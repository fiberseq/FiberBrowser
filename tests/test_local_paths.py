from services.local_paths import clean_local_path, path_access_error


def test_clean_local_path_unquotes_file_uri():
    assert clean_local_path('"file:///tmp/example%20file.bam"') == "/tmp/example file.bam"


def test_path_access_error_mentions_windows_network_drive_hint():
    error = path_access_error("/mnt/z/lab/sample.bam", expected="file")

    assert error is not None
    assert "mapped network drive" in error
    assert "Mount the share inside WSL" in error
