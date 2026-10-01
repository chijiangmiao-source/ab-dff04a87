"""随机差分测试：有界完备枚举 vs 精确判定。

对小型随机换能器，枚举所有长度 <= L 的输入串上全部可达
(状态, 输出) 配置，长度上限内的冲突检测是完备的；以此交叉验证
精确算法：精确算法判 CONSISTENT 时，枚举不得发现任何冲突；
精确算法给出的证人必须能逐迁移回放且确实产生不同输出。
"""

from __future__ import annotations

import random

from app.transducer import CONSISTENT, INCONSISTENT, EPSILON, analyze

ALPHABET = ["a", "b"]
OUTPUTS = ["", "A", "B", "AB", "BA"]
LIMIT = 6
CAP = 200_000  # 单层配置保护：超限则跳过该用例


def random_spec(rng):
    n = rng.randint(2, 3)
    states = ["q%d" % i for i in range(n)]
    accepts = [rng.choice(states)]
    transitions = []
    used = 0
    for p in states:
        for sym in ALPHABET + [EPSILON]:
            # ε 迁移密度更高，重点制造多滞后 / ε 循环场景
            prob = 0.55 if sym == EPSILON else 0.4
            if rng.random() < prob and used < 12:
                transitions.append(
                    {
                        "id": "t%02d" % used,
                        "source": p,
                        "input": sym,
                        "target": rng.choice(states),
                        "output": rng.choice(OUTPUTS),
                    }
                )
                used += 1
    if not transitions:
        transitions.append(
            {"id": "t00", "source": states[0], "input": "a",
             "target": accepts[0], "output": "A"}
        )
    return {
        "alphabet": ALPHABET,
        "states": states,
        "initial": states[0],
        "accepts": accepts,
        "transitions": transitions,
    }


def enumerate_conflict(spec):
    """有界枚举全部路径，按裁决序找限长内最优证人。

    健全（sound）：报告的任何冲突都是真实的两条可接受路径。
    返回 (best_key, word, out1, out2)、None 或 "skip"（超配置保护）。
    """
    by_src = {}
    for t in spec["transitions"]:
        by_src.setdefault(t["source"], []).append(t)
    accepts = set(spec["accepts"])
    step_budget = LIMIT + 2 * len(spec["states"])

    # 配置 (state, output, word, steps, ids)
    zero = (spec["initial"], "", "", 0, ())
    seen = {zero[:4]}
    frontier = [zero]
    # word -> {output: ids}（限长内每种输出保留裁决序最小的 ids）
    accepted: dict[str, dict[str, tuple]] = {}
    best = None

    def consider(p, o, word, ids):
        if p not in accepts:
            return None
        bucket = accepted.setdefault(word, {})
        old = bucket.get(o)
        if old is None or ids < old:
            bucket[o] = ids
        if len(bucket) >= 2:
            # 路径序按迁移标识元组对裁决：取标识元组最小的一对
            pairs = sorted(
                ((ids_o, out_o) for out_o, ids_o in bucket.items()),
                key=lambda x: x[0],
            )
            (i1, out1), (i2, out2) = pairs[0], pairs[1]
            return ((len(word), word, i1, i2), word, out1, out2)
        return None

    hit = consider(spec["initial"], "", "", ())
    if hit:
        best = hit

    while frontier:
        if len(seen) > CAP:
            return "skip"
        nxt = []
        for p, o, word, steps, ids in frontier:
            for t in by_src.get(p, []):
                if t["input"] == EPSILON:
                    if steps >= step_budget:
                        continue
                    nw, ns = word, steps + 1
                else:
                    if len(word) >= LIMIT:
                        continue
                    nw, ns = word + t["input"], steps + 1
                nids = ids + (t["id"],)
                marker = (t["target"], o + t["output"], nw, ns)
                if marker in seen:
                    # 即便配置见过，新的 id 路径也可能在接受态更优；
                    # 但有界枚举只求健全，这里跳过重复 (state,out,word,steps)。
                    hit2 = consider(t["target"], o + t["output"], nw, nids)
                    if hit2 and (best is None or hit2[0] < best[0]):
                        best = hit2
                    continue
                seen.add(marker)
                hit2 = consider(t["target"], o + t["output"], nw, nids)
                if hit2 and (best is None or hit2[0] < best[0]):
                    best = hit2
                nxt.append((t["target"], o + t["output"], nw, ns, nids))
        frontier = nxt
    return best


def replay(spec, ids):
    by_id = {t["id"]: t for t in spec["transitions"]}
    p = spec["initial"]
    consumed = []
    produced = ""
    for i in ids:
        t = by_id[i]
        assert t["source"] == p, "证人路径迁移 %s 端点不衔接" % i
        p = t["target"]
        if t["input"] != EPSILON:
            consumed.append(t["input"])
        produced += t["output"]
    assert p in spec["accepts"], "证人路径终点不是接受态"
    return "".join(consumed), produced


def test_random_differential():
    rng = random.Random(20260930)
    checked = 0
    inconsistent = 0
    for _ in range(400):
        s = random_spec(rng)
        r = analyze(s)
        checked += 1
        if r["status"] == INCONSISTENT:
            inconsistent += 1
            ev = r["evidence"]
            # 两条路径消费同一输入串
            in1, out1 = replay(s, [x["id"] for x in ev["paths"][0]])
            in2, out2 = replay(s, [x["id"] for x in ev["paths"][1]])
            assert in1 == in2 == ev["input"]
            assert out1 == ev["outputs"][0] and out2 == ev["outputs"][1]
            assert out1 != out2
            # 若全局最优证人落在枚举界内，裁决键必须与独立枚举完全一致
            steps = max(len(ev["paths"][0]), len(ev["paths"][1]))
            if len(ev["input"]) <= LIMIT and steps <= LIMIT + 2 * len(s["states"]):
                found = enumerate_conflict(s)
                if found != "skip":
                    assert found is not None, "枚举漏掉精确算法给出的短证人"
                    exact_key = (
                        len(ev["input"]),
                        ev["input"],
                        tuple(x["id"] for x in ev["paths"][0]),
                        tuple(x["id"] for x in ev["paths"][1]),
                    )
                    assert found[0] == exact_key, (
                        "裁决序不一致：精确 %r vs 枚举 %r；spec=%s"
                        % (exact_key, found[0], s)
                    )
        else:
            assert r["status"] == CONSISTENT
            found = enumerate_conflict(s)
            if found != "skip":
                assert found is None, (
                    "精确算法判一致，但枚举发现冲突：%s -> %s" % (found, s)
                )
    assert checked == 400
    assert inconsistent > 30  # 确保样本中确实覆盖了大量反例
