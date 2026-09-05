"""Personal group configuration: real SQLite/TestClient; no agent execution."""
import pytest
from test_agenthub_storage import make_client, auth_headers, BASE, isolated_public_origin


@pytest.mark.parametrize("change", [
    {"director": ""}, {"director": "limpatexqa"}, {"members": []},
    {"members": ["unknown"]}, {"members": ["limpatexqa", "limpatexqa"]},
    {"members": ["limpatexdev-cloud"]}, {"members": "limpatexqa"},
    {"name": " "}, {"name": "x" * 121}, {"objective": ""},
    {"id": "../../outside"}, {"execute": True},
])
def test_invalid_group_is_rejected_without_write(tmp_path, change):
    client = make_client(tmp_path / "invalid")
    candidate = dict(group(), **change)
    response = client.put(BASE + "/groups", json={"expectedRevision": 0, "groups": [candidate]}, headers=auth_headers(write=True))
    assert response.status_code == 422
    assert client.get(BASE + "/groups", headers=auth_headers()).json() == {"revision": 0, "groups": []}



def group():
    return {"id": "development", "name": "Desarrollo y QA", "director": "limpatexdev-cloud", "members": ["limpatexdevsenior", "limpatexqa"], "objective": "Implementar y revisar cambios solicitados por Dani."}


def test_groups_authorization_and_origin(tmp_path):
    client = make_client(tmp_path / "auth")
    payload = {"expectedRevision": 0, "groups": [group()]}
    for headers, status in [({}, 401), (auth_headers("owner-b", write=True), 403)]:
        assert client.get(BASE + "/groups", headers=headers).status_code == status
        assert client.put(BASE + "/groups", json=payload, headers=headers).status_code == status
    assert client.put(BASE + "/groups", json=payload, headers=auth_headers()).status_code == 403
    headers = dict(auth_headers(write=True), origin="https://evil.example")
    assert client.put(BASE + "/groups", json=payload, headers=headers).status_code == 403
    assert client.get(BASE + "/groups", headers=auth_headers()).json()["revision"] == 0


def test_concurrent_group_updates_do_not_overwrite(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    client = make_client(tmp_path / "cas")
    def write(name):
        return client.put(BASE + "/groups", json={"expectedRevision": 0, "groups": [dict(group(), name=name)]}, headers=auth_headers(write=True))
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, ["Primera", "Segunda"]))
    assert sorted(r.status_code for r in results) == [200, 409]
    winner = next(r.json() for r in results if r.status_code == 200)
    assert client.get(BASE + "/groups", headers=auth_headers()).json() == winner


@pytest.mark.parametrize("groups", [None, {}, [None], [group(), group()], [group()] * 101])
def test_invalid_group_collection(tmp_path, groups):
    client = make_client(tmp_path / "collection")
    assert client.put(BASE + "/groups", json={"expectedRevision": 0, "groups": groups}, headers=auth_headers(write=True)).status_code == 422


def test_groups_roundtrip_and_restart_preserves_chat_snapshot(tmp_path):
    root = tmp_path / "groups"
    client = make_client(root)
    before = client.get(BASE + "/state", headers=auth_headers()).json()
    response = client.put(BASE + "/groups", json={"expectedRevision": 0, "groups": [group()]}, headers=auth_headers(write=True))
    assert response.status_code == 200
    assert response.json() == {"revision": 1, "groups": [group()]}
    reopened = make_client(root, write_owner=False)
    assert reopened.get(BASE + "/groups", headers=auth_headers()).json() == response.json()
    assert reopened.get(BASE + "/state", headers=auth_headers()).json() == before
