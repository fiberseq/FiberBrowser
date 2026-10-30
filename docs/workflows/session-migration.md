# Opening sessions from 3.0.x

[← Docs index](../index.md) · [← User guide](../guide.md#sessions-and-workspaces)

Open a saved 3.0.x session with **Open**, or use **Restore Session** in
**Settings › Data & Sessions**. Keep the original file while checking the new
view. If files moved, **Locate session files** lets you locate a file or search
a folder. The browser checks file fingerprints before relinking.

## What comes across

Saved footprint-class and NFR runs keep their results, curation and per-read
states. Opening a session does not rerun discovery. The **Footprints** and
**Accessibility** panels remain available. The **Feature hub** also lists their
hits. Classes and NFRs kept in the old carts appear with a **Pinned** badge;
edit them in their original panel.

Peak selections and their cluster modes follow the saved features. Custom,
matched and graph peaks also appear in the hub. Selections, saved clusterings,
cluster branches and history keep their feature references. SV insertion
boundaries keep the older session representation for compatibility.

A class run over matched windows needs saved genomic positions for each
window. These hits can be listed, but use the original panel for per-read
states. A run without that position information stays in its original panel
and cannot be placed in the hub.

Saved split panels stay split. Registering a matching graph package can offer
**View as graph**; accepting it is optional. A saved graph host opens linear
with an explanation if its helper or package is missing. See
[Graph mode](graph-mode.md#sessions).

## Scans and new session content

New sessions save the hub's scan list, scopes, filters, selection and anchor
sets. They also keep association runs and the overlay settings and last result.
Small browser scans are embedded, up to 25 MiB of uncompressed files in total.
Larger browser scans and opened external scans remain references to directories.
Keep those directories with the session.

An embedded scan restores even after its cache directory was removed. A
missing referenced scan offers **Open scan…** or **Re-scan…**. A scan of other
files is read-only: its hits and values remain useful, but its states cannot
filter the loaded molecules. A stale scan needs a new scan of the changed BAM.

Nucleosome panel settings are saved. Outputs from **Compute in view** are not
embedded as panel results; compute them again or retain their scan.

## Saving and sharing

After checking the panels, save a new session file. New files retain the legacy
class/NFR runs and peak fields as well as the hub state. Older builds can use
those legacy views, but cannot reproduce every new hub, graph-sort or analysis
feature. A hub state-pattern split includes frozen membership for older builds.
Use the current build when sharing analyses that depend on the new features.

See [Feature hub and scans](feature-hub.md) for scan bindings and
[Updates](../updates.md) for saving and restoring during an app update.
