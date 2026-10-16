"""Plugin loader — discovers and mounts external Python plugins.

Usage:
    python browser.py -b data.bam --plugin ./my-plugin/

Each plugin directory must contain:
  - fiberbrowser-plugin.json  (manifest with name, label, headerColor)
  - plugin.py                 (exports create_router(ctx) -> APIRouter)
"""

import os
import sys
import json
import importlib.util
from typing import List, Dict, Any
from fastapi import APIRouter

from . import get_context, register_plugin


_manifests: List[Dict[str, Any]] = []


def load_plugin(plugin_dir: str) -> Dict[str, Any]:
    """Load a single plugin from a directory. Returns the manifest dict."""
    plugin_dir = os.path.abspath(plugin_dir)
    manifest_path = os.path.join(plugin_dir, 'fiberbrowser-plugin.json')
    plugin_py = os.path.join(plugin_dir, 'plugin.py')

    if not os.path.isfile(manifest_path):
        raise FileNotFoundError(f"No fiberbrowser-plugin.json in {plugin_dir}")
    if not os.path.isfile(plugin_py):
        raise FileNotFoundError(f"No plugin.py in {plugin_dir}")

    with open(manifest_path, 'r') as f:
        manifest = json.load(f)

    name = manifest.get('name')
    if not name:
        raise ValueError(f"Plugin manifest missing 'name': {manifest_path}")

    # Load the Python module
    spec = importlib.util.spec_from_file_location(f"fiberbrowser_plugin_{name}", plugin_py)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load plugin module: {plugin_py}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"fiberbrowser_plugin_{name}"] = module
    spec.loader.exec_module(module)

    # Call create_router(ctx) to get the APIRouter
    if not hasattr(module, 'create_router'):
        raise AttributeError(f"plugin.py must export create_router(ctx): {plugin_py}")

    ctx = get_context()
    router: APIRouter = module.create_router(ctx)

    # Mount with a prefix
    api_prefix = f"/api/plugins/{name}"
    manifest['api_prefix'] = api_prefix
    manifest['plugin_dir'] = plugin_dir

    register_plugin(name, router)

    return manifest


def load_plugins(plugin_paths: List[str]) -> List[Dict[str, Any]]:
    """Load all plugins from the given paths (dirs or parent dirs)."""
    manifests = []
    for path in plugin_paths:
        path = os.path.abspath(path)
        if os.path.isfile(os.path.join(path, 'fiberbrowser-plugin.json')):
            # Direct plugin directory
            try:
                m = load_plugin(path)
                manifests.append(m)
                print(f"  Plugin loaded: {m.get('label', m['name'])} ({path})")
            except Exception as e:
                print(f"  Warning: Failed to load plugin {path}: {e}")
        elif os.path.isdir(path):
            # Scan subdirectories for plugins
            for entry in sorted(os.listdir(path)):
                subdir = os.path.join(path, entry)
                if os.path.isdir(subdir) and os.path.isfile(os.path.join(subdir, 'fiberbrowser-plugin.json')):
                    try:
                        m = load_plugin(subdir)
                        manifests.append(m)
                        print(f"  Plugin loaded: {m.get('label', m['name'])} ({subdir})")
                    except Exception as e:
                        print(f"  Warning: Failed to load plugin {subdir}: {e}")

    _manifests.extend(manifests)
    return manifests


def get_plugin_manifests() -> List[Dict[str, Any]]:
    """Return all loaded plugin manifests."""
    return list(_manifests)
