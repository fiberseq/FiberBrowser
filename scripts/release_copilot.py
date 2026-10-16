#!/usr/bin/env python3
"""One-command Copilot release — keep EVERYTHING in sync, every time.

This is the canonical "default workflow": for each tier it fuses the fp16
model AND builds a quantized variant (int8 by default, q8; --q-bits 4 for q4),
uploads both to HF, registers both in
the model registry, and deprecates the prior version's entries — so the fp16
and q4 buckets never drift apart again (the gap that left q4 behind in v5).

It assumes the LoRA adapters already exist at adapters/copilot_<dir>_v1
(produced by scripts/train_copilot_lora.sh). It does NOT git commit/push —
that stays a human gate; the script prints the exact commands at the end.

Usage:
    # dry-run the plan (no fuse/quantize/upload, no registry writes)
    python scripts/release_copilot.py --version 6 --org mtcicero26 --dry-run

    # full release of all consumer tiers
    python scripts/release_copilot.py --version 6 --org mtcicero26

    # subset / skip already-done stages
    python scripts/release_copilot.py --version 6 --org mtcicero26 \
        --tiers tiny light --skip-upload

Stages (per tier, both fp16 + q4): fuse -> quantize -> register -> upload
-> deprecate-prior -> validate. Each stage is idempotent (skips work whose
output already exists), so a re-run after a failure resumes cleanly.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY = REPO_ROOT / "data" / "copilot_dataset" / "models.json"

# tier -> (registry-dir token, base model, size_b, fp16 (min,rec) RAM, q4 (min,rec) RAM)
# q8 needs about half the fp16 memory; v6 evals: q8 matched fp16, q4 lost 6-8 points.
TIERS: dict[str, tuple[str, str, float, tuple[int, int], tuple[int, int]]] = {
    "tiny":     ("1.5b", "Qwen/Qwen2.5-Coder-1.5B-Instruct", 1.5, (8, 16),  (4, 8)),
    "light":    ("3b",   "Qwen/Qwen2.5-Coder-3B-Instruct",   3.0, (12, 24), (6, 12)),
    "balanced": ("7b",   "Qwen/Qwen2.5-Coder-7B-Instruct",   7.0, (16, 32), (8, 16)),
    "heavy":    ("14b",  "Qwen/Qwen2.5-Coder-14B-Instruct",  14.0, (32, 64), (12, 24)),
    "max":      ("32b",  "Qwen/Qwen2.5-Coder-32B-Instruct",  32.0, (64, 128), (24, 48)),
}

Q8_RAM: dict[str, tuple[int, int]] = {
    "tiny": (6, 12), "light": (8, 16), "balanced": (12, 24), "heavy": (20, 40), "max": (40, 80),
}


def _run(cmd: list[str], *, dry: bool) -> None:
    print("  $", " ".join(cmd))
    if dry:
        return
    subprocess.run(cmd, cwd=REPO_ROOT, check=True)


def _load_registry() -> dict:
    return json.loads(REGISTRY.read_text(encoding="utf-8")) if REGISTRY.exists() else {"models": []}


def _write_registry(reg: dict) -> None:
    REGISTRY.write_text(json.dumps(reg, indent=2) + "\n", encoding="utf-8")


def _unpublished(reg: dict, ver: int, tiers: list[str]) -> list[str]:
    """This release's entries for the given tiers that have no hf_repo (nothing to download)."""
    return [m["id"] for m in reg.get("models", [])
            if m.get("version") == ver and m.get("tier") in tiers and not m.get("hf_repo")]


def _upsert(reg: dict, entry: dict) -> None:
    models = reg.setdefault("models", [])
    for i, m in enumerate(models):
        if m.get("id") == entry["id"]:
            models[i] = {**m, **entry}
            return
    models.append(entry)


def main() -> int:
    ap = argparse.ArgumentParser(description="Release all Copilot tiers (fp16 + q4) together.")
    ap.add_argument("--version", type=int, required=True, help="Release version number, e.g. 6")
    ap.add_argument("--org", required=True, help="HF org/user to publish under, e.g. mtcicero26")
    ap.add_argument("--tiers", nargs="+", default=["tiny", "light", "balanced"],
                    choices=list(TIERS), help="Tiers to release (default: consumer tiers)")
    ap.add_argument("--skip-fuse", action="store_true")
    ap.add_argument("--skip-quantize", action="store_true")
    ap.add_argument("--skip-upload", action="store_true")
    ap.add_argument("--q-bits", type=int, choices=(4, 8), default=8,
                    help="Quantized variant: 8 (default; matched fp16 in the v6 evals) or 4 (smaller, lost 6-8 points)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ver = args.version
    dry = args.dry_run
    fused_root = REPO_ROOT / "fused_models"
    print(f"=== Copilot release v{ver} -> HF org '{args.org}'  (tiers: {', '.join(args.tiers)})"
          f"{'  [DRY-RUN]' if dry else ''}\n")

    # ---- 1. Build (fuse fp16 + quantize q4) + register both variants ----
    reg = _load_registry()
    desc = (f"v{ver} model: teach-only tutorial Copilot (guided walks with spotlighted "
            f"controls, your-turn steps and troubleshooting from browser diagnostics).")
    for tier in args.tiers:
        token, base, size_b, (fmin, frec), (qmin, qrec) = TIERS[tier]
        bits = args.q_bits
        qtag = f"q{bits}"
        if bits == 8:
            qmin, qrec = Q8_RAM[tier]
        # This version's adapter (train with VERSION=<ver>); older releases used _v1.
        adapter = REPO_ROOT / "adapters" / f"copilot_{token}_v{ver}"
        if not adapter.exists():
            adapter = REPO_ROOT / "adapters" / f"copilot_{token}_v1"
        fp16 = fused_root / f"copilot_{token}_v{ver}"
        q4 = fused_root / f"copilot_{token}_v{ver}_{qtag}"
        print(f"[{tier}] adapter={adapter.name}  fp16={fp16.name}  {qtag}={q4.name}")
        if not args.skip_fuse and not (fp16 / "config.json").exists():
            if not adapter.exists():
                print(f"  !! adapter missing: {adapter} — run scripts/train_copilot_lora.sh SIZE={tier}", file=sys.stderr)
                return 1
            _run([sys.executable, "-m", "mlx_lm", "fuse", "--model", base,
                  "--adapter-path", str(adapter), "--save-path", str(fp16)], dry=dry)
        if not args.skip_quantize and not (q4 / "config.json").exists():
            _run([sys.executable, "-m", "mlx_lm", "convert", "--hf-path", str(fp16),
                  "--mlx-path", str(q4), "-q", "--q-bits", str(bits)], dry=dry)
        # Register both entries (hf_repo filled in by the upload step).
        _upsert(reg, {
            "id": f"fiberbrowser-copilot-{token}-v{ver}", "label": f"Copilot {token.upper()} v{ver}",
            "base": base, "size_b": size_b, "min_ram_gb": fmin, "recommended_ram_gb": frec,
            "tier": tier, "trained": True, "fused_path": f"fused_models/copilot_{token}_v{ver}",
            "description": f"fp16 {desc}", "version": ver, "quantized": False, "deprecated": False,
        })
        _upsert(reg, {
            "id": f"fiberbrowser-copilot-{token}-v{ver}-{qtag}", "label": f"Copilot {token.upper()} {qtag} (quantized) v{ver}",
            "base": base, "size_b": size_b, "min_ram_gb": qmin, "recommended_ram_gb": qrec,
            "tier": tier, "trained": True, "fused_path": f"fused_models/copilot_{token}_v{ver}_{qtag}",
            "description": (f"int8 quantization of the {desc} ~2x smaller, same accuracy as fp16." if bits == 8
                            else f"int4 quantization of the {desc} ~4x smaller; low-RAM Macs."),
            "version": ver, "quantized": True, "deprecated": False,
        })
    if not dry:
        _write_registry(reg)
        print(f"\n  registered fp16 + q{args.q_bits} entries for", ", ".join(args.tiers))

    # ---- 2. Upload (writes hf_repo back into the registry per entry) ----
    # Only this release's models (the uploader matches id substrings, so the
    # fp16 id also selects its quantized twin; tier names would re-upload old
    # versions). A failed upload exits non-zero and stops here (check=True),
    # before any working version is retired.
    if not args.skip_upload:
        print("\n=== uploading to HF ===")
        release_ids = [f"fiberbrowser-copilot-{TIERS[t][0]}-v{ver}" for t in args.tiers]
        _run([sys.executable, "scripts/upload_copilot_models.py", "--org", args.org, "--tiers", *release_ids],
             dry=dry)

    # ---- 3. Deprecate prior versions (per tier+quantized bucket) ----
    if not dry:
        reg = _load_registry()
        missing = _unpublished(reg, ver, args.tiers)
        if missing:
            # Retiring the old versions now would leave nothing downloadable.
            print(f"\n  !! not published (no hf_repo): {', '.join(missing)} — prior versions left in place",
                  file=sys.stderr)
            return 1
        deprecated = []
        for m in reg.get("models", []):
            if (m.get("trained") and (m.get("version") or 1) < ver
                    and not m.get("deprecated")
                    and m.get("tier") in args.tiers):
                m["deprecated"] = True
                deprecated.append(m["id"])
        _write_registry(reg)
        print("\n  deprecated prior:", ", ".join(deprecated) or "(none)")

    # ---- 4. Validate selection ----
    if not dry:
        sys.path.insert(0, str(REPO_ROOT / "browser"))
        from services.natural_language_commands import recommend_models_for_host  # noqa: E402
        r = recommend_models_for_host(ram_gb=64.0)
        print("\n=== validation (64 GB host) ===")
        print("  recommended_id:", r["recommended_id"])
        print("  latest_per_tier:", sorted(r["latest_per_tier"]))
        bad = [m["id"] for m in r["models"]
               if m.get("version") == ver and not Path(REPO_ROOT / m.get("fused_path", "x")).is_dir()]
        if bad:
            print("  !! v%d entries with MISSING local fused_path:" % ver, bad, file=sys.stderr)

    print(f"\n=== done. Next (human gate): review, then commit + push ===")
    print("  git add data/copilot_dataset/models.json")
    print(f"  git commit -m 'Release v{ver} copilot (fp16 + q{args.q_bits}, all tiers in sync)'")
    print("  git push origin HEAD:main")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
