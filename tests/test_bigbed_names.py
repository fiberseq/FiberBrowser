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
