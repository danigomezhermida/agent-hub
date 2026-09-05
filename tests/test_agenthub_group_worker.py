import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest

path=Path(__file__).resolve().parents[1]/'hermes-plugin/dashboard/group_worker.py'
spec=importlib.util.spec_from_file_location('group_worker_test',path)
worker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def test_worker_tools_hard_disabled_and_cleanup():
    captured={}
    class CLI:
        def __init__(self,**kw):
            assert kw['toolsets']==[]
            self.model='test'; self.api_key='test-placeholder'; self.base_url='https://provider.invalid'
            self.provider='test'; self.requested_provider='test'; self.api_mode='chat_completions'
            self.max_tokens=None; self.reasoning_config={}; self.system_prompt='Role'
        def _ensure_runtime_credentials(self): return True
    class Agent:
        def __init__(self,**kw):
            captured.update(kw); self.tools=[]; self.valid_tool_names=set(); self.api_mode='chat_completions'
        def run_conversation(self,**kw): return {'completed':True,'final_response':'Verified result'}
        def close(self): captured['closed']=True
    result=worker.run_turn('Request',CLI,Agent)
    assert result=={'ok':True,'text':'Verified result'}
    assert captured['enabled_toolsets']==[]
    assert captured['session_db'] is None
    assert captured['skip_memory'] and captured['skip_background_review'] and captured['skip_context_files']
    assert captured['max_iterations']==1 and captured['closed']


@pytest.mark.parametrize('mode',['codex_app_server','acp','unknown'])
def test_external_agent_runtime_rejected(mode):
    class CLI:
        def __init__(self,**kw): self.api_mode=mode
        def _ensure_runtime_credentials(self): return True
    def forbidden(**kw): raise AssertionError('Must not construct agent')
    with pytest.raises(RuntimeError,match='Unsupported'):
        worker.run_turn('Request',CLI,forbidden)


@pytest.mark.parametrize('change', [{'tools':[{}]}, {'valid_tool_names':{'terminal'}}])
def test_injected_tools_fail_before_inference(change):
    cli=SimpleNamespace(api_mode='chat_completions',model='test',api_key='test-placeholder',base_url='https://provider.invalid',provider='test',requested_provider='test',max_tokens=None,reasoning_config={},system_prompt='',_ensure_runtime_credentials=lambda:True)
    closed=[]
    class Agent:
        def __init__(self,**kw):
            self.api_mode='chat_completions';self.tools=[];self.valid_tool_names=set();self.__dict__.update(change)
        def run_conversation(self,**kw): raise AssertionError('No inference allowed')
        def close(self): closed.append(True)
    with pytest.raises(RuntimeError,match='Unsafe'):
        worker.run_turn('Request',lambda **kw:cli,Agent)
    assert closed==[True]


@pytest.mark.parametrize('result', [
    {'completed':False,'final_response':'Partial'}, {'completed':True,'partial':True,'final_response':'Partial'},
    {'completed':True,'error':'private','final_response':'Error'}, {'completed':True,'final_response':''},
    {'completed':True,'interrupted':True,'final_response':'Partial'},
])
def test_unconfirmed_results_rejected(result):
    cli=SimpleNamespace(api_mode='chat_completions',model='test',api_key='test-placeholder',base_url='https://provider.invalid',provider='test',requested_provider='test',max_tokens=None,reasoning_config={},system_prompt='',_ensure_runtime_credentials=lambda:True)
    class Agent:
        def __init__(self,**kw): self.api_mode='chat_completions';self.tools=[];self.valid_tool_names=set()
        def run_conversation(self,**kw): return result
        def close(self): pass
    with pytest.raises(RuntimeError,match='No confirmed'):
        worker.run_turn('Request',lambda **kw:cli,Agent)
