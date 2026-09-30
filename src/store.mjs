// Persistent audit store backed by an append-then-checkpoint JSON file.
// Concurrency model: single Node process; writes are serialized and fsynced.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class AuditStore {
  constructor(file) {
    this.file = file;
    this.records = new Map(); // auditId -> record
    this._load();
  }

  _load() {
    let raw = '';
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    if (raw.trim() === '') return;
    const doc = JSON.parse(raw);
    for (const rec of doc.records ?? []) {
      this.records.set(rec.auditId, rec);
    }
  }

  _persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const doc = {
      version: 1,
      records: [...this.records.values()].sort((a, b) => a.auditId.localeCompare(b.auditId)),
    };
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { flag: 'w' });
    renameSync(tmp, this.file);
  }

  get(auditId) {
    return this.records.get(auditId) ?? null;
  }

  all() {
    return [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Create or re-run an audit.
  // Same id + same payload: idempotent replay (frozen conclusion).
  // Same id + different payload: rejected.
  submit(auditId, spec, result) {
    const existing = this.records.get(auditId);
    const payload = normalizeSpec(spec);
    const canonical = canonicalSpec(payload);
    const fingerprint = fingerprintSpec(canonical);

    if (existing) {
      const conflict = existing.fingerprint !== fingerprint
        || canonicalSpec(existing.payload) !== canonical;
      if (conflict) {
        return {
          ok: false,
          code: 'AUDIT_ID_CONFLICT',
          message: `审计标识 ${auditId} 已用于不同载荷，禁止覆盖；请使用新标识`,
          existing: publicRecord(existing),
        };
      }
      return { ok: true, replayed: true, record: existing };
    }

    const record = {
      auditId,
      fingerprint,
      payload,
      result,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    this.records.set(auditId, record);
    this._persist();
    return { ok: true, replayed: false, record };
  }
}

export function normalizeSpec(spec) {
  const str = String(spec.alphabetRaw ?? '').trim();
  const alphabet = str === ''
    ? []
    : str.split(/[\s,]+/).filter(Boolean);
  const states = String(spec.statesRaw ?? '').trim() === ''
    ? []
    : String(spec.statesRaw).trim().split(/[\s,]+/).filter(Boolean);
  const acceptingStates = String(spec.acceptingStatesRaw ?? '').trim() === ''
    ? []
    : String(spec.acceptingStatesRaw).trim().split(/[\s,]+/).filter(Boolean);
  const transitions = (spec.transitions ?? []).map((t) => ({
    id: String(t.id ?? '').trim(),
    from: String(t.from ?? '').trim(),
    to: String(t.to ?? '').trim(),
    input: t.input === undefined || t.input === null ? '' : String(t.input).trim(),
    output: String(t.output ?? '').toUpperCase(),
  }));
  return {
    auditId: String(spec.auditId ?? '').trim(),
    alphabet,
    states,
    initialState: String(spec.initialState ?? '').trim(),
    acceptingStates,
    transitions,
  };
}

function canonicalSpec(value) {
  // Stable serialization that sorts object keys at every nesting level
  // (a JSON.stringify replacer array would filter nested keys as well).
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSpec).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalSpec(value[k])}`).join(',')}}`;
}

function fingerprintSpec(canonical) {
  // collisions across these small specs are negligible, and exact equality
  // is still enforced on replay via the stored payload below.
  let h1 = 0x811c9dc5;
  let h2 = 0x1e35a7bd;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 8) | (i & 31)), 0x85ebca6b) >>> 0;
  }
  return `fnv-${(h1 >>> 0).toString(16).padStart(8, '0')}-${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export function publicRecord(rec) {
  return {
    auditId: rec.auditId,
    createdAt: rec.createdAt,
    replayed: rec.replayed ?? false,
    spec: rec.payload,
    result: rec.result,
  };
}
