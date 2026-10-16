from services.file_picker import list_directory_payload


def test_lists_folders_first_and_hides_dotfiles(tmp_path):
    (tmp_path / "b.bam").write_bytes(b"x")
    (tmp_path / "a_dir").mkdir()
    (tmp_path / ".hidden").write_text("x")
    result = list_directory_payload(str(tmp_path))
    assert result["success"] is True
    assert [entry["name"] for entry in result["entries"]] == ["a_dir", "b.bam"]
    assert result["entries"][1]["size"] == 1
    assert result["parent"] == str(tmp_path.parent)


def test_a_file_path_lists_its_folder_and_missing_paths_fail(tmp_path):
    (tmp_path / "x.bb").write_bytes(b"")
    assert list_directory_payload(str(tmp_path / "x.bb"))["path"] == str(tmp_path)
    assert list_directory_payload(str(tmp_path / "missing"))["success"] is False


def test_a_typed_file_past_the_cap_is_still_listed_and_selected(tmp_path, monkeypatch):
    import services.file_picker as fp
    monkeypatch.setattr(fp, "MAX_LISTED_ENTRIES", 2)
    for name in ("a.bam", "b.bam", "c.bam"):
        (tmp_path / name).write_bytes(b"")
    result = fp.list_directory_payload(str(tmp_path / "c.bam"))
    assert result["truncated"] is True
    assert result["selected"] == str(tmp_path / "c.bam")
    assert [entry["name"] for entry in result["entries"]] == ["a.bam", "b.bam", "c.bam"]


class _Done:
    def __init__(self, returncode, stderr=""):
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = ""


def test_dialog_cancel_is_not_confused_with_a_dialog_that_could_not_open():
    from services.file_picker import _cancelled_or_failed
    assert _cancelled_or_failed(_Done(1, "execution error: User canceled. (-128)"), "File")["cancelled"] is True
    assert _cancelled_or_failed(_Done(1, "Gtk-Message: GtkDialog mapped without a transient parent"), "File")["cancelled"] is True
    assert _cancelled_or_failed(_Done(1, "(zenity): Gtk-WARNING: cannot open display: "), "File")["cancelled"] is False
    assert _cancelled_or_failed(_Done(1, "Not authorized to send Apple events to System Events. (-1743)"), "Folder")["cancelled"] is False
    assert _cancelled_or_failed(_Done(255), "File")["cancelled"] is False


def test_a_typed_hidden_file_is_listed_and_selected(tmp_path):
    (tmp_path / ".secret.bam").write_bytes(b"12")
    result = list_directory_payload(str(tmp_path / ".secret.bam"))
    assert result["selected"] == str(tmp_path / ".secret.bam")
    assert result["entries"][-1]["size"] == 2
