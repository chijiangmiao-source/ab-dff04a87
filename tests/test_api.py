"""HTTP API、冻结回放、拒绝重放、持久化与页面测试。"""

from __future__ import annotations

import os

import pytest

# 每个测试会话使用独立数据库
_DB = os.path.join(os.path.dirname(__file__), "_test_audits.db")
for _suffix in ("", "-wal", "-shm"):
    try:
        os.remove(_DB + _suffix)
    except OSError:
        pass
os.environ["TRANSDUCER_DB"] = _DB


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app, store

    # 清空表，保证用例隔离
    store._conn.execute("DELETE FROM audits")
    with TestClient(app) as c:
        yield c
    store._conn.execute("DELETE FROM audits")


EPS = "ε"


def epsilon_case(audit_id="EPS-DUAL-0001"):
    return {
        "audit_id": audit_id,
        "alphabet": ["a"],
        "states": ["q0", "q1"],
        "initial": "q0",
        "accepts": ["q1"],
        "transitions": [
            {"id": "e1", "source": "q0", "input": EPS, "target": "q1", "output": "AB"},
            {"id": "e2", "source": "q0", "input": EPS, "target": "q1", "output": ""},
            {"id": "t1", "source": "q1", "input": "a", "target": "q1", "output": "C"},
        ],
    }


def test_health_reports_page_state(client):
    r = client.get("/health")
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "ok"
    assert j["persisted_audits"] == 0
    assert j["page"] == "/"
    assert j["submit_endpoint"] == "/api/audits"


def test_index_page_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert "功能一致性" in r.text


def test_invalid_spec_collects_errors(client):
    r = client.post(
        "/api/audits",
        json={
            "audit_id": "BAD-1",
            "alphabet": ["a", EPS],
            "states": ["q0", "q0"],
            "initial": "q0",
            "accepts": [],
            "transitions": [
                {"id": "x", "source": "q0", "input": "z", "target": "qq", "output": "ab"},
            ],
        },
    )
    assert r.status_code == 422
    j = r.json()
    codes = {e["code"] for e in j["errors"]}
    assert {"ILLEGAL_EPSILON", "STATE_DUPLICATE", "ACCEPTS_EMPTY",
            "UNKNOWN_INPUT_SYMBOL", "DANGLING_ENDPOINT", "OUTPUT_INVALID"} <= codes
    assert j["status"] == "INVALID"


def test_invalid_spec_not_persisted_and_id_reusable(client):
    bad = epsilon_case("RETRY-1")
    bad["accepts"] = []
    r = client.post("/api/audits", json=bad)
    assert r.status_code == 422
    # 未持久化
    assert client.get("/api/audits/RETRY-1").status_code == 404
    assert client.get("/health").json()["persisted_audits"] == 0
    # 修正笔误后同标识可正常提交
    ok = client.post("/api/audits", json=epsilon_case("RETRY-1"))
    assert ok.status_code == 200
    assert ok.json()["status"] == "INCONSISTENT"


def test_epsilon_dual_output_counterexample_via_api(client):
    r = client.post("/api/audits", json=epsilon_case())
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "INCONSISTENT"
    assert j["replayed"] is False
    ev = j["evidence"]
    assert ev["input"] == ""
    assert ev["outputs"] == ["AB", ""]
    ids0 = [s["id"] for s in ev["paths"][0]]
    ids1 = [s["id"] for s in ev["paths"][1]]
    assert ids0 == ["e1"]
    assert ids1 == ["e2"]
    # 逐迁移结构完整
    for step in ev["paths"][0] + ev["paths"][1]:
        assert {"id", "source", "input", "output", "target"} <= set(step)


def test_consistent_submission(client):
    r = client.post(
        "/api/audits",
        json={
            "audit_id": "OK-1",
            "alphabet": ["a"],
            "states": ["q0", "q1"],
            "initial": "q0",
            "accepts": ["q1"],
            "transitions": [
                {"id": "t1", "source": "q0", "input": "a", "target": "q1", "output": "XY"},
            ],
        },
    )
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "CONSISTENT"
    assert j["evidence"] is None


def test_replay_same_payload_freezes_conclusion(client):
    first = client.post("/api/audits", json=epsilon_case()).json()
    second = client.post("/api/audits", json=epsilon_case()).json()
    assert second["replayed"] is True
    assert second["frozen"] is True
    assert second["evidence"] == first["evidence"]
    assert second["status"] == first["status"]
    assert second["created_at"] == first["created_at"]


def test_replay_semantically_identical_reordered_payload(client):
    """迁移/状态书写顺序不同但换能器相同：视为同载荷回放。"""
    client.post("/api/audits", json=epsilon_case())
    reordered = epsilon_case()
    reordered["transitions"] = list(reversed(reordered["transitions"]))
    r = client.post("/api/audits", json=reordered)
    assert r.status_code == 200
    assert r.json()["replayed"] is True


def test_same_id_different_payload_rejected(client):
    client.post("/api/audits", json=epsilon_case())
    changed = epsilon_case()
    changed["transitions"][0]["output"] = "ZZ"  # 同标识换载荷
    r = client.post("/api/audits", json=changed)
    assert r.status_code == 409
    j = r.json()
    assert j["status"] == "REJECTED"
    assert j["errors"][0]["code"] == "AUDIT_ID_CONFLICT"
    # 原结论未被污染
    got = client.get("/api/audits/EPS-DUAL-0001").json()
    assert got["evidence"]["outputs"] == ["AB", ""]


def test_reopen_audit_by_id(client):
    client.post("/api/audits", json=epsilon_case())
    r = client.get("/api/audits/EPS-DUAL-0001")
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "INCONSISTENT"
    assert j["audit_id"] == "EPS-DUAL-0001"
    assert j["spec"]["transitions"][0]["id"] == "e1"


def test_reopen_missing_returns_404(client):
    r = client.get("/api/audits/NOPE")
    assert r.status_code == 404
    assert r.json()["errors"][0]["code"] == "AUDIT_NOT_FOUND"


def test_conclusion_persisted_across_store_restart(tmp_path):
    from app.storage import AuditStore

    db = tmp_path / "restart.db"
    from app.transducer import analyze

    payload = {k: v for k, v in epsilon_case("PERSIST-1").items() if k != "audit_id"}
    result = analyze(payload)
    s1 = AuditStore(db)
    s1.insert("PERSIST-1", payload, result)
    del s1

    s2 = AuditStore(db)
    rec = s2.get("PERSIST-1")
    assert rec is not None
    assert rec["result"]["status"] == "INCONSISTENT"
    assert rec["result"]["evidence"]["outputs"] == ["AB", ""]


def test_health_count_tracks_persistence(client):
    assert client.get("/health").json()["persisted_audits"] == 0
    client.post("/api/audits", json=epsilon_case())
    assert client.get("/health").json()["persisted_audits"] == 1
    client.post(
        "/api/audits",
        json={
            "audit_id": "OK-X",
            "alphabet": ["a"], "states": ["q0", "q1"], "initial": "q0",
            "accepts": ["q1"],
            "transitions": [
                {"id": "t", "source": "q0", "input": "a", "target": "q1", "output": ""}
            ],
        },
    )
    assert client.get("/health").json()["persisted_audits"] == 2
    # 回放不新增
    client.post("/api/audits", json=epsilon_case())
    assert client.get("/health").json()["persisted_audits"] == 2


def test_bad_json_rejected(client):
    r = client.post("/api/audits", content=b"{not json",
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 400
    assert r.json()["errors"][0]["code"] == "BAD_JSON"
