// Differential tests against an independent, deliberately simple oracle that
// enumerates concrete accepting paths (bounded) and against direct simulation
// of every produced witness. These guard the exactness of the lag algorithm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTransducer } from '../src/transducer.mjs';

// Independent witness verification: simulate each listed transition path
// straight from the initial state, check consumed input, emitted output,
// and that the endpoint is accepting.
function verifyWitness(spec, w) {
  const byId = new Map(spec.transitions.map((t) => [t.id, t]));
  for (const path of [w.path1, w.path2]) {
    let state = spec.initialState;
    let input = '';
    let output = '';
    for (const step of path) {
      const t = byId.get(step.transitionId);
      assert.ok(t, `transition ${step.transitionId} exists`);
      assert.equal(t.from, state, 'path is contiguous from current state');
      state = t.to;
      if (step.consumed !== 'ε') input += step.consumed;
      output += step.output;
      const rawInput = (t.input === '' || t.input === 'ε') ? 'ε' : t.input;
      assert.equal(rawInput, step.consumed);
      assert.equal(t.output, step.output);
    }
    assert.equal(input, w.input, 'path consumes the witness input');
    assert.ok(spec.acceptingStates.includes(state), 'path ends in accepting state');
    assert.equal(output, path === w.path1 ? w.output1 : w.output2);
  }
  assert.notEqual(w.output1, w.output2);
}

// Simple oracle: enumerate concrete paths up to `cap` transitions, keep those
// ending in accepting states, group by consumed input word.
function boundedOracle(spec, cap = 9, maxPaths = 200000) {
  const byId = new Map(spec.transitions.map((t) => [t.id, t]));
  const outsByInput = new Map();
  let frontier = [{ s: spec.initialState, in: '', out: '', ids: [] }];
  for (let step = 0; step <= cap && frontier.length; step++) {
    const next = [];
    for (const cur of frontier) {
      if (spec.acceptingStates.includes(cur.s) && cur.in.length <= 5) {
        if (!outsByInput.has(cur.in)) outsByInput.set(cur.in, new Set());
        outsByInput.get(cur.in).add(cur.out);
      }
      for (const t of byId.values()) {
        if (t.from !== cur.s) continue;
        const eps = t.input === '' || t.input === 'ε';
        if (!eps && cur.in.length >= 5) continue;
        next.push({
          s: t.to,
          in: cur.in + (eps ? '' : t.input),
          out: cur.out + t.output,
          ids: cur.ids.concat(t.id),
        });
      }
    }
    frontier = next;
    if (frontier.length > maxPaths) break;
  }
  let best = null;
  for (const [input, outs] of outsByInput) {
    if (outs.size < 2) continue;
    const arr = [...outs];
    if (arr.every((o) => o === arr[0])) continue;
    if (!best || input.length < best.length ||
        (input.length === best.length && input < best)) best = input;
  }
  return best;
}

// Tiny deterministic PRNG so the suite is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random differential testing: verdicts agree with bounded enumeration oracle', () => {
  const rand = mulberry32(20260930);
  const alphabet = ['a', 'b'];
  const outputChoices = ['', 'A', 'B', 'AB', 'BA'];
  let checked = 0;
  let ambiguous = 0;
  for (let trial = 0; trial < 400; trial++) {
    const nStates = 1 + Math.floor(rand() * 4);
    const states = Array.from({ length: nStates }, (_, i) => `q${i}`);
    const initial = states[0];
    const accepting = states.filter(() => rand() < 0.4);
    if (accepting.length === 0) continue;
    const nTrans = 1 + Math.floor(rand() * 9);
    const transitions = [];
    const usedIds = new Set();
    for (let i = 0; i < nTrans; i++) {
      let id;
      do { id = `r${i}-${Math.floor(rand() * 1e6)}`; } while (usedIds.has(id));
      usedIds.add(id);
      const eps = rand() < 0.4;
      transitions.push({
        id,
        from: states[Math.floor(rand() * nStates)],
        to: states[Math.floor(rand() * nStates)],
        input: eps ? '' : alphabet[Math.floor(rand() * alphabet.length)],
        output: outputChoices[Math.floor(rand() * outputChoices.length)],
      });
    }
    const spec = {
      auditId: `FUZZ-${trial}`, alphabet, states,
      initialState: initial, acceptingStates: accepting, transitions,
    };
    const r = analyzeTransducer(spec);
    assert.equal(r.status, 'ok', `trial ${trial} should analyze, got ${JSON.stringify(r.errors)}`);
    const oracleWitness = boundedOracle(spec);
    if (oracleWitness !== null) {
      assert.equal(r.functional, false, `trial ${trial}: oracle found ambiguity`);
      assert.ok(r.witness.input.length <= oracleWitness.length ||
        (r.witness.input.length === oracleWitness.length &&
         r.witness.input <= oracleWitness),
        `trial ${trial}: witness not minimal vs bounded oracle`);
      verifyWitness(spec, r.witness);
      ambiguous++;
    } else if (!r.functional) {
      // Oracle missed it (witness beyond its bound): still must be valid.
      verifyWitness(spec, r.witness);
      ambiguous++;
    }
    checked++;
  }
  assert.ok(checked >= 200, `ran enough trials: ${checked}`);
  assert.ok(ambiguous >= 20, `exercised plenty of ambiguous machines: ${ambiguous}`);
});

test('every produced witness across a fixed battery simulates correctly', () => {
  const battery = [
    { // alternate-sided lag: eps emits ahead on each side in turn
      alphabet: ['a'], states: ['q0', 'q1'], initialState: 'q0', acceptingStates: ['q1'],
      transitions: [
        { id: 'a1', from: 'q0', to: 'q1', input: 'a', output: 'AB' },
        { id: 'e1', from: 'q0', to: 'q1', input: '', output: 'A' },
        { id: 'a2', from: 'q1', to: 'q1', input: 'a', output: 'X' },
      ],
    },
    { // prefix lag resolved then forced conflict on continuation
      alphabet: ['a'], states: ['q0', 'q1'], initialState: 'q0', acceptingStates: ['q1'],
      transitions: [
        { id: 'e1', from: 'q0', to: 'q1', input: '', output: 'AB' },
        { id: 'a1', from: 'q0', to: 'q1', input: 'a', output: 'A' },
        { id: 'a2', from: 'q1', to: 'q1', input: 'a', output: 'C' },
      ],
    },
  ];
  for (const spec of battery) {
    const r = analyzeTransducer({ auditId: 'BAT', ...spec });
    assert.equal(r.functional, false);
    verifyWitness(spec, r.witness);
  }
});
