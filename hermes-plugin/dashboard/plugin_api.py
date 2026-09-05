"""Personal, authenticated durable storage for the Agent Hub dashboard.

Hermes mounts ``router`` below ``/api/plugins/agent-hub``.  This module stores
only validated UI state, audio bytes, opaque chat/session bindings, and a turn
ledger; it does not expose paths and cannot execute an agent.

Turn ledger contract (all records are personal-owner scoped):
``GET /turns/{chatId}?clientMessageId=...`` returns ``{"turn": record|null}``;
``POST /turns/{chatId}`` requires ``clientMessageId``, ``requestId``, and a
lowercase SHA-256 ``promptDigest`` and returns ``turn`` plus ``claimed``;
``PATCH /turns/{chatId}/{clientMessageId}`` completes or rejects the exact
claim.  Public records contain chatId, clientMessageId, requestId, state, and
text; the digest and captured session binding remain server-side.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response


router = APIRouter()

_STATE_LIMIT = 4 * 1024 * 1024
_AUDIO_LIMIT = 6 * 1024 * 1024
_TURN_BODY_LIMIT = 512 * 1024
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_OWNER_HASH = re.compile(r"^[0-9a-f]{64}$")
_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
_AUDIO_TYPES = frozenset(
    {
        "audio/webm",
        "audio/ogg",
        "audio/mpeg",
        "audio/mp4",
        "audio/wav",
        "audio/x-wav",
    }
)
_EMPTY_SNAPSHOT: dict[str, Any] = {"chats": [], "messages": {}, "sessions": {}}
_CHAT_FIELDS = frozenset(
    {
        "id",
        "title",
        "desc",
        "time",
        "agent",
        "agents",
        "model",
        "effort",
        "status",
        "error",
        "createdAt",
        "updatedAt",
        "lastMessage",
        "lastMessageAt",
        "avatar",
        "color",
        "pinned",
        "archived",
        "unread",
        "sortOrder",
    }
)
_CHAT_STRING_FIELDS = _CHAT_FIELDS - {
    "id",
    "agents",
    "pinned",
    "archived",
    "unread",
    "sortOrder",
}
_MESSAGE_FIELDS = frozenset(
    {
        "id",
        "role",
        "text",
        "audioId",
        "duration",
        "delivery",
        "status",
        "error",
        "errors",
        "createdAt",
        "timestamp",
        "time",
        "source",
    }
)
_MESSAGE_STRING_FIELDS = _MESSAGE_FIELDS - {"id", "duration", "errors"}
_ROLES = frozenset({"user", "assistant", "agent", "audio", "system"})
_STORAGE_ROOT = Path(
    os.environ.get("AGENTHUB_STORAGE_ROOT")
    or Path(__file__).resolve().parents[3] / "agenthub-data"
)
_OWNERS_FILE = Path(os.environ.get("AGENTHUB_OWNERS_FILE") or _STORAGE_ROOT / "owners.json")
_DB_SETUP_LOCK = threading.Lock()
_DB_INITIALIZED = False


def _storage_root() -> Path:
    return _STORAGE_ROOT


def _owners_path() -> Path:
    return _OWNERS_FILE


def _private_json(content: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        content=content,
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )


def _session_value(session: Any, name: str) -> Any:
    # The dashboard gate attaches a canonical Session object.  Deliberately do
    # not derive identity from caller-controlled headers, query strings, or
    # request JSON.
    return getattr(session, name, None)


def _principal(request: Request) -> str:
    session = getattr(request.state, "session", None)
    if session is None:
        raise HTTPException(status_code=401, detail="Unauthorized")
    provider = _session_value(session, "provider")
    org_id = _session_value(session, "org_id")
    user_id = _session_value(session, "user_id")
    if (
        not isinstance(provider, str)
        or not provider
        or not isinstance(org_id, str)
        or not isinstance(user_id, str)
        or not user_id
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")
    canonical = json.dumps(
        [provider, org_id, user_id], ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()
    allowed = _load_owner_hashes()
    if not any(hmac.compare_digest(digest, candidate) for candidate in allowed):
        raise HTTPException(status_code=403, detail="Forbidden")
    return digest


def _load_owner_hashes() -> tuple[str, ...]:
    try:
        with _owners_path().open("rb") as handle:
            raw = handle.read(65537)
        if len(raw) > 65536:
            return ()
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return ()
    if not isinstance(value, list) or not value:
        return ()
    hashes: list[str] = []
    for item in value:
        if not isinstance(item, str) or _OWNER_HASH.fullmatch(item) is None:
            return ()
        hashes.append(item)
    unique_hashes = tuple(dict.fromkeys(hashes))
    return unique_hashes if len(unique_hashes) == 1 else ()


def _same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        raise HTTPException(status_code=403, detail="Same-origin request required")
    parsed = urlsplit(origin)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise HTTPException(status_code=403, detail="Same-origin request required")

    def effective_port(scheme: str, port: int | None) -> int | None:
        return port if port is not None else {"http": 80, "https": 443}.get(scheme)

    # The platform terminates HTTPS upstream. Trust only its configured public
    # URL, never client-supplied Forwarded/X-Forwarded-* headers.
    public_url = os.environ.get("HERMES_DASHBOARD_PUBLIC_URL", "")
    expected = urlsplit(public_url) if public_url else request.url
    try:
        matches = (
            expected.scheme in {"http", "https"}
            and parsed.scheme == expected.scheme
            and parsed.hostname.lower() == (expected.hostname or "").lower()
            and effective_port(parsed.scheme, parsed.port)
            == effective_port(expected.scheme, expected.port)
        )
    except ValueError:
        matches = False
    if not matches:
        raise HTTPException(status_code=403, detail="Same-origin request required")


def _require_json(request: Request) -> None:
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise HTTPException(status_code=415, detail="Content-Type must be application/json")


async def _bounded_body(request: Request, limit: int) -> bytes:
    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) < 0:
                raise ValueError
            if int(length) > limit:
                raise HTTPException(status_code=413, detail="Request body too large")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length") from None
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(status_code=413, detail="Request body too large")
        body.extend(chunk)
    return bytes(body)


def _reject_json_constant(_value: str) -> None:
    raise ValueError


async def _json_body(request: Request, limit: int = _STATE_LIMIT) -> Any:
    _require_json(request)
    raw = await _bounded_body(request, limit)
    try:
        return json.loads(
            raw,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid JSON") from None


def _safe_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or _SAFE_ID.fullmatch(value) is None or ".." in value:
        raise HTTPException(status_code=422, detail=f"Invalid {label}")
    return value


def _plain_string(value: Any, label: str, maximum: int = 100_000) -> str:
    if not isinstance(value, str) or len(value) > maximum:
        raise HTTPException(status_code=422, detail=f"Invalid {label}")
    return value


def _exact_object(value: Any, required: set[str], allowed: frozenset[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail=f"{label} must be an object")
    keys = set(value)
    if not required.issubset(keys) or not keys.issubset(allowed):
        raise HTTPException(status_code=422, detail=f"Invalid {label} fields")
    return value


def _validate_snapshot(value: Any) -> tuple[dict[str, Any], list[tuple[str, str]]]:
    snapshot = _exact_object(
        value, {"chats", "messages", "sessions"}, frozenset({"chats", "messages", "sessions"}), "snapshot"
    )
    chats = snapshot["chats"]
    messages = snapshot["messages"]
    sessions = snapshot["sessions"]
    if not isinstance(chats, list) or len(chats) > 5000:
        raise HTTPException(status_code=422, detail="Invalid chats")
    if not isinstance(messages, dict) or len(messages) > 5000:
        raise HTTPException(status_code=422, detail="Invalid messages")
    if not isinstance(sessions, dict) or len(sessions) > 5000:
        raise HTTPException(status_code=422, detail="Invalid sessions")

    chat_ids: set[str] = set()
    for index, raw_chat in enumerate(chats):
        chat = _exact_object(raw_chat, {"id"}, _CHAT_FIELDS, f"chat {index}")
        chat_id = _safe_id(chat["id"], "chat id")
        if chat_id in chat_ids:
            raise HTTPException(status_code=422, detail="Duplicate chat id")
        chat_ids.add(chat_id)
        for field in _CHAT_STRING_FIELDS:
            if field in chat:
                _plain_string(chat[field], f"chat {field}")
        if "agents" in chat:
            if (
                not isinstance(chat["agents"], list)
                or len(chat["agents"]) > 64
                or any(not isinstance(agent, str) or len(agent) > 256 for agent in chat["agents"])
            ):
                raise HTTPException(status_code=422, detail="Invalid chat agents")
        for field in ("pinned", "archived"):
            if field in chat and not isinstance(chat[field], bool):
                raise HTTPException(status_code=422, detail=f"Invalid chat {field}")
        if "unread" in chat and (
            not isinstance(chat["unread"], int) or isinstance(chat["unread"], bool) or chat["unread"] < 0
        ):
            raise HTTPException(status_code=422, detail="Invalid chat unread")
        if "sortOrder" in chat and (
            not isinstance(chat["sortOrder"], (int, float)) or isinstance(chat["sortOrder"], bool)
            or not math.isfinite(chat["sortOrder"])
        ):
            raise HTTPException(status_code=422, detail="Invalid chat sortOrder")

    audio_refs: list[tuple[str, str]] = []
    total_messages = 0
    for raw_chat_id, raw_entries in messages.items():
        chat_id = _safe_id(raw_chat_id, "message chat id")
        if chat_id not in chat_ids or not isinstance(raw_entries, list):
            raise HTTPException(status_code=422, detail="Messages must belong to a chat")
        total_messages += len(raw_entries)
        if total_messages > 50_000:
            raise HTTPException(status_code=422, detail="Too many messages")
        message_ids: set[str] = set()
        for index, raw_message in enumerate(raw_entries):
            message = _exact_object(
                raw_message, {"id", "role"}, _MESSAGE_FIELDS, f"message {index}"
            )
            message_id = _safe_id(message["id"], "message id")
            if message_id in message_ids:
                raise HTTPException(status_code=422, detail="Duplicate message id")
            message_ids.add(message_id)
            if message["role"] not in _ROLES:
                raise HTTPException(status_code=422, detail="Invalid message role")
            for field in _MESSAGE_STRING_FIELDS:
                if field in message:
                    _plain_string(message[field], f"message {field}")
            if "source" in message and message["source"] != "voice":
                raise HTTPException(status_code=422, detail="Invalid message source")
            if "duration" in message and (
                not isinstance(message["duration"], (int, float))
                or isinstance(message["duration"], bool)
                or not math.isfinite(message["duration"])
                or message["duration"] < 0
                or message["duration"] > 86_400_000
            ):
                raise HTTPException(status_code=422, detail="Invalid message duration")
            if "errors" in message and (
                not isinstance(message["errors"], list)
                or len(message["errors"]) > 100
                or any(not isinstance(error, str) or len(error) > 10_000 for error in message["errors"])
            ):
                raise HTTPException(status_code=422, detail="Invalid message errors")
            if "audioId" in message:
                audio_refs.append((_safe_id(message["audioId"], "audio id"), chat_id))

    for raw_chat_id, raw_session_id in sessions.items():
        chat_id = _safe_id(raw_chat_id, "session chat id")
        if chat_id not in chat_ids:
            raise HTTPException(status_code=422, detail="Sessions must belong to a chat")
        _safe_id(raw_session_id, "session id")
    return snapshot, audio_refs


def _prepare_storage() -> tuple[Path, Path]:
    root = _storage_root()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    db_path = root / "agenthub.sqlite3"
    descriptor = os.open(db_path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(descriptor)
    os.chmod(db_path, 0o600)
    return root, db_path


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    global _DB_INITIALIZED
    _, db_path = _prepare_storage()
    connection = sqlite3.connect(db_path, timeout=10.0, isolation_level=None)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        with _DB_SETUP_LOCK:
            if not _DB_INITIALIZED:
                deadline = time.monotonic() + 10.0
                while True:
                    try:
                        mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
                        if mode != "wal":
                            raise RuntimeError("WAL mode unavailable")
                        connection.executescript(
                            """
                            CREATE TABLE IF NOT EXISTS state (
                                owner_hash TEXT PRIMARY KEY,
                                revision INTEGER NOT NULL CHECK (revision >= 0),
                                snapshot_json TEXT NOT NULL
                            );
                            CREATE TABLE IF NOT EXISTS audio (
                                owner_hash TEXT NOT NULL,
                                audio_id TEXT NOT NULL,
                                chat_id TEXT NOT NULL,
                                content_type TEXT NOT NULL,
                                size INTEGER NOT NULL CHECK (size >= 0),
                                body BLOB NOT NULL,
                                PRIMARY KEY (owner_hash, audio_id)
                            );
                            CREATE TABLE IF NOT EXISTS bindings (
                                owner_hash TEXT NOT NULL,
                                chat_id TEXT NOT NULL,
                                session_id TEXT NOT NULL,
                                PRIMARY KEY (owner_hash, chat_id)
                            );
                            CREATE TABLE IF NOT EXISTS turns (
                                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                                owner_hash TEXT NOT NULL,
                                chat_id TEXT NOT NULL,
                                client_message_id TEXT NOT NULL,
                                request_id TEXT NOT NULL,
                                prompt_digest TEXT NOT NULL,
                                session_id TEXT NOT NULL,
                                state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'rejected')),
                                text TEXT,
                                UNIQUE (owner_hash, chat_id, client_message_id),
                                CHECK (
                                    (state = 'pending' AND text IS NULL)
                                    OR (state = 'rejected' AND text IS NULL)
                                    OR (state = 'completed' AND text IS NOT NULL AND length(text) BETWEEN 1 AND 100000)
                                )
                            );
                            CREATE INDEX IF NOT EXISTS turns_owner_chat_latest
                                ON turns(owner_hash, chat_id, sequence DESC);
                            """
                        )
                        _DB_INITIALIZED = True
                        break
                    except sqlite3.OperationalError as exc:
                        if "locked" not in str(exc).lower() or time.monotonic() >= deadline:
                            raise
                        time.sleep(0.01)
        yield connection
    finally:
        connection.close()


def _begin(connection: sqlite3.Connection) -> None:
    connection.execute("BEGIN IMMEDIATE")


def _commit(connection: sqlite3.Connection) -> None:
    connection.execute("COMMIT")


def _rollback(connection: sqlite3.Connection) -> None:
    if connection.in_transaction:
        connection.execute("ROLLBACK")


def _current_state(connection: sqlite3.Connection, owner: str) -> tuple[int, dict[str, Any]]:
    row = connection.execute(
        "SELECT revision, snapshot_json FROM state WHERE owner_hash = ?", (owner,)
    ).fetchone()
    if row is None:
        return 0, {"chats": [], "messages": {}, "sessions": {}}
    return int(row["revision"]), json.loads(row["snapshot_json"])


def _verify_audio_refs(
    connection: sqlite3.Connection, owner: str, refs: list[tuple[str, str]]
) -> None:
    for audio_id, chat_id in refs:
        row = connection.execute(
            "SELECT chat_id FROM audio WHERE owner_hash = ? AND audio_id = ?",
            (owner, audio_id),
        ).fetchone()
        if row is None or row["chat_id"] != chat_id:
            raise HTTPException(status_code=422, detail="Invalid audio reference")


def _turn_record(row: sqlite3.Row) -> dict[str, Any]:
    """Return only the public ledger contract; binding and owner stay private."""
    return {
        "chatId": row["chat_id"],
        "clientMessageId": row["client_message_id"],
        "requestId": row["request_id"],
        "state": row["state"],
        "text": row["text"],
    }


def _turn_row(
    connection: sqlite3.Connection,
    owner: str,
    chat_id: str,
    client_message_id: str,
) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT chat_id, client_message_id, request_id, prompt_digest,
               session_id, state, text
        FROM turns
        WHERE owner_hash = ? AND chat_id = ? AND client_message_id = ?
        """,
        (owner, chat_id, client_message_id),
    ).fetchone()


def _binding_session(
    connection: sqlite3.Connection, owner: str, chat_id: str
) -> str | None:
    row = connection.execute(
        "SELECT session_id FROM bindings WHERE owner_hash = ? AND chat_id = ?",
        (owner, chat_id),
    ).fetchone()
    return None if row is None else str(row["session_id"])


@router.get("/identity")
def identity(request: Request) -> JSONResponse:
    _principal(request)
    return _private_json({"scope": "personal"})


@router.get("/state")
def get_state(request: Request) -> JSONResponse:
    owner = _principal(request)
    with _connection() as connection:
        revision, snapshot = _current_state(connection, owner)
    return _private_json({"revision": revision, "snapshot": snapshot})


@router.put("/state")
async def put_state(request: Request) -> JSONResponse:
    owner = _principal(request)
    _same_origin(request)
    body = await _json_body(request)
    body = _exact_object(
        body,
        {"expectedRevision", "snapshot"},
        frozenset({"expectedRevision", "snapshot"}),
        "state body",
    )
    expected = body["expectedRevision"]
    if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
        raise HTTPException(status_code=422, detail="Invalid expectedRevision")
    snapshot, refs = _validate_snapshot(body["snapshot"])
    serialized = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    with _connection() as connection:
        try:
            _begin(connection)
            current, _ = _current_state(connection, owner)
            if current != expected:
                _rollback(connection)
                raise HTTPException(status_code=409, detail="Revision conflict")
            _verify_audio_refs(connection, owner, refs)
            revision = current + 1
            connection.execute(
                """
                INSERT INTO state(owner_hash, revision, snapshot_json) VALUES(?, ?, ?)
                ON CONFLICT(owner_hash) DO UPDATE SET
                    revision = excluded.revision,
                    snapshot_json = excluded.snapshot_json
                """,
                (owner, revision, serialized),
            )
            _commit(connection)
        except Exception:
            _rollback(connection)
            raise
    return _private_json({"revision": revision, "snapshot": snapshot})


@router.get("/audio/{audio_id}")
def get_audio(
    audio_id: str, request: Request, chat_id: str = Query(alias="chatId")
) -> Response:
    owner = _principal(request)
    audio_id = _safe_id(audio_id, "audio id")
    chat_id = _safe_id(chat_id, "chat id")
    with _connection() as connection:
        row = connection.execute(
            """
            SELECT content_type, body FROM audio
            WHERE owner_hash = ? AND audio_id = ? AND chat_id = ?
            """,
            (owner, audio_id, chat_id),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Audio not found")
    return Response(
        content=bytes(row["body"]),
        media_type=row["content_type"],
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.put("/audio/{audio_id}")
async def put_audio(
    audio_id: str, request: Request, chat_id: str = Query(alias="chatId")
) -> JSONResponse:
    owner = _principal(request)
    _same_origin(request)
    audio_id = _safe_id(audio_id, "audio id")
    chat_id = _safe_id(chat_id, "chat id")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in _AUDIO_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported audio Content-Type")
    body = await _bounded_body(request, _AUDIO_LIMIT)
    if not body:
        raise HTTPException(status_code=422, detail="Audio body is empty")
    with _connection() as connection:
        try:
            _begin(connection)
            current = connection.execute(
                "SELECT chat_id FROM audio WHERE owner_hash = ? AND audio_id = ?",
                (owner, audio_id),
            ).fetchone()
            if current is not None and current["chat_id"] != chat_id:
                _rollback(connection)
                raise HTTPException(status_code=409, detail="Audio id belongs to another chat")
            connection.execute(
                """
                INSERT INTO audio(owner_hash, audio_id, chat_id, content_type, size, body)
                VALUES(?, ?, ?, ?, ?, ?)
                ON CONFLICT(owner_hash, audio_id) DO UPDATE SET
                    content_type = excluded.content_type,
                    size = excluded.size,
                    body = excluded.body
                """,
                (owner, audio_id, chat_id, content_type, len(body), body),
            )
            _commit(connection)
        except Exception:
            _rollback(connection)
            raise
    return _private_json(
        {"id": audio_id, "chatId": chat_id, "contentType": content_type, "size": len(body)}
    )


@router.delete("/audio/{audio_id}")
def delete_audio(
    audio_id: str, request: Request, chat_id: str = Query(alias="chatId")
) -> Response:
    owner = _principal(request)
    _same_origin(request)
    audio_id = _safe_id(audio_id, "audio id")
    chat_id = _safe_id(chat_id, "chat id")
    with _connection() as connection:
        try:
            _begin(connection)
            row = connection.execute(
                "SELECT chat_id FROM audio WHERE owner_hash = ? AND audio_id = ?",
                (owner, audio_id),
            ).fetchone()
            if row is None or row["chat_id"] != chat_id:
                _rollback(connection)
                raise HTTPException(status_code=404, detail="Audio not found")
            _, snapshot = _current_state(connection, owner)
            _, refs = _validate_snapshot(snapshot)
            if (audio_id, chat_id) in refs:
                _rollback(connection)
                raise HTTPException(status_code=409, detail="Audio is referenced by state")
            cursor = connection.execute(
                "DELETE FROM audio WHERE owner_hash = ? AND audio_id = ? AND chat_id = ?",
                (owner, audio_id, chat_id),
            )
            if cursor.rowcount != 1:
                _rollback(connection)
                raise HTTPException(status_code=404, detail="Audio not found")
            _commit(connection)
        except Exception:
            _rollback(connection)
            raise
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/bindings")
def get_bindings(request: Request) -> JSONResponse:
    owner = _principal(request)
    with _connection() as connection:
        rows = connection.execute(
            "SELECT chat_id, session_id FROM bindings WHERE owner_hash = ? ORDER BY chat_id",
            (owner,),
        ).fetchall()
    return _private_json({"bindings": {row["chat_id"]: row["session_id"] for row in rows}})


@router.put("/bindings/{chat_id}")
async def put_binding(chat_id: str, request: Request) -> JSONResponse:
    owner = _principal(request)
    _same_origin(request)
    chat_id = _safe_id(chat_id, "chat id")
    body = await _json_body(request)
    body = _exact_object(
        body,
        {"sessionId", "expectedSessionId"},
        frozenset({"sessionId", "expectedSessionId"}),
        "binding body",
    )
    session_id = body["sessionId"]
    if session_id is not None:
        session_id = _safe_id(session_id, "session id")
    expected = body["expectedSessionId"]
    if expected is not None:
        expected = _safe_id(expected, "expected session id")
    with _connection() as connection:
        try:
            _begin(connection)
            row = connection.execute(
                "SELECT session_id FROM bindings WHERE owner_hash = ? AND chat_id = ?",
                (owner, chat_id),
            ).fetchone()
            current = None if row is None else row["session_id"]
            if current != expected:
                _rollback(connection)
                raise HTTPException(status_code=409, detail="Binding conflict")
            if current != session_id:
                pending = connection.execute(
                    """
                    SELECT 1 FROM turns
                    WHERE owner_hash = ? AND chat_id = ? AND state = 'pending'
                    LIMIT 1
                    """,
                    (owner, chat_id),
                ).fetchone()
                if pending is not None:
                    _rollback(connection)
                    raise HTTPException(
                        status_code=409, detail="Pending turn blocks binding change"
                    )
            if session_id is None:
                if current is not None:
                    cursor = connection.execute(
                        """
                        DELETE FROM bindings
                        WHERE owner_hash = ? AND chat_id = ? AND session_id = ?
                        """,
                        (owner, chat_id, expected),
                    )
                    if cursor.rowcount != 1:
                        raise RuntimeError("Binding delete lost atomic guard")
            else:
                connection.execute(
                    """
                    INSERT INTO bindings(owner_hash, chat_id, session_id) VALUES(?, ?, ?)
                    ON CONFLICT(owner_hash, chat_id) DO UPDATE SET session_id = excluded.session_id
                    """,
                    (owner, chat_id, session_id),
                )
            _commit(connection)
        except Exception:
            _rollback(connection)
            raise
    return _private_json({"chatId": chat_id, "sessionId": session_id})


@router.get("/turns/{chat_id}")
def get_turn(
    chat_id: str,
    request: Request,
    client_message_id: str | None = Query(default=None, alias="clientMessageId"),
) -> JSONResponse:
    """Read one turn by client id, or the latest durable turn for a chat."""
    owner = _principal(request)
    chat_id = _safe_id(chat_id, "chat id")
    if client_message_id is not None:
        client_message_id = _safe_id(client_message_id, "client message id")
    with _connection() as connection:
        if client_message_id is None:
            row = connection.execute(
                """
                SELECT chat_id, client_message_id, request_id, prompt_digest,
                       session_id, state, text
                FROM turns
                WHERE owner_hash = ? AND chat_id = ?
                ORDER BY sequence DESC
                LIMIT 1
                """,
                (owner, chat_id),
            ).fetchone()
        else:
            row = _turn_row(connection, owner, chat_id, client_message_id)
    return _private_json({"turn": None if row is None else _turn_record(row)})


@router.post("/turns/{chat_id}")
async def claim_turn(chat_id: str, request: Request) -> JSONResponse:
    """Atomically claim a bound turn before any prompt is submitted."""
    owner = _principal(request)
    _same_origin(request)
    chat_id = _safe_id(chat_id, "chat id")
    body = await _json_body(request, _TURN_BODY_LIMIT)
    body = _exact_object(
        body,
        {"clientMessageId", "requestId", "promptDigest"},
        frozenset({"clientMessageId", "requestId", "promptDigest"}),
        "turn claim body",
    )
    client_message_id = _safe_id(body["clientMessageId"], "client message id")
    request_id = _safe_id(body["requestId"], "request id")
    prompt_digest = body["promptDigest"]
    if not isinstance(prompt_digest, str) or _SHA256_HEX.fullmatch(prompt_digest) is None:
        raise HTTPException(status_code=422, detail="Invalid promptDigest")

    with _connection() as connection:
        try:
            _begin(connection)
            session_id = _binding_session(connection, owner, chat_id)
            if session_id is None:
                _rollback(connection)
                raise HTTPException(status_code=409, detail="Chat has no session binding")

            existing = _turn_row(connection, owner, chat_id, client_message_id)
            if existing is not None:
                if not hmac.compare_digest(existing["prompt_digest"], prompt_digest):
                    _rollback(connection)
                    raise HTTPException(status_code=409, detail="Prompt digest conflict")
                _commit(connection)
                return _private_json({"turn": _turn_record(existing), "claimed": False})

            pending = connection.execute(
                """
                SELECT 1 FROM turns
                WHERE owner_hash = ? AND chat_id = ? AND state = 'pending'
                LIMIT 1
                """,
                (owner, chat_id),
            ).fetchone()
            if pending is not None:
                _rollback(connection)
                raise HTTPException(status_code=409, detail="Chat already has a pending turn")

            connection.execute(
                """
                INSERT INTO turns(
                    owner_hash, chat_id, client_message_id, request_id,
                    prompt_digest, session_id, state, text
                ) VALUES(?, ?, ?, ?, ?, ?, 'pending', NULL)
                """,
                (
                    owner, chat_id, client_message_id, request_id,
                    prompt_digest, session_id,
                ),
            )
            row = _turn_row(connection, owner, chat_id, client_message_id)
            if row is None:
                raise RuntimeError("Turn claim was not persisted")
            _commit(connection)
        except Exception:
            _rollback(connection)
            raise
    return _private_json({"turn": _turn_record(row), "claimed": True})


@router.patch("/turns/{chat_id}/{client_message_id}")
async def finish_turn(
    chat_id: str, client_message_id: str, request: Request
) -> JSONResponse:
    """Durably finish a claimed turn; terminal records are immutable."""
    owner = _principal(request)
    _same_origin(request)
    chat_id = _safe_id(chat_id, "chat id")
    client_message_id = _safe_id(client_message_id, "client message id")
    body = await _json_body(request, _TURN_BODY_LIMIT)
    body = _exact_object(
        body,
        {"requestId", "state"},
        frozenset({"requestId", "state", "text"}),
        "turn finish body",
    )
    request_id = _safe_id(body["requestId"], "request id")
    state = body["state"]
    if state not in {"completed", "rejected"}:
        raise HTTPException(status_code=422, detail="Invalid turn state")
    if state == "completed":
        if "text" not in body:
            raise HTTPException(status_code=422, detail="Completed turn requires text")
        text = _plain_string(body["text"], "turn text", maximum=100_000)
        if not text:
            raise HTTPException(status_code=422, detail="Completed turn text is empty")
    else:
        if "text" in body:
            raise HTTPException(status_code=422, detail="Rejected turn cannot contain text")
        text = None

    with _connection() as connection:
        try:
            _begin(connection)
            row = _turn_row(connection, owner, chat_id, client_message_id)
            if row is None:
                _rollback(connection)
                raise HTTPException(status_code=404, detail="Turn not found")
            if not hmac.compare_digest(row["request_id"], request_id):
                _rollback(connection)
                raise HTTPException(status_code=409, detail="Request id conflict")
            if _binding_session(connection, owner, chat_id) != row["session_id"]:
                _rollback(connection)
                raise HTTPException(status_code=409, detail="Turn binding conflict")

            if row["state"] != "pending":
                if row["state"] != state or row["text"] != text:
                    _rollback(connection)
                    raise HTTPException(status_code=409, detail="Turn is immutable")
                _commit(connection)
                return _private_json({"turn": _turn_record(row)})

            cursor = connection.execute(
                """
                UPDATE turns SET state = ?, text = ?
                WHERE owner_hash = ? AND chat_id = ? AND client_message_id = ?
                  AND request_id = ? AND session_id = ? AND state = 'pending'
                """,
                (
                    state, text, owner, chat_id, client_message_id,
                    request_id, row["session_id"],
                ),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("Pending turn update lost atomic guard")
            finished = _turn_row(connection, owner, chat_id, client_message_id)
            if finished is None:
                raise RuntimeError("Finished turn was not persisted")
            _commit(connection)
        except Exception:
            _rollback(connection)
            raise
    return _private_json({"turn": _turn_record(finished)})
