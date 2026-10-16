# Third-party programs and data bundled with FiberBrowser (the Mac app and the
# WSL distribution): pinned releases, their checksums and a fetch helper.
# Sourced by macos/build_app.sh and windows/build_wsl_distro.sh.
#
# BLAST+ (blastn, makeblastdb only), Mac app: NCBI's macOS release binaries.
#   NCBI's code is public domain (a "United States Government Work"; the
#   tarball's LICENSE); the binaries statically include third-party libraries
#   with their own licences (third_party/blast/BLAST-THIRD-PARTY.txt; the macOS
#   build has no LZO or zstd). NCBI publishes md5 sums; the sha256 below was
#   taken from a tarball whose md5 matched NCBI's.
#   The WSL distribution uses Debian bookworm's ncbi-blast+ package instead
#   (windows/Dockerfile): no pin here.
# D. melanogaster TE library (every build: Identify): the canonical transposon sequence set v10.2
#   (Bergman lab, continuing FlyBase's set), FASTA + GFF3, CC0 1.0. Pinned to
#   a commit of github.com/bergmanlab/drosophila-transposons.
#
# minimap2 stays pinned in each build script (it is built from source there).

BLAST_VERSION=2.17.0
BLAST_URL="https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/$BLAST_VERSION"
BLAST_MACOS_TARBALL="ncbi-blast-$BLAST_VERSION+-aarch64-macosx.tar.gz"
BLAST_MACOS_SHA256=8d6739fa133107bce91dbb6b143ec993c9983416244fe502f9c36d585850dc00
BLAST_PROGRAMS="blastn makeblastdb"

TE_DMEL_ID=dmel-canonical-v10.2
TE_DMEL_COMMIT=9b28cdbe9d2b3ef895df37f8495b33104677e516
TE_DMEL_URL="https://raw.githubusercontent.com/bergmanlab/drosophila-transposons/$TE_DMEL_COMMIT"
# path in the repository, sha256
TE_DMEL_FILES="releases/D_mel_transposon_sequence_set_v10.2.fa 8f06ef5d5010f9caa08938d4b62e8d8f11cdba821765e274c9c13df68c88612d
releases/transposon_sequence_set_v10.2.gff e68526fca03e23b73869f56779dbd49aeef092de6c4d760339d24d4174e15e42
LICENSE a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499"

sha256_ok() {  # file, sha256
  [ -f "$1" ] && [ "$(shasum -a 256 "$1" | cut -d' ' -f1)" = "$2" ]
}

# fetch_pinned DEST SHA256 URL [LOCAL]: DEST when it is already there with that
# checksum; else LOCAL (a copy the builder points at) when given; else the
# download. A file whose checksum doesn't match is never used.
fetch_pinned() {
  local dest="$1" sha="$2" url="$3" local_copy="${4:-}"
  if sha256_ok "$dest" "$sha"; then return 0; fi
  rm -f "$dest"
  mkdir -p "$(dirname "$dest")"
  rm -f "$dest.part"
  if [ -n "$local_copy" ]; then
    [ -f "$local_copy" ] || { echo "  $local_copy: no such file" >&2; return 1; }
    cp "$local_copy" "$dest.part" || { rm -f "$dest.part"; echo "  could not copy $local_copy" >&2; return 1; }
    url="$local_copy"
  elif ! curl -fsSL --retry 3 -o "$dest.part" "$url"; then
    rm -f "$dest.part"
    echo "  could not download $url (offline? point the build at a local copy; see the script's settings)" >&2
    return 1
  fi
  # The copy itself is checked (not its source), then put in place in one step.
  sha256_ok "$dest.part" "$sha" || { rm -f "$dest.part"; echo "  $url: checksum mismatch (expected sha256 $sha)" >&2; return 1; }
  mv "$dest.part" "$dest" || { rm -f "$dest.part"; return 1; }
  sha256_ok "$dest" "$sha"
}

# fetch_te_dmel DIR [LOCAL_DIR]: the pinned TE library files into DIR (flat:
# the FASTA, the GFF and LICENSE), from LOCAL_DIR when given (same file names).
fetch_te_dmel() {
  local dir="$1" local_dir="${2:-}" path sha name
  while read -r path sha; do
    name="$(basename "$path")"
    fetch_pinned "$dir/$name" "$sha" "$TE_DMEL_URL/$path" "${local_dir:+$local_dir/$name}" || return 1
  done <<EOF
$TE_DMEL_FILES
EOF
}
