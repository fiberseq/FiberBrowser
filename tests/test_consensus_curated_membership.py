"""B3 round 8: final-stage class membership follows curation, as displayed."""
from services import consensus_workflow as workflow
from services.consensus_curation import update_curation
from services.consensus_occupancy import class_occupancy
from test_consensus_stages import fixture


def test_final_stage_automatic_membership_follows_curation(monkeypatch):
    """Ignore M (the read's primary class): the display promotes N, and so must
    filtering and co-occupancy; an earlier stage keeps its own membership."""
    state, job = fixture()
    monkeypatch.setattr(workflow, '_register', lambda *args: None)
    assert workflow.state_read_ids(state, 'j', 'd', 'M')['read_ids'] == ['read']
    assert not workflow.membership_is_curated(job, 'resolved')  # no decision yet
    update_curation(state, 'j', dict(expected_revision=0, operation='ignore', dataset_id='d', family_ids=['M']))
    assert workflow.state_read_ids(state, 'j', 'd', 'M')['read_ids'] == []
    assert workflow.state_read_ids(state, 'j', 'd', 'N')['read_ids'] == ['read']

    monkeypatch.setattr(workflow, '_match_projection_unit', lambda index, read: ('u', '', 1))
    groups = [dict(consensusStateId=f, consensusJobId='j', sourceDatasetId='d', consensusStage='resolved')
              for f in ('M', 'N')]
    members, eligible = class_occupancy(state, 'd', 'chr1', [{'id': 'read'}], groups)
    assert members == {0: set(), 1: {'read'}} and eligible == {0: {'read'}, 1: {'read'}}

    # Looking at the earlier stage: the final stage's classes stay curated, and
    # the earlier stage's own class keeps its uncurated reads.
    workflow.select_stage(state, 'j', 'native')
    assert workflow.state_read_ids(state, 'j', 'd', 'N', stage='resolved')['read_ids'] == ['read']
    assert workflow.state_read_ids(state, 'j', 'd', 'A')['read_ids'] == ['read']
    assert workflow.membership_is_curated(job, 'resolved') and not workflow.membership_is_curated(job, 'native')
