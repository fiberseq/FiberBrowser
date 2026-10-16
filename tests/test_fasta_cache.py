"""Remote FASTA caching: one cache file per source."""
import os

from state.browser_state import cached_fasta_path, record_fasta_source


def test_same_file_name_from_another_source_gets_its_own_cache(tmp_path):
    cache = str(tmp_path)
    a = "https://host-a.org/ref/reference.fa.gz"
    b = "https://host-b.org/other/reference.fa.gz"
    path_a = cached_fasta_path(cache, [a])
    assert os.path.basename(path_a) == "reference.fa"
    (tmp_path / "reference.fa").write_text(">chr1\nACGT\n")
    record_fasta_source(path_a, a)
    # The same source (or a mirror listed with it) finds its cache again.
    assert cached_fasta_path(cache, [a]) == path_a
    assert cached_fasta_path(cache, ["https://mirror.org/reference.fa.gz", a]) == path_a
    # Another source with the same file name does not reuse it.
    path_b = cached_fasta_path(cache, [b])
    assert path_b != path_a and os.path.basename(path_b).startswith("reference.") and path_b.endswith(".fa")
    assert cached_fasta_path(cache, [b]) == path_b


def test_a_cache_from_before_sources_were_recorded_is_kept(tmp_path):
    (tmp_path / "hg38.fa").write_text(">chr1\nA\n")
    assert cached_fasta_path(str(tmp_path), ["https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/hg38.fa.gz"]) == str(tmp_path / "hg38.fa")
