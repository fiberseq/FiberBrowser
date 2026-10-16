"""Hand-crafted (request -> plan) training records for the local Copilot.

Each record is the **raw output** the fine-tuned model should learn to emit
given the system prompt and the user message. The dataset builder runs every
plan through the production validator so any drift between this file and the
runtime is caught.

Conventions:
- thinking is short, mechanism-focused, and teaches the *reason* a particular
  action shape is chosen (e.g. why TSS-relative form over explicit coords).
- plans use the highest-level action that fits ("navigate_gene" before
  "navigate_region", "relative_to_gene" before explicit coords).
- when the user asks for a value that depends on the loaded GTF/data, the plan
  delegates the computation to the browser instead of inventing numbers.

Teach-only (the local Copilot is a tutor, not a browser operator):
- plans hold only tutorial actions: explain / try_it steps pointing at named UI
  anchors (frontend/src/data/tutorialAnchors.json), plus navigation and
  opening panels, tabs and sidebar sections. Copilot never clicks the controls
  that run something (scan, cluster, filter, sort, merge, load, export...).
- a try_it hands that click to the user and waits for a milestone
  (tutorialMilestones.json) before the next step, so the steps after it can
  explain results the user just produced.
- skip_if / requires gate steps on conditions: skip layers the user has already
  done, ask for a prerequisite first. An anchor marked `needs` exists only
  while its condition holds, so reach it through a try_it or `requires`.
- 3-12 steps, 1-2 sentences each, in the order the user would click.
"""
from __future__ import annotations


# ─────────────────────────────────────────────────────────────────────
# Shared context fixtures (so each record stays terse)
# ─────────────────────────────────────────────────────────────────────

V_DM6_2R = {"chrom": "2R", "start": 9_970_000, "end": 9_980_000, "currentGenome": "dm6"}
V_DM6_3R = {"chrom": "3R", "start": 1_000_000, "end": 1_010_000, "currentGenome": "dm6"}
V_DM6_2L = {"chrom": "2L", "start":     14_000, "end":     20_000, "currentGenome": "dm6"}
V_DM6_X  = {"chrom": "X",  "start":   195_000, "end":    210_000, "currentGenome": "dm6"}
V_HG38_MYC  = {"chrom": "chr8",  "start": 127_700_000, "end": 127_720_000, "currentGenome": "hg38"}
V_HG38_SOX2 = {"chrom": "chr3",  "start": 181_700_000, "end": 181_720_000, "currentGenome": "hg38"}
V_HG38_TP53 = {"chrom": "chr17", "start":   7_660_000, "end":   7_695_000, "currentGenome": "hg38"}
V_MM10_PAX6 = {"chrom": "chr2",  "start": 105_500_000, "end": 105_540_000, "currentGenome": "mm10"}
V_EMPTY     = {"chrom": "",      "start": 0,           "end": 0,           "currentGenome": ""}

# Dataset profiles (number passed to make_mock_state)
DS_FIBER_ONLY = 1   # one bigbed
DS_FIBER_DAF = 2    # bigbed + DAF bam
DS_THREE = 3        # adds a second fiber-seq dataset


def _r(**kw):
    """Compact record constructor; defaults the boring fields.

    Optional `phrasings` list captures paraphrases of `command` (same intent,
    same plan). The dataset builder emits one training example per phrasing
    so a single concept teaches the model robustness across writing styles
    without bloating this file. Keep canonical `command` as the most natural
    way a real user would phrase it; put creative variants in `phrasings`.
    """
    kw.setdefault("category", "general")
    kw.setdefault("dataset_count", DS_FIBER_DAF)
    kw.setdefault("warnings", [])
    kw.setdefault("phrasings", [])
    record = {
        "id": kw["id"],
        "category": kw["category"],
        "command": kw["command"],
        "phrasings": list(kw["phrasings"]),
        "context": kw["context"],
        "dataset_count": kw["dataset_count"],
        "thinking": kw["thinking"].strip(),
        "plan": {
            "summary": kw["summary"],
            "actions": kw["actions"],
            "warnings": kw["warnings"],
        },
    }
    if "state_overrides" in kw:
        record["state_overrides"] = kw["state_overrides"]
    # Troubleshooting context, as the browser sends it (utils/copilotDiagnostics.ts):
    # a list of {code, severity, message, fix_anchor?, dataset_id?} and/or the
    # compact raw state. Rendered into the user message like a live request.
    if "diagnostics" in kw:
        record["diagnostics"] = kw["diagnostics"]
    if "raw_state" in kw:
        record["raw_state"] = kw["raw_state"]
    if "previous_turns" in kw:
        record["previous_turns"] = kw["previous_turns"]
    return record

RECORDS: list[dict] = [

    # ── navigation ──────────────────────────────────────────────────

    _r(id='nav_gene_eve', category='navigation',
       command='navigate to eve',
       phrasings=[
           'go to eve',
           'jump to eve',
           'show me eve',
           'take me to the eve gene',
           'open eve',
           'center on eve',
           'find eve',
           'load eve in the browser',
           'zoom to eve',
           'go to eve +/- 5kb',
           'show eve with 5 kilobases of context',
           'open eve in a 10kb window',
           'navigate to eve with 5kb padding',
           'center on eve at 5kb',
           'eve plus minus 5kb',
       ],
       context=V_DM6_3R,
       thinking='Use navigate_gene with the default 5 kb padding so the GTF is the source of truth for coordinates.',
       summary='Navigate to gene eve',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
       ]),

    _r(id='nav_gene_padding_10kb', category='navigation',
       command='show ftz +/- 10 kb',
       context=V_DM6_2R,
       thinking="Explicit 10 kb window around ftz; the gene is on the + strand but padding is symmetric so strand doesn't matter here.",
       summary='Navigate to ftz +/- 10 kb',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 10000},
       ]),

    _r(id='nav_gene_padding_500bp', category='navigation',
       command='zoom into sna +/- 500 bp',
       context=V_DM6_2L,
       thinking='Tight zoom around sna. sna is on the - strand; navigate_gene still pads symmetrically.',
       summary='Navigate to sna +/- 500 bp',
       actions=[
           {'type': 'navigate_gene', 'gene': 'sna', 'padding_bp': 500},
       ]),

    _r(id='nav_gene_human_myc', category='navigation',
       command='navigate to MYC',
       context=V_HG38_SOX2,
       thinking='Human gene MYC. Default padding.',
       summary='Navigate to MYC',
       actions=[
           {'type': 'navigate_gene', 'gene': 'MYC', 'padding_bp': 5000},
       ]),

    _r(id='nav_gene_human_brca1', category='navigation',
       command='open BRCA1 with 20 kb flanks',
       context=V_HG38_TP53,
       thinking="20 kb flanks. BRCA1 is on the - strand but symmetric padding doesn't depend on strand.",
       summary='Navigate to BRCA1 +/- 20 kb',
       actions=[
           {'type': 'navigate_gene', 'gene': 'BRCA1', 'padding_bp': 20000},
       ]),

    _r(id='nav_gene_mouse_pax6', category='navigation',
       command='jump to Pax6',
       context=V_MM10_PAX6,
       thinking='Mouse Pax6. Default padding.',
       summary='Navigate to Pax6',
       actions=[
           {'type': 'navigate_gene', 'gene': 'Pax6', 'padding_bp': 5000},
       ]),

    _r(id='nav_region_explicit', category='navigation',
       command='go to 2R:9970000-9980000',
       phrasings=[
           'navigate to 2R:9970000-9980000',
           'take me to 2R 9970000-9980000',
           'show 2R from 9.97Mb to 9.98Mb',
           'open 2R:9,970,000-9,980,000',
           'jump to 2R 9.97-9.98 Mb',
       ],
       context=V_DM6_3R,
       thinking='Explicit genomic interval. Use navigate_region with the literal coordinates.',
       summary='Navigate to 2R:9970000-9980000',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9970000, 'end': 9980000},
       ]),

    _r(id='nav_region_chr_prefix', category='navigation',
       command='navigate to chr3R:6,861,000-6,864,000',
       context=V_DM6_2R,
       thinking='Explicit interval with chr prefix and commas. Strip commas; preserve chrom string verbatim.',
       summary='Navigate to chr3R:6861000-6864000',
       actions=[
           {'type': 'navigate_region', 'chrom': 'chr3R', 'start': 6861000, 'end': 6864000},
       ]),

    _r(id='nav_region_human', category='navigation',
       command='show chr8:127,700,000-127,720,000',
       context=V_HG38_TP53,
       thinking='Human chromosome interval.',
       summary='Navigate to chr8:127700000-127720000',
       actions=[
           {'type': 'navigate_region', 'chrom': 'chr8', 'start': 127700000, 'end': 127720000},
       ]),

    _r(id='nav_region_with_label', category='navigation',
       command='navigate to the eve enhancer at 2R:9,975,000-9,975,800',
       context=V_DM6_2R,
       thinking='Named region. Pass a label so the history reads cleanly.',
       summary='Navigate to eve enhancer',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9975000, 'end': 9975800, 'label': 'eve enhancer'},
       ]),

    _r(id='nav_gene_then_zoom_out', category='navigation',
       command='zoom out to ftz +/- 50 kb',
       context=V_DM6_2R,
       thinking='Wide zoom — single navigate_gene with 50 kb padding.',
       summary='Navigate to ftz +/- 50 kb',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 50000},
       ]),

    _r(id='nav_gene_close_in', category='navigation',
       command='show eve TSS at 100bp resolution',
       context=V_DM6_3R,
       thinking='100 bp window around the gene works as navigate_gene with padding_bp=100. The user wants tight context near the TSS.',
       summary='Navigate to eve +/- 100 bp',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 100},
       ]),

    _r(id='nav_back_to_locus', category='navigation',
       command='back to the eve locus',
       context=V_DM6_2L,
       thinking='Navigate back; default padding is reasonable.',
       summary='Navigate to eve',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
       ]),

    _r(id='nav_gene_minus_strand', category='navigation',
       command='show me Ubx +/- 25 kb',
       context=V_DM6_3R,
       thinking='Ubx is on the - strand; symmetric padding still works through navigate_gene.',
       summary='Navigate to Ubx +/- 25 kb',
       actions=[
           {'type': 'navigate_gene', 'gene': 'Ubx', 'padding_bp': 25000},
       ]),


    # ── peaks ───────────────────────────────────────────────────────

    _r(id='peaks_scan', category='peaks',
       command='scan peaks',
       phrasings=[
           'scan peaks in this view',
           'find peaks here',
           'scan for peaks',
           'call peaks in the current region',
           'run peak detection',
           'detect peaks now',
           'look for peaks in the viewport',
           'do peak scanning',
           'rescan peaks',
           're-scan peaks after I changed the rules',
           'detect peaks from the current accessibility signal at the 30th percentile',
       ],
       context=V_DM6_2R,
       thinking='"scan peaks": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan. Their clicks: Scan; the steps after each wait until it has happened.',
       summary='Scan',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
       ]),

    _r(id='peaks_scan_locked', category='peaks',
       command='scan peaks then lock them for reproducibility',
       context=V_DM6_2R,
       thinking='"scan peaks then lock them for reproducibility": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Lock peaks. Their clicks: Scan; the steps after each wait until it has happened.',
       summary='Scan → Lock peaks',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'explain', 'text': 'Click the lock to freeze these peaks, so navigating or re-scanning keeps the same set.', 'anchor': 'peaks-lock'},
       ]),

    _r(id='peaks_lock', category='peaks',
       command='lock peaks',
       phrasings=[
           'freeze the peaks',
           'pin peaks',
           'stop rescanning peaks',
           'keep peaks frozen',
           'hold peaks in place',
           'freeze the peak set',
       ],
       context=V_DM6_2R,
       thinking='"lock peaks": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Lock peaks.',
       summary='Lock peaks',
       actions=[
           {'type': 'explain', 'text': 'Click the lock to freeze these peaks, so navigating or re-scanning keeps the same set.', 'anchor': 'peaks-lock'},
       ]),

    _r(id='peaks_unlock', category='peaks',
       command='unlock peaks',
       context=V_DM6_2R,
       thinking='"unlock peaks": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Lock peaks.',
       summary='Lock peaks',
       actions=[
           {'type': 'explain', 'text': 'Click the lock again to unlock the peaks, so Scan can replace them.', 'anchor': 'peaks-lock'},
       ]),

    _r(id='peaks_scan_then_export', category='peaks',
       command='scan peaks and export the session',
       context=V_DM6_2R,
       thinking='"scan peaks and export the session": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Save. Their clicks: Scan, Save; the steps after each wait until it has happened.',
       summary='Scan → Save',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'try_it', 'text': 'Click Save in the top bar: it downloads a session file with the view, datasets, clusters, rules and colours; Load File reopens it.', 'wait_for': 'session_saved', 'anchor': 'save-session'},
       ]),

    _r(id='peaks_navigate_then_scan', category='peaks',
       command='go to ftz and scan peaks',
       context=V_DM6_3R,
       thinking='"go to ftz and scan peaks": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Scan. Their clicks: Scan; the steps after each wait until it has happened.',
       summary='ftz → Scan',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
       ]),


    # ── selection ───────────────────────────────────────────────────

    _r(id='select_peak_at_eve_tss', category='selection',
       command='select the peak at the eve TSS',
       context=V_DM6_2R,
       thinking='"select the peak at the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track. Their clicks: Scan, Peaks track; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
       ]),

    _r(id='select_peak_at_ftz_tss_close', category='selection',
       command='select the closest peak within 250 bp of the ftz TSS',
       context=V_DM6_3R,
       thinking='"select the closest peak within 250 bp of the ftz TSS": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Scan, Peaks track. Their clicks: Scan, Peaks track; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='ftz → Scan → Peaks track',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the ftz TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
       ]),

    _r(id='select_peak_upstream_minus_500', category='selection',
       command='select the peak 500 bp upstream of the eve TSS',
       context=V_DM6_2R,
       thinking='"select the peak 500 bp upstream of the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track. Their clicks: Scan, Peaks track; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak 500 bp upstream of the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
       ]),

    _r(id='select_peak_downstream_plus_300', category='selection',
       command='select a peak 300 bp downstream of the sna TSS',
       context=V_DM6_2L,
       thinking='"select a peak 300 bp downstream of the sna TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track. Their clicks: Scan, Peaks track; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak 300 bp downstream of the sna TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
       ]),

    _r(id='select_peak_explicit_coord', category='selection',
       command='select the peak at 2R:9974500',
       context=V_DM6_2R,
       thinking='"select the peak at 2R:9974500": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track. Their clicks: Scan, Peaks track; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak at 2R:9,974,500 in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
       ]),

    _r(id='select_peak_human_myc', category='selection',
       command='select the peak at the MYC TSS',
       context=V_HG38_MYC,
       thinking='"select the peak at the MYC TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track. Their clicks: Scan, Peaks track; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the MYC TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
       ]),


    # ── clustering ──────────────────────────────────────────────────

    _r(id='cluster_selected', category='clustering',
       command='cluster the selected peaks',
       phrasings=[
           'run clustering on selected peaks',
           'cluster these peaks',
           'do clustering on the picks',
           'group reads by these peaks',
           "cluster on what I've selected",
           'run k-means on the selected peaks',
           'cluster the picked peaks',
       ],
       context=V_DM6_2R,
       thinking='"cluster the selected peaks": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_at_gene_tss_eve', category='clustering',
       command='cluster on the peak overlapping the eve TSS',
       phrasings=[
           'cluster the eve TSS peak',
           'run clustering at the eve start site',
           "cluster reads at eve's promoter",
           'do clustering on the eve TSS',
           "cluster the peak at eve's TSS",
       ],
       context=V_DM6_2R,
       thinking='"cluster on the peak overlapping the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_at_gene_tss_ftz', category='clustering',
       command='cluster the reads at the ftz TSS',
       context=V_DM6_3R,
       thinking='"cluster the reads at the ftz TSS": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='ftz → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the ftz TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_at_gene_tss_minus_strand', category='clustering',
       command='cluster on the peak overlapping the sna TSS',
       context=V_DM6_2L,
       thinking='"cluster on the peak overlapping the sna TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the sna TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_human_myc_tss', category='clustering',
       command='cluster reads at MYC TSS with 1 kb tolerance',
       context=V_HG38_MYC,
       thinking='"cluster reads at MYC TSS with 1 kb tolerance": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the MYC TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_navigate_then_select_then_cluster', category='clustering',
       command='go to ftz, select the peak at the TSS, and cluster on it',
       context=V_DM6_2R,
       thinking='"go to ftz, select the peak at the TSS, and cluster on it": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='ftz → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the ftz TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_via_api_call_explicit_region', category='clustering',
       command='run clustering on chr3R 6861000-6864000 with k=3 against the current peaks',
       context=V_DM6_3R,
       thinking='"run clustering on chr3R 6861000-6864000 with k=3 against the current peaks": I guide them through it rather than doing it. First I move the view to chr3R:6,861,000. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Scan, Peaks track, Cluster. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='chr3R:6,861,000 → Cluster controls toggle → Clustering method → K → Scan → Peaks track',
       actions=[
           {'type': 'navigate_region', 'chrom': 'chr3R', 'start': 6861000, 'end': 6864000},
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 3.', 'anchor': 'cluster-k'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── labels ──────────────────────────────────────────────────────

    _r(id='label_tss_minus_100_green_tf', category='labels',
       command='color footprints smaller than 90 bp green at -100 bp from the eve TSS',
       phrasings=[
           'label the TF footprint at -100 from the eve TSS green',
           'highlight TF at TSS-100 of eve in green',
           "make the TF binding 100bp upstream of eve's TSS green",
           'color the TF footprint -100 from eve TSS green',
           'paint the TF at eve TSS minus 100 green',
       ],
       context=V_DM6_2R,
       thinking='"color footprints smaller than 90 bp green at -100 bp from the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 100 bp upstream of the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_tss_minus_100_orange', category='labels',
       command='paint the footprint at -100 bp relative to the eve TSS orange',
       context=V_DM6_2R,
       thinking='"paint the footprint at -100 bp relative to the eve TSS orange": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 100 bp upstream of the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to orange.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_tss_plus_200_pink_pol2', category='labels',
       command='label the pol II footprint +200 bp from the sna TSS as pink',
       context=V_DM6_2L,
       thinking='"label the pol II footprint +200 bp from the sna TSS as pink": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click sna in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 200 bp downstream of the sna TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 35-65 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to pink.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_tss_zero_blue_nuc', category='labels',
       command='color the nucleosome at the ftz TSS blue',
       context=V_DM6_3R,
       thinking='"color the nucleosome at the ftz TSS blue": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='ftz → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Click ftz in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a nucleosome footprint at the ftz TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 90-200 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to blue.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_tss_minus_50_red_fire', category='labels',
       command='mark accessibility 50 bp upstream of the eve TSS in red',
       context=V_DM6_2R,
       thinking='"mark accessibility 50 bp upstream of the eve TSS in red": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the accessible (FIRE) stretch 50 bp upstream of the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to red.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_tss_plus_50_purple', category='labels',
       command='recolor the footprint at +50 from the bcd TSS purple',
       context=V_DM6_2R,
       thinking='"recolor the footprint at +50 from the bcd TSS purple": I guide them through it rather than doing it. First I move the view to bcd. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='bcd → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'bcd', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Click bcd in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 50 bp downstream of the bcd TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to purple.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_tss_human_sox2', category='labels',
       command='label the TF footprint at the SOX2 TSS yellow',
       context=V_HG38_SOX2,
       thinking='"label the TF footprint at the SOX2 TSS yellow": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click SOX2 in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the SOX2 TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to yellow.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_explicit_region_green', category='labels',
       command='color footprints overlapping 2R:9,975,000-9,975,200 green',
       context=V_DM6_2R,
       thinking='"color footprints overlapping 2R:9,975,000-9,975,200 green": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 2R:9,975,000-9,975,200.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_explicit_region_nuc', category='labels',
       command='paint nucleosomes red on 3R:12,001,000-12,002,000',
       context=V_DM6_3R,
       thinking='"paint nucleosomes red on 3R:12,001,000-12,002,000": I guide them through it rather than doing it. First I move the view to 3R:12,000,000. Then the controls in the order they\'d use them: Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='3R:12,000,000 → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_region', 'chrom': '3R', 'start': 12000000, 'end': 12003000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a nucleosome footprint 3R:12,001,000-12,002,000.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 90-250 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to red.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_size_filter_small_only', category='labels',
       command='highlight only TF-sized footprints in the current viewport in cyan',
       context=V_DM6_2R,
       thinking='"highlight only TF-sized footprints in the current viewport in cyan": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 2R:9,970,000-9,980,000.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to cyan.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_size_filter_big_only', category='labels',
       command='highlight nucleosomes between 140 and 180 bp in the current viewport in teal',
       context=V_DM6_2R,
       thinking='"highlight nucleosomes between 140 and 180 bp in the current viewport in teal": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a nucleosome footprint 2R:9,970,000-9,980,000.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 140-180 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to teal.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_pol2_only', category='labels',
       command='recolor only the Pol II footprints (35-65 bp) in red',
       context=V_DM6_2R,
       thinking='"recolor only the Pol II footprints (35-65 bp) in red": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 2R:9,970,000-9,980,000.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 35-65 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to red.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_explicit_with_label_str', category='labels',
       command="add a label called 'GAGA-binding region' on 2R:9974600-9974680 in green",
       context=V_DM6_2R,
       thinking='"add a label called \'GAGA-binding region\' on 2R:9974600-9974680 in green": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 2R:9,974,600-9,974,680.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_hex_color_passed_through', category='labels',
       command='color the TF footprint at +25 bp from the eve TSS with #FFA500',
       context=V_DM6_2R,
       thinking='"color the TF footprint at +25 bp from the eve TSS with #FFA500": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 25 bp downstream of the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to orange (#FFA500).', 'anchor': 'footprints-saved'},
       ]),


    # ── motifs ──────────────────────────────────────────────────────

    _r(id='motif_at_tss_eve', category='motifs',
       command='what motifs overlap the eve TSS region',
       phrasings=[
           "find motifs near eve's TSS",
           'list motifs at the eve promoter',
           'any motifs at the eve start site?',
           'tell me what motifs sit at the eve TSS',
           'show motifs at the eve TSS',
       ],
       context=V_DM6_2R,
       thinking='"what motifs overlap the eve TSS region": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='motif_at_tss_minus_100', category='motifs',
       command='show motifs at -100 from the ftz TSS',
       context=V_DM6_3R,
       thinking='"show motifs at -100 from the ftz TSS": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='ftz → Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint 100 bp upstream of the ftz TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='motif_explicit_region', category='motifs',
       command='motifs in 2R:9974600-9974750',
       context=V_DM6_2R,
       thinking='"motifs in 2R:9974600-9974750": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint 2R:9,974,600-9,974,750.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='motif_in_viewport', category='motifs',
       command='what motifs are in the current view',
       context=V_DM6_2R,
       thinking='"what motifs are in the current view": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint 2R:9,970,000-9,980,000.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='motif_at_gene_human', category='motifs',
       command='motifs near the SOX2 TSS',
       context=V_HG38_SOX2,
       thinking='"motifs near the SOX2 TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the SOX2 TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='motif_minus_strand_gene', category='motifs',
       command='motifs near the BRCA1 TSS',
       context=V_HG38_TP53,
       thinking='"motifs near the BRCA1 TSS": I guide them through it rather than doing it. First I move the view to BRCA1. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='BRCA1 → Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'navigate_gene', 'gene': 'BRCA1', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the BRCA1 TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_nav_scan_label_motif', category='multi_step',
       command='go to eve +/- 5kb, scan peaks, paint the footprint at -100 from the TSS green, and tell me what motifs it overlaps',
       context=V_DM6_2L,
       thinking='"go to eve +/- 5kb, scan peaks, paint the footprint at -100 from the TSS green, and tell me what motifs it overlaps": I guide them through it rather than doing it. First I move the view to eve. Then the controls in the order they\'d use them: Scan, TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Scan, Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='eve → Scan → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint)',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 100 bp upstream of the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
           {'type': 'explain', 'text': 'Its Classes tab lists the motifs matching that footprint, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='multi_nav_scan_cluster', category='multi_step',
       command='navigate to ftz, scan peaks, then cluster on the peak at the TSS',
       phrasings=[
           'go to ftz, find peaks, then cluster the TSS peak',
           'open ftz, scan for peaks, cluster on the TSS',
           'jump to ftz, run peak scanning, then cluster at the TSS',
           'ftz then scan then cluster at TSS',
       ],
       context=V_DM6_2R,
       thinking='"navigate to ftz, scan peaks, then cluster on the peak at the TSS": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened.',
       summary='ftz → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'try_it', 'text': 'Click the peak over the ftz TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='multi_nav_label_pol2', category='multi_step',
       command='show ftz +/- 2kb and recolor only the Pol II footprints at the TSS in cyan',
       context=V_DM6_2R,
       thinking='"show ftz +/- 2kb and recolor only the Pol II footprints at the TSS in cyan": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='ftz → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 2000},
           {'type': 'explain', 'text': 'Click ftz in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the ftz TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 35-65 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to cyan.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='multi_nav_lock_export', category='multi_step',
       command='navigate to eve, scan peaks, lock them, and export the session',
       context=V_DM6_3R,
       thinking='"navigate to eve, scan peaks, lock them, and export the session": I guide them through it rather than doing it. First I move the view to eve. Then the controls in the order they\'d use them: Scan, Lock peaks, Save. Their clicks: Scan, Save; the steps after each wait until it has happened.',
       summary='eve → Scan → Lock peaks → Save',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'explain', 'text': 'Click the lock to freeze these peaks, so navigating or re-scanning keeps the same set.', 'anchor': 'peaks-lock'},
           {'type': 'try_it', 'text': 'Click Save in the top bar: it downloads a session file with the view, datasets, clusters, rules and colours; Load File reopens it.', 'wait_for': 'session_saved', 'anchor': 'save-session'},
       ]),

    _r(id='multi_select_then_cluster', category='multi_step',
       command='pick the peak 200 bp upstream of the bcd TSS and cluster on it',
       context=V_DM6_2R,
       thinking='"pick the peak 200 bp upstream of the bcd TSS and cluster on it": I guide them through it rather than doing it. First I move the view to bcd. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='bcd → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'bcd', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak 200 bp upstream of the bcd TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='multi_human_full_flow', category='multi_step',
       command='open MYC +/- 10 kb, scan peaks, cluster on the TSS peak, and label the TF footprint at the TSS in green',
       context=V_HG38_TP53,
       thinking='"open MYC +/- 10 kb, scan peaks, cluster on the TSS peak, and label the TF footprint at the TSS in green": I guide them through it rather than doing it. First I move the view to MYC. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab, TSS-relative coordinates, Reads. Their clicks: Scan, Peaks track, Cluster, Reads; the steps after each wait until it has happened.',
       summary='MYC → Scan → Peaks track → Cluster → Clusters > Overview tab → TSS-relative coordinates',
       actions=[
           {'type': 'navigate_gene', 'gene': 'MYC', 'padding_bp': 10000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'try_it', 'text': 'Click the peak over the MYC TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
           {'type': 'explain', 'text': 'Click MYC in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the MYC TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='multi_label_two_offsets', category='multi_step',
       command='paint the footprint at -100 from eve TSS green and the one at +100 in red',
       context=V_DM6_2R,
       thinking='"paint the footprint at -100 from eve TSS green and the one at +100 in red": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab → Reads',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 100 bp upstream of the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 100 bp downstream of the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to red.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='multi_scan_motifs_only', category='multi_step',
       command='navigate to ftz +/- 2kb and tell me what motifs are present in the viewport',
       context=V_DM6_2R,
       thinking='"navigate to ftz +/- 2kb and tell me what motifs are present in the viewport": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='ftz → Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 2000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the ftz TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='multi_navigate_label_minus_strand', category='multi_step',
       command='open Ubx +/- 10 kb and color the TF footprint 200 bp upstream of the TSS green',
       context=V_DM6_2R,
       thinking='"open Ubx +/- 10 kb and color the TF footprint 200 bp upstream of the TSS green": I guide them through it rather than doing it. First I move the view to Ubx. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='Ubx → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'Ubx', 'padding_bp': 10000},
           {'type': 'explain', 'text': 'Click Ubx in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 200 bp upstream of the Ubx TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='multi_three_genes_navigate_only', category='multi_step',
       command='quickly check eve, ftz, and bcd',
       context=V_DM6_2L,
       thinking='Three sequential navigations; default padding is fine.',
       summary='Navigate to eve, ftz, bcd',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'navigate_gene', 'gene': 'bcd', 'padding_bp': 5000},
       ]),

    _r(id='multi_compare_promoters', category='multi_step',
       command='compare nuc occupancy at the eve and ftz TSSes — label them blue and red',
       context=V_DM6_2R,
       thinking='"compare nuc occupancy at the eve and ftz TSSes — label them blue and red": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab → ftz',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a nucleosome footprint at the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 90-250 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to blue.', 'anchor': 'footprints-saved'},
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a nucleosome footprint at the ftz TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 90-250 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to red.', 'anchor': 'footprints-saved'},
       ]),


    # ── api_call ────────────────────────────────────────────────────

    _r(id='api_get_region', category='api_call',
       command='what region am I currently looking at',
       context=V_DM6_2R,
       thinking='The current region is shown in the search box; point at it.',
       summary='The search box shows the current region',
       actions=[
           {'type': 'explain', 'text': "The search box shows the region you're looking at; the axis above the reads has the coordinates.", 'anchor': 'search-bar'},
       ]),

    _r(id='api_chroms', category='api_call',
       command='list available chromosomes',
       context=V_DM6_2R,
       thinking='"list available chromosomes": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Chromosome selector.',
       summary='Chromosome selector',
       actions=[
           {'type': 'explain', 'text': 'The chromosome selector lists every chromosome of the loaded reference; pick one to go there.', 'anchor': 'chrom-selector'},
       ]),

    _r(id='api_gene_search', category='api_call',
       command="search for genes containing 'ftz' in the name",
       context=V_DM6_2R,
       thinking='"search for genes containing \'ftz\' in the name": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Search box. Their clicks: Search box; the steps after each wait until it has happened.',
       summary='Search box',
       actions=[
           {'type': 'try_it', 'text': 'Type ftz in the search box: matching genes are listed as you type; pick one to go there.', 'wait_for': 'navigated', 'anchor': 'search-bar'},
       ]),

    _r(id='api_render_png', category='api_call',
       command='render the current view as a PNG',
       context=V_DM6_2R,
       thinking='"render the current view as a PNG": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Export.',
       summary='Export',
       actions=[
           {'type': 'explain', 'text': 'Click Export in the top bar and choose PNG: it saves the view as you see it, including panel copies.', 'anchor': 'export-figure'},
       ]),

    _r(id='api_session_export', category='api_call',
       command='export the session for reproducibility',
       phrasings=[
           'export the session so my capture regions are reproducible',
           'export the session',
       ],
       context=V_DM6_2R,
       thinking='"export the session for reproducibility": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Save. Their clicks: Save; the steps after each wait until it has happened.',
       summary='Save',
       actions=[
           {'type': 'try_it', 'text': 'Click Save in the top bar: it downloads a session file with the view, datasets, clusters, rules and colours; Load File reopens it.', 'wait_for': 'session_saved', 'anchor': 'save-session'},
       ]),

    _r(id='api_filter_transcription_state', category='api_call',
       command='filter to reads in the active transcription state at the eve TSS',
       phrasings=[
           'filter to reads with Pol II at the eve TSS',
       ],
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"filter to reads in the active transcription state at the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add filter rule, Rules > Filter tab, Filter. Their clicks: Filter; the steps after each wait until it has happened.',
       summary='Add filter rule → Rules > Filter tab → Filter',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Filter, click Add filter rule and name it Paused Pol II at eve TSS.', 'anchor': 'add-filter-rule'},
           {'type': 'explain', 'text': 'Set it to keep reads with at least 1 (count) of paused Pol II at the eve TSS. It then appears in the Filter dropdown.', 'anchor': 'rules-filter-tab'},
           {'type': 'try_it', 'text': 'Pick "Paused Pol II at eve TSS" in the Filter dropdown and click Filter.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),

    _r(id='api_pol2_com', category='api_call',
       command='compute the Pol II center-of-mass heatmap for the viewport',
       phrasings=[
           'compute Pol II center-of-mass for the viewport',
       ],
       context=V_DM6_2R,
       thinking='"compute the Pol II center-of-mass heatmap for the viewport": I guide them through it rather than doing it. Where a control needs something first, the step asks for it.',
       summary='Transcription State > pol2com',
       actions=[
           {'type': 'explain', 'text': "Click the gene in the gene track to select it. The Transcription panel's Pol II COM tab shows where Pol II sits along the gene, read by read.", 'panel_type': 'transcription-state', 'tab': 'pol2com', 'requires': 'has_selected_gene'},
       ]),

    _r(id='api_coacc_matrix', category='api_call',
       command='give me the co-accessibility matrix for the current viewport as JSON',
       phrasings=[
           'show co-accessibility metadata for the viewport',
           'render the co-accessibility matrix as a normalized PNG',
           'give me the raw co-accessibility matrix as JSON',
           'export the co-accessibility matrix data',
           'raw co-acc matrix for the viewport',
       ],
       context=V_DM6_2R,
       thinking='"give me the co-accessibility matrix for the current viewport as JSON": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Co-accessibility matrix, Refresh co-accessibility.',
       summary='Co-accessibility matrix → Refresh co-accessibility',
       actions=[
           {'type': 'open_panel', 'panel_type': 'co-accessibility'},
           {'type': 'explain', 'text': 'The matrix shows how often pairs of positions are open on the same molecule; its export button saves it as an image or as data.', 'anchor': 'coacc-matrix'},
           {'type': 'explain', 'text': 'Refresh recomputes it after you move the view.', 'anchor': 'coacc-refresh'},
       ]),

    _r(id='api_coacc_arcs', category='api_call',
       command='show the top co-accessible pairs in the viewport',
       context=V_DM6_2R,
       thinking='"show the top co-accessible pairs in the viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Co-accessibility matrix, Refresh co-accessibility.',
       summary='Co-accessibility matrix → Refresh co-accessibility',
       actions=[
           {'type': 'open_panel', 'panel_type': 'co-accessibility'},
           {'type': 'explain', 'text': 'Set the track mode to Arcs: the most co-accessible pairs are drawn as arcs.', 'anchor': 'coacc-matrix'},
           {'type': 'explain', 'text': 'Refresh recomputes it after you move the view.', 'anchor': 'coacc-refresh'},
       ]),

    _r(id='api_footprint_analyze', category='api_call',
       command='run footprint analysis on the current viewport for both datasets',
       phrasings=[
           'run footprint analysis on the current viewport',
           'footprint analysis on Embryo 2-4hr only',
           'run footprint analysis with 50 bp motif flanks',
           'footprint analysis using only motif tracks 0 and 2',
           'run footprint analysis',
       ],
       context=V_DM6_2R,
       thinking='"run footprint analysis on the current viewport for both datasets": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Selected footprint, Footprints > Classes tab. Their clicks: Reads; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Reads → Selected footprint → Footprints > Classes tab',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on any read to analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range and where it sits across the reads.', 'anchor': 'selected-footprint'},
           {'type': 'explain', 'text': 'Classes lists the recurring footprint classes here, with their sizes and matching motifs.', 'anchor': 'footprints-classes'},
       ]),

    _r(id='api_read_stats', category='api_call',
       command='give me read stats for the current viewport',
       phrasings=[
           'read stats at the eve TSS region',
           'give me stats for selected reads in the viewport',
       ],
       context=V_DM6_2R,
       thinking='"give me read stats for the current viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Read Stats > Summary tab, Read Stats > Table tab. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='Reads → Read Stats > Summary tab → Read Stats > Table tab',
       actions=[
           {'type': 'try_it', 'text': "Shift+click the reads you want stats for (or select a cluster's reads in the Clusters panel).", 'wait_for': 'reads_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'Read Stats sums them up: count, span, footprints per read and accessibility.', 'anchor': 'read-stats-summary'},
           {'type': 'explain', 'text': 'The Table tab has one row per read.', 'anchor': 'read-stats-table'},
       ]),

    _r(id='api_quality_filters_get', category='api_call',
       command='show the current quality filters',
       phrasings=[
           'show the active quality filters',
       ],
       context=V_DM6_2R,
       thinking='"show the current quality filters": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Quality.',
       summary='Quality',
       actions=[
           {'type': 'explain', 'text': "Quality in the toolbar shows the active quality cutoffs; the sidebar's Read Filters hold the read-level ones.", 'anchor': 'quality-filters'},
       ]),

    _r(id='api_design_primers', category='api_call',
       command='design primers for the eve TSS region',
       phrasings=[
           'design primers for the current region',
       ],
       context=V_DM6_2R,
       thinking='"design primers for the eve TSS region": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Peaks track, Primers > Design tab, Design primers, Primers > Order List tab. Their clicks: Peaks track, Design primers; the steps after each wait until it has happened.',
       summary='Peaks track → Primers > Design tab → Design primers → Primers > Order List tab',
       actions=[
           {'type': 'try_it', 'text': 'Click the peak (or peaks) the primers should flank in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'The Design tab designs around the selected peaks, or the view if none are selected.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers; pairs are ranked by fit (and specificity when BLAST is set up).', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Save the pairs you like; the Order List exports them as an order sheet.', 'anchor': 'primers-order-tab'},
       ]),

    _r(id='api_dafc_status', category='api_call',
       command='check DAF-C contact-map status',
       phrasings=[
           'is the DAF-C contact map loaded',
           'check if the Micro-C expected matrix is ready',
       ],
       context=V_DM6_2R,
       thinking='"check DAF-C contact-map status": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Contacts > Map tab.',
       summary='Contacts > Map tab',
       actions=[
           {'type': 'explain', 'text': 'The Contacts panel shows the contact map when one is loaded; load a .cool/.mcool with Load File.', 'anchor': 'contacts-map'},
       ]),

    _r(id='api_sort_reads', category='api_call',
       command='sort reads by accessibility at the eve TSS',
       context=V_DM6_2R,
       thinking='"sort reads by accessibility at the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Sort. Their clicks: Scan, Peaks track, Sort; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Sort',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Choose Accessibility in the Sort dropdown and click Sort: the most open reads at the selected peaks go to the top.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
       ]),

    _r(id='api_genes_in_region', category='api_call',
       command='list the genes in the current viewport',
       context=V_DM6_2R,
       thinking='"list the genes in the current viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Search box.',
       summary='Search box',
       actions=[
           {'type': 'explain', 'text': 'Genes in view are drawn in the gene track; start typing a name in the search box to list matching genes.', 'anchor': 'search-bar'},
       ]),

    _r(id='api_peaks_get', category='api_call',
       command='show the current peaks',
       context=V_DM6_2R,
       thinking='"show the current peaks": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Peaks track.',
       summary='Peaks track',
       actions=[
           {'type': 'explain', 'text': 'The detected peaks are drawn in the Peaks track; the Peaks toolbar shows how many there are.', 'anchor': 'peaks-track'},
       ]),

    _r(id='api_clusters_get', category='api_call',
       command='show the current clusters',
       context=V_DM6_2R,
       thinking='"show the current clusters": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'The Clusters panel lists every cluster with its read count.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='api_chipatlas_search_negative', category='api_call',
       command='search ChIP-Atlas for GAGA factor in flies',
       context=V_DM6_2R,
       thinking='"search ChIP-Atlas for GAGA factor in flies": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Browse hubs lists the ChIP-Atlas tracks for the current genome; type Trl in its search box to narrow them.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Tick a track to add it to the view.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),


    # ── negative ────────────────────────────────────────────────────

    _r(id='negative_unknown_gene', category='negative',
       command='navigate to notagene +/- 5kb',
       context=V_DM6_2R,
       thinking='The user typed a gene that the loaded GTF does not contain. Emit no actions and a clear warning so the user picks a real symbol.',
       summary="Cannot resolve gene 'notagene'",
       warnings=["Gene 'notagene' was not found in the loaded GTF. Use a gene symbol or ID from the loaded annotation."],
       actions=[]),

    _r(id='negative_no_gtf_loaded', category='negative',
       command='cluster on the peak at the bcd TSS',
       context=V_EMPTY,
       thinking="'GTF loaded: no': a TSS can't be resolved. Point at where the annotation is loaded instead of guessing.",
       summary='Load a gene annotation first',
       warnings=["No gene annotation is loaded, so the bcd TSS can't be resolved."],
       actions=[
           {'type': 'explain', 'text': "No gene annotation is loaded, so the bcd TSS can't be found. Load a GTF here, or pick a bundled genome (its genes load with it).", 'anchor': 'load-gtf'},
           {'type': 'explain', 'text': 'Once genes are loaded, search bcd, select the peak over its TSS and click Cluster.', 'anchor': 'genome-selector'},
       ]),

    _r(id='negative_no_datasets', category='negative',
       command='run footprint analysis on the current viewport',
       context=V_DM6_2R,
       dataset_count=0,
       thinking='Footprint analysis needs reads. The user loads a dataset first, then Cmd/Ctrl+clicks a footprint.',
       summary='Load a dataset, then Cmd+click a footprint',
       warnings=['No datasets are loaded; footprint analysis requires at least one fiber-seq or DAF-seq dataset.'],
       actions=[
           {'type': 'try_it', 'text': 'No dataset is loaded. Click Load File and open a fiber-seq or DAF-seq BAM/BigBed.', 'wait_for': 'dataset_loaded', 'anchor': 'load-dataset'},
           {'type': 'try_it', 'text': 'Then Cmd/Ctrl+click a footprint on a read to analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
       ]),

    _r(id='negative_partial_gene_ambiguity', category='negative',
       command='go to ev',
       context=V_DM6_2R,
       thinking="'ev' is not an exact gene symbol. The validator does case-insensitive exact match only — warn the user to disambiguate.",
       summary="Cannot resolve gene 'ev'",
       warnings=["Gene 'ev' was not found in the loaded GTF as an exact symbol. Did you mean 'eve'?"],
       actions=[]),

    _r(id='negative_blocked_route', category='negative',
       command='upload my BAM at /Users/me/data/test.bam',
       context=V_DM6_2R,
       thinking="Opening files is the user's click; point at Load File.",
       summary='Load File opens local files',
       warnings=["Copilot doesn't open files; use Load File."],
       actions=[
           {'type': 'try_it', 'text': "I can't open files for you. Click Load File and choose /Users/me/data/test.bam (or drag it onto the window).", 'wait_for': 'dataset_loaded', 'anchor': 'load-dataset'},
       ]),

    _r(id='negative_shutdown_request', category='negative',
       command='shut down the server',
       context=V_DM6_2R,
       thinking='Stopping the server is outside the browser; there is no control to point at.',
       summary="Copilot can't stop the server",
       warnings=["Copilot can't stop the server. Close the terminal running browser.py (Ctrl+C) to shut it down."],
       actions=[]),

    _r(id='negative_invent_motif', category='negative',
       command='how strong is the GATA motif at the eve TSS, give me the score',
       context=V_DM6_2R,
       thinking="I won't invent a score. The real one is in the motif list of the footprint: navigate, they Cmd/Ctrl+click it, and read GATA's score.",
       summary="Read the GATA score off the footprint's motif list",
       warnings=["Motif scores come from the browser; I don't estimate them."],
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs matching it, with their real scores; look for GATA there.', 'anchor': 'footprints-classes'},
       ]),


    # ── navigation ──────────────────────────────────────────────────

    _r(id='nav_gene_synonym_jump', category='navigation',
       command='jump to en',
       context=V_DM6_2R,
       thinking='Two-letter gene symbol — an exact GTF match.',
       summary='Navigate to en',
       actions=[
           {'type': 'navigate_gene', 'gene': 'en', 'padding_bp': 5000},
       ]),

    _r(id='nav_gene_kr_minus_strand', category='navigation',
       command='show Kr +/- 2 kb',
       context=V_DM6_2R,
       thinking='Kr is on the - strand. Symmetric padding via navigate_gene.',
       summary='Navigate to Kr +/- 2 kb',
       actions=[
           {'type': 'navigate_gene', 'gene': 'Kr', 'padding_bp': 2000},
       ]),

    _r(id='nav_gene_dpp', category='navigation',
       command='navigate to dpp +/- 15 kb',
       context=V_DM6_2L,
       thinking='dpp on + strand; navigate_gene.',
       summary='Navigate to dpp +/- 15 kb',
       actions=[
           {'type': 'navigate_gene', 'gene': 'dpp', 'padding_bp': 15000},
       ]),


    # ── labels ──────────────────────────────────────────────────────

    _r(id='label_minus_strand_offset', category='labels',
       command='paint the TF footprint at +500 from the wg TSS in green',
       context=V_DM6_2L,
       thinking='"paint the TF footprint at +500 from the wg TSS in green": I guide them through it rather than doing it. First I move the view to wg. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='wg → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'wg', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Click wg in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 500 bp downstream of the wg TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_nuc_around_tss_human', category='labels',
       command='color +1 nucleosome at the GATA1 TSS purple',
       context=V_HG38_TP53,
       thinking='"color +1 nucleosome at the GATA1 TSS purple": I guide them through it rather than doing it. First I move the view to GATA1. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='GATA1 → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'GATA1', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Click GATA1 in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a nucleosome footprint 200 bp downstream of the GATA1 TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 90-250 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to purple.', 'anchor': 'footprints-saved'},
       ]),


    # ── clustering ──────────────────────────────────────────────────

    _r(id='cluster_human_brca1_minus', category='clustering',
       command='cluster reads at the BRCA1 TSS',
       context=V_HG38_TP53,
       thinking='"cluster reads at the BRCA1 TSS": I guide them through it rather than doing it. First I move the view to BRCA1. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='BRCA1 → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'BRCA1', 'padding_bp': 10000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the BRCA1 TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_mouse_pax6', category='clustering',
       command='cluster on the Pax6 TSS peak',
       context=V_MM10_PAX6,
       thinking='"cluster on the Pax6 TSS peak": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the Pax6 TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── api_call ────────────────────────────────────────────────────

    _r(id='api_jupyter_goto', category='api_call',
       command='POST /api/jupyter/goto with chrom 2R, 9970000-9980000',
       context=V_DM6_2L,
       thinking='"POST /api/jupyter/goto with chrom 2R, 9970000-9980000": moving the view is something I can do for them, so I navigate directly.',
       summary='2R:9,970,000',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9970000, 'end': 9980000},
       ]),

    _r(id='api_dissolve_cluster', category='api_call',
       command='dissolve cluster 2 in the current viewport',
       phrasings=[
           'dissolve cluster 2',
           'merge cluster 2 into the others',
           'break up cluster 2',
           "reassign cluster 2's reads",
           'dissolve the second cluster',
       ],
       context=V_DM6_2R,
       thinking='"dissolve cluster 2 in the current viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Right-click cluster 2 and choose Dissolve: its reads move to their nearest remaining cluster.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='api_render_svg', category='api_call',
       command='render the viewport as SVG',
       context=V_DM6_2R,
       thinking='"render the viewport as SVG": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Export.',
       summary='Export',
       actions=[
           {'type': 'explain', 'text': 'Click Export in the top bar and choose SVG: it saves the view as you see it, including panel copies.', 'anchor': 'export-figure'},
       ]),

    _r(id='api_render_pdf', category='api_call',
       command='render the viewport as PDF',
       context=V_DM6_2R,
       thinking='"render the viewport as PDF": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Export.',
       summary='Export',
       actions=[
           {'type': 'explain', 'text': 'Click Export in the top bar and choose PDF: it saves the view as you see it, including panel copies.', 'anchor': 'export-figure'},
       ]),


    # ── motifs ──────────────────────────────────────────────────────

    _r(id='motif_at_minus_strand_gene_partial', category='motifs',
       command='show me the motifs in the Kr promoter',
       context=V_DM6_2R,
       thinking='"show me the motifs in the Kr promoter": I guide them through it rather than doing it. First I move the view to Kr. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='Kr → Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'navigate_gene', 'gene': 'Kr', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the Kr TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_lock_then_export_session', category='multi_step',
       command='lock the peaks and export the session',
       context=V_DM6_2R,
       thinking='"lock the peaks and export the session": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Lock peaks, Save. Their clicks: Save; the steps after each wait until it has happened.',
       summary='Lock peaks → Save',
       actions=[
           {'type': 'explain', 'text': 'Click the lock to freeze these peaks, so navigating or re-scanning keeps the same set.', 'anchor': 'peaks-lock'},
           {'type': 'try_it', 'text': 'Click Save in the top bar: it downloads a session file with the view, datasets, clusters, rules and colours; Load File reopens it.', 'wait_for': 'session_saved', 'anchor': 'save-session'},
       ]),

    _r(id='multi_navigate_render', category='multi_step',
       command='navigate to ftz +/- 5 kb and render a PNG',
       context=V_DM6_2L,
       thinking='"navigate to ftz +/- 5 kb and render a PNG": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Export.',
       summary='ftz → Export',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Click Export in the top bar and choose PNG: it saves the view as you see it, including panel copies.', 'anchor': 'export-figure'},
       ]),

    _r(id='multi_label_two_genes_same_color', category='multi_step',
       command='color the TF footprints at the eve and ftz TSSes both green',
       context=V_DM6_2R,
       thinking='"color the TF footprints at the eve and ftz TSSes both green": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab → ftz',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the ftz TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='multi_navigate_lock_then_cluster', category='multi_step',
       command='go to eve, lock peaks, and cluster on the TSS peak',
       context=V_DM6_3R,
       thinking='"go to eve, lock peaks, and cluster on the TSS peak": I guide them through it rather than doing it. First I move the view to eve. Then the controls in the order they\'d use them: Lock peaks, Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='eve → Lock peaks → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Click the lock to freeze these peaks, so navigating or re-scanning keeps the same set.', 'anchor': 'peaks-lock'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='multi_select_minus_strand_offset', category='multi_step',
       command='select the peak 100 bp upstream of the wg TSS and cluster',
       context=V_DM6_2L,
       thinking='"select the peak 100 bp upstream of the wg TSS and cluster": I guide them through it rather than doing it. First I move the view to wg. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='wg → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'wg', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak 100 bp upstream of the wg TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='multi_renavigate_after_view', category='multi_step',
       command='okay now go back to ftz and run footprint analysis there',
       context=V_DM6_2R,
       thinking='"okay now go back to ftz and run footprint analysis there": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Reads, Selected footprint, Footprints > Classes tab. Their clicks: Reads; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='ftz → Reads → Selected footprint → Footprints > Classes tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on any read to analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range and where it sits across the reads.', 'anchor': 'selected-footprint'},
           {'type': 'explain', 'text': 'Classes lists the recurring footprint classes here, with their sizes and matching motifs.', 'anchor': 'footprints-classes'},
       ]),


    # ── negative ────────────────────────────────────────────────────

    _r(id='negative_locked_peaks_no_scan', category='negative',
       command='rescan peaks but keep them locked',
       context=V_DM6_2R,
       thinking='Scanning while locked does nothing, so the sequence is unlock, scan, relock.',
       summary='Unlock, Scan, lock again',
       warnings=['Rescanning is suppressed while peaks are locked.'],
       actions=[
           {'type': 'explain', 'text': "Locked peaks aren't rescanned. Click the lock to unlock them first.", 'anchor': 'peaks-lock'},
           {'type': 'try_it', 'text': 'Click Scan.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'explain', 'text': 'Then click the lock again to freeze the new peaks.', 'anchor': 'peaks-lock'},
       ]),


    # ── labels ──────────────────────────────────────────────────────

    _r(id='label_layer_explicit_fire', category='labels',
       command='paint accessibility on 2R:9974600-9974750 in cyan',
       context=V_DM6_2R,
       thinking='"paint accessibility on 2R:9974600-9974750 in cyan": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='Reads → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the accessible (FIRE) stretch 2R:9,974,600-9,974,750.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to cyan.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='label_size_only_above_120', category='labels',
       command='recolor any footprint over 120 bp at the eve TSS in red',
       context=V_DM6_2R,
       thinking='"recolor any footprint over 120 bp at the eve TSS in red": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a nucleosome footprint at the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 120-250 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to red.', 'anchor': 'footprints-saved'},
       ]),


    # ── api_call ────────────────────────────────────────────────────

    _r(id='api_genes_in_window_human', category='api_call',
       command='list the genes near the SOX2 region',
       context=V_HG38_SOX2,
       thinking='"list the genes near the SOX2 region": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Search box.',
       summary='Search box',
       actions=[
           {'type': 'explain', 'text': 'Genes in view are drawn in the gene track; start typing a name in the search box to list matching genes.', 'anchor': 'search-bar'},
       ]),


    # ── negative ────────────────────────────────────────────────────

    _r(id='api_session_import_blocked', category='negative',
       command='import a session from /Users/me/old.json',
       context=V_DM6_2R,
       thinking="Session import is the user's click; point at both ways.",
       summary='Restore session or Load File',
       warnings=["Copilot cannot read local file paths. Use the GUI's Session > Import to load /Users/me/old.json."],
       actions=[
           {'type': 'explain', 'text': 'Restore session in Data & Sessions reloads a saved session file; pick /Users/me/old.json there.', 'anchor': 'restore-session'},
           {'type': 'explain', 'text': 'Load File (or dragging the file onto the window) works too.', 'anchor': 'load-dataset'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='api_pdb_render_full_workflow', category='multi_step',
       command='navigate to MYC, scan peaks, render PNG, and export the session',
       context=V_HG38_TP53,
       thinking='"navigate to MYC, scan peaks, render PNG, and export the session": I guide them through it rather than doing it. First I move the view to MYC. Then the controls in the order they\'d use them: Scan, Export, Save. Their clicks: Scan, Save; the steps after each wait until it has happened.',
       summary='MYC → Scan → Export → Save',
       actions=[
           {'type': 'navigate_gene', 'gene': 'MYC', 'padding_bp': 10000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'explain', 'text': 'Click Export in the top bar and choose PNG: it saves the view as you see it, including panel copies.', 'anchor': 'export-figure'},
           {'type': 'try_it', 'text': 'Click Save in the top bar: it downloads a session file with the view, datasets, clusters, rules and colours; Load File reopens it.', 'wait_for': 'session_saved', 'anchor': 'save-session'},
       ]),


    # ── labels ──────────────────────────────────────────────────────

    _r(id='label_human_tp53_promoter', category='labels',
       command='color the TF footprints in the TP53 promoter green',
       context=V_HG38_TP53,
       thinking='"color the TF footprints in the TP53 promoter green": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click TP53 in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the TP53 TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),


    # ── motifs ──────────────────────────────────────────────────────

    _r(id='motif_human_tp53_promoter', category='motifs',
       command='motifs in the TP53 promoter',
       context=V_HG38_TP53,
       thinking='"motifs in the TP53 promoter": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the TP53 TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_label_then_motif_same_window', category='multi_step',
       command='paint -100 from the eve TSS green and tell me what motifs that footprint overlaps',
       context=V_DM6_2R,
       thinking='"paint -100 from the eve TSS green and tell me what motifs that footprint overlaps": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab, Footprints > Classes tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab → Footprints > Classes tab',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 100 bp upstream of the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
           {'type': 'explain', 'text': 'Its Classes tab lists the motifs matching that footprint, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='multi_select_explicit_then_cluster', category='multi_step',
       command='select the peak at chr3R:6862000 and cluster on it',
       context=V_DM6_3R,
       thinking='"select the peak at chr3R:6862000 and cluster on it": I guide them through it rather than doing it. First I move the view to chr3R:6,857,000. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='chr3R:6,857,000 → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'navigate_region', 'chrom': 'chr3R', 'start': 6857000, 'end': 6867000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak at chr3R:6,862,000 in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── api_call ────────────────────────────────────────────────────

    _r(id='api_filter_by_layer', category='api_call',
       command='filter to reads with TF footprints in the viewport',
       context=V_DM6_2R,
       thinking='"filter to reads with TF footprints in the viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add filter rule, Filter. Their clicks: Filter; the steps after each wait until it has happened.',
       summary='Add filter rule → Filter',
       actions=[
           {'type': 'explain', 'text': 'Make a filter rule in Rules > Filter: at least 1 TF footprint in the view.', 'anchor': 'add-filter-rule'},
           {'type': 'try_it', 'text': 'Pick it in the Filter dropdown and click Filter.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),

    _r(id='api_clear_filter', category='api_call',
       command='clear the read filter',
       context=V_DM6_2R,
       thinking='"clear the read filter": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clear filter. Their clicks: Clear filter; the steps after each wait until it has happened.',
       summary='Clear filter',
       actions=[
           {'type': 'try_it', 'text': 'Click Clear filter to show every read again.', 'wait_for': 'filter_cleared', 'anchor': 'clear-filter'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_human_label_two_layers', category='multi_step',
       command='at the SOX2 TSS, color the nucleosome blue and the TF footprint green',
       context=V_HG38_SOX2,
       thinking='"at the SOX2 TSS, color the nucleosome blue and the TF footprint green": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab → Reads',
       actions=[
           {'type': 'explain', 'text': 'Click SOX2 in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a nucleosome footprint at the SOX2 TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 90-250 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to blue.', 'anchor': 'footprints-saved'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the SOX2 TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='multi_unlock_scan_relock', category='multi_step',
       command='rescan peaks fresh — unlock, scan, lock again',
       context=V_DM6_2R,
       thinking='"rescan peaks fresh — unlock, scan, lock again": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Lock peaks, Scan. Their clicks: Scan; the steps after each wait until it has happened.',
       summary='Lock peaks → Scan → Lock peaks',
       actions=[
           {'type': 'explain', 'text': 'Click the lock again to unlock the peaks, so Scan can replace them.', 'anchor': 'peaks-lock'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'explain', 'text': 'Click the lock to freeze these peaks, so navigating or re-scanning keeps the same set.', 'anchor': 'peaks-lock'},
       ]),

    _r(id='multi_navigate_minus_strand_label_motif', category='multi_step',
       command='open Ubx, color the TF footprint at -200 from the TSS green, and check what motifs that overlaps',
       context=V_DM6_3R,
       thinking='"open Ubx, color the TF footprint at -200 from the TSS green, and check what motifs that overlaps": I guide them through it rather than doing it. First I move the view to Ubx. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab, Footprints > Classes tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='Ubx → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'Ubx', 'padding_bp': 10000},
           {'type': 'explain', 'text': 'Click Ubx in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 200 bp upstream of the Ubx TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
           {'type': 'explain', 'text': 'Its Classes tab lists the motifs matching that footprint, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='multi_two_views_compare', category='multi_step',
       command='compare the eve and bcd promoters by labeling Pol II at each',
       context=V_DM6_2R,
       thinking='"compare the eve and bcd promoters by labeling Pol II at each": I guide them through it rather than doing it. First I move the view to bcd. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab → bcd',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 35-65 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to cyan.', 'anchor': 'footprints-saved'},
           {'type': 'navigate_gene', 'gene': 'bcd', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the bcd TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 35-65 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to purple.', 'anchor': 'footprints-saved'},
       ]),


    # ── clustering ──────────────────────────────────────────────────

    _r(id='cluster_explicit_with_dataset_ids', category='clustering',
       command='cluster the eve TSS peak using only the Embryo 2-4hr dataset',
       context=V_DM6_2R,
       thinking='"cluster the eve TSS peak using only the Embryo 2-4hr dataset": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Reads, Scan, Peaks track. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Cluster controls toggle → Clustering method → K → Reads → Scan → Peaks track',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 4.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Click the header of the dataset panel you want (Cmd/Ctrl+click for more) so only it is clustered.', 'anchor': 'reads-track'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── api_call ────────────────────────────────────────────────────

    _r(id='api_jupyter_settings_post', category='api_call',
       command='set the analysis sample seed to 42',
       phrasings=[
           'lock the analysis seed at 42 for reproducibility',
       ],
       context=V_DM6_2R,
       thinking='"set the analysis sample seed to 42": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reproducibility.',
       summary='Reproducibility',
       actions=[
           {'type': 'explain', 'text': 'Set the sampling seed to 42: clustering and profiles then pick the same reads every run.', 'anchor': 'reproducibility'},
       ]),

    _r(id='api_get_footprint_colors', category='api_call',
       command='show the active footprint color rules',
       context=V_DM6_2R,
       thinking='Footprint colours come from Labeling rules and saved footprints; show both lists.',
       summary='Labeling rules and saved-footprint colours',
       actions=[
           {'type': 'explain', 'text': 'Your colour rules are listed in the Labeling panel, top to bottom in the order they apply.', 'anchor': 'labeling-rules'},
           {'type': 'explain', 'text': 'Colours of saved footprints are set in Footprints > Saved.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='api_clear_footprint_colors', category='api_call',
       command='clear all my footprint color overrides',
       context=V_DM6_2R,
       thinking='Clearing colours is Reset in the Labeling panel.',
       summary='Labeling panel: Reset',
       actions=[
           {'type': 'explain', 'text': 'In the Labeling panel, Reset restores the default colours and removes your rules.', 'anchor': 'labeling-rules'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_label_minus_then_clear', category='multi_step',
       command='clear the existing footprint colors and add a fresh red rule on TF footprints in the eve promoter',
       context=V_DM6_2R,
       thinking='Reset clears the old colours; a new rule with a gene condition limits it to eve.',
       summary='Reset, then a red TF rule with an eve gene condition',
       actions=[
           {'type': 'explain', 'text': 'In the Labeling panel, Reset removes your existing colour rules.', 'anchor': 'labeling-rules'},
           {'type': 'explain', 'text': 'Then Add rule: colour red, TF layer, 1-89 bp.', 'anchor': 'add-label-rule'},
           {'type': 'explain', 'text': 'Add a gene condition for eve so it only colours TF footprints in the eve promoter; drag the rule to the top.', 'anchor': 'labeling-rules'},
       ]),


    # ── selection ───────────────────────────────────────────────────

    _r(id='select_then_no_cluster', category='selection',
       command="just select the peak at the bcd TSS, don't cluster",
       context=V_DM6_2R,
       thinking='"just select the peak at the bcd TSS, don\'t cluster": I guide them through it rather than doing it. First I move the view to bcd. Then the controls in the order they\'d use them: Scan, Peaks track. Their clicks: Scan, Peaks track; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='bcd → Scan → Peaks track',
       actions=[
           {'type': 'navigate_gene', 'gene': 'bcd', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the bcd TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
       ]),

    _r(id='select_at_negative_offset_default_tolerance', category='selection',
       command='select the peak 250 bp upstream of the eve TSS',
       context=V_DM6_2R,
       thinking='"select the peak 250 bp upstream of the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track. Their clicks: Scan, Peaks track; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak 250 bp upstream of the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_navigate_then_motif_only', category='multi_step',
       command='open ftz +/- 500 bp and tell me what motifs are right at the TSS',
       context=V_DM6_2R,
       thinking='"open ftz +/- 500 bp and tell me what motifs are right at the TSS": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='ftz → Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 500},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the ftz TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),


    # ── negative ────────────────────────────────────────────────────

    _r(id='negative_no_motif_tracks', category='negative',
       command='motifs in the current viewport',
       context=V_DM6_2R,
       dataset_count=0,
       thinking='No datasets and likely no motif track: point at both loads.',
       summary='Load data and a motif track',
       warnings=['No datasets are loaded.'],
       actions=[
           {'type': 'try_it', 'text': 'No dataset is loaded yet: Load File opens one.', 'wait_for': 'dataset_loaded', 'anchor': 'load-dataset'},
           {'type': 'explain', 'text': "Motif sites come from a motif track: load JASPAR motifs in the Tracks panel and they're drawn across the view.", 'anchor': 'tracks-browse-hubs'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_full_repro_run', category='multi_step',
       command='full reproducibility run on the eve TSS: navigate, scan, lock, cluster, render PNG, export',
       context=V_DM6_3R,
       thinking='"full reproducibility run on the eve TSS: navigate, scan, lock, cluster, render PNG, export": I guide them through it rather than doing it. First I move the view to eve. Then the controls in the order they\'d use them: Scan, Lock peaks, Peaks track, Cluster, Clusters > Overview tab, Export. Their clicks: Scan, Peaks track, Cluster, Save; the steps after each wait until it has happened.',
       summary='eve → Scan → Lock peaks → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'explain', 'text': 'Click the lock to freeze these peaks, so navigating or re-scanning keeps the same set.', 'anchor': 'peaks-lock'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
           {'type': 'explain', 'text': 'Click Export in the top bar and choose PNG: it saves the view as you see it, including panel copies.', 'anchor': 'export-figure'},
           {'type': 'try_it', 'text': 'Click Save in the top bar: it downloads a session file with the view, datasets, clusters, rules and colours; Load File reopens it.', 'wait_for': 'session_saved', 'anchor': 'save-session'},
       ]),


    # ── contact_map ─────────────────────────────────────────────────

    _r(id='dafc_image_viewport', category='contact_map',
       command='render the DAF-C matrix for the current viewport',
       phrasings=[
           'give me the Micro-C matrix data for the current viewport',
       ],
       context=V_DM6_2R,
       thinking='"render the DAF-C matrix for the current viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Contacts > Map tab.',
       summary='Contacts > Map tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'contact-map', 'tab': 'map'},
           {'type': 'explain', 'text': 'The Map tab shows the contact matrix for the current view; the export button saves it as an image or data.', 'anchor': 'contacts-map'},
       ]),

    _r(id='dafc_select_region', category='contact_map',
       command='select a 2 kb DAF-C window around the eve TSS',
       phrasings=[
           'select the contact between 9.97 Mb and 9.98 Mb on 2R',
       ],
       context=V_DM6_2R,
       thinking='"select a 2 kb DAF-C window around the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Contacts > Map tab.',
       summary='Contacts > Map tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'contact-map', 'tab': 'map'},
           {'type': 'explain', 'text': 'Drag a rectangle on the map over the contact you want: the reads linking those two windows are selected.', 'anchor': 'contacts-map'},
           {'type': 'explain', 'text': 'Open Regions then opens both ends side by side.', 'anchor': 'contacts-map'},
       ]),

    _r(id='microc_arcs', category='contact_map',
       command='show the top Micro-C contacts in the viewport',
       context=V_DM6_2R,
       thinking='"show the top Micro-C contacts in the viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Contacts > Map tab.',
       summary='Contacts > Map tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'contact-map', 'tab': 'map'},
           {'type': 'explain', 'text': 'Switch the Micro-C track to Arcs: the strongest contacts in view are drawn as arcs.', 'anchor': 'contacts-map'},
       ]),

    _r(id='microc_virtual4c', category='contact_map',
       command='virtual 4C from the eve TSS',
       context=V_DM6_2R,
       thinking='"virtual 4C from the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Contacts > Map tab.',
       summary='Contacts > Map tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'contact-map', 'tab': 'map'},
           {'type': 'explain', 'text': 'Click a position on the Micro-C track to set the viewpoint: the virtual 4C profile shows its contacts across the view.', 'anchor': 'contacts-map'},
       ]),

    _r(id='microc_strip', category='contact_map',
       command='render the Micro-C triangle strip for the viewport',
       context=V_DM6_2R,
       thinking='"render the Micro-C triangle strip for the viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Contacts > Map tab.',
       summary='Contacts > Map tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'contact-map', 'tab': 'map'},
           {'type': 'explain', 'text': 'Switch the Micro-C track to Strip for the triangle view of the matrix under the reads.', 'anchor': 'contacts-map'},
       ]),

    _r(id='microc_apa_at_eve_tss', category='contact_map',
       command='run aggregate peak analysis centered at the eve TSS',
       context=V_DM6_2R,
       thinking='"run aggregate peak analysis centered at the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Peaks track, Contacts > Map tab. Their clicks: Peaks track; the steps after each wait until it has happened.',
       summary='Peaks track → Contacts > Map tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'contact-map', 'tab': 'map'},
           {'type': 'try_it', 'text': 'Click the peaks to aggregate in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': "With peaks selected, the Micro-C track's APA view averages the contacts between them.", 'anchor': 'contacts-map'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_navigate_then_dafc', category='multi_step',
       command='open ftz +/- 5kb and show the DAF-C matrix',
       context=V_DM6_3R,
       thinking='"open ftz +/- 5kb and show the DAF-C matrix": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Contacts > Map tab.',
       summary='ftz → Contacts > Map tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'open_panel', 'panel_type': 'contact-map', 'tab': 'map'},
           {'type': 'explain', 'text': 'The Map tab shows the contact matrix for the current view; the export button saves it as an image or data.', 'anchor': 'contacts-map'},
       ]),


    # ── annotations ─────────────────────────────────────────────────

    _r(id='annot_files_list', category='annotations',
       command='list the loaded annotation files',
       context=V_DM6_2R,
       thinking='"list the loaded annotation files": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Annotations > Files tab.',
       summary='Annotations > Files tab',
       actions=[
           {'type': 'explain', 'text': 'The Files tab lists the loaded per-read annotation files.', 'anchor': 'annotations-files'},
       ]),

    _r(id='annot_activate_file', category='annotations',
       command='activate annotation file fcnn-tf',
       context=V_DM6_2R,
       thinking='"activate annotation file fcnn-tf": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Annotations > Files tab.',
       summary='Annotations > Files tab',
       actions=[
           {'type': 'explain', 'text': 'In the Files tab, tick the annotation file to show it.', 'anchor': 'annotations-files'},
       ]),

    _r(id='annot_deactivate_file', category='annotations',
       command='turn off annotation file fcnn-tf',
       context=V_DM6_2R,
       thinking='"turn off annotation file fcnn-tf": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Annotations > Files tab.',
       summary='Annotations > Files tab',
       actions=[
           {'type': 'explain', 'text': 'In the Files tab, untick the annotation file to hide it.', 'anchor': 'annotations-files'},
       ]),

    _r(id='annot_set_threshold', category='annotations',
       command='set the FiberCNN-TF probability threshold to 0.85',
       context=V_DM6_2R,
       thinking='"set the FiberCNN-TF probability threshold to 0.85": I guide them through it rather than doing it.',
       summary='Annotations > types',
       actions=[
           {'type': 'explain', 'text': "On the Annotations panel's Types tab, set the FiberCNN-TF threshold to 0.85: calls scored below it are ignored.", 'panel_type': 'annotations', 'tab': 'types'},
       ]),

    _r(id='annot_region', category='annotations',
       command='get annotation overlays for the current viewport',
       context=V_DM6_2R,
       thinking='"get annotation overlays for the current viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Annotations > Files tab.',
       summary='Annotations > Files tab',
       actions=[
           {'type': 'explain', 'text': 'Active annotation files are drawn on the reads; tick or untick them in the Files tab.', 'anchor': 'annotations-files'},
       ]),

    _r(id='annot_filter_by_score', category='annotations',
       command='filter reads by FiberCNN-TF score above 0.7 in the viewport',
       context=V_DM6_2R,
       thinking='"filter reads by FiberCNN-TF score above 0.7 in the viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Annotations > Filter tab. Their clicks: Annotations > Filter tab; the steps after each wait until it has happened.',
       summary='Annotations > types → Annotations > Filter tab',
       actions=[
           {'type': 'explain', 'text': "On the Annotations panel's Types tab, set the FiberCNN-TF threshold to 0.7: calls scored below it are ignored.", 'panel_type': 'annotations', 'tab': 'types'},
           {'type': 'explain', 'text': 'On the Filter tab, choose FiberCNN-TF with Has Any.', 'anchor': 'annotations-filter'},
           {'type': 'try_it', 'text': 'Click Apply: only reads carrying it stay.', 'wait_for': 'filter_applied', 'anchor': 'annotations-filter'},
       ]),

    _r(id='annot_cluster', category='annotations',
       command='cluster reads by FiberCNN-TF annotation in the current viewport',
       context=V_DM6_2R,
       thinking='"cluster reads by FiberCNN-TF annotation in the current viewport": I guide them through it rather than doing it. Their clicks: ; the steps after each wait until it has happened.',
       summary='Annotations > cluster',
       actions=[
           {'type': 'explain', 'text': "On the Annotations panel's Cluster tab, pick FiberCNN-TF.", 'panel_type': 'annotations', 'tab': 'cluster'},
           {'type': 'try_it', 'text': 'Click Cluster: reads are grouped by which annotations they carry.', 'wait_for': 'clustered', 'panel_type': 'annotations', 'tab': 'cluster'},
       ]),

    _r(id='annot_profile', category='annotations',
       command='show the FiberCNN-TF profile across the viewport',
       context=V_DM6_2R,
       thinking='"show the FiberCNN-TF profile across the viewport": I guide them through it rather than doing it.',
       summary='Annotations > profile',
       actions=[
           {'type': 'explain', 'text': "The Annotations panel's Profile tab plots how often each annotation occurs along the view.", 'panel_type': 'annotations', 'tab': 'profile'},
       ]),


    # ── capture ─────────────────────────────────────────────────────

    _r(id='capture_add_via_marker', category='capture',
       command='add the eve TSS as a capture region',
       phrasings=[
           'add 2R:9974600-9974800 as a capture region',
           'capture this region for export',
       ],
       context=V_DM6_2R,
       thinking='"add the eve TSS as a capture region": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add capture region.',
       summary='Add capture region',
       actions=[
           {'type': 'explain', 'text': 'Click Add capture region to add the view.', 'anchor': 'capture-add-region'},
       ]),


    # ── transcription_state ─────────────────────────────────────────

    _r(id='ts_filter_open_at_eve_tss', category='transcription_state',
       command='select all reads with an open TSS at eve',
       context=V_DM6_2R,
       thinking='"select all reads with an open TSS at eve": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Filter. Their clicks: Scan, Peaks track, Filter; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Filter',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Choose Open at selected peaks in the Filter dropdown and click Filter: only reads with that site open stay.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),

    _r(id='ts_filter_closed_at_ftz_tss', category='transcription_state',
       command='show reads where the ftz promoter is closed',
       context=V_DM6_3R,
       thinking='"show reads where the ftz promoter is closed": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Filter. Their clicks: Scan, Peaks track, Filter; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Filter',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Choose Closed at selected peaks in the Filter dropdown and click Filter: only reads with that site closed stay.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),

    _r(id='ts_pol2_com_at_gene', category='transcription_state',
       command='compute Pol II center-of-mass at the eve TSS',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='Pol II centre of mass is computed for the selected gene in the Transcription panel; eve must be selected first.',
       summary='Select eve; Transcription > Pol II COM',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it.', 'panel_type': 'transcription-state', 'tab': 'pol2com', 'requires': 'has_selected_gene'},
           {'type': 'explain', 'text': "The Transcription panel's Pol II COM tab shows where Pol II sits along eve, read by read.", 'panel_type': 'transcription-state', 'tab': 'pol2com'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_ts_filter_then_cluster', category='multi_step',
       command='filter to reads with an open eve TSS and cluster on it',
       context=V_DM6_2R,
       thinking='"filter to reads with an open eve TSS and cluster on it": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Filter, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Filter, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Filter → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Choose Open at selected peaks in the Filter dropdown and click Filter: only reads with that site open stay.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='multi_ts_compare_two_states', category='multi_step',
       command='compare reads with active vs inactive eve promoters by labeling them',
       context=V_DM6_2R,
       thinking='"compare reads with active vs inactive eve promoters by labeling them": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Filter, TSS-relative coordinates, Reads, Selected footprint. Their clicks: Scan, Peaks track, Filter, Reads; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Filter → TSS-relative coordinates → Reads → Selected footprint',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Choose Open at selected peaks in the Filter dropdown and click Filter: only reads with that site open stay.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),


    # ── transcription_state ─────────────────────────────────────────

    _r(id='ts_filter_rev_strand_gene', category='transcription_state',
       command='select reads with an open sna TSS',
       context=V_DM6_2L,
       thinking='"select reads with an open sna TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Filter. Their clicks: Scan, Peaks track, Filter; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Filter',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Choose Open at selected peaks in the Filter dropdown and click Filter: only reads with that site open stay.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),


    # ── footprint_analysis ──────────────────────────────────────────

    _r(id='footprint_analyze_motif_threshold', category='footprint_analysis',
       command='run footprint analysis with a stricter motif threshold of 0.9',
       context=V_DM6_2R,
       thinking='"run footprint analysis with a stricter motif threshold of 0.9": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs, Reads, Selected footprint, Footprints > Classes tab. Their clicks: Reads; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Browse hubs → Reads → Selected footprint → Footprints > Classes tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Set the motif score threshold slider to 0.9: higher keeps only stronger matches.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on any read to analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range and where it sits across the reads.', 'anchor': 'selected-footprint'},
           {'type': 'explain', 'text': 'Classes lists the recurring footprint classes here, with their sizes and matching motifs.', 'anchor': 'footprints-classes'},
       ]),

    _r(id='footprint_analyze_specific_motifs', category='footprint_analysis',
       command='run footprint analysis with only the GAGA and TATA motifs',
       context=V_DM6_2R,
       thinking='"run footprint analysis with only the GAGA and TATA motifs": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs, Reads, Selected footprint, Footprints > Classes tab. Their clicks: Browse hubs, Reads; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Browse hubs → Reads → Selected footprint → Footprints > Classes tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Type Trl, TBP in the JASPAR box.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Click Load: each motif is drawn as a track of its sites.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on any read to analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range and where it sits across the reads.', 'anchor': 'selected-footprint'},
           {'type': 'explain', 'text': 'Classes lists the recurring footprint classes here, with their sizes and matching motifs.', 'anchor': 'footprints-classes'},
       ]),

    _r(id='footprint_analyze_at_gene_tss', category='footprint_analysis',
       command='footprint analysis at the eve TSS +/- 200 bp',
       context=V_DM6_2R,
       thinking='"footprint analysis at the eve TSS +/- 200 bp": I guide them through it rather than doing it. First I move the view to 2R:9,973,800. Then the controls in the order they\'d use them: Reads, Selected footprint, Footprints > Classes tab. Their clicks: Reads; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='2R:9,973,800 → Reads → Selected footprint → Footprints > Classes tab',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9973800, 'end': 9974200},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on any read to analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range and where it sits across the reads.', 'anchor': 'selected-footprint'},
           {'type': 'explain', 'text': 'Classes lists the recurring footprint classes here, with their sizes and matching motifs.', 'anchor': 'footprints-classes'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_navigate_then_footprint_analyze', category='multi_step',
       command='open ftz +/- 2 kb and run footprint analysis there',
       context=V_DM6_2L,
       thinking='"open ftz +/- 2 kb and run footprint analysis there": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Reads, Selected footprint, Footprints > Classes tab. Their clicks: Reads; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='ftz → Reads → Selected footprint → Footprints > Classes tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 2000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on any read to analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range and where it sits across the reads.', 'anchor': 'selected-footprint'},
           {'type': 'explain', 'text': 'Classes lists the recurring footprint classes here, with their sizes and matching motifs.', 'anchor': 'footprints-classes'},
       ]),


    # ── primers ─────────────────────────────────────────────────────

    _r(id='primer_config_set', category='primers',
       command='set primer Tm to 60 and length to 22',
       context=V_DM6_2R,
       thinking="Tm and length are design settings on the Primers panel's Design tab.",
       summary='Primers > Design settings: Tm 60, length 22',
       actions=[
           {'type': 'open_panel', 'panel_type': 'primer-design', 'tab': 'design'},
           {'type': 'explain', 'text': 'In the design settings, set the target Tm to 60 °C and the primer length to 22 nt; they apply to the next design.', 'anchor': 'primers-design-tab'},
       ]),

    _r(id='primer_design_at_gene', category='primers',
       command='design primers for the ftz TSS',
       context=V_DM6_3R,
       thinking='"design primers for the ftz TSS": I guide them through it rather than doing it. First I move the view to 2R:9,988,800. Then the controls in the order they\'d use them: Peaks track, Primers > Design tab, Design primers, Primers > Order List tab. Their clicks: Peaks track, Design primers; the steps after each wait until it has happened.',
       summary='2R:9,988,800 → Peaks track → Primers > Design tab → Design primers → Primers > Order List tab',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9988800, 'end': 9991200},
           {'type': 'try_it', 'text': 'Click the peak (or peaks) the primers should flank in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'The Design tab designs around the selected peaks, or the view if none are selected.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers; pairs are ranked by fit (and specificity when BLAST is set up).', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Save the pairs you like; the Order List exports them as an order sheet.', 'anchor': 'primers-order-tab'},
       ]),

    _r(id='primer_design_dafc', category='primers',
       command='design DAF-C anchor primers for the eve TSS',
       context=V_DM6_2R,
       thinking='"design DAF-C anchor primers for the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Peaks track, Primers > Design tab, Design primers, Primers > Order List tab. Their clicks: Peaks track, Design primers; the steps after each wait until it has happened.',
       summary='Peaks track → Primers > Design tab → Design primers → Primers > Order List tab',
       actions=[
           {'type': 'try_it', 'text': 'Click the peak (or peaks) the primers should flank in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'The Design tab designs around the selected peaks, or the view if none are selected. Set the mode to DAF-C to design primers for both ends of a contact.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers; pairs are ranked by fit (and specificity when BLAST is set up).', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Save the pairs you like; the Order List exports them as an order sheet.', 'anchor': 'primers-order-tab'},
       ]),

    _r(id='primer_design_4c', category='primers',
       command='design 4C primers for the eve enhancer at 2R:9975000-9975200',
       context=V_DM6_2R,
       thinking='"design 4C primers for the eve enhancer at 2R:9975000-9975200": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Peaks track, Primers > Design tab, Design primers, Primers > Order List tab. Their clicks: Peaks track, Design primers; the steps after each wait until it has happened.',
       summary='Peaks track → Primers > Design tab → Design primers → Primers > Order List tab',
       actions=[
           {'type': 'try_it', 'text': 'Click the peak (or peaks) the primers should flank in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'The Design tab designs around the selected peaks, or the view if none are selected. Set the mode to 4C for inverse-PCR primers from a viewpoint.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers; pairs are ranked by fit (and specificity when BLAST is set up).', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Save the pairs you like; the Order List exports them as an order sheet.', 'anchor': 'primers-order-tab'},
       ]),

    _r(id='primer_list', category='primers',
       command='list saved primers',
       phrasings=[
           'show my primer cart',
       ],
       context=V_DM6_2R,
       thinking='"list saved primers": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Primers > Order List tab.',
       summary='Primers > Order List tab',
       actions=[
           {'type': 'explain', 'text': 'Your saved primers are in the Order List, ready to export as an order sheet.', 'anchor': 'primers-order-tab'},
       ]),

    _r(id='primer_clear', category='primers',
       command='clear the primer order list',
       phrasings=[
           'clear my primer cart',
       ],
       context=V_DM6_2R,
       thinking='"clear the primer order list": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Primers > Order List tab.',
       summary='Primers > Order List tab',
       actions=[
           {'type': 'explain', 'text': 'In the Order List, Clear removes every saved primer.', 'anchor': 'primers-order-tab'},
       ]),


    # ── track_browser ───────────────────────────────────────────────

    _r(id='ucsc_curated', category='track_browser',
       command='show UCSC curated tracks for dm6',
       phrasings=[
           'browse UCSC group regulation in dm6',
       ],
       context=V_DM6_2R,
       thinking='"show UCSC curated tracks for dm6": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Browse hubs lists the UCSC tracks for the current genome.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Tick a track to add it to the view.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='ucsc_search', category='track_browser',
       command='search UCSC for cage tracks in dm6',
       context=V_DM6_2R,
       thinking='"search UCSC for cage tracks in dm6": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Browse hubs lists the UCSC tracks for the current genome; type cage in its search box to narrow them.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Tick a track to add it to the view.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='encode_facets', category='track_browser',
       command='show ENCODE search facets',
       context=V_HG38_TP53,
       thinking='"show ENCODE search facets": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Browse hubs lists the ENCODE tracks for the current genome.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Tick a track to add it to the view.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='encode_search_chip_seq', category='track_browser',
       command='find ENCODE TF ChIP-seq tracks for K562',
       context=V_HG38_TP53,
       thinking='"find ENCODE TF ChIP-seq tracks for K562": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Browse hubs lists the ENCODE tracks for the current genome; type K562 in its search box to narrow them.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Tick a track to add it to the view.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='chipatlas_facets_dm6', category='track_browser',
       command='ChIP-Atlas facets for dm6',
       context=V_DM6_2R,
       thinking='"ChIP-Atlas facets for dm6": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Browse hubs lists the ChIP-Atlas tracks for the current genome.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Tick a track to add it to the view.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='catalog_browse', category='track_browser',
       command='show me the loaded track catalog',
       phrasings=[
           'list all loaded tracks',
           'add catalog track t-encode-k562-myc to my session',
       ],
       context=V_DM6_2R,
       thinking='"show me the loaded track catalog": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add a track file or URL.',
       summary='Add a track file or URL',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'The Tracks panel lists every loaded track; untick one to hide it or click × to remove it.', 'anchor': 'tracks-add-file'},
       ]),

    _r(id='tracks_remove', category='track_browser',
       command='remove track 3',
       context=V_DM6_2R,
       thinking='"remove track 3": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add a track file or URL.',
       summary='Add a track file or URL',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Click the × on the track you want to remove in the loaded list.', 'anchor': 'tracks-add-file'},
       ]),

    _r(id='tracks_reorder', category='track_browser',
       command='reorder tracks: put track 2 above track 0',
       context=V_DM6_2R,
       thinking='"reorder tracks: put track 2 above track 0": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Sub-track settings.',
       summary='Sub-track settings',
       actions=[
           {'type': 'explain', 'text': "Open the panel's sub-track settings and drag the tracks into the order you want.", 'anchor': 'panel-subtracks'},
       ]),

    _r(id='tracks_add_motif_pwm', category='track_browser',
       command='add a custom GAGA motif from a PWM matrix',
       context=V_DM6_2R,
       thinking='"add a custom GAGA motif from a PWM matrix": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'In the motif box, enter your PWM counts and name it GAGA; the threshold slider sets how strict matches are.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Click Add motif: its sites are drawn as a track.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='tracks_add_motif_sequence', category='track_browser',
       command="add a custom motif by sequence GAGAG with name 'GAGA'",
       context=V_DM6_2R,
       thinking='"add a custom motif by sequence GAGAG with name \'GAGA\'": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'In the motif box, enter the IUPAC sequence GAGAG and name it GAGA; the threshold slider sets how strict matches are.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Click Add motif: its sites are drawn as a track.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),


    # ── co_accessibility ────────────────────────────────────────────

    _r(id='coacc_slice_at_eve_tss', category='co_accessibility',
       command='virtual 4C from the co-accessibility matrix at the eve TSS',
       context=V_DM6_2R,
       thinking='"virtual 4C from the co-accessibility matrix at the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Co-accessibility matrix, Refresh co-accessibility.',
       summary='Co-accessibility matrix → Refresh co-accessibility',
       actions=[
           {'type': 'open_panel', 'panel_type': 'co-accessibility'},
           {'type': 'explain', 'text': 'Set the track mode to Virtual 4C and click a position (e.g. the TSS) to see what is co-accessible with it.', 'anchor': 'coacc-matrix'},
           {'type': 'explain', 'text': 'Refresh recomputes it after you move the view.', 'anchor': 'coacc-refresh'},
       ]),

    _r(id='coacc_arcs_threshold', category='co_accessibility',
       command='show only the strongest co-accessible pairs (threshold 0.5)',
       context=V_DM6_2R,
       thinking='"show only the strongest co-accessible pairs (threshold 0.5)": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Co-accessibility matrix, Refresh co-accessibility.',
       summary='Co-accessibility matrix → Refresh co-accessibility',
       actions=[
           {'type': 'open_panel', 'panel_type': 'co-accessibility'},
           {'type': 'explain', 'text': 'Set the track mode to Arcs: the most co-accessible pairs are drawn as arcs; raise the threshold to 0.5 to keep only the strongest.', 'anchor': 'coacc-matrix'},
           {'type': 'explain', 'text': 'Refresh recomputes it after you move the view.', 'anchor': 'coacc-refresh'},
       ]),

    _r(id='coacc_strip', category='co_accessibility',
       command='render the co-accessibility triangle strip',
       context=V_DM6_2R,
       thinking='"render the co-accessibility triangle strip": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Co-accessibility matrix, Refresh co-accessibility.',
       summary='Co-accessibility matrix → Refresh co-accessibility',
       actions=[
           {'type': 'open_panel', 'panel_type': 'co-accessibility'},
           {'type': 'explain', 'text': 'Set the track mode to Strip for the triangle view under the reads.', 'anchor': 'coacc-matrix'},
           {'type': 'explain', 'text': 'Refresh recomputes it after you move the view.', 'anchor': 'coacc-refresh'},
       ]),


    # ── session ─────────────────────────────────────────────────────

    _r(id='session_import_via_api', category='session',
       command='import a session from a previously exported payload',
       context=V_DM6_2R,
       thinking='Importing a session is the user opening the file; point at both ways.',
       summary='Load File (or Restore session) opens a saved session',
       actions=[
           {'type': 'try_it', 'text': 'Click Load File and choose the saved session (.json): it reloads the data, view, clusters and settings.', 'wait_for': 'dataset_loaded', 'anchor': 'load-dataset'},
           {'type': 'explain', 'text': 'Restore session in Data & Sessions does the same.', 'anchor': 'restore-session'},
       ]),


    # ── negative ────────────────────────────────────────────────────

    _r(id='negative_undo_via_api', category='negative',
       command='undo the last action',
       context=V_DM6_2R,
       thinking='Undo is a click; point at it and the timeline.',
       summary='Undo is yours to click',
       warnings=["Undo/redo lives in the browser's history. Use Cmd+Z, Undo in the top toolbar, or the timeline under ▾ next to it — Copilot has no action for it."],
       actions=[
           {'type': 'try_it', 'text': 'Click Undo (or press Cmd+Z).', 'wait_for': 'undo_used', 'anchor': 'undo'},
           {'type': 'explain', 'text': 'The ▾ next to it jumps back further.', 'anchor': 'history-timeline'},
       ]),

    _r(id='negative_save_named_cluster', category='negative',
       command="save the current cluster set as 'eve_TSS_v1'",
       context=V_DM6_2R,
       thinking='A named clustering is a Snapshot in the Clusters panel.',
       summary='Snapshot the clustering',
       warnings=["The Cluster Cart's named-save is a frontend action. The plan exports the full session so the cluster persists; use the GUI Clusters panel's 'Save' button to add a named entry."],
       actions=[
           {'type': 'explain', 'text': 'Click Snapshot in the Clusters panel and name it eve_TSS_v1.', 'anchor': 'cluster-snapshot', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': "It's listed in the Saved tab; click it to restore that clustering.", 'anchor': 'clusters-saved', 'requires': 'has_clusters'},
       ]),


    # ── sort ────────────────────────────────────────────────────────

    _r(id='sort_by_pol2', category='sort',
       command='sort reads by Pol II occupancy at the eve TSS',
       phrasings=[
           'sort reads by transcription state at the eve TSS',
       ],
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"sort reads by Pol II occupancy at the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add sort rule, Rules > Sort tab, Sort. Their clicks: Sort; the steps after each wait until it has happened.',
       summary='Add sort rule → Rules > Sort tab → Sort',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Sort, click Add sort rule and name it Paused Pol II first.', 'anchor': 'add-sort-rule'},
           {'type': 'explain', 'text': 'Give it a term for paused Pol II at the eve TSS, metric count, highest first. It then appears in the Sort dropdown.', 'anchor': 'rules-sort-tab'},
           {'type': 'try_it', 'text': 'Pick "Paused Pol II first" in the Sort dropdown and click Sort.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
       ]),

    _r(id='sort_by_position', category='sort',
       command='sort reads by start position',
       context=V_DM6_2R,
       thinking="No such sort exists; say so and point at the Sort dropdown's Default.",
       summary='No position sort; Default keeps alignment order',
       actions=[
           {'type': 'explain', 'text': "There's no sort by start position: reads keep their alignment order until you pick another sort here; Default returns to it.", 'anchor': 'sort-button'},
       ]),

    _r(id='sort_by_cluster', category='sort',
       command='sort reads by cluster assignment',
       context=V_DM6_2R,
       thinking='"sort reads by cluster assignment": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Sort. Their clicks: Sort; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Sort',
       actions=[
           {'type': 'try_it', 'text': 'Choose Similarity (cluster order) in the Sort dropdown and click Sort: reads are grouped by cluster, most similar together.', 'wait_for': 'sorted', 'anchor': 'sort-button', 'requires': 'has_clusters'},
       ]),

    _r(id='sort_clear', category='sort',
       command='clear the read sort',
       context=V_DM6_2R,
       thinking='"clear the read sort": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Sort.',
       summary='Sort',
       actions=[
           {'type': 'explain', 'text': 'Choose Default in the Sort dropdown to go back to the original read order.', 'anchor': 'sort-button'},
       ]),


    # ── quality ─────────────────────────────────────────────────────

    _r(id='qfilter_set_min_size', category='quality',
       command='set the minimum read span filter to 4 kb',
       context=V_DM6_2R,
       thinking='"set the minimum read span filter to 4 kb": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read Filters.',
       summary='Read Filters',
       actions=[
           {'type': 'explain', 'text': 'Set Min span to 4,000 bp: shorter reads are hidden.', 'anchor': 'read-filters'},
       ]),

    _r(id='qfilter_clear', category='quality',
       command='clear all quality filters',
       context=V_DM6_2R,
       thinking='"clear all quality filters": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read Filters.',
       summary='Read Filters',
       actions=[
           {'type': 'explain', 'text': 'In Read Filters, Reset clears every read-level filter.', 'anchor': 'read-filters'},
       ]),

    _r(id='qfilter_spanning_only', category='quality',
       command='only show reads that span the full viewport',
       phrasings=[
           'show only spanning reads',
           'only show reads that span the viewport',
           'hide partial reads',
           'filter to full-length reads',
       ],
       context=V_DM6_2R,
       thinking='"only show reads that span the full viewport": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Spanning only.',
       summary='Spanning only',
       actions=[
           {'type': 'explain', 'text': 'Tick Spanning only: just the reads that cover the whole view edge to edge.', 'anchor': 'spanning-toggle'},
       ]),


    # ── navigation ──────────────────────────────────────────────────

    _r(id='view_pan_left', category='navigation',
       command='pan left by half a screen',
       context=V_DM6_2R,
       thinking='"pan left by half a screen": moving the view is something I can do for them, so I navigate directly.',
       summary='Pan left',
       actions=[
           {'type': 'pan_view', 'direction': 'left'},
       ]),

    _r(id='view_pan_right', category='navigation',
       command='pan right by half a screen',
       context=V_DM6_2R,
       thinking='"pan right by half a screen": moving the view is something I can do for them, so I navigate directly.',
       summary='Pan right',
       actions=[
           {'type': 'pan_view', 'direction': 'right'},
       ]),

    _r(id='view_zoom_in_2x', category='navigation',
       command='zoom in 2x',
       context=V_DM6_2R,
       thinking='"zoom in 2x": moving the view is something I can do for them, so I navigate directly.',
       summary='Zoom in',
       actions=[
           {'type': 'zoom_view', 'direction': 'in', 'steps': 2},
       ]),

    _r(id='view_zoom_out_2x', category='navigation',
       command='zoom out 2x',
       context=V_DM6_2R,
       thinking='"zoom out 2x": moving the view is something I can do for them, so I navigate directly.',
       summary='Zoom out',
       actions=[
           {'type': 'zoom_view', 'direction': 'out', 'steps': 2},
       ]),

    _r(id='view_recenter_on_position', category='navigation',
       command='recenter on 2R:9974500',
       context=V_DM6_2R,
       thinking='"recenter on 2R:9974500": moving the view is something I can do for them, so I navigate directly.',
       summary='2R:9,969,500',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9969500, 'end': 9979500},
       ]),

    _r(id='view_genomes_list', category='navigation',
       command='list available genomes',
       context=V_DM6_2R,
       thinking='"list available genomes": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Genome list.',
       summary='Genome list',
       actions=[
           {'type': 'explain', 'text': 'The genome list has the bundled genomes (dm6, hg38, mm10, ...); picking one loads its reference and genes.', 'anchor': 'genome-selector'},
       ]),


    # ── peaks ───────────────────────────────────────────────────────

    _r(id='peak_rules_set', category='peaks',
       command='set the peak rule threshold percentile to 25',
       context=V_DM6_2R,
       thinking='The threshold is part of the peak rule; then they rescan.',
       summary='Peak rules: percentile 25, then Scan',
       actions=[
           {'type': 'explain', 'text': "Open the peak rules and set the rule's threshold percentile to 25.", 'anchor': 'peak-rules'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks with the new threshold.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
       ]),

    _r(id='peak_detect_at_gene', category='peaks',
       command='detect signal peaks at the eve TSS region',
       context=V_DM6_2R,
       thinking='"detect signal peaks at the eve TSS region": I guide them through it rather than doing it. First I move the view to 2R:9,973,000. Then the controls in the order they\'d use them: Scan. Their clicks: Scan; the steps after each wait until it has happened.',
       summary='2R:9,973,000 → Scan',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9973000, 'end': 9975000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
       ]),

    _r(id='peak_sync', category='peaks',
       command='sync peaks back to Jupyter',
       context=V_DM6_2R,
       thinking='Nothing to click: peaks reach the notebook on their own.',
       summary='Peaks sync automatically',
       actions=[
           {'type': 'explain', 'text': 'Peaks sync to Python automatically: in the notebook, client.get_peaks() returns the peaks drawn here.', 'anchor': 'peaks-track'},
       ]),


    # ── clustering ──────────────────────────────────────────────────

    _r(id='cluster_assign_to', category='clustering',
       command='reassign cluster 0 reads to cluster 1',
       context=V_DM6_2R,
       thinking='"reassign cluster 0 reads to cluster 1": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Their clicks: Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Tick clusters 0 and 1 in the list to select them.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'Then click Merge selected: their reads become one cluster.', 'wait_for': 'clusters_merged', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='cluster_auto_cull', category='clustering',
       command='auto-cull tiny clusters',
       context=V_DM6_2R,
       thinking='"auto-cull tiny clusters": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Merge similar clusters. Their clicks: Merge similar clusters; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Merge similar clusters',
       actions=[
           {'type': 'try_it', 'text': 'Click Merge similar clusters: tiny clusters and near-duplicates fold into their nearest cluster.', 'wait_for': 'clusters_merged', 'anchor': 'merge-similar', 'requires': 'has_clusters'},
       ]),

    _r(id='cluster_dissolve_one', category='clustering',
       command='dissolve cluster 3',
       context=V_DM6_2R,
       thinking='"dissolve cluster 3": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Right-click cluster 3 and choose Dissolve: its reads move to their nearest remaining cluster.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='cluster_expand', category='clustering',
       command='expand cluster 1 into sub-clusters',
       context=V_DM6_2R,
       thinking='"expand cluster 1 into sub-clusters": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, K, Clusters > Overview tab, Cluster, Cluster branch map. Their clicks: Cluster; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Cluster controls toggle → K → Clusters > Overview tab → Cluster → Cluster branch map',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set K to 3.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Tick cluster 1 to select it.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'With clusters selected, Cluster re-clusters only their reads, into a branch under the current clustering.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'The branch map shows the parent clustering and the new branch; click either to switch between them.', 'anchor': 'cluster-branches'},
       ]),

    _r(id='cluster_vplot', category='clustering',
       command='render a V-plot of the current clusters',
       context=V_DM6_2R,
       thinking='"render a V-plot of the current clusters": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > V-Plot tab. Where a control needs something first, the step asks for it.',
       summary='Clusters > V-Plot tab',
       actions=[
           {'type': 'explain', 'text': 'The V-Plot tab plots footprint size against position for each cluster.', 'anchor': 'clusters-vplot', 'requires': 'has_clusters'},
       ]),

    _r(id='cluster_projection', category='clustering',
       command='project clusters to 2D for visualization',
       context=V_DM6_2R,
       thinking='"project clusters to 2D for visualization": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Projection tab. Where a control needs something first, the step asks for it.',
       summary='Clusters > Projection tab',
       actions=[
           {'type': 'explain', 'text': 'The Projection tab places each read in 2-D by its features, coloured by cluster.', 'anchor': 'clusters-projection', 'requires': 'has_clusters'},
       ]),


    # ── motifs ──────────────────────────────────────────────────────

    _r(id='motif_search_at_window', category='motifs',
       command='search for motifs in 2R:9974600-9974680',
       context=V_DM6_2R,
       thinking='"search for motifs in 2R:9974600-9974680": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint 2R:9,974,600-9,974,680.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),


    # ── settings ────────────────────────────────────────────────────

    _r(id='settings_set_accessibility_threshold', category='settings',
       command='set the accessibility threshold to 0.7',
       phrasings=[
           'set the accessibility threshold to 70',
           'raise the FIRE accessibility cutoff to 70',
           'make accessibility stricter — threshold 70',
           'only call accessible where score is at least 70',
       ],
       context=V_DM6_2R,
       thinking='"set the accessibility threshold to 0.7": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Cluster toolbar group.',
       summary='Cluster controls toggle → Cluster toolbar group',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set the accessibility threshold (the % box next to K) to 70%: the share of bases that must be open to call a peak open.', 'anchor': 'cluster-toolbar'},
       ]),

    _r(id='settings_set_sample_count', category='settings',
       command='cap analysis sampling at 2000 reads',
       context=V_DM6_2R,
       thinking='"cap analysis sampling at 2000 reads": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reproducibility.',
       summary='Reproducibility',
       actions=[
           {'type': 'explain', 'text': 'Set the sample size to 2000 reads: clustering and profiles use at most that many.', 'anchor': 'reproducibility'},
       ]),


    # ── sequences ───────────────────────────────────────────────────

    _r(id='sequence_at_window', category='sequences',
       command='give me the FASTA sequence at 2R:9974600-9974680',
       context=V_DM6_2R,
       thinking='"give me the FASTA sequence at 2R:9974600-9974680": I guide them through it rather than doing it. First I move the view to 2R:9,974,600. Then the controls in the order they\'d use them: Add capture region, Capture > Export tab.',
       summary='2R:9,974,600 → Add capture region → Capture > Export tab',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9974600, 'end': 9974680},
           {'type': 'explain', 'text': 'Click Add capture region to add this view.', 'anchor': 'capture-add-region'},
           {'type': 'explain', 'text': 'Capture > Export saves the regions as FASTA (the sequence comes from the loaded reference).', 'anchor': 'capture-export'},
       ]),

    _r(id='sequence_at_eve_tss_region', category='sequences',
       command='get the sequence for the eve TSS +/- 200 bp',
       context=V_DM6_2R,
       thinking='"get the sequence for the eve TSS +/- 200 bp": I guide them through it rather than doing it. First I move the view to 2R:9,973,800. Then the controls in the order they\'d use them: Add capture region, Capture > Export tab.',
       summary='2R:9,973,800 → Add capture region → Capture > Export tab',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9973800, 'end': 9974200},
           {'type': 'explain', 'text': 'Click Add capture region to add this view.', 'anchor': 'capture-add-region'},
           {'type': 'explain', 'text': 'Capture > Export saves the regions as FASTA (the sequence comes from the loaded reference).', 'anchor': 'capture-export'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_pol2_workflow', category='multi_step',
       command='navigate to eve, set the analysis seed to 7, lock peaks, and compute Pol II COM',
       context=V_DM6_2L,
       state_overrides={'selected_gene': 'eve'},
       thinking="Navigate to eve, then the seed, lock and the Transcription panel's Pol II COM view, which needs eve selected.",
       summary='eve, seed 7, lock peaks, Pol II COM',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Set the sampling seed to 7 so the same reads are used every run.', 'anchor': 'reproducibility'},
           {'type': 'explain', 'text': 'Lock the peaks so they stay put.', 'anchor': 'peaks-lock'},
           {'type': 'explain', 'text': "Click eve in the gene track to select it; the Transcription panel's Pol II COM tab shows where Pol II sits along it.", 'panel_type': 'transcription-state', 'tab': 'pol2com', 'requires': 'has_selected_gene'},
       ]),

    _r(id='multi_open_tss_then_motifs', category='multi_step',
       command='filter to reads with an open eve TSS and tell me what motifs they overlap at the TSS',
       context=V_DM6_2R,
       thinking='"filter to reads with an open eve TSS and tell me what motifs they overlap at the TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Filter, Reads, Footprints > Classes tab, Browse hubs. Their clicks: Scan, Peaks track, Filter, Reads; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Filter → Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Choose Open at selected peaks in the Filter dropdown and click Filter: only reads with that site open stay.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='multi_dafc_at_two_genes', category='multi_step',
       command='DAF-C views at eve and ftz',
       context=V_DM6_2R,
       thinking='"DAF-C views at eve and ftz": I guide them through it rather than doing it. First I move the view to eve. Then the controls in the order they\'d use them: Contacts > Map tab.',
       summary='eve → Contacts > Map tab → ftz → Contacts > Map tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'open_panel', 'panel_type': 'contact-map', 'tab': 'map'},
           {'type': 'explain', 'text': 'The Map tab shows the contact matrix for the current view; the export button saves it as an image or data.', 'anchor': 'contacts-map'},
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'The map follows the view, so it now shows the contacts here.', 'anchor': 'contacts-map'},
       ]),

    _r(id='multi_annotation_threshold_then_filter', category='multi_step',
       command='set the FiberCNN-TF threshold to 0.8 and filter reads above it',
       context=V_DM6_2R,
       thinking='"set the FiberCNN-TF threshold to 0.8 and filter reads above it": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Annotations > Filter tab. Their clicks: Annotations > Filter tab; the steps after each wait until it has happened.',
       summary='Annotations > types → Annotations > Filter tab',
       actions=[
           {'type': 'explain', 'text': "On the Annotations panel's Types tab, set the FiberCNN-TF threshold to 0.8: calls scored below it are ignored.", 'panel_type': 'annotations', 'tab': 'types'},
           {'type': 'explain', 'text': 'On the Filter tab, choose FiberCNN-TF with Has Any.', 'anchor': 'annotations-filter'},
           {'type': 'try_it', 'text': 'Click Apply: only reads carrying it stay.', 'wait_for': 'filter_applied', 'anchor': 'annotations-filter'},
       ]),

    _r(id='multi_capture_workflow', category='multi_step',
       command='add eve TSS and ftz TSS as capture regions and export the session',
       context=V_DM6_3R,
       thinking='"add eve TSS and ftz TSS as capture regions and export the session": I guide them through it rather than doing it. First I move the view to 2R:9,973,900. Then the controls in the order they\'d use them: Add capture region, Save. Their clicks: Save; the steps after each wait until it has happened.',
       summary='2R:9,973,900 → Add capture region → 2R:9,989,900 → Add capture region → Save',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9973900, 'end': 9974100},
           {'type': 'explain', 'text': 'Click Add capture region to add the view.', 'anchor': 'capture-add-region'},
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9989900, 'end': 9990100},
           {'type': 'explain', 'text': 'Click Add capture region to add the view.', 'anchor': 'capture-add-region'},
           {'type': 'try_it', 'text': 'Click Save in the top bar: it downloads a session file with the view, datasets, clusters, rules and colours; Load File reopens it.', 'wait_for': 'session_saved', 'anchor': 'save-session'},
       ]),

    _r(id='multi_quality_filter_then_cluster', category='multi_step',
       command='restrict to reads spanning the viewport and cluster on the eve TSS peak',
       context=V_DM6_2R,
       thinking='"restrict to reads spanning the viewport and cluster on the eve TSS peak": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Spanning only, Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Spanning only → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Tick Spanning only: just the reads that cover the whole view edge to edge.', 'anchor': 'spanning-toggle'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='multi_full_eve_inspection', category='multi_step',
       command='full inspection at eve: navigate, scan, footprint analyze, motif overlaps, render PNG',
       context=V_DM6_2L,
       thinking='"full inspection at eve: navigate, scan, footprint analyze, motif overlaps, render PNG": I guide them through it rather than doing it. First I move the view to eve. Then the controls in the order they\'d use them: Scan, Reads, Selected footprint, Footprints > Classes tab, Browse hubs, Export. Their clicks: Scan, Reads; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='eve → Scan → Reads → Selected footprint → Footprints > Classes tab → Reads',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on any read to analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range and where it sits across the reads.', 'anchor': 'selected-footprint'},
           {'type': 'explain', 'text': 'Classes lists the recurring footprint classes here, with their sizes and matching motifs.', 'anchor': 'footprints-classes'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'explain', 'text': 'Click Export in the top bar and choose PNG: it saves the view as you see it, including panel copies.', 'anchor': 'export-figure'},
       ]),


    # ── settings ────────────────────────────────────────────────────

    _r(id='set_cluster_k_3', category='settings',
       command='set k to 3 for clustering',
       context=V_DM6_2R,
       thinking='"set k to 3 for clustering": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, K.',
       summary='Cluster controls toggle → K',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set K to 3.', 'anchor': 'cluster-k'},
       ]),

    _r(id='set_cluster_k_5', category='settings',
       command='use k=5 for clustering',
       context=V_DM6_2R,
       thinking='"use k=5 for clustering": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, K.',
       summary='Cluster controls toggle → K',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set K to 5.', 'anchor': 'cluster-k'},
       ]),

    _r(id='set_cluster_method_kmeans', category='settings',
       command='switch to kmeans clustering',
       phrasings=[
           'switch the cluster mode to kmeans',
           'use k-means clustering',
           'switch to KMeans',
           'change the cluster method to k means',
       ],
       context=V_DM6_2R,
       thinking='"switch to kmeans clustering": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method.',
       summary='Cluster controls toggle → Clustering method',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
       ]),

    _r(id='set_cluster_method_combinatorial', category='settings',
       command='use combinatorial clustering',
       context=V_DM6_2R,
       thinking='"use combinatorial clustering": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method.',
       summary='Cluster controls toggle → Clustering method',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose Combinatorial in the method dropdown. K-means needs a K; Combinatorial and HDBSCAN pick the number of clusters themselves.', 'anchor': 'cluster-method'},
       ]),

    _r(id='set_cluster_method_hierarchical', category='settings',
       command='use hierarchical clustering',
       phrasings=[
           'use hierarchical clustering instead',
           'switch to hierarchical clustering',
           'use agglomerative clustering',
           'set cluster mode to hierarchical',
           'switch the cluster method to hierarchical',
       ],
       context=V_DM6_2R,
       thinking='"use hierarchical clustering": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method.',
       summary='Cluster controls toggle → Clustering method',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose Hierarchical in the method dropdown.', 'anchor': 'cluster-method'},
       ]),

    _r(id='set_cluster_method_typed_hdbscan', category='settings',
       command='cluster with hdbscan',
       phrasings=[
           'use density based clustering',
           'switch the cluster method to HDBSCAN',
       ],
       context=V_DM6_2R,
       thinking='"cluster with hdbscan": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method.',
       summary='Cluster controls toggle → Clustering method',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose HDBSCAN in the method dropdown. K-means needs a K; Combinatorial and HDBSCAN pick the number of clusters themselves.', 'anchor': 'cluster-method'},
       ]),

    _r(id='set_cluster_k_typed_4', category='settings',
       command='use 4 clusters',
       phrasings=[
           'set k to 4',
           'I want 4 clusters',
           'n_clusters = 4',
       ],
       context=V_DM6_2R,
       thinking='"use 4 clusters": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, K.',
       summary='Cluster controls toggle → K',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set K to 4.', 'anchor': 'cluster-k'},
       ]),

    _r(id='set_cluster_method_and_k_combo', category='settings',
       command='use k-means with k=6 and cluster',
       phrasings=[
           'switch to kmeans with 6 clusters and run it',
           'set k-means k=6 then cluster the selected peaks',
       ],
       context=V_DM6_2R,
       thinking='"use k-means with k=6 and cluster": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Scan, Peaks track, Cluster. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Cluster controls toggle → Clustering method → K → Scan → Peaks track → Cluster',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 6.', 'anchor': 'cluster-k'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── clustering ──────────────────────────────────────────────────

    _r(id='cluster_on_accessibility_default', category='clustering',
       command='cluster reads in this window by accessibility',
       phrasings=[
           'cluster the reads by their accessibility',
           'cluster on the FIRE rule',
           'cluster using the default accessibility rule',
           'cluster reads by their open/closed pattern',
           'cluster reads by accessibility',
           'cluster on accessibility',
           'cluster using the default FIRE rule',
           'group reads by how open they are',
       ],
       context=V_DM6_2R,
       thinking='"cluster reads in this window by accessibility": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── settings ────────────────────────────────────────────────────

    _r(id='set_accessibility_threshold', category='settings',
       command='set accessibility threshold to 0.6',
       phrasings=[
           'raise the accessibility threshold to 60%',
           'use 60% as the accessibility cutoff',
           'set min accessibility to 60',
       ],
       context=V_DM6_2R,
       thinking='"set accessibility threshold to 0.6": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Cluster toolbar group.',
       summary='Cluster controls toggle → Cluster toolbar group',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set the accessibility threshold (the % box next to K) to 60%: the share of bases that must be open to call a peak open.', 'anchor': 'cluster-toolbar'},
       ]),

    _r(id='set_sample_count_500', category='settings',
       command='cap analysis sampling to 500 reads',
       context=V_DM6_2R,
       thinking='"cap analysis sampling to 500 reads": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reproducibility.',
       summary='Reproducibility',
       actions=[
           {'type': 'explain', 'text': 'Set the sample size to 500 reads: clustering and profiles use at most that many.', 'anchor': 'reproducibility'},
       ]),

    _r(id='set_click_layer_tf', category='settings',
       command='make TF the click target layer',
       context=V_DM6_2R,
       thinking='"make TF the click target layer": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Footprints > Classes tab.',
       summary='Footprints > Classes tab',
       actions=[
           {'type': 'explain', 'text': 'In the Footprints panel, set Click target to TF: Cmd/Ctrl+click then picks TF calls.', 'anchor': 'footprints-classes'},
       ]),

    _r(id='set_two_settings', category='settings',
       command='set k to 4 and use kmeans method',
       context=V_DM6_2R,
       thinking='"set k to 4 and use kmeans method": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K.',
       summary='Cluster controls toggle → Clustering method → K',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 4.', 'anchor': 'cluster-k'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='set_k_then_cluster_eve', category='multi_step',
       command='cluster on the eve TSS peak with k=5',
       context=V_DM6_2R,
       thinking='"cluster on the eve TSS peak with k=5": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, K, Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Cluster controls toggle → K → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set K to 5.', 'anchor': 'cluster-k'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='set_k_method_then_cluster', category='multi_step',
       command='use combinatorial clustering with k=4 on the bcd TSS',
       context=V_DM6_2R,
       thinking='"use combinatorial clustering with k=4 on the bcd TSS": I guide them through it rather than doing it. First I move the view to bcd. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Scan, Peaks track, Cluster. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='bcd → Cluster controls toggle → Clustering method → K → Scan → Peaks track',
       actions=[
           {'type': 'navigate_gene', 'gene': 'bcd', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose Combinatorial in the method dropdown. K-means needs a K; Combinatorial and HDBSCAN pick the number of clusters themselves.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 4.', 'anchor': 'cluster-k'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the bcd TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='set_seed_then_full_repro', category='multi_step',
       command='lock seed at 7, lock peaks, and cluster on the eve TSS',
       context=V_DM6_2R,
       thinking='"lock seed at 7, lock peaks, and cluster on the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reproducibility, Lock peaks, Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Reproducibility → Lock peaks → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Set the sampling seed to 7: clustering and profiles then pick the same reads every run.', 'anchor': 'reproducibility'},
           {'type': 'explain', 'text': 'Click the lock to freeze these peaks, so navigating or re-scanning keeps the same set.', 'anchor': 'peaks-lock'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── gene_context ────────────────────────────────────────────────

    _r(id='ctx_label_this_gene_tss', category='gene_context',
       command='label the TF footprint at -100 from the TSS green',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"label the TF footprint at -100 from the TSS green": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 100 bp upstream of the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='ctx_cluster_this_gene', category='gene_context',
       command='cluster on the TSS peak',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'ftz'},
       thinking='"cluster on the TSS peak": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='ftz → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the ftz TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='ctx_motifs_at_this_tss', category='gene_context',
       command='what motifs are at the TSS',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'sna'},
       thinking='"what motifs are at the TSS": I guide them through it rather than doing it. First I move the view to sna. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='sna → Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'navigate_gene', 'gene': 'sna', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint at the sna TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='ctx_label_pol2_at_this_gene', category='gene_context',
       command='recolor only Pol II footprints at the TSS in cyan',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'ftz'},
       thinking='"recolor only Pol II footprints at the TSS in cyan": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='ftz → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Click ftz in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the ftz TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 35-65 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to cyan.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='ctx_select_peak_at_this_tss', category='gene_context',
       command='select the peak at the TSS',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'Ubx'},
       thinking='"select the peak at the TSS": I guide them through it rather than doing it. First I move the view to Ubx. Then the controls in the order they\'d use them: Scan, Peaks track. Their clicks: Scan, Peaks track; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Ubx → Scan → Peaks track',
       actions=[
           {'type': 'navigate_gene', 'gene': 'Ubx', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the Ubx TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
       ]),

    _r(id='ctx_set_k_then_cluster_this', category='gene_context',
       command='set k to 6 and cluster on the TSS peak',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"set k to 6 and cluster on the TSS peak": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, K, Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Cluster controls toggle → K → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set K to 6.', 'anchor': 'cluster-k'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='ctx_motifs_upstream_of_this', category='gene_context',
       command='show motifs 200 bp upstream of the TSS',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'bcd'},
       thinking='"show motifs 200 bp upstream of the TSS": I guide them through it rather than doing it. First I move the view to bcd. Then the controls in the order they\'d use them: Reads, Footprints > Classes tab, Browse hubs. Their clicks: Reads; the steps after each wait until it has happened.',
       summary='bcd → Reads → Footprints > Classes tab → Browse hubs',
       actions=[
           {'type': 'navigate_gene', 'gene': 'bcd', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click the footprint 200 bp upstream of the bcd TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view instead, load a JASPAR motif track from the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='ctx_label_red_around_this', category='gene_context',
       command='paint the +1 nucleosome red',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'ftz'},
       thinking='"paint the +1 nucleosome red": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='ftz → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Click ftz in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a nucleosome footprint 200 bp downstream of the ftz TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 90-250 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to red.', 'anchor': 'footprints-saved'},
       ]),


    # ── multi_turn ──────────────────────────────────────────────────

    _r(id='turn_redo_with_different_k', category='multi_turn',
       command='do that again with k=7',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       previous_turns=[{'text': 'cluster on the eve TSS peak', 'summary': 'Scan → Peaks track → Cluster → Clusters > Overview tab', 'actions': [{'type': 'try_it', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'}, {'type': 'try_it', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'}, {'type': 'try_it', 'wait_for': 'clustered', 'anchor': 'cluster-button'}, {'type': 'explain', 'anchor': 'clusters-overview'}]}],
       thinking='"do that again with k=7": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, K, Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Cluster controls toggle → K → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set K to 7.', 'anchor': 'cluster-k'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='turn_redo_at_other_gene', category='multi_turn',
       command='now do the same at ftz',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       previous_turns=[{'text': 'label the TF footprint at -100 from the eve TSS green', 'summary': 'TSS-relative coordinates → Reads → Save (this footprint) → Footprints > Saved tab', 'actions': [{'type': 'explain', 'anchor': 'relative-coords'}, {'type': 'try_it', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'}, {'type': 'try_it', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'}, {'type': 'explain', 'anchor': 'footprints-saved'}]}],
       thinking='"now do the same at ftz": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='ftz → TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'Click ftz in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 100 bp upstream of the ftz TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='turn_change_color_of_last_label', category='multi_turn',
       command='actually make it red instead',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       previous_turns=[{'text': 'label the TF footprint at the eve TSS green', 'summary': 'TSS-relative coordinates → Reads → Save (this footprint) → Footprints > Saved tab', 'actions': [{'type': 'explain', 'anchor': 'relative-coords'}, {'type': 'try_it', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'}, {'type': 'try_it', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'}, {'type': 'explain', 'anchor': 'footprints-saved'}]}],
       thinking='"actually make it red instead": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint at the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to red.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='turn_zoom_out', category='multi_turn',
       command='zoom out 2x',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       previous_turns=[{'text': 'navigate to eve', 'summary': 'eve', 'actions': [{'type': 'navigate_gene', 'gene': 'eve'}]}],
       thinking='"zoom out 2x": moving the view is something I can do for them, so I navigate directly.',
       summary='Zoom out',
       actions=[
           {'type': 'zoom_view', 'direction': 'out', 'steps': 2},
       ]),

    _r(id='turn_continue_workflow', category='multi_turn',
       command='now scan peaks and cluster',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       previous_turns=[{'text': 'navigate to eve +/- 5kb', 'summary': 'eve', 'actions': [{'type': 'navigate_gene', 'gene': 'eve'}]}],
       thinking='"now scan peaks and cluster": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='turn_apply_same_color_elsewhere', category='multi_turn',
       command='put the same green label at +100',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       previous_turns=[{'text': 'label the TF footprint at -100 green', 'summary': 'TSS-relative coordinates → Reads → Save (this footprint) → Footprints > Saved tab', 'actions': [{'type': 'explain', 'anchor': 'relative-coords'}, {'type': 'try_it', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'}, {'type': 'try_it', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'}, {'type': 'explain', 'anchor': 'footprints-saved'}]}],
       thinking='"put the same green label at +100": I guide them through it rather than doing it. Then the controls in the order they\'d use them: TSS-relative coordinates, Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened.',
       summary='TSS-relative coordinates → Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'Click eve in the gene track to select it, then turn on TSS-relative coordinates: the axis counts bp from its TSS.', 'anchor': 'relative-coords'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint 100 bp downstream of the eve TSS.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range; set it to 1-89 bp so only footprints like it match.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save: the footprint is kept as a definition and coloured on every read that carries it.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, set its colour to green.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='turn_undo_via_color_change', category='multi_turn',
       command='undo that',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       previous_turns=[{'text': 'label the TF footprint at the eve TSS green', 'summary': 'TSS-relative coordinates → Reads → Save (this footprint) → Footprints > Saved tab', 'actions': [{'type': 'explain', 'anchor': 'relative-coords'}, {'type': 'try_it', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'}, {'type': 'try_it', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'}, {'type': 'explain', 'anchor': 'footprints-saved'}]}],
       thinking='Undoing the last label: Undo, or remove the saved footprint.',
       summary='Undo, or delete the saved footprint',
       warnings=["Undo lives in the browser's history slice (Cmd+Z). Copilot has no API to drive it."],
       actions=[
           {'type': 'try_it', 'text': 'Click Undo (Cmd+Z) to take the label back.', 'wait_for': 'undo_used', 'anchor': 'undo'},
           {'type': 'explain', 'text': 'Or delete that saved footprint in the Saved tab.', 'anchor': 'footprints-saved', 'requires': 'has_saved_footprints'},
       ]),

    _r(id='turn_carry_seed_forward', category='multi_turn',
       command='run it again',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve', 'analysis_sample_seed': 42},
       previous_turns=[{'text': 'cluster eve with seed 42', 'summary': 'Scan → Peaks track → Cluster → Clusters > Overview tab', 'actions': [{'type': 'try_it', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'}, {'type': 'try_it', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'}, {'type': 'try_it', 'wait_for': 'clustered', 'anchor': 'cluster-button'}, {'type': 'explain', 'anchor': 'clusters-overview'}]}],
       thinking='"run it again": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── analysis_rules ──────────────────────────────────────────────

    _r(id='analysis_rules_list', category='analysis_rules',
       command='show me my analysis rules',
       context=V_DM6_2R,
       thinking="Rules are listed on the Rules panel's three tabs.",
       summary='Rules panel tabs',
       actions=[
           {'type': 'explain', 'text': 'Your cluster rules are here; the Sort and Filter tabs list the others.', 'anchor': 'rules-cluster-tab'},
       ]),

    _r(id='filter_by_tf_count_in_gene', category='analysis_rules',
       command='filter to reads with at least 3 TF footprints in this gene',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"filter to reads with at least 3 TF footprints in this gene": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add filter rule, Filter. Their clicks: Filter; the steps after each wait until it has happened.',
       summary='Add filter rule → Filter',
       actions=[
           {'type': 'explain', 'text': 'Make a filter rule in Rules > Filter keeping reads with at least 3 TF footprints (1-89 bp) in eve.', 'anchor': 'add-filter-rule'},
           {'type': 'try_it', 'text': 'Pick it in the Filter dropdown and click Filter.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),

    _r(id='filter_by_nuc_occupancy', category='analysis_rules',
       command='filter to reads where nucleosome occupancy is above 0.5 in the current window',
       context=V_DM6_3R,
       thinking='"filter to reads where nucleosome occupancy is above 0.5 in the current window": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add filter rule, Filter. Their clicks: Filter; the steps after each wait until it has happened.',
       summary='Add filter rule → Filter',
       actions=[
           {'type': 'explain', 'text': 'Make a filter rule in Rules > Filter keeping reads with nucleosome occupancy at least 0.5.', 'anchor': 'add-filter-rule'},
           {'type': 'try_it', 'text': 'Pick it in the Filter dropdown and click Filter.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),

    _r(id='sort_by_tf_count_descending', category='analysis_rules',
       command='sort reads by number of TF footprints, most first',
       context=V_DM6_2R,
       thinking='"sort reads by number of TF footprints, most first": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add sort rule, Sort. Their clicks: Sort; the steps after each wait until it has happened.',
       summary='Add sort rule → Sort',
       actions=[
           {'type': 'explain', 'text': 'Make a sort rule in Rules > Sort: TF footprints, metric count, highest first.', 'anchor': 'add-sort-rule'},
           {'type': 'try_it', 'text': 'Pick it in the Sort dropdown and click Sort.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
       ]),

    _r(id='sort_by_nuc_fp_rate', category='analysis_rules',
       command='sort by nucleosome occupancy rate',
       context=V_DM6_2L,
       thinking='"sort by nucleosome occupancy rate": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add sort rule, Sort. Their clicks: Sort; the steps after each wait until it has happened.',
       summary='Add sort rule → Sort',
       actions=[
           {'type': 'explain', 'text': 'Make a sort rule in Rules > Sort: nucleosome footprints, metric rate, highest first.', 'anchor': 'add-sort-rule'},
           {'type': 'try_it', 'text': 'Pick it in the Sort dropdown and click Sort.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
       ]),

    _r(id='cluster_by_saved_feature_rule', category='analysis_rules',
       command='cluster reads using my TF-footprint rule across selected peaks',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"cluster reads using my TF-footprint rule across selected peaks": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Cluster toolbar group, Scan, Peaks track. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Cluster controls toggle → Clustering method → K → Cluster toolbar group → Scan → Peaks track',
       warnings=['Pass the actual saved rule id and body from the Rules panel; the stub above is illustrative.'],
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 4.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Pick the cluster rule "TF footprints" (TF footprints 1-89 bp at the selected peaks) in the features dropdown; make it in Rules > Cluster if it doesn\'t exist yet.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── transcription_state ─────────────────────────────────────────

    _r(id='filter_by_pause_state', category='transcription_state',
       command='show me only paused reads at eve',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"show me only paused reads at eve": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Transcription > Filters tab. Their clicks: Transcription > Filters tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Transcription > Filters tab',
       actions=[
           {'type': 'explain', 'text': 'Select the gene first (click it in the gene track).', 'anchor': 'transcription-filters', 'requires': 'has_selected_gene'},
           {'type': 'try_it', 'text': "In the Transcription panel's Filters tab, choose paused and click Apply: only paused reads stay.", 'wait_for': 'filter_applied', 'anchor': 'transcription-filters', 'requires': 'has_selected_gene'},
       ]),

    _r(id='filter_by_elongating_state', category='transcription_state',
       command='filter to elongating reads',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"filter to elongating reads": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Transcription > Filters tab. Their clicks: Transcription > Filters tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Transcription > Filters tab',
       actions=[
           {'type': 'explain', 'text': 'Select the gene first (click it in the gene track).', 'anchor': 'transcription-filters', 'requires': 'has_selected_gene'},
           {'type': 'try_it', 'text': "In the Transcription panel's Filters tab, choose elongating and click Apply: only elongating reads stay.", 'wait_for': 'filter_applied', 'anchor': 'transcription-filters', 'requires': 'has_selected_gene'},
       ]),

    _r(id='sort_by_pic_state', category='transcription_state',
       command='sort reads by PIC state at sna',
       context=V_DM6_2L,
       state_overrides={'selected_gene': 'sna'},
       thinking='"sort reads by PIC state at sna": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Transcription > Filters tab, Sort. Their clicks: Sort; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Transcription > Filters tab → Sort',
       actions=[
           {'type': 'explain', 'text': 'Select the gene (click it in the gene track), then in the Transcription panel choose PIC as the state.', 'anchor': 'transcription-filters', 'requires': 'has_selected_gene'},
           {'type': 'try_it', 'text': 'Choose Transcription state in the Sort dropdown and click Sort: PIC reads go to the top.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
       ]),

    _r(id='sort_by_hyperburst', category='transcription_state',
       command='sort by hyperbursting reads first',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='Hyperburst no longer exists; point at the sorts that do.',
       summary='Hyperburst was removed; sort by a Pol II state',
       actions=[
           {'type': 'explain', 'text': 'The hyperburst state was removed; Pol II states are pause, PIC and elongating. Pick Transcription state in the Sort dropdown and choose one of those.', 'anchor': 'sort-button'},
       ]),


    # ── primer_cart ─────────────────────────────────────────────────

    _r(id='design_primers_snapgene_tm', category='primer_cart',
       command='design primers for this region using SnapGene Tm',
       context=V_DM6_2R,
       thinking='"design primers for this region using SnapGene Tm": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Peaks track, Primers > Design tab, Design primers, Primers > Order List tab. Their clicks: Peaks track, Design primers; the steps after each wait until it has happened.',
       summary='Peaks track → Primers > Design tab → Design primers → Primers > Order List tab',
       actions=[
           {'type': 'try_it', 'text': 'Click the peak (or peaks) the primers should flank in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'The Design tab designs around the selected peaks, or the view if none are selected.', 'anchor': 'primers-design-tab'},
           {'type': 'explain', 'text': 'In the design settings, set Tm method snapgene and tandem-repeat check on.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers; pairs are ranked by fit (and specificity when BLAST is set up).', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Save the pairs you like; the Order List exports them as an order sheet.', 'anchor': 'primers-order-tab'},
       ]),

    _r(id='design_primers_no_repeats', category='primer_cart',
       command='design primers but allow tandem repeats',
       context=V_DM6_2R,
       thinking='"design primers but allow tandem repeats": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Peaks track, Primers > Design tab, Design primers, Primers > Order List tab. Their clicks: Peaks track, Design primers; the steps after each wait until it has happened.',
       summary='Peaks track → Primers > Design tab → Design primers → Primers > Order List tab',
       actions=[
           {'type': 'try_it', 'text': 'Click the peak (or peaks) the primers should flank in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'The Design tab designs around the selected peaks, or the view if none are selected.', 'anchor': 'primers-design-tab'},
           {'type': 'explain', 'text': 'In the design settings, set Tm method primer3 and tandem-repeat check off.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers; pairs are ranked by fit (and specificity when BLAST is set up).', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Save the pairs you like; the Order List exports them as an order sheet.', 'anchor': 'primers-order-tab'},
       ]),


    # ── dafc ────────────────────────────────────────────────────────

    _r(id='dafc_select_self_loop', category='dafc',
       command='get the reads linking the eve TSS to itself',
       phrasings=[
           'get the DAF-C contacts anchored at the eve TSS',
       ],
       context=V_DM6_3R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"get the reads linking the eve TSS to itself": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Contacts > Map tab.',
       summary='Contacts > Map tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'contact-map', 'tab': 'map'},
           {'type': 'explain', 'text': 'Drag a rectangle on the map over the contact you want: the reads linking those two windows are selected.', 'anchor': 'contacts-map'},
           {'type': 'explain', 'text': 'Open Regions then opens both ends side by side.', 'anchor': 'contacts-map'},
       ]),


    # ── scope_variations ────────────────────────────────────────────

    _r(id='cluster_rule_scope_tss', category='scope_variations',
       command='cluster by TF footprints around the eve TSS',
       context=V_DM6_3R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"cluster by TF footprints around the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Cluster toolbar group, Cluster, Clusters > Overview tab. Their clicks: Cluster; the steps after each wait until it has happened.',
       summary='Cluster controls toggle → Clustering method → K → Cluster toolbar group → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 3.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Pick the cluster rule "TF at TSS" (TF footprints 1-89 bp at the eve TSS) in the features dropdown; make it in Rules > Cluster if it doesn\'t exist yet.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_rule_scope_exons', category='scope_variations',
       command='cluster by nucleosome occupancy across exons of the selected gene',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"cluster by nucleosome occupancy across exons of the selected gene": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Cluster toolbar group, Cluster, Clusters > Overview tab. Their clicks: Cluster; the steps after each wait until it has happened.',
       summary='Cluster controls toggle → Clustering method → K → Cluster toolbar group → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 4.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Pick the cluster rule "Nuc across exons" (nucleosome footprints 90-250 bp at the eve exons) in the features dropdown; make it in Rules > Cluster if it doesn\'t exist yet.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_rule_scope_current_window', category='scope_variations',
       command='cluster by accessibility across the current window',
       context=V_DM6_2R,
       thinking='"cluster by accessibility across the current window": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Cluster toolbar group, Cluster, Clusters > Overview tab. Their clicks: Cluster; the steps after each wait until it has happened.',
       summary='Cluster controls toggle → Clustering method → K → Cluster toolbar group → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 3.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Pick the cluster rule "Accessibility in window" (FIRE footprints at least 1 bp across the whole view) in the features dropdown; make it in Rules > Cluster if it doesn\'t exist yet.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_rule_scope_custom_region', category='scope_variations',
       command='cluster by TF footprints in 9.97 Mb to 9.98 Mb on 2R',
       context=V_DM6_2R,
       thinking='"cluster by TF footprints in 9.97 Mb to 9.98 Mb on 2R": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Cluster toolbar group, Cluster, Clusters > Overview tab. Their clicks: Cluster; the steps after each wait until it has happened.',
       summary='Cluster controls toggle → Clustering method → K → Cluster toolbar group → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 3.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Pick the cluster rule "TF custom" (TF footprints 1-89 bp in 2R:9,970,000-9,980,000) in the features dropdown; make it in Rules > Cluster if it doesn\'t exist yet.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── analysis_rules ──────────────────────────────────────────────

    _r(id='filter_all_peaks_level_zero_only', category='analysis_rules',
       command='filter reads using only strong peaks (level 0)',
       context=V_DM6_2R,
       thinking='"filter reads using only strong peaks (level 0)": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add filter rule, Filter. Their clicks: Filter; the steps after each wait until it has happened.',
       summary='Add filter rule → Filter',
       warnings=['allPeaks + peakLevelMin/Max scoping happens at the rule level; the backend resolves the windows from selected_peaks when scope_windows is omitted. Pass the actual rule via cluster_feature_rules/analysis_filter_rules if you need explicit peak-level gating.'],
       actions=[
           {'type': 'explain', 'text': 'Make a filter rule in Rules > Filter keeping reads with at least 1 TF footprint (1-89 bp) at detected peaks.', 'anchor': 'add-filter-rule'},
           {'type': 'try_it', 'text': 'Pick it in the Filter dropdown and click Filter.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),

    _r(id='cluster_with_label_rule_term', category='analysis_rules',
       command='cluster by my green label rule across selected peaks',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"cluster by my green label rule across selected peaks": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Cluster toolbar group, Scan, Peaks track. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Cluster controls toggle → Clustering method → K → Cluster toolbar group → Scan → Peaks track',
       warnings=['Replace <saved-rule-id> with the actual ColorRule id from activeColormap.rules; the Rules panel snapshots the rule body when the term is created.'],
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 3.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Pick the cluster rule "Green-label cluster" (label_rule at the selected peaks) in the features dropdown; make it in Rules > Cluster if it doesn\'t exist yet.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='cluster_with_footprint_group_term', category='analysis_rules',
       command='cluster by my saved Pol II footprint class',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"cluster by my saved Pol II footprint class": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, Clustering method, K, Cluster toolbar group, Scan, Peaks track. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Cluster controls toggle → Clustering method → K → Cluster toolbar group → Scan → Peaks track',
       warnings=['Replace <saved-group-id> with the actual FootprintGroup id from footprintGroups; created from the Footprints panel.'],
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 3.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Pick the cluster rule "Pol II cluster" (your saved footprint at the selected peaks) in the features dropdown; make it in Rules > Cluster if it doesn\'t exist yet.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='filter_compute_then_pin', category='analysis_rules',
       command='filter to reads with at least 2 TF footprints and pin them as the display filter',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking="A filter rule applied with Filter stays applied, which is the 'pin'.",
       summary='Filter rule: at least 2 TF footprints, then Filter',
       warnings=["The read_ids in the second step must come from the first step's response.results.<dataset_id>.read_ids; the client helper filter_by_analysis_rule(pin=True) does this round-trip in one call."],
       actions=[
           {'type': 'explain', 'text': 'Make a filter rule in Rules > Filter: at least 2 TF footprints (1-89 bp) in the view.', 'anchor': 'add-filter-rule'},
           {'type': 'try_it', 'text': 'Pick it in the Filter dropdown and click Filter: the matching reads stay shown until you clear the filter.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='multi_step_scan_then_filter_then_sort', category='multi_step',
       command='scan peaks, filter to reads with at least 1 TF footprint, then sort by nucleosome occupancy',
       context=V_DM6_2R,
       thinking='"scan peaks, filter to reads with at least 1 TF footprint, then sort by nucleosome occupancy": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Add filter rule, Filter, Add sort rule, Sort. Their clicks: Scan, Filter, Sort; the steps after each wait until it has happened.',
       summary='Scan → Add filter rule → Filter → Add sort rule → Sort',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'explain', 'text': 'Make a filter rule in Rules > Filter keeping reads with at least 1 TF footprint (1-89 bp).', 'anchor': 'add-filter-rule'},
           {'type': 'try_it', 'text': 'Pick it in the Filter dropdown and click Filter.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
           {'type': 'explain', 'text': 'Make a sort rule in Rules > Sort: nucleosome footprints, metric occupancy, highest first.', 'anchor': 'add-sort-rule'},
           {'type': 'try_it', 'text': 'Pick it in the Sort dropdown and click Sort.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
       ]),

    _r(id='multi_step_navigate_cluster_by_rule', category='multi_step',
       command='navigate to eve, scan peaks, then cluster using my TF-footprint rule',
       context=V_DM6_3R,
       thinking='"navigate to eve, scan peaks, then cluster using my TF-footprint rule": I guide them through it rather than doing it. First I move the view to eve. Then the controls in the order they\'d use them: Scan, Cluster controls toggle, Clustering method, K, Cluster toolbar group, Peaks track. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='eve → Scan → 3R:1,000,000 → Cluster controls toggle → Clustering method → K',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'navigate_region', 'chrom': '3R', 'start': 1000000, 'end': 1010000},
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Choose K-means in the method dropdown.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'Set K to 4.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Pick the cluster rule "TF footprints" (TF footprints 1-89 bp at the selected peaks) in the features dropdown; make it in Rules > Cluster if it doesn\'t exist yet.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── analysis_rules ──────────────────────────────────────────────

    _r(id='peak_rule_add_via_settings', category='analysis_rules',
       command='add a peak rule for TF accessibility with strong threshold 0.6',
       context=V_DM6_2R,
       thinking='"add a peak rule for TF accessibility with strong threshold 0.6": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Peak rules, Scan. Their clicks: Scan; the steps after each wait until it has happened.',
       summary='Peak rules → Scan',
       warnings=["This stub replaces all peak_rules with the single new rule; in practice include the existing rules too so others aren't dropped."],
       actions=[
           {'type': 'explain', 'text': 'Open the peak rules and add one on the TF layer with a strong threshold of 0.6.', 'anchor': 'peak-rules'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
       ]),


    # ── ui_actions ──────────────────────────────────────────────────

    _r(id='ui_open_analysis_rules_panel', category='ui_actions',
       command='show me the analysis rules panel',
       phrasings=[
           'open the analysis rules panel',
           'bring up the rules panel',
           'I want to see the analysis rules',
           'switch to the rules panel',
           'open analysis rules',
           'show the rules panel',
       ],
       context=V_DM6_2R,
       thinking='Open it and say what it holds.',
       summary='Rules panel',
       actions=[
           {'type': 'open_panel', 'panel_type': 'cluster-features'},
           {'type': 'explain', 'text': 'Rules has three tabs: Cluster, Sort and Filter; each rule you make shows up in the matching toolbar control.', 'anchor': 'rules-cluster-tab'},
       ]),

    _r(id='ui_open_primer_design_panel', category='ui_actions',
       command='open the primer design panel',
       phrasings=[
           'bring up the primer design panel',
           'show the primer design panel',
           'I want primer design',
           'switch to primer design',
           'open primers',
       ],
       context=V_DM6_2R,
       thinking='Open it on the Design tab.',
       summary='Primers panel',
       actions=[
           {'type': 'open_panel', 'panel_type': 'primer-design', 'tab': 'design'},
           {'type': 'explain', 'text': 'Primers are designed around the selected peaks, or the view if none are selected.', 'anchor': 'primers-design-tab'},
       ]),

    _r(id='ui_open_analysis_rules_filter_tab', category='ui_actions',
       command='show me the filter tab of analysis rules',
       context=V_DM6_2R,
       thinking='Open the Filter tab and point at Add filter rule.',
       summary='Rules > Filter',
       actions=[
           {'type': 'open_panel', 'panel_type': 'cluster-features', 'tab': 'filter'},
           {'type': 'explain', 'text': 'Add filter rule makes a rule that keeps only reads passing a test; it then appears in the Filter dropdown.', 'anchor': 'add-filter-rule'},
       ]),

    _r(id='ui_add_cluster_rule_for_tf', category='ui_actions',
       command='add a cluster rule for TF footprints at selected peaks',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"add a cluster rule for TF footprints at selected peaks": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add cluster rule, Rules > Cluster tab.',
       summary='Add cluster rule → Rules > Cluster tab',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Cluster, click Add cluster rule and name it TF footprints.', 'anchor': 'add-cluster-rule'},
           {'type': 'explain', 'text': 'Add a term for TF footprints 1-89 bp, scoped at the selected peaks; each rule becomes an option in the Cluster controls.', 'anchor': 'rules-cluster-tab'},
       ]),

    _r(id='ui_open_panel_then_add_rule', category='ui_actions',
       command='open the analysis rules panel and add a nucleosome cluster rule',
       context=V_DM6_2R,
       thinking='Open Rules on the Cluster tab and walk the Add cluster rule form.',
       summary='Rules > Cluster: add a nucleosome rule',
       actions=[
           {'type': 'open_panel', 'panel_type': 'cluster-features', 'tab': 'cluster'},
           {'type': 'explain', 'text': 'Click Add cluster rule and name it, e.g. Nucleosomes.', 'anchor': 'add-cluster-rule'},
           {'type': 'explain', 'text': 'Add a term for nucleosome footprints (90-200 bp) at the selected peaks; the rule then appears in the Cluster controls.', 'anchor': 'rules-cluster-tab'},
       ]),

    _r(id='ui_add_sort_rule_for_tf_count', category='ui_actions',
       command='add a sort rule for TF footprint count, highest first',
       context=V_DM6_2R,
       thinking='"add a sort rule for TF footprint count, highest first": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add sort rule, Rules > Sort tab.',
       summary='Add sort rule → Rules > Sort tab',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Sort, click Add sort rule and name it TF footprint count.', 'anchor': 'add-sort-rule'},
           {'type': 'explain', 'text': 'Give it a term for TF footprints 1-89 bp at the selected peaks, metric count, highest first. It then appears in the Sort dropdown.', 'anchor': 'rules-sort-tab'},
       ]),

    _r(id='ui_add_filter_rule_nuc_occupancy', category='ui_actions',
       command='add a filter rule that keeps reads with at least 0.5 nucleosome occupancy',
       context=V_DM6_2R,
       thinking='"add a filter rule that keeps reads with at least 0.5 nucleosome occupancy": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add filter rule, Rules > Filter tab.',
       summary='Add filter rule → Rules > Filter tab',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Filter, click Add filter rule and name it Nuc occupancy >= 0.5.', 'anchor': 'add-filter-rule'},
           {'type': 'explain', 'text': 'Set it to keep reads with at least 0.5 (occupancy) of nucleosome footprints 90-250 bp at the selected peaks. It then appears in the Filter dropdown.', 'anchor': 'rules-filter-tab'},
       ]),

    _r(id='ui_add_sort_rule_pol2_pause_selected_gene', category='ui_actions',
       command='add a sort rule that puts paused Pol II reads first for the selected gene',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"add a sort rule that puts paused Pol II reads first for the selected gene": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add sort rule, Rules > Sort tab.',
       summary='Add sort rule → Rules > Sort tab',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Sort, click Add sort rule and name it Paused Pol II first.', 'anchor': 'add-sort-rule'},
           {'type': 'explain', 'text': 'Give it a term for paused Pol II at the eve TSS, metric count, highest first. It then appears in the Sort dropdown.', 'anchor': 'rules-sort-tab'},
       ]),

    _r(id='ui_add_filter_rule_pol2_elongating_gene_body', category='ui_actions',
       command='add a filter rule for elongating Pol II in the gene body',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"add a filter rule for elongating Pol II in the gene body": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add filter rule, Rules > Filter tab.',
       summary='Add filter rule → Rules > Filter tab',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Filter, click Add filter rule and name it Elongating Pol II in gene body.', 'anchor': 'add-filter-rule'},
           {'type': 'explain', 'text': 'Set it to keep reads with at least 1 (count) of elongating Pol II at the eve gene body. It then appears in the Filter dropdown.', 'anchor': 'rules-filter-tab'},
       ]),

    _r(id='ui_focus_cluster_3', category='ui_actions',
       command='focus on cluster 3',
       phrasings=[
           'show only cluster 3',
           'isolate cluster 3',
           'filter to cluster 3',
           'just show me cluster 3',
           'highlight cluster 3 only',
           'dim everything except cluster 3',
           'show me only cluster 3',
           'hide everything except cluster 3',
       ],
       context=V_DM6_2R,
       thinking='"focus on cluster 3": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Their clicks: Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click cluster 3 in the list (or its colour in the bar left of the reads) to focus it; the other clusters fade.', 'wait_for': 'cluster_focused', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='ui_hide_cluster_5', category='ui_actions',
       command='hide cluster 5',
       phrasings=[
           'remove cluster 5 from view',
           'drop cluster 5',
           'get rid of cluster 5',
           'hide the 5th cluster',
       ],
       context=V_DM6_2R,
       thinking='"hide cluster 5": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Their clicks: Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click the eye icon on cluster 5 to hide it. Its reads stay assigned; Unhide all brings it back.', 'wait_for': 'cluster_focused', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='ui_design_primers_for_eve_tss', category='ui_actions',
       command='design primers covering the eve TSS region',
       context=V_DM6_3R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"design primers covering the eve TSS region": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Peaks track, Primers > Design tab, Design primers, Primers > Order List tab. Their clicks: Peaks track, Design primers; the steps after each wait until it has happened.',
       summary='Peaks track → Primers > Design tab → Design primers → Primers > Order List tab',
       actions=[
           {'type': 'try_it', 'text': 'Click the peak (or peaks) the primers should flank in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'The Design tab designs around the selected peaks, or the view if none are selected.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers; pairs are ranked by fit (and specificity when BLAST is set up).', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Save the pairs you like; the Order List exports them as an order sheet.', 'anchor': 'primers-order-tab'},
       ]),

    _r(id='ui_focus_then_dissolve', category='ui_actions',
       command='focus on cluster 4 then dissolve it',
       context=V_DM6_2R,
       thinking='"focus on cluster 4 then dissolve it": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Their clicks: Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click cluster 4 in the list (or its colour in the bar left of the reads) to focus it; the other clusters fade.', 'wait_for': 'cluster_focused', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': 'Right-click cluster 4 and choose Dissolve: its reads move to their nearest remaining cluster.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='ui_remove_cluster_rule_by_name', category='ui_actions',
       command='remove my TF footprints cluster rule',
       context=V_DM6_2R,
       thinking='"remove my TF footprints cluster rule": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Rules > Cluster tab.',
       summary='Rules > Cluster tab',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Cluster, click the × on "TF footprints" to delete it.', 'anchor': 'rules-cluster-tab'},
       ]),


    # ── tutorial_intent ─────────────────────────────────────────────

    _r(id='teach_cluster_panel', category='tutorial_intent',
       command='walk me through the cluster panel',
       phrasings=[
           'explain how to use the cluster panel',
           'spotlight the cluster panel and explain how to use it',
           'give me a tutorial on the cluster panel',
           'what does the cluster panel do?',
           'help me understand the cluster panel',
           'cluster these reads',
           'cluster reads for me',
           'how do I cluster reads?',
           'show me how clustering works',
           'teach me how to cluster reads',
           'how do I merge clusters',
           'how do I combine clusters',
       ],
       context=V_DM6_2R,
       thinking='They want the tour of clustering. Controls first (expand, method, K), then they scan, pick a peak and click Cluster themselves; once clusters exist the panel has something to show, so its tabs come last. Scan and peak steps are skipped if already done.',
       summary='Cluster controls, then the Clusters panel and its tabs',
       actions=[
           {'type': 'explain', 'text': 'Clustering lives in the Cluster group of the toolbar: method, K and the Cluster button.', 'anchor': 'cluster-toolbar'},
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of its controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Pick the method. K-means usually works best; Combinatorial and HDBSCAN choose the number of clusters themselves.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'K sets how many clusters K-means makes. Choose it a little high; you can merge similar ones afterwards.', 'anchor': 'cluster-k'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click a peak to cluster on (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'The Clusters panel lists each cluster with its read count; click one to focus it, the eye hides it.', 'anchor': 'clusters-overview'},
           {'type': 'explain', 'text': "Profiles overlays each cluster's average profile, so you can see where they differ.", 'anchor': 'clusters-profiles'},
           {'type': 'explain', 'text': 'Projection places each read in 2-D by its features, coloured by cluster.', 'anchor': 'clusters-projection'},
           {'type': 'explain', 'text': 'Merge similar clusters folds tiny clusters and near-duplicates into their nearest cluster.', 'anchor': 'clusters-merge-similar'},
       ]),

    _r(id='teach_rules_panel', category='tutorial_intent',
       command='walk me through analysis rules',
       phrasings=[
           'explain the analysis rules panel',
           'spotlight the analysis rules panel',
           'give me a tutorial on the rules panel',
           'what can I do in the analysis rules panel?',
           'explain the rules system to me',
           'create a sort rule for me',
           'make a cluster rule',
           'how do I use analysis rules?',
           'how do I create a sort rule?',
           'show me how rules work',
       ],
       context=V_DM6_2R,
       thinking='A tour of the Rules panel: three tabs, each feeding a toolbar control. Point at each tab and at the toolbar control that uses its rules; nothing needs the user to act yet.',
       summary="Rules panel: cluster, sort and filter rules and where they're used",
       actions=[
           {'type': 'explain', 'text': 'Rules are reusable definitions. The Cluster tab says which footprints, at which regions, define clusters.', 'anchor': 'rules-cluster-tab'},
           {'type': 'explain', 'text': "Add cluster rule makes one; it then appears in the Cluster controls' features dropdown.", 'anchor': 'add-cluster-rule'},
           {'type': 'explain', 'text': 'The Sort tab holds sort rules, e.g. TF footprint count at the TSS, highest first.', 'anchor': 'rules-sort-tab'},
           {'type': 'explain', 'text': 'A saved sort rule shows up in the Sort dropdown; pick it and click Sort.', 'anchor': 'sort-button'},
           {'type': 'explain', 'text': 'The Filter tab keeps only reads that pass a test, e.g. at least 2 TF footprints.', 'anchor': 'rules-filter-tab'},
           {'type': 'explain', 'text': 'Pick a filter rule in the Filter dropdown and click Filter; Clear filter shows every read again.', 'anchor': 'filter-button'},
       ]),

    _r(id='teach_primer_panel', category='tutorial_intent',
       command='walk me through designing primers',
       phrasings=[
           'explain the primer design panel',
           'spotlight the primer panel',
           'give me a tutorial on the primer panel',
           'what does the primer panel do?',
           "I'm new to primer design here — show me",
           'design primers for this region',
           'design primers around the selected peak',
           'how do I design primers in this tool?',
           'how do I make qPCR primers?',
           'show me how primer design works',
       ],
       context=V_DM6_2R,
       thinking='Primer design needs a target: a selected peak (skipped if one is selected). Then point at the Design tab, let them click Design primers, and finish at the Order List.',
       summary='Pick a peak, design primers, save to the order list',
       actions=[
           {'type': 'try_it', 'text': 'Click the peak the primers should flank (Cmd/Ctrl+click for more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'explain', 'text': 'The Design tab designs around the selected peaks, or the whole view if none are selected. Modes: Standard, 4C and DAF-C.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers.', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Pairs are ranked by fit, and by specificity when a BLAST database is configured.', 'anchor': 'primers-design-tab'},
           {'type': 'explain', 'text': 'Save the pairs you like; the Order List exports them as an order sheet (IDT, Twist, ...).', 'anchor': 'primers-order-tab'},
       ]),

    _r(id='teach_footprint_panel', category='tutorial_intent',
       command='walk me through footprint analysis',
       phrasings=[
           'explain footprint analysis',
           'how does the footprint analysis panel work?',
           'spotlight the footprint panel',
           'tutorial on footprint analysis',
           'what is footprint analysis?',
           'give me an overview of the footprint panel',
           'analyze footprints in this region',
           'run footprint analysis here',
           'how do I run footprint analysis?',
           'show me how to use the footprint panel',
       ],
       context=V_DM6_2R,
       thinking='The Footprints panel is empty until a footprint is Cmd/Ctrl+clicked, so that comes first (skipped if one is selected), then saving it, then the tabs that use saved footprints.',
       summary='Cmd+click a footprint, save it, then the Saved, Classes and Co-occupancy tabs',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on any read to analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range and where it sits across the reads.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Adjust the size range if you like, then click Save to keep it as a definition.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint', 'skip_if': 'has_saved_footprints'},
           {'type': 'explain', 'text': 'Saved footprints are listed here and coloured on every read that carries one; you can rename, recolour or filter by them.', 'anchor': 'footprints-saved'},
           {'type': 'explain', 'text': 'Classes lists the recurring footprint classes in this view, with sizes and matching motifs.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'Co-occupancy shows which saved footprints occur together on the same molecules, and can cluster reads by them.', 'anchor': 'footprints-cooccupancy'},
       ]),

    _r(id='teach_contact_panel', category='tutorial_intent',
       command='walk me through contact maps',
       phrasings=[
           'explain the contact map panel',
           'what does the contact map panel do?',
           'spotlight the contact map panel',
           'tutorial for the contact map',
           'teach me about Micro-C contact maps',
           'show me the contact map for this region',
           'open a contact map here',
           'how do I use the contact map?',
           'show me how the contact map works',
           'how do I view 3D chromatin contacts?',
       ],
       context=V_DM6_2R,
       thinking="Open the Contacts panel, move to eve so there is something to see, then explain selecting a contact and the Compare tab. Loading the map itself is the user's click (Load File).",
       summary='Contacts panel: the map, selecting a contact, comparing loci',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 20000},
           {'type': 'open_panel', 'panel_type': 'contact-map', 'tab': 'map'},
           {'type': 'explain', 'text': 'The Map tab shows the Micro-C or DAF-C contact matrix for the view; load a .cool/.mcool file with Load File if none is loaded.', 'anchor': 'contacts-map'},
           {'type': 'explain', 'text': 'Drag a rectangle over a contact to select the reads linking the two windows; Open Regions shows both ends side by side.', 'anchor': 'contacts-map'},
           {'type': 'explain', 'text': 'Compare puts two loci or two haplotypes side by side in linked panels.', 'anchor': 'haplotype-compare'},
       ]),

    _r(id='teach_history_panel', category='tutorial_intent',
       command='walk me through undo and the history panel',
       phrasings=[
           'explain the history panel and how undo works',
           'spotlight the history panel',
           'tutorial on the history feature',
           'what does the history panel do?',
           'teach me about history and snapshots',
           'undo my last action',
           'let me see my session history',
           'how does undo work in this tool?',
           'how do I undo my last action?',
           'how do I see my history?',
       ],
       context=V_DM6_2R,
       thinking='Point at Undo, Redo and the timeline, then let them try Undo once so they see it work.',
       summary='Undo, Redo and the history timeline',
       actions=[
           {'type': 'explain', 'text': 'Undo steps back one change (Cmd+Z); every navigation, cluster run, sort and colour change is a step.', 'anchor': 'undo'},
           {'type': 'explain', 'text': 'Redo steps forward again (Cmd+Shift+Z).', 'anchor': 'redo'},
           {'type': 'explain', 'text': 'The ▾ next to Undo opens the timeline: click any step to jump straight back to it.', 'anchor': 'history-timeline'},
           {'type': 'try_it', 'text': 'Try it: click Undo.', 'wait_for': 'undo_used', 'anchor': 'undo'},
       ]),

    _r(id='teach_navigation_chrome', category='tutorial_intent',
       command='teach me how to navigate the browser',
       phrasings=[
           'give me a tutorial on browser navigation',
           'explain how navigation works',
           'walk me through the navigation controls',
           'tutorial on getting around',
           'navigate to eve',
           'take me to a gene',
           'how do I move around in this browser?',
           'show me how navigation works',
           'how do I jump to a gene?',
           'how do I zoom out?',
       ],
       context=V_DM6_2R,
       thinking='Navigation basics: they type into the search box themselves, then the zoom, pan, chromosome and go-to-reads controls, and the history to go back.',
       summary='Search, zoom, pan, chromosome, go to reads, history',
       actions=[
           {'type': 'try_it', 'text': 'Type a gene name (e.g. eve) or coordinates (2R:9,970,000-9,980,000) and press Enter.', 'wait_for': 'navigated', 'anchor': 'search-bar'},
           {'type': 'explain', 'text': 'Zoom in and out here, or with the arrow keys; Cmd/Ctrl+scroll over the reads changes their height instead.', 'anchor': 'zoom-in'},
           {'type': 'explain', 'text': 'Pan left and right here (or drag inside a track).', 'anchor': 'pan-left'},
           {'type': 'explain', 'text': 'Pick a chromosome here.', 'anchor': 'chrom-selector'},
           {'type': 'explain', 'text': 'Go to reads jumps to the next best-covered window, deepest first.', 'anchor': 'go-to-reads'},
           {'type': 'explain', 'text': 'Every move is in the history: Undo (Cmd+Z) or the ▾ timeline takes you back.', 'anchor': 'history-timeline'},
       ]),


    # ── tutorial_walks ──────────────────────────────────────────────

    _r(id='walk_open_rules_add_cluster_and_sort', category='tutorial_walks',
       command='open the analysis rules panel and add a TF cluster rule plus a sort by TF count',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"open the analysis rules panel and add a TF cluster rule plus a sort by TF count": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add cluster rule, Rules > Cluster tab, Add sort rule, Rules > Sort tab.',
       summary='Add cluster rule → Rules > Cluster tab → Add sort rule → Rules > Sort tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'cluster-features', 'tab': 'cluster'},
           {'type': 'explain', 'text': 'In Rules > Cluster, click Add cluster rule and name it TF footprints.', 'anchor': 'add-cluster-rule'},
           {'type': 'explain', 'text': 'Add a term for TF footprints 1-89 bp, scoped at the selected peaks; each rule becomes an option in the Cluster controls.', 'anchor': 'rules-cluster-tab'},
           {'type': 'explain', 'text': 'In Rules > Sort, click Add sort rule and name it TF count (desc).', 'anchor': 'add-sort-rule'},
           {'type': 'explain', 'text': 'Give it a term for TF footprints 1-89 bp at the selected peaks, metric count, highest first. It then appears in the Sort dropdown.', 'anchor': 'rules-sort-tab'},
       ]),

    _r(id='walk_scan_cluster_focus_largest', category='tutorial_walks',
       command='scan peaks, cluster reads, then focus on cluster 1',
       context=V_DM6_2R,
       thinking='"scan peaks, cluster reads, then focus on cluster 1": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster, Clusters > Overview tab; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
           {'type': 'try_it', 'text': 'Click cluster 1 in the list (or its colour in the bar left of the reads) to focus it; the other clusters fade.', 'wait_for': 'cluster_focused', 'anchor': 'clusters-overview'},
       ]),

    _r(id='walk_navigate_design_primers', category='tutorial_walks',
       command='navigate to eve, then design primers for the TSS region',
       context=V_DM6_3R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"navigate to eve, then design primers for the TSS region": I guide them through it rather than doing it. First I move the view to eve. Then the controls in the order they\'d use them: Peaks track, Primers > Design tab, Design primers, Primers > Order List tab. Their clicks: Peaks track, Design primers; the steps after each wait until it has happened.',
       summary='eve → Peaks track → Primers > Design tab → Design primers → Primers > Order List tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click the peak (or peaks) the primers should flank in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'The Design tab designs around the selected peaks, or the view if none are selected.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers; pairs are ranked by fit (and specificity when BLAST is set up).', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Save the pairs you like; the Order List exports them as an order sheet.', 'anchor': 'primers-order-tab'},
       ]),

    _r(id='walk_filter_pol2_then_sort_elongating', category='tutorial_walks',
       command='filter to paused reads at eve and sort by elongating Pol II',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"filter to paused reads at eve and sort by elongating Pol II": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add filter rule, Rules > Filter tab, Filter, Add sort rule, Rules > Sort tab, Sort. Their clicks: Filter, Sort; the steps after each wait until it has happened.',
       summary='Add filter rule → Rules > Filter tab → Filter → Add sort rule → Rules > Sort tab → Sort',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Filter, click Add filter rule and name it Pol II pause.', 'anchor': 'add-filter-rule'},
           {'type': 'explain', 'text': 'Set it to keep reads with at least 1 (count) of paused Pol II at the eve TSS. It then appears in the Filter dropdown.', 'anchor': 'rules-filter-tab'},
           {'type': 'try_it', 'text': 'Pick "Pol II pause" in the Filter dropdown and click Filter.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
           {'type': 'explain', 'text': 'In Rules > Sort, click Add sort rule and name it Elongating Pol II.', 'anchor': 'add-sort-rule'},
           {'type': 'explain', 'text': 'Give it a term for elongating Pol II at the eve gene body, metric count, highest first. It then appears in the Sort dropdown.', 'anchor': 'rules-sort-tab'},
           {'type': 'try_it', 'text': 'Pick "Elongating Pol II" in the Sort dropdown and click Sort.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
       ]),

    _r(id='walk_hide_two_clusters', category='tutorial_walks',
       command='hide clusters 4 and 5',
       context=V_DM6_2R,
       thinking='"hide clusters 4 and 5": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Their clicks: Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click the eye icon on cluster 4 to hide it. Its reads stay assigned; Unhide all brings it back.', 'wait_for': 'cluster_focused', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'Click the eye icon on cluster 5 to hide it. Its reads stay assigned; Unhide all brings it back.', 'wait_for': 'cluster_focused', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='walk_undo_filter_then_focus', category='tutorial_walks',
       command='clear my filter and focus on cluster 2',
       context=V_DM6_2R,
       thinking='"clear my filter and focus on cluster 2": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clear filter, Clusters > Overview tab. Their clicks: Clear filter, Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clear filter → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Clear filter to show every read again.', 'wait_for': 'filter_cleared', 'anchor': 'clear-filter'},
           {'type': 'try_it', 'text': 'Click cluster 2 in the list (or its colour in the bar left of the reads) to focus it; the other clusters fade.', 'wait_for': 'cluster_focused', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='walk_open_filter_tab_add_then_apply', category='tutorial_walks',
       command='open the filter tab and add a rule for at least 2 TF footprints',
       context=V_DM6_2R,
       thinking='"open the filter tab and add a rule for at least 2 TF footprints": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add filter rule, Rules > Filter tab.',
       summary='Add filter rule → Rules > Filter tab',
       actions=[
           {'type': 'open_panel', 'panel_type': 'cluster-features', 'tab': 'filter'},
           {'type': 'explain', 'text': 'In Rules > Filter, click Add filter rule and name it TF count >= 2.', 'anchor': 'add-filter-rule'},
           {'type': 'explain', 'text': 'Set it to keep reads with at least 2 (count) of TF footprints 1-89 bp at the selected peaks. It then appears in the Filter dropdown.', 'anchor': 'rules-filter-tab'},
       ]),

    _r(id='walk_remove_two_rules', category='tutorial_walks',
       command='remove my TF cluster rule and my elongating Pol II sort rule',
       context=V_DM6_2R,
       thinking='"remove my TF cluster rule and my elongating Pol II sort rule": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Rules > Cluster tab, Rules > Sort tab.',
       summary='Rules > Cluster tab → Rules > Sort tab',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Cluster, click the × on "TF footprints" to delete it.', 'anchor': 'rules-cluster-tab'},
           {'type': 'explain', 'text': 'In Rules > Sort, click the × on "Elongating Pol II" to delete it.', 'anchor': 'rules-sort-tab'},
       ]),


    # ── display ─────────────────────────────────────────────────────

    _r(id='display_hide_nuc_layer', category='display',
       command='hide the nucleosome layer',
       phrasings=[
           'turn off the nuc layer',
           'disable nucleosomes',
           'hide nucs',
           'switch off the nucleosome display',
           'stop showing nucleosomes',
           'turn off nuc',
       ],
       context=V_DM6_2R,
       thinking='"hide the nucleosome layer": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Layer toggles.',
       summary='Layer toggles',
       actions=[
           {'type': 'explain', 'text': 'Click nucleosome in the Layers controls to hide it.', 'anchor': 'layer-toggles'},
       ]),

    _r(id='display_show_tf_layer', category='display',
       command='show the TF footprint layer',
       context=V_DM6_2R,
       thinking='"show the TF footprint layer": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Layer toggles.',
       summary='Layer toggles',
       actions=[
           {'type': 'explain', 'text': 'Click TF in the Layers controls to show it.', 'anchor': 'layer-toggles'},
       ]),

    _r(id='display_show_fire_layer', category='display',
       command='enable the FIRE accessibility layer',
       context=V_DM6_2R,
       thinking='"enable the FIRE accessibility layer": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Layer toggles.',
       summary='Layer toggles',
       actions=[
           {'type': 'explain', 'text': 'Click FIRE in the Layers controls to show it.', 'anchor': 'layer-toggles'},
       ]),

    _r(id='display_set_min_footprints', category='display',
       command='hide reads with fewer than 3 footprints',
       context=V_DM6_2R,
       thinking='"hide reads with fewer than 3 footprints": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read Filters.',
       summary='Read Filters',
       actions=[
           {'type': 'explain', 'text': 'Set Min footprints to 3: reads with fewer footprints are hidden.', 'anchor': 'read-filters'},
       ]),

    _r(id='display_set_quality_filter', category='display',
       command='only show footprints with quality at least 200',
       context=V_DM6_2R,
       thinking='"only show footprints with quality at least 200": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Quality cutoffs.',
       summary='Quality cutoffs',
       actions=[
           {'type': 'explain', 'text': 'Set the minimum call quality to 200: calls below it are hidden and not counted.', 'anchor': 'quality-cutoffs'},
       ]),

    _r(id='display_toggle_span_off', category='display',
       command='show non-spanning reads too',
       context=V_DM6_2R,
       thinking='"show non-spanning reads too": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Spanning only.',
       summary='Spanning only',
       actions=[
           {'type': 'explain', 'text': 'Untick Spanning only to show every read that overlaps the view, not just the ones spanning it.', 'anchor': 'spanning-toggle'},
       ]),

    _r(id='color_rule_remove_by_name', category='display',
       command='remove my green TF label rule',
       context=V_DM6_2R,
       thinking='"remove my green TF label rule": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Labeling > Rules tab.',
       summary='Labeling > Rules tab',
       actions=[
           {'type': 'explain', 'text': 'In the Labeling panel, click the × on "Green TF" to remove it.', 'anchor': 'labeling-rules'},
       ]),

    _r(id='color_rule_disable', category='display',
       command="disable my green TF label rule but don't delete it",
       context=V_DM6_2R,
       thinking='"disable my green TF label rule but don\'t delete it": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Labeling > Rules tab.',
       summary='Labeling > Rules tab',
       actions=[
           {'type': 'explain', 'text': 'Use the checkbox at the left of "Green TF" to turn it off; the rule stays in the list.', 'anchor': 'labeling-rules'},
       ]),

    _r(id='color_rule_clear_all', category='display',
       command='clear all color rules',
       phrasings=[
           'reset all my color rules',
           'remove all my custom colors',
           'go back to default colors',
       ],
       context=V_DM6_2R,
       thinking='"clear all color rules": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Labeling > Rules tab.',
       summary='Labeling > Rules tab',
       actions=[
           {'type': 'explain', 'text': 'In the Labeling panel, Reset restores the default colour rules and removes your own.', 'anchor': 'labeling-rules'},
       ]),


    # ── tracks ──────────────────────────────────────────────────────

    _r(id='tracks_add_bigwig_from_url', category='tracks',
       command='add an ATAC track from http://example.com/atac.bw',
       context=V_HG38_MYC,
       thinking='"add an ATAC track from http://example.com/atac.bw": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add a track file or URL. Their clicks: Add a track file or URL; the steps after each wait until it has happened.',
       summary='Add a track file or URL',
       actions=[
           {'type': 'try_it', 'text': 'In the Tracks panel, paste http://example.com/atac.bw into Add a track and click Add, then name it ATAC.', 'wait_for': 'track_added', 'anchor': 'tracks-add-file'},
       ]),

    _r(id='tracks_add_s3_signal_track', category='tracks',
       command='load s3://public-fiberbrowser/h3k27ac.bigWig as an H3K27ac signal track',
       context=V_HG38_MYC,
       thinking='"load s3://public-fiberbrowser/h3k27ac.bigWig as an H3K27ac signal track": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add a track file or URL. Their clicks: Add a track file or URL; the steps after each wait until it has happened.',
       summary='Add a track file or URL',
       actions=[
           {'type': 'try_it', 'text': 'In the Tracks panel, paste s3://public-fiberbrowser/h3k27ac.bigWig into Add a track and click Add, then name it H3K27ac.', 'wait_for': 'track_added', 'anchor': 'tracks-add-file'},
       ]),

    _r(id='tracks_reject_local_path', category='tracks',
       command='load /Users/me/private/signal.bw as a track',
       context=V_DM6_2R,
       thinking="Opening a local file is the user's click; point at where a track file is added.",
       summary='Tracks panel: add the file yourself',
       warnings=['Copilot cannot load local filesystem track paths. Use the Data sidebar or file picker instead.'],
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'try_it', 'text': 'Paste /Users/me/private/signal.bw into Add a track and click Add (or drag the file onto the window).', 'wait_for': 'track_added', 'anchor': 'tracks-add-file'},
       ]),

    _r(id='tracks_remove_first', category='tracks',
       command='remove the first orthogonal track',
       phrasings=[
           'remove the second track',
           'delete track 2',
           'get rid of the second orthogonal track',
       ],
       context=V_DM6_2R,
       thinking='"remove the first orthogonal track": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add a track file or URL.',
       summary='Add a track file or URL',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Loaded tracks are listed here; click the × on the one you want to remove.', 'anchor': 'tracks-add-file'},
       ]),

    _r(id='tracks_set_filter_jaspar', category='tracks',
       command='filter track 2 to only show MA0007 and MA0050',
       context=V_DM6_2R,
       thinking='"filter track 2 to only show MA0007 and MA0050": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Sub-track settings.',
       summary='Sub-track settings',
       actions=[
           {'type': 'explain', 'text': "Hover the track's label and type MA0007, MA0050 in its filter box to show only those entries.", 'anchor': 'panel-subtracks'},
       ]),


    # ── analysis_rules ──────────────────────────────────────────────

    _r(id='apply_cluster_rule_by_name', category='analysis_rules',
       command='cluster using my TF footprints rule',
       context=V_DM6_2R,
       thinking='"cluster using my TF footprints rule": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster toolbar group, Cluster, Clusters > Overview tab. Their clicks: Cluster; the steps after each wait until it has happened.',
       summary='Cluster toolbar group → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'In the Cluster controls, pick your rule "TF footprints" in the features dropdown next to the method.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Then click Cluster: the rule decides which footprints define the clusters.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='apply_sort_rule_by_name', category='analysis_rules',
       command='sort by my TF count sort rule',
       context=V_DM6_2R,
       thinking='"sort by my TF count sort rule": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Sort. Their clicks: Sort; the steps after each wait until it has happened.',
       summary='Sort',
       actions=[
           {'type': 'try_it', 'text': 'Pick "TF count (desc)" in the Sort dropdown and click Sort.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
       ]),

    _r(id='apply_sort_rule_pol2_by_name', category='analysis_rules',
       command='apply my paused Pol II sort rule',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"apply my paused Pol II sort rule": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Sort. Their clicks: Sort; the steps after each wait until it has happened.',
       summary='Sort',
       actions=[
           {'type': 'try_it', 'text': 'Pick "Paused Pol II first" in the Sort dropdown and click Sort.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
       ]),

    _r(id='apply_filter_rule_pinned', category='analysis_rules',
       command='apply my Pol II pause filter rule and pin the result',
       context=V_DM6_2R,
       thinking='"apply my Pol II pause filter rule and pin the result": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Filter. Their clicks: Filter; the steps after each wait until it has happened.',
       summary='Filter',
       actions=[
           {'type': 'try_it', 'text': 'Pick "Pol II pause" in the Filter dropdown and click Filter.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),

    _r(id='apply_filter_rule_preview_unpinned', category='analysis_rules',
       command="preview my TF count filter rule but don't pin the reads",
       context=V_DM6_2R,
       thinking='"preview my TF count filter rule but don\'t pin the reads": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Filter. Their clicks: Filter; the steps after each wait until it has happened.',
       summary='Filter',
       actions=[
           {'type': 'try_it', 'text': 'Pick "TF count >= 2" in the Filter dropdown and click Filter. The reads it hides come back with Clear filter.', 'wait_for': 'filter_applied', 'anchor': 'filter-button'},
       ]),


    # ── ui_actions ──────────────────────────────────────────────────

    _r(id='select_cluster_2_reads', category='ui_actions',
       command='select all reads in cluster 2',
       context=V_DM6_2R,
       thinking='"select all reads in cluster 2": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Their clicks: Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Right-click cluster 2 and choose Select reads: every read in it is selected (they show up in Read Stats).', 'wait_for': 'reads_selected', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='auto_cull_low_abundance', category='ui_actions',
       command='auto-cull tiny clusters with fewer than 3% of reads',
       context=V_DM6_2R,
       thinking='"auto-cull tiny clusters with fewer than 3% of reads": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Merge similar clusters settings, Merge similar clusters. Their clicks: Merge similar clusters; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Merge similar clusters settings → Merge similar clusters',
       actions=[
           {'type': 'explain', 'text': 'In the Merge similar clusters settings, set the smallest cluster to 3%; the preview shows which clusters would go.', 'anchor': 'merge-settings', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'Click Merge similar clusters: tiny clusters and near-duplicates fold into their nearest cluster.', 'wait_for': 'clusters_merged', 'anchor': 'merge-similar', 'requires': 'has_clusters'},
       ]),

    _r(id='auto_cull_similar_clusters', category='ui_actions',
       command='auto-cull nearly duplicate clusters with cosine similarity above 0.9',
       context=V_DM6_2R,
       thinking='"auto-cull nearly duplicate clusters with cosine similarity above 0.9": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Merge similar clusters settings, Merge similar clusters. Their clicks: Merge similar clusters; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Merge similar clusters settings → Merge similar clusters',
       actions=[
           {'type': 'explain', 'text': 'In the Merge similar clusters settings, set the smallest cluster to 0% and the similarity cutoff to 0.9; the preview shows which clusters would go.', 'anchor': 'merge-settings', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'Click Merge similar clusters: tiny clusters and near-duplicates fold into their nearest cluster.', 'wait_for': 'clusters_merged', 'anchor': 'merge-similar', 'requires': 'has_clusters'},
       ]),

    _r(id='annotation_hide_5mc', category='ui_actions',
       command='hide 5mC annotations',
       context=V_DM6_2R,
       thinking='"hide 5mC annotations": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Layer toggles.',
       summary='Layer toggles',
       actions=[
           {'type': 'explain', 'text': 'Click 5mC in the Layers controls to hide it.', 'anchor': 'layer-toggles'},
       ]),

    _r(id='capture_clear_all', category='ui_actions',
       command='clear all captured regions',
       context=V_DM6_2R,
       thinking='"clear all captured regions": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add capture region.',
       summary='Add capture region',
       actions=[
           {'type': 'explain', 'text': 'The capture list is below; Clear all removes every region.', 'anchor': 'capture-add-region'},
       ]),

    _r(id='footprint_group_add_pol2', category='ui_actions',
       command='add a footprint class for Pol II (TF layer, 35-65 bp)',
       context=V_DM6_2R,
       thinking='"add a footprint class for Pol II (TF layer, 35-65 bp)": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Selected footprint, Save (this footprint), Footprints > Saved tab. Their clicks: Reads, Save (this footprint); the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint of the kind you want to keep.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'Set the size range to 35-65 bp.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, name it Pol II and colour cyan.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='footprint_group_remove_pol2', category='ui_actions',
       command='remove my Pol II footprint class',
       context=V_DM6_2R,
       thinking='"remove my Pol II footprint class": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Footprints > Saved tab. Where a control needs something first, the step asks for it.',
       summary='Footprints > Saved tab',
       actions=[
           {'type': 'explain', 'text': 'In Footprints > Saved, click the × on "Pol II" to delete it.', 'anchor': 'footprints-saved', 'requires': 'has_saved_footprints'},
       ]),


    # ── settings ────────────────────────────────────────────────────

    _r(id='settings_cluster_k_8', category='settings',
       command='use k=8 for clustering',
       context=V_DM6_2R,
       thinking='"use k=8 for clustering": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, K.',
       summary='Cluster controls toggle → K',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set K to 8.', 'anchor': 'cluster-k'},
       ]),

    _r(id='settings_sample_seed', category='settings',
       command='set the sample seed to paper-v1 for reproducibility',
       context=V_DM6_2R,
       thinking='"set the sample seed to paper-v1 for reproducibility": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reproducibility.',
       summary='Reproducibility',
       actions=[
           {'type': 'explain', 'text': 'Set the sampling seed to paper-v1: clustering and profiles then pick the same reads every run.', 'anchor': 'reproducibility'},
       ]),


    # ── ui_actions ──────────────────────────────────────────────────

    _r(id='clear_selected_peaks', category='ui_actions',
       command='clear my selected peaks',
       phrasings=[
           'deselect all peaks',
           'unselect the peaks',
           'clear peak selection',
           'drop my peak picks',
       ],
       context=V_DM6_2R,
       thinking='"clear my selected peaks": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clear peak selection.',
       summary='Clear peak selection',
       actions=[
           {'type': 'explain', 'text': 'Click Clear peak selection to deselect every peak.', 'anchor': 'peak-clear-selection'},
       ]),

    _r(id='clear_selected_reads', category='ui_actions',
       command='deselect all reads',
       context=V_DM6_2R,
       thinking='"deselect all reads": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads.',
       summary='Reads',
       actions=[
           {'type': 'explain', 'text': 'Shift+click a selected read again to deselect it, or click an empty spot in the reads to clear the whole selection.', 'anchor': 'reads-track'},
       ]),

    _r(id='reset_view', category='ui_actions',
       command='reset the view',
       phrasings=[
           'reset zoom',
           'go back to the default view',
           'reset the browser',
           'return to the starting view',
           'clear the viewport',
           'restore default zoom',
       ],
       context=V_DM6_2R,
       thinking="reset_view calls the store's resetView action to return to the default viewport.",
       summary='Reset viewport',
       actions=[
           {'type': 'reset_view'},
       ]),


    # ── tutorial_walks ──────────────────────────────────────────────

    _r(id='walk_clean_slate_then_cluster', category='tutorial_walks',
       command='clear my filter and selected peaks, then cluster using my TF rule',
       context=V_DM6_2R,
       thinking='"clear my filter and selected peaks, then cluster using my TF rule": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clear filter, Clear peak selection, Cluster toolbar group, Cluster, Clusters > Overview tab. Their clicks: Clear filter, Cluster; the steps after each wait until it has happened.',
       summary='Clear filter → Clear peak selection → Cluster toolbar group → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Clear filter to show every read again.', 'wait_for': 'filter_cleared', 'anchor': 'clear-filter'},
           {'type': 'explain', 'text': 'Click Clear peak selection to deselect every peak.', 'anchor': 'peak-clear-selection'},
           {'type': 'explain', 'text': 'In the Cluster controls, pick your rule "TF footprints" in the features dropdown next to the method.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Then click Cluster: the rule decides which footprints define the clusters.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='walk_pol2_workflow', category='tutorial_walks',
       command='add a Pol II footprint class, cluster by my Pol II rule, then select reads in cluster 1',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"add a Pol II footprint class, cluster by my Pol II rule, then select reads in cluster 1": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Reads, Selected footprint, Save (this footprint), Footprints > Saved tab, Cluster toolbar group, Cluster. Their clicks: Reads, Save (this footprint), Cluster, Clusters > Overview tab; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Reads → Selected footprint → Save (this footprint) → Footprints > Saved tab → Cluster toolbar group → Cluster',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF footprint of the kind you want to keep.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'Set the size range to 35-65 bp.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'In the Saved tab, name it Pol II and colour cyan.', 'anchor': 'footprints-saved'},
           {'type': 'explain', 'text': 'In the Cluster controls, pick your rule "Pol II" in the features dropdown next to the method.', 'anchor': 'cluster-toolbar'},
           {'type': 'try_it', 'text': 'Then click Cluster: the rule decides which footprints define the clusters.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
           {'type': 'try_it', 'text': 'Right-click cluster 1 and choose Select reads: every read in it is selected (they show up in Read Stats).', 'wait_for': 'reads_selected', 'anchor': 'clusters-overview'},
       ]),

    _r(id='walk_settings_then_cluster', category='tutorial_walks',
       command='set k=4 with seed paper-v1 then cluster',
       context=V_DM6_2R,
       thinking='"set k=4 with seed paper-v1 then cluster": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, K, Reproducibility, Scan, Peaks track, Cluster. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Cluster controls toggle → K → Reproducibility → Scan → Peaks track → Cluster',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set K to 4.', 'anchor': 'cluster-k'},
           {'type': 'explain', 'text': 'Set the sampling seed to paper-v1: clustering and profiles then pick the same reads every run.', 'anchor': 'reproducibility'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='walk_hide_layer_then_recolor', category='tutorial_walks',
       command='hide the nuc layer and clear my color rules',
       context=V_DM6_2R,
       thinking='"hide the nuc layer and clear my color rules": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Layer toggles, Labeling > Rules tab.',
       summary='Layer toggles → Labeling > Rules tab',
       actions=[
           {'type': 'explain', 'text': 'Click nucleosome in the Layers controls to hide it.', 'anchor': 'layer-toggles'},
           {'type': 'explain', 'text': 'In the Labeling panel, Reset restores the default colour rules and removes your own.', 'anchor': 'labeling-rules'},
       ]),


    # ── tutorial_intent ─────────────────────────────────────────────

    _r(id='explain_find_motifs_for_footprint', category='tutorial_intent',
       command='how do I find motifs for a footprint',
       phrasings=[
           'how do I see what motif a footprint is',
           'what motif is inside this footprint',
           'find the motif at this footprint',
           'tell me how to look up motifs under a footprint',
           'how do I find what TF binds a footprint',
       ],
       context=V_DM6_2R,
       thinking='Motif matches come from analysing a footprint: they Cmd/Ctrl+click it, then the panel lists its motifs. A motif track is the alternative for the whole view.',
       summary='Cmd+click a footprint; its motif matches are listed',
       actions=[
           {'type': 'try_it', 'text': "Cmd/Ctrl+click the footprint you're interested in.", 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs that match it, with their scores; the species line says which JASPAR collection was used.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'To see motif sites along the whole view, load a JASPAR motif track in the Tracks panel.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='explain_get_rid_of_cluster', category='tutorial_intent',
       command='how do I get rid of a cluster',
       phrasings=[
           'how do I delete a cluster',
           'how do I hide a cluster',
           "I don't want this cluster anymore",
           'how do I remove a cluster from my view',
           "what's the difference between hiding and dissolving a cluster",
       ],
       context=V_DM6_2R,
       thinking='Three ways, from reversible to bulk. All live in the Clusters panel, which needs a clustering.',
       summary='Hide, dissolve, or merge similar clusters',
       actions=[
           {'type': 'explain', 'text': 'Hide: click the eye icon on a cluster. Its reads stay assigned and Unhide all brings it back.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': 'Dissolve: right-click the cluster and choose Dissolve; its reads move to their nearest remaining cluster.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': 'In bulk: Merge similar clusters folds tiny clusters and near-duplicates into their nearest cluster; the ⚙ sets how aggressive it is.', 'anchor': 'merge-similar'},
       ]),

    _r(id='explain_navigate', category='tutorial_intent',
       command='how do I navigate the browser',
       phrasings=[
           'how do I move around',
           'how do I get to a different gene',
           'how do I jump to a region',
           'how do I pan and zoom',
       ],
       context=V_DM6_2R,
       thinking='Search first (their turn), then zoom/pan, the best-covered-window jump, and how to go back.',
       summary='Search, zoom and pan, go to reads, go back',
       actions=[
           {'type': 'try_it', 'text': 'Type a gene or coordinates here and press Enter.', 'wait_for': 'navigated', 'anchor': 'search-bar'},
           {'type': 'explain', 'text': 'Zoom in and out here or with the arrow keys; drag inside a track to pan.', 'anchor': 'zoom-in'},
           {'type': 'explain', 'text': 'Go to reads jumps to where the reads are.', 'anchor': 'go-to-reads'},
           {'type': 'explain', 'text': 'To go back, press Cmd+Z or use the ▾ timeline next to Undo.', 'anchor': 'history-timeline'},
       ]),

    _r(id='explain_find_a_gene', category='tutorial_intent',
       command='how do I find a gene',
       phrasings=[
           'how do I look up a gene',
           'where do I search for a gene',
           'how do I jump to a specific gene by name',
       ],
       context=V_DM6_2R,
       thinking="Gene search is the search box; if it finds nothing the annotation is missing, so point at where it's loaded.",
       summary='Search box; gene annotation needed',
       actions=[
           {'type': 'try_it', 'text': "Type the gene's name (e.g. eve); matches from the loaded annotation appear as you type. Pick one or press Enter.", 'wait_for': 'navigated', 'anchor': 'search-bar'},
           {'type': 'explain', 'text': 'No matches? Gene search needs a gene annotation: load a GTF/GFF here, or pick a bundled genome.', 'anchor': 'load-gtf'},
       ]),

    _r(id='explain_change_cluster_method', category='tutorial_intent',
       command='how do I change the cluster method or k',
       phrasings=[
           'how do I switch to hierarchical clustering',
           'how do I change the number of clusters',
           'how do I pick a different clustering algorithm',
       ],
       context=V_DM6_2R,
       thinking='Method and K sit behind the Cluster controls toggle. Show both, then they re-run Cluster themselves (a selected peak is needed).',
       summary='Expand the Cluster controls: method, K, Cluster',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show all the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'The method dropdown: K-means, KMeans++, Hierarchical, HDBSCAN or Combinatorial.', 'anchor': 'cluster-method'},
           {'type': 'explain', 'text': 'K (2-20) is used by K-means and KMeans++; the others choose the number of clusters themselves.', 'anchor': 'cluster-k'},
           {'type': 'try_it', 'text': 'Click Cluster to re-run with the new settings.', 'wait_for': 'clustered', 'anchor': 'cluster-button', 'requires': 'has_selected_peak'},
       ]),

    _r(id='explain_color_reads', category='tutorial_intent',
       command='how do I color reads',
       phrasings=[
           'how do I change the read colors',
           'how do I make TF footprints stand out',
           'how do I color by size',
           'how do I customize colors',
       ],
       context=V_DM6_2R,
       thinking='Colouring is rule-based in the Labeling panel; a single footprint at a position is a saved footprint instead.',
       summary='Labeling panel rules; saved footprints for one position',
       actions=[
           {'type': 'explain', 'text': 'Read colours come from the rules in the Labeling panel, applied top to bottom; drag to reorder.', 'anchor': 'labeling-rules'},
           {'type': 'explain', 'text': 'Add rule: pick a layer (nucleosome, TF, FIRE...), a size range and a colour, or a size gradient.', 'anchor': 'add-label-rule'},
           {'type': 'explain', 'text': 'The checkbox on a rule turns it on or off; the opacity slider fades it.', 'anchor': 'labeling-rules'},
           {'type': 'explain', 'text': 'To colour one footprint at one position, save it in the Footprints panel and set its colour in the Saved tab.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='explain_select_a_footprint', category='tutorial_intent',
       command='how do I select a footprint',
       phrasings=[
           'how do I click on a footprint',
           'how do I pick a specific footprint',
           'what happens when I click a footprint',
       ],
       context=V_DM6_2R,
       thinking='Selecting a footprint is a Cmd/Ctrl+click, which also opens the Footprints panel with its analysis.',
       summary='Hover, then Cmd/Ctrl+click a footprint',
       actions=[
           {'type': 'explain', 'text': 'Hover a footprint (the coloured blocks on each read) to see its size, layer and read.', 'anchor': 'reads-track'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click it to select and analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'The Footprints panel opens with its size range and where it sits; Cmd/Ctrl+click more to add them.', 'anchor': 'selected-footprint'},
       ]),

    _r(id='explain_scan_for_peaks', category='tutorial_intent',
       command='how do I scan for peaks',
       phrasings=[
           'how do I find peaks',
           'what does the scan button do',
           'how does peak detection work',
       ],
       context=V_DM6_2R,
       thinking='They click Scan; then explain where peaks show, how to keep them, and where the rules live.',
       summary='Scan, the Peaks track, lock and rules',
       actions=[
           {'type': 'explain', 'text': 'Peaks are found by the enabled peak rules (FIRE accessibility by default).', 'anchor': 'peaks-toolbar'},
           {'type': 'try_it', 'text': 'Click Scan to detect peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'explain', 'text': 'They appear in the Peaks track above the reads; click one to select it.', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'The lock keeps these peaks when you move the view; peak rules change what is detected.', 'anchor': 'peaks-lock'},
       ]),

    _r(id='explain_lock_peaks', category='tutorial_intent',
       command='how do I lock the peaks',
       phrasings=[
           'how do I freeze my peaks',
           'how do I stop peaks from rescanning',
           'what does the lock icon do',
       ],
       context=V_DM6_2R,
       thinking='The lock is inside the Peaks controls; expanding them reveals it.',
       summary='Peaks controls → lock',
       actions=[
           {'type': 'explain', 'text': 'Click the small Peaks label to show all the peak controls.', 'anchor': 'peaks-controls-expand'},
           {'type': 'explain', 'text': 'Click the lock to freeze the current peaks: they stay put when you pan, zoom or re-scan. Click again to unlock.', 'anchor': 'peaks-lock'},
       ]),

    _r(id='explain_toggle_layers', category='tutorial_intent',
       command='how do I toggle layers',
       phrasings=[
           'how do I hide the nuc layer',
           'how do I show only TF footprints',
           'how do I turn off a footprint type',
       ],
       context=V_DM6_2R,
       thinking="Layer toggles live in the toolbar's Layers group.",
       summary='Layers controls in the toolbar',
       actions=[
           {'type': 'explain', 'text': 'Click the small Layers label to show every layer.', 'anchor': 'layers-controls-expand'},
           {'type': 'explain', 'text': 'Click a layer (nucleosomes, TF footprints, FIRE/MSP, m6A, 5mC, deamination) to show or hide it.', 'anchor': 'layer-toggles'},
       ]),

    _r(id='explain_save_session', category='tutorial_intent',
       command='how do I save my session',
       phrasings=[
           'how do I export my work',
           "how do I save what I'm doing",
           'how do I share this view with a collaborator',
           'how do I save my session so I can come back to it',
           'how do I save my work',
           'how do I save the session',
           'how do I come back to this exact view later',
           'how do I export my analysis to reopen it',
           'can I save where I am and reload it tomorrow',
       ],
       context=V_DM6_2R,
       thinking='Saving is one click (theirs), reopening is Load File; autosave covers crashes.',
       summary='Save downloads a session file; Load File reopens it',
       actions=[
           {'type': 'try_it', 'text': 'Click Save: it downloads a session file with the datasets, view, clusters, rules and colours.', 'wait_for': 'session_saved', 'anchor': 'save-session'},
           {'type': 'explain', 'text': 'Open that file later with Load File (or drag it onto the window) to land exactly where you were.', 'anchor': 'load-dataset'},
           {'type': 'explain', 'text': 'Your work is also auto-saved, and every step stays in the undo timeline.', 'anchor': 'history-timeline'},
       ]),

    _r(id='explain_design_primers', category='tutorial_intent',
       command='how do I design primers',
       phrasings=[
           'how do I make PCR primers',
           'how do I get primers for a region',
           'walk me through primer design',
       ],
       context=V_DM6_2R,
       thinking='Primers need a target peak (skipped if selected), then they click Design primers.',
       summary='Select a peak, Design primers, save to the order list',
       actions=[
           {'type': 'try_it', 'text': 'Click the peak the primers should flank.', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'explain', 'text': 'Open the Primers panel: the Design tab designs around the selected peaks (or the view). Standard, 4C and DAF-C modes.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers.', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Save the pairs you want; the Order List exports an order sheet.', 'anchor': 'primers-order-tab'},
       ]),

    _r(id='explain_make_reads_bigger', category='tutorial_intent',
       command='how do I make reads bigger',
       phrasings=[
           'how do I zoom in on reads',
           'the reads are too small to see',
           'how do I change read height',
       ],
       context=V_DM6_2R,
       thinking='Row height is in the Reads toolbar; sampling fewer reads also makes rows taller.',
       summary='Row height, sample mode, Read Display settings',
       actions=[
           {'type': 'explain', 'text': 'Set a bigger row height here, or Cmd/Ctrl+scroll over the reads.', 'anchor': 'row-height'},
           {'type': 'explain', 'text': 'Switch to a sample of the reads: fewer rows means each one is taller.', 'anchor': 'read-display-mode'},
           {'type': 'explain', 'text': 'Read Display in the sidebar has row height, separators and Fill.', 'anchor': 'read-display-settings'},
       ]),

    _r(id='explain_what_is_fire', category='tutorial_intent',
       command='what is the FIRE rule',
       phrasings=[
           'what does FIRE mean',
           "what's the difference between FIRE and accessibility",
           'what is the default cluster rule',
       ],
       context=V_DM6_2R,
       thinking='FIRE is the default accessibility signal: the peak rule, the layer, and the default clustering feature.',
       summary='FIRE: the default accessibility peak rule',
       actions=[
           {'type': 'explain', 'text': 'FIRE (Fiber-seq Inferred Regulatory Elements) calls accessible stretches on each molecule; the default peak rule scans FIRE accessibility.', 'anchor': 'peak-rules'},
           {'type': 'explain', 'text': 'The FIRE/MSP layer draws those calls on the reads.', 'anchor': 'layer-toggles'},
           {'type': 'explain', 'text': 'Clustering on accessibility uses it too; add a cluster rule to cluster on something else, like TF footprints.', 'anchor': 'rules-cluster-tab'},
       ]),

    _r(id='explain_open_undo_history', category='tutorial_intent',
       command='how do I undo something',
       phrasings=[
           'how do I go back',
           'how do I see what I did',
           'how do I revert a change',
           'how do I undo a mistake',
           'how do I go back a step',
           'I clustered by accident, how do I undo',
           'how do I get back to a previous state',
           'is there an undo',
           'how do I redo',
       ],
       context=V_DM6_2R,
       thinking='Undo is a click (theirs); the timeline and Redo round it out.',
       summary='Undo, the timeline, Redo',
       actions=[
           {'type': 'try_it', 'text': 'Click Undo (or press Cmd+Z).', 'wait_for': 'undo_used', 'anchor': 'undo'},
           {'type': 'explain', 'text': 'The ▾ next to it opens the timeline: jump back to any earlier step.', 'anchor': 'history-timeline'},
           {'type': 'explain', 'text': 'Redo (Cmd+Shift+Z) steps forward again.', 'anchor': 'redo'},
       ]),

    _r(id='explain_query_motif_overlaps', category='tutorial_intent',
       command='how do I check what motifs overlap a region',
       phrasings=[
           'how do I find TF binding sites in a region',
           'what motifs are at this position',
           'how do I look up motifs',
       ],
       context=V_DM6_2R,
       thinking='Motif overlap is visible three ways: a motif track, the motif list of a Cmd/Ctrl+clicked footprint, and a colour rule with a motif condition.',
       summary='Motif track, footprint motif matches, motif colour rules',
       actions=[
           {'type': 'explain', 'text': 'Load a motif track in the Tracks panel (JASPAR names or your own motif); its sites are drawn over the reads.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Or Cmd/Ctrl+click a footprint in the region.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel lists the motifs overlapping it, with scores.', 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'A labeling rule with a motif condition colours every footprint that overlaps a motif site.', 'anchor': 'add-label-rule'},
       ]),

    _r(id='explain_filter_reads', category='tutorial_intent',
       command='how do I filter reads',
       phrasings=[
           'how do I show only certain reads',
           "how do I hide reads I don't want",
           'how do I subset the reads',
       ],
       context=V_DM6_2R,
       thinking='From simplest to most specific: spanning, read-level filters, then a filter rule applied with the Filter button.',
       summary='Spanning only, Read Filters, filter rules',
       actions=[
           {'type': 'explain', 'text': 'Spanning only keeps the reads that cover the whole view.', 'anchor': 'spanning-toggle'},
           {'type': 'explain', 'text': 'Read Filters in the sidebar hide reads by minimum footprints, span or quality.', 'anchor': 'read-filters'},
           {'type': 'explain', 'text': 'For a specific test (e.g. at least 2 TF footprints at the TSS), add a filter rule in Rules > Filter.', 'anchor': 'add-filter-rule'},
           {'type': 'explain', 'text': 'Pick it in the Filter dropdown and click Filter; Clear filter brings every read back.', 'anchor': 'filter-button'},
       ]),

    _r(id='explain_where_is_search_bar', category='tutorial_intent',
       command='where is the search bar',
       phrasings=[
           'where do I type a gene',
           'where is the gene search',
           'where can I enter a region',
       ],
       context=V_DM6_2R,
       thinking='Just point at it.',
       summary='The search box',
       actions=[
           {'type': 'explain', 'text': 'Here: type a gene name or coordinates and press Enter.', 'anchor': 'search-bar'},
       ]),

    _r(id='explain_where_is_cluster_panel', category='tutorial_intent',
       command='where is the cluster panel',
       phrasings=[
           'where do I find clustering',
           'where is the cluster button',
       ],
       context=V_DM6_2R,
       thinking='Open it and show where it opens from next time.',
       summary='Clusters panel',
       actions=[
           {'type': 'open_panel', 'panel_type': 'cluster-detail'},
           {'type': 'explain', 'text': 'It opens from the Clusters button in this strip (and from Cluster details in the Cluster controls).', 'anchor': 'analysis-strip'},
       ]),

    _r(id='explain_where_are_layer_toggles', category='tutorial_intent',
       command='where are the layer toggles',
       phrasings=[
           'where do I hide a layer',
           'where are the nuc/tf checkboxes',
       ],
       context=V_DM6_2R,
       thinking='Point at the layer toggles.',
       summary='Layers group',
       actions=[
           {'type': 'explain', 'text': 'In the Layers group of the toolbar: click a layer to show or hide it.', 'anchor': 'layer-toggles'},
       ]),

    _r(id='explain_where_is_color_editor', category='tutorial_intent',
       command='where do I change colors',
       phrasings=[
           'where is the colormap',
           'where do I edit color rules',
       ],
       context=V_DM6_2R,
       thinking='Open the Labeling panel where colour rules live.',
       summary='Labeling panel',
       actions=[
           {'type': 'open_panel', 'panel_type': 'colormap'},
           {'type': 'explain', 'text': 'Colours are rules in the Labeling panel; Add rule makes a new one.', 'anchor': 'labeling-rules'},
       ]),

    _r(id='explain_where_is_history_panel', category='tutorial_intent',
       command='where is the history panel',
       phrasings=[
           'where do I see my undo history',
           'where can I find earlier snapshots',
       ],
       context=V_DM6_2R,
       thinking='The history is the timeline next to Undo.',
       summary='History timeline next to Undo',
       actions=[
           {'type': 'explain', 'text': 'The ▾ next to Undo opens the history timeline: every step of the session, click one to jump back.', 'anchor': 'history-timeline'},
       ]),

    _r(id='explain_where_is_footprint_panel', category='tutorial_intent',
       command='where is the footprint analysis panel',
       phrasings=[
           'where do I analyze footprints',
           'where is the footprint sizes tab',
       ],
       context=V_DM6_2R,
       thinking='Open it and say what fills it.',
       summary='Footprints panel',
       actions=[
           {'type': 'open_panel', 'panel_type': 'footprint-analysis'},
           {'type': 'explain', 'text': 'It fills in when you Cmd/Ctrl+click a footprint on a read.', 'anchor': 'reads-track'},
       ]),

    _r(id='explain_where_is_primer_panel', category='tutorial_intent',
       command='where do I design primers',
       phrasings=[
           'where is primer design',
           'where do I make PCR primers',
       ],
       context=V_DM6_2R,
       thinking='Open the Primers panel on its Design tab.',
       summary='Primers panel',
       actions=[
           {'type': 'open_panel', 'panel_type': 'primer-design', 'tab': 'design'},
           {'type': 'explain', 'text': 'The Design tab designs primers around the selected peaks or the view.', 'anchor': 'primers-design-tab'},
       ]),

    _r(id='explain_where_is_capture_panel', category='tutorial_intent',
       command='where is the capture cart',
       phrasings=[
           'where do I add capture regions',
           'where is the export cart',
       ],
       context=V_DM6_2R,
       thinking='Open the Capture panel.',
       summary='Capture panel',
       actions=[
           {'type': 'open_panel', 'panel_type': 'capture'},
           {'type': 'explain', 'text': 'Add capture region adds the view or selection; Export saves them as BED, FASTA or probes.', 'anchor': 'capture-add-region'},
       ]),

    _r(id='explain_what_can_i_do_overview', category='tutorial_intent',
       command='what can I do here',
       phrasings=[
           'what can copilot do',
           'what features does this browser have',
           "give me a tour of what's possible",
           'what are my options',
       ],
       context=V_DM6_2R,
       thinking='An overview: point at the main surfaces in the order people use them, ending at the Tour.',
       summary='Search, reads, peaks, clustering, panels, the tour',
       actions=[
           {'type': 'explain', 'text': 'Go anywhere: type a gene or coordinates.', 'anchor': 'search-bar'},
           {'type': 'explain', 'text': 'Each row is one molecule with its footprints; Cmd/Ctrl+click a footprint to analyse it, Shift+click a read to select it.', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'Scan finds accessible peaks; selected peaks feed clustering, sorting and primer design.', 'anchor': 'scan-peaks-button'},
           {'type': 'explain', 'text': 'Cluster groups reads by their footprints at the selected peaks.', 'anchor': 'cluster-toolbar'},
           {'type': 'explain', 'text': 'Each analysis panel opens from here: Clusters, Footprints, Rules, Tracks, Primers and more.', 'anchor': 'analysis-strip'},
           {'type': 'explain', 'text': 'The Tour walks through all of it on a demo dataset; or ask me how to do any one thing.', 'anchor': 'guided-tour'},
       ]),

    _r(id='explain_what_can_i_do_with_cluster_panel', category='tutorial_intent',
       command='what can I do in the cluster panel',
       phrasings=[
           'what does the cluster panel offer',
           'what cluster operations are there',
       ],
       context=V_DM6_2R,
       thinking="Tour of the Clusters panel's tabs; it needs a clustering first.",
       summary='Clusters panel tabs',
       actions=[
           {'type': 'explain', 'text': 'Each cluster with its read count: click to focus, eye to hide, right-click to dissolve or select its reads.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': "Profiles overlays the clusters' average profiles.", 'anchor': 'clusters-profiles', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': "Composition shows each cluster's mix of footprint types.", 'anchor': 'clusters-composition', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': 'V-Plot plots footprint size against position per cluster.', 'anchor': 'clusters-vplot', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': 'Projection shows the reads in 2-D, and previews Merge similar clusters.', 'anchor': 'clusters-projection', 'requires': 'has_clusters'},
       ]),

    _r(id='explain_what_can_i_do_with_footprints', category='tutorial_intent',
       command='what can I do with footprints',
       phrasings=[
           'what footprint operations exist',
           "what's possible with footprint analysis",
       ],
       context=V_DM6_2R,
       thinking='Footprint work starts with a Cmd/Ctrl+click; then what can be done with it.',
       summary='Analyse, save, co-occupancy, classes',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on a read.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'You see its size range and where it sits across molecules.', 'anchor': 'selected-footprint'},
           {'type': 'explain', 'text': 'Save keeps it as a definition, coloured on every read that carries it.', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'Co-occupancy shows which saved footprints occur together, and clusters reads by them.', 'anchor': 'footprints-cooccupancy'},
           {'type': 'explain', 'text': 'Find footprint classes calls the recurring classes in the view across molecules.', 'anchor': 'consensus-caller'},
       ]),

    _r(id='explain_what_can_i_do_with_a_peak', category='tutorial_intent',
       command='what can I do with a peak once I click it',
       phrasings=[
           'what happens when I select a peak',
           'I clicked a peak — now what',
       ],
       context=V_DM6_2R,
       thinking='A selected peak is the input for several tools; select one first (skipped if one is selected).',
       summary='Selected peaks feed cluster, sort, primers, capture',
       actions=[
           {'type': 'try_it', 'text': 'Click a peak to select it.', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'explain', 'text': 'Cluster groups reads by their footprints at the selected peaks.', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Sort by accessibility puts the reads most open at the selected peaks on top.', 'anchor': 'sort-button'},
           {'type': 'explain', 'text': 'Primer design targets the selected peaks.', 'anchor': 'primers-design-tab'},
           {'type': 'explain', 'text': 'Capture adds them as capture regions for export.', 'anchor': 'capture-add-region'},
       ]),

    _r(id='explain_what_is_cluster_focus', category='tutorial_intent',
       command='what does it mean to focus a cluster',
       phrasings=[
           "what's the difference between hiding and focusing a cluster",
           'what does clicking a cluster do',
           'what happens when I click a cluster row',
       ],
       context=V_DM6_2R,
       thinking='Focusing is easiest to understand by doing it once.',
       summary='Click a cluster to focus it',
       actions=[
           {'type': 'try_it', 'text': 'Click a cluster to focus it: its reads stay bright, the others fade.', 'wait_for': 'cluster_focused', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': 'Focus is visual only. Clicking a colour in the bar left of the reads also toggles it; Unhide all shows everything again.', 'anchor': 'cluster-focus-bar', 'requires': 'has_clusters'},
       ]),


    # ── display ─────────────────────────────────────────────────────

    _r(id='prefer_typed_min_footprints_over_filter_rule', category='display',
       command='hide reads with fewer than 5 footprints',
       phrasings=[
           'show only reads with at least 5 footprints',
           'filter to reads with 5+ footprints',
           'drop sparse reads',
           'require at least 5 footprints per read',
           'drop reads with under 5 footprints',
       ],
       context=V_DM6_2R,
       thinking='"hide reads with fewer than 5 footprints": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read Filters.',
       summary='Read Filters',
       actions=[
           {'type': 'explain', 'text': 'Set Min footprints to 5: reads with fewer footprints are hidden.', 'anchor': 'read-filters'},
       ]),


    # ── quality ─────────────────────────────────────────────────────

    _r(id='prefer_typed_quality_over_filter_rule', category='quality',
       command='set min footprint quality to 20',
       phrasings=[
           'drop low-quality footprints',
           'set quality threshold to 20',
       ],
       context=V_DM6_2R,
       thinking='"set min footprint quality to 20": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Quality cutoffs.',
       summary='Quality cutoffs',
       actions=[
           {'type': 'explain', 'text': 'Set the minimum call quality to 20: calls below it are hidden and not counted.', 'anchor': 'quality-cutoffs'},
       ]),


    # ── settings ────────────────────────────────────────────────────

    _r(id='prefer_set_cluster_k_over_new_rule', category='settings',
       command='use 7 clusters and recluster',
       phrasings=[
           'redo clustering with k=7',
           'I want 7 clusters',
       ],
       context=V_DM6_2R,
       thinking='"use 7 clusters and recluster": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster controls toggle, K, Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Cluster controls toggle → K → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Click the small Cluster label to show the rest of the clustering controls.', 'anchor': 'cluster-controls-expand'},
           {'type': 'explain', 'text': 'Set K to 7.', 'anchor': 'cluster-k'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── clustering ──────────────────────────────────────────────────

    _r(id='prefer_explicit_rule_only_when_named', category='clustering',
       command='cluster on TF binding at the TSS',
       phrasings=[
           'cluster reads by TF binding at TSS',
           'make a cluster rule for TF binding at the gene TSS',
       ],
       context=V_DM6_2R,
       thinking='"cluster on TF binding at the TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add cluster rule, Rules > Cluster tab, Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Add cluster rule → Rules > Cluster tab → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Cluster, click Add cluster rule and name it TF at TSS.', 'anchor': 'add-cluster-rule'},
           {'type': 'explain', 'text': 'Add a term for TF footprints 1-89 bp, scoped at the selected peaks; each rule becomes an option in the Cluster controls.', 'anchor': 'rules-cluster-tab'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),


    # ── tutorial_intent ─────────────────────────────────────────────

    _r(id='explain_export_figure', category='tutorial_intent',
       command='how do I export a figure',
       phrasings=[
           'how do I save an image of this region',
           'how do I get a publication figure out of this',
           'how do I export a PNG',
           'how do I make a PDF of the browser view',
           'where do I download the current view as an image',
           'how do I capture this view for a paper',
           'how do I make a figure',
           'export a PDF of this view',
           'save a picture for my paper',
           'how do I export an SVG',
       ],
       context=V_DM6_2R,
       thinking='Figures come from Export in the top bar; data and capture exports are nearby.',
       summary='Export: figure formats and data',
       actions=[
           {'type': 'explain', 'text': 'Click Export in the top bar: PNG for slides, SVG or PDF for editable vector figures. It saves the view as you see it, panel copies included.', 'anchor': 'export-figure'},
           {'type': 'explain', 'text': 'The Data tab exports peaks (BED), clusters (TSV) and regions instead.', 'anchor': 'export-figure'},
           {'type': 'explain', 'text': 'For sequences or probes of chosen regions, use Capture > Export.', 'anchor': 'capture-export'},
       ]),

    _r(id='explain_select_reads', category='tutorial_intent',
       command='how do I select reads',
       phrasings=[
           'how do I pick specific reads',
           'how do I highlight a few reads',
           'how do I select multiple reads',
           'how do I select all reads in a cluster',
           'how do I choose reads to get stats on',
       ],
       context=V_DM6_2R,
       thinking="Selecting reads is Shift+click (theirs), which fills Read Stats; a cluster's reads come from its right-click menu.",
       summary='Shift+click reads; Read Stats',
       actions=[
           {'type': 'try_it', 'text': 'Shift+click a read to select it; Shift+click more to add them.', 'wait_for': 'reads_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'Read Stats sums up the selected reads.', 'anchor': 'read-stats-summary'},
           {'type': 'explain', 'text': 'The Table tab lists them one per row.', 'anchor': 'read-stats-table'},
           {'type': 'explain', 'text': "To select a whole cluster's reads, right-click the cluster in the Clusters panel.", 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='explain_read_colors_layers', category='tutorial_intent',
       command='what do the read colors mean',
       phrasings=[
           'what are the colored bars on the reads',
           'what do the footprint colors represent',
           "what's the difference between m6A, TF, and nucleosome",
           'how do I change what the colors mean',
           'explain the layers to me',
       ],
       context=V_DM6_2R,
       thinking='Colours are the Labeling rules per layer and size; point there, the layer toggles and quality shading.',
       summary='Default colour rules, layers, quality shading',
       actions=[
           {'type': 'explain', 'text': 'By default: nucleosome-sized footprints, TF-sized footprints and accessible (FIRE/MSP) stretches each have a colour; the rules here set them.', 'anchor': 'labeling-rules'},
           {'type': 'explain', 'text': 'Each layer can be shown or hidden here.', 'anchor': 'layer-toggles'},
           {'type': 'explain', 'text': 'The Quality tab shades calls by confidence.', 'anchor': 'labeling-quality'},
       ]),

    _r(id='explain_sort_reads', category='tutorial_intent',
       command='how do I sort the reads',
       phrasings=[
           'how do I order reads by footprint count',
           'how do I sort reads by accessibility',
           'how do I reorder the reads in the track',
           'how do I put the most accessible reads on top',
       ],
       context=V_DM6_2R,
       thinking='Show the Sort dropdown and where custom orders come from, then they click Sort.',
       summary='Sort dropdown, sort rules, Sort',
       actions=[
           {'type': 'explain', 'text': 'The Sort dropdown has built-in orders (e.g. accessibility at the selected peaks, similarity) plus your sort rules.', 'anchor': 'sort-button'},
           {'type': 'explain', 'text': 'Make your own in Rules > Sort: a layer, size range, metric and direction.', 'anchor': 'sort-rules'},
           {'type': 'try_it', 'text': 'Pick one and click Sort.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
       ]),

    _r(id='explain_quality_filter', category='tutorial_intent',
       command='how do I filter out low quality reads',
       phrasings=[
           'how do I hide short reads',
           'how do I only show reads that span the region',
           'how do I set a minimum read length',
           'how do I filter reads by quality',
           'how do I require a minimum number of footprints',
       ],
       context=V_DM6_2R,
       thinking='Low-quality calls vs low-quality reads: toolbar Quality for calls, sidebar Read Filters for reads.',
       summary='Call quality, read filters, spanning only',
       actions=[
           {'type': 'explain', 'text': 'Quality in the toolbar sets how confident a call must be to be drawn and counted.', 'anchor': 'quality-filters'},
           {'type': 'explain', 'text': 'Set a minimum per layer here.', 'anchor': 'quality-cutoffs'},
           {'type': 'explain', 'text': 'Read Filters in the sidebar drop whole reads: minimum footprints, span, gaps.', 'anchor': 'read-filters'},
           {'type': 'explain', 'text': 'Spanning only keeps just the reads covering the whole view.', 'anchor': 'spanning-toggle'},
       ]),

    _r(id='explain_lookup_sequence', category='tutorial_intent',
       command='how do I get the DNA sequence',
       phrasings=[
           'how do I look up the sequence at a region',
           'how do I get the FASTA for this window',
           'how do I see the underlying bases',
           'can I pull the reference sequence',
       ],
       context=V_DM6_2R,
       thinking='Bases need the reference; they show when zoomed in, and Capture exports them as FASTA.',
       summary='Reference FASTA, sequence track, Capture > FASTA',
       actions=[
           {'type': 'explain', 'text': "The sequence comes from the reference FASTA; load it here if it isn't loaded.", 'anchor': 'load-fasta'},
           {'type': 'explain', 'text': 'Zoom in below about 2 kb and the sequence track shows the bases.', 'anchor': 'zoom-in'},
           {'type': 'explain', 'text': 'To copy a sequence, add the region with Add capture region...', 'anchor': 'capture-add-region'},
           {'type': 'explain', 'text': '...and export it as FASTA from Capture > Export.', 'anchor': 'capture-export'},
       ]),

    _r(id='explain_coaccessibility', category='tutorial_intent',
       command='how do I look at co-accessibility',
       phrasings=[
           'what is the co-accessibility matrix',
           'how do I see which sites open together',
           'how do I do a virtual 4C',
           'how do I find co-accessible peaks',
           'explain the co-accessibility panel',
       ],
       context=V_DM6_2R,
       thinking='Open the Co-accessibility panel and explain its views.',
       summary='Co-accessibility panel: matrix, arcs, virtual 4C',
       actions=[
           {'type': 'open_panel', 'panel_type': 'co-accessibility'},
           {'type': 'explain', 'text': 'The matrix scores how often pairs of positions are open on the same molecule; bright off-diagonal blocks open together.', 'anchor': 'coacc-matrix'},
           {'type': 'explain', 'text': 'Switch the track mode to Arcs for the strongest pairs, or Virtual 4C and click a position to see what opens with it.', 'anchor': 'coacc-matrix'},
           {'type': 'explain', 'text': 'Refresh recomputes it after you move the view.', 'anchor': 'coacc-refresh'},
       ]),

    _r(id='explain_add_track', category='tutorial_intent',
       command='how do I add another track',
       phrasings=[
           'how do I load an ATAC track',
           'how do I add a bigWig',
           'how do I overlay a ChIP track',
           'how do I add a track from a URL',
           'how do I show a JASPAR motif track',
       ],
       context=V_DM6_2R,
       thinking='Tracks are added in the Tracks panel; they add one themselves.',
       summary='Tracks panel: hubs, a file or URL, metaprofile',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Browse hubs finds UCSC, ENCODE and ChIP-Atlas tracks for the current genome.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Or paste a BigWig/BigBed/BED path or URL here and click Add.', 'wait_for': 'track_added', 'anchor': 'tracks-add-file'},
           {'type': 'explain', 'text': 'Add metaprofile makes a track from your own reads.', 'anchor': 'tracks-add-metaprofile'},
       ]),

    _r(id='explain_read_stats_panel', category='tutorial_intent',
       command='how do I read the read stats panel',
       phrasings=[
           'what does the read stats panel show',
           'how do I get stats on my reads',
           'explain the read stats panel',
           'how do I see footprint counts per read',
       ],
       context=V_DM6_2R,
       thinking='Read Stats is about selected reads, so a Shift+click comes first (skipped if some are selected).',
       summary='Select reads, then the Summary and Table tabs',
       actions=[
           {'type': 'try_it', 'text': 'Shift+click the reads you want (Shift+click more to add).', 'wait_for': 'reads_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_reads'},
           {'type': 'explain', 'text': 'Summary: counts, span, footprints per read and accessibility for the selected reads.', 'anchor': 'read-stats-summary'},
           {'type': 'explain', 'text': 'Table: one row per read, with MAPQ for BAM data.', 'anchor': 'read-stats-table'},
       ]),

    _r(id='explain_saved_vs_detected_peaks', category='tutorial_intent',
       command="what's the difference between saved and detected peaks",
       phrasings=[
           'why are there two rows of peaks',
           'what does the saved peak row mean',
           'how do I keep a detected peak',
           "what's the detected peaks row for",
           'how do I save a peak I like',
       ],
       context=V_DM6_2R,
       thinking='Detected peaks are transient; drawn peaks and locking keep a set fixed.',
       summary='Detected vs drawn peaks, and the lock',
       actions=[
           {'type': 'explain', 'text': 'Detected peaks come from the last Scan and are replaced when you move the view or scan again.', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'Draw a peak adds your own: click a start and an end on the Peaks track. Drawn peaks stay.', 'anchor': 'peak-draw'},
           {'type': 'explain', 'text': "Lock freezes the detected peaks too, so moving the view doesn't rescan them.", 'anchor': 'peaks-lock'},
       ]),


    # ── sequences ───────────────────────────────────────────────────

    _r(id='sequence_at_selected_gene_tss', category='sequences',
       command='get the sequence around the ftz TSS +/- 100bp',
       phrasings=[
           'FASTA for ftz TSS plus minus 100',
           'pull the reference sequence at the ftz start, 100 bp each side',
       ],
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'ftz'},
       thinking='"get the sequence around the ftz TSS +/- 100bp": I guide them through it rather than doing it. First I move the view to 2R:9,974,500. Then the controls in the order they\'d use them: Add capture region, Capture > Export tab.',
       summary='2R:9,974,500 → Add capture region → Capture > Export tab',
       actions=[
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9974500, 'end': 9974700},
           {'type': 'explain', 'text': 'Click Add capture region to add this view.', 'anchor': 'capture-add-region'},
           {'type': 'explain', 'text': 'Capture > Export saves the regions as FASTA (the sequence comes from the loaded reference).', 'anchor': 'capture-export'},
       ]),


    # ── read_stats ──────────────────────────────────────────────────

    _r(id='read_stats_for_cluster_reads', category='read_stats',
       command='get read stats for the reads in cluster 1',
       phrasings=[
           "stats on cluster 1's reads",
           'summarize the reads in cluster 1',
       ],
       context=V_DM6_2R,
       thinking='"get read stats for the reads in cluster 1": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab, Reads, Read Stats > Summary tab, Read Stats > Table tab. Their clicks: Clusters > Overview tab, Reads; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab → Reads → Read Stats > Summary tab → Read Stats > Table tab',
       actions=[
           {'type': 'try_it', 'text': 'Right-click cluster 1 and choose Select reads: every read in it is selected (they show up in Read Stats).', 'wait_for': 'reads_selected', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': "Shift+click the reads you want stats for (or select a cluster's reads in the Clusters panel).", 'wait_for': 'reads_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'Read Stats sums them up: count, span, footprints per read and accessibility.', 'anchor': 'read-stats-summary'},
           {'type': 'explain', 'text': 'The Table tab has one row per read.', 'anchor': 'read-stats-table'},
       ]),


    # ── session ─────────────────────────────────────────────────────

    _r(id='session_show_manifest_then_export', category='session',
       command="show me what's in the session then export it",
       context=V_DM6_2R,
       thinking='Point at what a session holds, then they click Save.',
       summary='Session contents, then Save',
       actions=[
           {'type': 'explain', 'text': 'The Session section lists what a saved session contains: datasets, view, clusters, rules and colours.', 'anchor': 'session-settings'},
           {'type': 'try_it', 'text': 'Click Save to download it.', 'wait_for': 'session_saved', 'anchor': 'save-session'},
       ]),


    # ── ui_actions ──────────────────────────────────────────────────

    _r(id='toggle_annotation_show_motifs', category='ui_actions',
       command='show the JASPAR motif annotations again',
       phrasings=[
           'turn the motif annotations back on',
           're-enable the JASPAR track',
       ],
       context=V_DM6_2R,
       thinking='"show the JASPAR motif annotations again": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Layer toggles.',
       summary='Layer toggles',
       actions=[
           {'type': 'explain', 'text': 'Click JASPAR in the Layers controls to show it.', 'anchor': 'layer-toggles'},
       ]),


    # ── tracks ──────────────────────────────────────────────────────

    _r(id='track_filter_to_single_motif', category='tracks',
       command='filter track 1 to just CTCF',
       phrasings=[
           'show only CTCF on track 1',
           'narrow track 1 to the CTCF motif',
       ],
       context=V_HG38_MYC,
       thinking='"filter track 1 to just CTCF": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Sub-track settings.',
       summary='Sub-track settings',
       actions=[
           {'type': 'explain', 'text': "Hover the track's label and type CTCF in its filter box to show only those entries.", 'anchor': 'panel-subtracks'},
       ]),


    # ── ui_actions ──────────────────────────────────────────────────

    _r(id='capture_add_gene_region', category='ui_actions',
       command='add the eve locus to my capture list',
       phrasings=[
           'capture the eve region for the figure',
           'add eve to the regions I want to export',
       ],
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"add the eve locus to my capture list": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Add capture region.',
       summary='Add capture region',
       actions=[
           {'type': 'explain', 'text': 'Click Add capture region to add the view and name it eve.', 'anchor': 'capture-add-region'},
       ]),

    _r(id='select_cluster_3_reads_variety', category='ui_actions',
       command='grab all the reads in cluster 3',
       phrasings=[
           "select cluster 3's reads",
           'highlight every read in cluster 3',
       ],
       context=V_DM6_2R,
       thinking='"grab all the reads in cluster 3": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Their clicks: Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Right-click cluster 3 and choose Select reads: every read in it is selected (they show up in Read Stats).', 'wait_for': 'reads_selected', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),


    # ── multi_step ──────────────────────────────────────────────────

    _r(id='flow_gene_scan_cluster_focus_capture', category='multi_step',
       command='go to ftz, scan peaks, cluster, focus the top cluster, and capture it for export',
       context=V_DM6_2R,
       thinking='"go to ftz, scan peaks, cluster, focus the top cluster, and capture it for export": I guide them through it rather than doing it. First I move the view to ftz. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab, Add capture region. Their clicks: Scan, Peaks track, Cluster, Clusters > Overview tab; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='ftz → Scan → Peaks track → Cluster → Clusters > Overview tab → 2R:9,970,000',
       actions=[
           {'type': 'navigate_gene', 'gene': 'ftz', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
           {'type': 'try_it', 'text': 'Click cluster 1 in the list (or its colour in the bar left of the reads) to focus it; the other clusters fade.', 'wait_for': 'cluster_focused', 'anchor': 'clusters-overview'},
           {'type': 'navigate_region', 'chrom': '2R', 'start': 9970000, 'end': 9980000},
           {'type': 'explain', 'text': 'Click Add capture region to add the view and name it ftz cluster 1.', 'anchor': 'capture-add-region'},
       ]),

    _r(id='flow_quality_then_sort_then_stats', category='multi_step',
       command='show only spanning reads, sort by TF count, then give me read stats',
       context=V_DM6_2R,
       thinking='"show only spanning reads, sort by TF count, then give me read stats": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Spanning only, Sort, Reads, Read Stats > Summary tab, Read Stats > Table tab. Their clicks: Sort, Reads; the steps after each wait until it has happened.',
       summary='Spanning only → Sort → Reads → Read Stats > Summary tab → Read Stats > Table tab',
       actions=[
           {'type': 'explain', 'text': 'Tick Spanning only: just the reads that cover the whole view edge to edge.', 'anchor': 'spanning-toggle'},
           {'type': 'try_it', 'text': 'Pick "TF count (desc)" in the Sort dropdown and click Sort.', 'wait_for': 'sorted', 'anchor': 'sort-button'},
           {'type': 'try_it', 'text': "Shift+click the reads you want stats for (or select a cluster's reads in the Clusters panel).", 'wait_for': 'reads_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'Read Stats sums them up: count, span, footprints per read and accessibility.', 'anchor': 'read-stats-summary'},
           {'type': 'explain', 'text': 'The Table tab has one row per read.', 'anchor': 'read-stats-table'},
       ]),

    _r(id='flow_navigate_design_primers_save', category='multi_step',
       command='go to the eve TSS, scan, select the TSS peak, and design primers around it',
       context=V_DM6_2R,
       state_overrides={'selected_gene': 'eve'},
       thinking='"go to the eve TSS, scan, select the TSS peak, and design primers around it": I guide them through it rather than doing it. First I move the view to eve. Then the controls in the order they\'d use them: Scan, Peaks track, Primers > Design tab, Design primers, Primers > Order List tab. Their clicks: Scan, Peaks track, Design primers; the steps after each wait until it has happened.',
       summary='eve → Scan → Peaks track → Primers > Design tab → Design primers → Primers > Order List tab',
       actions=[
           {'type': 'navigate_gene', 'gene': 'eve', 'padding_bp': 5000},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'try_it', 'text': 'Click the peak at 2R:9,974,000 in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'explain', 'text': 'The Design tab designs around the selected peaks, or the view if none are selected.', 'anchor': 'primers-design-tab'},
           {'type': 'try_it', 'text': 'Click Design primers; pairs are ranked by fit (and specificity when BLAST is set up).', 'wait_for': 'primers_designed', 'anchor': 'primers-design-button'},
           {'type': 'explain', 'text': 'Save the pairs you like; the Order List exports them as an order sheet.', 'anchor': 'primers-order-tab'},
       ]),


    # ── negative ────────────────────────────────────────────────────

    _r(id='negative_delete_files', category='negative',
       command='delete the bam file from disk',
       phrasings=[
           'rm the dataset file',
           'remove sample_footprints.bam from my computer',
           'wipe the input files',
       ],
       context=V_DM6_2R,
       thinking="Deleting files is outside the browser; removing it from view is the panel's ×.",
       summary='Close the panel; delete the file yourself',
       warnings=["Copilot can't delete files."],
       actions=[
           {'type': 'explain', 'text': "I can't delete files. To remove the dataset from the browser, close its panel here; delete the file itself outside the app.", 'anchor': 'panel-close'},
       ]),

    _r(id='negative_run_shell', category='negative',
       command='run samtools index on my bam',
       phrasings=[
           'execute a shell command for me',
           'run bedtools intersect on these files',
       ],
       context=V_DM6_2R,
       thinking="Running samtools happens outside the browser, so there's no control to point at; say so.",
       summary="Can't run shell commands",
       warnings=["Copilot can't run shell commands — it only issues safe browser API calls. Run samtools/bedtools in your own terminal."],
       actions=[]),

    _r(id='negative_arbitrary_url_fetch', category='negative',
       command='fetch https://example.com/secret and show me the response',
       phrasings=[
           'download this arbitrary URL and print it',
           'GET this random website for me',
       ],
       context=V_DM6_2R,
       thinking="Fetching a web page isn't something the browser does; only track URLs are loaded, through the Tracks panel.",
       summary="Can't fetch arbitrary URLs",
       warnings=["Copilot can only call the browser's own /api/ endpoints, not arbitrary URLs. To load a remote track, add it as a bigWig/bigBed track URL instead."],
       actions=[]),

    _r(id='negative_navigate_no_coords', category='negative',
       command='go to the interesting part',
       phrasings=[
           'take me somewhere good',
           'show me the best region',
       ],
       context=V_DM6_2R,
       thinking="No resolvable target — no gene, no coordinates, and 'interesting' isn't something the browser can compute without a metric. Ask the user to specify rather than guessing a location.",
       summary='Cannot navigate — no target specified',
       warnings=["I need a target to navigate to — give me a gene symbol (e.g. 'eve') or coordinates (e.g. '2R:9,970,000-9,980,000')."],
       actions=[]),


    # ── dataset_layout ──────────────────────────────────────────────

    _r(id='dataset_layout_open', category='dataset_layout',
       command='open the dataset layout panel',
       phrasings=[
           'show the dataset layout',
           'let me arrange my datasets',
           'open dataset arrangement',
       ],
       context=V_DM6_2R,
       dataset_count=DS_THREE,
       thinking='Open it and say what it does.',
       summary='Layout panel',
       actions=[
           {'type': 'open_panel', 'panel_type': 'dataset-layout'},
           {'type': 'explain', 'text': 'Arrange, rename, link and merge dataset panels here; save layouts as presets.', 'anchor': 'layout-panel'},
       ]),

    _r(id='dataset_rename', category='dataset_layout',
       command='rename the first dataset to WT rep1',
       phrasings=[
           "call the Embryo 2-4hr dataset 'WT rep1'",
           'change the dataset label to WT rep1',
       ],
       context=V_DM6_2R,
       dataset_count=DS_THREE,
       thinking='"rename the first dataset to WT rep1": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Loaded Datasets.',
       summary='Loaded Datasets',
       actions=[
           {'type': 'explain', 'text': "Click the dataset's name here and type WT rep1.", 'anchor': 'loaded-datasets'},
       ]),

    _r(id='dataset_merge_selected', category='dataset_layout',
       command='merge the selected datasets',
       phrasings=[
           'combine these datasets into one',
           'stack the datasets together',
           'merge my datasets',
       ],
       context=V_DM6_2R,
       dataset_count=DS_THREE,
       thinking='"merge the selected datasets": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Layout panel, Merge datasets.',
       summary='Layout panel → Merge datasets',
       actions=[
           {'type': 'open_panel', 'panel_type': 'dataset-layout'},
           {'type': 'explain', 'text': 'Select the datasets you want to combine.', 'anchor': 'layout-panel'},
           {'type': 'explain', 'text': 'Click Merge datasets: their reads are shown together in one panel.', 'anchor': 'layout-merge'},
       ]),

    _r(id='dataset_unmerge', category='dataset_layout',
       command='split the merged dataset back apart',
       phrasings=[
           'unmerge the dataset',
           'separate the merged datasets',
       ],
       context=V_DM6_2R,
       dataset_count=DS_THREE,
       thinking='"split the merged dataset back apart": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Merge datasets.',
       summary='Merge datasets',
       actions=[
           {'type': 'open_panel', 'panel_type': 'dataset-layout'},
           {'type': 'explain', 'text': 'Select the merged dataset and click Unmerge to split it back into its original datasets.', 'anchor': 'layout-merge'},
       ]),

    _r(id='dataset_link_two', category='dataset_layout',
       command='link the first and third datasets so they scroll together',
       phrasings=[
           'sync the Embryo 2-4hr and 5-8hr datasets',
           'keep these two datasets in sync',
       ],
       context=V_DM6_2R,
       dataset_count=DS_THREE,
       thinking='"link the first and third datasets so they scroll together": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Layout panel, Link datasets.',
       summary='Layout panel → Link datasets',
       actions=[
           {'type': 'open_panel', 'panel_type': 'dataset-layout'},
           {'type': 'explain', 'text': 'Select the panels you want to move together.', 'anchor': 'layout-panel'},
           {'type': 'explain', 'text': 'Click Link datasets: they now pan and zoom as one.', 'anchor': 'layout-link'},
       ]),

    _r(id='dataset_unlink', category='dataset_layout',
       command='unlink the third dataset',
       phrasings=[
           'let the Embryo 5-8hr dataset scroll on its own',
           'detach that dataset from its link group',
       ],
       context=V_DM6_2R,
       dataset_count=DS_THREE,
       thinking='"unlink the third dataset": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Link datasets.',
       summary='Link datasets',
       actions=[
           {'type': 'open_panel', 'panel_type': 'dataset-layout'},
           {'type': 'explain', 'text': 'Select the panel and click Unlink so it moves on its own.', 'anchor': 'layout-link'},
       ]),


    # ── clustering ──────────────────────────────────────────────────

    _r(id='cluster_select_one', category='clustering',
       command='select cluster 2',
       phrasings=[
           'add cluster 2 to the selection',
           'pick cluster 2',
       ],
       context=V_DM6_2R,
       thinking='"select cluster 2": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Tick clusters 2 in the list to select them.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='cluster_select_many', category='clustering',
       command='select clusters 1, 3 and 4',
       phrasings=[
           'select clusters 1 3 4',
           'highlight clusters 1, 3, and 4',
       ],
       context=V_DM6_2R,
       thinking='"select clusters 1, 3 and 4": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Tick clusters 1, 3 and 4 in the list to select them.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='cluster_clear_selection', category='clustering',
       command='clear the cluster selection',
       phrasings=[
           'deselect all clusters',
           'unselect the clusters',
       ],
       context=V_DM6_2R,
       thinking='"clear the cluster selection": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Untick the selected clusters (or click Clear selection) to deselect them all.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='cluster_merge_two', category='clustering',
       command='merge clusters 1 and 2',
       phrasings=[
           'combine cluster 1 and cluster 2',
           'join clusters 1 and 2 into one',
           'fold cluster 2 into cluster 1',
       ],
       context=V_DM6_2R,
       thinking='"merge clusters 1 and 2": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Their clicks: Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Tick clusters 1 and 2 in the list to select them.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'Then click Merge selected: their reads become one cluster.', 'wait_for': 'clusters_merged', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='cluster_merge_selected', category='clustering',
       command='merge the selected clusters',
       phrasings=[
           'combine the clusters I selected',
           'merge my selected clusters',
       ],
       context=V_DM6_2R,
       thinking='"merge the selected clusters": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Their clicks: Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Tick the clusters you want to combine.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'Then click Merge selected: their reads become one cluster.', 'wait_for': 'clusters_merged', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='cluster_lock_order', category='clustering',
       command='lock the cluster order',
       phrasings=[
           'freeze the cluster order',
           "don't reshuffle clusters when I sort",
           'keep clusters in this order',
       ],
       context=V_DM6_2R,
       thinking='"lock the cluster order": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Lock cluster order. Where a control needs something first, the step asks for it.',
       summary='Lock cluster order',
       actions=[
           {'type': 'explain', 'text': 'Click Lock cluster order: clusters keep their order when you re-sort, re-cluster or zoom.', 'anchor': 'cluster-order-lock', 'requires': 'has_clusters'},
       ]),

    _r(id='cluster_unlock_order', category='clustering',
       command='unlock the cluster order',
       phrasings=[
           'let sorting reorder the clusters again',
           'stop freezing the cluster order',
       ],
       context=V_DM6_2R,
       thinking='"unlock the cluster order": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Lock cluster order. Where a control needs something first, the step asks for it.',
       summary='Lock cluster order',
       actions=[
           {'type': 'explain', 'text': 'Click Lock cluster order again to unlock it, so sorting can reorder the clusters.', 'anchor': 'cluster-order-lock', 'requires': 'has_clusters'},
       ]),


    # ── display ─────────────────────────────────────────────────────

    _r(id='read_row_height_px', category='display',
       command='make the reads 8 pixels tall',
       phrasings=[
           'set read row height to 8',
           'shrink reads to 8px rows',
           '8 pixel rows',
       ],
       context=V_DM6_2R,
       thinking='"make the reads 8 pixels tall": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read row height.',
       summary='Read row height',
       actions=[
           {'type': 'explain', 'text': 'Set the row height to 8 px (Cmd/Ctrl+scroll over the reads also changes it).', 'anchor': 'row-height'},
       ]),

    _r(id='read_row_height_auto', category='display',
       command='fit the reads to the track height',
       phrasings=[
           'auto-size the read rows',
           'make reads fill the available height',
           'auto read height',
       ],
       context=V_DM6_2R,
       thinking='"fit the reads to the track height": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read row height.',
       summary='Read row height',
       actions=[
           {'type': 'explain', 'text': 'Set the row height to Auto: the reads fill the track height.', 'anchor': 'row-height'},
       ]),

    _r(id='read_fill_on', category='display',
       command='expand sparse reads to fill the track',
       phrasings=[
           'turn on fill read height',
           'fill the track with reads',
           'stretch reads to fill',
       ],
       context=V_DM6_2R,
       thinking='"expand sparse reads to fill the track": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read Display.',
       summary='Read Display',
       actions=[
           {'type': 'explain', 'text': 'Turn on Fill: when there are few reads, rows stretch to fill the track.', 'anchor': 'read-display-settings'},
       ]),

    _r(id='read_separator_off', category='display',
       command='remove the lines between reads',
       phrasings=[
           'turn off read separators',
           'no gaps between reads',
           'hide the separator lines',
       ],
       context=V_DM6_2R,
       thinking='"remove the lines between reads": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read Display.',
       summary='Read Display',
       actions=[
           {'type': 'explain', 'text': 'Set Separators to Off to remove the lines between reads.', 'anchor': 'read-display-settings'},
       ]),

    _r(id='read_separator_fixed_width', category='display',
       command='use fixed 2px separators between reads',
       phrasings=[
           'fixed read separators 2 pixels',
           'set separator width to 2',
       ],
       context=V_DM6_2R,
       thinking='"use fixed 2px separators between reads": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read Display.',
       summary='Read Display',
       actions=[
           {'type': 'explain', 'text': 'Set Separators to Fixed for a constant line between reads.', 'anchor': 'read-display-settings'},
           {'type': 'explain', 'text': 'Set the separator width to 2 px.', 'anchor': 'read-display-settings'},
       ]),

    _r(id='layer_bg_opacity_nuc', category='display',
       command='dim the nucleosome background to 30%',
       phrasings=[
           'set nuc background opacity to 0.3',
           'make the nucleosome layer background fainter',
       ],
       context=V_DM6_2R,
       thinking='"dim the nucleosome background to 30%": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read Display.',
       summary='Read Display',
       actions=[
           {'type': 'explain', 'text': 'Set the nucleosome background opacity to 30%.', 'anchor': 'read-display-settings'},
       ]),


    # ── motifs ──────────────────────────────────────────────────────

    _r(id='motif_threshold_set', category='motifs',
       command='set the motif score threshold to 0.9',
       phrasings=[
           'make motif matching stricter, 0.9',
           'raise the motif cutoff to 0.9',
       ],
       context=V_DM6_2R,
       thinking='"set the motif score threshold to 0.9": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Set the motif score threshold slider to 0.9: higher keeps only stronger matches.', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='motif_jaspar_by_name', category='motifs',
       command='load CTCF and GATA1 motif tracks',
       phrasings=[
           'add JASPAR motifs for CTCF and GATA1',
           'show me CTCF and GATA1 binding motifs',
           'load the CTCF motif',
       ],
       context=V_HG38_MYC,
       thinking='"load CTCF and GATA1 motif tracks": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Type CTCF, GATA1 in the JASPAR box.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Click Load: each motif is drawn as a track of its sites.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='motif_add_sequence', category='motifs',
       command='find the TGASTCA motif in this region',
       phrasings=[
           'add an AP-1 (TGASTCA) motif track',
           'scan for the TGASTCA sequence motif',
       ],
       context=V_DM6_2R,
       thinking='"find the TGASTCA motif in this region": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'In the motif box, enter the IUPAC sequence TGASTCA; the threshold slider sets how strict matches are.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Click Add motif: its sites are drawn as a track.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),

    _r(id='motif_add_pwm', category='motifs',
       command='add a custom PWM motif track called myTF',
       phrasings=[
           'load a position weight matrix motif',
           'add a custom PWM',
       ],
       context=V_DM6_2R,
       thinking='"add a custom PWM motif track called myTF": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Browse hubs. Their clicks: Browse hubs; the steps after each wait until it has happened.',
       summary='Browse hubs',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'In the motif box, enter your PWM counts and name it myTF; the threshold slider sets how strict matches are.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Click Add motif: its sites are drawn as a track.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),


    # ── tutorial_intent ─────────────────────────────────────────────

    _r(id='teach_dataset_layout_panel', category='tutorial_intent',
       command='walk me through the dataset layout panel',
       phrasings=[
           'explain the dataset layout panel',
           'how do I arrange my datasets',
           'how do I merge two datasets',
           'how do I rename a dataset',
           'how do I link datasets so they scroll together',
           'what does the dataset layout panel do?',
       ],
       context=V_DM6_2R,
       dataset_count=DS_THREE,
       thinking='Open the Layout panel and point at its three jobs: arranging, linking and merging; renaming lives in Loaded Datasets too.',
       summary='Layout panel: arrange, link, merge, rename',
       actions=[
           {'type': 'open_panel', 'panel_type': 'dataset-layout'},
           {'type': 'explain', 'text': 'The Layout panel lists your dataset panels: drag to arrange them, rename them, and save layout presets.', 'anchor': 'layout-panel'},
           {'type': 'explain', 'text': 'Select two or more panels and click Link datasets: they pan and zoom together.', 'anchor': 'layout-link'},
           {'type': 'explain', 'text': "Merge datasets combines the selected datasets' reads in one panel; Unmerge splits them again.", 'anchor': 'layout-merge'},
           {'type': 'explain', 'text': "The sidebar's Loaded Datasets list also renames and recolours datasets.", 'anchor': 'loaded-datasets'},
       ]),

    _r(id='explain_merge_clusters', category='tutorial_intent',
       command='how do I merge clusters',
       phrasings=[
           'how do I combine two clusters',
           'how do I join clusters together',
           'can I merge clusters into one',
       ],
       context=V_DM6_2R,
       thinking='Merging is ticking clusters and clicking Merge (theirs), or the automatic Merge similar.',
       summary='Tick clusters, Merge selected; or Merge similar',
       actions=[
           {'type': 'explain', 'text': 'Tick the clusters you want to combine.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'Click Merge selected: their reads become one cluster.', 'wait_for': 'clusters_merged', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': 'Merge similar clusters does it automatically for tiny clusters and near-duplicates.', 'anchor': 'merge-similar'},
       ]),

    _r(id='explain_read_display', category='tutorial_intent',
       command='how do I change the read height and spacing',
       phrasings=[
           'how do I make reads taller or shorter',
           'how do I add gaps between reads',
           'how do I change read row height',
           'how do I remove the lines between reads',
       ],
       context=V_DM6_2R,
       thinking="Height is in the Reads toolbar; fill and separators in the sidebar's Read Display.",
       summary='Row height and Read Display settings',
       actions=[
           {'type': 'explain', 'text': 'Row height: set a number of pixels, Auto to fit the track, or Cmd/Ctrl+scroll over the reads.', 'anchor': 'row-height'},
           {'type': 'explain', 'text': 'Read Display in the sidebar: Fill stretches sparse reads to the track height; Separators (Auto, Fixed, Off) sets the lines between reads.', 'anchor': 'read-display-settings'},
       ]),

    _r(id='explain_custom_motif', category='tutorial_intent',
       command='how do I add my own motif',
       phrasings=[
           'how do I load a JASPAR motif',
           'how do I add a PWM motif',
           'how do I search for a sequence motif',
           'how do I show TF binding motifs',
       ],
       context=V_DM6_2R,
       thinking='Custom motifs are added in the Tracks panel; they click Load themselves.',
       summary='Tracks panel: JASPAR, sequence or PWM motif',
       actions=[
           {'type': 'open_panel', 'panel_type': 'track-browser'},
           {'type': 'explain', 'text': 'Type TF names or JASPAR IDs (e.g. CTCF, GATA1) in the JASPAR box, or enter your own IUPAC sequence (TGASTCA) or PWM.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'explain', 'text': 'The score threshold slider (0.5-1.0) sets how strict matches are.', 'anchor': 'tracks-browse-hubs'},
           {'type': 'try_it', 'text': 'Click Load (or Add motif): its sites are drawn as a track.', 'wait_for': 'track_added', 'anchor': 'tracks-browse-hubs'},
       ]),


    # ── tutorial_walks ──────────────────────────────────────────────

    _r(id='walk_select_two_clusters_then_merge', category='tutorial_walks',
       command='select clusters 2 and 3 and merge them',
       context=V_DM6_2R,
       thinking='"select clusters 2 and 3 and merge them": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab. Their clicks: Clusters > Overview tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Tick clusters 2 and 3 in the list to select them.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'Then click Merge selected: their reads become one cluster.', 'wait_for': 'clusters_merged', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),

    _r(id='walk_layout_label_then_link', category='tutorial_walks',
       command='rename the first dataset to WT and link it with the third',
       context=V_DM6_2R,
       dataset_count=DS_THREE,
       thinking='"rename the first dataset to WT and link it with the third": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Loaded Datasets, Layout panel, Link datasets.',
       summary='Loaded Datasets → Layout panel → Link datasets',
       actions=[
           {'type': 'open_panel', 'panel_type': 'dataset-layout'},
           {'type': 'explain', 'text': "Click the dataset's name here and type WT.", 'anchor': 'loaded-datasets'},
           {'type': 'explain', 'text': 'Select the panels you want to move together.', 'anchor': 'layout-panel'},
           {'type': 'explain', 'text': 'Click Link datasets: they now pan and zoom as one.', 'anchor': 'layout-link'},
       ]),

    _r(id='walk_tighten_read_display', category='tutorial_walks',
       command='tighten the read display: small rows, no separators',
       context=V_DM6_2R,
       thinking='"tighten the read display: small rows, no separators": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Read row height, Read Display.',
       summary='Read row height → Read Display',
       actions=[
           {'type': 'explain', 'text': 'Set the row height to 5 px (Cmd/Ctrl+scroll over the reads also changes it).', 'anchor': 'row-height'},
           {'type': 'explain', 'text': 'Set Separators to Off to remove the lines between reads.', 'anchor': 'read-display-settings'},
       ]),


    # ── negative ────────────────────────────────────────────────────

    _r(id='negative_link_one_dataset', category='negative',
       command='link just the first dataset',
       context=V_DM6_2R,
       dataset_count=DS_THREE,
       thinking='A link group of one is meaningless; show where to select two.',
       summary='Pick a second panel to link',
       warnings=['Linking needs at least two datasets.'],
       actions=[
           {'type': 'open_panel', 'panel_type': 'dataset-layout'},
           {'type': 'explain', 'text': 'Linking needs two or more panels: select the first dataset and a second one, then click Link datasets.', 'anchor': 'layout-link'},
       ]),


    # ── clustering ──────────────────────────────────────────────────

    _r(id='subcluster_one', category='clustering',
       command='subcluster cluster 2',
       phrasings=[
           'drill into cluster 2',
           're-cluster the reads in cluster 2',
           'break cluster 2 into sub-clusters',
           'split cluster 2 further',
       ],
       context=V_DM6_2R,
       thinking='"subcluster cluster 2": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab, Cluster, Cluster branch map. Their clicks: Cluster; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab → Cluster → Cluster branch map',
       actions=[
           {'type': 'explain', 'text': 'Tick cluster 2 to select it.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'With clusters selected, Cluster re-clusters only their reads, into a branch under the current clustering.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'The branch map shows the parent clustering and the new branch; click either to switch between them.', 'anchor': 'cluster-branches'},
       ]),

    _r(id='subcluster_multi', category='clustering',
       command='drill into clusters 1 and 3',
       phrasings=[
           'subcluster clusters 1 and 3 together',
           're-cluster reads from clusters 1 and 3',
       ],
       context=V_DM6_2R,
       thinking='"drill into clusters 1 and 3": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Clusters > Overview tab, Cluster, Cluster branch map. Their clicks: Cluster; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Clusters > Overview tab → Cluster → Cluster branch map',
       actions=[
           {'type': 'explain', 'text': 'Tick clusters 1 and 3 to select them.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'With clusters selected, Cluster re-clusters only their reads, into a branch under the current clustering.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'The branch map shows the parent clustering and the new branch; click either to switch between them.', 'anchor': 'cluster-branches'},
       ]),

    _r(id='dynamic_clustering_on', category='clustering',
       command='turn on dynamic reassignment',
       phrasings=[
           'reassign reads to clusters as I navigate',
           'enable dynamic clustering',
           'keep clusters updated as the viewport moves',
       ],
       context=V_DM6_2R,
       thinking='"turn on dynamic reassignment": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Dynamic reassignment. Where a control needs something first, the step asks for it.',
       summary='Dynamic reassignment',
       actions=[
           {'type': 'explain', 'text': 'Tick Dynamic reassignment: as you pan, reads are reassigned to the nearest cluster.', 'anchor': 'cluster-dynamic', 'requires': 'has_clusters'},
       ]),

    _r(id='dynamic_overlap_conservative', category='clustering',
       command='make dynamic reassignment conservative',
       phrasings=[
           'only reassign reads that overlap every clustering peak',
           'set dynamic overlap to conservative',
           'be strict about dynamic reassignment',
       ],
       context=V_DM6_2R,
       thinking='"make dynamic reassignment conservative": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Dynamic reassignment. Where a control needs something first, the step asks for it.',
       summary='Dynamic reassignment',
       actions=[
           {'type': 'explain', 'text': 'Next to it, set the overlap mode to Conservative: Conservative only reassigns reads that overlap every clustering peak (others go to Unassigned).', 'anchor': 'cluster-dynamic', 'requires': 'has_clusters'},
       ]),

    _r(id='dynamic_on_then_aggressive', category='clustering',
       command='turn on dynamic reassignment in aggressive mode',
       phrasings=[
           'enable dynamic clustering, aggressive overlap',
       ],
       context=V_DM6_2R,
       thinking='"turn on dynamic reassignment in aggressive mode": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Dynamic reassignment. Where a control needs something first, the step asks for it.',
       summary='Dynamic reassignment',
       actions=[
           {'type': 'explain', 'text': 'Tick Dynamic reassignment: as you pan, reads are reassigned to the nearest cluster.', 'anchor': 'cluster-dynamic', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': 'Next to it, set the overlap mode to Aggressive: Aggressive reassigns any read that overlaps at least one clustering peak.', 'anchor': 'cluster-dynamic', 'requires': 'has_clusters'},
       ]),

    _r(id='branch_capture', category='clustering',
       command='save this clustering as a branch called baseline',
       phrasings=[
           "snapshot the current clusters as 'baseline'",
           'save the current clustering',
           'checkpoint these clusters',
       ],
       context=V_DM6_2R,
       thinking='"save this clustering as a branch called baseline": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Snapshot. Where a control needs something first, the step asks for it.',
       summary='Snapshot',
       actions=[
           {'type': 'explain', 'text': 'Click Snapshot to save this clustering and name it baseline; it is listed in the Saved tab.', 'anchor': 'cluster-snapshot', 'requires': 'has_clusters'},
       ]),

    _r(id='branch_switch', category='clustering',
       command='go back to the baseline branch',
       phrasings=[
           'switch to the baseline clustering',
           'restore the baseline branch',
           'jump back to branch baseline',
       ],
       context=V_DM6_2R,
       thinking='"go back to the baseline branch": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster branch map. Where a control needs something first, the step asks for it.',
       summary='Cluster branch map',
       actions=[
           {'type': 'explain', 'text': 'Click the baseline branch in the branch map to switch back to it.', 'anchor': 'cluster-branches', 'requires': 'has_clusters'},
       ]),

    _r(id='branch_rename', category='clustering',
       command='rename the current branch to paused Pol II',
       phrasings=[
           "rename this cluster branch to 'paused Pol II'",
           "call the active branch 'paused Pol II'",
       ],
       context=V_DM6_2R,
       thinking='"rename the current branch to paused Pol II": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster branch map. Where a control needs something first, the step asks for it.',
       summary='Cluster branch map',
       actions=[
           {'type': 'explain', 'text': "Double-click the current branch's name in the branch map and type paused Pol II.", 'anchor': 'cluster-branches', 'requires': 'has_clusters'},
       ]),

    _r(id='branch_delete', category='clustering',
       command='delete the C2 subcluster branch',
       phrasings=[
           'remove the C2 branch',
           'drop the branch named C2',
       ],
       context=V_DM6_2R,
       thinking='"delete the C2 subcluster branch": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Cluster branch map. Where a control needs something first, the step asks for it.',
       summary='Cluster branch map',
       actions=[
           {'type': 'explain', 'text': 'Right-click the C2 branch in the branch map and choose Delete.', 'anchor': 'cluster-branches', 'requires': 'has_clusters'},
       ]),


    # ── tutorial_walks ──────────────────────────────────────────────

    _r(id='walk_cluster_then_subcluster_then_branch', category='tutorial_walks',
       command='cluster, drill into cluster 1, then save it as a branch',
       context=V_DM6_2R,
       thinking='"cluster, drill into cluster 1, then save it as a branch": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab, Cluster branch map, Snapshot. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab → Cluster → Cluster branch map',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak you want in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track', 'skip_if': 'has_selected_peak'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
           {'type': 'explain', 'text': 'Tick cluster 1 to select it.', 'anchor': 'clusters-overview'},
           {'type': 'try_it', 'text': 'With clusters selected, Cluster re-clusters only their reads, into a branch under the current clustering.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'The branch map shows the parent clustering and the new branch; click either to switch between them.', 'anchor': 'cluster-branches'},
           {'type': 'explain', 'text': 'Click Snapshot to save this clustering and name it C1 subclusters; it is listed in the Saved tab.', 'anchor': 'cluster-snapshot'},
       ]),


    # ── tutorial_intent ─────────────────────────────────────────────

    _r(id='teach_cluster_branches', category='tutorial_intent',
       command='walk me through cluster branches and subclustering',
       phrasings=[
           'explain the cluster tree',
           'how do I subcluster',
           'what are cluster branches',
           'how does the cluster branch tree work',
           'how do I drill into a cluster',
           'how do I go back to a previous clustering',
       ],
       context=V_DM6_2R,
       thinking='Subclustering starts from existing clusters (required). They tick clusters and click Cluster themselves; then the branch map, Snapshot and the Saved tab.',
       summary='Select clusters, recluster into a branch, switch and snapshot',
       actions=[
           {'type': 'explain', 'text': 'Tick the clusters you want to drill into.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'try_it', 'text': 'With clusters selected, Cluster re-clusters only their reads, into a branch under the current clustering.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'The branch map shows the parent clustering and each branch; click one to switch to it.', 'anchor': 'cluster-branches'},
           {'type': 'explain', 'text': 'Snapshot saves the current clustering so you can come back to it.', 'anchor': 'cluster-snapshot'},
           {'type': 'explain', 'text': 'The Saved tab lists snapshots; click one to restore it.', 'anchor': 'clusters-saved'},
       ]),

    _r(id='explain_dynamic_reassignment', category='tutorial_intent',
       command='how does dynamic reassignment work',
       phrasings=[
           'what is dynamic cluster reassignment',
           'how do I keep clusters updated as I scroll',
           "what's the difference between conservative and aggressive overlap",
           'how do I reassign reads to clusters automatically',
       ],
       context=V_DM6_2R,
       thinking='A setting in the Clusters panel; needs a clustering.',
       summary='Dynamic reassignment and its overlap mode',
       actions=[
           {'type': 'explain', 'text': 'Tick Dynamic reassignment: as you pan and zoom, reads are reassigned to the nearest cluster using the stored patterns or centroids.', 'anchor': 'cluster-dynamic', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': 'The overlap mode sets how strict: Conservative only reassigns reads overlapping every clustering peak, Aggressive any read overlapping one.', 'anchor': 'cluster-dynamic', 'requires': 'has_clusters'},
       ]),

    _r(id='explain_unassigned_bucket', category='tutorial_intent',
       command='what is the unassigned cluster',
       phrasings=[
           'why is there an unassigned bucket',
           'what does unassigned mean in clustering',
           'where do reads with no cluster go',
       ],
       context=V_DM6_2R,
       thinking='Explain where Unassigned comes from, in the Clusters panel.',
       summary='The Unassigned bucket',
       actions=[
           {'type': 'explain', 'text': 'When you subcluster, reads outside the chosen clusters collect in Unassigned so every read still appears; Conservative dynamic reassignment puts reads there too.', 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
           {'type': 'explain', 'text': "It's hidden by default; focus it like any cluster to inspect those reads.", 'anchor': 'clusters-overview', 'requires': 'has_clusters'},
       ]),


    # ── strands ─────────────────────────────────────────────────────

    _r(id='strand_show_ct', category='strands',
       command='show only the CT strand',
       phrasings=[
           'just the C to T reads',
           'filter to CT strand reads',
           'hide the GA strand',
           'only show C→T molecules',
       ],
       context=V_DM6_2R,
       thinking='"show only the CT strand": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Strand chip.',
       summary='Strand chip',
       actions=[
           {'type': 'explain', 'text': 'Click the strand chip in the panel header and choose CT: only CT reads are shown.', 'anchor': 'strand-chip'},
       ]),

    _r(id='strand_show_ga', category='strands',
       command='show only GA strand reads',
       phrasings=[
           'G to A strand only',
           'filter the DAF panel to the GA strand',
           'hide the CT reads',
       ],
       context=V_DM6_2R,
       thinking='"show only GA strand reads": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Strand chip.',
       summary='Strand chip',
       actions=[
           {'type': 'explain', 'text': 'Click the strand chip in the panel header and choose GA: only GA reads are shown.', 'anchor': 'strand-chip'},
       ]),

    _r(id='strand_show_both', category='strands',
       command='show both strands again',
       phrasings=[
           'stop filtering by strand',
           'go back to all reads, both strands',
           'remove the strand filter',
       ],
       context=V_DM6_2R,
       thinking='"show both strands again": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Strand chip.',
       summary='Strand chip',
       actions=[
           {'type': 'explain', 'text': 'Click the strand chip and choose Both strands to put the strands back together.', 'anchor': 'strand-chip'},
       ]),

    _r(id='strand_split', category='strands',
       command='show the two strands side by side',
       phrasings=[
           'split the DAF panel by strand',
           'CT and GA next to each other',
           'compare the strands side by side',
           'split into CT | GA',
       ],
       context=V_DM6_2R,
       thinking='"show the two strands side by side": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Strand chip, Split into CT and GA panels. Their clicks: Split into CT and GA panels; the steps after each wait until it has happened.',
       summary='Strand chip → Split into CT and GA panels',
       actions=[
           {'type': 'explain', 'text': 'DAF-seq deaminates one strand of each molecule; the strand chip in the panel header chooses CT, GA or both.', 'anchor': 'strand-chip'},
           {'type': 'try_it', 'text': 'Choose Split into CT and GA panels: CT reads here, GA reads in a copy beside it.', 'wait_for': 'strand_split', 'anchor': 'split-by-strand'},
       ]),

    _r(id='strand_split_then_cluster', category='strands',
       command='split by strand and cluster each on the eve TSS peak',
       phrasings=[
           'cluster the eve TSS separately for each strand',
           'compare strand clusters at eve',
       ],
       context=V_DM6_2R,
       thinking='"split by strand and cluster each on the eve TSS peak": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Strand chip, Split into CT and GA panels, Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Split into CT and GA panels, Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Strand chip → Split into CT and GA panels → Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'DAF-seq deaminates one strand of each molecule; the strand chip in the panel header chooses CT, GA or both.', 'anchor': 'strand-chip'},
           {'type': 'try_it', 'text': 'Choose Split into CT and GA panels: CT reads here, GA reads in a copy beside it.', 'wait_for': 'strand_split', 'anchor': 'split-by-strand'},
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='strand_quantify_better_strand', category='strands',
       command='quantify footprints on the CT strand only',
       phrasings=[
           'run footprint analysis on just the CT reads',
           'analyze footprints for the better-fit strand, CT',
       ],
       context=V_DM6_2R,
       thinking='"quantify footprints on the CT strand only": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Strand chip, Reads, Selected footprint, Footprints > Classes tab. Their clicks: Reads; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Strand chip → Reads → Selected footprint → Footprints > Classes tab',
       actions=[
           {'type': 'explain', 'text': 'Click the strand chip in the panel header and choose CT: only CT reads are shown.', 'anchor': 'strand-chip'},
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on any read to analyse it.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'The Footprints panel shows its size range and where it sits across the reads.', 'anchor': 'selected-footprint'},
           {'type': 'explain', 'text': 'Classes lists the recurring footprint classes here, with their sizes and matching motifs.', 'anchor': 'footprints-classes'},
       ]),


    # ── tutorial_intent ─────────────────────────────────────────────

    _r(id='explain_strands', category='tutorial_intent',
       command='what are the CT and GA strands',
       phrasings=[
           'why would I split by strand',
           'how do strands work for DAF-seq',
           'what does the strand chip do',
       ],
       context=V_DM6_2R,
       thinking='Explain the strands and let them split the panel.',
       summary='Strand chip, split CT | GA, compare strands',
       actions=[
           {'type': 'explain', 'text': 'DAF-seq deaminates one strand of each molecule, so each read is C→T (CT) or G→A (GA). The strand chip chooses CT, GA or both.', 'anchor': 'strand-chip'},
           {'type': 'try_it', 'text': 'Choose Split into CT and GA panels to see them side by side.', 'wait_for': 'strand_split', 'anchor': 'split-by-strand'},
           {'type': 'explain', 'text': 'In the Footprints panel, Compare strands shows which strand calls each class better.', 'anchor': 'footprints-classes'},
       ]),


    # ── panel_copies ────────────────────────────────────────────────

    _r(id='copy_panel_linked', category='panel_copies',
       command='add a copy of this panel',
       phrasings=[
           'duplicate the panel',
           'make another copy of the dataset panel',
           'open a second view of this dataset',
       ],
       context=V_DM6_2R,
       thinking='"add a copy of this panel": I guide them through it rather than doing it. Then the controls in the order they\'d use them: + Add a copy, Link / Unlink. Their clicks: + Add a copy; the steps after each wait until it has happened.',
       summary='+ Add a copy → Link / Unlink',
       actions=[
           {'type': 'try_it', 'text': "Hover the dataset panel's header and click + to add a copy.", 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy'},
           {'type': 'explain', 'text': 'It follows the main view while linked; Unlink lets it show another locus, chromosome or haplotype.', 'anchor': 'panel-link'},
       ]),

    _r(id='copy_panel_at_gene', category='panel_copies',
       command='open a copy of this panel at ftz',
       phrasings=[
           'show ftz next to this view',
           'put ftz in a second panel beside eve',
           'compare eve with ftz side by side',
       ],
       context=V_DM6_2R,
       thinking='"open a copy of this panel at ftz": I guide them through it rather than doing it. Then the controls in the order they\'d use them: + Add a copy, Link / Unlink, Panel location bar. Their clicks: + Add a copy, Panel location bar; the steps after each wait until it has happened.',
       summary='+ Add a copy → Link / Unlink → Panel location bar',
       actions=[
           {'type': 'try_it', 'text': "Hover the dataset panel's header and click + to add a copy.", 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy'},
           {'type': 'explain', 'text': "Click Unlink in the copy's location bar so it can move on its own.", 'anchor': 'panel-link'},
           {'type': 'try_it', 'text': "Type ftz in the copy's location box and press Enter.", 'wait_for': 'navigated', 'anchor': 'panel-location-bar'},
       ]),

    _r(id='copy_panel_at_region', category='panel_copies',
       command='open another panel at 3R:12,000,000-12,010,000',
       phrasings=[
           'show 3R:12000000-12010000 in a second panel',
           'add a view of 3R 12.00-12.01 Mb next to this one',
       ],
       context=V_DM6_2R,
       thinking='"open another panel at 3R:12,000,000-12,010,000": I guide them through it rather than doing it. Then the controls in the order they\'d use them: + Add a copy, Link / Unlink, Panel location bar. Their clicks: + Add a copy, Panel location bar; the steps after each wait until it has happened.',
       summary='+ Add a copy → Link / Unlink → Panel location bar',
       actions=[
           {'type': 'try_it', 'text': "Hover the dataset panel's header and click + to add a copy.", 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy'},
           {'type': 'explain', 'text': "Click Unlink in the copy's location bar so it can move on its own.", 'anchor': 'panel-link'},
           {'type': 'try_it', 'text': "Type 3R:12,000,000-12,010,000 in the copy's location box and press Enter.", 'wait_for': 'navigated', 'anchor': 'panel-location-bar'},
       ]),

    _r(id='copy_panel_haplotype', category='panel_copies',
       command='show the same region on the other haplotype chromosome',
       phrasings=[
           'open this region on haplotype 2',
           'compare this locus between haplotypes',
       ],
       context=V_HG38_MYC,
       thinking='The other haplotype is another contig, so a panel copy pointed at it; the contig name is theirs to type.',
       summary="Copy, unlink, type the other haplotype's contig",
       actions=[
           {'type': 'try_it', 'text': 'Hover the panel header and click + to add a copy.', 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy'},
           {'type': 'explain', 'text': "Click Unlink in the copy's location bar.", 'anchor': 'panel-link'},
           {'type': 'try_it', 'text': "Type the other haplotype's contig with the same coordinates (e.g. chr8_hap2:127,700,000-127,720,000).", 'wait_for': 'navigated', 'anchor': 'panel-location-bar'},
           {'type': 'explain', 'text': 'Select a peak in each panel and Cluster to cluster both haplotypes together.', 'anchor': 'cluster-button'},
       ]),

    _r(id='unlink_copy', category='panel_copies',
       command='unlink the copy',
       phrasings=[
           'let the second panel move on its own',
           'stop the copy following the main view',
           'detach the panel copy',
       ],
       context=V_DM6_2R,
       thinking='"unlink the copy": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Link / Unlink. Where a control needs something first, the step asks for it.',
       summary='Link / Unlink',
       actions=[
           {'type': 'explain', 'text': "Click Unlink in the copy's location bar; it keeps its place and gets its own location box.", 'anchor': 'panel-link', 'requires': 'has_panel_copy'},
       ]),

    _r(id='link_copy', category='panel_copies',
       command='link the copy back to the main view',
       phrasings=[
           'make the second panel follow the main view again',
           'lock the copy to the main view',
           'move both panels together',
       ],
       context=V_DM6_2R,
       thinking='"link the copy back to the main view": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Link / Unlink. Where a control needs something first, the step asks for it.',
       summary='Link / Unlink',
       actions=[
           {'type': 'explain', 'text': "Click Link in the copy's location bar: it jumps back to the main view and moves with it.", 'anchor': 'panel-link', 'requires': 'has_panel_copy'},
       ]),

    _r(id='cluster_across_loci', category='panel_copies',
       command='cluster the reads at eve and ftz together',
       phrasings=[
           'cluster both panels together',
           'cluster the two loci as one set',
       ],
       context=V_DM6_2R,
       thinking='Two loci together means a panel copy at ftz; then a peak in each and one Cluster click.',
       summary='Copy at ftz, a peak in each panel, Cluster',
       actions=[
           {'type': 'try_it', 'text': 'Hover the panel header and click + to add a copy.', 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy', 'skip_if': 'has_panel_copy'},
           {'type': 'explain', 'text': "Click Unlink in the copy's location bar.", 'anchor': 'panel-link'},
           {'type': 'try_it', 'text': "Type ftz in the copy's location box and press Enter.", 'wait_for': 'navigated', 'anchor': 'panel-location-bar'},
           {'type': 'explain', 'text': 'Select (or draw) a peak in each panel. Peaks are paired left to right and the wider of a pair is cropped to the narrower, so both loci are scored on the same features.', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
       ]),


    # ── tutorial_intent ─────────────────────────────────────────────

    _r(id='explain_panel_copies', category='tutorial_intent',
       command='how do I look at two places at once',
       phrasings=[
           'how do I compare two loci',
           'how do I show two chromosomes side by side',
           'what does the plus in the panel header do',
           'how do I compare haplotypes',
       ],
       context=V_DM6_2R,
       thinking='Two places at once is a panel copy: add it, unlink, move it; clustering then spans both.',
       summary='+ copy, Unlink, move it, cluster across both',
       actions=[
           {'type': 'try_it', 'text': "Hover a dataset panel's header and click + to add a copy.", 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy', 'skip_if': 'has_panel_copy'},
           {'type': 'explain', 'text': 'While linked, the copy follows the main view; click Unlink to move it on its own.', 'anchor': 'panel-link'},
           {'type': 'try_it', 'text': "Type another gene, region, chromosome or haplotype in the copy's location box.", 'wait_for': 'navigated', 'anchor': 'panel-location-bar'},
           {'type': 'explain', 'text': 'Each panel scans its own peaks; clustering pairs them left to right, so reads from both places share clusters.', 'anchor': 'peaks-track'},
       ]),


    # ── navigation ──────────────────────────────────────────────────

    _r(id='top_locus_go', category='navigation',
       command='take me to where the reads are',
       phrasings=[
           'go to reads',
           'find a region with high coverage',
           'jump to the best-covered locus',
           'where is my data',
           'show me somewhere with lots of reads',
       ],
       context=V_DM6_2R,
       thinking='go_to_top_locus jumps to the best-covered window at the current zoom, deepest first; repeating it steps to the next one.',
       summary='Go to the best-covered locus',
       actions=[
           {'type': 'go_to_top_locus'},
       ]),


    # ── multi_turn ──────────────────────────────────────────────────

    _r(id='top_locus_next', category='multi_turn',
       command='next one',
       phrasings=[
           'go to the next locus',
           'another one',
           'the next best',
       ],
       context=V_DM6_2R,
       previous_turns=[{'text': 'take me to where the reads are', 'summary': 'Explanation', 'actions': [{'type': 'go_to_top_locus'}]}],
       thinking="Previous turn went to the best-covered locus; 'next one' repeats go_to_top_locus, which steps down the ranked list.",
       summary='Next best-covered locus',
       actions=[
           {'type': 'go_to_top_locus'},
       ]),


    # ── navigation ──────────────────────────────────────────────────

    _r(id='top_locus_empty_view', category='navigation',
       command="I can't see any reads",
       phrasings=[
           'why is the view empty',
           'nothing is showing up',
       ],
       context=V_EMPTY,
       thinking='An empty view usually has no coverage. Jump to reads, then point at the button so they can do it again.',
       summary='Go to the best-covered place; the button that does it',
       actions=[
           {'type': 'go_to_top_locus'},
           {'type': 'explain', 'text': 'Go to reads (this button) does it: each click jumps to the next best-covered place at this zoom, deepest first.', 'anchor': 'go-to-reads'},
       ]),


    # ── footprint_analysis ──────────────────────────────────────────

    _r(id='footprints_open', category='footprint_analysis',
       command='open the footprints panel',
       phrasings=[
           'show the Footprints panel',
           'open footprint analysis',
           'open the binding panel',
       ],
       context=V_DM6_2R,
       thinking='Open it and say what fills it.',
       summary='Footprints panel',
       actions=[
           {'type': 'open_panel', 'panel_type': 'footprint-analysis'},
           {'type': 'explain', 'text': 'It fills in when you Cmd/Ctrl+click a footprint on a read: sizes, classes, motifs, strands and co-occupancy at that spot.', 'anchor': 'reads-track'},
       ]),

    _r(id='footprints_cluster_by_saved', category='footprint_analysis',
       command='cluster the reads by which saved footprints they have',
       phrasings=[
           'cluster reads by the footprints I saved',
           'group reads by footprint occupancy',
           'cluster by saved footprint classes',
       ],
       context=V_DM6_2R,
       thinking='"cluster the reads by which saved footprints they have": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Footprints > Co-occupancy tab, Clusters > Overview tab. Their clicks: Footprints > Co-occupancy tab; the steps after each wait until it has happened. Where a control needs something first, the step asks for it.',
       summary='Footprints > Co-occupancy tab → Clusters > Overview tab',
       actions=[
           {'type': 'explain', 'text': 'Co-occupancy shows which saved footprints occur together on the same molecules.', 'anchor': 'footprints-cooccupancy', 'requires': 'has_saved_footprints'},
           {'type': 'try_it', 'text': 'Click Cluster reads by these footprints: reads are grouped by which saved footprints they carry.', 'wait_for': 'clustered', 'anchor': 'footprints-cooccupancy', 'requires': 'has_saved_footprints'},
           {'type': 'explain', 'text': 'Each cluster is one combination of saved footprints, with its read count.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='footprints_save_then_cluster', category='footprint_analysis',
       command='save a TF-sized footprint class and a nucleosome class, then cluster by them',
       phrasings=[
           'make TF and nucleosome footprint groups and cluster by them',
       ],
       context=V_DM6_2R,
       thinking="Clustering by footprints needs saved footprints at positions: two Cmd/Ctrl+click-and-save rounds, then Co-occupancy's cluster button.",
       summary='Save a TF and a nucleosome footprint, cluster by them',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a TF-sized footprint.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_saved_footprints'},
           {'type': 'explain', 'text': 'Set its size range to 1-89 bp.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save.', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'try_it', 'text': 'Now Cmd/Ctrl+click a nucleosome-sized footprint, set 90-200 bp and Save it too.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track'},
           {'type': 'explain', 'text': 'Co-occupancy shows how the two saved footprints occur together on molecules.', 'anchor': 'footprints-cooccupancy'},
           {'type': 'try_it', 'text': 'Click Cluster reads by these footprints.', 'wait_for': 'clustered', 'anchor': 'footprints-cooccupancy'},
       ]),


    # ── tutorial_intent ─────────────────────────────────────────────

    _r(id='explain_footprints_saving', category='tutorial_intent',
       command='how do I save footprints',
       phrasings=[
           'how do I save all the footprint classes',
           'where is save all in the footprints panel',
           'how do I keep a footprint class',
       ],
       context=V_DM6_2R,
       thinking='Saving a footprint is select, size, Save; then where saved ones live.',
       summary='Cmd+click, size range, Save, the Saved tab',
       actions=[
           {'type': 'try_it', 'text': 'Cmd/Ctrl+click a footprint on a read.', 'wait_for': 'footprint_selected', 'anchor': 'reads-track', 'skip_if': 'has_selected_footprint'},
           {'type': 'explain', 'text': 'Pick its size range.', 'anchor': 'selected-footprint'},
           {'type': 'try_it', 'text': 'Click Save (Save all selected saves several at once).', 'wait_for': 'footprint_saved', 'anchor': 'save-footprint'},
           {'type': 'explain', 'text': 'Saved footprints are listed here: rename, recolour, filter reads by them, or cluster by them in Co-occupancy.', 'anchor': 'footprints-saved'},
       ]),

    _r(id='explain_vplot_controls', category='tutorial_intent',
       command='how do I change the v-plot axes',
       phrasings=[
           'can I change the V-plot resolution',
           'v plot is too coarse',
           'make the vplot window bigger',
       ],
       context=V_DM6_2R,
       thinking='V-plots live on saved footprints and in the Clusters panel.',
       summary='V-plot controls on saved footprints and clusters',
       actions=[
           {'type': 'explain', 'text': "Open a saved footprint's V-plot here: the controls set the window around it, the size range, the resolution and a log colour scale.", 'anchor': 'footprints-saved', 'requires': 'has_saved_footprints'},
           {'type': 'explain', 'text': 'The Clusters panel has a V-Plot tab per cluster too.', 'anchor': 'clusters-vplot', 'requires': 'has_clusters'},
       ]),

    _r(id='explain_motif_organism', category='tutorial_intent',
       command='the motifs are for the wrong organism',
       phrasings=[
           'why are the motifs human',
           'use fly motifs',
           'which species are the JASPAR motifs from',
       ],
       context=V_DM6_2R,
       thinking='The collection follows the genome, so fix the genome.',
       summary='Motif collection follows the genome',
       actions=[
           {'type': 'explain', 'text': "Motifs are matched against the loaded genome's JASPAR collection (insects for dm6, vertebrates for hg38/mm10); the species line under the hits says which.", 'anchor': 'footprints-classes'},
           {'type': 'explain', 'text': 'If the genome is wrong, pick the right one here (or load its FASTA/GTF).', 'anchor': 'genome-selector'},
       ]),

    _r(id='explain_where_labeling', category='tutorial_intent',
       command='where are the color rules',
       phrasings=[
           'where is the colormap',
           'how do I change read colors',
           'open the labeling panel',
       ],
       context=V_DM6_2R,
       thinking='Open it.',
       summary='Labeling panel',
       actions=[
           {'type': 'open_panel', 'panel_type': 'colormap'},
           {'type': 'explain', 'text': 'Colour rules: by layer, size, region, motif or track overlap.', 'anchor': 'labeling-rules'},
       ]),

    _r(id='explain_where_clusters', category='tutorial_intent',
       command='where do I see the clusters',
       phrasings=[
           'open the clusters panel',
           'show cluster details',
           'where are the cluster profiles',
       ],
       context=V_DM6_2R,
       thinking='Open the Clusters panel and point at the bar by the reads.',
       summary='Clusters panel and the cluster bar',
       actions=[
           {'type': 'open_panel', 'panel_type': 'cluster-detail'},
           {'type': 'explain', 'text': "The coloured bar left of the reads also shows each read's cluster.", 'anchor': 'cluster-focus-bar', 'requires': 'has_clusters'},
       ]),

    _r(id='explain_where_rules', category='tutorial_intent',
       command='where do I make a cluster rule',
       phrasings=[
           'open the rules panel',
           'where are analysis rules',
       ],
       context=V_DM6_2R,
       thinking='Point at Add cluster rule.',
       summary='Rules > Cluster',
       actions=[
           {'type': 'explain', 'text': 'In Rules > Cluster: Add cluster rule.', 'anchor': 'add-cluster-rule'},
       ]),

    _r(id='explain_where_layout', category='tutorial_intent',
       command='how do I arrange the panels',
       phrasings=[
           'open the layout panel',
           'how do I stack panels',
           'make the panels equal width',
       ],
       context=V_DM6_2R,
       thinking='Quick layout vs the full panel.',
       summary='Layout menu and Layout panel',
       actions=[
           {'type': 'explain', 'text': 'Layout arranges panels side by side or stacked and evens out their widths; drag a panel by its header to move it.', 'anchor': 'layout-menu'},
           {'type': 'explain', 'text': 'The Layout panel also renames, links and merges panels and saves presets.', 'anchor': 'layout-panel'},
       ]),

    _r(id='explain_load_plasmid', category='tutorial_intent',
       command='how do I load a plasmid',
       phrasings=[
           'how do I view my plasmid',
           'load a genbank file',
           'open a snapgene map',
       ],
       context=V_DM6_2R,
       thinking='Point at where plasmid maps load.',
       summary='Load Plasmid Map',
       actions=[
           {'type': 'explain', 'text': 'Load Plasmid Map takes a GenBank, SnapGene, EMBL or SBOL map; it becomes its own circular contig (Load File works too).', 'anchor': 'load-plasmid'},
           {'type': 'explain', 'text': 'It opens beside the current view; reads come from a BAM aligned to the plasmid.', 'anchor': 'regions-plasmid'},
       ]),

    _r(id='explain_guided_tour', category='tutorial_intent',
       command='give me a tour',
       phrasings=[
           'show me how to use this',
           'is there a tutorial',
           'walk me through the basics',
           "I'm new, where do I start",
       ],
       context=V_EMPTY,
       dataset_count=0,
       thinking='Point at the Tour.',
       summary='The Tour button',
       actions=[
           {'type': 'explain', 'text': 'Click Tour: it loads a small demo dataset and walks through the main tools step by step.', 'anchor': 'guided-tour'},
       ]),


    # ── negative ────────────────────────────────────────────────────

    _r(id='negative_strand_not_daf', category='negative',
       command='show only the CT strand',
       context=V_DM6_2R,
       dataset_count=DS_FIBER_ONLY,
       thinking='Strands only apply to DAF-seq (DddA/DddB) data; this session has only a fiber-seq dataset. Explain instead of acting.',
       summary='Strand views need DAF-seq data',
       warnings=['Strand views apply to DAF-seq (DddA/DddB) datasets; the loaded data is fiber-seq, where reads have no CT/GA strand.'],
       actions=[]),

    _r(id='negative_copy_invented_haplotype', category='negative',
       command='open hap2',
       context=V_DM6_2R,
       thinking="'hap2' isn't a known contig; don't invent coordinates. A copy the user points at the right contig.",
       summary='Copy, unlink, type the haplotype contig',
       actions=[
           {'type': 'try_it', 'text': "I couldn't find a 'hap2' contig. Add a panel copy with + in the header.", 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy'},
           {'type': 'explain', 'text': "Click Unlink in the copy's location bar.", 'anchor': 'panel-link'},
           {'type': 'try_it', 'text': "Type the haplotype's contig name and coordinates.", 'wait_for': 'navigated', 'anchor': 'panel-location-bar'},
       ]),


    # ── multi_turn ──────────────────────────────────────────────────

    _r(id='mt_copy_then_unlink', category='multi_turn',
       command='now unlink it',
       phrasings=[
           'let it move on its own now',
           'detach that copy',
       ],
       context=V_DM6_2R,
       previous_turns=[{'text': 'add a copy of this panel', 'summary': '+ Add a copy → Link / Unlink', 'actions': [{'type': 'try_it', 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy'}, {'type': 'explain', 'anchor': 'panel-link'}]}],
       thinking='"now unlink it": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Link / Unlink. Where a control needs something first, the step asks for it.',
       summary='Link / Unlink',
       actions=[
           {'type': 'explain', 'text': "Click Unlink in the copy's location bar; it keeps its place and gets its own location box.", 'anchor': 'panel-link', 'requires': 'has_panel_copy'},
       ]),

    _r(id='mt_copy_then_cluster_together', category='multi_turn',
       command='now cluster them together',
       phrasings=[
           'cluster both of them',
           'cluster the reads across both panels',
       ],
       context=V_DM6_2R,
       previous_turns=[{'text': 'open a copy of this panel at ftz', 'summary': '+ Add a copy → Link / Unlink → Panel location bar', 'actions': [{'type': 'try_it', 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy'}, {'type': 'explain', 'anchor': 'panel-link'}, {'type': 'try_it', 'wait_for': 'navigated', 'anchor': 'panel-location-bar'}]}],
       thinking='The copy at ftz exists from the last turn; they select a peak in each and click Cluster.',
       summary='A peak in each panel, then Cluster',
       actions=[
           {'type': 'explain', 'text': "Select a peak in each panel (or draw one); they're paired left to right and cropped to the same width.", 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Click Cluster: reads from both panels share the clusters.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
       ]),

    _r(id='mt_split_then_back', category='multi_turn',
       command='ok put the strands back together',
       phrasings=[
           'undo the strand split view',
           'back to one panel with both strands',
       ],
       context=V_DM6_2R,
       previous_turns=[{'text': 'show the two strands side by side', 'summary': 'Strand chip → Split into CT and GA panels', 'actions': [{'type': 'explain', 'anchor': 'strand-chip'}, {'type': 'try_it', 'wait_for': 'strand_split', 'anchor': 'split-by-strand'}]}],
       thinking='Undoing the split: both strands in one panel, then the copy can go.',
       summary='Both strands; close the extra panel',
       actions=[
           {'type': 'explain', 'text': 'Click the strand chip and choose Both strands.', 'anchor': 'strand-chip'},
           {'type': 'explain', 'text': "Close the second panel with × in its header if you don't need it.", 'anchor': 'panel-close'},
       ]),

    _r(id='mt_ct_then_cluster', category='multi_turn',
       command='and cluster those on the eve TSS',
       phrasings=[
           'now cluster the CT reads at eve',
       ],
       context=V_DM6_2R,
       previous_turns=[{'text': 'show only the CT strand', 'summary': 'Strand chip', 'actions': [{'type': 'explain', 'anchor': 'strand-chip'}]}],
       thinking='"and cluster those on the eve TSS": I guide them through it rather than doing it. Then the controls in the order they\'d use them: Scan, Peaks track, Cluster, Clusters > Overview tab. Their clicks: Scan, Peaks track, Cluster; the steps after each wait until it has happened. Layers they\'ve already done are skipped.',
       summary='Scan → Peaks track → Cluster → Clusters > Overview tab',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks in this view.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button', 'skip_if': 'has_peaks'},
           {'type': 'try_it', 'text': 'Click the peak over the eve TSS in the Peaks track to select it (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Now click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
           {'type': 'explain', 'text': 'Each cluster is listed with its read count; the coloured bar left of the reads shows which cluster each read is in.', 'anchor': 'clusters-overview'},
       ]),

    _r(id='mt_top_locus_then_scan_cluster', category='multi_turn',
       command='scan and cluster here',
       phrasings=[
           'cluster at this locus',
           'find peaks here and cluster',
       ],
       context=V_DM6_2R,
       previous_turns=[{'text': 'go to reads', 'summary': 'Explanation', 'actions': [{'type': 'go_to_top_locus'}]}],
       thinking="They're at the best-covered locus from the last turn; scan, pick peaks and cluster, all their clicks.",
       summary='Scan, select peaks, Cluster',
       actions=[
           {'type': 'try_it', 'text': 'Click Scan to find peaks here.', 'wait_for': 'peaks_scanned', 'anchor': 'scan-peaks-button'},
           {'type': 'try_it', 'text': 'Click the peaks to cluster on (Cmd/Ctrl+click adds more).', 'wait_for': 'peak_selected', 'anchor': 'peaks-track'},
           {'type': 'try_it', 'text': 'Click Cluster.', 'wait_for': 'clustered', 'anchor': 'cluster-button'},
       ]),


    # ── tutorial_intent ─────────────────────────────────────────────

    _r(id='explain_quality_group', category='tutorial_intent',
       command='what does the quality setting do',
       phrasings=[
           'what is class support',
           'how strict are the footprint calls',
           'what does FIRE default mean',
       ],
       context=V_DM6_2R,
       thinking='Explain the Quality control and where its details live.',
       summary='Quality cutoffs',
       actions=[
           {'type': 'explain', 'text': "Quality sets how confident a call must be to be drawn and counted; FIRE default uses the producer's calls as they are.", 'anchor': 'quality-filters'},
           {'type': 'explain', 'text': 'Set a minimum per layer here.', 'anchor': 'quality-cutoffs'},
           {'type': 'explain', 'text': "The full rules and shading are in the Labeling panel's Quality tab.", 'anchor': 'labeling-quality'},
       ]),

    _r(id='explain_restore_offer', category='tutorial_intent',
       command='how do I get my last session back',
       phrasings=[
           'the browser crashed, can I restore',
           'where is restore session',
           'I closed the tab by mistake',
       ],
       context=V_EMPTY,
       dataset_count=0,
       thinking='The auto-restore offer, then the permanent route.',
       summary='Restore offer, or a saved session',
       actions=[
           {'type': 'explain', 'text': "Reload the page: a 'restore previous session' offer appears at the top with your last datasets, view and clusters."},
           {'type': 'explain', 'text': 'For a copy you keep, click Save; reopen it later with Load File.', 'anchor': 'save-session'},
       ]),

    _r(id='explain_cluster_order_zoom', category='tutorial_intent',
       command='will my clusters stay in order when I zoom',
       phrasings=[
           'the cluster order changes when I pan',
           'keep the clusters in the same order',
       ],
       context=V_DM6_2R,
       thinking='Answer, then point at the lock.',
       summary='Cluster order and its lock',
       actions=[
           {'type': 'explain', 'text': 'Yes: clusters keep their order as you pan and zoom.'},
           {'type': 'explain', 'text': 'Lock cluster order also keeps it when you re-sort or re-cluster.', 'anchor': 'cluster-order-lock', 'requires': 'has_clusters'},
       ]),


    # ── strands ─────────────────────────────────────────────────────

    _r(id='strand_hg38_compare', category='strands',
       command='compare CT and GA reads at MYC',
       phrasings=[
           'split the strands at MYC',
       ],
       context=V_HG38_MYC,
       thinking='"compare CT and GA reads at MYC": I guide them through it rather than doing it. First I move the view to MYC. Then the controls in the order they\'d use them: Strand chip, Split into CT and GA panels. Their clicks: Split into CT and GA panels; the steps after each wait until it has happened.',
       summary='MYC → Strand chip → Split into CT and GA panels',
       actions=[
           {'type': 'navigate_gene', 'gene': 'MYC', 'padding_bp': 5000},
           {'type': 'explain', 'text': 'DAF-seq deaminates one strand of each molecule; the strand chip in the panel header chooses CT, GA or both.', 'anchor': 'strand-chip'},
           {'type': 'try_it', 'text': 'Choose Split into CT and GA panels: CT reads here, GA reads in a copy beside it.', 'wait_for': 'strand_split', 'anchor': 'split-by-strand'},
       ]),


    # ── panel_copies ────────────────────────────────────────────────

    _r(id='copy_panel_hg38_gene', category='panel_copies',
       command='open SOX2 in a second panel next to MYC',
       phrasings=[
           'show SOX2 beside this',
           'put SOX2 next to MYC',
       ],
       context=V_HG38_MYC,
       thinking='"open SOX2 in a second panel next to MYC": I guide them through it rather than doing it. Then the controls in the order they\'d use them: + Add a copy, Link / Unlink, Panel location bar. Their clicks: + Add a copy, Panel location bar; the steps after each wait until it has happened.',
       summary='+ Add a copy → Link / Unlink → Panel location bar',
       actions=[
           {'type': 'try_it', 'text': "Hover the dataset panel's header and click + to add a copy.", 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy'},
           {'type': 'explain', 'text': "Click Unlink in the copy's location bar so it can move on its own.", 'anchor': 'panel-link'},
           {'type': 'try_it', 'text': "Type SOX2 in the copy's location box and press Enter.", 'wait_for': 'navigated', 'anchor': 'panel-location-bar'},
       ]),

    _r(id='top_locus_then_copy', category='panel_copies',
       command='keep this view and open the best-covered locus in another panel',
       phrasings=[
           'put the top locus in a second panel',
       ],
       context=V_DM6_2R,
       thinking='"keep this view and open the best-covered locus in another panel": I guide them through it rather than doing it. First I move the view. Then the controls in the order they\'d use them: + Add a copy, Link / Unlink, Panel location bar. Their clicks: + Add a copy, Panel location bar; the steps after each wait until it has happened.',
       summary='+ Add a copy → Link / Unlink → Panel location bar',
       actions=[
           {'type': 'try_it', 'text': "Hover the dataset panel's header and click + to add a copy.", 'wait_for': 'panel_copy_made', 'anchor': 'panel-add-copy'},
           {'type': 'explain', 'text': "Click Unlink in the copy's location bar so it can move on its own.", 'anchor': 'panel-link'},
           {'type': 'try_it', 'text': "Type 2R:9,970,000-9,980,000 in the copy's location box and press Enter.", 'wait_for': 'navigated', 'anchor': 'panel-location-bar'},
           {'type': 'go_to_top_locus'},
       ]),

]


def category_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for record in RECORDS:
        counts[record["category"]] = counts.get(record["category"], 0) + 1
    return counts


# ── Teach-only modules (appended) ──

# Troubleshooting records ("why are no reads visible?" and other stuck questions).
try:
    from data.copilot_dataset import records_teach_troubleshooting
except ImportError:  # imported as a top-level module
    import records_teach_troubleshooting
RECORDS += records_teach_troubleshooting.build_records()

# How-to walkthroughs (the tutorial Copilot's workflows).
try:
    from data.copilot_dataset.records_teach_workflows import RECORDS as _TEACH_WORKFLOW_RECORDS
except ImportError:  # imported as a top-level module
    from records_teach_workflows import RECORDS as _TEACH_WORKFLOW_RECORDS
RECORDS += _TEACH_WORKFLOW_RECORDS

# Each analysis panel in depth: run, read the result, options, follow-ups.
try:
    from data.copilot_dataset.records_teach_panels import RECORDS as _TEACH_PANEL_RECORDS
except ImportError:  # imported as a top-level module
    from records_teach_panels import RECORDS as _TEACH_PANEL_RECORDS
RECORDS += _TEACH_PANEL_RECORDS

# Further teach-only record modules extend RECORDS below this line, e.g.
#   from data.copilot_dataset.records_howto import RECORDS as _HOWTO; RECORDS.extend(_HOWTO)

# Vague, goal-level and ambiguous requests ("is my TF bound here?", "compare", "help").
try:
    from data.copilot_dataset.records_teach_vague import RECORDS as _TEACH_VAGUE_RECORDS
except ImportError:  # imported as a top-level module
    from records_teach_vague import RECORDS as _TEACH_VAGUE_RECORDS
RECORDS += _TEACH_VAGUE_RECORDS
