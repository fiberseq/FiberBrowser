FiberBrowser @VERSION@ for Windows (portable package)
=====================================================

FiberBrowser runs on Windows 10 (version 2004 or newer) and Windows 11 in WSL 2
(Windows Subsystem for Linux), in a Linux system of its own named "FiberBrowser".
It does not change your other WSL distributions or settings.

Install
  1. Unzip this whole folder (right-click > Extract All...).
  2. Double-click Install.cmd. If WSL is not installed, it offers to install it
     (administrator approval; Windows may need a restart, then run Install.cmd again).
  3. Start FiberBrowser from the Start menu or the desktop shortcut.

The usual installer, FiberBrowser-@VERSION@-Setup.exe, does the same; use this
package where that one is blocked.

Uninstall
  Settings > Apps > Installed apps > FiberBrowser > Uninstall
  (or %LOCALAPPDATA%\FiberBrowser\app\Uninstall.cmd). Your FiberBrowser data is kept
  unless you ask to delete it; installing again brings it back.

Help: https://github.com/fiberseq/FiberBrowser/blob/main/docs/install.md#windows
Logs: %LOCALAPPDATA%\FiberBrowser\logs
