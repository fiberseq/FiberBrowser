"""Re-call a BAM from the FiberHMM command line its header records (``@PG CL``).

Used by "Re-call with FiberHMM <current>" when a BAM has neither a
fiberhmm-pipeline ``outputs.json`` nor a New DAF-seq run record: the last
fiberhmm-call (or fiberhmm-pipeline) command in its header is read back
against the *current* tool's own argparse parser, and re-run with the same
tool. Only what must change is rewritten (outputs into the Library's new
folder, cores, the job's progress file, an input found elsewhere), and every
rewrite is listed for the user to review; every other option is carried
verbatim, and a flag the current tool no longer has is mapped to its known
rename or refused.

How the command line was written decides how it is split:

* ``fiberhmm-call`` writes ``' '.join(sys.argv)``: not shell-quoted, so a path
  with spaces spans several words. It is split on single spaces and the
  words between two option flags are joined back (with single spaces) into
  the one value they were, guided by the current parser's option table.
* ``fiberhmm-pipeline`` writes ``fiberhmm-pipeline`` plus ``shlex.quote``-d
  arguments: it is split with ``shlex``.

Nothing here runs a shell or a FiberHMM command; ``library_jobs`` runs the
parser probe (``PARSER_PROBE``) in the job's own interpreter and environment.
"""
from __future__ import annotations

import os
import re
import shlex
from typing import Callable, Optional

# The tools a header command line can be re-run with, and the module whose parser checks it.
HEADER_TOOLS = {"fiberhmm-call": "fiberhmm.cli.call", "fiberhmm-pipeline": "fiberhmm.cli.pipeline"}
# @PG programs that made calls; the last one in the header is the command that made this BAM.
CALLING_PROGRAMS = ("fiberhmm-call", "fiberhmm-apply", "fiberhmm-run", "fiberhmm-pipeline")
PROGRESS_PLACEHOLDER = "<job>/progress.jsonl"
# How a recorded command names its program: a console script, the module file, ``python -m``'s __main__.
_PROGRAM_NAMES = {"fiberhmm-call", "fiberhmm-call.exe", "call.py", "fiberhmm-pipeline", "fiberhmm-pipeline.exe",
                  "pipeline.py", "fiberhmm-apply", "apply.py", "fiberhmm-run"}

# Flags a current tool no longer has, with the spelling that replaced them (CHANGELOG / cli history).
RENAMES = {
    "fiberhmm-call": {"--force-chemistry": "--force-seq"},
    "fiberhmm-pipeline": {},
}
# Flags the current parser still accepts but that only stop the run with a migration message.
RETIRED = {
    "fiberhmm-call": {
        "--ddda-mcg": "FiberHMM 3.0 removed fiberhmm-call's per-CpG mode (--ddda-mcg): its workflow is "
                      "fiberhmm-call, then fiberhmm-tag-m5c, then fiberhmm-call again on the tagged BAM, "
                      "which a re-call from the header cannot do.",
    },
    "fiberhmm-pipeline": {},
}
# Options a re-call leaves out (each one listed as a rewrite with its reason): FiberHMM 3.0
# retired them because they caused artifacts, and they may be removed from its parser
# altogether. Each takes one value. They are fiberhmm-call options (also inside a
# pipeline's --call-args or an outputs.json's call_args).
RETIRED_CAUSED_ARTIFACTS = "retired in FiberHMM 3.0: caused artifacts"
DROPPED = {
    "fiberhmm-call": {"--phase-nrl": RETIRED_CAUSED_ARTIFACTS, "--nuc-recall-policy": RETIRED_CAUSED_ARTIFACTS},
    "fiberhmm-pipeline": {},
}
# fiberhmm-call's dests for them (argparse's own derivation), for the parse comparison.
DROPPED_DESTS = {"phase_nrl", "nuc_recall_policy"}


def _retired_spelling(word: str, table: Optional["Table"] = None) -> Optional[str]:
    """The retired fiberhmm-call option a word names (also abbreviated, as argparse reads it), or None.

    With fiberhmm-call's option table, as its parser resolves the word. Without one: the
    full name, or an unambiguous prefix of exactly one retired option (a recorded command
    ran, so a prefix its parser accepted was unique; argparse prefers an exact name, so a
    word that is itself another option's name is never taken)."""
    retired = DROPPED["fiberhmm-call"]
    if not word.startswith("--"):
        return None
    name = word.partition("=")[0]
    if name in retired:
        return name
    if table is not None:
        if name in table.by_option:
            return None
        hit = table.lookup(word)
        if hit is not None:
            return hit[1] if hit[1] in retired else None
        # Not a current option (the parser may have removed the retired ones): a prefix of one.
    matches = [flag for flag in retired if len(name) > 3 and flag.startswith(name)]
    return matches[0] if len(matches) == 1 else None


def drop_retired(words: list[str], table: Optional["Table"] = None) -> tuple[list[str], list[dict]]:
    """A fiberhmm-call argument list (one word per argument, e.g. a pipeline's --call-args)
    without the DROPPED options, in any spelling its parser accepts (``table``: fiberhmm-call's
    options): (kept words, [{flag, value, why}])."""
    retired = DROPPED["fiberhmm-call"]
    kept: list[str] = []
    dropped: list[dict] = []
    i = 0
    while i < len(words):
        _spelled, eq, value = words[i].partition("=")
        name = _retired_spelling(words[i], table)
        if name:
            if not eq and i + 1 < len(words) and not _looks_like_option(words[i + 1]):
                value = words[i + 1]
                i += 1
            dropped.append({"flag": name, "value": value if (eq or value) else None, "why": retired[name]})
        else:
            kept.append(words[i])
        i += 1
    return kept, dropped

# What each option's value is, by argparse dest. Outputs go into the Library's new folder.
OUTPUTS = {
    "fiberhmm-call": {"output": "file", "dedup_stats_tsv": "file", "daf_snp_output_prefix": "prefix",
                      "qc_output_prefix": "prefix", "work_dir": "folder"},
    "fiberhmm-pipeline": {"outdir": "outdir"},
}
INPUTS = {
    "fiberhmm-call": ("input", "model", "recall_model", "reference", "daf_snp_mask"),
    "fiberhmm-pipeline": ("reads", "reference", "snp_mask"),
}
MAIN_INPUT = {"fiberhmm-call": "input", "fiberhmm-pipeline": "reads"}
PROGRESS_DEST = "progress_json"
CORES_DEST = "cores"
# A dest that looks like it names something written: refused unless it is classified above.
_WRITES = re.compile(r"(^|_)(output|outdir|out|prefix|tsv|json|dir|log)($|_)")

_SPLIT_HINT = ("the header's command line is not shell-quoted, so the Library joined the words "
               "between two options back into one value")


class CommandError(ValueError):
    """A header command the Library will not re-run, worded for the user.

    ``needs_input``: the main input was not found; the user can point at it."""

    def __init__(self, message: str, needs_input: Optional[dict] = None):
        super().__init__(message)
        self.needs_input = needs_input


# ---------------------------------------------------------------------------
# The parser probe (run by library_jobs in the job's interpreter and environment)
# ---------------------------------------------------------------------------

PARSER_PROBE = r'''
import argparse, contextlib, importlib, io, json, os, sys
module, first, mode = sys.argv[1], sys.argv[2] or os.getcwd(), sys.argv[3]
if sys.path and sys.path[0] == '':
    sys.path[0] = first
elif getattr(sys, 'frozen', False) and first not in sys.path:
    sys.path.insert(0, first)
out = {}
try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        mod = importlib.import_module(module)
except Exception as exc:
    print("\n" + json.dumps({"error": "cannot import %s: %s: %s" % (module, type(exc).__name__, exc)}))
    raise SystemExit(0)
parser = None
build = getattr(mod, 'build_parser', None)
if callable(build):
    parser = build()
else:
    class _Captured(Exception):
        pass
    original = argparse.ArgumentParser.parse_known_args
    def intercept(self, args=None, namespace=None):
        raise _Captured(self)
    argparse.ArgumentParser.parse_known_args = intercept
    saved = sys.argv
    sys.argv = [module]
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            mod.parse_args()
    except _Captured as captured:
        parser = captured.args[0]
    except BaseException:
        parser = None
    finally:
        argparse.ArgumentParser.parse_known_args = original
        sys.argv = saved
if parser is None:
    print("\n" + json.dumps({"error": "no argument parser in %s" % module}))
    raise SystemExit(0)
def plain(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return repr(value)
actions = []
for action in parser._actions:
    nargs = action.nargs
    if isinstance(nargs, str) and nargs not in ('?', '*', '+'):
        nargs = 'other'
    actions.append({"options": list(action.option_strings), "dest": action.dest, "nargs": nargs,
                    "choices": [plain(c) for c in action.choices] if action.choices is not None else None,
                    "default": plain(action.default), "required": bool(action.required),
                    "kind": type(action).__name__})
out = {"actions": actions, "allow_abbrev": bool(getattr(parser, 'allow_abbrev', True))}
try:
    import fiberhmm
    out["version"] = getattr(fiberhmm, '__version__', None)
except Exception:
    out["version"] = None
if mode == 'parse':
    class _Refused(Exception):
        pass
    def error(message):
        raise _Refused(message)
    parser.error = error
    results = []
    for argv in json.loads(sys.stdin.read() or '[]'):
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                namespace = parser.parse_args(argv)
            results.append({"namespace": {k: plain(v) for k, v in vars(namespace).items()}})
        except _Refused as exc:
            results.append({"error": str(exc)})
        except SystemExit as exc:
            results.append({"error": "the parser stopped (exit %s)" % exc.code})
    out["parsed"] = results
print("\n" + json.dumps(out))
'''


class Table:
    """The current tool's options, from its own parser (PARSER_PROBE's answer)."""

    def __init__(self, tool: str, probe: dict):
        self.tool = tool
        self.version = probe.get("version")
        self.allow_abbrev = probe.get("allow_abbrev", True)
        self.actions: list[dict] = [a for a in probe.get("actions") or [] if isinstance(a, dict)]
        self.by_option = {opt: a for a in self.actions for opt in a.get("options") or []}
        self.by_dest = {a["dest"]: a for a in self.actions}
        self.positionals = [a for a in self.actions if not a.get("options")]

    def has(self, flag: str) -> bool:
        return flag in self.by_option

    def spelling(self, dest: str) -> Optional[str]:
        """The long spelling of an option (``--cores``), else its first."""
        action = self.by_dest.get(dest)
        if not action or not action.get("options"):
            return None
        longs = [o for o in action["options"] if o.startswith("--")]
        return (longs or action["options"])[0]

    def lookup(self, token: str) -> Optional[tuple[dict, str, Optional[str], bool]]:
        """(action, canonical flag, attached value or None, abbreviated) for an option token."""
        if token in self.by_option:
            return self.by_option[token], token, None, False
        if token.startswith("--"):
            name, eq, value = token.partition("=")
            if name in self.by_option:
                return self.by_option[name], name, (value if eq else None), False
            if self.allow_abbrev and len(name) > 2:
                matches = [o for o in self.by_option if o.startswith(name) and o.startswith("--")]
                actions = {id(self.by_option[o]) for o in matches}
                if matches and len(actions) == 1:
                    return self.by_option[matches[0]], matches[0], (value if eq else None), True
            return None
        if token.startswith("-") and len(token) > 2:
            short = token[:2]
            action = self.by_option.get(short)
            if action is not None and action.get("nargs") != 0:
                return action, short, token[2:], False
        return None


def _looks_like_option(token: str) -> bool:
    return token.startswith("-") and len(token) > 1 and not re.fullmatch(r"-\d+(\.\d*)?", token)


def _takes_one(action: dict) -> bool:
    return action.get("nargs") in (None, "?")


# ---------------------------------------------------------------------------
# Reading the command line back
# ---------------------------------------------------------------------------

def calling_program(programs: list[dict]) -> Optional[dict]:
    """The last FiberHMM calling @PG of a header (its PN, VN, CL, DS), or None."""
    for pg in reversed(programs or []):
        name = str(pg.get("PN") or pg.get("ID") or "")
        base = re.sub(r"\.\d+$", "", name)
        if base in CALLING_PROGRAMS:
            return {"name": base, "version": pg.get("VN"), "cl": str(pg.get("CL") or ""),
                    "ds": str(pg.get("DS") or "")}
    return None


def split_command(tool: str, cl: str) -> tuple[list[str], bool]:
    """The words of a recorded command line, and whether they are shell-quoted
    (True: one word per argument; False: ``' '.join(argv)``, see the module doc)."""
    if tool == "fiberhmm-pipeline":
        try:
            return shlex.split(cl), True
        except ValueError as exc:
            raise CommandError(f"The header's fiberhmm-pipeline command line cannot be read ({exc}).") from None
    return cl.strip().split(" "), False


def read_items(table: Table, words: list[str], quoted: bool) -> tuple[list[str], list[dict], list[dict]]:
    """(program words, option items, notes) of a recorded command line.

    Each item: {flag (canonical; None for a positional), spelled, dest, action, values}.
    The program is everything before the first option (a path such as
    ``.../fiberhmm/cli/call.py`` or ``/home/me/env/bin/fiberhmm-call``; with
    spaces, it spans several words of an unquoted command line); it is ignored."""
    tool = table.tool
    renames = RENAMES.get(tool, {})
    notes: list[dict] = []
    start = None
    if quoted:
        start = 1  # fiberhmm-pipeline writes its own name first, then the quoted arguments
    else:
        # The program ends at the word naming the tool (a script path may contain spaces);
        # else it is everything before the first option-like word. An unknown option after
        # it is refused below, never taken for part of the program.
        for i, word in enumerate(words):
            if _basename(word).lower() in _PROGRAM_NAMES:
                start = i + 1
                break
        if start is None:
            start = next((i for i, word in enumerate(words) if _looks_like_option(word)), None)
    if start is None or start >= len(words):
        raise CommandError(f"The header's {tool} command line has no option this FiberHMM's {tool} knows; "
                           "the Library cannot tell how it was run.")
    program, rest = words[:start], words[start:]
    items: list[dict] = []
    dropped_items: list[dict] = []
    positionals: list[str] = []
    open_item: Optional[dict] = None  # the option whose value words are being read
    open_parts: list[str] = []
    joined = False

    def close() -> None:
        nonlocal open_item, open_parts, joined
        if open_item is not None and open_parts:
            if _takes_one(open_item["action"]):
                open_item["values"] = [" ".join(open_parts)]
                if len(open_parts) > 1:
                    joined = True
                    notes.append({"flag": open_item["flag"], "value": open_item["values"][0]})
            else:
                open_item["values"] = list(open_parts)
        open_item, open_parts = None, []

    dropped_map = DROPPED.get(tool, {})
    for word in rest:
        # argparse reads a word with a space as a value, never an option (--call-args '--a 1 --b'),
        # unless it is an option's attached form (--call-args=--a 1).
        is_option = _looks_like_option(word) and not (
            quoted and " " in word and word.partition("=")[0] not in table.by_option)
        hit = table.lookup(word) if is_option else None
        if is_option:
            # A retired option (whether or not this parser still has it): its value is
            # read off and left out, and the drop is listed.
            name, eq, attached = word.partition("=")
            gone = name if name in dropped_map else (hit[1] if hit is not None and hit[1] in dropped_map else None)
            if gone is None and hit is None and dropped_map:
                gone = _retired_spelling(word, table)  # abbreviated, once the parser no longer has it
            if gone:
                close()
                open_item = {"flag": gone, "spelled": word, "dest": None, "action": {"nargs": None},
                             "values": [], "dropped": True}
                dropped_items.append(open_item)
                open_parts = [attached] if eq else []
                if quoted and eq:
                    close()
                continue
        if hit is None and is_option:
            name, eq, value = word.partition("=")
            if name in RETIRED.get(tool, {}):
                raise CommandError(RETIRED[tool][name])
            if name in renames and table.has(renames[name]):
                hit = table.lookup(renames[name] + (eq + value if eq else ""))
                if hit is not None:
                    hit = (hit[0], hit[1], hit[2], False)
                    notes.append({"renamed": name, "to": renames[name]})
            elif open_item is not None and not quoted and ("/" in word or "\\" in word):
                open_parts.append(word)  # a word of an unquoted path ("/data/run -2/x.bam")
                continue
            else:
                close()
                raise CommandError(
                    f"The original command used {name}, which this FiberHMM's {tool} does not have "
                    "(and FiberBrowser knows no replacement for). The Library will not drop or guess an "
                    "option; start a New DAF-seq run from the aligned reads instead.")
        if hit is None:  # a value word
            if open_item is not None:
                action = open_item["action"]
                if quoted and _takes_one(action) and open_parts:
                    close()
                    positionals.append(word)
                    continue
                open_parts.append(word)
                nargs = action.get("nargs")
                if isinstance(nargs, int) and len(open_parts) >= nargs:
                    close()
            else:
                positionals.append(word)
            continue
        close()
        action, flag, attached, abbreviated = hit
        if name_retired := RETIRED.get(tool, {}).get(flag):
            raise CommandError(name_retired)
        item = {"flag": flag, "spelled": word, "dest": action["dest"], "action": action, "values": []}
        if abbreviated:
            notes.append({"abbreviated": word.split("=", 1)[0], "to": flag})
        items.append(item)
        if action.get("nargs") == 0:
            if attached is not None:
                raise CommandError(f"The original command gave {flag} a value ({word}), which {tool} "
                                   "does not take; the Library cannot tell what it meant.")
            continue
        open_item, open_parts = item, ([attached] if attached is not None else [])
        if quoted and attached is not None and _takes_one(action):
            close()
    close()
    for item in items:
        nargs = item["action"].get("nargs")
        if nargs in (None, "+") and not item["values"]:
            raise CommandError(f"The header's command line gives {item['flag']} no value; it cannot be re-run.")
    if positionals:
        slots = [a for a in table.positionals]
        if not slots:
            raise CommandError(f"The header's {tool} command line has words the Library cannot place "
                               f"({' '.join(positionals)[:120]}); it will not guess what they were.")
        items.insert(0, {"flag": None, "spelled": None, "dest": slots[0]["dest"], "action": slots[0],
                         "values": _group_positionals(positionals, quoted)})
    for item in dropped_items:
        notes.append({"dropped": item["flag"], "value": item["values"][0] if item["values"] else None,
                      "why": dropped_map[item["flag"]]})
    if joined:
        notes.append({"joined": True})
    return program, items, notes


def _group_positionals(words: list[str], quoted: bool) -> list[str]:
    if quoted:
        return list(words)
    # An unquoted list of read files: words up to one that ends like a read file (or exists) are one path.
    out: list[str] = []
    current: list[str] = []
    for word in words:
        current.append(word)
        text = " ".join(current)
        if re.search(r"\.(bam|cram|sam|fastq|fq|fastq\.gz|fq\.gz)$", text, re.I) or os.path.exists(text):
            out.append(text)
            current = []
    if current:
        out.append(" ".join(current))
    return out


def argv_of(items: list[dict]) -> list[str]:
    """The argv a list of items stands for (positionals first, then options in their order).
    A one-value option whose value starts with '-' is written attached (``--flag=-x``), as
    argparse would otherwise read the value as an option."""
    argv: list[str] = []
    for item in items:
        if item["flag"] is None:
            argv += item["values"]
    for item in items:
        flag = item["flag"]
        if flag is None:
            continue
        values = item["values"]
        if len(values) == 1 and values[0].startswith("-") and _takes_one(item["action"]):
            argv.append(f"{flag}={values[0]}" if flag.startswith("--") else f"{flag}{values[0]}")
        else:
            argv.append(flag)
            argv += values
    return argv


# ---------------------------------------------------------------------------
# Finding a recorded input on this computer
# ---------------------------------------------------------------------------

def _parts(path: str) -> list[str]:
    return [p for p in re.split(r"[\\/]+", path) if p]


def search_roots(entry_path: str) -> list[str]:
    """Where a path recorded on another computer may live here: the BAM's own folders
    (nearest first), the home folder, and Dropbox folders."""
    home = os.path.expanduser("~")
    roots: list[str] = []
    folder = os.path.dirname(os.path.abspath(entry_path))
    while folder and folder != os.path.dirname(folder):
        roots.append(folder)
        if folder == home:
            break
        folder = os.path.dirname(folder)
    roots.append(home)
    roots.append(os.path.join(home, "Dropbox"))
    cloud = os.path.join(home, "Library", "CloudStorage")
    try:
        roots += sorted(os.path.join(cloud, n) for n in os.listdir(cloud) if n.lower().startswith("dropbox"))
    except OSError:
        pass
    return list(dict.fromkeys(roots))


def root_mapping(recorded_output: Optional[str], entry_path: str) -> Optional[tuple[str, str]]:
    """(old root, new root) when the recorded output path and this BAM's path share their
    trailing folders and name (a BAM read here at the path another computer wrote it to)."""
    if not recorded_output or not os.path.isabs(recorded_output.replace("\\", "/")):
        return None
    old, new = _parts(recorded_output), _parts(os.path.abspath(entry_path))
    common = 0
    while common < min(len(old), len(new)) and old[-1 - common] == new[-1 - common]:
        common += 1
    if common < 2 or common == len(old):
        return None
    old_root = "/" + "/".join(old[:len(old) - common])
    new_root = "/" + "/".join(new[:len(new) - common])
    return (old_root, new_root) if old_root != new_root else None


def locate(recorded: str, entry_path: str, mapping: Optional[tuple[str, str]],
           exists: Callable[[str], bool] = os.path.exists) -> Optional[tuple[str, str]]:
    """(path here, how it was found) for an absolute path recorded elsewhere, or None."""
    parts = _parts(recorded)
    if mapping:
        old_parts = _parts(mapping[0])
        if parts[:len(old_parts)] == old_parts:
            candidate = os.path.join(mapping[1], *parts[len(old_parts):])
            if exists(candidate):
                return candidate, (f"the header records {mapping[0]}/…, which is {mapping[1]}/… on this computer "
                                   "(where this BAM is)")
    roots = search_roots(entry_path)
    for keep in range(len(parts) - 1, 0, -1):  # the longest trailing part of the path first
        suffix = parts[len(parts) - keep:]
        for root in roots:
            if keep == 1 and root != os.path.dirname(os.path.abspath(entry_path)):
                continue  # a bare file name only next to this BAM
            candidate = os.path.join(root, *suffix)
            if exists(candidate):
                dropped = "/" + "/".join(parts[:len(parts) - keep])
                return candidate, (f"the recorded path with {dropped} replaced by {root}"
                                   if keep > 1 else "found next to this BAM")
    return None


# ---------------------------------------------------------------------------
# Defaults that changed since the original run
# ---------------------------------------------------------------------------

def _ds_token(ds: str, key: str) -> Optional[str]:
    """The value of a ``key=value`` token of an @PG DS (None when absent)."""
    match = re.search(rf"(?:^|[\s;]){re.escape(key)}=([^\s;]+)", ds or "")
    return match.group(1) if match else None


# The texts of 3.0's changed defaults shared by every re-call (header command, outputs.json, run record).
SUPPLEMENTARY_TEXT = ("FiberHMM 3.0 also calls supplementary alignments (the other parts of a split read, e.g. "
                      "the far side of a structural variant); the original called primary alignments only.")
UNALIGNED_MASK_TEXT = ("FiberHMM 3.0 masks inserted and soft-clipped bases for DAF (no evidence: they have no "
                       "reference base to be deaminated against) and calls recurrent insertions against a "
                       "deamination-aware consensus; the original counted their unconverted bases as protected.")
SOFT_CLIP_TEXT = ("FiberHMM 3.0 keeps soft clips on linear contigs (DAF calling treats them as no evidence; "
                  "they are the read's own sequence for structural-variant views) and hard-clips only on "
                  "circular contigs; the original hard-clipped every read.")


def changed_defaults(tool: str, enzyme: str, flags: set[str], ds: str, input_indexed: bool,
                     call_flags: Optional[set[str]] = None) -> list[dict]:
    """3.0 default changes (CHANGELOG "Changed defaults") that apply to a run whose
    command line left the option out, judged by the DS tokens the original recorded.
    ``restore``: the flags that keep the original behaviour (None: no option restores
    it); ``dest``: the option's argparse dest, filled in from the parser by ``build``.
    ``call_flags``: the options of a pipeline's --call-args (fiberhmm-call's)."""
    out: list[dict] = []
    daf = enzyme in ("ddda", "dddb")
    nested = set(call_flags or ())

    def lacks(*names: str) -> bool:
        return not (set(names) & flags)

    if tool == "fiberhmm-pipeline":
        # The pipeline's @PG DS records its alignment set (and clipping) since these defaults changed.
        if _ds_token(ds, "alignments") is not None:
            return out
        if lacks("--alignments", "--primary", "--no-primary"):
            out.append({"id": "alignments", "restore": ["--alignments", "primary"], "text": SUPPLEMENTARY_TEXT})
        if daf and lacks("--hard-clip", "--keep-soft-clips") and _ds_token(ds, "hard_clip") in (None, "on"):
            out.append({"id": "soft_clips", "restore": ["--hard-clip"], "text": SOFT_CLIP_TEXT})
        if daf and lacks("--daf-mask-unaligned", "--no-daf-mask-unaligned") and not (
                {"--daf-mask-unaligned", "--no-daf-mask-unaligned"} & nested):
            out.append({"id": "daf_unaligned_mask", "restore": ["--no-daf-mask-unaligned"],
                        "text": UNALIGNED_MASK_TEXT})
        return out
    if tool != "fiberhmm-call":
        return out

    if lacks("--alignments", "--primary", "--no-primary") and _ds_token(ds, "alignments") is None:
        if _ds_token(ds, "primary_only") == "on":
            out.append({"id": "alignments", "restore": ["--alignments", "primary"], "text": SUPPLEMENTARY_TEXT})
        elif _ds_token(ds, "primary_only") is None:
            out.append({"id": "alignments", "restore": ["--alignments", "all"],
                        "text": "FiberHMM 3.0 calls primary and supplementary alignments and passes secondary "
                                "ones through uncalled; the original called every alignment (DAF reads: except "
                                "supplementary ones, which FiberHMM 3.0 calls either way)."})
    if lacks("--process-unmapped", "--no-process-unmapped") and not input_indexed:
        out.append({"id": "process_unmapped", "restore": ["--no-process-unmapped"],
                    "text": "FiberHMM 3.0 calls the unmapped reads of an unindexed input; the original passed "
                            "them through uncalled."})
    if daf and lacks("--daf-mask-unaligned", "--no-daf-mask-unaligned") and _ds_token(ds, "daf_unaligned_mask") is None:
        out.append({"id": "daf_unaligned_mask", "restore": ["--no-daf-mask-unaligned"], "text": UNALIGNED_MASK_TEXT})
    if enzyme == "ddda" and lacks("--daf-mask-runs") and "daf_run_mask=>=" not in ds:
        out.append({"id": "ddda_thinning", "restore": ["--daf-mask-runs", "0"],
                    "text": "FiberHMM 3.0 keeps one target of each DddA CC/GG run; the original used them all."})
    if enzyme == "ddda" and lacks("--use-m5c", "--no-use-m5c") and "cpg_mask=" not in ds:
        out.append({"id": "ddda_cpg", "restore": ["--no-use-m5c"],
                    "text": "FiberHMM 3.0 leaves CpGs out of DddA recall outside unmethylated islands; the "
                            "original used them."})
    if "tf_decoder=" not in ds:
        extra = (" and a TF --min-llr of 5.0 (the original's DddB default was 4.0)"
                 if enzyme == "dddb" and lacks("--min-llr") else "")
        out.append({"id": "tf_decoder", "restore": None,
                    "text": f"FiberHMM 3.0 calls TFs with its multi-interval decoder{extra}; no option restores "
                            "the original's decoder."})
    # Nucleosome recall the original ran with by default (an explicit option is dropped, and listed, instead).
    phase, policy = _ds_token(ds, "phase_nrl"), _ds_token(ds, "nuc_recall_policy")
    if enzyme != "ddda" and lacks(*DROPPED["fiberhmm-call"]) and ((phase not in (None, "0", "off")) or policy == "topology"):
        used = ", ".join(x for x in (f"phase_nrl={phase}" if phase not in (None, "0", "off") else "",
                                     "nuc_recall_policy=topology" if policy == "topology" else "") if x)
        out.append({"id": "nuc_recall", "restore": None,
                    "text": f"FiberHMM 3.0 calls nucleosomes with no periodicity prior and conservative recall; "
                            f"the original used {used}, options {RETIRED_CAUSED_ARTIFACTS}, so nothing "
                            "restores them."})
    return out


# ---------------------------------------------------------------------------
# The re-call command
# ---------------------------------------------------------------------------

# fiberhmm-call options a pipeline sets itself, or that write files: never taken from a recorded --call-args.
_PIPELINE_OWNS = {"input", "output", "cores", "progress_json", "work_dir", "keep_work_dir", "resume",
                  "dedup_stats_tsv", "daf_snp_output_prefix", "qc_output_prefix"}


def _split_call_args(text: str) -> list[str]:
    try:
        return shlex.split(text)
    except ValueError:
        raise CommandError("The original --call-args cannot be read (unbalanced quotes).") from None


def nested_call_args(text: str, call_table: Optional[Table], exists: Callable[[str], bool]) -> list[str]:
    """Check a recorded pipeline --call-args with fiberhmm-call's own options (it is passed on
    verbatim): refuse what the pipeline sets itself or what writes a file, unknown options and
    relative or missing paths; return the files it reads (to bind and confine)."""
    words = _split_call_args(text)
    if not words:
        return []
    if call_table is None:
        raise CommandError("The Library could not read fiberhmm-call's options to check the original --call-args.")
    _program, items, _notes = read_items(call_table, ["fiberhmm-call", *words], True)
    files: list[str] = []
    for item in items:
        dest = item["dest"]
        if item["flag"] is None:
            raise CommandError(f"The original --call-args has words fiberhmm-call does not take "
                               f"({' '.join(item['values'])[:80]}).")
        if dest in _PIPELINE_OWNS or _WRITES.search(dest):
            raise CommandError(f"The original --call-args gives fiberhmm-call {item['flag']}, which the pipeline "
                               "sets itself or which writes a file outside the re-call's folder; the Library will "
                               "not re-run it.")
        for value in item["values"]:
            looks_like_path = "/" in value or value.startswith(".") or dest in INPUTS["fiberhmm-call"]
            if looks_like_path and not _is_abs(value) and dest in INPUTS["fiberhmm-call"]:
                raise CommandError(f"The original --call-args gives {item['flag']} {value}, a path relative to a "
                                   "folder the header does not record.")
            if "/" in value and not _is_abs(value):
                raise CommandError(f"The original --call-args names {value}, a path relative to a folder the "
                                   "header does not record.")
            if dest in INPUTS["fiberhmm-call"]:
                if not exists(value):
                    raise CommandError(f"The original --call-args uses {item['flag']} {value}, which was not found "
                                       "on this computer.")
                files.append(value)
    return files


_RAW_SUFFIXES = (".pod5", ".fast5")
_RAW_FOLDER = re.compile(r"^(pod5|fast5)(_(pass|fail|skip))?$", re.IGNORECASE)


def is_raw_input(value: str, exists: Callable[[str], bool] = os.path.exists) -> bool:
    """Raw Nanopore signal (POD5/FAST5, or a folder of it): a pipeline that read it basecalled it with
    dorado first. A recorded folder not on this computer counts when it is named like MinKNOW's."""
    text = str(value or "").rstrip("/\\")
    if text.lower().endswith(_RAW_SUFFIXES):
        return True
    if exists(text) and os.path.isdir(text):
        from services.pipeline_inputs import raw_input_kind
        return raw_input_kind(text) == "pod5"
    return bool(_RAW_FOLDER.match(_basename(text)))


def _raw_refusal(value: str, outputs_dir: Optional[str], shown: str) -> CommandError:
    hint = f" (it is {os.path.join(outputs_dir, '<sample>.basecalled.bam')} in the original run's folder)" \
        if outputs_dir else ""
    return CommandError(
        f"The header's fiberhmm-pipeline command starts from raw Nanopore POD5 ({value}); re-running it would "
        "basecall everything again with dorado (hours on a GPU). Choose the run's basecalled BAM instead"
        f"{hint}, or its aligned BAM.", needs_input={"flag": shown, "recorded": value, "reason": "raw"})


_OVERRIDE_KEYS = {"program": "program", "basecaller": "program", "version": "version",
                  "basecaller_version": "version", "basecall_model": "basecall_model", "model": "basecall_model",
                  "modbase_models": "modbase_models", "modbase_model": "modbase_models"}


def _override_fields(info: str) -> list[str]:
    """The fields a ``--basecaller-info`` value sets (FiberHMM's keys and aliases)."""
    out = []
    for token in re.split(r"[\s;]+", info or ""):
        key, sep, value = token.partition("=")
        field = _OVERRIDE_KEYS.get(key.strip().lower())
        if sep and field and value.strip():
            out.append(field)
    return out


def recorded_override(ds: str) -> dict:
    """The basecaller fields an earlier FiberHMM run recorded as an override (``basecaller_sources=
    field:override`` or ``:recorded-override`` in its @PG DS): {field: value}."""
    tokens = {}
    for token in re.split(r"[\s;]+", ds or ""):
        key, sep, value = token.partition("=")
        if sep and key:
            tokens[key] = value
    names = {"program": "basecaller", "version": "basecaller_version", "basecall_model": "basecall_model",
             "modbase_models": "modbase_models"}
    out: dict = {}
    for item in str(tokens.get("basecaller_sources") or "").split(","):
        field, sep, source = item.partition(":")
        if not sep or field not in names or source not in ("override", "recorded-override"):
            continue
        value = tokens.get(names[field])
        if value in (None, "", "unknown"):
            continue
        out[field] = value
    return out


def _is_abs(path: str) -> bool:
    return os.path.isabs(path) or bool(re.match(r"^[A-Za-z]:[\\/]", path))


def _basename(path: str) -> str:
    return _parts(path)[-1] if _parts(path) else ""


def build(*, tool: str, cl: str, ds: str, table: Table, entry_path: str, enzyme: str,
          platform: Optional[str], outdir: str, cores: int, input_override: Optional[str] = None,
          keep_old: Optional[list[str]] = None, exists: Callable[[str], bool] = os.path.exists,
          indexed: Callable[[str], bool] = lambda p: False, call_table: Optional[Table] = None) -> dict:
    """The re-call of a recorded command: its new arguments and everything that changed.

    ``call_table``: fiberhmm-call's options, to read a pipeline command's --call-args
    (required when it has them).

    Raises CommandError (``needs_input`` set when the main input is missing or
    recorded relative to a folder the header does not name)."""
    words, quoted = split_command(tool, cl)
    _program, items, notes = read_items(table, words, quoted)
    recorded_args = argv_of(items)
    outputs_kind = OUTPUTS.get(tool, {})
    input_dests = INPUTS.get(tool, ())
    main_dest = MAIN_INPUT[tool]
    flags_used = {i["flag"] for i in items if i["flag"]}
    rewrites: list[dict] = []
    for note in notes:
        if note.get("renamed"):
            rewrites.append({"flag": note["to"], "from": note["renamed"], "to": note["to"],
                             "why": f"{note['renamed']} is spelled {note['to']} in this FiberHMM"})
        elif note.get("abbreviated"):
            rewrites.append({"flag": note["to"], "from": note["abbreviated"], "to": note["to"],
                             "why": "spelled out (the original used an abbreviation)"})
        elif note.get("dropped"):
            rewrites.append({"flag": note["dropped"], "from": note["value"], "to": None, "why": note["why"]})
    joined = [n for n in notes if n.get("flag") and "value" in n]
    warnings: list[str] = []
    if joined:
        flags = ", ".join(dict.fromkeys(n["flag"] for n in joined))
        warnings.append(f"Values with spaces ({flags}): {_SPLIT_HINT}. Check them in the original command below.")

    # Options the Library doesn't know how to place: refused rather than carried to write somewhere old.
    nested_inputs: list[str] = []
    nested_args: list[str] = []
    nested_flags: set[str] = set()
    call_args_rewritten = False
    for item in list(items):
        dest = item["dest"]
        if item["flag"] is None or dest in outputs_kind or dest in input_dests or dest in (PROGRESS_DEST, CORES_DEST):
            continue
        if _WRITES.search(dest) and item["values"]:
            raise CommandError(f"The original command used {item['flag']} {' '.join(item['values'])}, an option "
                               "this FiberBrowser does not know where it writes; it will not re-run it.")
        if tool == "fiberhmm-pipeline" and dest == "call_args":
            kept, dropped = drop_retired(_split_call_args(item["values"][0]), call_table)
            for gone in dropped:
                rewrites.append({"flag": f"{item['flag']} {gone['flag']}", "from": gone["value"], "to": None,
                                 "why": gone["why"]})
            if dropped:
                call_args_rewritten = True
                # Emptied, the option stays (as ''): argparse keeps the last --call-args, so removing
                # this one would bring back an earlier one the original overrode.
                item["values"] = [shlex.join(kept)]
            nested_inputs += nested_call_args(item["values"][0], call_table, exists)
            # What fiberhmm-call gets: the last --call-args only (argparse keeps the last occurrence).
            nested_args = [item["values"][0]]
            nested_flags = {w.split("=", 1)[0] for w in kept if _looks_like_option(w)}
            continue
        for value in item["values"]:
            if ("/" in value or value.startswith(("./", "../"))) and not _is_abs(value):
                raise CommandError(f"The original command gave {item['flag']} {value}, a path relative to a folder "
                                   "the header does not record; the Library will not guess it.")

    recorded_outdir = next((i["values"][0] for i in items if outputs_kind.get(i["dest"]) == "outdir" and i["values"]),
                           None)
    # The output this BAM was written to (for mapping another computer's paths onto this one).
    recorded_output = next((i["values"][0] for i in items if outputs_kind.get(i["dest"]) == "file"
                            and i["dest"] == "output" and i["values"]), None)
    mapping = root_mapping(recorded_output, entry_path)

    # Inputs: kept when they exist here; else found (and shown) or asked for.
    found_input: dict = {}
    for item in items:
        if item["dest"] not in input_dests:
            continue
        new_values = []
        for value in item["values"]:
            shown = item["flag"] or "the reads"
            is_main = item["dest"] == main_dest
            if is_main and input_override and len(item["values"]) > 1:
                raise CommandError("The header's command reads several files; the Library can only take one "
                                   "chosen file in place of one input, so it will not replace them all with it.")
            if is_main and input_override:
                picked = os.path.abspath(os.path.expanduser(input_override))
                if not exists(picked):
                    raise CommandError(f"Not found: {picked}", needs_input={"flag": shown, "recorded": value})
                if tool == "fiberhmm-pipeline" and is_raw_input(picked, exists):
                    raise _raw_refusal(picked, recorded_outdir, shown)
                rewrites.append({"flag": shown, "from": value, "to": picked, "why": "the file you chose"})
                found_input = {"flag": shown, "recorded": value, "path": picked, "how": "you chose it"}
                new_values.append(picked)
                continue
            if value == "-":
                raise CommandError("The original command read its input from a pipe (-i -), so the Library "
                                   "cannot tell which reads it called.")
            if is_main and tool == "fiberhmm-pipeline" and is_raw_input(value, exists):
                raise _raw_refusal(value, recorded_outdir, shown)
            if not _is_abs(value):
                message = (f"The header records the input as {value}, relative to a folder it does not name. "
                           "Choose the file it was (the aligned reads the original command read).")
                if is_main:
                    raise CommandError(message, needs_input={"flag": shown, "recorded": value, "reason": "relative"})
                raise CommandError(f"The original command gave {shown} {value}, a path relative to a folder the "
                                   "header does not record; the Library will not guess it.")
            if exists(value):
                new_values.append(value)
                if is_main:
                    found_input = {"flag": shown, "recorded": value, "path": value, "how": "as recorded"}
                continue
            hit = locate(value, entry_path, mapping, exists)
            if hit is None:
                if is_main:
                    raise CommandError(f"The input the header records was not found on this computer: {value}. "
                                       "Choose the file (the aligned reads the original command read).",
                                       needs_input={"flag": shown, "recorded": value, "reason": "missing"})
                raise CommandError(f"The original command used {shown} {value}, which was not found on this "
                                   "computer.")
            path, how = hit
            if is_main and tool == "fiberhmm-pipeline" and is_raw_input(path, exists):
                raise _raw_refusal(path, recorded_outdir, shown)  # found elsewhere, and still raw POD5
            rewrites.append({"flag": shown, "from": value, "to": path, "why": f"not found as recorded; {how}"})
            warnings.append(f"{shown} was not found where the header records it; the Library found {path} ({how}). "
                            "Check that it is the file the original command read.")
            if is_main:
                found_input = {"flag": shown, "recorded": value, "path": path, "how": how}
            new_values.append(path)
        item["values"] = new_values
    if not found_input:
        raise CommandError(f"The header's {tool} command line names no input.")

    # Outputs: the original names, in the Library's new folder.
    output_paths: list[str] = []
    output_bam = None
    for item in items:
        kind = outputs_kind.get(item["dest"])
        if not kind:
            continue
        old = item["values"][0] if item["values"] else ""
        if kind == "outdir":
            new = outdir
        else:
            if old in ("", "-"):
                raise CommandError(f"The original command wrote {item['flag']} to a pipe ({old or '-'}), so later "
                                   "steps the Library cannot see made this file; it will not re-run it.")
            name = _basename(old)
            if name in ("", ".", "..") or name.startswith("-"):
                raise CommandError(f"The original command's {item['flag']} {old} has no file name to keep in the "
                                   "re-call's folder; the Library will not guess one.")
            new = os.path.join(outdir, name)
        if item["dest"] == "output":
            output_bam = new
        item["values"] = [new]
        output_paths.append(new)
        rewrites.append({"flag": item["flag"], "from": old, "to": new, "why": "into the re-call's folder"})
    if tool == "fiberhmm-call" and not output_bam:
        raise CommandError("The header's fiberhmm-call command line names no output (-o).")
    clashes = {p for p in output_paths if output_paths.count(p) > 1}
    if clashes:
        raise CommandError(f"Two outputs of the original command would both be {sorted(clashes)[0]} in the new "
                           "folder; the Library will not overwrite one with the other.")

    # Cores: the Library's (every occurrence: argparse keeps the last).
    cores_items = [i for i in items if i["dest"] == CORES_DEST]
    for cores_item in cores_items:
        if cores_item["values"] != [str(cores)]:
            rewrites.append({"flag": cores_item["flag"], "from": " ".join(cores_item["values"]), "to": str(cores),
                             "why": "the Library's core count"})
        cores_item["values"] = [str(cores)]
    if not cores_items and table.spelling(CORES_DEST):
        flag = table.spelling(CORES_DEST)
        items.append({"flag": flag, "spelled": None, "dest": CORES_DEST, "action": table.by_dest[CORES_DEST],
                      "values": [str(cores)]})
        rewrites.append({"flag": flag, "from": None, "to": str(cores), "why": "the Library's core count"})

    # Progress: the job's own file (it is how a restarted FiberBrowser finds the running job).
    progress_items = [i for i in items if i["dest"] == PROGRESS_DEST]
    for progress_item in progress_items:
        rewrites.append({"flag": progress_item["flag"], "from": " ".join(progress_item["values"]) or None,
                         "to": PROGRESS_PLACEHOLDER, "why": "the job's progress file"})
        progress_item["values"] = [PROGRESS_PLACEHOLDER]
        progress_item["flag"] = table.spelling(PROGRESS_DEST) or progress_item["flag"]
    if not progress_items and table.spelling(PROGRESS_DEST):
        flag = table.spelling(PROGRESS_DEST)
        items.append({"flag": flag, "spelled": None, "dest": PROGRESS_DEST, "action": table.by_dest[PROGRESS_DEST],
                      "values": [PROGRESS_PLACEHOLDER]})
        rewrites.append({"flag": flag, "from": None, "to": PROGRESS_PLACEHOLDER,
                         "why": "the job's progress file (Runs shows it)"})

    # The platform the original run declared, as the outputs.json re-call passes it.
    if "--seq" not in flags_used and platform in ("nanopore", "pacbio") and table.has("--seq"):
        items.append({"flag": "--seq", "spelled": None, "dest": "seq", "action": table.by_option["--seq"],
                      "values": [platform]})
        rewrites.append({"flag": "--seq", "from": None, "to": platform,
                         "why": "the platform this BAM declares (FIBERHMM-CHEMISTRY); 3.0 would otherwise "
                                "take it from the input's header"})

    # A basecaller override the original recorded only in its @PG DS (not on its command line): given
    # again, so the re-call keeps it even when its input does not record it (e.g. a file you chose).
    # Per field, as FiberHMM's precedence is: what the command line gives stays, the rest is added.
    override_dests: list[str] = []
    carried = recorded_override(ds)
    if carried and table.has("--basecaller-info") and table.has("--modbase-model"):
        info_dest = table.by_option["--basecaller-info"]["dest"]
        mods_dest = table.by_option["--modbase-model"]["dest"]
        info_items = [i for i in items if i["dest"] == info_dest and i["values"]]
        explicit = set(_override_fields(info_items[-1]["values"][0])) if info_items else set()
        if any(i["dest"] == mods_dest and i["values"] for i in items):
            explicit.add("modbase_models")
        why = "the basecaller override the original run recorded (@PG DS)"
        pairs = " ".join(f"{k}={carried[k]}" for k in ("program", "version", "basecall_model")
                         if k in carried and k not in explicit)
        if pairs and info_items:
            # argparse keeps the last --basecaller-info: the missing fields join that one.
            old = info_items[-1]["values"][0]
            info_items[-1]["values"] = [f"{old} {pairs}".strip()]
            override_dests.append(info_dest)
            rewrites.append({"flag": info_items[-1]["flag"], "from": old, "to": info_items[-1]["values"][0], "why": why})
        elif pairs:
            action = table.by_option["--basecaller-info"]
            items.append({"flag": "--basecaller-info", "spelled": None, "dest": info_dest, "action": action,
                          "values": [pairs]})
            override_dests.append(info_dest)
            rewrites.append({"flag": "--basecaller-info", "from": None, "to": pairs, "why": why})
        if "modbase_models" in carried and "modbase_models" not in explicit:
            action = table.by_option["--modbase-model"]
            items.append({"flag": "--modbase-model", "spelled": None, "dest": mods_dest, "action": action,
                          "values": [carried["modbase_models"]]})
            override_dests.append(mods_dest)
            rewrites.append({"flag": "--modbase-model", "from": None, "to": carried["modbase_models"], "why": why})

    # 3.0 defaults the original run predates: shown, and kept old on request where an option exists.
    keep = set(keep_old or [])
    changes = changed_defaults(tool, enzyme, flags_used, ds, indexed(found_input["path"]), nested_flags)
    for change in changes:
        restore = change.get("restore")
        if restore and not table.has(restore[0]):
            change["restore"] = None
        change["dest"] = table.by_option[change["restore"][0]]["dest"] if change.get("restore") else None
        change["kept_old"] = bool(change.get("restore") and change["id"] in keep)
        if change["kept_old"]:
            action = table.by_option[change["restore"][0]]
            items.append({"flag": change["restore"][0], "spelled": None, "dest": action["dest"], "action": action,
                          "values": list(change["restore"][1:])})
            rewrites.append({"flag": change["restore"][0], "from": None, "to": " ".join(change["restore"]),
                             "why": "you chose to keep the original behaviour"})
    unknown = keep - {c["id"] for c in changes if c.get("restore")}
    if unknown:
        raise CommandError(f"There is no original behaviour to keep for {sorted(unknown)[0]} in this re-call.")

    args = argv_of(items)
    input_files = [v for i in items if i["dest"] in input_dests for v in i["values"]] + nested_inputs
    last = {i["dest"]: i["values"][0] for i in items if i["values"] and outputs_kind.get(i["dest"]) == "prefix"}
    return {"tool": tool, "args": args, "items": items, "rewrites": rewrites, "warnings": warnings,
            "input": found_input, "output_bam": output_bam, "outputs": output_paths,
            "input_files": input_files, "qc_prefix": last.get("qc_output_prefix"),
            "call_args": [w for text in nested_args for w in _split_call_args(text)],
            "written": written_files(tool, output_bam, outdir, last),
            "flags": sorted(flags_used), "changed_defaults": changes,
            "original_args": recorded_args, "quoted": quoted, "call_args_rewritten": call_args_rewritten,
            "override_dests": override_dests}


# What fiberhmm-call writes beside a prefix (call.py _refuse_call_path_aliases), and next to its BAM.
_PREFIX_FILES = {"daf_snp_output_prefix": (".bed", ".vcf", ".json", ".amplicons.tsv"),
                 "qc_output_prefix": (".qc.json", ".qc.tsv", ".qc.png", ".qc.pdf", ".qc.curves.json")}


def written_files(tool: str, output_bam: Optional[str], outdir: str, prefixes: dict) -> list[str]:
    """Every file a re-call is expected to write (to refuse a folder that already holds one):
    the BAM and its index, the files beside each output prefix, and the default
    ``qc/<BAM stem>.*`` files (QC, SNP screen and dedup report)."""
    if tool != "fiberhmm-call" or not output_bam:
        return []
    out = [output_bam, output_bam + ".bai"]
    for dest, suffixes in _PREFIX_FILES.items():
        if prefixes.get(dest):
            out += [prefixes[dest] + suffix for suffix in suffixes]
    stem = os.path.splitext(os.path.basename(output_bam))[0]
    qc = os.path.join(os.path.dirname(output_bam), "qc")
    out += [os.path.join(qc, stem + suffix) for suffixes in _PREFIX_FILES.values() for suffix in suffixes]
    out += [os.path.join(qc, f"{stem}.daf_snps{suffix}") for suffix in _PREFIX_FILES["daf_snp_output_prefix"]]
    out.append(os.path.join(qc, f"{stem}.dedup.json"))
    return list(dict.fromkeys(out))


def display(tool: str, args: list[str]) -> str:
    """The new command as one would type it (never executed)."""
    return " ".join(shlex.quote(a) for a in [tool, *args])


# Dests whose value a re-call is allowed to differ in from the original (each one is a listed rewrite).
def allowed_changes(tool: str, result: dict) -> set[str]:
    allowed = set(OUTPUTS.get(tool, {})) | {PROGRESS_DEST, CORES_DEST, "seq"}
    if result.get("call_args_rewritten"):
        allowed.add("call_args")  # a retired option left out of it (a listed rewrite)
    allowed |= set(INPUTS.get(tool, ()))  # only when found elsewhere or chosen, which is listed
    allowed |= set(result.get("override_dests") or ())  # a recorded basecaller override given again (listed)
    for change in result.get("changed_defaults") or []:
        if change.get("kept_old") and change.get("dest"):
            allowed.add(change["dest"])
    return allowed


def silent_changes(before: dict, after: dict, allowed: set[str]) -> list[str]:
    """Dests whose parsed value differs between the original and the re-call, other than the listed rewrites."""
    out = []
    for dest in sorted(set(before) | set(after)):
        if dest in allowed:
            continue
        if before.get(dest) != after.get(dest):
            out.append(dest)
    return out

