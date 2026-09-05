"""Real endpoint/SQLite tests; provider substitute is confined to tests."""
import asyncio
import sys
import pytest
from test_agenthub_storage import make_client, auth_headers, BASE, isolated_public_origin
from test_agenthub_groups import group


def api_for(client):
    return client.app.state.agenthub_api


def test_run_security_and_unavailable_profile(tmp_path, monkeypatch):
    with make_client(tmp_path / 'security') as client:
        api=api_for(client)
        client.put(BASE+'/groups',json={'expectedRevision':0,'groups':[group()]},headers=auth_headers(write=True))
        body={'runId':'secure','message':'Propuesta','expectedRevision':1}
        path=BASE+'/groups/development/runs'
        assert client.post(path,json=body).status_code==401
        assert client.post(path,json=body,headers=auth_headers('owner-b',write=True)).status_code==403
        assert client.post(path,json=body,headers=auth_headers()).status_code==403
        assert client.post(path,json=body,headers=dict(auth_headers(write=True),origin='https://evil.example')).status_code==403
        monkeypatch.setattr(api,'_group_profile_available',lambda p:False)
        assert client.post(path,json=body,headers=auth_headers(write=True)).status_code==409
        assert client.get(BASE+'/group-runs/secure',headers=auth_headers()).status_code==404
        assert client.get(BASE+'/group-catalog',headers=auth_headers('owner-b')).status_code==403
        assert all(not p['available'] for p in client.get(BASE+'/group-catalog',headers=auth_headers()).json()['specialists'])


@pytest.mark.parametrize('patch', [
    {'expectedRevision':True}, {'expectedRevision':-1}, {'message':''},
    {'message':'x'*12001}, {'runId':'../escape'}, {'tools':['terminal']},
    {'director':'limpatexqa'}, {'message':[]},
])
def test_invalid_runs_fail_closed(tmp_path,patch):
    with make_client(tmp_path/'invalid') as client:
        body=dict({'runId':'invalid','message':'Propuesta','expectedRevision':1},**patch)
        assert client.post(BASE+'/groups/development/runs',json=body,headers=auth_headers(write=True)).status_code==422


def test_active_guard_and_restart_uncertainty(tmp_path, monkeypatch):
    root=tmp_path/'restart'
    with make_client(root) as client:
        api=api_for(client)
        calls=[]
        async def blocked(profile,prompt):
            calls.append(profile)
            await asyncio.sleep(3600)
        monkeypatch.setattr(api,'_invoke_group_profile',blocked)
        monkeypatch.setattr(api,'_group_profile_available',lambda p:True)
        client.put(BASE+'/groups',json={'expectedRevision':0,'groups':[group()]},headers=auth_headers(write=True))
        body={'runId':'once','message':'Propuesta','expectedRevision':1}
        path=BASE+'/groups/development/runs'
        assert client.post(path,json=body,headers=auth_headers(write=True)).status_code==200
        assert client.post(path,json=body,headers=auth_headers(write=True)).status_code==200
        assert client.post(path,json=dict(body,runId='another'),headers=auth_headers(write=True)).status_code==409
        assert client.get(BASE+'/group-runs/once',headers=auth_headers('owner-b')).status_code==403
        assert len(calls)==1
        async def cancel():
            tasks=list(api._GROUP_TASKS)
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
        client.portal.call(cancel)
        with api._connection() as db:
            db.execute("UPDATE group_runs SET state='running',boot_id='old_process' WHERE run_id='once'")
    with make_client(root,write_owner=False) as reopened:
        run=reopened.get(BASE+'/group-runs/once',headers=auth_headers()).json()
        assert run['state']=='uncertain' and run['text']==''
        assert reopened.post(path,json=body,headers=auth_headers(write=True)).json()==run
        assert len(calls)==1


def test_provider_failure_is_not_a_final_answer(tmp_path,monkeypatch):
    with make_client(tmp_path/'failure') as client:
        api=api_for(client)
        async def fail(profile,prompt): raise RuntimeError('PRIVATE_PROVIDER_DIAGNOSTIC')
        monkeypatch.setattr(api,'_invoke_group_profile',fail)
        monkeypatch.setattr(api,'_group_profile_available',lambda p:True)
        client.put(BASE+'/groups',json={'expectedRevision':0,'groups':[group()]},headers=auth_headers(write=True))
        client.post(BASE+'/groups/development/runs',json={'runId':'failure','message':'Propuesta','expectedRevision':1},headers=auth_headers(write=True))
        client.portal.call(lambda:asyncio.gather(*list(api._GROUP_TASKS)))
        response=client.get(BASE+'/group-runs/failure',headers=auth_headers())
        run=response.json()
        assert run['state']=='failed' and run['text']==''
        assert 'PRIVATE_PROVIDER_DIAGNOSTIC' not in response.text
        assert run['steps'][0]['status']=='failed'


def test_worker_environment_does_not_inherit_secrets(tmp_path, monkeypatch):
    with make_client(tmp_path/'env') as client:
        api=api_for(client)
        monkeypatch.setenv('AGENTHUB_AUDIT_UNRELATED_SECRET','sentinel-not-for-worker')
        monkeypatch.setenv('OPENAI_API_KEY','other-profile-placeholder')
        monkeypatch.setenv('HERMES_DASHBOARD_OAUTH_CLIENT_SECRET','dashboard-placeholder')
        env=api._group_worker_env('limpatexqa')
        assert not any(name in env for name in ['AGENTHUB_AUDIT_UNRELATED_SECRET','OPENAI_API_KEY','HERMES_DASHBOARD_OAUTH_CLIENT_SECRET'])
        assert env['HERMES_HOME'].endswith('/profiles/limpatexqa')
        assert set(env) == {'HOME','PATH','LANG','HERMES_HOME','PYTHONPATH'}


def test_real_group_orchestration_contract(tmp_path, monkeypatch):
    with make_client(tmp_path / 'runs') as client:
        api = api_for(client)
        calls = []
        async def provider(profile, prompt):
            calls.append((profile, prompt))
            return 'Aportación ' + profile
        monkeypatch.setattr(api, '_invoke_group_profile', provider, raising=False)
        monkeypatch.setattr(api, '_group_profile_available', lambda profile: True, raising=False)
        saved = client.put(BASE + '/groups', json={'expectedRevision':0,'groups':[group()]}, headers=auth_headers(write=True))
        assert saved.status_code == 200
        payload={'runId':'run_contract', 'message':'Revisa esta propuesta de desarrollo.', 'expectedRevision':1}
        response=client.post(BASE + '/groups/development/runs',json=payload,headers=auth_headers(write=True))
        assert response.status_code == 200
        # Explicitly wait on the application task, never re-submit.
        client.portal.call(lambda: asyncio.gather(*list(api._GROUP_TASKS)))
        run=client.get(BASE + '/group-runs/run_contract',headers=auth_headers()).json()
        assert run['state'] == 'completed'
        assert run['text'] == 'Aportación limpatexdev-cloud'
        assert [c[0] for c in calls] == ['limpatexdev-cloud','limpatexdevsenior','limpatexqa','limpatexdev-cloud']
        assert 'Aportación limpatexqa' in calls[-1][1]
        assert client.post(BASE+'/groups/development/runs',json=payload,headers=auth_headers(write=True)).json() == run
        assert len(calls)==4
        assert client.get(BASE+'/group-runs?groupId=development',headers=auth_headers()).json()=={'runs':[run]}
        assert client.get(BASE+'/group-runs?groupId=development',headers=auth_headers('owner-b')).status_code==403
        assert client.get(BASE+'/group-runs?groupId=unknown',headers=auth_headers()).json()=={'runs':[]}
        changed=dict(payload,message='Otra petición')
        assert client.post(BASE+'/groups/development/runs',json=changed,headers=auth_headers(write=True)).status_code==409
