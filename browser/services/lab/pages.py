"""Server-rendered pages of a lab server: sign in, accept an invite, admin.

Plain HTML (no build step), styled to match; every URL goes through the root
path, and every form carries the CSRF token of the ``fiberbrowser_csrf``
cookie. ``index_flags``/``index_body_snippet`` add the member bar (who is
signed in, Admin, Sign out; or "Sign in" for public-catalog visitors) to the
app page.
"""
from __future__ import annotations

import html
import json
from typing import Optional

_STYLE = """
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
main{max-width:26rem;margin:8vh auto;padding:2rem;background:#fff;border:1px solid #e2e8f0;border-radius:12px;
box-shadow:0 1px 3px rgba(15,23,42,.08)}
main.wide{max-width:60rem}
h1{font-size:1.25rem;margin:0 0 .25rem} p.sub{margin:0 0 1.25rem;color:#475569;font-size:.9rem}
label{display:block;font-size:.85rem;font-weight:600;margin:.75rem 0 .25rem}
input,select{width:100%;box-sizing:border-box;padding:.5rem .6rem;border:1px solid #cbd5e1;border-radius:6px;font:inherit}
button{margin-top:1.1rem;width:100%;padding:.55rem;border:0;border-radius:6px;background:#1e3a8a;color:#fff;font:inherit;
font-weight:600;cursor:pointer} button.link{background:none;color:#1e3a8a;width:auto;padding:0;margin:0;font-weight:500}
.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:6px;padding:.5rem .7rem;font-size:.88rem}
.ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;border-radius:6px;padding:.5rem .7rem;font-size:.88rem}
a{color:#1e3a8a} small{color:#64748b} table{border-collapse:collapse;width:100%;font-size:.85rem}
td,th{border-bottom:1px solid #e2e8f0;padding:.35rem .4rem;text-align:left;vertical-align:top} code{font-size:.85em}
@media (prefers-color-scheme: dark){body{background:#0f172a;color:#e2e8f0} main{background:#1e293b;border-color:#334155}
input,select{background:#0f172a;color:#e2e8f0;border-color:#475569} p.sub,small{color:#94a3b8}
td,th{border-color:#334155} a,button.link{color:#93c5fd}}
"""


def _page(title: str, body: str, *, wide: bool = False) -> str:
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>'
            f'<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
            f'<style>{_STYLE}</style></head><body><main class="{"wide" if wide else ""}">{body}</main></body></html>')


def _u(path: str) -> str:
    from services.root_path import url_for_path
    return html.escape(url_for_path(path), quote=True)


def lab_name() -> str:
    from services.lab import get_config
    cfg = get_config()
    return "FiberBrowser lab server" if cfg is None else "FiberBrowser"


def login_page(*, csrf: str, next_path: str = "/", error: Optional[str] = None, notice: Optional[str] = None,
               mode: str = "accounts", catalog: bool = False, username: str = "") -> str:
    if mode != "accounts":
        body = ("<h1>Sign in through your lab's portal</h1><p class='sub'>This FiberBrowser signs members in "
                "through the lab's single sign-on proxy. Open it from the lab's link.</p>")
        return _page("Sign in: FiberBrowser", body)
    parts = ["<h1>FiberBrowser</h1><p class='sub'>Sign in with your lab account.</p>"]
    if error:
        parts.append(f"<div class='err' role='alert'>{html.escape(error)}</div>")
    if notice:
        parts.append(f"<div class='ok' role='status'>{html.escape(notice)}</div>")
    parts.append(
        f"<form method='post' action='{_u('/auth/login')}'>"
        f"<input type='hidden' name='csrf' value='{html.escape(csrf, quote=True)}'>"
        f"<input type='hidden' name='next' value='{html.escape(next_path, quote=True)}'>"
        f"<label for='u'>User name</label><input id='u' name='username' autocomplete='username' required autofocus "
        f"value='{html.escape(username, quote=True)}'>"
        "<label for='p'>Password</label><input id='p' name='password' type='password' autocomplete='current-password' required>"
        "<button type='submit'>Sign in</button></form>"
        f"<p><small>Got an invite code? <a href='{_u('/auth/invite')}'>Choose your password</a>.")
    if catalog:
        parts.append(f" Or <a href='{_u('/')}'>browse the public catalog</a> without an account.")
    parts.append("</small></p>")
    return _page("Sign in: FiberBrowser", "".join(parts))


def invite_page(*, csrf: str, username: str = "", code: str = "", error: Optional[str] = None) -> str:
    parts = ["<h1>Choose your password</h1><p class='sub'>Use the invite code an admin gave you.</p>"]
    if error:
        parts.append(f"<div class='err' role='alert'>{html.escape(error)}</div>")
    parts.append(
        f"<form method='post' action='{_u('/auth/invite')}'>"
        f"<input type='hidden' name='csrf' value='{html.escape(csrf, quote=True)}'>"
        f"<label for='u'>User name</label><input id='u' name='username' autocomplete='username' required "
        f"value='{html.escape(username, quote=True)}'>"
        f"<label for='c'>Invite code</label><input id='c' name='code' required autocomplete='one-time-code' "
        f"value='{html.escape(code, quote=True)}'>"
        "<label for='p'>New password (10+ characters)</label>"
        "<input id='p' name='password' type='password' autocomplete='new-password' required minlength='10'>"
        "<label for='p2'>Repeat it</label><input id='p2' name='password2' type='password' autocomplete='new-password' required>"
        f"<button type='submit'>Set password and sign in</button></form>"
        f"<p><small><a href='{_u('/auth/login')}'>Back to sign in</a></small></p>")
    return _page("Invite: FiberBrowser", "".join(parts))


def admin_page() -> str:
    from services.root_path import get_root_path
    root = json.dumps(get_root_path())
    body = """
<h1>Lab admin</h1><p class="sub">Accounts and the audit log of this FiberBrowser lab server.
<a href="ROOT/">Back to FiberBrowser</a></p>
<div id="msg"></div>
<h2 style="font-size:1rem">Accounts</h2>
<table id="users"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody></tbody></table>
<form id="add" style="display:flex;gap:.5rem;align-items:end;margin-top:.75rem">
<div style="flex:2"><label for="n">New user</label><input id="n" required placeholder="user name"></div>
<div style="flex:1"><label for="r">Role</label><select id="r"><option>member</option><option>admin</option></select></div>
<div style="flex:1"><button type="submit" style="margin:0">Invite</button></div></form>
<h2 style="font-size:1rem;margin-top:1.5rem">Audit log (latest first)</h2>
<table id="audit"><thead><tr><th>Time (UTC)</th><th>Event</th><th>User</th><th>Address</th><th>Details</th></tr></thead><tbody></tbody></table>
<script>
(function(){
var ROOT=__ROOT__;
function csrf(){var m=document.cookie.match(/(?:^|; )fiberbrowser_csrf=([^;]+)/);return m?decodeURIComponent(m[1]):'';}
function api(path,opts){opts=opts||{};opts.headers=Object.assign({'Content-Type':'application/json','X-FiberBrowser-CSRF':csrf()},opts.headers||{});
opts.credentials='same-origin';return fetch(ROOT+path,opts).then(function(r){return r.json().then(function(j){if(!r.ok||j.success===false)throw new Error(j.detail||j.message||r.status);return j;});});}
function el(tag,text){var e=document.createElement(tag);if(text!=null)e.textContent=text;return e;}
function say(text,ok){var m=document.getElementById('msg');m.className=ok?'ok':'err';m.textContent=text;}
function when(t){return t?new Date(t*1000).toISOString().replace('T',' ').slice(0,16):'';}
function btn(label,fn){var b=el('button',label);b.className='link';b.type='button';b.onclick=fn;return b;}
function loadUsers(){api('/api/admin/users').then(function(j){var tb=document.querySelector('#users tbody');tb.innerHTML='';
j.users.forEach(function(u){var tr=el('tr');tr.appendChild(el('td',u.name));tr.appendChild(el('td',u.role));
tr.appendChild(el('td',u.has_password?'active':(u.invite_pending?'invited':'no password')));tr.appendChild(el('td',when(u.last_login)));
var td=el('td');td.appendChild(btn('New invite',function(){api('/api/admin/users/'+encodeURIComponent(u.name)+'/reset',{method:'POST',body:'{}'}).then(function(r){say('New invite code for '+u.name+': '+r.code+' (sign-in page: Choose your password). Their current sign-ins ended.',true);loadUsers();}).catch(function(e){say(e.message);});}));
td.appendChild(document.createTextNode(' · '));
td.appendChild(btn(u.role==='admin'?'Make member':'Make admin',function(){api('/api/admin/users/'+encodeURIComponent(u.name)+'/role',{method:'POST',body:JSON.stringify({role:u.role==='admin'?'member':'admin'})}).then(loadUsers).catch(function(e){say(e.message);});}));
td.appendChild(document.createTextNode(' · '));
td.appendChild(btn('Remove',function(){if(!confirm('Remove '+u.name+'?'))return;api('/api/admin/users/'+encodeURIComponent(u.name),{method:'DELETE'}).then(loadUsers).catch(function(e){say(e.message);});}));
tr.appendChild(td);tb.appendChild(tr);});}).catch(function(e){say(e.message);});}
function loadAudit(){api('/api/admin/audit?limit=300').then(function(j){var tb=document.querySelector('#audit tbody');tb.innerHTML='';
j.events.slice().reverse().forEach(function(ev){var tr=el('tr');tr.appendChild(el('td',(ev.ts||'').replace('T',' ').slice(0,19)));
tr.appendChild(el('td',ev.event));tr.appendChild(el('td',ev.user||''));tr.appendChild(el('td',ev.ip||''));
var d=Object.assign({},ev);['ts','event','user','ip'].forEach(function(k){delete d[k];});tr.appendChild(el('td',JSON.stringify(d)));tb.appendChild(tr);});}).catch(function(e){say(e.message);});}
document.getElementById('add').onsubmit=function(e){e.preventDefault();var n=document.getElementById('n').value.trim();
api('/api/admin/users',{method:'POST',body:JSON.stringify({name:n,role:document.getElementById('r').value})}).then(function(r){
say('Invited '+r.name+'. Give them this one-time code: '+r.code+' (sign-in page: Choose your password).',true);document.getElementById('n').value='';loadUsers();loadAudit();}).catch(function(e){say(e.message);});};
loadUsers();loadAudit();})();
</script>"""
    from services.root_path import url_for_path
    body = body.replace("ROOT/", html.escape(url_for_path("/"), quote=True)).replace("__ROOT__", root)
    return _page("Lab admin: FiberBrowser", body, wide=True)


# ---------------------------------------------------------------------------
# The member bar injected into the app page
# ---------------------------------------------------------------------------

def index_flags() -> list[str]:
    from services.lab import get_config
    from services.runtime import current_lab_user, is_anonymous_visitor
    cfg = get_config()
    user = current_lab_user()
    info = {
        "user": user.name if user else None,
        "role": user.role if user else None,
        "auth": cfg.auth.mode if cfg else None,
        "anonymous": is_anonymous_visitor(),
        "jobs": bool(cfg and cfg.jobs.enabled),
    }
    return [f"window.__FIBERBROWSER_LAB__ = {json.dumps(info)};"]


def index_body_snippet() -> str:
    from services.lab import get_config
    from services.root_path import url_for_path
    from services.runtime import current_lab_user
    cfg = get_config()
    user = current_lab_user()
    style = ("position:fixed;right:8px;bottom:6px;z-index:2147483000;font:12px system-ui,sans-serif;"
             "background:rgba(15,23,42,.82);color:#e2e8f0;padding:3px 9px;border-radius:999px;"
             "display:flex;gap:8px;align-items:center")
    link = "color:#bfdbfe;text-decoration:none"
    if user is None:
        return (f'<div id="fb-lab-bar" data-testid="lab-bar" style="{style}">Public catalog · '
                f'<a style="{link}" href="{html.escape(url_for_path("/auth/login"), quote=True)}">Sign in</a></div>')
    parts = [f'<span data-testid="lab-user">{html.escape(user.name)}{" (admin)" if user.is_admin else ""}</span>']
    if user.is_admin:
        parts.append(f'<a style="{link}" href="{html.escape(url_for_path("/admin"), quote=True)}" target="_blank">Admin</a>')
    if cfg is not None and cfg.auth.mode == "accounts":
        parts.append(
            f'<form method="post" action="{html.escape(url_for_path("/auth/logout"), quote=True)}" style="margin:0" '
            'onsubmit="var m=document.cookie.match(/(?:^|; )fiberbrowser_csrf=([^;]+)/);'
            'this.csrf.value=m?decodeURIComponent(m[1]):\'\';">'
            '<input type="hidden" name="csrf" value="">'
            f'<button type="submit" data-testid="lab-signout" style="all:unset;cursor:pointer;{link}">Sign out</button></form>')
    return f'<div id="fb-lab-bar" data-testid="lab-bar" style="{style}">{" · ".join(parts)}</div>'
