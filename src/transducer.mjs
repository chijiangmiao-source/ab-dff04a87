// Finite-state transducer functional-equivalence decision.
//
// A transducer is functional iff no input word has two accepting paths
// whose emitted output strings differ.  This is decided EXACTLY (no input
// length bound, no sampling, no finite path enumeration) using the classical
// "pair of states + output lag" construction:
//
//   * a product node is (p, q) plus a bounded lag describing output already
//     emitted by one side but not yet matched by the other;
//   * product edges consume a common input symbol on both sides, or an
//     epsilon transition on exactly one side;
//   * a lag whose two next characters differ is a permanent output fork;
//   * lag growth beyond a bound is a pumpable cycle (free-monoid pumping
//     lemma); the bound is doubled on demand until a concrete witness is
//     found, so the procedure always terminates with a precise answer.
//
// The smallest witness is selected by (input length, input ASCII order,
// path-1 transition-id sequence, path-2 transition-id sequence) via a
// lexicographic Dijkstra search.

const EPSILON = 'ε';
const MAX_STATES = 10;
const MAX_TRANSITIONS = 30;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATE_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
const SYMBOL_RE = /^[A-Za-z0-9]$/; // single printable ASCII input symbol
const OUTPUT_RE = /^[A-Z]{0,2}$/;

function isEpsilonInput(v) {
  return v === '' || v === null || v === undefined || v === EPSILON;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateTransducer(spec) {
  const errors = [];
  const push = (path, code, message) => errors.push({ path, code, message });

  if (spec === null || typeof spec !== 'object') {
    return [{ path: '', code: 'SPEC_INVALID', message: '审计规格必须是 JSON 对象' }];
  }

  const auditId = String(spec.auditId ?? '').trim();
  if (!ID_RE.test(auditId)) {
    push('auditId', 'AUDIT_ID_INVALID', '审计标识需为 1-64 位字母、数字、下划线或连字符');
  }

  // Alphabet
  const rawAlpha = Array.isArray(spec.alphabet)
    ? spec.alphabet
    : typeof spec.alphabet === 'string'
      ? spec.alphabet.split(/[\s,]+/)
      : [];
  const alphabet = [];
  const alphaSet = new Set();
  if (rawAlpha.length === 0) {
    push('alphabet', 'ALPHABET_EMPTY', '输入字母表不能为空');
  }
  for (const raw of rawAlpha) {
    const a = String(raw ?? '').trim();
    if (a === '') continue;
    if (a === EPSILON) {
      push('alphabet', 'ALPHABET_EPSILON_FORBIDDEN', '输入字母表不能包含 ε（ε 仅用于迁移）');
      continue;
    }
    if (!SYMBOL_RE.test(a)) {
      push('alphabet', 'ALPHABET_SYMBOL_INVALID', `非法输入符号：${JSON.stringify(a)}，需为单个 ASCII 字母或数字`);
      continue;
    }
    if (alphaSet.has(a)) {
      push('alphabet', 'ALPHABET_DUPLICATE', `输入字母表重复：${a}`);
      continue;
    }
    alphaSet.add(a);
    alphabet.push(a);
  }

  // States
  const rawStates = Array.isArray(spec.states)
    ? spec.states
    : typeof spec.states === 'string'
      ? spec.states.split(/[\s,]+/)
      : [];
  const states = [];
  const stateSet = new Set();
  const stateDup = new Set();
  if (rawStates.filter((s) => String(s ?? '').trim() !== '').length === 0) {
    push('states', 'STATES_EMPTY', '状态集合不能为空');
  }
  if (rawStates.length > MAX_STATES) {
    push('states', 'STATES_LIMIT', `状态数 ${rawStates.length} 超过上限 ${MAX_STATES}`);
  }
  for (const raw of rawStates) {
    const s = String(raw ?? '').trim();
    if (s === '') continue;
    if (!STATE_RE.test(s)) {
      push('states', 'STATE_ID_INVALID', `非法状态标识：${JSON.stringify(s)}`);
      continue;
    }
    if (stateSet.has(s)) {
      if (!stateDup.has(s)) {
        stateDup.add(s);
        push('states', 'STATES_DUPLICATE', `重复状态：${s}`);
      }
      continue;
    }
    stateSet.add(s);
    states.push(s);
  }

  // Initial state
  const initialState = String(spec.initialState ?? '').trim();
  if (initialState === '') {
    push('initialState', 'INITIAL_MISSING', '必须指定初态');
  } else if (!stateSet.has(initialState)) {
    push('initialState', 'INITIAL_UNKNOWN', `初态不在状态集合中：${initialState}`);
  }

  // Accepting states
  const rawAccept = Array.isArray(spec.acceptingStates)
    ? spec.acceptingStates
    : typeof spec.acceptingStates === 'string'
      ? spec.acceptingStates.split(/[\s,]+/)
      : [];
  const acceptingStates = [];
  const acceptSet = new Set();
  const acceptVals = rawAccept.map((s) => String(s ?? '').trim()).filter((s) => s !== '');
  if (acceptVals.length === 0) {
    push('acceptingStates', 'ACCEPT_EMPTY', '接受态集合不能为空');
  }
  for (const s of acceptVals) {
    if (!stateSet.has(s)) {
      push('acceptingStates', 'ACCEPT_UNKNOWN', `接受态不在状态集合中：${s}`);
      continue;
    }
    if (!acceptSet.has(s)) {
      acceptSet.add(s);
      acceptingStates.push(s);
    }
  }

  // Transitions
  const rawTrans = Array.isArray(spec.transitions) ? spec.transitions : [];
  if (rawTrans.length > MAX_TRANSITIONS) {
    push('transitions', 'TRANSITIONS_LIMIT', `迁移数 ${rawTrans.length} 超过上限 ${MAX_TRANSITIONS}`);
  }
  const transIdSet = new Set();
  const transitions = [];
  rawTrans.forEach((raw0, i) => {
    const p = `transitions[${i}]`;
    const raw = raw0 === null || typeof raw0 !== 'object' ? {} : raw0;
    const id = String(raw.id ?? '').trim();
    const from = String(raw.from ?? '').trim();
    const to = String(raw.to ?? '').trim();
    const inputRaw = raw.input === undefined || raw.input === null ? '' : String(raw.input).trim();
    const output = String(raw.output ?? '').toUpperCase();

    if (id === '') {
      push(`${p}.id`, 'TRANSITION_ID_MISSING', `第 ${i + 1} 条迁移缺少标识`);
    } else if (!ID_RE.test(id)) {
      push(`${p}.id`, 'TRANSITION_ID_INVALID', `非法迁移标识：${JSON.stringify(id)}`);
    } else if (transIdSet.has(id)) {
      push(`${p}.id`, 'TRANSITION_ID_DUPLICATE', `迁移标识重复：${id}`);
    } else {
      transIdSet.add(id);
    }

    if (from === '') {
      push(`${p}.from`, 'TRANSITION_ENDPOINT_MISSING', `迁移 ${id || i + 1} 缺少源状态`);
    } else if (!stateSet.has(from)) {
      push(`${p}.from`, 'TRANSITION_ENDPOINT_DANGLING', `迁移 ${id || i + 1} 的源状态悬空：${from}`);
    }
    if (to === '') {
      push(`${p}.to`, 'TRANSITION_ENDPOINT_MISSING', `迁移 ${id || i + 1} 缺少目标状态`);
    } else if (!stateSet.has(to)) {
      push(`${p}.to`, 'TRANSITION_ENDPOINT_DANGLING', `迁移 ${id || i + 1} 的目标状态悬空：${to}`);
    }

    if (isEpsilonInput(inputRaw)) {
      // valid epsilon spelling
    } else if (inputRaw.includes(EPSILON)) {
      push(`${p}.input`, 'INVALID_EPSILON', `迁移 ${id || i + 1} 的 ε 写法非法：${JSON.stringify(inputRaw)}，留空或仅填写 ε`);
    } else if (inputRaw.length !== 1 || !SYMBOL_RE.test(inputRaw)) {
      push(`${p}.input`, 'INPUT_SYMBOL_INVALID', `迁移 ${id || i + 1} 的输入非法：${JSON.stringify(inputRaw)}，需为单个 ASCII 字母/数字或 ε`);
    } else if (!alphaSet.has(inputRaw)) {
      push(`${p}.input`, 'INPUT_UNKNOWN', `迁移 ${id || i + 1} 消费了字母表外的符号：${inputRaw}`);
    }

    if (!OUTPUT_RE.test(output)) {
      push(`${p}.output`, 'OUTPUT_INVALID', `迁移 ${id || i + 1} 的输出非法：${JSON.stringify(output)}，需为 0-2 个大写 ASCII 字符`);
    }

    if (id !== '' && from !== '' && to !== '' && transIdSet.has(id)) {
      transitions.push({
        id, from, to,
        epsilon: isEpsilonInput(inputRaw),
        input: isEpsilonInput(inputRaw) ? '' : inputRaw,
        output,
      });
    }
  });

  errors.sort((a, b) =>
    (a.path + '' + a.code + '' + a.message).localeCompare(
      b.path + '' + b.code + '' + b.message,
    ));
  return errors;
}

// ---------------------------------------------------------------------------
// Small binary heap keyed by lexicographic witness order
// key = [inputLength, inputString, ids1[], ids2[]]
// ---------------------------------------------------------------------------

function cmpSeq(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function cmpKey(a, b) {
  if (a.len !== b.len) return a.len - b.len;
  if (a.input !== b.input) return a.input < b.input ? -1 : 1;
  const c1 = cmpSeq(a.ids1, b.ids1);
  if (c1 !== 0) return c1;
  return cmpSeq(a.ids2, b.ids2);
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(key, val) {
    const a = this.a;
    a.push({ key, val });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmpKey(a[p].key, a[i].key) <= 0) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && cmpKey(a[l].key, a[m].key) < 0) m = l;
        if (r < a.length && cmpKey(a[r].key, a[m].key) < 0) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.val;
  }
}

// ---------------------------------------------------------------------------
// Lag reduction.
// side 0: outputs aligned, lag empty
// side 1: left path is ahead by `lag`
// side 2: right path is ahead by `lag`
// Returns {status:'ok', side, lag} or {status:'conflict'}
// ---------------------------------------------------------------------------

function reduceLag(side, lag, addLeft, addRight, bound) {
  let x, y;
  if (side === 0) { x = addLeft; y = addRight; }
  else if (side === 1) { x = lag + addLeft; y = addRight; }
  else { x = addLeft; y = lag + addRight; }

  const kMax = Math.min(x.length, y.length);
  let k = 0;
  while (k < kMax && x[k] === y[k]) k++;
  x = x.slice(k);
  y = y.slice(k);

  if (x !== '' && y !== '') return { status: 'conflict' };
  if (x !== '') {
    if (x.length > bound) return { status: 'overflow' };
    return { status: 'ok', side: 1, lag: x };
  }
  if (y !== '') {
    if (y.length > bound) return { status: 'overflow' };
    return { status: 'ok', side: 2, lag: y };
  }
  return { status: 'ok', side: 0, lag: '' };
}

const nodeKey = (p, q, side, lag) => `${p} ${q} ${side} ${lag}`;

// Turn a concrete list of product edges into the API witness shape.
function buildWitness(edgePath) {
  const path1 = [];
  const path2 = [];
  let input = '';
  let output1 = '';
  let output2 = '';
  for (const e of edgePath) {
    if (e.kind === 'sym') {
      input += e.sym;
      output1 += e.t1.output;
      output2 += e.t2.output;
      path1.push({ transitionId: e.t1.id, consumed: e.sym, output: e.t1.output });
      path2.push({ transitionId: e.t2.id, consumed: e.sym, output: e.t2.output });
    } else if (e.kind === 'epsL') {
      output1 += e.t1.output;
      path1.push({ transitionId: e.t1.id, consumed: EPSILON, output: e.t1.output });
    } else {
      output2 += e.t2.output;
      path2.push({ transitionId: e.t2.id, consumed: EPSILON, output: e.t2.output });
    }
  }
  return { input, path1, path2, output1, output2 };
}

// ---------------------------------------------------------------------------
// Main decision procedure
// ---------------------------------------------------------------------------

export function analyzeTransducer(spec) {
  const errors = validateTransducer(spec);
  if (errors.length > 0) return { status: 'invalid', errors };

  const alphabet = [...new Set(spec.alphabet.map((a) => String(a).trim()))].sort();
  const states = [...new Set(spec.states.map((a) => String(a).trim()))];
  const accept = new Set(spec.acceptingStates.map((a) => String(a).trim()));
  const initial = String(spec.initialState).trim();
  const transitions = spec.transitions.map((t) => ({
    id: String(t.id).trim(),
    from: String(t.from).trim(),
    to: String(t.to).trim(),
    epsilon: isEpsilonInput(t.input),
    input: isEpsilonInput(t.input) ? '' : String(t.input).trim(),
    output: String(t.output ?? '').toUpperCase(),
  }));

  const maxOut = transitions.reduce((m, t) => Math.max(m, t.output.length), 0);
  if (maxOut === 0) {
    // Every accepting path emits the empty word: functional by inspection.
    return { status: 'ok', functional: true, witness: null };
  }

  const epsOut = new Map(states.map((s) => [s, []]));
  const symOut = new Map(states.map((s) => [s, new Map()]));
  for (const t of transitions) {
    if (t.epsilon) epsOut.get(t.from).push(t);
    else {
      if (!symOut.get(t.from).has(t.input)) symOut.get(t.from).set(t.input, []);
      symOut.get(t.from).get(t.input).push(t);
    }
  }

  // Output-agnostic product graph, and pairs that can reach an accepting pair.
  const pairEdges = new Map();
  const reverse = new Map();
  const allPairs = [];
  for (const p of states) for (const q of states) allPairs.push(`${p} ${q}`);
  const edgesOf = (p, q) => {
    const key = `${p} ${q}`;
    let edges = pairEdges.get(key);
    if (edges) return edges;
    edges = [];
    for (const t of epsOut.get(p)) edges.push({ kind: 'epsL', t1: t });
    for (const t of epsOut.get(q)) edges.push({ kind: 'epsR', t2: t });
    for (const a of alphabet) {
      const A = symOut.get(p).get(a);
      const B = symOut.get(q).get(a);
      if (A && B) for (const t1 of A) for (const t2 of B) edges.push({ kind: 'sym', sym: a, t1, t2 });
    }
    pairEdges.set(key, edges);
    return edges;
  };
  for (const pk of allPairs) {
    const [p, q] = pk.split(' ');
    for (const e of edgesOf(p, q)) {
      const np = e.kind === 'epsR' ? p : e.t1.to;
      const nq = e.kind === 'epsL' ? q : e.t2.to;
      const nk = `${np} ${nq}`;
      if (!reverse.has(nk)) reverse.set(nk, []);
      reverse.get(nk).push(pk);
    }
  }
  const canReachAccept = new Set();
  {
    const queue = [];
    for (const pk of allPairs) {
      const [p, q] = pk.split(' ');
      if (accept.has(p) && accept.has(q)) { canReachAccept.add(pk); queue.push(pk); }
    }
    while (queue.length) {
      const pk = queue.shift();
      for (const pred of reverse.get(pk) ?? []) {
        if (!canReachAccept.has(pred)) { canReachAccept.add(pred); queue.push(pred); }
      }
    }
  }

  // Best-first continuation from a conflict pair to any accepting pair,
  // ignoring outputs (the output fork is already irreconcilable).
  const continuationToAccept = (rp, rq) => {
    const start = `${rp} ${rq}`;
    if (accept.has(rp) && accept.has(rq)) return [];
    const heap = new Heap();
    const info = new Map();
    const startKey = { len: 0, input: '', ids1: [], ids2: [] };
    info.set(start, { key: startKey, edge: null, prev: null });
    heap.push(startKey, start);
    while (heap.size) {
      const pk = heap.pop();
      const cur = info.get(pk);
      const [p, q] = pk.split(' ');
      if (accept.has(p) && accept.has(q)) {
        const es = [];
        let n = pk;
        while (info.get(n).prev) {
          const c = info.get(n);
          es.push(c.edge);
          n = c.prev;
        }
        return es.reverse();
      }
      for (const e of edgesOf(p, q)) {
        const np = e.kind === 'epsR' ? p : e.t1.to;
        const nq = e.kind === 'epsL' ? q : e.t2.to;
        const nk = `${np} ${nq}`;
        const key = {
          len: cur.key.len + (e.kind === 'sym' ? 1 : 0),
          input: cur.key.input + (e.kind === 'sym' ? e.sym : ''),
          ids1: cur.key.ids1.concat(e.kind === 'epsR' ? [] : [e.t1.id]),
          ids2: cur.key.ids2.concat(e.kind === 'epsL' ? [] : [e.t2.id]),
        };
        const old = info.get(nk);
        if (!old || cmpKey(key, old.key) < 0) {
          info.set(nk, { key, edge: e, prev: pk });
          heap.push(key, nk);
        }
      }
    }
    return null; // unreachable (caller guards)
  };

  // Iterative lag-deepening Dijkstra.
  let bound = 2 * maxOut;
  let bestWitness = null;
  for (let iteration = 0; iteration < 64; iteration++) {
    bestWitness = null;
    let growth = false;

    const heap = new Heap();
    const settled = new Set();
    const best = new Map();
    const startPair = `${initial} ${initial}`;
    if (!canReachAccept.has(startPair)) {
      // No accepting computation exists at all: uniqueness is vacuous.
      return { status: 'ok', functional: true, witness: null };
    }
    const startKey = { len: 0, input: '', ids1: [], ids2: [] };
    best.set(nodeKey(initial, initial, 0, ''), {
      key: startKey, p: initial, q: initial, side: 0, lag: '',
      edge: null, prev: null,
    });
    heap.push(startKey, nodeKey(initial, initial, 0, ''));

    const considerWitness = (edgeList, key) => {
      const w = buildWitness(edgeList);
      if (w.output1 === w.output2) return; // defensive
      if (!bestWitness || cmpKey(key, bestWitness.key) < 0) {
        bestWitness = { key, witness: w };
      }
    };

    while (heap.size) {
      const nk = heap.pop();
      if (settled.has(nk)) continue;
      const node = best.get(nk);
      settled.add(nk);

      // Edge path reconstruction (chains are short at these problem sizes).
      const pathEdges = [];
      for (let c = node; c.prev; c = best.get(c.prev)) pathEdges.push(c.edge);
      pathEdges.reverse();

      if (accept.has(node.p) && accept.has(node.q) && node.lag !== '') {
        considerWitness(pathEdges, node.key);
      }

      for (const e of edgesOf(node.p, node.q)) {
        const addL = e.kind === 'epsR' ? '' : e.t1.output;
        const addR = e.kind === 'epsL' ? '' : e.t2.output;
        const red = reduceLag(node.side, node.lag, addL, addR, bound);
        const np = e.kind === 'epsR' ? node.p : e.t1.to;
        const nq = e.kind === 'epsL' ? node.q : e.t2.to;
        const pairK = `${np} ${nq}`;
        if (!canReachAccept.has(pairK)) continue;

        if (red.status === 'conflict') {
          const cont = continuationToAccept(np, nq);
          if (cont) {
            const edges = pathEdges.concat(e).concat(cont);
            let k = node.key;
            k = {
              len: k.len + (e.kind === 'sym' ? 1 : 0) + cont.reduce((m, x) => m + (x.kind === 'sym' ? 1 : 0), 0),
              input: k.input + (e.kind === 'sym' ? e.sym : '') + cont.map((x) => (x.kind === 'sym' ? x.sym : '')).join(''),
              ids1: k.ids1.concat(e.kind === 'epsR' ? [] : [e.t1.id]).concat(cont.flatMap((x) => (x.kind === 'epsR' ? [] : [x.t1.id]))),
              ids2: k.ids2.concat(e.kind === 'epsL' ? [] : [e.t2.id]).concat(cont.flatMap((x) => (x.kind === 'epsL' ? [] : [x.t2.id]))),
            };
            considerWitness(edges, k);
          }
          continue;
        }

        if (red.status === 'overflow') {
          growth = true; // pumpable lag; deepening produces a concrete witness
          continue;
        }

        const childKey = nodeKey(np, nq, red.side, red.lag);
        const key = {
          len: node.key.len + (e.kind === 'sym' ? 1 : 0),
          input: node.key.input + (e.kind === 'sym' ? e.sym : ''),
          ids1: node.key.ids1.concat(e.kind === 'epsR' ? [] : [e.t1.id]),
          ids2: node.key.ids2.concat(e.kind === 'epsL' ? [] : [e.t2.id]),
        };
        const old = best.get(childKey);
        if (!settled.has(childKey) && (!old || cmpKey(key, old.key) < 0)) {
          best.set(childKey, {
            key, p: np, q: nq, side: red.side, lag: red.lag, edge: e, prev: nk,
          });
          heap.push(key, childKey);
        }
      }
    }

    if (bestWitness) {
      return { status: 'ok', functional: false, witness: bestWitness.witness };
    }
    if (!growth) {
      return { status: 'ok', functional: true, witness: null };
    }
    bound *= 2; // lag exceeded the bound on an accepting-reaching alignment
  }

  // Unreachable in practice for the configured problem limits.
  return { status: 'error', errors: [{ path: '', code: 'ANALYSIS_NONTERMINATING', message: '分析未能在有限深度内终止' }] };
}
