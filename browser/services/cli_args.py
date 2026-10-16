"""Command-line argument parsing for FiberBrowser."""
from __future__ import annotations

import argparse
import os
from collections.abc import Sequence


def build_arg_parser() -> argparse.ArgumentParser:
    # `fiberbrowser` (the pip command) runs browser.py and names itself here.
    parser = argparse.ArgumentParser(prog=os.environ.get('FIBERBROWSER_PROG') or None,
                                     description='FiberHMM Browser - Visualization for fiber-seq footprint data')
    parser.add_argument('--bigbed_dir', '-d', help='Directory containing BigBed files')
    parser.add_argument('--bam', '-b', help='Fiber-seq BAM file(s) or BigBed file (.bb). Use comma-separated paths for multiple BAMs as single dataset (e.g., -b file1.bam,file2.bam)')
    parser.add_argument('--dataset', action='append', metavar='PATH[:LABEL]',
                        help='Add a dataset (BAM, BigBed file, or BigBed directory). Can be repeated. Optional label after colon.')
    parser.add_argument('--gtf', '-g', help='GTF annotation file')
    parser.add_argument('--fire', '-r', help='Directory containing FIRE BED files')
    parser.add_argument('--tracks', '-t', help='File listing orthogonal bigWig tracks (one per line)')
    parser.add_argument('--cool', '-c', help='Cool/mcool file for DAF-C contact matrix visualization')
    parser.add_argument('--dafc-bigbed', help='BigBed file for DAF-C footprints (if different from --bam)')
    parser.add_argument('--port', '-p', type=int, default=8000)
    parser.add_argument(
        '--host', default=None,
        help="Interface to listen on. Default 127.0.0.1 (this computer only; SSH "
             "tunnels to it get the full app). 0.0.0.0 lets other machines on the network "
             "connect with the access link, read-only (refused with --no-token). "
             "--public defaults to 0.0.0.0.",
    )
    parser.add_argument('--config', metavar='TOML',
                        help='Server configuration file (profile personal/public/lab, host/port, root path, data '
                             'roots, shared state, sign-in, jobs, limits). Flags given here win over the file. '
                             'See docs/deployment/. Also FIBERBROWSER_CONFIG.')
    parser.add_argument('--root-path', metavar='PREFIX', default=None,
                        help='Serve under a URL prefix, e.g. /rnode/<host>/<port> behind Open OnDemand or '
                             '/fiberbrowser behind a lab proxy (works whether or not the proxy strips it).')
    parser.add_argument('--no-token', action='store_true',
                        help='Do not require the per-launch access token. By default a local server '
                             'answers only requests that carry its token (the launchers open the tokened '
                             'link for you), so other users of this machine or network cannot use it. '
                             'Use --no-token only on a single-user computer; a server listening on the '
                             'network (--host 0.0.0.0) refuses to start without the token.')
    parser.add_argument('--force-port', action='store_true',
                        help='Compatibility option: busy ports are always skipped without stopping other processes')
    browser_group = parser.add_mutually_exclusive_group()
    browser_group.add_argument('--open-browser', dest='open_browser', action='store_true', default=None,
                               help='Open the local FiberBrowser URL in your default web browser after startup. This is the default for normal local launches.')
    browser_group.add_argument('--no-open-browser', '--no-open', dest='open_browser', action='store_false',
                               help='Do not open a web browser automatically after startup.')
    parser.add_argument('--copilot', choices=['off', 'auto', 'mlx', 'ollama'], default='auto',
                        help='Copilot backend (default: auto). auto = adopt a running mlx_lm.server on :8080, else spawn one from the cached MLX tier, else fall back to a running Ollama, else stay off until set up in the Copilot panel. mlx = force MLX (downloads the model if needed; Apple Silicon Macs only). ollama = force Ollama. off = disable entirely.')
    parser.add_argument('--no-copilot', dest='no_copilot', action='store_true',
                        help='Leave the Copilot out entirely: nothing is downloaded or started, the page '
                             'hides it and its routes refuse (FiberBrowser.app runs this way). '
                             'Same as FIBERBROWSER_COPILOT=off.')
    parser.add_argument('--copilot-model', default=None,
                        help='Override the auto-selected model id (e.g. fiberbrowser-copilot-7b-v1, fiberbrowser-copilot-7b-v1-q4).')
    parser.add_argument('--copilot-port', type=int, default=8080,
                        help='Port for the managed mlx_lm.server child process when --copilot=mlx '
                             '(if another program holds it, the next free port is used).')
    parser.add_argument('--copilot-doctor', action='store_true',
                        help='Check the install and the local Copilot setup (Python, packages, Apple Silicon/Rosetta, '
                             'mlx-lm, disk, network, model server, Ollama), print how to fix any problem, and exit.')
    parser.add_argument('--standalone', '-s', action='store_true', help='Run in standalone mode with file picker')
    parser.add_argument('--fasta', '-f', help='Reference FASTA file (requires .fai index) for sequence track')
    parser.add_argument('--prefetch', type=int, default=10,
                        help='Prefetch multiplier for read caching (default: 10, meaning 10x viewport is cached)')
    parser.add_argument('--max-working-reads', type=int, default=0,
                        help='Optional backend-wide working-set cap for low-memory machines. 0 disables the cap (default; '
                             '--public uses 20,000 unless set, see FIBERBROWSER_PUBLIC_MAX_WORKING_READS). '
                             'Prefer the UI Analysis sample menu for request-scoped speedups.')
    parser.add_argument('--plugin', action='append', metavar='DIR',
                        help='Load a plugin from DIR (must contain fiberbrowser-plugin.json + plugin.py). Can be repeated.')
    parser.add_argument('--plugin-dir', metavar='DIR',
                        help='Scan DIR for plugin subdirectories')
    parser.add_argument('--public', action='store_true',
                        help='Public/web-deployment mode: disables shutdown beacon, file '
                             'uploads, primer design, session save, and other mutation '
                             'endpoints. Datasets are served read-only from the CLI-loaded '
                             'files. Multiple visitors get independent browser state. '
                             'Opt-in only - pass this when exposing the server over a URL.')
    public_limits = parser.add_argument_group(
        'public-server limits',
        'Resource caps for anonymous visitors in --public mode (also settable as '
        'FIBERBROWSER_PUBLIC_<NAME> environment variables, e.g. FIBERBROWSER_PUBLIC_MAX_SPAN_BP).')
    public_limits.add_argument('--public-max-span-bp', type=int, default=None, metavar='BP',
                               help='Largest window reads and read analyses load (default 1,000,000).')
    public_limits.add_argument('--public-max-reads', type=int, default=None, metavar='N',
                               help='Cap on max_reads-style request parameters (default 2,000).')
    public_limits.add_argument('--public-consensus-region-bp', type=int, default=None, metavar='BP',
                               help='Largest footprint-class (consensus) region (default 50,000).')
    public_limits.add_argument('--public-consensus-cores', type=int, default=None, metavar='N',
                               help='CPU cores one footprint-class run may use (default min(2, cores)).')
    public_limits.add_argument('--public-consensus-queue', type=int, default=None, metavar='N',
                               help='Footprint-class runs queued or running at once, server-wide (default 3).')
    # Open-internet protection (services/public_protection.py). Defaults and
    # meanings: PublicLimits in services/public_limits.py.
    for flag, metavar, text in (
        ('rate-per-minute', 'N', 'Requests per client IP per minute (default 1200; burst --public-rate-burst, default 300).'),
        ('rate-burst', 'N', argparse.SUPPRESS),
        ('heavy-per-minute', 'N', 'Analysis requests (clustering, figures, ...) per client IP per minute (default 120).'),
        ('heavy-burst', 'N', argparse.SUPPRESS),
        ('heavy-concurrent-per-ip', 'N', 'Analysis requests one client IP may run at once (default 3).'),
        ('heavy-concurrent', 'N', 'Analysis requests running at once server-wide (default: half the cores, at least 2).'),
        ('heavy-wait-seconds', 'S', argparse.SUPPRESS),
        ('heavy-timeout-seconds', 'S', 'An analysis request still running after this gets 503 (default 180).'),
        ('global-rate-per-second', 'N', 'Requests per second from all clients together (default 400).'),
        ('max-body-kb', 'KB', 'Largest request body (default 1024); uploads are always refused.'),
        ('sessions-per-ip', 'N', 'Visitor sessions one client IP may hold (default 24).'),
        ('session-cache-entries', 'N', argparse.SUPPRESS),
        ('idle-cache-seconds', 'S', 'A visitor idle this long has its read caches emptied (default 120).'),
        ('memory-mb', 'MB', 'Resident memory past which idle sessions drop their caches and new '
                            'sessions wait (default 0: no check).'),
        ('cache-mb', 'MB', 'Shared cache of identical anonymous read responses (default 256; 0 turns it off).'),
        ('cache-ttl-seconds', 'S', argparse.SUPPRESS),
    ):
        public_limits.add_argument(f'--public-{flag}', type=int, default=None, metavar=metavar, help=text)
    # Every other limit has its flag too (--public-<name>); what each one does:
    # docs/deployment/public-server.md, "Limits and settings".
    from services.public_limits import PublicLimits, limit_names
    registered = {action.dest for action in parser._actions}
    for name in limit_names():
        if f'public_{name}' not in registered:
            default = getattr(PublicLimits(), name)
            public_limits.add_argument(f'--public-{name.replace("_", "-")}', type=int, default=None, metavar='N',
                                       help=f'Public-server limit {name} (default {default:,}; see '
                                            'docs/deployment/public-server.md).')
    public_limits.add_argument('--trusted-proxy', action='append', metavar='IP_OR_CIDR',
                               help='A reverse proxy (e.g. Caddy) whose X-Forwarded-For / X-Forwarded-Proto '
                                    'headers are believed; repeat for several. Without it the connecting '
                                    'address is the client (FIBERBROWSER_TRUSTED_PROXIES, comma-separated; '
                                    'a config file\'s auth.trusted_proxies adds to the same list).')
    parser.add_argument('--catalog', metavar='JSON',
                        help='Dataset catalog JSON - a curated list of groups of BAM/BigBed '
                             'files (local paths or s3:// / https:// URLs) that visitors can '
                             'load on demand via the sidebar. Does NOT imply --public; pair '
                             'it with --public for locked-down web deployments.')
    launcher = parser.add_argument_group(
        'app window and shortcuts',
        'Handled by the launcher (fiberbrowser or browser.py) before the server starts.')
    launcher.add_argument('--app', action='store_true',
                          help='Open FiberBrowser in its own app window instead of a browser tab '
                               '(needs pywebview: pip install "fiberbrowser[app]"). Other options are '
                               'passed to the server; without --port it uses 8756 or the next free port.')
    launcher.add_argument('--install-shortcut', action='store_true',
                          help='Add FiberBrowser to the application menu (Linux) or Start menu (Windows); '
                               'the entry opens the app window. Then exit.')
    launcher.add_argument('--uninstall-shortcut', action='store_true',
                          help='Remove the entry --install-shortcut added, and exit.')
    return parser


def parse_browser_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_arg_parser().parse_args(argv)
