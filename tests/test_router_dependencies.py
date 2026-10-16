import ast
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _python_files(*parts):
    return sorted(
        path
        for path in (PROJECT_ROOT / Path(*parts)).glob("*.py")
        if path.name != "__init__.py"
    )


def _pack_python_files():
    """The routers and services of the plugin packs in this tree (browser/<pack>/fiberbrowser-pack.json)."""
    out = []
    for manifest in sorted((PROJECT_ROOT / "browser").glob("*/fiberbrowser-pack.json")):
        pack = manifest.parent
        out += _python_files("browser", pack.name, "routers") + _python_files("browser", pack.name, "services")
    return out


DECOUPLED_MODULE_PATHS = [
    *_python_files("browser", "routers"),
    *_python_files("browser", "services"),
    *_pack_python_files(),
    PROJECT_ROOT / "browser" / "render.py",
    PROJECT_ROOT / "browser" / "models" / "domain.py",
    PROJECT_ROOT / "browser" / "state" / "browser_state.py",
    PROJECT_ROOT / "browser" / "state" / "dependencies.py",
]


@pytest.mark.parametrize(
    "module_path",
    DECOUPLED_MODULE_PATHS,
    ids=lambda path: str(path.relative_to(PROJECT_ROOT)),
)
def test_decoupled_modules_do_not_import_server_module(module_path):
    source = module_path.read_text()
    tree = ast.parse(source)
    imports_server = any(
        (
            isinstance(node, ast.Import)
            and any(alias.name == "server" for alias in node.names)
        )
        or (
            isinstance(node, ast.ImportFrom)
            and node.module == "server"
        )
        for node in ast.walk(tree)
    )
    uses_server_attr = any(
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "server"
        for node in ast.walk(tree)
    )
    assert not imports_server
    assert not uses_server_attr
