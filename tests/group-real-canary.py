"""Opt-in real model canary, TEMP SQLite and TestClient identity fixture.
Not production authentication and not browser E2E. No provider substitutes.
"""
import asyncio
import json
import tempfile
from pathlib import Path
from test_agenthub_storage import make_client, auth_headers, BASE
from test_agenthub_groups import group

with tempfile.TemporaryDirectory(prefix='agenthub-real-groups-') as directory:
    with make_client(Path(directory)) as client:
        api=client.app.state.agenthub_api
        saved=client.put(BASE+'/groups',json={'expectedRevision':0,'groups':[group()]},headers=auth_headers(write=True))
        assert saved.status_code==200
        body={'runId':'real_pipeline','message':'Propón en tres puntos cómo comprobar un formulario interno antes de publicarlo. No consultes datos externos ni afirmes haber ejecutado pruebas. Incluye GRUPOS_REALES_OK en la respuesta final.', 'expectedRevision':1}
        start=client.post(BASE+'/groups/development/runs',json=body,headers=auth_headers(write=True))
        assert start.status_code==200, start.status_code
        client.portal.call(lambda:asyncio.gather(*list(api._GROUP_TASKS)))
        run=client.get(BASE+'/group-runs/real_pipeline',headers=auth_headers()).json()
        print(json.dumps({'state':run['state'],'steps':run['steps'],'has_real_final':bool(run['text']),'marker':'GRUPOS_REALES_OK' in run['text'],'error':run['error']},ensure_ascii=False))
        assert run['state']=='completed' and len(run['steps'])==4 and 'GRUPOS_REALES_OK' in run['text']
        print('REAL_PROVIDER_GROUP_PIPELINE_PASS; TestClient identity and temporary SQLite, NOT production authentication')
