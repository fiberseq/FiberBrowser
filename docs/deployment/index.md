# Deploying FiberBrowser on a server (optional)

[← Documentation](../index.md)

Most people run FiberBrowser on their own computer (`fiberbrowser`, or the Mac
app) and need nothing here. These pages are for running it **on a server** for
yourself or for a lab. They are optional deployment paths; pick one.

| You want | Read |
|---|---|
| FiberBrowser on a cluster, just for you | [Personal use on a cluster](personal-cluster.md) |
| A cluster app for the lab, through Open OnDemand | [Open OnDemand app](ondemand.md) |
| An always-on lab server (a lab workstation or VM) | [Lab server](lab-server.md) |
| A public, anonymous catalog on the internet | [A public server](public-server.md) |

## Remote access and security (personal servers)

A personal FiberBrowser (the default: not `--public`, not a lab server) can
read your files, start runs, use your SSH and S3 credentials and stop itself.
Those powers belong to **your browser on the computer it runs on**. Everything
else gets less, whatever it presents.

**Who is the owner.** A request is the owner's only when all three hold:

- it comes straight from a loopback address (`127.0.0.1`, `::1`,
  `::ffff:127.0.0.1`);
- it carries no proxy header: `X-Forwarded-For`, `X-Forwarded-Proto`,
  `X-Forwarded-Host` (and the other `X-Forwarded-*`), `Forwarded`,
  `X-Real-IP`, `Via`, or Tailscale's `Tailscale-User-Login`/`-Name`/
  `-Profile-Pic`;
- its `Host` is `localhost`, `127.0.0.1` or `[::1]` (any port).

Anything else is a **remote** client. That includes a phone or laptop on the
Wi-Fi (`--host 0.0.0.0`), and also every request that arrives through a
reverse proxy on this computer (`tailscale serve`, Caddy, nginx): a proxy
connects from loopback, so the address alone never decides. Headers can only
make a request remote, never the owner's: none of them is believed for an
address. (Uvicorn replaces the peer from `X-Forwarded-For` only when the
connection itself comes from `127.0.0.1`, and the header then marks the
request as proxied anyway.) The desktop app, a browser tab on this computer,
`browser_client` and the figure renderer talk to `127.0.0.1` directly and are
the owner.

A proxy on this computer must therefore say that it is one. `tailscale
serve`, Caddy and Apache add `X-Forwarded-For` by default. **nginx does not**:
with a bare `proxy_pass http://127.0.0.1:8757;` and no `proxy_set_header`,
its requests look exactly like your own browser's and get the full app. Add
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (and keep
`Host $host`), or better, use a lab server behind it. An SSH tunnel to the
server's loopback (`ssh -L 8000:localhost:8000`) is deliberately the owner.

**What a remote client may do.** Remote clients still need the access token
(the link). With it they get a **read-only view**: viewing, navigation and
per-view analysis (clustering, filters, sorting, peak scans): the routes in
`REMOTE_ALLOWED` (`browser/services/remote_access.py`), listed one by one, all
of them also on the public server's allowlist; the public routes left out are
listed with the reason in `REMOTE_EXCLUDED`. They never get: file browsing or
loading by path, uploads or any write, any job (FiberHMM runs, QC, Find
classes, primers and BLAST, figure rendering, plugin packs' jobs), Connect to cluster (SSH),
S3 settings, Copilot, Jupyter, plugins, settings, opening links, a new
window, the tab heartbeat, Quit or shutdown, and no WebSocket. One central
guard decides, and a route nobody has classified is owner-only (also a new
public route, an OPTIONS handler other than a configured CORS preflight, or a
separate HEAD handler), so a new feature is closed to other devices until
someone opens it (`tests/test_remote_access.py` lists
every route's class). Until viewers get their own view state, a remote
client's clustering or filters change the one shared view.

**Shutdown.** The "last tab closed, stop the server" beacon, the tab
heartbeats and Quit answer only the owner. A phone's tab never counts as an
open tab, and closing or suspending it can't stop the server.

**Network binds.** A personal server **refuses to start** on a non-loopback
interface (`--host 0.0.0.0`, a LAN address) when the token is off with
`--no-token` or `FIBERBROWSER_NO_TOKEN`. `require_token: false` in
`~/.fiberhmm/browser_settings.json` applies to `127.0.0.1` only: with
`--host 0.0.0.0` the token is on and a note says so. There is no flag to
override this; a server for several people is a [lab server](lab-server.md),
and an anonymous one is a [public server](public-server.md). With the token
off (on loopback), the server answers no remote client at all, so a
`tailscale serve` in front of it serves nothing but 403s.

**Recommended way to reach your FiberBrowser from another device:** keep it
on `127.0.0.1` and put `tailscale serve` (HTTPS, reachable only from your
tailnet) or an SSH tunnel to the server's own loopback in front. Never put a
personal server on the internet (router port forwarding, ngrok, Cloudflare
quick tunnels): use a public server for that.

### Viewer access (design; not built yet)

The mobile plan's phone view adds a third scope, **viewer**, next to owner
and remote. The guard already supports it: `request_scope` returns the scope,
and each non-owner scope has its own allowlist (`VIEWER_ALLOWED`, today the
same routes as `REMOTE_ALLOWED`, never larger). A viewer:

- gets only `VIEWER_ALLOWED`: never owner routes, files, jobs or shutdown;
- gets its own view state, as a public server's visitor does, so a phone never
  moves the desktop's view (the reason it isn't switched on yet);
- never counts as an open tab;
- is identified by a credential separate from the owner's token, which the
  owner can revoke.

Two ways to grant it without a QR code (open a bookmarked address on the
phone):

- **Tailnet identity (recommended).** The server stays on `127.0.0.1` behind
  `tailscale serve`. Serve adds `Tailscale-User-Login` to requests from the
  tailnet and removes any copy the client sent; it adds none for tagged
  devices or Funnel (public) traffic ([Tailscale Serve: identity
  headers](https://tailscale.com/kb/1312/serve)). A request with a proxy
  marker, a loopback peer, and a login on the owner's allowed list (default:
  the owner's own login) would get the viewer scope with no token. Tailscale
  decides who can reach the address; the list decides who is a viewer. Only
  for a loopback bind: on `0.0.0.0` anyone on the Wi-Fi could send the
  header, so identity headers would be ignored there. Caveat: any program on
  this computer could forge the header too, which is acceptable on a
  single-user Mac only (on a shared machine, use the PIN).
- **Viewer PIN.** The owner sets a short PIN; the phone enters it once on a
  sign-in page and gets a long-lived (30-day), revocable, HttpOnly viewer
  cookie, separate from the owner's token. Needs a rate limit and lockout on
  attempts (the lab server's login limiter) and HTTPS for the cookie to be
  Secure. Works without Tailscale (same-room Wi-Fi with `--host 0.0.0.0` and
  the token on).

## One config file

Every server reads one TOML file:

```bash
fiberbrowser serve --config fiberbrowser-server.toml
fiberbrowser check-config fiberbrowser-server.toml     # validate it first
```

Command-line flags keep working and win over the file. `profile` picks the
kind of server:

- `personal`: today's default. One user; every launch has an access token.
- `public`: today's `--public`. Anonymous visitors, a read-only catalog, resource limits.
- `lab`: a shared lab server. Members sign in and all see the same data, a
  shared Library, shared runs and saved sessions, each attributed to the person
  who made it.

[`deploy/lab/fiberbrowser-server.example.toml`](../../deploy/lab/fiberbrowser-server.example.toml)
lists every key with its default.

## The lab profile in short

- **Data roots.** Members browse and open files only under `[[data.roots]]`
  (symlinks that point outside are refused). Runs and exports write only to
  roots marked `writable = true`.
- **Shared state folder** (`[state] dir`): `library.json`, `jobs/`,
  `sessions/` (the lab session shelf), `uploads/`, `users.json`,
  `logins.json` and `audit.log`. Back it up.
- **Sign-in** (`[auth] mode`):
  - `accounts`: built-in accounts. `fiberbrowser users invite <name> --role admin --config ...`
    prints a one-time code the person uses on the sign-in page to choose a
    password. Admins manage accounts and read the audit log on the Admin page
    or with `fiberbrowser users` / `fiberbrowser audit`.
  - `proxy`: a reverse proxy that signs people in (single sign-on) passes the
    user name in `X-Forwarded-User` (`proxy_header`). It is believed only from
    `trusted_proxies`.
  - `none`: no sign-in, for a server that is reachable only through a portal
    that already authenticated the person (Open OnDemand). The launch token
    (`FIBERBROWSER_TOKEN`) still has to be presented.
- Each member keeps their own view (loaded datasets, position, filters).
- **Runs** ("New DAF-seq run") are off unless `[jobs] enabled = true`, with
  per-member and total limits.
- Copilot is off on servers.
- `[public_catalog] enabled = true` also lets people who aren't signed in
  browse a catalog read-only, with the public-mode rules.
- **Under a URL prefix** (`server.root_path`, or `--root-path`): the app works
  behind a proxy that serves it at a sub-path such as `/fiberbrowser/` or
  OnDemand's `/rnode/<host>/<port>/`, whether or not the proxy strips the prefix.

Security notes: session cookies are HttpOnly and SameSite (Secure over HTTPS,
or always with `auth.secure_cookies = "always"` or an `https://` `public_url`)
and scoped to the root path. Sign-in attempts are rate limited, with lockout.
Passwords are stored as scrypt hashes. The audit log records sign-ins, uploads,
runs, shared sessions and admin actions, never passwords or tokens.

What needs sign-in, and what counts as a same-site request, exactly:

- Every request needs a signed-in member (or, with `[public_catalog]`, is an
  anonymous visitor under the public-mode rules), whatever its method,
  including OPTIONS. The exceptions: the sign-in pages (`/auth/login`,
  `/auth/logout`, `/auth/invite`), the app's static files (`/assets/`,
  `favicon.ico`), `GET`/`HEAD /api/health` (answers `{"status": "ok"}` for load
  balancers, nothing else), and a CORS preflight from an origin listed in
  `FIBERBROWSER_CORS_ORIGINS` (a preflight carries no credentials).
- A state-changing request (POST, PUT, PATCH, DELETE) needs one of: the
  `X-FiberBrowser-CSRF` header equal to the `fiberbrowser_csrf` cookie (the app
  always sends it); `Sec-Fetch-Site: same-origin`; or an `Origin` equal to this
  server's origin (its `public_url`, its `Host`, or `X-Forwarded-Host` from a
  trusted proxy). Browsers set `Sec-Fetch-Site` and `Origin` themselves, so a
  page on another site can't produce them; the headless figure renderer, which
  has no CSRF cookie, relies on them. With `auth = "none"`, a script that sends
  the launch token in `X-FiberBrowser-Token` needs no CSRF token (a browser
  never adds that header on its own).
- `X-Forwarded-Host`/`-Proto` are believed only from a proxy listed explicitly
  in `auth.trusted_proxies` (or `--trusted-proxy`,
  `FIBERBROWSER_TRUSTED_PROXIES`); without a list, never. Behind Open OnDemand
  (no list) the browser's own `Sec-Fetch-Site` lets its requests through.
- Files: every file a member's request reads or writes, and every file named
  by stored data (run records, QC manifests, BAM headers, companions, the
  shelf), is checked against the data roots where it is opened, and opened by a
  walk of folder descriptors that follows no symlink, so a folder or file
  swapped for a link after the check is refused; the walk starts at `/`, and
  each data root is pinned (device and inode) when the server starts, so a
  root, or a folder above it, pointed elsewhere later admits nothing. BAM files
  and plain FASTA files with their indexes are handed to htslib as the checked
  descriptors (`/dev/fd/N` on Linux and macOS). Other files opened by native
  libraries (bgzip FASTA, CRAM, BigWig/BigBed, contact maps) are checked by
  resolved path just before they are opened; that leaves a window only to
  someone who can change files inside the data roots on the server itself.
  Files a run's settings name, including options inside `--call-args`
  (parsed with fiberhmm-call's own parser), are checked too.
- Runs: a run's inputs and output folder are checked against the data roots
  when it is planned, when it is retried and again when it starts; a retry of a
  run recorded under older limits (more cores than now allowed, a folder that
  is no longer writable) is refused and has to be started again.
