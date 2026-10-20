"""A stand-in for graphlift's ``fiberbrowser-graph`` that speaks protocol 1 and misbehaves on request.

The graph panel's supervisor tests (tests/test_graph_panel_pool.py) need faults
the real helper never produces on purpose: malformed, oversized or truncated
frames, stalls, a blocked stdout, a stderr flood, memory growth. Each query's
``request.mode`` picks one (default ``ok``); the environment sets startup faults:

  FAKE_GRAPH_STARTUP     ok | slow | garbage | exit | wrong_schema
  FAKE_GRAPH_NO_READ=1   stop reading stdin after startup (the supervisor's write blocks)
  FAKE_GRAPH_JOBS        jobs per process (advertised; exit cleanly after that many)
  FAKE_GRAPH_LOG         append one line per command (pid, type, job id) to this file

``serve --package DIR`` reports DIR/manifest.json's revisions; ``handshake`` and
``verify --package DIR`` behave like the real helper's.
"""
import json
import os
import struct
import sys
import time

PROTOCOL = 1


def out(obj, raw=None):
    data = raw if raw is not None else json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack(">I", len(data)) + data)
    sys.stdout.buffer.flush()


def envelope(kind, job_id, generation, revisions, **fields):
    obj = {"protocol": PROTOCOL, "job_id": job_id, "generation": generation, "revisions": revisions, "type": kind}
    obj.update(fields)
    return obj


def handshake(jobs):
    return {"producer": "fake-graph-helper 0", "build_target": "test", "db_schemas": ["GBZ-base version 4"],
            "package_schemas": [1], "map_schemas": [2], "limits": {"target_bp": 50000, "paths": 4},
            "topology_bytes": 4 << 20, "sequence_bytes": 128 << 10, "jobs_per_process": jobs,
            "dispatch_deadline_ms": 1000, "startup_deadline_ms": 2000}


def read_exact(n):
    buf = b""
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def log(line):
    path = os.environ.get("FAKE_GRAPH_LOG")
    if path:
        with open(path, "a") as handle:
            handle.write(f"{os.getpid()} {line}\n")


def serve(package):
    with open(os.path.join(package, "manifest.json")) as handle:
        revisions = json.load(handle)["revisions"]
    jobs = int(os.environ.get("FAKE_GRAPH_JOBS", "4096"))
    startup = os.environ.get("FAKE_GRAPH_STARTUP", "ok")
    if startup == "slow":
        time.sleep(30)
    if startup == "exit":
        sys.exit(3)
    if startup == "garbage":
        sys.stdout.buffer.write(b"not a frame at all\n")
        sys.stdout.buffer.flush()
        time.sleep(30)
    hs = handshake(jobs)
    if startup == "wrong_schema":
        hs["db_schemas"] = ["GBZ-base version 99"]
    out(envelope("ready", "startup", 0, revisions, handshake=hs))
    if os.environ.get("FAKE_GRAPH_NO_READ") == "1":
        time.sleep(60)
        return
    done = 0
    held = []
    while True:
        header = read_exact(4)
        if header is None:
            return  # EOF on stdin: the supervisor is gone
        (length,) = struct.unpack(">I", header)
        cmd = json.loads(read_exact(length))
        kind, job, gen = cmd["type"], cmd["job_id"], cmd["generation"]
        log(f"{kind} {job} {(cmd.get('request') or {}).get('n', '')}")
        if kind == "shutdown":
            if os.environ.get("FAKE_GRAPH_DIE_ON_SHUTDOWN") == "1":
                sys.exit(4)
            time.sleep(int(os.environ.get("FAKE_GRAPH_SLOW_SHUTDOWN_MS", "0")) / 1000)
            out(envelope("bye", job, gen, revisions))
            return
        if kind == "catalog":
            out(envelope("catalog", job, gen, revisions, paths=[{"path": {"sample": "T", "haplotype": "0", "contig": "c"},
                                                                 "indexed": True, "fragments": 1}],
                         next_offset=None, total=1))
        else:
            request = cmd.get("request") or {}
            # Through the API only real request fields arrive: interval start 4242 asks for a stall.
            magic = {4242: "stall"}.get((request.get("interval") or {}).get("start"))
            mode = str(request.get("mode") or magic or "ok")
            name, _, arg = mode.partition(":")
            result = {"complete": True, "summaries": [], "echo": request, "pid": os.getpid(), "nodes": [], "edges": [],
                      "paths": []}
            if name == "sleep":
                time.sleep(int(arg) / 1000)
            elif name == "stall":
                time.sleep(3600)
            elif name == "malformed":
                out(None, raw=b"{this is not json")
                time.sleep(30)
            elif name == "oversized_header":
                sys.stdout.buffer.write(struct.pack(">I", 5 << 20))
                sys.stdout.buffer.flush()
                time.sleep(30)
            elif name == "oversized_payload":
                result["pad"] = "x" * ((4 << 20) + 10)
            elif name == "truncated":
                sys.stdout.buffer.write(struct.pack(">I", 100) + b'{"protocol":1')
                sys.stdout.buffer.flush()
                sys.exit(0)
            elif name == "truncated_hang":
                sys.stdout.buffer.write(struct.pack(">I", 100) + b'{"protocol":1')
                sys.stdout.buffer.flush()
                time.sleep(3600)
            elif name == "eof":
                sys.exit(0)
            elif name == "unknown_job":
                out(envelope("topology", "no-such-job", gen, revisions, result=result))
                time.sleep(30)
            elif name == "duplicate":
                out(envelope("topology", job, gen, revisions, result=result))
                out(envelope("topology", job, gen, revisions, result=result))
                done += 1
                continue
            elif name == "wrong_generation":
                out(envelope("topology", job, gen + 1, revisions, result=result))
                time.sleep(30)
            elif name == "stderr_flood":
                chunk = b"diagnostic line from the fake helper\n" * 1000
                total = int(arg) << 20
                written = 0
                while written < total:
                    sys.stderr.buffer.write(chunk)
                    written += len(chunk)
                sys.stderr.buffer.flush()
            elif name == "memory":
                block = bytearray(int(arg) << 20)
                for i in range(0, len(block), 4096):
                    block[i] = 1
                held.append(block)
                time.sleep(30)
            elif name == "memory_then_ok":
                block = bytearray(int(arg) << 20)
                for i in range(0, len(block), 4096):
                    block[i] = 1
                held.append(block)
            elif name == "slow_frame":
                data = json.dumps(envelope("topology", job, gen, revisions, result=result)).encode()
                sys.stdout.buffer.write(struct.pack(">I", len(data)) + data[:5])
                sys.stdout.buffer.flush()
                time.sleep(int(arg) / 1000)
                sys.stdout.buffer.write(data[5:])
                sys.stdout.buffer.flush()
                done += 1
                continue
            elif name == "wrong_revision":
                out(envelope("topology", job, gen, {**revisions, "db": "0" * 64}, result=result))
                time.sleep(30)
            elif name == "error":
                out(envelope("error", job, gen, revisions, error={"code": arg or "invalid_request", "message": "fake"}))
                done += 1
                continue
            out(envelope("topology", job, gen, revisions, result=result))
        done += 1
        if done >= jobs:
            return


def main(argv):
    if not argv:
        sys.exit(2)
    if argv[0] == "handshake":
        out(envelope("ready", "startup", 0, {"package": "", "graph": "", "db": "", "maps": ""},
                     handshake=handshake(int(os.environ.get("FAKE_GRAPH_JOBS", "4096")))))
        return
    if argv[0] == "verify":
        package = argv[argv.index("--package") + 1]
        if os.path.exists(os.path.join(package, "BAD")):
            sys.stderr.write("digest mismatch for graph.db\n")
            sys.exit(1)
        return
    if argv[0] == "serve":
        serve(argv[argv.index("--package") + 1])
        return
    sys.exit(2)


if __name__ == "__main__":
    main(sys.argv[1:])
