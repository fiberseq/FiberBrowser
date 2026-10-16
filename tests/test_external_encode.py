import asyncio

from services import external_encode


def test_encode_facets_uses_disk_cache_without_network():
    external_encode._encode_facet_cache.clear()
    cached = {
        "supported": True,
        "genome": "dm6",
        "assays": [{"key": "ChIP-seq", "count": 10}],
        "targets": [],
        "biosamples": [],
    }

    result = asyncio.run(external_encode.get_encode_facets_for_genome("dm6", {"dm6_encode_facets": cached}))

    assert result is cached
    assert external_encode._encode_facet_cache["dm6"][1] is cached


def test_encode_facets_reports_unsupported_genome():
    result = asyncio.run(external_encode.get_encode_facets_for_genome("unknown", {}))

    assert result == {"supported": False, "genome": "unknown"}


def test_encode_search_formats_file_metadata(monkeypatch):
    external_encode._encode_search_cache.clear()

    class FakeResponse:
        def read(self):
            return (
                b'{"@graph":[{"href":"/files/ENCFF1/@@download/file.bigWig",'
                b'"output_type":"signal","file_size":123,'
                b'"dataset":{"@id":"/experiments/ENCSR1/","assay_title":"ChIP-seq",'
                b'"target":{"label":"Pol II"},"biosample_ontology":{"term_name":"embryo"}}}],'
                b'"total":1}'
            )

    monkeypatch.setattr(external_encode.urllib.request, "urlopen", lambda req, timeout=20: FakeResponse())

    result = asyncio.run(external_encode.search_encode_tracks(genome="hg38", target="ignored"))

    assert result["supported"] is True
    assert result["tracks"] == [{
        "url": "https://www.encodeproject.org/files/ENCFF1/@@download/file.bigWig",
        "label": "Pol II \u00b7 embryo \u00b7 signal \u00b7 ENCSR1",
        "output_type": "signal",
        "dataset": "ENCSR1",
        "file_size": 123,
    }]
