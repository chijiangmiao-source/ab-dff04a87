"""审计结论持久化（SQLite，标准库实现）。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS audits (
    audit_id     TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    spec_json    TEXT NOT NULL,
    result_json  TEXT NOT NULL,
    status       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
"""


def canonical_hash(payload: dict[str, Any]) -> str:
    """按换能器语义规范化后计算摘要。

    合法规格中集合类成员不允许重复，故 states/accepts/alphabet 排序、
    迁移按 id 排序后，同一换能器（无论列表书写顺序）得到同一摘要。
    """
    canon = dict(payload)
    for key in ("alphabet", "states", "accepts"):
        value = canon.get(key)
        if isinstance(value, list) and all(isinstance(x, str) for x in value):
            canon[key] = sorted(value)
    trs = canon.get("transitions")
    if isinstance(trs, list) and all(isinstance(t, dict) for t in trs):
        canon["transitions"] = sorted(
            trs, key=lambda t: str(t.get("id", ""))
        )
    blob = json.dumps(canon, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class AuditStore:
    def __init__(self, db_path: str | Path) -> None:
        self._path = str(db_path)
        parent = Path(self._path).parent
        parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(
            self._path, check_same_thread=False, isolation_level=None
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        with self._lock:
            self._conn.executescript(SCHEMA)

    def health(self) -> dict[str, Any]:
        with self._lock:
            count = self._conn.execute("SELECT COUNT(*) FROM audits").fetchone()[0]
        return {"database": "ok", "persisted_audits": count}

    def get(self, audit_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM audits WHERE audit_id = ?", (audit_id,)
            ).fetchone()
        if row is None:
            return None
        return {
            "audit_id": row["audit_id"],
            "payload_hash": row["payload_hash"],
            "spec": json.loads(row["spec_json"]),
            "result": json.loads(row["result_json"]),
            "status": row["status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def insert(self, audit_id: str, spec: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        """新建审计；同一标识已存在时抛 AuditIdConflict。"""
        payload_hash = canonical_hash(spec)
        now = _utcnow()
        record = {
            "audit_id": audit_id,
            "payload_hash": payload_hash,
            "spec": spec,
            "result": result,
            "status": result["status"],
            "created_at": now,
            "updated_at": now,
        }
        with self._lock:
            existing = self._conn.execute(
                "SELECT payload_hash, result_json, created_at FROM audits WHERE audit_id = ?",
                (audit_id,),
            ).fetchone()
            if existing is not None:
                if existing["payload_hash"] == payload_hash:
                    frozen = json.loads(existing["result_json"])
                    return {
                        "replayed": True,
                        "record": {
                            "audit_id": audit_id,
                            "payload_hash": payload_hash,
                            "spec": spec,
                            "result": frozen,
                            "status": frozen["status"],
                            "created_at": existing["created_at"],
                            "updated_at": existing["created_at"],
                        },
                    }
                raise AuditIdConflict(audit_id)
            self._conn.execute(
                "INSERT INTO audits (audit_id, payload_hash, spec_json, result_json,"
                " status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    audit_id,
                    payload_hash,
                    json.dumps(spec, ensure_ascii=False, sort_keys=True),
                    json.dumps(result, ensure_ascii=False),
                    result["status"],
                    now,
                    now,
                ),
            )
        return {"replayed": False, "record": record}


class AuditIdConflict(Exception):
    def __init__(self, audit_id: str) -> None:
        self.audit_id = audit_id
        super().__init__("审计标识 %r 已绑定不同载荷，拒绝重放。" % audit_id)
