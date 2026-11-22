import asyncio

from services import bigbed_names


def test_bigbed_names_payload_uses_memory_cache():
    memory_cache = {"dm6": {"success": True, "names": ["cached"]}}

    result = asyncio.run(
        bigbed_names.get_bigbed_names_payload(
            url="https://example.org/tf.bb",
            genome="dm6",
            disk_cache={},
            memory_cache=memory_cache,
        )
    )

    assert result == {"success": True, "names": ["cached"], "cached": True}


def test_bigbed_names_payload_uses_disk_cache_and_populates_memory_cache():
    memory_cache = {}
    disk_cache = {
        "dm6_jaspar_names": {
            "url": "https://example.org/tf.bb",
            "names": ["GAF"],
            "name_to_ma": {"GAF": ["MA0001.1"]},
        }
    }

    result = asyncio.run(
        bigbed_names.get_bigbed_names_payload(
            url="https://example.org/tf.bb",
            genome="dm6",
            disk_cache=disk_cache,
            memory_cache=memory_cache,
        )
    )

    assert result == {
        "success": True,
        "names": ["GAF"],
        "name_to_ma": {"GAF": ["MA0001.1"]},
        "cached": True,
    }
    assert memory_cache["dm6"]["names"] == ["GAF"]


def test_bigbed_names_payload_prefers_jaspar_for_known_genome():
    async def fake_jaspar(tax_group):
        assert tax_group == "insects"
        return {"success": True, "names": ["GAF"], "name_to_ma": {"GAF": ["MA"]}}

    def fail_bigbed(_url, _sample_size):
        raise AssertionError("BigBed fallback should not run")

    disk_cache = {}
    memory_cache = {}
    result = asyncio.run(
        bigbed_names.get_bigbed_names_payload(
            url="https://example.org/tf.bb",
            genome="dm6",
            disk_cache=disk_cache,
            memory_cache=memory_cache,
            jaspar_fetcher=fake_jaspar,
            bigbed_fetcher=fail_bigbed,
        )
    )

    assert result == {"success": True, "names": ["GAF"], "name_to_ma": {"GAF": ["MA"]}}
    assert disk_cache["dm6_jaspar_names"] == {
        "url": "https://example.org/tf.bb",
        "names": ["GAF"],
        "name_to_ma": {"GAF": ["MA"]},
    }
    assert memory_cache["dm6"]["names"] == ["GAF"]


def test_bigbed_names_payload_falls_back_to_bigbed_for_unknown_or_failed_jaspar():
    async def fake_jaspar(_tax_group):
        return None

    def fake_bigbed(url, sample_size):
        assert url == "https://example.org/tf.bb"
        assert sample_size == 123
        return {"success": True, "names": ["MA0001.1"]}

    result = asyncio.run(
        bigbed_names.get_bigbed_names_payload(
            url="https://example.org/tf.bb",
            genome="unknown",
            sample_size=123,
            disk_cache={},
            memory_cache={},
            jaspar_fetcher=fake_jaspar,
            bigbed_fetcher=fake_bigbed,
        )
    )

    assert result == {"success": True, "names": ["MA0001.1"]}


def test_bigbed_names_payload_reports_fallback_errors():
    def failing_bigbed(_url, _sample_size):
        raise RuntimeError("boom")

    result = asyncio.run(
        bigbed_names.get_bigbed_names_payload(
            url="https://example.org/tf.bb",
            disk_cache={},
            memory_cache={},
            bigbed_fetcher=failing_bigbed,
        )
    )

    assert result == {"success": False, "names": [], "error": "boom"}


def test_jaspar_names_need_no_httpx(monkeypatch):
    """The Mac app bundles no httpx: the JASPAR lookup must not import it (3.0.x-3.1.0 answered 500 on every
    /api/bigbed/names call with a genome), and it reads every page with the standard library."""
    import builtins
    real_import = builtins.__import__

    def no_httpx(name, *args, **kwargs):
        if name == "httpx" or name.startswith("httpx."):
            raise ModuleNotFoundError("No module named 'httpx'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_httpx)
    pages = {1: {"results": [{"name": "GAF", "matrix_id": "MA0001.1"}, {"name": "Trl", "matrix_id": "MA0205.2"}],
                 "next": "page2"},
             2: {"results": [{"name": "GAF", "matrix_id": "MA0001.2"}], "next": None}}
    seen = []

    def get_json(url):
        seen.append(url)
        page = int(url.split("page=")[1].split("&")[0])
        assert "tax_group=insects" in url and "collection=CORE" in url
        return pages[page]

    out = bigbed_names._fetch_jaspar_api_names_sync("insects", get_json=get_json)
    assert out == {"success": True, "names": ["GAF", "Trl"], "name_to_ma": {"GAF": ["MA0001.1", "MA0001.2"], "Trl": ["MA0205.2"]}}
    assert len(seen) == 2


def test_jaspar_names_failure_falls_back_to_bigbed_sampling():
    """A JASPAR failure (offline, TLS, HTTP error) returns None, so the payload samples the BigBed instead."""
    def broken(url):
        raise OSError("offline")

    assert bigbed_names._fetch_jaspar_api_names_sync("insects", get_json=broken) is None
    result = asyncio.run(bigbed_names.get_bigbed_names_payload(
        url="https://example.org/tf.bb", genome="dm6", disk_cache={}, memory_cache={},
        jaspar_fetcher=lambda tax: asyncio.sleep(0, result=bigbed_names._fetch_jaspar_api_names_sync(tax, get_json=broken)),
        bigbed_fetcher=lambda url, n: {"success": True, "names": ["MA0001.1"]}))
    assert result == {"success": True, "names": ["MA0001.1"]}
