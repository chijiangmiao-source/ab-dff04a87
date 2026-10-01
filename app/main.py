"""星载指令转码器一致性审计服务。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .storage import AuditIdConflict, AuditStore, canonical_hash
from .transducer import analyze, validate_audit_id

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = os.environ.get("TRANSDUCER_DB", str(BASE_DIR / "data" / "audits.db"))
SERVICE_VERSION = "1.0.0"

app = FastAPI(title="星载指令转能器一致性审计", version=SERVICE_VERSION)
store = AuditStore(DB_PATH)

SPEC_KEYS = ("alphabet", "states", "initial", "accepts", "transitions")


def _payload_from_body(body: dict[str, Any]) -> dict[str, Any]:
    """提取与审计载荷有关的字段（剔除审计标识与外层噪声）。"""
    return {k: body.get(k) for k in SPEC_KEYS if k in body}


def _serialize(record: dict[str, Any], replayed: bool) -> dict[str, Any]:
    result = record["result"]
    return {
        "audit_id": record["audit_id"],
        "payload_hash": record["payload_hash"],
        "status": result["status"],
        "evidence": result.get("evidence"),
        "errors": result.get("errors", []),
        "spec": record["spec"],
        "replayed": replayed,
        "frozen": replayed,
        "created_at": record["created_at"],
        "updated_at": record["updated_at"],
    }


@app.post("/api/audits")
async def submit_audit(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse(
            {"status": "INVALID", "errors": [{"code": "BAD_JSON", "message": "请求体不是合法 JSON。"}]},
            status_code=400,
        )
    if not isinstance(body, dict):
        return JSONResponse(
            {"status": "INVALID", "errors": [{"code": "BAD_BODY", "message": "请求体必须是 JSON 对象。"}]},
            status_code=400,
        )

    audit_id = body.get("audit_id")
    id_errors = validate_audit_id(audit_id)
    if id_errors:
        return JSONResponse({"status": "INVALID", "errors": id_errors}, status_code=400)

    payload = _payload_from_body(body)

    # 先查既有审计：同标识同载荷回放冻结结论，换载荷拒绝（409）。
    existing = store.get(audit_id)
    if existing is not None:
        if canonical_hash(payload) != existing["payload_hash"]:
            return JSONResponse(
                {
                    "status": "REJECTED",
                    "errors": [
                        {
                            "code": "AUDIT_ID_CONFLICT",
                            "message": "审计标识 %r 已绑定不同载荷，禁止覆盖；请使用新标识。"
                            % audit_id,
                        }
                    ],
                    "existing_created_at": existing["created_at"],
                },
                status_code=409,
            )
        return JSONResponse(_serialize(existing, replayed=True))

    result = analyze(payload)
    if result["status"] == "INVALID":
        # 非法规格不持久化：用户修正后可沿用同一标识重新提交。
        return JSONResponse(_serialize(
            {
                "audit_id": audit_id,
                "payload_hash": canonical_hash(payload),
                "spec": payload,
                "result": result,
                "created_at": None,
                "updated_at": None,
            },
            replayed=False,
        ), status_code=422)
    try:
        outcome = store.insert(audit_id, payload, result)
    except AuditIdConflict:
        return JSONResponse(
            {
                "status": "REJECTED",
                "errors": [
                    {
                        "code": "AUDIT_ID_CONFLICT",
                        "message": "审计标识 %r 已绑定不同载荷，禁止覆盖；请使用新标识。"
                        % audit_id,
                    }
                ],
            },
            status_code=409,
        )
    record = outcome["record"]
    return JSONResponse(
        _serialize(record, replayed=False),
        status_code=200 if result["status"] != "INVALID" else 422,
    )


@app.get("/api/audits/{audit_id}")
async def get_audit(audit_id: str) -> JSONResponse:
    id_errors = validate_audit_id(audit_id)
    if id_errors:
        return JSONResponse({"status": "INVALID", "errors": id_errors}, status_code=400)
    record = store.get(audit_id)
    if record is None:
        return JSONResponse(
            {
                "status": "NOT_FOUND",
                "errors": [
                    {"code": "AUDIT_NOT_FOUND", "message": "审计 %r 不存在。" % audit_id}
                ],
            },
            status_code=404,
        )
    return JSONResponse(_serialize(record, replayed=True))


@app.get("/health")
async def health() -> JSONResponse:
    try:
        db = store.health()
    except Exception as exc:  # pragma: no cover - 故障路径
        return JSONResponse(
            {"status": "unhealthy", "service": "transducer-audit", "database": str(exc)},
            status_code=503,
        )
    return JSONResponse(
        {
            "status": "ok",
            "service": "transducer-audit",
            "version": SERVICE_VERSION,
            "page": "/",
            "submit_endpoint": "/api/audits",
            **db,
        }
    )


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(str(BASE_DIR / "static" / "index.html"))


app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
