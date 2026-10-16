# Open OnDemand app (optional)

[← Deployment](index.md)

[Open OnDemand](https://openondemand.org) clusters can offer FiberBrowser as an
interactive app, like their Jupyter and RStudio apps. The app is a generic
Batch Connect app in
[`deploy/ondemand/fiberbrowser/`](../../deploy/ondemand/fiberbrowser/). Before
anyone can use it, the site must fill in its placeholders and install it.
Nothing here is specific to any one institution.

## What a session does

1. The form asks for cores, hours, memory, the **lab data folder** (read-only),
   an **output folder** for runs and exports, and optionally a **shared lab
   state folder** that several members give so they share a Library, saved
   sessions and an audit log.
2. `before.sh` picks a free port and a random session password.
   `script.sh` writes a `profile = "lab"` config and starts
   `fiberbrowser serve` on the compute node. The config uses
   `auth.mode = "none"`, `root_path = "/rnode/<host>/<port>"`, the password as
   the launch token, and runs enabled on the allocation's cores.
3. The session card's **Connect** button POSTs the password once. FiberBrowser
   answers with an HttpOnly cookie scoped to `/rnode/<host>/<port>/` and opens
   the app. The password never appears in a URL or in the job's log.
4. Runs started in the session use its cores and stop when it ends. Each node
   keeps its own run registry (`<state>/jobs/<host>`).

Without the password the server refuses every request, so other cluster users
who reach the node directly get nothing. All OnDemand apps share the portal's
origin: open only sessions and links you trust in the same browser (this
applies to every OnDemand app, Jupyter included).

## Install it (site checklist)

1. **Install FiberBrowser** where compute nodes can run it. Pick one:
   - a shared conda env: `mamba env create -p /shared/apps/fiberbrowser -f deploy/cluster/environment.yml`
   - an Apptainer image: `apptainer build fiberbrowser.sif deploy/cluster/fiberbrowser.def`
2. **Fill in the placeholders** in `form.yml`:
   - `cluster:`, your cluster's name in `/etc/ood/config/clusters.d/`
   - the default `lab_data_dir`
   - the default "Environment setup" lines (e.g. `module load anaconda3; conda activate /shared/apps/fiberbrowser`),
     or a default `fiberbrowser_image`
   - `bc_account` / `bc_queue` defaults, or remove them if your site doesn't use them
3. **Check `submit.yml.erb`**. It is written for Slurm (`--cpus-per-task`,
   `--mem`); adjust it for your scheduler and site policy.
4. **Try it as a sandbox app.** Enable developer mode for your account, then
   `cp -r deploy/ondemand/fiberbrowser ~/ondemand/dev/fiberbrowser`, and launch
   it from *My Sandbox Apps* in the dashboard.
5. **For everyone**, ask your cluster's research computing team to install it
   as a system app (`/var/www/ood/apps/sys/fiberbrowser`). Or share it from
   your own account if the site allows shared apps.
6. **Shared lab state**: create a group-writable folder (for example
   `/shared/lab/fiberbrowser-state`, mode `2770`, the lab's group). Every member
   enters it in the form. `script.sh` runs with `umask 007`.
7. Check that `/rnode/` is enabled on your portal (it is by default). The app
   also works through `/node/`.

## Test it without the cluster

```bash
python -m pytest tests/test_ondemand_app.py   # renders the ERB with Ruby and runs script.sh behind a fake /rnode/ proxy
python deploy/ondemand/dev/rnode_proxy.py --help
ruby deploy/ondemand/dev/render.rb deploy/ondemand/fiberbrowser/template/script.sh.erb '{"lab_data_dir": "/data", ...}'
```

`browser/frontend/tests/e2e/lab-prefix.spec.ts` signs in and uses the whole app
through the same stand-in proxy.
