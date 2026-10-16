# Workflow: data on a cluster (Connect to cluster…)

[← Docs index](../index.md) · [← User guide](../guide.md)

Run FiberBrowser on your laptop (the Mac app or `pip install fiberbrowser`)
and open BAM, BigBed, FASTA and plasmid-map files that stay on your
university or institute cluster. Nothing is copied
up front and nothing is installed on the cluster. FiberBrowser signs in with
your own `ssh` and then reads only the byte ranges it needs.

Another option, a FiberBrowser app for the cluster's Open OnDemand web portal
that runs FiberBrowser on a compute node, is being prepared separately.
Use it when you need whole-genome views or footprint-class runs on data that is
too large to move.

## What you need

- **On your computer:** macOS or Linux with OpenSSH (the `ssh` command). Both
  come with it. Windows' `ssh` can't share one sign-in between sessions
  (ControlMaster), so on Windows run FiberBrowser in WSL.
- **On the cluster:** only SSH access, plus Python 3.6 or newer on the login
  node. Most clusters have `/usr/bin/python3`, so nothing more is needed.
  If your cluster has no `python3`, give the full path of one under
  **Advanced… → Remote Python**. For example, run `module load anaconda3` and
  then `which python3` on the cluster.
- **Indexes next to the data:** `samtools index` for each BAM (`.bai` or `.csi`)
  and `samtools faidx` for a FASTA (`.fai`, plus `.gzi` when bgzipped). Run
  these on the cluster, next to the files.

## One-time SSH setup

1. **An SSH key**, so you don't type a password every time:

   ```bash
   ssh-keygen -t ed25519                      # on your laptop, once
   ssh-copy-id <username>@login.hpc.example.edu    # adds the public key on the cluster
   ```

   If your cluster doesn't accept keys, or also asks for Duo, that works too.
   See step 3.

2. **A `Host` entry** in `~/.ssh/config`. The name you give it (`hpc` below)
   is what you pick in FiberBrowser:

   ```
   Host hpc
       HostName login.hpc.example.edu
       User <username>
   ```

   Jump hosts (`ProxyJump`), other ports and other identities work as usual.
   FiberBrowser runs your own `ssh`, which reads this file.

3. **Duo / two-factor: share one sign-in.** Add this to the same entry so one
   Duo approval covers every SSH session for a few hours: your terminal,
   `scp`, and FiberBrowser.

   ```
   Host hpc
       HostName login.hpc.example.edu
       User <username>
       ControlMaster auto
       ControlPath ~/.ssh/cm-%r@%h:%p
       ControlPersist 4h
   ```

   With this, once you are logged in to `hpc` in any terminal, FiberBrowser
   connects straight away with no prompt.

## Connecting

1. **Connect to cluster…**: on the welcome screen, or in the sidebar under
   **Data & Sessions → Connect to cluster**.
2. **Host**: pick one of the `Host` entries from your `~/.ssh/config` or type a
   host name. **User** is optional.
3. **Folders to share**: one per line, for example `~` and `/projects/MYLAB`.
   FiberBrowser can read files in these folders and below them, and nothing
   else. `~` and `$VARS` such as `/scratch/gpfs/$USER` are expanded on the
   cluster.
4. **Connect.** What happens next:
   - Your open SSH connection, or keys/agent: it connects within a second or two.
   - A password, a Duo prompt or a first-time host key: a Terminal window opens
     running the sign-in command. The dialog shows the same command, so you
     can also paste it into any terminal. Answer the prompts there and
     FiberBrowser continues by itself. FiberBrowser never sees your password.
5. **Browse** the shared folders. The filters show **BAM / BigBed**,
   **FASTA / maps** or **All files**, and BAMs and FASTAs are marked *indexed*
   or *no index*. Tick files and press **Open**:
   - a FASTA becomes the reference, read through its `.fai`;
   - one plasmid map with BAMs opens as a plasmid dataset, with the BAM contigs
     linked to the map by sequence (see [Plasmids](plasmids.md));
   - BAM and BigBed files become datasets, as with local files.

The connection row shows the login node, the round-trip time and the current
transfer rate. **Disconnect** stops the file helper and the port forward.
Tick *also close the SSH sign-in* to end the SSH connection as well. Otherwise
it stays open for 30 minutes, so you can reconnect without Duo.

The same dialog has an **S3 bucket** tab. Type `s3://bucket/folder/`, and
optionally an AWS profile or an S3-compatible endpoint, to browse a bucket and
open its BAM/BigBed files and plasmid maps the same way. Setting up a bucket
for the lab: [Lab data on S3](s3-lab-data.md).

## Sessions and the Library

Datasets opened this way are saved by reference, as
`ssh://hpc/projects/MYLAB/run1/sample.bam` (`ssh://user@host/...` when you
gave a user). The live connection details are never saved. When you restore a
session that uses such files, FiberBrowser opens **Connect to cluster** with
the host and the files' folders filled in, and continues the restore once you
are connected. If you close the dialog instead, nothing is restored and what
is open now stays as it is; connect and restore the session again.

A reference with a user (`ssh://alice@hpc/...`) opens only through a
connection that signs in as that user: one you made as `alice@hpc`, or one
made as plain `hpc` when your `~/.ssh/config` makes `alice` the user for
`hpc` (FiberBrowser asks `ssh -G`). Otherwise it asks you to connect as
`alice`, so the same path is never read from another account.

The **Library** records files you open from a cluster by the same reference.
The Library window has its own **Connect to cluster…** button. Opening a
cluster entry asks you to connect to its host first; while you are not
connected, the entry is still listed and openable, not shown as missing.

## On a shared lab server

A lab server (`profile = "lab"`) doesn't offer Connect to cluster, and it
refuses the `/api/remote/*` routes and `ssh://` references. The SSH sign-in
would run as the server's own account on behalf of every member. A lab server
reads its files directly from its data folders. If it runs on the cluster
itself (for example through OnDemand), put the data under one of those
folders. To use Connect to cluster, run FiberBrowser on your own computer.

## What is transferred, and how fast it is

- **Read on demand:** only the byte ranges of the BAM/BigBed a view needs, over
  your SSH connection (encrypted).
- **Copied once to your computer:** each BAM's `.bai`/`.csi` index (a few MB at
  most), and plasmid maps (whole, since they are small). Both go to
  `~/.fiberhmm/remote_cache/` and are refreshed whenever the file on the
  cluster is rewritten or replaced (its size, modification time to the
  nanosecond, change time or inode differ), and an index also when its BAM
  is. A copy is kept only if the file did not change while it was copied.
  The cache prunes itself: copies unused for 30 days go, and beyond 5 GB the
  least recently used go first (copies used in the last hour are kept).
- **Written on the cluster: nothing** but the helper's private socket folder
  (`/tmp/fbh-…`, readable by you only), removed when the helper stops. The
  helper is read-only.

Measured on a Mac through a real SSH connection on the same machine, so the
network cost is not included. Data: a daf_timecourse DAF-seq BAM,
long molecules.

| | Local file | Through SSH |
|---|---:|---:|
| Open a BAM (header; index already cached) | 1–2 ms | 5 ms |
| Reads of one amplicon (chr2L:15.47–15.49 Mb, 11,304 molecules) | 0.25 s | 0.25 s, **5 requests, 67 MB** |
| Reads of the *gt* amplicon from a 397 MB BAM (5,583 molecules) | 0.16 s | 0.17 s, 5 requests, 46 MB |
| Adding the 397 MB BAM as a dataset (layer probe) | 0.8 s | 30 requests, ~47 MB |
| A BigBed window (500 molecules) | 1.0 s | 0.6 s, 14 requests, 1.4 MB |

On a real network, time is mostly **data ÷ bandwidth**. BAM views need only a
handful of requests, so round-trip time matters little. For the amplicon
above: about 0.7 s on a 1 Gbit/s campus link, 5–7 s at 100 Mbit/s, and a
minute on slow home broadband. FiberBrowser keeps the reads it has loaded, so
panning and zooming inside the amplicon is instant afterwards.

Limits:

- **Whole-chromosome and genome-wide views** (coverage along a chromosome, best
  covered windows, genome-wide scans) read far more data than one locus and are
  much slower than on local files. Zoom in to a locus or amplicon first.
- **Footprint-class (consensus) runs** read every molecule of the region through
  FiberHMM, which needs the files on your computer. Such a run on a cluster
  dataset stops with a message. Copy the BAM (or the region, with
  `samtools view -b`) to your computer, or run FiberHMM on the cluster.
- **Layer detection** on a cluster BAM checks a smaller sample of reads than for
  a local BAM (20 reads, plus up to 250 in the sparse-tag check), so that
  opening it doesn't download ~150 MB. If a layer you expect is missing, see
  [DAF-seq: missing layers](daf-seq.md#missing-layers).

## Security

- **On the login node, only your account can reach the helper.** It listens
  on a Unix socket inside a new folder only you can open (`/tmp/fbh-…`,
  mode 0700), not on a network port. FiberBrowser reaches it with an SSH
  forward from **127.0.0.1 on your computer** to that socket (OpenSSH's
  `ssh -L 127.0.0.1:PORT:/path/to/socket`). The folder is made only inside
  one no other account can change (your private runtime folder, or a sticky
  `/tmp` owned by root, with every folder above it the same); the folders you
  shared are opened from `/` one step at a time without following links and
  checked to be the very folders you named.
- **If the cluster refuses socket forwarding** (`AllowStreamLocalForwarding
  no`, or a very old sshd), or no such safe temporary folder exists there,
  FiberBrowser switches by itself to the earlier
  arrangement: the helper binds **127.0.0.1 on the login node** on a random
  port, which other users of that node can reach, so everything then rests on
  the token below. The connection's details show which one is in use.
- Every request needs a **random per-connection token** (32 random bytes). A
  request with a wrong token gets the same "not found" as a missing file. The
  token is sent to the helper over SSH (never on a command line, so other
  users of the login node can't see it in `ps`). It is never shown in the UI
  or saved in sessions.
- **The addresses htslib and pyBigWig open carry a per-file key, not the
  token.** The key is derived from the token and opens only that one file (and
  its `.fai`/`.gzi`/`.bai`/`.csi` next to it). FiberBrowser replaces these
  addresses by the `ssh://` reference in everything it prints, logs or
  returns to the page, and keeps htslib quiet while it opens them. What
  remains: if a read fails *after* a file was opened (a dropped connection
  mid-read), htslib may still print the address to the FiberBrowser server's
  own error output (the terminal or log it was started from), where FiberBrowser
  cannot rewrite it. That key opens only that file, only from your computer,
  and only while you stay connected.
- **Read-only and confined:** GET and HEAD only. Every path is resolved with
  `realpath` and must lie inside a folder you shared: `../` and symlinks that
  point outside are refused, and such links don't appear in listings. The file
  or folder is then opened step by step from the shared folder itself, never
  following a symlink, so a folder swapped for a link at the wrong moment is
  refused too. Only regular files are served, never FIFOs or devices.
- **Bounded:** at most 256 connections at a time (more are turned away at
  once), a request must arrive within 20 seconds and idle connections are
  closed after that, a download nobody reads is abandoned after 15 minutes,
  a single byte range may be at most 256 MB and a malformed range is refused
  instead of answered with the whole file. A listing shows at most 5,000
  entries and reads at most 50,000 within 5 seconds; the dialog says when a
  folder is only partly listed. (With Python 3.6 on the cluster this needs `/proc`; where
  there is none, folders aren't listed and the dialog asks for a newer
  **Remote Python**. Files opened by reference still work.) (htslib reads a BAM as one stream from the
  offset it needs to wherever it stops, so those streams are not capped in
  size; they only advance as fast as FiberBrowser reads them.)
- **No shell from the browser:** FiberBrowser runs only the fixed `ssh`
  commands, as argument lists. Host and user names are checked (letters,
  digits, `.`, `_`, `-`; a leading `-` is refused, so nothing like
  `-oProxyCommand=…` can be passed), and `--` comes before the host. The one
  remote command is fixed: it finds Python 3.6 or newer and starts the helper.
- **Short-lived:** the helper stops as soon as its SSH session ends (Disconnect,
  quitting FiberBrowser, or a dropped connection), or after 8 hours without a
  request, and removes its socket folder.
- **Your own computer only:** Connect to cluster is refused on `--public`
  servers, on shared lab servers and in tour tabs.
- Other programs on your computer can reach the forwarded port, like any
  localhost port, but can't read anything without the token or a file's key.

Login nodes are shared. The helper is one small Python process: a few MB of
memory and no CPU while idle, running only while you are connected. It serves
file bytes and does no computing. If your cluster has a data-transfer or
visualization node that allows SSH, you can connect to that host instead.

## Troubleshooting

| Message | What to do |
|---|---|
| *Unknown host* | Check the `Host` name, or use the full host name. |
| The dialog waits in *authenticating* | Finish the password / Duo prompt in the terminal window, or run the command shown in the dialog in any terminal. |
| *No Python 3.6 or newer was found* | Set **Advanced… → Remote Python** to the full path of a `python3` on the cluster. |
| *Not found under the shared folders* | Add the file's folder to **Folders to share** and connect again. |
| *no index* next to a BAM or FASTA | Run `samtools index` / `samtools faidx` on the cluster. |
| *Not connected to hpc. Use Connect to cluster…* | The connection ended (network change, sleep). Connect again; loaded datasets keep working after that. |
| Windows | Run FiberBrowser in WSL, or use the cluster's OnDemand. |

Settings for administrators and tests (environment variables of the server):
`FIBERBROWSER_SSH` (the `ssh` program), `FIBERBROWSER_SSH_CONFIG` (an ssh
config file, passed as `-F`), `FIBERBROWSER_SSH_DIR` (where the control
sockets go, default `~/.fiberhmm/ssh`), `FIBERBROWSER_REMOTE_CACHE` (the
index and map cache, default `~/.fiberhmm/remote_cache`),
`FIBERBROWSER_REMOTE_CACHE_MAX_MB` (its size limit, default 5120) and
`FIBERBROWSER_REMOTE_CACHE_MAX_AGE_DAYS` (unused copies are removed after this
many days, default 30).

## For developers: storage sources

The cluster connection and S3 are two *sources* behind one small interface
(`browser/services/remote_sources/`). You can add another storage source as a
module, and it gets the same browse / open dialog and reference handling:

```python
from services.remote_sources import register_source
from services.remote_sources.base import RemoteSource

class MyStore(RemoteSource):
    scheme = "mystore"          # references look like mystore://<target>/<path>
    label = "My storage"

    def describe(self, *, probe=False): ...   # availability and connections (no secrets)
    def connect(self, params): ...            # sign in / configure
    def disconnect(self, target, **options): ...
    def is_connected(self, ref): ...
    def list(self, ref): ...                  # {"path", "entries": [{name, type, size, mtime}], "truncated"}
    def stat(self, ref): ...                  # {"type", "size", "mtime", "version"?} or None
    def open_url(self, ref): ...              # a URL htslib and pyBigWig can range-read
    def fetch_bytes(self, ref, max_bytes): ...  # a whole small file (maps)

register_source(MyStore())
```

Then add one import to `_load_builtin_sources()` in `remote_sources/__init__.py`.
Datasets, sessions and the Library store only the reference. The live URL
from `open_url` is made when a file is opened
(`remote_sources/opening.py`: `open_alignment_file`, `open_bigwig`,
`open_fasta`, `local_copy`). The routes are `/api/remote/sources`,
`/connect`, `/disconnect`, `/list` and `/refs_status`. They are refused on
public servers.
