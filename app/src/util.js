import { createHash, randomBytes } from 'node:crypto';

export const newId = (bytes = 12) => randomBytes(bytes).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export const NO_STORE = { 'cache-control': 'no-store' };

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return res.end();
  const isStr = typeof body === 'string';
  res.writeHead(status, {
    'content-type': isStr ? (body.startsWith('<!doctype') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8') : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function jsonBody(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

/** Form-encoded or JSON (OAuth endpoints accept both). */
export async function formBody(req) {
  const raw = await readBody(req, 32 * 1024);
  if (!raw) return {};
  if (String(req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || '';
}

export function cookie(req, name) {
  const m = String(req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Refuse cross-site browser POSTs. The pit.world edge forwards with Host set to the public
 * name, so an Origin whose host equals Host is same-origin even when PUBLIC_URL differs.
 */
export function sameOrigin(req, publicUrl) {
  const o = req.headers.origin;
  if (!o || o === new URL(publicUrl).origin) return;
  let host = null;
  try {
    host = new URL(o).host;
  } catch {
    /* "null" or garbage */
  }
  if (host && (host === req.headers.host || host === req.headers['x-forwarded-host'])) return;
  throw new HttpError(403, `cross-site request refused (Origin ${String(o).slice(0, 80)})`);
}
