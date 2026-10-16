# Always-on lab server (optional)

[← Deployment](index.md)

One FiberBrowser that the whole lab signs in to, on a lab workstation or a VM
on the institution's network. Everyone sees all data under the data roots, and
everyone shares the Library, runs and saved sessions. Each run and session
shows who made it.

## Set it up

1. Install FiberBrowser (`pip install "fiberbrowser[pipeline]"` into a venv or
   conda env, or use Docker below).
2. Copy [`deploy/lab/fiberbrowser-server.example.toml`](../../deploy/lab/fiberbrowser-server.example.toml)
   to `/etc/fiberbrowser/fiberbrowser-server.toml`. Set the data roots, the
   state folder and `public_url`, then check it:
   `fiberbrowser check-config /etc/fiberbrowser/fiberbrowser-server.toml`.
3. Create the first admin:
   `fiberbrowser users invite alice --role admin --config /etc/fiberbrowser/fiberbrowser-server.toml`.
   Alice opens the sign-in page, clicks *Choose your password*, and enters the code.
   After that, admins invite others from the **Admin** page (the link in the
   bar at the bottom right).
4. Run it as a service with [`deploy/lab/fiberbrowser.service`](../../deploy/lab/fiberbrowser.service)
   (systemd), listening on `127.0.0.1:8000`.
5. Put HTTPS in front with [`deploy/lab/Caddyfile.lab`](../../deploy/lab/Caddyfile.lab).
   Use `tls internal` for Caddy's own CA (install its root certificate on the
   lab's machines once), or the institution's certificate. Cookies become
   `Secure` automatically over HTTPS.

**Docker instead:** [`deploy/lab/docker-compose.lab.yml`](../../deploy/lab/docker-compose.lab.yml)
runs FiberBrowser and Caddy together with
[`deploy/lab/lab-docker.toml`](../../deploy/lab/lab-docker.toml).

**Single sign-on:** if the institution's SSO proxy (for example
Shibboleth or OIDC in Apache or nginx) sits in front, set `auth.mode = "proxy"`.
Set `trusted_proxies` to the proxy's address and `admins` to the admins' user
names. Make sure the proxy removes any `X-Forwarded-User` that a client sends.

## Backups

Everything the lab shares is in the state folder (`[state] dir`). Back it up
with the lab's usual tools, nightly:

- `users.json` (accounts, password hashes) and `logins.json` (active sign-ins)
- `library.json`, `sessions/` (the lab session shelf), `jobs/` (the run registry)
- `audit.log` (JSON lines, one event each; rotate it yearly if it grows)
- `uploads/`, which is disposable

The data roots are the lab's own data and are backed up however the lab
already does. FiberBrowser never changes files there, except in writable roots.

## Checking on it

```bash
fiberbrowser audit --config /etc/fiberbrowser/fiberbrowser-server.toml --tail 50
fiberbrowser audit --config ... --event login_failed
fiberbrowser users list --config ...
```
