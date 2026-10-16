"""Native plasmid-map import helpers.

This intentionally stays conservative: text formats are parsed structurally,
while SnapGene `.dna` files use packet-tolerant extraction for the embedded
sequence and XML-like feature records that SnapGene stores in the binary file.
"""
from __future__ import annotations

import os
import re
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from urllib.parse import unquote


DNA_RE = re.compile(rb"[ACGTNacgtn]{50,}")
FASTA_EXTS = (".fa", ".fasta", ".fna")
GFF_EXTS = (".gff3", ".gff")
BED_EXTS = (".bed",)
SBOL_EXTS = (".xml", ".rdf", ".sbol", ".ttl")
SUPPORTED_FORMATS = (
    ".dna, .gb, .gbk, .genbank, .embl, .emb, .fa, .fasta, .fna, "
    ".gff3, .gff, .bed, .xml, .rdf, .sbol, .ttl"
)
RDF_ABOUT = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about"
RDF_RESOURCE = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}resource"


@dataclass
class PlasmidFeature:
    name: str
    start: int
    end: int
    strand: str = "+"
    kind: str = "feature"


@dataclass
class PlasmidMap:
    name: str
    sequence: str
    circular: bool = True
    features: list[PlasmidFeature] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _safe_name(path: str) -> str:
    stem = os.path.splitext(os.path.basename(path))[0] or "plasmid"
    return _safe_identifier(stem)


def _safe_identifier(value: str, fallback: str = "plasmid") -> str:
    stem = str(value or fallback).split()[0] or fallback
    cleaned = re.sub(r"[^0-9A-Za-z_.-]+", "_", stem).strip("_")
    return cleaned or fallback


def _open_map(path: str, binary: bool = False):
    """A map/annotation file: plain ``open`` off the lab profile; on a lab server only
    inside its data roots, opened by the checked descriptor walk (services/lab/paths.py)."""
    from services.lab.paths import enforcing, open_read
    if not enforcing():
        return open(path, "rb") if binary else open(path, "rt", encoding="utf-8", errors="replace")
    return open_read(path) if binary else open_read(path, text=True)


def _read_text(path: str) -> str:
    with _open_map(path) as handle:
        return handle.read()


def _clean_name(value: str, fallback: str = "feature") -> str:
    cleaned = re.sub(r"\s+", " ", str(value or "").strip())
    return cleaned or fallback


def _qualifier_value(qualifiers: str, keys: tuple[str, ...] = ("gene", "label", "product", "note")) -> str | None:
    for key in keys:
        match = re.search(rf"/{re.escape(key)}=(?:\"([^\"]+)\"|([^\s]+))", qualifiers)
        if match:
            return _clean_name(match.group(1) or match.group(2))
    return None


def _select_attribute(attrs: dict[str, str], fallback: str = "feature") -> str:
    for key in ("Name", "gene", "label", "product", "note", "locus_tag", "ID"):
        value = attrs.get(key)
        if value:
            return _clean_name(value, fallback=fallback)
    return fallback


def _parse_location_span(location: str, seq_len: int | None = None) -> tuple[int, int, str] | None:
    clean = str(location or "").replace("<", "").replace(">", "")
    strand = "-" if "complement" in clean.lower() else "+"
    ranges = [(int(a), int(b)) for a, b in re.findall(r"(\d+)\s*\.\.\s*(\d+)", clean)]
    if not ranges:
        singles = [int(value) for value in re.findall(r"(?<!\d)(\d+)(?!\d)", clean)]
        if not singles:
            return None
        ranges = [(singles[0], singles[0])]

    if seq_len and len(ranges) > 1 and ranges[-1][1] < ranges[0][0]:
        return max(0, ranges[0][0] - 1), max(ranges[0][0], ranges[-1][1] + int(seq_len)), strand

    start = max(0, min(a for a, _b in ranges) - 1)
    end = max(b for _a, b in ranges)
    return start, max(start + 1, end), strand


def _companion_path(path: str, exts: tuple[str, ...]) -> str | None:
    root, _ext = os.path.splitext(path)
    from services.lab.paths import readable
    for ext in exts:
        candidate = root + ext
        # A lab server: a companion resolving outside its data roots is not one.
        if os.path.exists(candidate) and readable(candidate):
            return candidate
    return None


def _local_name(tag: str) -> str:
    text = str(tag)
    if "}" in text:
        text = text.rsplit("}", 1)[1]
    if "#" in text:
        text = text.rsplit("#", 1)[1]
    return text


def _rdf_subject(elem: ET.Element) -> str | None:
    return elem.attrib.get(RDF_ABOUT) or elem.attrib.get("about") or elem.attrib.get("id")


def _rdf_resource(elem: ET.Element) -> str | None:
    return elem.attrib.get(RDF_RESOURCE) or elem.attrib.get("resource") or elem.attrib.get("href")


def _child_text(elem: ET.Element, names: set[str]) -> str | None:
    for child in list(elem):
        if _local_name(child.tag) in names and child.text and child.text.strip():
            return child.text.strip()
    return None


def _descendant_text(elem: ET.Element, names: set[str]) -> str | None:
    for child in elem.iter():
        if child is elem:
            continue
        if _local_name(child.tag) in names and child.text and child.text.strip():
            return child.text.strip()
    return None


def _descendant_resource(elem: ET.Element, names: set[str]) -> str | None:
    for child in elem.iter():
        if child is elem:
            continue
        if _local_name(child.tag) in names:
            resource = _rdf_resource(child)
            if resource:
                return resource
    return None


def _orientation_to_strand(value: str | None) -> str:
    normalized = str(value or "").lower()
    return "-" if "reverse" in normalized or "complement" in normalized else "+"


def _has_circular_topology(elem: ET.Element) -> bool:
    for child in elem.iter():
        text = " ".join(value for value in [child.text, _rdf_resource(child)] if value)
        if _local_name(child.tag).lower() == "topology" and "circular" in text.lower():
            return True
    return False


def _has_topology(elem: ET.Element) -> bool:
    return any(_local_name(child.tag).lower() == "topology" for child in elem.iter())


def _read_first_fasta(path: str) -> tuple[str, str]:
    name = _safe_name(path)
    sequence_lines: list[str] = []
    seen_first_record = False
    with _open_map(path) as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith(">"):
                if seen_first_record:
                    break
                seen_first_record = True
                name = _safe_identifier(stripped[1:] or name)
                continue
            if seen_first_record or not sequence_lines:
                sequence_lines.append(stripped)

    sequence = re.sub(r"[^ACGTNacgtn]", "", "".join(sequence_lines)).upper()
    if not sequence:
        raise ValueError("No DNA sequence found in FASTA file")
    return name, sequence


def _filter_features_for_seq(rows: list[tuple[str, PlasmidFeature]], seq_names: set[str]) -> list[PlasmidFeature]:
    if not rows:
        return []
    normalized_names = {name.lower() for name in seq_names if name}
    exact = [feature for seqid, feature in rows if seqid.lower() in normalized_names]
    if exact:
        return exact
    unique_seqids = {seqid for seqid, _feature in rows}
    if len(unique_seqids) == 1:
        return [feature for _seqid, feature in rows]
    return []


def _parse_gff_attributes(raw: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for part in raw.split(";"):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            key, value = part.split("=", 1)
        elif " " in part:
            key, value = part.split(" ", 1)
        else:
            continue
        attrs[key.strip()] = unquote(value.strip().strip('"'))
    return attrs


def parse_gff_features(path: str, seq_names: set[str] | None = None) -> list[PlasmidFeature]:
    rows: list[tuple[str, PlasmidFeature]] = []
    with _open_map(path) as handle:
        for line in handle:
            if not line.strip() or line.startswith("#"):
                continue
            fields = line.rstrip("\n").split("\t")
            if len(fields) < 9:
                continue
            seqid, _source, kind, start_raw, end_raw, _score, strand_raw, _phase, attrs_raw = fields[:9]
            try:
                start = max(0, int(start_raw) - 1)
                end = max(start + 1, int(end_raw))
            except ValueError:
                continue
            attrs = _parse_gff_attributes(attrs_raw)
            kind = kind if kind and kind != "." else "feature"
            if kind.lower() in {"region", "chromosome", "contig"}:
                continue
            strand = strand_raw if strand_raw in {"+", "-"} else "+"
            rows.append((
                seqid,
                PlasmidFeature(
                    name=_select_attribute(attrs, fallback=kind),
                    start=start,
                    end=end,
                    strand=strand,
                    kind=kind,
                ),
            ))
    return _filter_features_for_seq(rows, seq_names or set())


def parse_bed_features(path: str, seq_names: set[str] | None = None) -> list[PlasmidFeature]:
    rows: list[tuple[str, PlasmidFeature]] = []
    with _open_map(path) as handle:
        for line in handle:
            if not line.strip() or line.startswith(("#", "track", "browser")):
                continue
            fields = re.split(r"\s+", line.strip())
            if len(fields) < 3:
                continue
            seqid = fields[0]
            try:
                start = max(0, int(fields[1]))
                end = max(start + 1, int(fields[2]))
            except ValueError:
                continue
            name = fields[3] if len(fields) > 3 and fields[3] else "feature"
            strand = fields[5] if len(fields) > 5 and fields[5] in {"+", "-"} else "+"
            rows.append((
                seqid,
                PlasmidFeature(name=_clean_name(name), start=start, end=end, strand=strand, kind="bed_feature"),
            ))
    return _filter_features_for_seq(rows, seq_names or set())


def _parse_snapgene_features(text: str) -> list[PlasmidFeature]:
    features: list[PlasmidFeature] = []
    for raw in re.findall(r"<Feature\b[\s\S]*?</Feature>", text):
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            continue
        name = root.attrib.get("name") or root.attrib.get("label") or "feature"
        direction = (root.attrib.get("directionality") or root.attrib.get("direction") or "").lower()
        strand = "-" if "back" in direction or direction == "-" else "+"
        ranges: list[tuple[int, int]] = []
        for segment in root.iter():
            raw_range = segment.attrib.get("range") or segment.attrib.get("ranges")
            if not raw_range:
                continue
            match = re.search(r"(\d+)\s*[-.]{1,2}\s*(\d+)", raw_range)
            if not match:
                continue
            start = max(0, int(match.group(1)) - 1)
            end = max(start + 1, int(match.group(2)))
            ranges.append((start, end))
        if not ranges:
            continue
        features.append(
            PlasmidFeature(
                name=name,
                start=min(start for start, _end in ranges),
                end=max(end for _start, end in ranges),
                strand=strand,
                kind=root.attrib.get("type") or "feature",
            )
        )
    return features


def parse_snapgene(path: str) -> PlasmidMap:
    with _open_map(path, binary=True) as handle:
        data = handle.read()
    matches = DNA_RE.findall(data)
    if not matches:
        raise ValueError("No DNA sequence found in SnapGene file")
    sequence = max(matches, key=len).decode("ascii").upper()
    text = data.decode("latin1", "ignore")
    return PlasmidMap(
        name=_safe_name(path),
        sequence=sequence,
        circular=True,
        features=_parse_snapgene_features(text),
        warnings=[
            "SnapGene .dna import is best-effort; export GenBank/GBK for exact sequence and feature parsing.",
        ],
    )


def parse_genbank(path: str) -> PlasmidMap:
    text = _read_text(path)
    name = _safe_name(path)
    locus = re.search(r"^LOCUS\s+(\S+).*(circular|linear)?", text, re.MULTILINE | re.IGNORECASE)
    circular = True
    if locus:
        name = re.sub(r"[^0-9A-Za-z_.-]+", "_", locus.group(1)) or name
        circular = "linear" not in locus.group(0).lower()

    origin = text.split("ORIGIN", 1)
    if len(origin) < 2:
        raise ValueError("No ORIGIN sequence block found in GenBank file")
    sequence = re.sub(r"[^ACGTNacgtn]", "", origin[1].split("//", 1)[0]).upper()
    if not sequence:
        raise ValueError("No DNA sequence found in GenBank ORIGIN block")

    features: list[PlasmidFeature] = []
    feature_block = text.split("FEATURES", 1)
    if len(feature_block) > 1:
        block = feature_block[1].split("ORIGIN", 1)[0]
        features = _parse_genbank_features(block, len(sequence))

    return PlasmidMap(name=name, sequence=sequence, circular=circular, features=features)


def _parse_genbank_features(block: str, seq_len: int) -> list[PlasmidFeature]:
    features: list[PlasmidFeature] = []
    current: dict[str, str] | None = None

    def flush() -> None:
        nonlocal current
        if not current:
            return
        span = _parse_location_span(current.get("location", ""), seq_len=seq_len)
        if not span:
            current = None
            return
        start, end, strand = span
        kind = current.get("kind") or "feature"
        features.append(
            PlasmidFeature(
                name=_qualifier_value(current.get("qualifiers", "")) or kind,
                start=start,
                end=end,
                strand=strand,
                kind=kind,
            )
        )
        current = None

    for line in block.splitlines():
        if not line.startswith("     ") or "Location/Qualifiers" in line:
            continue
        key = line[5:21].strip()
        value = line[21:].strip()
        if key:
            flush()
            current = {"kind": key, "location": value, "qualifiers": ""}
        elif current and value.startswith("/"):
            current["qualifiers"] += " " + value
        elif current and value:
            current["location"] += value
    flush()
    return features


def _parse_embl_features(text: str, seq_len: int) -> list[PlasmidFeature]:
    features: list[PlasmidFeature] = []
    current: dict[str, str] | None = None

    def flush() -> None:
        nonlocal current
        if not current:
            return
        span = _parse_location_span(current.get("location", ""), seq_len=seq_len)
        if not span:
            current = None
            return
        start, end, strand = span
        qualifiers = current.get("qualifiers", "")
        kind = current.get("kind") or "feature"
        features.append(
            PlasmidFeature(
                name=_qualifier_value(qualifiers) or kind,
                start=start,
                end=end,
                strand=strand,
                kind=kind,
            )
        )
        current = None

    for line in text.splitlines():
        if not line.startswith("FT"):
            continue
        key = line[5:21].strip()
        value = line[21:].strip()
        if key:
            flush()
            current = {"kind": key, "location": value, "qualifiers": ""}
        elif current and value.startswith("/"):
            current["qualifiers"] += " " + value
        elif current and value:
            current["location"] += value
    flush()
    return features


def parse_embl(path: str) -> PlasmidMap:
    text = _read_text(path)
    name = _safe_name(path)
    circular = True
    id_match = re.search(r"^ID\s+([^;\s]+).*", text, re.MULTILINE | re.IGNORECASE)
    if id_match:
        name = re.sub(r"[^0-9A-Za-z_.-]+", "_", id_match.group(1)) or name
        id_line = id_match.group(0).lower()
        circular = "linear" not in id_line

    sq_match = re.search(r"^SQ\s+.*?$([\s\S]*?)^//", text, re.MULTILINE)
    if not sq_match:
        raise ValueError("No SQ sequence block found in EMBL file")
    sequence = re.sub(r"[^ACGTNacgtn]", "", sq_match.group(1)).upper()
    if not sequence:
        raise ValueError("No DNA sequence found in EMBL SQ block")

    return PlasmidMap(
        name=name,
        sequence=sequence,
        circular=circular,
        features=_parse_embl_features(text, len(sequence)),
    )


def parse_fasta_plasmid(path: str, feature_path: str | None = None) -> PlasmidMap:
    name, sequence = _read_first_fasta(path)
    seq_names = {name, _safe_name(path)}
    warnings: list[str] = []

    if feature_path is None:
        feature_path = _companion_path(path, GFF_EXTS) or _companion_path(path, BED_EXTS)

    features: list[PlasmidFeature] = []
    if feature_path:
        lower = feature_path.lower()
        if lower.endswith(GFF_EXTS):
            features = parse_gff_features(feature_path, seq_names=seq_names)
        elif lower.endswith(BED_EXTS):
            features = parse_bed_features(feature_path, seq_names=seq_names)
        else:
            warnings.append(f"Unsupported companion annotation format: {os.path.basename(feature_path)}")
        if not features:
            warnings.append(f"No matching annotation rows found in {os.path.basename(feature_path)}")
    else:
        warnings.append("No companion GFF3 or BED annotation file found for FASTA plasmid import.")

    return PlasmidMap(name=name, sequence=sequence, circular=True, features=features, warnings=warnings)


def parse_annotation_with_companion_fasta(path: str) -> PlasmidMap:
    fasta_path = _companion_path(path, FASTA_EXTS)
    if not fasta_path:
        raise ValueError(
            f"Annotation-only plasmid imports need a same-name FASTA companion ({', '.join(FASTA_EXTS)})"
        )
    return parse_fasta_plasmid(fasta_path, feature_path=path)


def _parse_sbol_features(parent: ET.Element, seq_len: int) -> list[PlasmidFeature]:
    features: list[PlasmidFeature] = []
    for annotation in parent.iter():
        if _local_name(annotation.tag) not in {"SequenceAnnotation", "Feature", "SubComponent"}:
            continue
        name = (
            _child_text(annotation, {"displayId", "name", "label"})
            or _descendant_text(annotation, {"displayId", "name", "label"})
            or "feature"
        )
        role = _descendant_resource(annotation, {"role", "roles"})
        kind = role.rsplit("/", 1)[-1].rsplit("#", 1)[-1] if role else "feature"
        for location in annotation.iter():
            if _local_name(location.tag) not in {"Range", "Location"}:
                continue
            start_text = _child_text(location, {"start"})
            end_text = _child_text(location, {"end"})
            if not start_text or not end_text:
                continue
            try:
                start = max(0, int(start_text) - 1)
                end = max(start + 1, int(end_text))
            except ValueError:
                continue
            orientation = _descendant_resource(location, {"orientation"}) or _child_text(location, {"orientation"})
            features.append(
                PlasmidFeature(
                    name=_clean_name(name),
                    start=start,
                    end=end,
                    strand=_orientation_to_strand(orientation),
                    kind=kind or "feature",
                )
            )
    deduped: list[PlasmidFeature] = []
    seen: set[tuple[str, int, int, str, str]] = set()
    for feature in features:
        key = (feature.name, feature.start, feature.end, feature.strand, feature.kind)
        if key not in seen:
            seen.add(key)
            deduped.append(feature)
    return deduped


def _parse_sbol_turtle(path: str) -> PlasmidMap:
    text = _read_text(path)
    match = re.search(
        r"(?:sbol:elements|<[^>]*elements>)\s+(?:\"\"\"([\s\S]*?)\"\"\"|\"([^\"]+)\")",
        text,
        re.IGNORECASE,
    )
    if not match:
        raise ValueError("No SBOL sequence elements found in Turtle file")
    sequence = re.sub(r"[^ACGTNacgtn]", "", match.group(1) or match.group(2) or "").upper()
    if not sequence:
        raise ValueError("No DNA sequence found in SBOL Turtle file")
    name_match = re.search(r"(?:sbol:displayId|<[^>]*displayId>)\s+\"([^\"]+)\"", text, re.IGNORECASE)
    return PlasmidMap(
        name=_safe_identifier(name_match.group(1) if name_match else _safe_name(path)),
        sequence=sequence,
        circular="linear" not in text.lower(),
        warnings=["SBOL Turtle import is sequence-only best-effort; RDF/XML or GenBank preserves annotations better."],
    )


def parse_sbol(path: str) -> PlasmidMap:
    if path.lower().endswith(".ttl"):
        return _parse_sbol_turtle(path)

    try:
        root = ET.fromstring(_read_text(path))
    except ET.ParseError as exc:
        raise ValueError(f"Could not parse SBOL XML/RDF: {exc}") from exc

    sequences: dict[str, tuple[str, str]] = {}
    for elem in root.iter():
        if _local_name(elem.tag) != "Sequence":
            continue
        raw_sequence = _child_text(elem, {"elements"})
        if not raw_sequence:
            continue
        sequence = re.sub(r"[^ACGTNacgtn]", "", raw_sequence).upper()
        if not sequence:
            continue
        uri = _rdf_subject(elem) or f"sequence:{len(sequences)}"
        name = _child_text(elem, {"displayId", "name"}) or _safe_name(path)
        sequences[uri] = (_safe_identifier(name), sequence)

    if not sequences:
        raise ValueError("No SBOL sequence elements found")

    selected_uri, (name, sequence) = max(sequences.items(), key=lambda item: len(item[1][1]))
    components: list[ET.Element] = []
    for elem in root.iter():
        if _local_name(elem.tag) not in {"ComponentDefinition", "Component"}:
            continue
        if _descendant_resource(elem, {"sequence", "sequences"}) == selected_uri:
            components.append(elem)

    if components:
        component_name = _child_text(components[0], {"displayId", "name"})
        if component_name:
            name = _safe_identifier(component_name)
        topology_known = any(_has_topology(component) for component in components)
        circular = any(_has_circular_topology(component) for component in components) if topology_known else True
        features = [feature for component in components for feature in _parse_sbol_features(component, len(sequence))]
    else:
        circular = _has_circular_topology(root) if _has_topology(root) else True
        features = _parse_sbol_features(root, len(sequence))

    warnings = ["SBOL import is best-effort; export GenBank/GBK if feature placement looks off."]
    if not features:
        warnings.append("No ranged SBOL annotations were found.")

    return PlasmidMap(
        name=name,
        sequence=sequence,
        circular=circular,
        features=features,
        warnings=warnings,
    )


def parse_plasmid_map(path: str) -> PlasmidMap:
    lower = path.lower()
    if lower.endswith(".dna"):
        return parse_snapgene(path)
    if lower.endswith((".gb", ".gbk", ".genbank")):
        return parse_genbank(path)
    if lower.endswith((".embl", ".emb")):
        return parse_embl(path)
    if lower.endswith(FASTA_EXTS):
        return parse_fasta_plasmid(path)
    if lower.endswith(GFF_EXTS + BED_EXTS):
        return parse_annotation_with_companion_fasta(path)
    if lower.endswith(SBOL_EXTS):
        return parse_sbol(path)
    raise ValueError(f"Unsupported plasmid map format. Expected {SUPPORTED_FORMATS}")


def write_plasmid_fasta(plasmid: PlasmidMap, output_dir: str | None = None) -> str:
    output_dir = output_dir or os.path.join(tempfile.gettempdir(), "fiberbrowser_plasmids")
    os.makedirs(output_dir, exist_ok=True)
    fasta_path = os.path.join(output_dir, f"{plasmid.name}.fa")
    sequence = plasmid.sequence.upper()
    line_bases = 60
    # newline="\n": the .fai offsets assume 1-byte line ends (Windows would write 2).
    with open(fasta_path, "w", encoding="ascii", newline="\n") as handle:
        handle.write(f">{plasmid.name}\n")
        for i in range(0, len(sequence), line_bases):
            handle.write(sequence[i:i + line_bases] + "\n")

    offset = len(f">{plasmid.name}\n".encode("ascii"))
    line_width = line_bases + 1
    with open(fasta_path + ".fai", "w", encoding="ascii", newline="\n") as handle:
        handle.write(f"{plasmid.name}\t{len(sequence)}\t{offset}\t{line_bases}\t{line_width}\n")
    return fasta_path


def plasmid_features_to_gtf_data(plasmid: PlasmidMap):
    import pandas as pd
    from services.gene_annotations import exon_table
    from utils.chrom import normalize_chrom_name

    transcripts = []
    exons = []
    for idx, feature in enumerate(plasmid.features):
        feature_id = f"{plasmid.name}:{feature.kind}:{idx}"
        transcripts.append({
            "chrom": plasmid.name,
            "start": int(feature.start),
            "end": int(feature.end),
            "strand": feature.strand or "+",
            "transcript_id": feature_id,
            "gene_name": feature.name or feature.kind,
            "biotype": feature.kind or "feature",
            "norm_chrom": normalize_chrom_name(plasmid.name),
        })
        exons.append({
            "chrom": plasmid.name,
            "start": int(feature.start),
            "end": int(feature.end),
            "transcript_id": feature_id,
        })
    return {
        "transcripts": pd.DataFrame(transcripts),
        "exons": exon_table(exons),
    }
