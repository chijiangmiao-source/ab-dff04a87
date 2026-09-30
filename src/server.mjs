import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeTransducer } from './transducer.mjs';
import { AuditStore, normalizeSpec, publicRecord } from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const DEFAULT_PORT = 8080;

export function createApp({ store }) {
  const page = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');

  const send = (res, status, body, headers = {}) => {
    const data = typeof body === 'string' || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': typeof body === 'string' || Buffer.isBuffer(body)
        ? (headers['Content-Type'] ?? 'text/plain; charset=utf-8')
        : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(data);
  };

  const json = (req) => new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 256 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try { resolve(buf === '' ? {} : JSON.parse(buf)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/health') {
        const persisted = store.all().length;
        send(res, 200, {
          status: 'ok',
          service: 'transducer-audit',
          persisted,
          page: existsSync(join(ROOT, 'public', 'index.html')),
          time: new Date().toISOString(),
        });
        return;
      }

      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        send(res, 200, page, { 'Content-Type': 'text/html; charset=utf-8' });
        return;
      }

      if (req.method === 'POST' && path === '/api/audits') {
        let body;
        try { body = await json(req); } catch {
          send(res, 400, { error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
          return;
        }
        const payload = normalizeSpec(body);
        const result = analyzeTransducer(payload);
        if (result.status === 'invalid') {
          // Invalid input is reported but not persisted as a conclusion.
          send(res, 422, { error: { code: 'VALIDATION_FAILED', errors: result.errors } });
          return;
        }
        if (result.status === 'error') {
          send(res, 500, { error: { code: 'ANALYSIS_ERROR', errors: result.errors } });
          return;
        }
        const out = store.submit(payload.auditId, body, {
          functional: result.functional,
          witness: result.witness,
        });
        if (!out.ok) {
          send(res, 409, { error: { code: out.code, message: out.message } });
          return;
        }
        const rec = publicRecord(out.record);
        rec.replayed = out.replayed;
        send(res, out.replayed ? 200 : 201, rec);
        return;
      }

      if (req.method === 'GET' && path.startsWith('/api/audits/')) {
        const id = decodeURIComponent(path.slice('/api/audits/'.length));
        const rec = store.get(id);
        if (!rec) {
          send(res, 404, { error: { code: 'NOT_FOUND', message: `未找到审计：${id}` } });
          return;
        }
        send(res, 200, publicRecord(rec));
        return;
      }

      if (req.method === 'GET' && path === '/api/audits') {
        send(res, 200, { audits: store.all().map(publicRecord) });
        return;
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: '未知路径' } });
    } catch (err) {
      send(res, 500, { error: { code: 'INTERNAL', message: String(err?.message ?? err) } });
    }
  });
}

function start() {
  const port = Number(process.env.PORT || process.env.TRANSDUCER_PORT || DEFAULT_PORT);
  const host = process.env.HOST || '0.0.0.0';
  const dataFile = process.env.DATA_FILE || join(ROOT, 'data', 'audits.json');
  const store = new AuditStore(dataFile);
  const app = createApp({ store });
  app.listen(port, host, () => {
    console.log(`[transducer-audit] listening on http://${host}:${port} (data: ${dataFile})`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
