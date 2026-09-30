import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTransducer, validateTransducer } from '../src/transducer.mjs';

const base = (over = {}) => ({
  auditId: 'A1',
  alphabet: ['a', 'b'],
  states: ['q0', 'q1'],
  initialState: 'q0',
  acceptingStates: ['q1'],
  transitions: [],
  ...over,
});

test('deterministic transducer is functional', () => {
  const r = analyzeTransducer(base({
    states: ['q0', 'q1'],
    acceptingStates: ['q1'],
    transitions: [
      { id: 't1', from: 'q0', to: 'q1', input: 'a', output: 'X' },
      { id: 't2', from: 'q1', to: 'q1', input: 'b', output: 'Y' },
    ],
  }));
  assert.equal(r.status, 'ok');
  assert.equal(r.functional, true);
  assert.equal(r.witness, null);
});

test('two symbol transitions with different outputs on same input -> counterexample', () => {
  const r = analyzeTransducer(base({
    transitions: [
      { id: 'ta', from: 'q0', to: 'q1', input: 'a', output: 'A' },
      { id: 'tb', from: 'q0', to: 'q1', input: 'a', output: 'B' },
    ],
  }));
  assert.equal(r.functional, false);
  const w = r.witness;
  assert.equal(w.input, 'a');
  assert.equal(w.output1, 'A');
  assert.equal(w.output2, 'B');
});

test('epsilon + two-character outputs dual-path counterexample (acceptance fixture)', () => {
  // input "a":
  //   path A: t3 (eps/X) then t4 (a/Y)        => "XY"
  //   path B: t1 (a/A)  then t2 (eps/BC)      => "ABC"
  const r = analyzeTransducer(base({
    auditId: 'DEMO-EPS-DUAL-OUTPUT',
    states: ['q0', 'q1', 'q2'],
    acceptingStates: ['q2'],
    transitions: [
      { id: 't1', from: 'q0', to: 'q1', input: 'a', output: 'A' },
      { id: 't2', from: 'q1', to: 'q2', input: '', output: 'BC' },
      { id: 't3', from: 'q0', to: 'q1', input: '', output: 'X' },
      { id: 't4', from: 'q1', to: 'q2', input: 'a', output: 'Y' },
    ],
  }));
  assert.equal(r.status, 'ok');
  assert.equal(r.functional, false);
  const w = r.witness;
  assert.equal(w.input, 'a');
  assert.notEqual(w.output1, w.output2);
  const joined = w.output1 + w.output2;
  assert.ok(joined.includes('BC'), 'witness must carry a two-character output chunk');
  assert.ok(
    w.path1.some((s) => s.consumed === 'ε') && w.path2.some((s) => s.consumed === 'ε'),
    'both paths must traverse an epsilon transition',
  );
  // consumed symbols concatenate (ignoring epsilons) to the witness input
  for (const p of [w.path1, w.path2]) {
    assert.equal(p.filter((s) => s.consumed !== 'ε').map((s) => s.consumed).join(''), w.input);
  }
});

test('epsilon reordering with EQUAL outputs is functional', () => {
  // input "a": eps/A then a/eps  ==  a/A
  const r = analyzeTransducer(base({
    states: ['q0', 'q1', 'q2'],
    acceptingStates: ['q2'],
    transitions: [
      { id: 't1', from: 'q0', to: 'q2', input: 'a', output: 'A' },
      { id: 't2', from: 'q0', to: 'q1', input: '', output: 'A' },
      { id: 't3', from: 'q1', to: 'q2', input: 'a', output: '' },
    ],
  }));
  assert.equal(r.functional, true);
});

test('empty-output epsilon self-loop: infinitely many paths, still functional (exact, no enumeration)', () => {
  const r = analyzeTransducer(base({
    transitions: [
      { id: 'loop', from: 'q0', to: 'q0', input: '', output: '' },
      { id: 'go', from: 'q0', to: 'q1', input: 'a', output: '' },
    ],
  }));
  assert.equal(r.functional, true);
});

test('pumpable epsilon loop that emits output is detected without length bounds', () => {
  // q0 -eps/A-> q0 (loop), q0 -a/eps-> q1 ; input "a" has outputs A^k vs empty.
  const r = analyzeTransducer(base({
    transitions: [
      { id: 'pump', from: 'q0', to: 'q0', input: '', output: 'A' },
      { id: 'go', from: 'q0', to: 'q1', input: 'a', output: '' },
    ],
  }));
  assert.equal(r.functional, false);
  assert.equal(r.witness.input, 'a');
  assert.notEqual(r.witness.output1, r.witness.output2);
});

test('fork hidden behind arbitrarily many iterations is found exactly (pumping)', () => {
  // Two loops at q0: eps emits "A" on one path, eps emits "" on another,
  // then a/eps -> q1. Divergence exists for every pumping length.
  const r = analyzeTransducer(base({
    transitions: [
      { id: 'l1', from: 'q0', to: 'q0', input: '', output: 'A' },
      { id: 'l2', from: 'q0', to: 'q0', input: '', output: '' },
      { id: 'go', from: 'q0', to: 'q1', input: 'a', output: '' },
    ],
  }));
  assert.equal(r.functional, false);
  assert.equal(r.witness.input, 'a');
});

test('no accepting computation: vacuously functional', () => {
  const r = analyzeTransducer(base({
    transitions: [
      { id: 't1', from: 'q0', to: 'q0', input: 'a', output: 'A' },
      { id: 't2', from: 'q0', to: 'q0', input: 'a', output: 'B' },
    ],
  }));
  // q1 unreachable: ambiguity never reaches an accepting pair.
  assert.equal(r.functional, true);
});

test('witness ordering: shortest input wins, then ASCII order', () => {
  // ambiguity on "b" (length1) and on "aa" (length2) -> must pick "b"
  const r = analyzeTransducer(base({
    states: ['q0', 'q1'],
    acceptingStates: ['q1', 'q0'],
    transitions: [
      { id: 'x1', from: 'q0', to: 'q1', input: 'a', output: 'A' },
      { id: 'x2', from: 'q0', to: 'q1', input: 'a', output: 'B' },
      { id: 'y1', from: 'q0', to: 'q0', input: 'b', output: 'C' },
      { id: 'y2', from: 'q0', to: 'q0', input: 'b', output: 'D' },
    ],
  }));
  assert.equal(r.functional, false);
  assert.equal(r.witness.input, 'a'); // length 1 tie: ASCII a < b
});

test('all validation problems are reported at once', () => {
  const errors = validateTransducer({
    auditId: 'bad id!',
    alphabet: ['a', 'a', 'ε', '??'],
    states: ['q0', 'q0', 'q1'],
    initialState: 'qx',
    acceptingStates: [],
    transitions: [
      { id: 't1', from: 'q0', to: 'qz', input: 'c', output: 'abc' },
      { id: 't2', from: 'qy', to: 'q1', input: 'εx', output: '1' },
    ],
  });
  const codes = errors.map((e) => e.code);
  for (const c of [
    'AUDIT_ID_INVALID',
    'ALPHABET_DUPLICATE',
    'ALPHABET_EPSILON_FORBIDDEN',
    'ALPHABET_SYMBOL_INVALID',
    'STATES_DUPLICATE',
    'INITIAL_UNKNOWN',
    'ACCEPT_EMPTY',
    'TRANSITION_ENDPOINT_DANGLING',
    'INVALID_EPSILON',
    'INPUT_UNKNOWN',
    'OUTPUT_INVALID',
  ]) {
    assert.ok(codes.includes(c), `expected error code ${c}, got ${codes.join(',')}`);
  }
});

test('limits: >10 states and >30 transitions are flagged', () => {
  const states = Array.from({ length: 11 }, (_, i) => `s${i}`);
  const transitions = Array.from({ length: 31 }, (_, i) => ({
    id: `tr${i}`, from: 's0', to: 's0', input: 'a', output: '',
  }));
  const errors = validateTransducer(base({
    states, acceptingStates: ['s0'], transitions,
  }));
  assert.ok(errors.some((e) => e.code === 'STATES_LIMIT'));
  assert.ok(errors.some((e) => e.code === 'TRANSITIONS_LIMIT'));
});

test('outputs of length up to two uppercase ASCII are accepted', () => {
  const errors = validateTransducer(base({
    transitions: [
      { id: 't0', from: 'q0', to: 'q1', input: 'a', output: '' },
      { id: 't1', from: 'q0', to: 'q1', input: 'b', output: 'Z' },
      { id: 't2', from: 'q0', to: 'q1', input: 'a', output: 'AB' },
    ],
  }));
  assert.deepEqual(errors, []);
});

test('valid epsilon spellings: empty string and ε', () => {
  const errors = validateTransducer(base({
    transitions: [
      { id: 't1', from: 'q0', to: 'q1', input: '', output: '' },
      { id: 't2', from: 'q1', to: 'q1', input: 'ε', output: 'A' },
    ],
  }));
  assert.deepEqual(errors, []);
});
