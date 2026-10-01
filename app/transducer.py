"""有限状态换能器（FST）功能一致性判定。

核心问题：对任意输入串，换能器是否存在两条可接受路径产生不同输出
（关系是否为偏函数 / single-valuedness）。该性质可判定，这里采用
不限制输入长度、不做随机抽样或有限路径枚举的精确算法：

1. 在两份换能器拷贝的笛卡尔积上构造同步积。合法走法有三种：
   - 左侧单独走一条输入为 ε 的迁移；
   - 右侧单独走一条输入为 ε 的迁移；
   - 两侧同步消费同一个输入符号（ε 可任意穿插，覆盖所有交错顺序）。
2. 维护两条路径输出的“滞后差” (u, v)：输出串去掉最长公共前缀后，
   至多一侧非空。若一次推进后两侧首字符不同，则输出已永久分叉；
   若一对接受态处仍有非空滞后，则输出长度/内容不同。
3. 终止性与多项式界（不依赖输入长度限制）：同步积配置为
   (p, q, u, v)，其中滞后 (u, v) 至多一侧非空。经典滞后引理：
   若换能器功能一致，则对任一“既可达又共达接受态对”的状态对
   (p, q)，可到达的滞后至多只有一个——否则两个不同滞后配上同一
   条公共续接，必有一对完整路径输出不同。因此：
     - 状态对不能共达 F×F 的配置直接丢弃；
     - 同一状态对上出现第二个不同滞后时，立即用最短公共续接
       构造具体反例并停止扩展该配置（实际输出不等才采纳）；
     - 首字符分叉（两侧滞后均非空）立即用最短续接构造反例。
   每个状态对至多保留一个滞后，配置数 O(|Q|²)，搜索多项式终止，
   不做任何输入长度截断、随机抽样或有限路径枚举。
4. 证人按 (输入串长度, 输入串 ASCII 序, 左路径迁移标识序列,
   右路径迁移标识序列) 做单调字典序最短路（Dijkstra），保证裁决稳定。
"""

from __future__ import annotations

import heapq
import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

EPSILON = "ε"

MAX_STATES = 10
MAX_TRANSITIONS = 30
MAX_OUTPUT_LEN = 2
MAX_NAME_LEN = 32

NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,%d}$" % MAX_NAME_LEN)
AUDIT_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
OUTPUT_RE = re.compile(r"^[A-Z]{0,%d}$" % MAX_OUTPUT_LEN)

CONSISTENT = "CONSISTENT"
INCONSISTENT = "INCONSISTENT"
INVALID = "INVALID"


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------


def _err(code: str, message: str, **ref: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"code": code, "message": message}
    out.update(ref)
    return out


def validate_audit_id(audit_id: Any) -> list[dict[str, Any]]:
    if not isinstance(audit_id, str) or not audit_id:
        return [_err("AUDIT_ID_REQUIRED", "必须提供非空稳定审计标识。")]
    if not AUDIT_ID_RE.match(audit_id):
        return [
            _err(
                "AUDIT_ID_INVALID",
                "审计标识须为 1-64 个字母、数字、下划线、点或连字符。",
            )
        ]
    return []


def validate_spec(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """一次指出所有可静态发现的问题。"""
    errors: list[dict[str, Any]] = []

    def as_str_list(key: str) -> list[str]:
        value = spec.get(key)
        if not isinstance(value, list) or not all(
            isinstance(x, str) for x in value
        ):
            errors.append(_err("%s_INVALID" % key.upper(), "%s 必须是字符串数组。" % key))
            return []
        return list(value)

    states = as_str_list("states")
    accepts = as_str_list("accepts")

    alphabet_raw = spec.get("alphabet")
    alphabet: list[str] = []
    if not isinstance(alphabet_raw, list) or not all(
        isinstance(x, str) for x in alphabet_raw
    ):
        errors.append(_err("ALPHABET_INVALID", "输入字母表必须是字符数组。"))
    else:
        alphabet = list(alphabet_raw)
        seen: set[str] = set()
        for ch in alphabet:
            if ch == EPSILON:
                errors.append(
                    _err(
                        "ILLEGAL_EPSILON",
                        "输入字母表不得包含 ε；ε 仅可作为迁移的输入标记。",
                    )
                )
            elif len(ch) != 1 or not (33 <= ord(ch) <= 126):
                errors.append(
                    _err(
                        "SYMBOL_INVALID",
                        "输入符号必须是单个可打印 ASCII 字符（无空白），得到 %r。" % ch,
                    )
                )
            elif ch in seen:
                errors.append(_err("SYMBOL_DUPLICATE", "输入符号 %r 重复。" % ch))
            else:
                seen.add(ch)

    initial = spec.get("initial")
    if initial is not None and not isinstance(initial, str):
        errors.append(_err("INITIAL_INVALID", "初态必须是字符串。"))
        initial = None

    # 状态名
    state_set: set[str] = set()
    if not states:
        errors.append(_err("STATES_EMPTY", "状态集不能为空，且至多 %d 个。" % MAX_STATES))
    if len(states) > MAX_STATES:
        errors.append(
            _err("STATES_TOO_MANY", "状态数 %d 超过上限 %d。" % (len(states), MAX_STATES))
        )
    for name in states:
        if not NAME_RE.match(name):
            errors.append(
                _err(
                    "STATE_NAME_INVALID",
                    "状态名 %r 不合法：需 1-%d 个字母/数字/下划线/点/连字符。"
                    % (name, MAX_NAME_LEN),
                    state=name,
                )
            )
        elif name in state_set:
            errors.append(_err("STATE_DUPLICATE", "状态 %r 重复定义。" % name, state=name))
        else:
            state_set.add(name)

    if isinstance(initial, str):
        if not initial:
            errors.append(_err("INITIAL_REQUIRED", "必须指定初态。"))
        elif initial not in state_set:
            errors.append(
                _err("INITIAL_UNKNOWN", "初态 %r 不在状态集中。" % initial, state=initial)
            )

    if not accepts:
        errors.append(_err("ACCEPTS_EMPTY", "接受态集合不能为空。"))
    accept_set: set[str] = set()
    for name in accepts:
        if name not in state_set:
            errors.append(
                _err("ACCEPT_UNKNOWN", "接受态 %r 不在状态集中。" % name, state=name)
            )
        elif name in accept_set:
            errors.append(_err("ACCEPT_DUPLICATE", "接受态 %r 重复列出。" % name, state=name))
        else:
            accept_set.add(name)

    # 迁移
    transitions_raw = spec.get("transitions", [])
    if not isinstance(transitions_raw, list) or not all(
        isinstance(t, dict) for t in transitions_raw
    ):
        errors.append(_err("TRANSITIONS_INVALID", "迁移必须是对象数组。"))
        return errors

    if len(transitions_raw) > MAX_TRANSITIONS:
        errors.append(
            _err(
                "TRANSITIONS_TOO_MANY",
                "迁移数 %d 超过上限 %d。" % (len(transitions_raw), MAX_TRANSITIONS),
            )
        )

    alphabet_set = set(s for s in alphabet if len(s) == 1)
    seen_ids: set[str] = set()
    for idx, tr in enumerate(transitions_raw):
        ref = {"index": idx}
        tid = tr.get("id")
        if not isinstance(tid, str) or not tid:
            errors.append(_err("TRANSITION_ID_REQUIRED", "迁移必须有非空标识。", **ref))
        elif not NAME_RE.match(tid):
            errors.append(
                _err(
                    "TRANSITION_ID_INVALID",
                    "迁移标识 %r 不合法。" % tid,
                    **ref,
                    id=tid,
                )
            )
        elif tid in seen_ids:
            errors.append(
                _err("TRANSITION_ID_DUPLICATE", "迁移标识 %r 重复。" % tid, **ref, id=tid)
            )
        else:
            seen_ids.add(tid)
            ref["id"] = tid

        source = tr.get("source")
        target = tr.get("target")
        if not isinstance(source, str) or source not in state_set:
            errors.append(
                _err(
                    "DANGLING_ENDPOINT",
                    "迁移 %r 的源状态 %r 不存在。" % (tid, source),
                    **ref,
                    endpoint="source",
                )
            )
        if not isinstance(target, str) or target not in state_set:
            errors.append(
                _err(
                    "DANGLING_ENDPOINT",
                    "迁移 %r 的目标状态 %r 不存在。" % (tid, target),
                    **ref,
                    endpoint="target",
                )
            )

        symbol = tr.get("input")
        if not isinstance(symbol, str) or not symbol:
            errors.append(
                _err(
                    "TRANSITION_INPUT_REQUIRED",
                    "迁移 %r 必须消费一个输入符号或 ε。" % tid,
                    **ref,
                )
            )
        elif EPSILON in symbol:
            if symbol != EPSILON:
                errors.append(
                    _err(
                        "ILLEGAL_EPSILON",
                        "迁移 %r 的输入只能是单独的 ε，不能是 %r。" % (tid, symbol),
                        **ref,
                    )
                )
            # 单独的 ε 合法
        elif len(symbol) != 1 or symbol not in alphabet_set:
            errors.append(
                _err(
                    "UNKNOWN_INPUT_SYMBOL",
                    "迁移 %r 消费未知输入符号 %r。" % (tid, symbol),
                    **ref,
                )
            )

        output = tr.get("output", "")
        if not isinstance(output, str) or not OUTPUT_RE.match(output):
            errors.append(
                _err(
                    "OUTPUT_INVALID",
                    "迁移 %r 的输出 %r 必须是 0-%d 个大写 ASCII 字符。"
                    % (tid, output, MAX_OUTPUT_LEN),
                    **ref,
                )
            )

    return errors


def normalize_spec(spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "alphabet": list(spec["alphabet"]),
        "states": list(spec["states"]),
        "initial": spec["initial"],
        "accepts": list(spec["accepts"]),
        "transitions": [
            {
                "id": t["id"],
                "source": t["source"],
                "input": t["input"],
                "target": t["target"],
                "output": t.get("output", ""),
            }
            for t in spec["transitions"]
        ],
    }


# ---------------------------------------------------------------------------
# 功能一致性精确判定
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Transition:
    id: str
    source: str
    target: str
    symbol: str
    output: str

    def public(self) -> dict[str, str]:
        return {
            "id": self.id,
            "source": self.source,
            "input": self.symbol,
            "output": self.output,
            "target": self.target,
        }


def _advance(u: str, v: str, x: str, y: str) -> tuple[str, str, bool]:
    """两侧分别追加输出 x/y，去除最长公共前缀。

    返回 (新左滞后, 新右滞后, 是否首字符分叉)。
    """
    s = u + x
    t = v + y
    n = min(len(s), len(t))
    i = 0
    while i < n and s[i] == t[i]:
        i += 1
    su, sv = s[i:], t[i:]
    return su, sv, bool(su and sv)


def check_functionality(spec: dict[str, Any]) -> dict[str, Any]:
    """对合法 spec 精确判定；返回状态与（不一致时的）证人。"""
    states = sorted(spec["states"])
    initial = spec["initial"]
    accepts = set(spec["accepts"])
    alphabet = sorted(spec["alphabet"])

    transitions = [
        Transition(t["id"], t["source"], t["target"], t["input"], t.get("output", ""))
        for t in spec["transitions"]
    ]
    by_id = {t.id: t for t in transitions}

    eps_out: dict[str, list[Transition]] = defaultdict(list)
    sym_out: dict[tuple[str, str], list[Transition]] = defaultdict(list)
    for tr in sorted(transitions, key=lambda z: z.id):
        if tr.symbol == EPSILON:
            eps_out[tr.source].append(tr)
        else:
            sym_out[(tr.source, tr.symbol)].append(tr)

    # 预取每条最短公共续接在两侧追加的输出串，用于双滞后冲突证人。
    suffix_out: dict[tuple[str, str], tuple[str, str]] = {}

    # -- 反向图：为每个状态对求到 F × F 的字典序最短“公共续接” ----------
    # 边（正向 pair -> pair）：
    #   左 ε / 右 ε / 两侧同步消费同一符号。
    # 边键 = (输入长度, 输入串, 左迁移 id 元组, 右迁移 id 元组)。
    predecessors: dict[tuple[str, str], list[tuple]] = defaultdict(list)
    for p in states:
        for q in states:
            pair = (p, q)
            for tl in eps_out[p]:
                predecessors[(tl.target, q)].append(
                    (pair, (0, "", (tl.id,), ()))
                )
            for tr in eps_out[q]:
                predecessors[(p, tr.target)].append(
                    (pair, (0, "", (), (tr.id,)))
                )
            for a in alphabet:
                for tl in sym_out[(p, a)]:
                    for tr in sym_out[(q, a)]:
                        predecessors[(tl.target, tr.target)].append(
                            (pair, (1, a, (tl.id,), (tr.id,)))
                        )

    accept_pairs = {(f1, f2) for f1 in accepts for f2 in accepts}
    # 反向 Dijkstra（字典序）：suf[node] 保存到某接受态对的最短续接
    # (输入串, 左 ids, 右 ids)；dist 保存完整键。
    suf_dist: dict[tuple[str, str], tuple] = {}
    suffix: dict[tuple[str, str], tuple] = {}
    rheap: list[tuple] = []
    for ap in accept_pairs:
        heapq.heappush(rheap, ((0, "", (), ()), ap))
    while rheap:
        key, node = heapq.heappop(rheap)
        if node in suf_dist:
            continue
        suf_dist[node] = key
        # 由前驱边增量恢复续接内容
        # key 自身即完整续接键，从中取输入串；id 序列重建一次。
        suffix[node] = None  # 占位，稍后填充
        for prev, ekey in predecessors.get(node, ()):
            if prev in suf_dist:
                continue
            cand = (
                ekey[0] + key[0],
                ekey[1] + key[1],
                ekey[2] + key[2],
                ekey[3] + key[3],
            )
            heapq.heappush(rheap, (cand, prev))
    # 填充续接内容（直接取 dist 键中的串与 id 元组）
    for node, key in suf_dist.items():
        sin, sl, sr = key[1], key[2], key[3]
        suffix[node] = (sin, sl, sr)
        suffix_out[node] = (
            "".join(by_id[i].output for i in sl),
            "".join(by_id[i].output for i in sr),
        )

    # -- 同步积前向搜索（带滞后差） ---------------------------------------
    # key = (输入长度, 输入串, 左迁移 id 元组, 右迁移 id 元组)
    start_key = (0, "", (), ())
    heap: list[tuple] = [(start_key, (initial, initial, "", ""))]
    # 滞后引理：功能一致时每个共达状态对至多可达一个滞后。
    # pair_lag[pair] = (u, v, key)。
    pair_lag: dict[tuple[str, str], tuple[str, str, tuple]] = {}

    # 全局最优完整反例：(完整键, 左 ids, 右 ids)
    best: tuple | None = None

    def full_key(pair, key):
        sin, sl, sr = suffix[pair]
        return (
            key[0] + len(sin),
            key[1] + sin,
            key[2] + sl,
            key[3] + sr,
        )

    def offer(p2, q2, u2, v2, clash, key) -> None:
        nonlocal best
        pair = (p2, q2)
        if pair not in suffix:
            return  # 无法共达接受态对：任何分叉都不致命
        if clash:
            # 两侧滞后首字符不同 → 输出永久分叉，任意续接都保持不等。
            full = full_key(pair, key)
            if best is None or full < best[0]:
                _, sl, sr = suffix[pair]
                best = (full, key[2] + sl, key[3] + sr)
            return  # 分叉配置不再扩展
        stored = pair_lag.get(pair)
        if stored is None:
            pair_lag[pair] = (u2, v2, key)
            heapq.heappush(heap, (key, (p2, q2, u2, v2)))
            return
        if stored[0] == u2 and stored[1] == v2:
            # 同一滞后经另一前缀到达：保留裁决序更小的前缀。
            if key < stored[2]:
                pair_lag[pair] = (u2, v2, key)
                heapq.heappush(heap, (key, (p2, q2, u2, v2)))
            return
        # 同一共达状态对上出现第二个不同滞后。取其最短公共续接，
        # 二者中必有一对完整路径输出不同（验证后采纳）。
        u1, v1, key1 = stored
        s_out_l, s_out_r = suffix_out[pair]
        differs1 = u1 + s_out_l != v1 + s_out_r
        differs2 = u2 + s_out_l != v2 + s_out_r
        if differs1 or differs2:
            full1 = full_key(pair, key1)
            full2 = full_key(pair, key)
            if differs1 and differs2:
                chosen, ck = (key1, full1) if full1 <= full2 else (key, full2)
            else:
                chosen, ck = (key1, full1) if differs1 else (key, full2)
            if best is None or ck < best[0]:
                _, sl, sr = suffix[pair]
                best = (ck, chosen[2] + sl, chosen[3] + sr)
        # 功能一致时第二个滞后不可能存在；不一致时上面已给证人。
        # 不再扩展，保证每对状态至多一个滞后、搜索多项式终止。

    offer(initial, initial, "", "", False, start_key)

    while heap:
        key, conf = heapq.heappop(heap)
        p, q, u, v = conf
        stored = pair_lag.get((p, q))
        if stored is None or stored[2] != key:
            continue  # 已被裁决序更小的前缀取代

        # settled 时检查：接受态对残留单侧滞后 = 完整反例（长度不同）。
        if (u or v) and p in accepts and q in accepts:
            if best is None or key < best[0]:
                best = (key, key[2], key[3])

        # 左侧 ε
        for tl in eps_out[p]:
            u2, v2, clash = _advance(u, v, tl.output, "")
            nkey = (key[0], key[1], key[2] + (tl.id,), key[3])
            offer(tl.target, q, u2, v2, clash, nkey)
        # 右侧 ε
        for tr in eps_out[q]:
            u2, v2, clash = _advance(u, v, "", tr.output)
            nkey = (key[0], key[1], key[2], key[3] + (tr.id,))
            offer(p, tr.target, u2, v2, clash, nkey)
        # 同步消费同一符号
        for a in alphabet:
            for tl in sym_out[(p, a)]:
                for tr in sym_out[(q, a)]:
                    u2, v2, clash = _advance(u, v, tl.output, tr.output)
                    nkey = (
                        key[0] + 1,
                        key[1] + a,
                        key[2] + (tl.id,),
                        key[3] + (tr.id,),
                    )
                    offer(tl.target, tr.target, u2, v2, clash, nkey)

    if best is None:
        return {"status": CONSISTENT, "evidence": None}

    _, left_ids, right_ids = best
    left_steps = [by_id[i].public() for i in left_ids]
    right_steps = [by_id[i].public() for i in right_ids]
    output1 = "".join(by_id[i].output for i in left_ids)
    output2 = "".join(by_id[i].output for i in right_ids)
    input_string = "".join(
        by_id[i].symbol for i in left_ids if by_id[i].symbol != EPSILON
    )

    return {
        "status": INCONSISTENT,
        "evidence": {
            "input": input_string,
            "paths": [left_steps, right_steps],
            "outputs": [output1, output2],
        },
    }


def analyze(spec: dict[str, Any]) -> dict[str, Any]:
    errors = validate_spec(spec)
    if errors:
        return {"status": INVALID, "evidence": None, "errors": errors}
    result = check_functionality(normalize_spec(spec))
    result["errors"] = []
    return result
