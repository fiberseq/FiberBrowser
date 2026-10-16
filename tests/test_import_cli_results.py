"""Results from the FiberHMM command line can be imported (release audit: CLI/transfer runs record no Browser sources).

fiberhmm-consensus (and fiberhmm-transfer, which writes ordinary recaller runs with a 'transfer' block) record their
input BAMs (path, size, mtime) under dataset ids like dataset_1. Import matches them to the open dataset holding
exactly those BAMs and renames the result's datasets to it, as a Browser run of that dataset would have named them."""
import copy
import gzip
import json
from pathlib import Path

import pysam
import pytest

from services.fiberhmm_runtime import configure_fiberhmm_runtime
configure_fiberhmm_runtime()
from fiberhmm.io.bam_header import append_chemistry
from services import consensus_workflow as cw
from state.browser_state import BrowserState


def _bam(path):
    header = pysam.AlignmentHeader.from_dict({'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': 'chr1', 'LN': 1000}]})
    header = append_chemistry(header, dict(assay='daf', enzyme='ddda', platform='pacbio', mode='daf'))
    with pysam.AlignmentFile(str(path), 'wb', header=header) as bam:
        for i in range(3):
            read = pysam.AlignedSegment(header); read.query_name = f'molecule_{i}'
            read.query_sequence = 'AYGT'*50; read.reference_id = 0; read.reference_start = 100 + i
            read.mapping_quality = 60; read.cigarstring = '200M'; read.set_tag('st', 'CT')
            read.set_tag('MA', '200;msp:1-200;tf:61-80'); bam.write(read)
    pysam.index(str(path))
    return path


@pytest.fixture(scope='module')
def cli_run(tmp_path_factory):
    from fiberhmm.inference.consensus import cli
    root = tmp_path_factory.mktemp('cli')
    bam = _bam(root/'calls.bam')
    cli.main(['--bam', str(bam), '--region', 'chr1:120-300', '--no-bam', '--output', str(root/'run')])
    path = next((root/'run').rglob('result.json.gz'))
    return bam, path.read_bytes()


def _state(bam, dataset_id='napa'):
    state = BrowserState(None)
    state.add_dataset(dataset_id, str(bam))
    return state


def test_cli_result_is_matched_to_the_open_bam_and_renamed(cli_run):
    bam, raw = cli_run
    result = json.loads(gzip.decompress(raw))
    assert not result['manifest'].get('browser_sources') and list(result['datasets']) == ['dataset_1']
    state = _state(bam)
    summary = cw.import_result(state, raw)
    assert summary['status'] == 'complete' and 'command-line' in summary['message']
    job = cw._session(state)[0][summary['job_id']]
    assert list(job['result']['datasets']) == ['napa'] and job['request']['dataset_ids'] == ['napa']
    units = job['result']['datasets']['napa']['units']
    assert units and all(u['unit_id'].startswith('napa::') for u in units)
    assert all(str(u.get('library_id', 'browser:napa:')).startswith('browser:napa:') for u in units)
    assert job['_snapshot'] == cw._snapshot(state, ['napa'])
    assert state.consensus_workflow_active == summary['job_id']
    assert cw.activate(state, summary['job_id'])['status'] == 'complete'     # sources verified again later


def test_cli_result_needs_its_bams_open(cli_run, tmp_path):
    bam, raw = cli_run
    other = _bam(tmp_path/'other.bam')
    with pytest.raises(ValueError, match='Open the BAM file'):
        cw.import_result(_state(other), raw)


def test_pooled_bed_results_have_no_genomic_frame(cli_run):
    bam, raw = cli_run
    result = json.loads(gzip.decompress(raw))
    result['manifest']['region'] = dict(chrom='oriented_BED', start=0, end=200)
    with pytest.raises(ValueError, match='oriented BED windows'):
        cw.import_result(_state(bam), json.dumps(result).encode())


def test_transfer_results_import_and_report_their_catalog(cli_run):
    bam, raw = cli_run
    result = json.loads(gzip.decompress(raw))
    result['transfer'] = result['manifest']['transfer'] = dict(schema='fiberhmm.frozen_transfer.lattice_recaller.v1',
                                                               catalog_sha256='abc123def4567890', window=None)
    summary = cw.import_result(_state(bam), json.dumps(result).encode())
    assert 'fiberhmm-transfer' in summary['message'] and 'abc123def456' in summary['message']
    assert summary['transfer']['catalog_sha256'] == 'abc123def4567890'


def test_remapping_renames_every_dataset_reference():
    result = {'datasets': {'dataset_1': {'units': [{'unit_id': 'dataset_1::m1', 'library_id': 'browser:dataset_1:/x.bam',
                                                     'strand': 'dataset_1'}]}},
              'manifest': {'datasets': [{'dataset_id': 'dataset_1'}], 'realized_channels': {'dataset_1': ['CT']}},
              'recaller': {'rows': [{'dataset': 'dataset_1', 'channel': 'dataset_1::CT', 'class_id': 'class_001'}]}}
    out = cw._remap_dataset_ids(copy.deepcopy(result), {'dataset_1': 'napa'})
    unit = out['datasets']['napa']['units'][0]
    assert unit == {'unit_id': 'napa::m1', 'library_id': 'browser:napa:/x.bam', 'strand': 'dataset_1'}   # only id fields
    assert out['manifest'] == {'datasets': [{'dataset_id': 'napa'}], 'realized_channels': {'napa': ['CT']}}
    assert out['recaller']['rows'][0] == {'dataset': 'napa', 'channel': 'napa::CT', 'class_id': 'class_001'}
