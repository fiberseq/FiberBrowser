from pathlib import Path
from types import SimpleNamespace
import sys
import pytest
from services import fiberhmm_runtime as runtime


def test_inference_refuses_an_already_loaded_shadow_package(tmp_path,monkeypatch):
    expected=tmp_path/'expected';wrong=tmp_path/'old'/'fiberhmm'/'__init__.py'
    monkeypatch.setattr(runtime,'bundled_fiberhmm_root',lambda:expected)
    monkeypatch.setattr(runtime,'_CONFIGURED_ROOT',str(expected))
    monkeypatch.setitem(sys.modules,'fiberhmm',SimpleNamespace(__file__=str(wrong)))
    # Basic browsing need not become unavailable; inference may not run stale.
    assert runtime.configure_fiberhmm_runtime() is None
    with pytest.raises(ValueError,match='runtime mismatch.*expected source'):
        runtime.configure_fiberhmm_runtime(strict=True)
    assert sys.modules['fiberhmm'].__file__==str(wrong)


def test_resolver_reasserts_priority_before_import_even_after_configuration(tmp_path,monkeypatch):
    expected=tmp_path/'expected';shadow=tmp_path/'shadow'
    monkeypatch.setattr(runtime,'bundled_fiberhmm_root',lambda:expected)
    monkeypatch.setattr(runtime,'_CONFIGURED_ROOT',str(expected))
    monkeypatch.delitem(sys.modules,'fiberhmm',raising=False)
    monkeypatch.setattr(sys,'path',[str(shadow),str(expected),*sys.path])
    assert runtime.configure_fiberhmm_runtime(strict=True)==str(expected)
    assert sys.path[0]==str(expected)
    assert sum(Path(p or '.').resolve()==expected for p in sys.path)==1


def test_schema_names_actual_loaded_caller_and_current_numerical_budget():
    from services.consensus_workflow import schema
    value=schema()
    assert value['runtime']['workflow_path'].endswith('fiberhmm/inference/consensus/workflow.py')
    assert Path(value['runtime']['workflow_path']).is_file()
    option=next(v for v in value['groups']['cr'] if v['name']=='global_iterations')
    assert option['default']==800


def test_old_consensus_api_is_rejected_with_install_prompt():
    from services.consensus_workflow import _validate_consensus_runtime
    old=SimpleNamespace(parameter_schema=lambda: {'cr': [{'name':'engine','choices':['call_harmonization']}]})
    with pytest.raises(ValueError, match='Install a compatible FiberHMM'):
        _validate_consensus_runtime(SimpleNamespace(run_workflow=lambda:None), old)


def test_install_prompt_targets_browser_python_and_consensus_extra():
    from services.consensus_workflow import _consensus_install_help
    message=_consensus_install_help('/source/FiberHMM')
    assert sys.executable in message
    assert '/source/FiberHMM[consensus]' in message
    assert 'restart' in message
    assert 'no alternate engine is substituted' in message


def test_install_prompt_names_the_fiberhmm_3_requirement():
    from services.consensus_workflow import _consensus_install_help
    message=_consensus_install_help()
    assert 'fiberhmm[consensus]>=3.0,<4' in message
    assert '/path/to/FiberHMM' not in message


def test_no_sibling_folder_is_searched_without_fiberhmm_source_dir(tmp_path,monkeypatch):
    # Only FIBERHMM_SOURCE_DIR names a source tree; the old Dropbox-layout
    # probe (parents[4]/"Release v2.0.0") is gone.
    monkeypatch.delenv('FIBERHMM_SOURCE_DIR',raising=False)
    assert runtime.bundled_fiberhmm_root() is None
    source=tmp_path/'FiberHMM'
    (source/'fiberhmm'/'inference').mkdir(parents=True)
    (source/'fiberhmm'/'inference'/'strand_rescue.py').write_text('')
    monkeypatch.setenv('FIBERHMM_SOURCE_DIR',str(source))
    assert runtime.bundled_fiberhmm_root()==source.resolve()
    monkeypatch.setenv('FIBERHMM_SOURCE_DIR',str(tmp_path/'missing'))
    assert runtime.bundled_fiberhmm_root() is None


def test_startup_log_warns_about_fiberhmm_older_than_3(monkeypatch):
    monkeypatch.setattr(runtime,'fiberhmm_selection',lambda:{'notices':[]})
    monkeypatch.setattr(runtime,'describe_fiberhmm',lambda:{'available':True,'version':'2.16.8',
        'path':'/site-packages/fiberhmm','compatible':False,'error':None})
    lines=[]
    runtime.log_fiberhmm_runtime(lines.append)
    assert 'WARNING' in lines[0] and '2.16.8' in lines[0] and 'fiberhmm[consensus]>=3.0,<4' in lines[0]
    monkeypatch.setattr(runtime,'describe_fiberhmm',lambda:{'available':True,'version':'3.0.0',
        'path':'/site-packages/fiberhmm','compatible':True,'error':None})
    lines.clear()
    runtime.log_fiberhmm_runtime(lines.append)
    assert lines==['  FiberHMM: 3.0.0 (/site-packages/fiberhmm)']


def test_describe_fiberhmm_reports_the_imported_package():
    info=runtime.describe_fiberhmm()
    import fiberhmm
    assert info['available'] and info['version']==fiberhmm.__version__
    assert info['compatible']==(int(fiberhmm.__version__.split('.')[0])>=3)


def test_startup_log_prints_the_selection_notices(monkeypatch):
    monkeypatch.setattr(runtime,'describe_fiberhmm',lambda:{'available':True,'version':'3.0.0',
        'path':'/app/fiberhmm','compatible':True,'error':None})
    note='Custom FiberHMM at /x lacks the NFR engine; using the bundled FiberHMM 3.0.0.'
    monkeypatch.setattr(runtime,'fiberhmm_selection',lambda:{'notices':[note]})
    lines=[]
    info=runtime.log_fiberhmm_runtime(lines.append)
    assert lines==['  FiberHMM: 3.0.0 (/app/fiberhmm)','  NOTE: '+note]
    assert info['selection']['notices']==[note]
