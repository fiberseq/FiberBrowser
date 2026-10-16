"""Chromosome name normalization and translation utilities."""

# Roman numeral mapping (yeast chrI..chrXVI <-> 1..16). 'X' is left out on
# purpose: in most genomes chrX is the sex chromosome, and mapping it to 10
# merged chrX with chr10. Yeast chrX still matches 'X' / 'chrX'.
_ROMAN_TO_ARABIC = {
    'I': '1', 'II': '2', 'III': '3', 'IV': '4', 'V': '5',
    'VI': '6', 'VII': '7', 'VIII': '8', 'IX': '9',
    'XI': '11', 'XII': '12', 'XIII': '13', 'XIV': '14', 'XV': '15',
    'XVI': '16', 'XVII': '17', 'XVIII': '18', 'XIX': '19', 'XX': '20',
}
_ARABIC_TO_ROMAN = {v: k for k, v in _ROMAN_TO_ARABIC.items()}


def normalize_chrom_name(chrom: str) -> str:
    """Normalize chromosome name to canonical form (lowercase, no 'chr', Arabic numerals)."""
    name = chrom.lower()
    if name.startswith('chr'):
        name = name[3:]

    upper_name = name.upper()
    if upper_name in _ROMAN_TO_ARABIC:
        name = _ROMAN_TO_ARABIC[upper_name]

    if name in ('m', 'mt', 'mito', 'mitochondria', 'mitochondrion'):
        name = 'mt'

    return name


def _alias_keys(name: str) -> set:
    lower = str(name or '').lower()
    stripped = lower[3:] if lower.startswith('chr') else lower
    keys = {lower, stripped, f'chr{stripped}'}
    if stripped in ('m', 'mt'):
        keys |= {'m', 'mt', 'chrm', 'chrmt'}
    return keys


def same_chrom(a: str, b: str) -> bool:
    """Whether two names mean the same contig ('chr1' / '1', 'chrM' / 'MT');
    the frontend's chromAliases.sameChrom rule."""
    if a == b:
        return True
    return bool(_alias_keys(a) & _alias_keys(b))


def build_chrom_map(chroms: list) -> dict:
    """Build mapping from normalized chrom names to actual names."""
    chrom_map = {}
    for c in chroms:
        name = c.name if hasattr(c, 'name') else str(c)
        normalized = normalize_chrom_name(name)
        chrom_map[normalized] = name
        chrom_map[name.lower()] = name
    return chrom_map


def translate_chrom(chrom: str, chrom_map: dict) -> str:
    """Translate a chromosome name to the dataset's actual name."""
    if chrom in chrom_map.values():
        return chrom

    normalized = normalize_chrom_name(chrom)
    if normalized in chrom_map:
        return chrom_map[normalized]

    if chrom.lower() in chrom_map:
        return chrom_map[chrom.lower()]

    return chrom


def get_chrom_variants(chrom: str) -> list:
    """Get all possible variants of a chromosome name for flexible matching.

    Name spellings only (chr1 / 1, chrM / MT, roman numerals), the same for
    every file and workspace. A plasmid map's link to a BAM contig of another
    name belongs to one workspace, dataset and frame: readers get it from
    ``services.plasmid_reconcile.contig_links`` and pass it to
    ``resolve_reference_name`` as ``links``.
    """
    variants = [chrom]

    if chrom.startswith('chr'):
        variants.append(chrom[3:])
    else:
        variants.append('chr' + chrom)

    norm = normalize_chrom_name(chrom)
    if norm in _ARABIC_TO_ROMAN:
        roman = _ARABIC_TO_ROMAN[norm]
        # Both spellings: chrIV <-> IV, 4, chr4 (a roman name normalizes to arabic).
        variants.extend([roman, 'chr' + roman, norm, 'chr' + norm])
    if norm.upper() in _ROMAN_TO_ARABIC:
        arabic = _ROMAN_TO_ARABIC[norm.upper()]
        variants.extend([arabic, 'chr' + arabic])

    if norm == 'mt':
        variants.extend(['M', 'chrM', 'MT', 'chrMT', 'chrMito'])

    return list(dict.fromkeys(variants))


def resolve_reference_name(chrom: str, references, chrom_map: dict | None = None,
                           links: dict | None = None) -> str | None:
    """The name a file (e.g. a BAM) uses for ``chrom``, or None if it has none.

    Tries the name itself, its mapped name and every alias (chr1 / 1, chrM /
    MT, roman numerals), always checked against the file's own references:
    the session's chrom map follows the FASTA, whose names may differ from
    the file's.

    ``links`` is this file's plasmid links in the caller's workspace,
    ``{file contig: chromosome it is shown on}`` (see
    ``services.plasmid_reconcile.contig_links``): a contig linked to
    ``chrom`` is its name there whatever it is called, and a contig linked to
    another chromosome (e.g. the same plasmid in another frame) never
    stands for ``chrom`` by name.
    """
    refs = set(references or ())
    if links:
        for contig, target in links.items():
            if target == chrom and contig in refs:
                return contig
        refs -= {contig for contig, target in links.items() if target != chrom}
    candidates = [chrom]
    if chrom_map:
        candidates.append(chrom_map.get(chrom))
    for variant in get_chrom_variants(chrom):
        candidates.append(variant)
        if chrom_map:
            candidates.append(chrom_map.get(variant))
    for candidate in candidates:
        if candidate and candidate in refs:
            return candidate
    return None
