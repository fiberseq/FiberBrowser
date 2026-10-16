"""Native file/folder picker helpers."""
from __future__ import annotations

import os
import subprocess
import threading

from services.local_paths import clean_local_path, convert_windows_path_to_wsl, is_windows_drive_path, is_wsl
from services.wsl_interop import windows_cwd, windows_program


WINDOWS_FILTERS = {
    "gtf": "GTF files (*.gtf;*.gff;*.gff3)|*.gtf;*.gtf.gz;*.gff;*.gff3;*.bed;*.bed.gz;*.bed12|All files (*.*)|*.*",
    "bigwig": "BigWig files (*.bw;*.bigwig)|*.bw;*.bigwig|All files (*.*)|*.*",
    "bam": "BAM/BigBed files|*.bam;*.bb;*.bigbed|BAM files (*.bam)|*.bam|BigBed files (*.bb)|*.bb;*.bigbed|All files (*.*)|*.*",
    "dataset": "BAM/BigBed files|*.bam;*.bb;*.bigbed|All files (*.*)|*.*",
    "overlay": "BigBed files (*.bb)|*.bb;*.bigbed|All files (*.*)|*.*",
    "any": "All supported|*.bam;*.bb;*.bigbed;*.bw;*.bigwig;*.gtf;*.gff;*.gff3;*.fa;*.fasta;*.fna;*.cool;*.mcool;*.dna;*.gb;*.gbk;*.genbank;*.embl;*.sbol;*.fiberlayers.json;*.fiberlayer-rules.json;*.fiberlayers.bed;*.json|All files (*.*)|*.*",
    "fasta": "FASTA files (*.fa;*.fasta;*.fna)|*.fa;*.fasta;*.fna|All files (*.*)|*.*",
    "annotation": "BigBed files (*.bb)|*.bb;*.bigbed|All files (*.*)|*.*",
    "fiberlayers": "FiberBrowser layer bundles|*.fiberlayers.json;*.fiberlayers.bb;*.fiberlayers.bigbed;*.fiberlayers.bed|All files (*.*)|*.*",
    "footprint_rules": "Footprint rule files|*.fiberlayer-rules.json;*.fiberlayers.json|All files (*.*)|*.*",
}

def _shared_filters() -> None:
    """The open dialogs' filters (Load File: "open"; Add dataset: "dataset") come
    from the shared list of what FiberBrowser opens (services/supported_files.py),
    with All files last. Without the list the dialogs keep the fixed filters."""
    try:
        from services import supported_files
        for picker in ("open", "dataset"):
            if supported_files.has_picker(picker):
                WINDOWS_FILTERS[picker] = supported_files.windows_filter(picker)
                ZENITY_FILTERS[picker] = supported_files.zenity_filters(picker)
    except Exception as exc:  # a dialog filter must never stop the server
        print(f"FiberBrowser: open-dialog filters unavailable: {exc}")
    WINDOWS_FILTERS.setdefault("open", WINDOWS_FILTERS["any"])
    ZENITY_FILTERS.setdefault("open", ZENITY_FILTERS["any"])


PICK_FILE_PROMPTS = {
    "gtf": "Select GTF, GFF, or BED Gene Annotation",
    "bigwig": "Select BigWig Track File",
    "bam": "Select Fiber-seq BAM File",
    "dataset": "Select Dataset (BAM or BigBed)",
    "overlay": "Select {overlay_label} Overlay (bigBed)",
    "any": "Select File (BAM, BigBed, BigWig, GTF, FASTA, session .json)",
    "open": "Select Files to Open (BAM, BigBed, BigWig, GTF, FASTA, session .json)",
    "fasta": "Select Reference Genome FASTA",
    "annotation": "Select Annotation BigBed File",
    "fiberlayers": "Select Materialized Layer Bundle (.fiberlayers.json, .fiberlayers.bb, or .fiberlayers.bed)",
    "footprint_rules": "Select Footprint Rule JSON",
}

ZENITY_FILTERS = {
    "gtf": ["--file-filter=GTF files | *.gtf *.gtf.gz *.gff *.gff3 *.bed *.bed.gz *.bed12", "--file-filter=All files | *"],
    "bigwig": ["--file-filter=BigWig files | *.bw *.bigwig *.bigWig", "--file-filter=All files | *"],
    "bam": ["--file-filter=BAM files | *.bam", "--file-filter=BigBed files | *.bb *.bigbed *.bigBed", "--file-filter=All files | *"],
    "dataset": ["--file-filter=BAM/BigBed files | *.bam *.bb *.bigbed *.bigBed", "--file-filter=All files | *"],
    "overlay": ["--file-filter=BigBed files | *.bb *.bigbed *.bigBed", "--file-filter=All files | *"],
    "any": ["--file-filter=All supported | *.bam *.bb *.bigbed *.bigBed *.bw *.bigwig *.bigWig *.gtf *.gff *.gff3 *.fa *.fasta *.fna *.cool *.mcool *.dna *.gb *.gbk *.genbank *.embl *.sbol *.fiberlayers.json *.fiberlayer-rules.json *.fiberlayers.bed *.json", "--file-filter=All files | *"],
    "fasta": ["--file-filter=FASTA files | *.fa *.fasta *.fna", "--file-filter=All files | *"],
    "annotation": ["--file-filter=BigBed files | *.bb *.bigbed *.bigBed", "--file-filter=All files | *"],
    "fiberlayers": ["--file-filter=FiberBrowser layer bundles | *.fiberlayers.json *.fiberlayers.bb *.fiberlayers.bigbed *.fiberlayers.bed", "--file-filter=All files | *"],
    "footprint_rules": ["--file-filter=Footprint rule files | *.fiberlayer-rules.json *.fiberlayers.json", "--file-filter=All files | *"],
}


_shared_filters()


def ps_quote(value: str) -> str:
    """Single-quote a string for safe PowerShell embedding."""
    return "'" + (value or "").replace("'", "''") + "'"


def wslpath_to_unix(win_path: str) -> str:
    """Backward-compatible wrapper for tests/callers using the old helper name."""
    value = clean_local_path(win_path)
    if is_windows_drive_path(value):
        drive = value[0].lower()
        rest = value[2:].lstrip("\\/").replace("\\", "/")
        return f"/mnt/{drive}/{rest}"
    return convert_windows_path_to_wsl(value)


def run_powershell(script: str, timeout: int = 300):
    """Run a PowerShell script via -EncodedCommand from WSL (its output read as UTF-8)."""
    import base64

    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    powershell = windows_program("powershell.exe") or "powershell.exe"
    return subprocess.run(
        [powershell, "-NoProfile", "-NonInteractive", "-Sta", "-EncodedCommand", encoded],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        cwd=windows_cwd(),
    )


# Every WinForms dialog script starts like this: UTF-8 output (paths with
# accents or CJK characters survive the pipe), and a hidden top-most owner
# window, so the dialog opens in front of FiberBrowser's window instead of
# behind it (a process without windows of its own can't take the foreground).
_PS_DIALOG_PRELUDE = (
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null\n"
    "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true; ShowInTaskbar = $false}\n"
)

WSL_DIALOG_TIMEOUT_S = 600
_wsl_dialog_lock = threading.Lock()


def _run_wsl_dialog(script: str):
    """One Windows dialog at a time (a second would open behind the first)."""
    if not _wsl_dialog_lock.acquire(blocking=False):
        raise DialogBusy()
    try:
        return run_powershell(script, timeout=WSL_DIALOG_TIMEOUT_S)
    finally:
        _wsl_dialog_lock.release()


def wsl_pick_file(prompt: str, file_type: str, multiple: bool):
    """Open Windows-native OpenFileDialog from WSL. Returns result dict or None to fall through."""
    if not is_wsl():
        return None
    if not windows_program("powershell.exe"):
        return None

    filt = WINDOWS_FILTERS.get(file_type, "All files (*.*)|*.*")
    multi_str = "$true" if multiple else "$false"

    script = (
        _PS_DIALOG_PRELUDE
        + "$dlg = New-Object System.Windows.Forms.OpenFileDialog\n"
        f"$dlg.Title = {ps_quote(prompt)}\n"
        f"$dlg.Filter = {ps_quote(filt)}\n"
        f"$dlg.Multiselect = {multi_str}\n"
        "$dlg.RestoreDirectory = $true\n"
        "$dlg.CheckFileExists = $true\n"
        "if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {\n"
        "    $dlg.FileNames | ForEach-Object { [Console]::Out.WriteLine($_) }\n"
        "}\n"
        "$owner.Dispose()\n"
    )
    result = _run_wsl_dialog(script)
    if result.returncode != 0:
        raise RuntimeError(f"PowerShell pick_file failed: {result.stderr.strip()}")

    win_paths = [path.strip() for path in result.stdout.splitlines() if path.strip()]
    if not win_paths:
        return {"success": False, "cancelled": True, "path": None, "paths": [], "message": "No file selected"}

    unix_paths = [convert_windows_path_to_wsl(path) for path in win_paths]
    if multiple:
        return {"success": True, "paths": unix_paths, "path": unix_paths[0]}
    return {"success": True, "path": unix_paths[0]}


def wsl_pick_folder(prompt: str):
    """Open Windows-native FolderBrowserDialog from WSL. Returns result dict or None."""
    if not is_wsl():
        return None
    if not windows_program("powershell.exe"):
        return None

    script = (
        _PS_DIALOG_PRELUDE
        + "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog\n"
        f"$dlg.Description = {ps_quote(prompt)}\n"
        "try { $dlg.UseDescriptionForTitle = $true } catch {}\n"
        "if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {\n"
        "    [Console]::Out.WriteLine($dlg.SelectedPath)\n"
        "}\n"
        "$owner.Dispose()\n"
    )
    result = _run_wsl_dialog(script)
    if result.returncode != 0:
        raise RuntimeError(f"PowerShell pick_folder failed: {result.stderr.strip()}")

    win_path = result.stdout.strip()
    if not win_path:
        return {"success": False, "cancelled": True, "path": None, "message": "No folder selected"}
    return {"success": True, "path": convert_windows_path_to_wsl(win_path)}


_DIALOG_FAILURE_HINTS = (
    "display", "x server", "xdg_runtime", "wayland", "cannot open", "unable to init", "could not connect",
    "not authorized", "not allowed", "execution error",
)


MAC_DIALOG_TIMEOUT_S = 120
_mac_dialog_lock = threading.Lock()


class DialogBusy(Exception):
    """A native dialog is already open; opening another would stack them."""


def _run_mac_dialog(script: str, args: tuple[str, ...] = ()):
    """Run a System Events chooser, one at a time, closing it if it times out.

    The dialog belongs to System Events, not osascript, so killing osascript
    on timeout would leave it on screen (often behind the browser) while the
    page moves on to the in-page file browser.

    Caller-supplied text goes in ``args`` (read with ``on run argv``), never
    into the script source, so it can't be run as AppleScript.
    """
    if not _mac_dialog_lock.acquire(blocking=False):
        raise DialogBusy()
    try:
        try:
            return subprocess.run(["osascript", "-e", script, *args], capture_output=True, text=True, timeout=MAC_DIALOG_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            try:
                # Relaunches on demand; quitting it closes the orphaned dialog.
                subprocess.run(["osascript", "-e", 'tell application "System Events" to quit'], capture_output=True, timeout=10)
            except Exception:
                pass
            raise
    finally:
        _mac_dialog_lock.release()


_BUSY_RESULT = {"success": False, "cancelled": True, "busy": True, "path": None, "paths": [],
                "message": "A file dialog is already open (it may be behind this window)."}


def _cancelled_or_failed(result, what: str) -> dict:
    """A dialog that exited without a path: the user cancelled, or it could not open.

    Callers use ``cancelled`` to decide whether to offer the in-page browser
    instead, so a dialog that failed to show must not look like a cancel.
    """
    stderr = (getattr(result, "stderr", "") or "").strip()
    code = getattr(result, "returncode", 1)
    low = stderr.lower()
    user_cancel = "-128" in stderr or "user canceled" in low or "user cancelled" in low
    failed = not user_cancel and (code not in (0, 1) or any(hint in low for hint in _DIALOG_FAILURE_HINTS))
    if failed:
        return {"success": False, "cancelled": False, "path": None, "paths": [],
                "message": f"{what} dialog could not open: {stderr.splitlines()[-1] if stderr else f'exit {code}'}"}
    return {"success": False, "cancelled": True, "path": None, "paths": [], "message": f"No {what.lower()} selected"}


def pick_folder_payload(prompt: str = "Select Fiber-seq BigBed Folder") -> dict:
    """Open native file picker dialog to select a folder."""
    import shutil
    import subprocess
    import sys

    dialog_title = prompt or "Select Fiber-seq BigBed Folder"

    try:
        if sys.platform == "darwin":
            script = """
            on run argv
                tell application "System Events"
                    activate
                    set theFolder to choose folder with prompt (item 1 of argv)
                    return POSIX path of theFolder
                end tell
            end run
            """
            result = _run_mac_dialog(script, (dialog_title,))

            if result.returncode == 0 and result.stdout.strip():
                return {"success": True, "path": result.stdout.strip()}
            return _cancelled_or_failed(result, "Folder")

        try:
            wsl_result = wsl_pick_folder(prompt)
            if wsl_result is not None:
                return wsl_result
        except (DialogBusy, subprocess.TimeoutExpired):
            raise
        except Exception as wsl_err:
            print(f"WSL folder picker failed, falling back: {wsl_err}")

        if shutil.which("zenity"):
            result = subprocess.run(
                ["zenity", "--file-selection", "--directory", f"--title={prompt}"],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode == 0 and result.stdout.strip():
                return {"success": True, "path": result.stdout.strip()}
            return _cancelled_or_failed(result, "Folder")

        if shutil.which("kdialog"):
            result = subprocess.run(
                ["kdialog", "--getexistingdirectory", ".", "--title", prompt],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode == 0 and result.stdout.strip():
                return {"success": True, "path": result.stdout.strip()}
            return _cancelled_or_failed(result, "Folder")

        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.lift()
        root.attributes("-topmost", True)
        root.focus_force()
        root.after(100, lambda: root.focus_force())
        folder_path = filedialog.askdirectory(title=prompt, parent=root)
        root.destroy()
        if folder_path:
            return {"success": True, "path": folder_path}
        return {"success": False, "cancelled": True, "path": None, "message": "No folder selected"}

    except DialogBusy:
        return dict(_BUSY_RESULT)
    except subprocess.TimeoutExpired:
        return {"success": False, "path": None, "message": "Dialog timed out"}
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return {"success": False, "path": None, "message": str(exc)}


def pick_file_prompt(file_type: str, overlay_type: str | None = None, multiple: bool = False) -> str:
    overlay_label = "m6A" if overlay_type == "m6a" else "m5C"
    template = PICK_FILE_PROMPTS.get(file_type, "Select File")
    prompt = template.format(overlay_label=overlay_label)
    if multiple:
        prompt += " (Shift+Click for multiple)"
    return prompt


def pick_file_payload(file_type: str = "gtf", overlay_type: str | None = None, multiple: bool = False) -> dict:
    """Open native file picker dialog to select a file, or multiple files if requested."""
    import shutil
    import subprocess
    import sys

    prompt = pick_file_prompt(file_type, overlay_type, multiple)

    try:
        if sys.platform == "darwin":
            multi_clause = "with multiple selections allowed" if multiple else ""
            # Load File / Add dataset: only the files FiberBrowser opens (the shared
            # list); other dialogs, and "any", stay unfiltered. The prompt and the
            # types are arguments (``on run argv``), never script source.
            from services import supported_files
            types = supported_files.mac_file_types(file_type) if supported_files.has_picker(file_type) else []
            script = f'''
            on run argv
                set thePrompt to item 1 of argv
                set theTypes to {{}}
                if (count of argv) > 1 then set theTypes to items 2 thru -1 of argv
                tell application "System Events"
                    activate
                    if theTypes is {{}} then
                        set theFiles to choose file with prompt thePrompt {multi_clause}
                    else
                        set theFiles to choose file with prompt thePrompt of type theTypes {multi_clause}
                    end if
                    if class of theFiles is list then
                        set output to ""
                        repeat with f in theFiles
                            set output to output & POSIX path of f & linefeed
                        end repeat
                        return output
                    else
                        return POSIX path of theFiles
                    end if
                end tell
            end run
            '''
            result = _run_mac_dialog(script, (prompt, *types))

            if result.returncode == 0 and result.stdout.strip():
                paths = [path for path in result.stdout.strip().split("\n") if path]
                if multiple:
                    return {"success": True, "paths": paths, "path": paths[0] if paths else None}
                return {"success": True, "path": paths[0] if paths else None}
            return _cancelled_or_failed(result, "File")

        try:
            wsl_result = wsl_pick_file(prompt, file_type, multiple)
            if wsl_result is not None:
                return wsl_result
        except (DialogBusy, subprocess.TimeoutExpired):
            raise
        except Exception as wsl_err:
            print(f"WSL file picker failed, falling back: {wsl_err}")

        if shutil.which("zenity"):
            cmd = ["zenity", "--file-selection", f"--title={prompt}"]
            if multiple:
                cmd.append("--multiple")
                cmd.append("--separator=|")
            cmd.extend(ZENITY_FILTERS.get(file_type, []))
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if result.returncode == 0 and result.stdout.strip():
                if multiple:
                    paths = result.stdout.strip().split("|")
                    return {"success": True, "paths": paths, "path": paths[0] if paths else None}
                return {"success": True, "path": result.stdout.strip()}
            return _cancelled_or_failed(result, "File")

        if shutil.which("kdialog"):
            result = subprocess.run(
                ["kdialog", "--getopenfilename", ".", "*", "--title", prompt],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode == 0 and result.stdout.strip():
                return {"success": True, "path": result.stdout.strip()}
            return _cancelled_or_failed(result, "File")

        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.lift()
        root.attributes("-topmost", True)
        root.focus_force()
        root.after(100, lambda: root.focus_force())

        from services import supported_files
        filetypes = supported_files.tk_filetypes(file_type) if supported_files.has_picker(file_type) else None
        extra = {"filetypes": filetypes} if filetypes else {}
        if multiple:
            file_paths = filedialog.askopenfilenames(title=prompt, parent=root, **extra)
            root.destroy()
            if file_paths:
                return {"success": True, "paths": list(file_paths), "path": file_paths[0]}
            return {"success": False, "cancelled": True, "path": None, "paths": [], "message": "No file selected"}

        file_path = filedialog.askopenfilename(title=prompt, parent=root, **extra)
        root.destroy()
        if file_path:
            return {"success": True, "path": file_path}
        return {"success": False, "cancelled": True, "path": None, "message": "No file selected"}

    except DialogBusy:
        return dict(_BUSY_RESULT)
    except subprocess.TimeoutExpired:
        return {"success": False, "path": None, "paths": [], "message": "Dialog timed out"}
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return {"success": False, "path": None, "paths": [], "message": str(exc)}


MAX_LISTED_ENTRIES = 2000


def list_directory_payload(path: str | None) -> dict:
    """Directory listing for the in-page file browser (folders first, no hidden files).

    A file path lists its folder with that file preselected, so a file past
    the listing cap can still be chosen by typing its path.
    """
    from services.runtime import get_lab_mode
    if get_lab_mode():
        return _lab_list_directory_payload(path)
    return _plain_list_directory(path)


def _plain_list_directory(path: str | None) -> dict:
    target = os.path.abspath(os.path.expanduser(path or "~"))
    selected = None
    if os.path.isfile(target):
        selected = target
        target = os.path.dirname(target)
    if not os.path.isdir(target):
        return {"success": False, "path": target, "message": f"Not a folder: {target}"}
    entries = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                if entry.name.startswith("."):
                    continue
                try:
                    is_dir = entry.is_dir()
                    size = None if is_dir else entry.stat().st_size
                except OSError:
                    continue
                entries.append({"name": entry.name, "path": entry.path, "is_dir": is_dir, "size": size})
    except OSError as exc:
        return {"success": False, "path": target, "message": str(exc)}
    entries.sort(key=lambda entry: (not entry["is_dir"], entry["name"].lower()))
    shown = entries[:MAX_LISTED_ENTRIES]
    if selected and all(entry["path"] != selected for entry in shown):
        # Past the cap, hidden, or created after the scan: list it explicitly.
        try:
            shown.append({"name": os.path.basename(selected), "path": selected, "is_dir": False,
                          "size": os.path.getsize(selected)})
        except OSError:
            selected = None
    parent = os.path.dirname(target)
    return {
        "success": True,
        "path": target,
        "parent": parent if parent != target else None,
        "home": os.path.expanduser("~"),
        "entries": shown,
        "truncated": len(entries) > MAX_LISTED_ENTRIES,
        "selected": selected,
    }


def _lab_list_directory_payload(path: str | None) -> dict:
    """A lab server's listing: only inside the data roots, never above one.

    Starts at the first data root; entries whose real location is outside
    every root (symlinks that leave it) are not listed.
    """
    from services.lab import paths as lab_paths

    roots = lab_paths.roots_listing()
    first = roots[0]["path"] if roots else "/"
    requested = (path or "").strip() or first
    try:
        lab_paths.check(requested)
    except lab_paths.PathDenied as exc:
        return {"success": False, "path": requested, "message": str(exc), "roots": roots, "home": first}
    payload = _plain_list_directory(requested)
    payload["home"] = first
    payload["roots"] = roots
    if not payload.get("success"):
        return payload
    payload["entries"] = [entry for entry in payload.get("entries", []) if lab_paths.allowed(entry["path"])]
    parent = payload.get("parent")
    current_root = lab_paths.root_for(payload["path"])
    if parent is None or current_root is None or os.path.realpath(payload["path"]) == current_root \
            or not lab_paths.allowed(parent):
        payload["parent"] = None
    return payload
