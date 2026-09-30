#!/usr/bin/env node
// Single-command acceptance:
//   1. code tests (node --test)
//   2. container image build + compose up        (skipped with LOCAL=1)
//   3. HTTP smoke on an epsilon + dual-output counterexample
//   4. exit code 0 only if every stage passes
//
// Environment:
//   HOST_PORT  host port published by compose (default 8080)
//   KEEP_UP=1  leave the compose stack running after the run
//   LOCAL=1    skip docker; smoke against a locally spawned node process

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_PORT = Number(process.env.HOST_PORT || process.env.PORT || 8080);
const LOCAL = process.env.LOCAL === '1';
const KEEP_UP = process.env.KEEP_UP === '1';
const AUDIT_ID = `VERIFY-EPS-DUAL-${Date.now()}`;

const results = [];
const report = (stage, ok, detail = '') => {
  results.push({ stage, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail ? ` — ${detail}` : ''}`);
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: false, ...opts });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(base, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.status === 200) return await r.json();
    } catch (e) { lastErr = e; }
    await sleep(700);
  }
  throw new Error(`service did not become healthy in ${timeoutMs}ms (${lastErr?.message ?? 'no /health'})`);
}

function demoSpec() {
  return {
    auditId: AUDIT_ID,
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
  };
}

async function smoke(base) {
  // 1. health reflects page state
  {
    const r = await fetch(`${base}/health`);
    const d = await r.json();
    if (r.status !== 200 || d.status !== 'ok' || d.page !== true) {
      throw new Error(`bad health payload: ${JSON.stringify(d)}`);
    }
    report('health check reports ok with page present', true);
  }

  // 2. page is reachable
  {
    const r = await fetch(`${base}/`);
    const t = await r.text();
    if (r.status !== 200 || !t.includes('功能一致性审计')) throw new Error('page missing');
    report('audit page served', true);
  }

  // 3. submit epsilon + two-char-output ambiguity
  const spec = demoSpec();
  let created;
  {
    const r = await fetch(`${base}/api/audits`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    });
    created = await r.json();
    if (r.status !== 201) throw new Error(`expected 201, got ${r.status}: ${JSON.stringify(created)}`);
    const w = created.result.witness;
    const epsBoth = w.path1.some((s) => s.consumed === 'ε') &&
                    w.path2.some((s) => s.consumed === 'ε');
    const dual = w.path1.concat(w.path2).some((s) => s.output.length === 2);
    const simOk = simulate(spec, w);
    if (created.result.functional !== false || w.input !== 'a' ||
        w.output1 === w.output2 || !epsBoth || !dual || !simOk) {
      throw new Error(`counterexample assertions failed: ${JSON.stringify(w)}`);
    }
    report('counterexample (ε transitions + two-char outputs) detected and verified',
      true, `"${w.input}" -> "${w.output1}" vs "${w.output2}"`);
  }

  // 4. same id + same payload replays frozen conclusion
  {
    const r = await fetch(`${base}/api/audits`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    });
    const d = await r.json();
    if (r.status !== 200 || d.replayed !== true) {
      throw new Error(`expected frozen replay 200 replayed=true, got ${r.status}`);
    }
    report('identical retransmission replays frozen conclusion', true);
  }

  // 5. same id + changed payload rejected
  {
    const changed = structuredClone(spec);
    changed.transitions[0].output = 'Z';
    const r = await fetch(`${base}/api/audits`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changed),
    });
    const d = await r.json();
    if (r.status !== 409 || d.error.code !== 'AUDIT_ID_CONFLICT') {
      throw new Error(`expected 409 conflict, got ${r.status}`);
    }
    report('same id with changed payload rejected (409)', true);
  }

  // 6. reopen persisted audit
  {
    const r = await fetch(`${base}/api/audits/${encodeURIComponent(AUDIT_ID)}`);
    const d = await r.json();
    if (r.status !== 200 || d.result.witness.input !== 'a') {
      throw new Error(`reopen failed: ${r.status}`);
    }
    report('persisted audit reopened by id', true);
  }

  // 7. invalid spec reports multiple errors at once
  {
    const r = await fetch(`${base}/api/audits`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auditId: 'bad!', alphabetRaw: 'a ε', statesRaw: 'q0 q0',
        initialState: '', acceptingStatesRaw: '',
        transitions: [{ id: 'x', from: 'qz', to: 'q0', input: 'z', output: 'ABC' }],
      }),
    });
    const d = await r.json();
    if (r.status !== 422 || d.error.errors.length < 5) {
      throw new Error(`expected aggregated 422 errors, got ${r.status}`);
    }
    report('invalid spec reports all problems at once (422)', true, `${d.error.errors.length} errors`);
  }
}

// Independent direct simulation of the witness (same logic as the test suite).
function simulate(spec, w) {
  const byId = new Map(spec.transitions.map((t) => [t.id, t]));
  for (const path of [w.path1, w.path2]) {
    let state = spec.initialState, input = '', output = '';
    for (const step of path) {
      const t = byId.get(step.transitionId);
      if (!t || t.from !== state) return false;
      state = t.to;
      if (step.consumed !== 'ε') input += step.consumed;
      output += step.output;
    }
    if (input !== w.input) return false;
    if (!spec.acceptingStatesRaw.split(/[\s,]+/).includes(state)) return false;
    if (output !== (path === w.path1 ? w.output1 : w.output2)) return false;
  }
  return w.output1 !== w.output2;
}

function detectCompose() {
  for (const [cmd, args] of [['docker', ['compose', 'version']], ['docker-compose', ['version']]]) {
    const r = runCapture(cmd, args);
    if (r.status === 0) return { cmd, sub: cmd === 'docker' ? ['compose'] : [] };
  }
  return null;
}

async function main() {
  console.log(`== transducer-audit verify (${LOCAL ? 'local process' : 'docker compose'}) ==`);

  // Stage 1: code tests
  try {
    const code = run(process.execPath, ['--test', 'test/transducer.test.mjs',
      'test/differential.test.mjs', 'test/api.test.mjs']);
    report('code tests', code === 0, code === 0 ? 'all suites passed' : `exit ${code}`);
    if (code !== 0) return finish(1);
  } catch (e) {
    report('code tests', false, e.message);
    return finish(1);
  }

  let base;
  let cleanup = async () => {};

  if (LOCAL) {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'));
    const port = 60000 + Math.floor(Math.random() * 5000);
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_FILE: join(dir, 'audits.json') },
      stdio: 'ignore',
    });
    base = `http://127.0.0.1:${port}`;
    cleanup = async () => { child.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); };
  } else {
    // Stage 2: image build + compose up
    const compose = detectCompose();
    if (!compose) {
      report('docker availability', false, 'docker / docker compose not found (use LOCAL=1 for local smoke)');
      return finish(1);
    }
    const cc = (subArgs) => run(compose.cmd, [...compose.sub, ...subArgs]);

    try {
      const b = cc(['build']);
      report('container image build', b === 0);
      if (b !== 0) return finish(1);

      const u = cc(['up', '-d']);
      report('compose stack up', u === 0);
      if (u !== 0) return finish(1);
      base = `http://127.0.0.1:${HOST_PORT}`;
      cleanup = async () => {
        if (!KEEP_UP) cc(['down', '-v']);
      };
    } catch (e) {
      report('compose lifecycle', false, e.message);
      return finish(1);
    }
  }

  // Stage 3: wait for health + HTTP smoke
  try {
    const h = await waitForHealth(base);
    report('service /health reachable', true, `${h.persisted} persisted audits`);
    await smoke(base);
  } catch (e) {
    report('HTTP smoke', false, e.message);
  } finally {
    await cleanup();
  }
  return finish();
}

function finish(forced) {
  const failed = results.filter((r) => !r.ok);
  console.log('\n== acceptance summary ==');
  for (const r of results) console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.stage}`);
  const code = forced ?? (failed.length === 0 ? 0 : 1);
  console.log(code === 0 ? '\nACCEPTED' : `\nREJECTED (${failed.length} failed stage(s))`);
  process.exit(code);
}

main().catch((e) => { console.error(e); process.exit(2); });
