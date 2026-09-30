import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { AuditStore } from '../src/store.mjs';

let server, base, dataDir;

function listen() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'audit-'));
  const store = new AuditStore(join(dataDir, 'audits.json'));
  server = createApp({ store });
  const port = await listen();
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const demoSpec = () => ({
  auditId: 'EPS-DUAL',
  alphabetRaw: 'a b',
  statesRaw: 'q0 q1 q2',
  initialState: 'q0',
  acceptingStatesRaw: 'q2',
  transitions: [
    { id: 't1', from: 'q0', to: 'q1', input: 'a', output: 'A' },
    { id: 't2', from: 'q1', to: 'q2', input: '', output: 'BC' },
    { id: 't3', from: 'q0', to: 'q1', input: '', output: 'X' },
    { id: 't4', from: 'q1', to: 'q2', input: 'a', output: 'Y' },
  ],
});

describe('HTTP API', () => {
  test('health endpoint reflects service state', async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.status, 'ok');
    assert.equal(typeof d.persisted, 'number');
    assert.equal(d.page, true);
  });

  test('page is served', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.ok(t.includes('功能一致性审计'));
  });

  test('submit epsilon dual-output counterexample and persist it', async () => {
    const r = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(demoSpec()),
    });
    assert.equal(r.status, 201);
    const rec = await r.json();
    assert.equal(rec.auditId, 'EPS-DUAL');
    assert.equal(rec.result.functional, false);
    assert.equal(rec.result.witness.input, 'a');
    assert.notEqual(rec.result.witness.output1, rec.result.witness.output2);
    assert.ok(rec.result.witness.path1.some((s) => s.consumed === 'ε'));
  });

  test('same id + same payload replays the frozen conclusion', async () => {
    const r = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(demoSpec()),
    });
    assert.equal(r.status, 200);
    const rec = await r.json();
    assert.equal(rec.replayed, true);
    assert.equal(rec.result.functional, false);
  });

  test('same id + changed payload is rejected with 409', async () => {
    const changed = demoSpec();
    changed.transitions[0].output = 'Z';
    const r = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changed),
    });
    assert.equal(r.status, 409);
    const d = await r.json();
    assert.equal(d.error.code, 'AUDIT_ID_CONFLICT');
  });

  test('reopen persisted audit by id', async () => {
    const r = await fetch(`${base}/api/audits/EPS-DUAL`);
    assert.equal(r.status, 200);
    const rec = await r.json();
    assert.equal(rec.result.witness.input, 'a');
    assert.equal(rec.spec.states.length, 3);
  });

  test('unknown id -> 404', async () => {
    const r = await fetch(`${base}/api/audits/NOPE`);
    assert.equal(r.status, 404);
  });

  test('invalid spec lists all errors with 422 and is not persisted', async () => {
    const r = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auditId: 'bad!',
        alphabetRaw: 'a ε',
        statesRaw: 'q0 q0',
        initialState: '',
        acceptingStatesRaw: '',
        transitions: [{ id: 't1', from: 'qz', to: 'q0', input: 'z', output: 'ABC' }],
      }),
    });
    assert.equal(r.status, 422);
    const d = await r.json();
    assert.ok(d.error.errors.length >= 5);
    const codes = d.error.errors.map((e) => e.code);
    assert.ok(codes.includes('ACCEPT_EMPTY'));
    assert.ok(codes.includes('INPUT_UNKNOWN'));
    assert.ok(codes.includes('OUTPUT_INVALID'));

    const list = await (await fetch(`${base}/api/audits`)).json();
    assert.ok(!list.audits.some((a) => a.auditId === 'bad!'));
  });

  test('functional transducer is persisted as functional', async () => {
    const r = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auditId: 'FUNC-1',
        alphabetRaw: 'a',
        statesRaw: 'q0 q1',
        initialState: 'q0',
        acceptingStatesRaw: 'q1',
        transitions: [{ id: 't1', from: 'q0', to: 'q1', input: 'a', output: 'OK' }],
      }),
    });
    assert.equal(r.status, 201);
    const rec = await r.json();
    assert.equal(rec.result.functional, true);
  });
});
