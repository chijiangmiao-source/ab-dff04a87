#!/usr/bin/env python3
"""HTTP 冒烟：针对“含 ε 迁移的双输出反例”验证真实 API 全链路。

用法: python smoke.py [BASE_URL]
仅依赖标准库；成功退出码 0，任一断言失败退出码 1。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BASE_URL", "http://127.0.0.1:8080")
EPS = "ε"

# 唯一审计标识：即便对接已有数据库，首次提交也必然是新建；
# 紧接着第二次提交验证同标识同载荷的冻结回放。
RUN_TAG = os.environ.get("SMOKE_RUN_TAG") or str(__import__("time").time_ns())
AUDIT_ID = "SMOKE-EPS-DUAL-%s" % RUN_TAG

PAYLOAD = {
    "audit_id": AUDIT_ID,
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

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("  PASS " if cond else "  FAIL ") + name + ((" — " + detail) if detail and not cond else ""))
    if not cond:
        failures.append(name)


def request(method: str, path: str, body=None, expect: int | None = None):
    url = BASE.rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read().decode()
            code = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        code = e.code
    parsed = json.loads(raw) if raw else {}
    if expect is not None:
        check("HTTP %s %s -> %d" % (method, path, expect), code == expect,
              "got %d: %s" % (code, raw[:200]))
    return code, parsed


def main() -> int:
    print("SMOKE against", BASE)

    code, health = request("GET", "/health", expect=200)
    check("health.status == ok", health.get("status") == "ok", str(health))
    check("health advertises page", health.get("page") == "/")

    with urllib.request.urlopen(BASE.rstrip("/") + "/", timeout=5) as resp:
        page = resp.read().decode()
        check("GET / returns HTML page", resp.status == 200 and "功能一致性" in page)

    code, first = request("POST", "/api/audits", PAYLOAD, expect=200)
    check("status INCONSISTENT", first.get("status") == "INCONSISTENT", str(first.get("status")))
    check("not replayed on first submit", first.get("replayed") is False)
    ev = first.get("evidence") or {}
    check("counterexample input is empty string (ε)", ev.get("input") == "", str(ev.get("input")))
    check("outputs are AB and ε", ev.get("outputs") == ["AB", ""], str(ev.get("outputs")))
    paths = ev.get("paths") or [[], []]
    ids0 = [s.get("id") for s in paths[0]]
    ids1 = [s.get("id") for s in paths[1]]
    check("path A walks e1 (ε / AB)", ids0 == ["e1"], str(ids0))
    check("path B walks e2 (ε / empty)", ids1 == ["e2"], str(ids1))
    check("two paths differ", first["evidence"]["outputs"][0] != first["evidence"]["outputs"][1])

    code, replay = request("POST", "/api/audits", PAYLOAD, expect=200)
    check("same id+payload replays frozen conclusion", replay.get("replayed") is True)
    check("frozen evidence identical", replay.get("evidence") == first.get("evidence"))

    changed = json.loads(json.dumps(PAYLOAD))
    changed["transitions"][0]["output"] = "ZZ"
    code, rejected = request("POST", "/api/audits", changed, expect=409)
    check("same id different payload rejected 409",
          rejected.get("status") == "REJECTED"
          and rejected["errors"][0]["code"] == "AUDIT_ID_CONFLICT")

    code, reopened = request("GET", "/api/audits/" + AUDIT_ID, expect=200)
    check("reopen by id returns persisted conclusion",
          reopened.get("status") == "INCONSISTENT"
          and reopened.get("evidence", {}).get("outputs") == ["AB", ""])

    code, missing = request("GET", "/api/audits/NO-SUCH-AUDIT", expect=404)
    check("missing audit -> 404", missing.get("errors", [{}])[0].get("code") == "AUDIT_NOT_FOUND")

    if failures:
        print("\nSMOKE FAILED: %d check(s): %s" % (len(failures), "; ".join(failures)))
        return 1
    print("\nSMOKE PASSED: all API/persistence/replay checks succeeded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
