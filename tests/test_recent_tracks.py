"""Recently used track sources persist on the server (paths/URLs only)."""


def test_remember_list_and_forget(client, tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_RECENT_TRACKS_FILE", str(tmp_path / "recent.json"))
    present = tmp_path / "signal.bw"
    present.write_bytes(b"")
    client.post("/api/tracks/recent", json={"source": "local", "kind": "bigwig", "label": "Signal", "path": str(present)})
    client.post("/api/tracks/recent", json={"source": "local", "kind": "bigwig", "label": "Gone", "path": str(tmp_path / "gone.bw")})
    client.post("/api/tracks/recent", json={"source": "local", "kind": "motif", "label": "CTCF", "path": "motif://jaspar/MA0139.2"})
    # Re-using a track moves it to the top instead of duplicating it.
    client.post("/api/tracks/recent", json={"source": "local", "kind": "bigwig", "label": "Signal", "path": str(present)})

    tracks = client.get("/api/tracks/recent").json()["tracks"]
    assert [t["label"] for t in tracks] == ["Signal", "CTCF", "Gone"]
    assert [t["available"] for t in tracks] == [True, True, False]

    client.delete("/api/tracks/recent", params={"key": tracks[2]["key"]})
    assert [t["label"] for t in client.get("/api/tracks/recent").json()["tracks"]] == ["Signal", "CTCF"]


def test_entries_need_a_location_and_label(client, tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_RECENT_TRACKS_FILE", str(tmp_path / "recent.json"))
    assert client.post("/api/tracks/recent", json={"label": "x"}).json()["success"] is False
