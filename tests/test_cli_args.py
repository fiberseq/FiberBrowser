from services.cli_args import parse_browser_args


def test_cli_defaults_match_browser_startup_defaults():
    args = parse_browser_args([])

    assert args.port == 8000
    assert args.prefetch == 10
    assert args.max_working_reads == 0
    assert args.public is False
    assert args.standalone is False
    assert args.dataset is None
    assert args.open_browser is None


def test_cli_allows_repeated_dataset_and_plugin_args():
    args = parse_browser_args([
        "--dataset", "/data/a.bam:A",
        "--dataset", "/data/b.bam:B",
        "--plugin", "/plugins/one",
        "--plugin", "/plugins/two",
        "--public",
        "--catalog", "/catalog.json",
    ])

    assert args.dataset == ["/data/a.bam:A", "/data/b.bam:B"]
    assert args.plugin == ["/plugins/one", "/plugins/two"]
    assert args.public is True
    assert args.catalog == "/catalog.json"


def test_cli_browser_open_flags_are_mutually_exclusive():
    assert parse_browser_args(["--open-browser"]).open_browser is True
    assert parse_browser_args(["--no-open-browser"]).open_browser is False
    assert parse_browser_args(["--no-open"]).open_browser is False
