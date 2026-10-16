# Personal use on a cluster (optional)

[← Deployment](index.md)

The simplest way to look at cluster data is still FiberBrowser on your own
computer, opening the files remotely. When the data must stay on the cluster,
run FiberBrowser **on a compute node, for yourself**. Web servers usually
aren't allowed on login nodes.

## Install once

```bash
mamba env create -f deploy/cluster/environment.yml    # FiberBrowser + FiberHMM + minimap2
# or build an image: apptainer build fiberbrowser.sif deploy/cluster/fiberbrowser.def
```

## Through Open OnDemand

If your cluster has Open OnDemand, use the [FiberBrowser app](ondemand.md). It
handles the node, the port and the password for you.

## Through an SSH tunnel

```bash
# On the cluster (an interactive job; the scheduler options are your site's):
srun --cpus-per-task=4 --mem=16G --time=4:00:00 --pty bash
conda activate fiberbrowser
fiberbrowser --port 8123 --no-open-browser -b /path/to/sample.bam
#   Open http://localhost:8123/?token=...      <- note this link

# On your computer (replace NODE with the compute node's name):
ssh -N -J you@cluster-login.example.edu -L 8123:localhost:8123 you@NODE
# then open the printed link, with localhost:8123, in your browser
```

The tunnel ends on the compute node's own `127.0.0.1`, where FiberBrowser
listens by default, so nothing else on the cluster can reach it, and your
browser is the server's owner with every feature. The access token in the link
keeps other users of the node out, so share the link with no one.
`~/.fiberhmm/browser_runtime.json` (readable only by you) lists your running
servers and their links.

If your cluster doesn't let you SSH to a compute node that runs your job, use
[Open OnDemand](ondemand.md). A server started with `--host 0.0.0.0` and
reached through the login node (`-L 8123:NODE:8123`) sees your browser as
another machine: it gets the read-only view (no loading files, runs or
settings; see [Remote access and security](index.md#remote-access-and-security-personal-servers)).
