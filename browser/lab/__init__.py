"""NFR and Synchronise analysis modules, included in every release (see ARCHITECTURE.md).

Core code never imports this package; plugins/packs.py discovers it by its fiberbrowser-pack.json and calls
``lab.pack.register``.
"""
