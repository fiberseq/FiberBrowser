# Architecture: plugin packs

FiberBrowser's core can be extended by **internal plugin packs**: feature folders that ship with some builds and
not others. Core never imports a pack; it finds the packs a build has and lets them register with the extension
points below. A build without a pack simply doesn't have its features, and a session written by a build with a pack
opens in one without it (the pack's parts are left out, and a one-line note says so).

(External Python plugins, `--plugin`, are a different mechanism: [docs/plugins.md](docs/plugins.md).)

## One release build

Every release includes NFR analysis and Synchronise regions. Their modules remain
in `browser/lab/` and `browser/frontend/src/lab/`; their tests remain in
`tests/lab_tests/` and `browser/frontend/tests/e2e/lab/`. The legacy pack name `lab`
is a saved-session identifier, so existing analyses and sessions still restore.
The pack reports the public build flavour and uses the public update channel.

Build directly from this repository. The public-tree exporter, section stripping
and held-back-word check are retired. See [CONTRIBUTING.md](CONTRIBUTING.md).

The **lab server profile** (`browser/services/lab/`, `browser/routers/lab.py`,
`deploy/lab/`) is a shared server with sign-in and a session shelf. It and the
read-only public-server profile retain their authorization boundaries; neither
selects a different set of shipped features.

## Core features registered like a pack

`browser/frontend/src/features/` (the insertion lens and Identify, alt-allele panels, the Variants panel) is core, but
registers through the same extension points a pack uses (`features/register.ts`, called from `main.tsx` before the
packs), so it reaches the rest of core only through them. On the server, its routers are core's
(`routers/registry.py`) and its session hooks go through the pack API as a built-in (`plugins/builtin_features.py`,
registered first by `load_packs`; never listed as a pack, so it sets no flavour and marks nothing in sessions).

## Preview features

A feature can be released as a **Preview**: present in every build, controlled by *Settings → Show
preview features* (`utils/previewFeatures.ts`; kept on this computer in `~/.fiberhmm/analysis_preferences.json` as
`show_preview_features`, with the browser's storage as the fallback). Previews start on unless the user has chosen otherwise. Each one is described once
(`registerPreviewFeature`: its label, its known limitations, what graduates it), and the registrations that are its
entry points name it (`preview: '<id>'` on an analysis panel, a read-menu contribution or menu item, a track kind or a
track-menu item, a split hook's `opened`, the SV row's selection); a component that is itself an entry point (a
panel-header item, a button) checks `usePreviewsEnabled()`. `inUse(state)` says whether a state uses the feature. With the switch off those entry points are
hidden; everything still registers, so sessions, undo steps and crash-recovery copies keep the feature's state, and a
session that uses one opens with a one-line offer to turn previews on. With the switch on, each entry point carries a
small Preview badge and the panel a "Known limitations" note.

## How packs are found

- **Server**: `browser/plugins/packs.py` scans `browser/*/fiberbrowser-pack.json` (name, label, flavour, module),
  imports the module and calls `register(api)` once (from the router registry, or lazily from any hook). The build's
  flavour is the first pack's (else `public`).
- **Browser**: `src/plugins/packs.ts` globs `src/*/fiberbrowser-pack.ts` at build time (none: an empty list) and
  registers each pack before the app renders (`main.tsx`). While a pack registers, the registries record what it
  contributed (`plugins/packRegistry.ts`), so sessions can say which parts a pack wrote.

## What a pack can contribute

Server (`PackAPI`, `browser/plugins/packs.py`):

- API routers, and their places on the public-server, remote-viewer and heavy-work allowlists;
- session hooks: export, import start and end, dispose; datasets it builds (a session entry marked with the pack,
  and a restorer); references it builds (marked, never offered for relinking); a FASTA context describer;
- feature-state providers for its feature kinds (`/api/features/states`);
- analysis preference maps kept on this computer (`preference_map`: merged per key like the pinned motifs; a build
  without the pack keeps them in the file untouched).

Browser (each registry lives next to what it extends):

| Extension point | Module |
|---|---|
| analysis panels (rail tile, icon, colour) and old panel names | `plugins/registry.ts` (`registerAnalysisPanel`, `registerPanelAlias`) |
| per-panel rows: kind, default placement, menu items, renderer | `components/tracks/trackRegistry.ts`, `trackRenderers.ts` |
| read-menu and SV-row menu items, menu icons | `read-track/readMenuModel.ts` (`registerReadMenuContribution`), `ReadContextMenu.tsx` |
| SV-row shift-click selection | `components/tracks/svRowSelection.ts` |
| feature kinds (selection, chip, Cluster / Sort / Filter) | `stores/featureStore.ts` (`registerFeatureKind`) |
| combinatorial groupings and split sources | `utils/featureClustering.ts`, `utils/splitPanels.ts` |
| browser-store state with sessions, undo, autosave, persistence | `stores/storeExtensions.ts` |
| settings (palette and settings search) | `utils/settingsRegistry.ts` (`registerSettings`) |
| window-level hosts (background hooks, dialogs) | `plugins/browserHosts.tsx` |
| panel traits, view links, split hooks | `utils/panelExtensions.ts` |
| panel-header chips and menu items; ruler coordinates of a contig | `panelHeaderExtensions.ts`, `axisCoordinates.ts` |
| Footprints class links; analysis preference maps | `footprint-analysis/classLinks.ts`, `utils/analysisPreferences.ts` |

Types a pack adds (row types, feature kinds, split sources, `PanelConfig` fields, browser-store state) are
TypeScript module augmentations in the pack (`declare module`), so core's types never name them.

## Sessions across builds

A session's frontend state lists the packs that wrote parts of it (`packs`: each pack's panel types, row types,
feature kinds, panel fields, owner fields and store keys), and so does every undo step and crash-recovery copy
(`serializeState`); the server's session lists them too (`packs`; a pack's dataset entries carry `"pack"`). A build
without one of those packs leaves the parts out (`api/sessionPacks.ts`: its panels, the panels an owner field marks,
rows, fields, and the panels of datasets skipped and reported as `datasets_skipped` / `missing_packs`; the full view
and the selection keep only the panels left) and, opening a session, shows one note: *This session uses features
this build doesn't include (…); they were left out.* A build with the packs restores everything, and a pack migrates
its own older session formats. Sessions saved before packs existed carry no marker, so a build without the pack
can't tell their parts apart from its own and opens them as they are.
