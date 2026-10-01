"""换能器一致性判定算法的精确性 / 稳定性测试。"""

from __future__ import annotations

import copy
import random

import pytest

from app.transducer import (
    CONSISTENT,
    INCONSISTENT,
    INVALID,
    analyze,
    check_functionality,
)

EPS = "ε"


def tr(tid, source, symbol, target, output=""):
    return {"id": tid, "source": source, "input": symbol, "target": target, "output": output}


def spec(transitions, alphabet=("a", "b"), states=("q0", "q1"), initial="q0",
         accepts=("q1",)):
    return {
        "alphabet": list(alphabet),
        "states": list(states),
        "initial": initial,
        "accepts": list(accepts),
        "transitions": transitions,
    }


def codes(result):
    return sorted(e["code"] for e in result["errors"])


# ---------------------------------------------------------------- 基本性质


def test_deterministic_transducer_is_consistent():
    s = spec([tr("t1", "q0", "a", "q1", "X"), tr("t2", "q1", "b", "q1", "Y")])
    r = analyze(s)
    assert r["status"] == CONSISTENT
    assert r["evidence"] is None


def test_two_paths_same_output_consistent():
    s = spec(
        [
            tr("lo", "q0", "a", "q1", "A"),
            tr("hi", "q0", "a", "q1", "A"),
        ]
    )
    assert analyze(s)["status"] == CONSISTENT


def test_two_char_outputs_consistent():
    s = spec([tr("t1", "q0", "a", "q1", "AB"), tr("t2", "q0", "a", "q1", "AB")])
    assert analyze(s)["status"] == CONSISTENT


# ------------------------------------------------------ verify 目标反例：ε


def test_epsilon_dual_output_counterexample():
    """含 ε 迁移：同一点出发，一条追加 AB，一条追加 ε。"""
    s = spec(
        [
            tr("e1", "q0", EPS, "q1", "AB"),
            tr("e2", "q0", EPS, "q1", ""),
            tr("t1", "q1", "a", "q1", "C"),
        ],
        alphabet=("a",),
    )
    r = analyze(s)
    assert r["status"] == INCONSISTENT
    ev = r["evidence"]
    assert ev["input"] == ""
    assert ev["outputs"] == ["AB", ""]
    assert [s["id"] for s in ev["paths"][0]] == ["e1"]
    assert [s["id"] for s in ev["paths"][1]] == ["e2"]


def test_epsilon_interleaving_mismatch():
    """输入 a：直走产出 A；先 ε 产 X 再吃 a 产 A，输出不同。"""
    s = spec(
        [
            tr("dir", "q0", "a", "q1", "A"),
            tr("eps", "q0", EPS, "q0", "X"),
        ]
    )
    r = analyze(s)
    assert r["status"] == INCONSISTENT
    ev = r["evidence"]
    assert ev["input"] == "a"
    assert set(ev["outputs"]) == {"A", "XA"}
    assert [x["id"] for x in ev["paths"][1]] == ["eps", "dir"] or \
           [x["id"] for x in ev["paths"][0]] == ["eps", "dir"]


def test_long_epsilon_chain_requires_state_based_bound():
    """滞后 9 个字符 > 2*max_out(=2)：验证界必须基于微状态数而非 2M。

    q0 上两条 ε 选择：产 A 或不产；之后共用 8 条产 A 的 ε 链到接受态。
    """
    n = 10
    states = tuple("q%d" % i for i in range(n))
    transitions = [tr("a1", "q0", EPS, "q1", "A"), tr("zz", "q0", EPS, "q1", "")]
    for i in range(1, n - 1):
        transitions.append(tr("c%d" % i, "q%d" % i, EPS, "q%d" % (i + 1), "A"))
    s = spec(transitions, alphabet=("x",), states=states, initial="q0",
             accepts=("q%d" % (n - 1),))
    r = analyze(s)
    assert r["status"] == INCONSISTENT
    ev = r["evidence"]
    assert ev["input"] == ""
    assert set(ev["outputs"]) == {"A" * 9, "A" * 8}


def test_symbol_mismatch_after_shared_prefix():
    """两条路径首字符相同（A），第二字符分叉：AC vs AD。"""
    s = spec(
        [
            tr("l", "q0", "a", "q1", "AC"),
            tr("r", "q0", "a", "q1", "AD"),
        ]
    )
    r = analyze(s)
    assert r["status"] == INCONSISTENT
    ev = r["evidence"]
    assert ev["input"] == "a"
    assert set(ev["outputs"]) == {"AC", "AD"}


def test_dead_branch_is_not_false_positive():
    """分叉后左支无法到达接受态：不存在两条可接受路径，必须判一致。"""
    s = spec(
        [
            tr("l", "q0", "a", "dead", "A"),
            tr("r", "q0", "a", "q1", "B"),
            tr("go", "q1", "b", "q1", "C"),
        ],
        states=("q0", "q1", "dead"),
    )
    assert analyze(s)["status"] == CONSISTENT


def test_conflict_requires_continuation_to_accepts():
    """首字符分叉在非接受态 q2：需公共续接 b 到接受态；删掉 b 则不报。"""
    good = spec(
        [
            tr("l", "q0", "a", "q2", "A"),
            tr("r", "q0", "a", "q2", "B"),
            tr("cont", "q2", "b", "q1", "C"),
        ],
        states=("q0", "q1", "q2"),
    )
    r = analyze(good)
    assert r["status"] == INCONSISTENT
    assert r["evidence"]["input"] == "ab"
    assert set(r["evidence"]["outputs"]) == {"AC", "BC"}

    bad = spec(
        [tr("l", "q0", "a", "q2", "A"), tr("r", "q0", "a", "q2", "B")],
        states=("q0", "q1", "q2"),
    )
    assert analyze(bad)["status"] == CONSISTENT


def test_length_difference_via_lag_at_accepts():
    s = spec(
        [
            tr("l", "q0", "a", "q1", "A"),
            tr("r", "q0", "a", "q1", "AB"),
        ]
    )
    r = analyze(s)
    assert r["status"] == INCONSISTENT
    assert set(r["evidence"]["outputs"]) == {"A", "AB"}


def test_witness_is_shortest_input_then_ascii():
    """输入 b 立刻冲突；输入 aa 也冲突但更长，应裁决 b。"""
    s = spec(
        [
            tr("b1", "q0", "b", "q1", "X"),
            tr("b2", "q0", "b", "q1", "Y"),
            tr("a1", "q0", "a", "q0", "P"),
            tr("a2", "q0", "a", "q0", "Q"),
        ]
    )
    r = analyze(s)
    assert r["status"] == INCONSISTENT
    assert r["evidence"]["input"] == "b"


def test_witness_ascii_tiebreak():
    """同样长度 1：a 与 b 均冲突，ASCII 序选择 a。"""
    s = spec(
        [
            tr("ba", "q0", "b", "q1", "X"),
            tr("bb", "q0", "b", "q1", "Y"),
            tr("aa", "q0", "a", "q1", "P"),
            tr("ab", "q0", "a", "q1", "Q"),
        ]
    )
    assert analyze(s)["evidence"]["input"] == "a"


def test_transition_id_tiebreak_is_stable():
    """输入/输出完全对称：迁移标识序决定路径 A/B 顺序。"""
    s = spec([tr("zz", "q0", "a", "q1", "A"), tr("aa", "q0", "a", "q1", "B")])
    r1 = check_functionality(s)
    r2 = check_functionality(copy.deepcopy(s))
    assert r1 == r2
    ev = r1["evidence"]
    assert [x["id"] for x in ev["paths"][0]] == ["aa"]
    assert [x["id"] for x in ev["paths"][1]] == ["zz"]
    assert ev["outputs"] == ["B", "A"]


def test_larger_ambiguous_epsilon_loop():
    """ε 循环可任意重复：空串有 ε vs AA 两种输出。"""
    s = spec(
        [
            tr("loop", "q0", EPS, "q0", "AA"),
            tr("exit", "q0", EPS, "q1", ""),
            tr("a", "q1", "a", "q1", ""),
        ],
        alphabet=("a",),
    )
    r = analyze(s)
    assert r["status"] == INCONSISTENT
    assert r["evidence"]["input"] == ""
    assert set(r["evidence"]["outputs"]) == {"", "AA"}


# ---------------------------------------------------------------- 校验


def test_validation_aggregates_all_errors():
    s = {
        "alphabet": ["a", EPS],
        "states": ["q0", "q0", "bad name"],
        "initial": "ghost",
        "accepts": ["nobody"],
        "transitions": [
            {"id": "t1", "source": "q0", "input": "z", "target": "nowhere", "output": "abc"},
            {"id": "t1", "source": "x", "input": EPS + "a", "target": "y", "output": "1"},
        ],
    }
    r = analyze(s)
    assert r["status"] == INVALID
    c = codes(r)
    assert "ILLEGAL_EPSILON" in c
    assert "STATE_DUPLICATE" in c
    assert "STATE_NAME_INVALID" in c
    assert "INITIAL_UNKNOWN" in c
    assert "ACCEPT_UNKNOWN" in c
    assert "ACCEPTS_EMPTY" not in c  # 接受集非空（只是悬空）
    assert "UNKNOWN_INPUT_SYMBOL" in c
    assert "DANGLING_ENDPOINT" in c
    assert "OUTPUT_INVALID" in c
    assert "TRANSITION_ID_DUPLICATE" in c


def test_empty_accepts_rejected():
    s = spec([tr("t1", "q0", "a", "q1")], accepts=())
    assert analyze(s)["status"] == INVALID
    assert "ACCEPTS_EMPTY" in codes(analyze(s))


def test_limits_enforced():
    states = ["q%d" % i for i in range(11)]
    s = spec([], states=tuple(states), accepts=("q10",))
    assert "STATES_TOO_MANY" in codes(analyze(s))

    s2 = spec(
        [tr("t%02d" % i, "q0", "a", "q1") for i in range(31)],
        states=("q0", "q1"),
    )
    assert "TRANSITIONS_TOO_MANY" in codes(analyze(s2))


def test_output_must_be_uppercase_ascii():
    s = spec([tr("t1", "q0", "a", "q1", "aB")])
    assert analyze(s)["status"] == INVALID


# ------------------------------------------------------------ 规模与确定性


@pytest.mark.parametrize("seed", range(5))
def test_deterministic_witness_across_runs(seed):
    s = spec(
        [
            tr("m1", "q0", "a", "q0", "A"),
            tr("m2", "q0", "a", "q0", "B"),
            tr("f", "q0", "b", "q1", ""),
        ],
        states=("q0", "q1"),
    )
    r1 = analyze(copy.deepcopy(s))
    r2 = analyze(copy.deepcopy(s))
    assert r1 == r2
    assert r1["evidence"]["input"] == "ab"
    assert set(r1["evidence"]["outputs"]) == {"A", "B"}


# ------------------------------------------------------------ 规模 / 性能


def test_max_size_spec_performance():
    """10 状态、30 迁移、多符号：精确判定必须快速终止（非枚举）。"""
    import string
    import time

    alphabet = list(string.ascii_lowercase[:6])
    states = ["s%d" % i for i in range(10)]
    transitions = []
    rng = random.Random(7)
    for i in range(30):
        transitions.append(
            tr(
                "m%02d" % i,
                states[i % 10],
                alphabet[i % len(alphabet)],
                states[(i * 3 + 1) % 10],
                rng.choice(["", "A", "B", "AB", "BA"]),
            )
        )
    s = spec(transitions, alphabet=tuple(alphabet), states=tuple(states),
             initial="s0", accepts=("s9",))
    t0 = time.perf_counter()
    r = analyze(s)
    elapsed = time.perf_counter() - t0
    assert r["status"] in (CONSISTENT, INCONSISTENT)
    assert elapsed < 5.0, "判定耗时 %.2fs，疑似退化为路径枚举" % elapsed


# ------------------------------------------- 含 ε 循环但确实功能一致的用例


def test_silent_epsilon_loop_is_consistent():
    """空输出 ε 循环可任意穿插，所有可接受路径输出均为 X：必须判一致。"""
    s = spec(
        [
            tr("loop", "q0", EPS, "q0", ""),
            tr("go", "q0", "a", "q1", "X"),
            tr("acc", "q1", "a", "q1", "X"),
        ],
        alphabet=("a",),
    )
    assert analyze(s)["status"] == CONSISTENT


def test_mandatory_epsilon_prefix_consistent():
    """ε 前缀是唯一走法（两条拷贝都必走）：所有路径输出相同 AX。"""
    s = spec(
        [
            tr("pre", "q0", EPS, "q1", "A"),
            tr("go", "q1", "a", "q2", "X"),
        ],
        states=("q0", "q1", "q2"),
        alphabet=("a",),
        accepts=("q2",),
    )
    assert analyze(s)["status"] == CONSISTENT


def test_both_sides_silent_cycles_consistent():
    """两侧各自的空 ε 自环 + 同步迁移：输出恒等。"""
    s = spec(
        [
            tr("el", "q0", EPS, "q0", ""),
            tr("er", "q1", EPS, "q1", ""),
            tr("go", "q0", "a", "q1", "M"),
            tr("end", "q1", "b", "q2", "N"),
        ],
        states=("q0", "q1", "q2"),
        alphabet=("a", "b"),
        accepts=("q2",),
    )
    assert analyze(s)["status"] == CONSISTENT


def test_initial_is_accept_empty_string_semantics():
    """初态即接受态：空串可被接受；若空串存在两种输出则不一致。"""
    inconsistent = spec(
        [tr("e1", "q0", EPS, "q0", "A"), tr("go", "q0", "a", "q1", "B")],
        states=("q0", "q1"), accepts=("q0", "q1"),
    )
    assert analyze(inconsistent)["status"] == INCONSISTENT
    assert analyze(inconsistent)["evidence"]["input"] == ""

    consistent = spec(
        [tr("go", "q0", "a", "q1", "B")],
        states=("q0", "q1"), accepts=("q0", "q1"),
    )
    assert analyze(consistent)["status"] == CONSISTENT
