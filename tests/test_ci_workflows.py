"""The GitHub workflows run their Linux jobs on one pinned image (see the note at the top of ci.yml)."""
import re
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"
LINUX_IMAGE = "ubuntu-24.04"


def _runs_on():
    for path in sorted(WORKFLOWS.glob("*.yml")):
        for n, line in enumerate(path.read_text().splitlines(), 1):
            m = re.match(r"\s*runs-on:\s*(\S+)", line)
            if m:
                yield path.name, n, m.group(1)


def test_linux_jobs_use_the_pinned_image_and_never_a_moving_label():
    rows = list(_runs_on())
    linux = [r for r in rows if r[2].startswith("ubuntu")]
    assert linux, "no Linux jobs found: the workflow layout changed"
    wrong = [r for r in linux if r[2] != LINUX_IMAGE]
    assert not wrong, f"Linux jobs must run on {LINUX_IMAGE} (Playwright refuses ubuntu-latest = 26.04): {wrong}"
    assert not [r for r in rows if r[2].endswith("-latest")], rows



def test_ci_runs_once_per_pushed_commit_not_again_for_its_tag():
    text = (WORKFLOWS / "ci.yml").read_text()
    on = text[text.index("\non:\n"):text.index("\npermissions:")]
    push = on[on.index("  push:\n"):on.index("  pull_request:")]
    assert re.search(r'^    branches: \["\*\*"\]$', push, re.M), push
    assert "tags" not in push, push
    assert re.findall(r'cron: "([^"]+)"', on) == ["0 6 * * *"], "the only schedule is the nightly run"
