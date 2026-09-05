from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sqlite3
import stat
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient


PLUGIN_API = Path(__file__).resolve().parents[1] / "hermes-plugin" / "dashboard" / "plugin_api.py"
BASE = "/api/plugins/agent-hub"
ORIGIN = "http://testserver"


@pytest.fixture(autouse=True)
def isolated_public_origin(monkeypatch):
    monkeypatch.delenv("HERMES_DASHBOARD_PUBLIC_URL", raising=False)


def test_https_proxy_origin_is_pinned(tmp_path, monkeypatch):
    client = make_client(tmp_path / "proxy")
    monkeypatch.setenv("HERMES_DASHBOARD_PUBLIC_URL", "https://hub.example.com")
    snapshot = {"chats": [], "messages": {}, "sessions": {}}
    payload = {"expectedRevision": 0, "snapshot": snapshot}
    headers = {"x-test-principal": "owner-a", "origin": "https://hub.example.com"}
    assert client.put(BASE + "/state", json=payload, headers=headers).status_code == 200
    readback = client.get(BASE + "/state", headers=auth_headers()).json()
    assert readback["snapshot"] == snapshot
    for origin in ["https://evil.example", "http://hub.example.com", "https://hub.example.com:444", ORIGIN]:
        rejected = dict(headers, origin=origin)
        rejected["x-forwarded-host"] = "hub.example.com"
        rejected["x-forwarded-proto"] = "https"
        assert client.put(BASE + "/state", json=payload, headers=rejected).status_code == 403


@dataclass(frozen=True)
class Session:
    provider: str
    org_id: str
    user_id: str


OWNER_A = Session("portal", "org-a", "user-a")
OWNER_B = Session("portal", "org-a", "user-b")


def owner_digest(session: Session) -> str:
    canonical = json.dumps(
        [session.provider, session.org_id, session.user_id],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def load_api(storage_root: Path):
    os.environ["AGENTHUB_STORAGE_ROOT"] = str(storage_root)
    module_name = f"agenthub_plugin_api_test_{id(storage_root)}_{len(sys.modules)}"
    spec = importlib.util.spec_from_file_location(module_name, PLUGIN_API)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def make_client(storage_root: Path, *, write_owner: bool = True) -> TestClient:
    storage_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if write_owner:
        (storage_root / "owners.json").write_text(
            json.dumps([owner_digest(OWNER_A)]), encoding="utf-8"
        )
    module = load_api(storage_root)
    app = FastAPI()

    @app.middleware("http")
    async def attach_test_session(request: Request, call_next):
        principal = request.headers.get("x-test-principal")
        if principal == "owner-a":
            request.state.session = OWNER_A
        elif principal == "owner-b":
            request.state.session = OWNER_B
        return await call_next(request)

    app.include_router(module.router, prefix=BASE)
    return TestClient(app)


def auth_headers(principal: str = "owner-a", *, write: bool = False) -> dict[str, str]:
    headers = {"x-test-principal": principal}
    if write:
        headers["origin"] = ORIGIN
    return headers


def empty_snapshot() -> dict:
    return {"chats": [], "messages": {}, "sessions": {}}


def put_audio(
    client: TestClient,
    audio_id: str = "audio-1",
    chat_id: str = "chat-1",
    body: bytes = b"\x1aE\xdf\xa3test-webm",
):
    return client.put(
        f"{BASE}/audio/{audio_id}",
        params={"chatId": chat_id},
        content=body,
        headers={
            **auth_headers(write=True),
            "content-type": "audio/webm",
        },
    )


def put_binding(
    client: TestClient,
    chat_id: str = "chat-1",
    session_id: str | None = "session-1",
    expected_session_id: str | None = None,
):
    return client.put(
        f"{BASE}/bindings/{chat_id}",
        json={"sessionId": session_id, "expectedSessionId": expected_session_id},
        headers=auth_headers(write=True),
    )


def claim_turn(
    client: TestClient,
    chat_id: str = "chat-1",
    client_message_id: str = "message-1",
    request_id: str = "request-1",
    prompt_digest: str = "a" * 64,
    *,
    headers: dict[str, str] | None = None,
):
    return client.post(
        f"{BASE}/turns/{chat_id}",
        json={
            "clientMessageId": client_message_id,
            "requestId": request_id,
            "promptDigest": prompt_digest,
        },
        headers=headers or auth_headers(write=True),
    )


def test_identity_requires_canonical_allowed_owner_and_fails_closed(tmp_path: Path):
    with make_client(tmp_path / "missing", write_owner=False) as missing_owner_client:
        assert missing_owner_client.get(BASE + "/identity").status_code == 401
        denied = missing_owner_client.get(
            BASE + "/identity", headers=auth_headers()
        )
        assert denied.status_code == 403

    with make_client(tmp_path / "configured") as client:
        missing = client.get(BASE + "/identity")
        assert missing.status_code == 401
        other = client.get(BASE + "/identity", headers=auth_headers("owner-b"))
        assert other.status_code == 403
        allowed = client.get(BASE + "/identity", headers=auth_headers())
        assert allowed.status_code == 200
        assert allowed.json() == {"scope": "personal"}
        assert "user-a" not in allowed.text


def test_identity_denies_everyone_when_two_owners_are_configured(tmp_path: Path):
    root = tmp_path / "two-owners"
    with make_client(root) as client:
        (root / "owners.json").write_text(
            json.dumps([owner_digest(OWNER_A), owner_digest(OWNER_B)]),
            encoding="utf-8",
        )

        owner_a = client.get(BASE + "/identity", headers=auth_headers("owner-a"))
        owner_b = client.get(BASE + "/identity", headers=auth_headers("owner-b"))

        assert owner_a.status_code == 403
        assert owner_a.json() == {"detail": "Forbidden"}
        assert owner_b.status_code == 403
        assert owner_b.json() == {"detail": "Forbidden"}


def test_state_round_trip_preserves_ui_fields_and_enforces_atomic_cas(tmp_path: Path):
    with make_client(tmp_path / "store") as client:
        initial = client.get(BASE + "/state", headers=auth_headers())
        assert initial.json() == {"revision": 0, "snapshot": empty_snapshot()}

        snapshot = {
            "chats": [
                {
                    "id": "chat-1",
                    "title": "Plan",
                    "desc": "Today",
                    "time": "Ahora",
                    "agent": "Hermes",
                    "agents": ["H"],
                    "model": "default",
                    "effort": "high",
                    "status": "Activo",
                    "error": "recoverable UI notice",
                }
            ],
            "messages": {
                "chat-1": [
                    {
                        "id": "message-1",
                        "role": "user",
                        "text": "hello",
                        "delivery": "complete",
                        "status": "complete",
                        "errors": ["prior transient error"],
                    }
                ]
            },
            "sessions": {"chat-1": "session-123"},
        }
        saved = client.put(
            BASE + "/state",
            json={"expectedRevision": 0, "snapshot": snapshot},
            headers=auth_headers(write=True),
        )
        assert saved.status_code == 200, saved.text
        assert saved.json() == {"revision": 1, "snapshot": snapshot}

        conflict = client.put(
            BASE + "/state",
            json={"expectedRevision": 0, "snapshot": empty_snapshot()},
            headers=auth_headers(write=True),
        )
        assert conflict.status_code == 409
        assert client.get(BASE + "/state", headers=auth_headers()).json() == {
            "revision": 1,
            "snapshot": snapshot,
        }


def test_state_accepts_exact_live_voice_message_and_rejects_other_sources(tmp_path: Path):
    with make_client(tmp_path / "store") as client:
        live_voice_message = {
            "id": "voice-turn-1",
            "role": "user",
            "source": "voice",
            "text": "mensaje transcrito",
            "duration": 1234,
        }
        snapshot = {
            "chats": [{"id": "chat-1"}],
            "messages": {"chat-1": [live_voice_message]},
            "sessions": {},
        }

        saved = client.put(
            BASE + "/state",
            json={"expectedRevision": 0, "snapshot": snapshot},
            headers=auth_headers(write=True),
        )
        assert saved.status_code == 200, saved.text
        assert saved.json() == {"revision": 1, "snapshot": snapshot}

        invalid = json.loads(json.dumps(snapshot))
        invalid["messages"]["chat-1"][0]["source"] = "browser"
        rejected = client.put(
            BASE + "/state",
            json={"expectedRevision": 1, "snapshot": invalid},
            headers=auth_headers(write=True),
        )
        assert rejected.status_code == 422
        assert rejected.json() == {"detail": "Invalid message source"}


def test_state_rejects_unknown_secret_fields_bad_relations_and_oversize(tmp_path: Path):
    with make_client(tmp_path / "store") as client:
        bad_snapshots = [
            {"chats": [], "messages": {}, "sessions": {}, "token": "secret"},
            {
                "chats": [{"id": "chat-1", "title": "x", "accessToken": "secret"}],
                "messages": {},
                "sessions": {},
            },
            {
                "chats": [],
                "messages": {"chat-missing": []},
                "sessions": {},
            },
            {
                "chats": [{"id": "../escape", "title": "x"}],
                "messages": {},
                "sessions": {},
            },
        ]
        for snapshot in bad_snapshots:
            response = client.put(
                BASE + "/state",
                json={"expectedRevision": 0, "snapshot": snapshot},
                headers=auth_headers(write=True),
            )
            assert response.status_code == 422, (snapshot, response.text)

        huge = json.dumps(
            {
                "expectedRevision": 0,
                "snapshot": {
                    "chats": [{"id": "chat-1", "title": "x" * (4 * 1024 * 1024)}],
                    "messages": {"chat-1": []},
                    "sessions": {},
                },
            }
        ).encode()
        response = client.put(
            BASE + "/state",
            content=huge,
            headers={
                **auth_headers(write=True),
                "content-type": "application/json",
            },
        )
        assert response.status_code == 413


def test_state_compare_and_swap_is_atomic_under_concurrency(tmp_path: Path):
    root = tmp_path / "store"
    client = make_client(root)
    app = client.app
    client.close()

    def update(title: str) -> int:
        chat_id = f"chat-{title}"
        candidate = {
            "chats": [{"id": chat_id, "title": title}],
            "messages": {chat_id: []},
            "sessions": {},
        }
        with TestClient(app) as concurrent_client:
            response = concurrent_client.put(
                BASE + "/state",
                headers=auth_headers(write=True),
                json={"expectedRevision": 0, "snapshot": candidate},
            )
            return response.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(update, ("one", "two")))

    assert sorted(statuses) == [200, 409]


def test_writes_require_same_origin_and_json_content_type(tmp_path: Path):
    with make_client(tmp_path / "store") as client:
        body = {"expectedRevision": 0, "snapshot": empty_snapshot()}
        no_origin = client.put(BASE + "/state", json=body, headers=auth_headers())
        assert no_origin.status_code == 403
        cross_origin = client.put(
            BASE + "/state",
            json=body,
            headers={**auth_headers(), "origin": "https://attacker.example"},
        )
        assert cross_origin.status_code == 403
        wrong_type = client.put(
            BASE + "/state",
            content=json.dumps(body),
            headers={**auth_headers(write=True), "content-type": "text/plain"},
        )
        assert wrong_type.status_code == 415


def test_audio_persists_restart_and_is_bound_to_chat(tmp_path: Path):
    root = tmp_path / "store"
    payload = b"\x1aE\xdf\xa3durable-audio"
    with make_client(root) as client:
        created = put_audio(client, body=payload)
        assert created.status_code == 200, created.text
        assert created.json() == {
            "id": "audio-1",
            "chatId": "chat-1",
            "contentType": "audio/webm",
            "size": len(payload),
        }
        wrong_chat = client.get(
            BASE + "/audio/audio-1",
            params={"chatId": "chat-2"},
            headers=auth_headers(),
        )
        assert wrong_chat.status_code in {403, 404}

    with make_client(root) as restarted:
        fetched = restarted.get(
            BASE + "/audio/audio-1",
            params={"chatId": "chat-1"},
            headers=auth_headers(),
        )
        assert fetched.status_code == 200
        assert fetched.content == payload
        assert fetched.headers["content-type"] == "audio/webm"
        assert "x-content-type-options" in fetched.headers

        cannot_rebind = put_audio(restarted, chat_id="chat-2", body=b"new")
        assert cannot_rebind.status_code == 409


def test_audio_quota_mime_ids_and_owner_are_enforced(tmp_path: Path):
    with make_client(tmp_path / "store") as client:
        bad_mime = client.put(
            BASE + "/audio/audio-1",
            params={"chatId": "chat-1"},
            content=b"not audio",
            headers={**auth_headers(write=True), "content-type": "application/octet-stream"},
        )
        assert bad_mime.status_code == 415
        unsafe = client.put(
            BASE + "/audio/..%2Fescape",
            params={"chatId": "chat-1"},
            content=b"x",
            headers={**auth_headers(write=True), "content-type": "audio/webm"},
        )
        assert unsafe.status_code in {404, 422}
        too_large = put_audio(client, body=b"x" * (6 * 1024 * 1024 + 1))
        assert too_large.status_code == 413
        denied = client.put(
            BASE + "/audio/audio-2",
            params={"chatId": "chat-1"},
            content=b"x",
            headers={
                **auth_headers("owner-b", write=True),
                "content-type": "audio/webm",
            },
        )
        assert denied.status_code == 403


def test_snapshot_audio_references_must_exist_and_match_chat(tmp_path: Path):
    with make_client(tmp_path / "store") as client:
        snapshot = {
            "chats": [
                {"id": "chat-1", "title": "one"},
                {"id": "chat-2", "title": "two"},
            ],
            "messages": {
                "chat-1": [
                    {
                        "id": "message-1",
                        "role": "audio",
                        "text": "",
                        "audioId": "audio-1",
                        "duration": 100,
                        "status": "complete",
                    }
                ],
                "chat-2": [],
            },
            "sessions": {},
        }
        missing = client.put(
            BASE + "/state",
            json={"expectedRevision": 0, "snapshot": snapshot},
            headers=auth_headers(write=True),
        )
        assert missing.status_code == 422
        assert put_audio(client).status_code == 200
        valid = client.put(
            BASE + "/state",
            json={"expectedRevision": 0, "snapshot": snapshot},
            headers=auth_headers(write=True),
        )
        assert valid.status_code == 200, valid.text

        moved = json.loads(json.dumps(snapshot))
        moved["messages"]["chat-2"] = moved["messages"].pop("chat-1")
        mismatch = client.put(
            BASE + "/state",
            json={"expectedRevision": 1, "snapshot": moved},
            headers=auth_headers(write=True),
        )
        assert mismatch.status_code == 422

        referenced_delete = client.delete(
            BASE + "/audio/audio-1",
            params={"chatId": "chat-1"},
            headers=auth_headers(write=True),
        )
        assert referenced_delete.status_code == 409


def test_bindings_have_cas_and_reject_path_like_ids(tmp_path: Path):
    with make_client(tmp_path / "store") as client:
        assert client.get(BASE + "/bindings", headers=auth_headers()).json() == {
            "bindings": {}
        }
        created = client.put(
            BASE + "/bindings/chat-1",
            json={"sessionId": "session-1", "expectedSessionId": None},
            headers=auth_headers(write=True),
        )
        assert created.status_code == 200, created.text
        assert created.json() == {"chatId": "chat-1", "sessionId": "session-1"}
        stale = client.put(
            BASE + "/bindings/chat-1",
            json={"sessionId": "session-2", "expectedSessionId": None},
            headers=auth_headers(write=True),
        )
        assert stale.status_code == 409
        updated = client.put(
            BASE + "/bindings/chat-1",
            json={"sessionId": "session-2", "expectedSessionId": "session-1"},
            headers=auth_headers(write=True),
        )
        assert updated.status_code == 200
        assert client.get(BASE + "/bindings", headers=auth_headers()).json() == {
            "bindings": {"chat-1": "session-2"}
        }
        path_like = client.put(
            BASE + "/bindings/chat-2",
            json={"sessionId": "../../sessions.db", "expectedSessionId": None},
            headers=auth_headers(write=True),
        )
        assert path_like.status_code == 422


def test_binding_null_deletes_only_matching_cas_and_pending_turn_blocks_it(tmp_path: Path):
    with make_client(tmp_path / "store") as client:
        assert put_binding(client).status_code == 200

        stale_delete = put_binding(
            client, session_id=None, expected_session_id="session-stale"
        )
        assert stale_delete.status_code == 409
        assert stale_delete.json() == {"detail": "Binding conflict"}
        assert client.get(BASE + "/bindings", headers=auth_headers()).json() == {
            "bindings": {"chat-1": "session-1"}
        }

        assert claim_turn(client).status_code == 200
        blocked_delete = put_binding(
            client, session_id=None, expected_session_id="session-1"
        )
        assert blocked_delete.status_code == 409
        assert blocked_delete.json() == {
            "detail": "Pending turn blocks binding change"
        }

        rejected = client.patch(
            f"{BASE}/turns/chat-1/message-1",
            json={"requestId": "request-1", "state": "rejected"},
            headers=auth_headers(write=True),
        )
        assert rejected.status_code == 200

        deleted = put_binding(
            client, session_id=None, expected_session_id="session-1"
        )
        assert deleted.status_code == 200, deleted.text
        assert deleted.json() == {"chatId": "chat-1", "sessionId": None}
        assert client.get(BASE + "/bindings", headers=auth_headers()).json() == {
            "bindings": {}
        }


def test_sqlite_is_wal_and_storage_permissions_are_private(tmp_path: Path):
    root = tmp_path / "store"
    with make_client(root) as client:
        response = client.put(
            BASE + "/state",
            json={"expectedRevision": 0, "snapshot": empty_snapshot()},
            headers=auth_headers(write=True),
        )
        assert response.status_code == 200

    db = root / "agenthub.sqlite3"
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE(db.stat().st_mode) == 0o600
    import sqlite3

    with sqlite3.connect(db) as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"


def test_turn_claim_persists_binding_and_digest_and_deduplicates(tmp_path: Path):
    root = tmp_path / "store"
    expected = {
        "chatId": "chat-1",
        "clientMessageId": "message-1",
        "requestId": "request-1",
        "state": "pending",
        "text": None,
    }
    with make_client(root) as client:
        assert claim_turn(client).status_code == 409
        assert put_binding(client).status_code == 200
        claimed = claim_turn(client)
        assert claimed.status_code == 200, claimed.text
        assert claimed.json() == {"turn": expected, "claimed": True}

        duplicate = claim_turn(client, request_id="different-request")
        assert duplicate.status_code == 200
        assert duplicate.json() == {"turn": expected, "claimed": False}
        digest_mismatch = claim_turn(client, prompt_digest="b" * 64)
        assert digest_mismatch.status_code == 409
        assert claim_turn(client, prompt_digest="A" * 64).status_code == 422

    with sqlite3.connect(root / "agenthub.sqlite3") as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            "SELECT chat_id, client_message_id, request_id, prompt_digest, "
            "session_id, state, text FROM turns"
        ).fetchall()
    assert [dict(row) for row in rows] == [{
        "chat_id": "chat-1", "client_message_id": "message-1",
        "request_id": "request-1", "prompt_digest": "a" * 64,
        "session_id": "session-1", "state": "pending", "text": None,
    }]

    with make_client(root) as restarted:
        fetched = restarted.get(
            f"{BASE}/turns/chat-1", params={"clientMessageId": "message-1"},
            headers=auth_headers(),
        )
        assert fetched.json() == {"turn": expected}


def test_pending_turn_blocks_another_turn_and_binding_change(tmp_path: Path):
    root = tmp_path / "store"
    with make_client(root) as client:
        assert put_binding(client).status_code == 200
        assert claim_turn(client).status_code == 200
        assert claim_turn(
            client, client_message_id="message-2", request_id="request-2",
            prompt_digest="b" * 64,
        ).status_code == 409
        assert put_binding(
            client, session_id="session-2", expected_session_id="session-1"
        ).status_code == 409
        assert client.get(BASE + "/bindings", headers=auth_headers()).json() == {
            "bindings": {"chat-1": "session-1"}
        }
    with sqlite3.connect(root / "agenthub.sqlite3") as connection:
        assert connection.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 1


def test_concurrent_devices_can_create_only_one_pending_turn(tmp_path: Path):
    root = tmp_path / "store"
    client = make_client(root)
    app = client.app
    with client:
        assert put_binding(client).status_code == 200

    def submit(number: int) -> int:
        with TestClient(app) as device:
            return claim_turn(
                device,
                client_message_id=f"message-{number}",
                request_id=f"request-{number}",
                prompt_digest=str(number) * 64,
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(submit, (1, 2)))
    assert sorted(statuses) == [200, 409]
    with sqlite3.connect(root / "agenthub.sqlite3") as connection:
        assert connection.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 1


def test_completed_turn_is_immutable_readable_and_repeat_claim_is_cached(tmp_path: Path):
    root = tmp_path / "store"
    completed = {
        "chatId": "chat-1", "clientMessageId": "message-1",
        "requestId": "request-1",
        "state": "completed", "text": "durable answer",
    }
    with make_client(root) as client:
        assert put_binding(client).status_code == 200
        assert claim_turn(client).status_code == 200
        payload = {"requestId": "request-1", "state": "completed", "text": "durable answer"}
        finish = client.patch(
            f"{BASE}/turns/chat-1/message-1", json=payload,
            headers=auth_headers(write=True),
        )
        assert finish.status_code == 200, finish.text
        assert finish.json() == {"turn": completed}
        assert client.patch(
            f"{BASE}/turns/chat-1/message-1", json=payload,
            headers=auth_headers(write=True),
        ).json() == {"turn": completed}
        changed = client.patch(
            f"{BASE}/turns/chat-1/message-1",
            json={**payload, "text": "changed"}, headers=auth_headers(write=True),
        )
        assert changed.status_code == 409
        replay = claim_turn(client, request_id="must-not-execute")
        assert replay.json() == {"turn": completed, "claimed": False}

        assert claim_turn(
            client, client_message_id="message-2", request_id="request-2",
            prompt_digest="b" * 64,
        ).status_code == 200
        latest = client.get(BASE + "/turns/chat-1", headers=auth_headers())
        assert latest.json()["turn"]["clientMessageId"] == "message-2"

    with make_client(root) as restarted:
        readback = restarted.get(
            BASE + "/turns/chat-1", params={"clientMessageId": "message-1"},
            headers=auth_headers(),
        )
        assert readback.json() == {"turn": completed}


def test_request_mismatch_and_binding_mismatch_cannot_clear_pending(tmp_path: Path):
    root = tmp_path / "store"
    with make_client(root) as client:
        assert put_binding(client).status_code == 200
        assert claim_turn(client).status_code == 200
        mismatch = client.patch(
            f"{BASE}/turns/chat-1/message-1",
            json={"requestId": "wrong-request", "state": "rejected"},
            headers=auth_headers(write=True),
        )
        assert mismatch.status_code == 409
        with sqlite3.connect(root / "agenthub.sqlite3") as connection:
            connection.execute(
                "UPDATE bindings SET session_id = 'tampered-session' WHERE chat_id = 'chat-1'"
            )
            connection.commit()
        wrong_binding = client.patch(
            f"{BASE}/turns/chat-1/message-1",
            json={"requestId": "request-1", "state": "rejected"},
            headers=auth_headers(write=True),
        )
        assert wrong_binding.status_code == 409
    with sqlite3.connect(root / "agenthub.sqlite3") as connection:
        assert connection.execute("SELECT state FROM turns").fetchone()[0] == "pending"


def test_turn_validation_authorization_csrf_and_rejection(tmp_path: Path):
    root = tmp_path / "store"
    with make_client(root) as client:
        assert client.get(BASE + "/turns/chat-1", headers=auth_headers()).json() == {"turn": None}
        assert put_binding(client).status_code == 200
        assert claim_turn(client, headers=auth_headers()).status_code == 403
        assert claim_turn(client, headers={
            **auth_headers(), "origin": "https://attacker.example"
        }).status_code == 403
        assert claim_turn(client, headers=auth_headers("owner-b", write=True)).status_code == 403
        wrong_type = client.post(
            BASE + "/turns/chat-1", content="{}",
            headers={**auth_headers(write=True), "content-type": "text/plain"},
        )
        assert wrong_type.status_code == 415

        assert claim_turn(client).status_code == 200
        invalid_completed = client.patch(
            f"{BASE}/turns/chat-1/message-1",
            json={"requestId": "request-1", "state": "completed", "text": ""},
            headers=auth_headers(write=True),
        )
        assert invalid_completed.status_code == 422
        rejected_with_text = client.patch(
            f"{BASE}/turns/chat-1/message-1",
            json={"requestId": "request-1", "state": "rejected", "text": "no"},
            headers=auth_headers(write=True),
        )
        assert rejected_with_text.status_code == 422
        rejected = client.patch(
            f"{BASE}/turns/chat-1/message-1",
            json={"requestId": "request-1", "state": "rejected"},
            headers=auth_headers(write=True),
        )
        assert rejected.status_code == 200
        assert rejected.json()["turn"]["text"] is None

        assert claim_turn(
            client, client_message_id="message-2", request_id="request-2",
            prompt_digest="b" * 64,
        ).status_code == 200
        oversized = client.patch(
            f"{BASE}/turns/chat-1/message-2",
            json={"requestId": "request-2", "state": "completed", "text": "x" * 100_001},
            headers=auth_headers(write=True),
        )
        assert oversized.status_code == 422
