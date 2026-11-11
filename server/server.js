// License + trial server for the car CarPlay/Android Auto launcher app.
// Zero dependencies: Node 22+ only (uses built-in node:sqlite).
//
// Env vars:
//   PORT          default 3000
//   ADMIN_TOKEN   required for /admin/* endpoints (long random string)
//   TRIAL_DAYS    default 7
//   DB_PATH       default ./data/licenses.db
//   APK_PATH      default ./public/app.apk  (served at /download/app.apk)

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'licenses.db');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APK_PATH = process.env.APK_PATH || path.join(PUBLIC_DIR, 'app.apk');
const DAY_MS = 24 * 60 * 60 * 1000;
// App update info: bump APP_VERSION_CODE whenever you upload a new public/app.apk
const APP_VERSION_CODE = Number(process.env.APP_VERSION_CODE || 1);
const APP_VERSION_NAME = process.env.APP_VERSION_NAME || '1.0';
// Plans: prices in IQD. Lifetime = 100 years.
const PLANS = {
  monthly:  { days: 30,    priceIqd: 2000,  label: 'شهري' },
  yearly:   { days: 365,   priceIqd: 20000, label: 'سنوي' },
  lifetime: { days: 36500, priceIqd: 50000, label: 'مدى الحياة' },
};

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    device_id   TEXT PRIMARY KEY,
    device_type TEXT,              -- 'iphone' | 'android' | null
    trial_start INTEGER NOT NULL,  -- ms epoch
    paid_until  INTEGER NOT NULL DEFAULT 0,
    note        TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codes (
    code        TEXT PRIMARY KEY,
    days        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    used_by     TEXT,
    used_at     INTEGER,
    label       TEXT               -- e.g. customer name / partner code
  );
`);

const q = {
  getDevice: db.prepare('SELECT * FROM devices WHERE device_id = ?'),
  insertDevice: db.prepare(
    'INSERT INTO devices (device_id, device_type, trial_start, paid_until, created_at) VALUES (?, ?, ?, 0, ?)'
  ),
  updateType: db.prepare('UPDATE devices SET device_type = ? WHERE device_id = ?'),
  setPaidUntil: db.prepare('UPDATE devices SET paid_until = ? WHERE device_id = ?'),
  getCode: db.prepare('SELECT * FROM codes WHERE code = ?'),
  insertCode: db.prepare('INSERT INTO codes (code, days, created_at, label) VALUES (?, ?, ?, ?)'),
  useCode: db.prepare('UPDATE codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL'),
  listDevices: db.prepare('SELECT * FROM devices ORDER BY created_at DESC LIMIT 500'),
  listCodes: db.prepare('SELECT * FROM codes ORDER BY created_at DESC LIMIT 500'),
};

// ---------- helpers ----------
function now() { return Date.now(); }

function computeStatus(dev) {
  const t = now();
  const trialEnd = dev.trial_start + TRIAL_DAYS * DAY_MS;
  if (dev.paid_until > t) {
    return { status: 'active', expiresAt: dev.paid_until, daysLeft: Math.ceil((dev.paid_until - t) / DAY_MS) };
  }
  if (trialEnd > t) {
    return { status: 'trial', expiresAt: trialEnd, daysLeft: Math.ceil((trialEnd - t) / DAY_MS) };
  }
  return { status: 'expired', expiresAt: Math.max(trialEnd, dev.paid_until), daysLeft: 0 };
}

function validDeviceId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}
function validType(t) {
  return t === undefined || t === null || t === 'iphone' || t === 'android';
}

function makeCode() {
  // 12 chars from an unambiguous alphabet, shown as XXXX-XXXX-XXXX
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
function normalizeCode(c) {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3');
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10_000) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// very small in-memory rate limiter (per IP, per minute) to slow code guessing
const hits = new Map();
function rateLimited(ip, limit = 30) {
  const minute = Math.floor(now() / 60000);
  const key = ip + ':' + minute;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) for (const k of hits.keys()) if (!k.endsWith(':' + minute)) hits.delete(k);
  return n > limit;
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const h = req.headers['authorization'] || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.apk': 'application/vnd.android.package-archive' };

function serveFile(res, file, downloadName) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size };
    if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';

  try {
    // --- static / download ---
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (req.method === 'GET' && url.pathname === '/download/app.apk') {
      return serveFile(res, APK_PATH, 'zigg.apk');
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/version') {
      return send(res, 200, { versionCode: APP_VERSION_CODE, versionName: APP_VERSION_NAME, url: '/download/app.apk' });
    }

    // --- client API ---
    if (req.method === 'POST' && url.pathname === '/api/status') {
      if (rateLimited(ip, 60)) return send(res, 429, { error: 'rate_limited' });
      const body = await readJson(req);
      if (!validDeviceId(body.deviceId) || !validType(body.deviceType)) return send(res, 400, { error: 'bad_request' });

      let dev = q.getDevice.get(body.deviceId);
      if (!dev) {
        // first contact: start the free trial
        q.insertDevice.run(body.deviceId, body.deviceType || null, now(), now());
        dev = q.getDevice.get(body.deviceId);
      } else if (body.deviceType && body.deviceType !== dev.device_type) {
        q.updateType.run(body.deviceType, body.deviceId);
        dev = q.getDevice.get(body.deviceId);
      }
      return send(res, 200, { ...computeStatus(dev), trialDays: TRIAL_DAYS, serverTime: now() });
    }

    if (req.method === 'POST' && url.pathname === '/api/redeem') {
      if (rateLimited(ip, 10)) return send(res, 429, { error: 'rate_limited' });
      const body = await readJson(req);
      if (!validDeviceId(body.deviceId)) return send(res, 400, { error: 'bad_request' });
      const dev = q.getDevice.get(body.deviceId);
      if (!dev) return send(res, 404, { error: 'unknown_device' });

      const code = normalizeCode(body.code);
      const row = q.getCode.get(code);
      if (!row) return send(res, 404, { error: 'invalid_code' });
      if (row.used_by) return send(res, 409, { error: 'code_already_used' });

      const r = q.useCode.run(body.deviceId, now(), code);
      if (r.changes !== 1) return send(res, 409, { error: 'code_already_used' });

      // extend from the later of: now, current paid_until
      const base = Math.max(now(), dev.paid_until);
      q.setPaidUntil.run(base + row.days * DAY_MS, body.deviceId);
      const updated = q.getDevice.get(body.deviceId);
      return send(res, 200, { ...computeStatus(updated), addedDays: row.days });
    }

    if (req.method === 'GET' && url.pathname === '/api/plans') {
      return send(res, 200, { currency: 'IQD', trialDays: TRIAL_DAYS, plans: PLANS });
    }

    // --- admin API ---
    if (url.pathname.startsWith('/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'POST' && url.pathname === '/admin/codes') {
        const body = await readJson(req);
        const plan = body.plan ? PLANS[String(body.plan)] : null;
        if (body.plan && !plan) return send(res, 400, { error: 'bad_request', hint: 'plan: monthly | yearly | lifetime' });
        const days = plan ? plan.days : Number(body.days);
        const count = Math.min(Number(body.count || 1), 200);
        if (!Number.isInteger(days) || days < 1 || days > 36500 || !Number.isInteger(count) || count < 1)
          return send(res, 400, { error: 'bad_request', hint: 'plan (monthly|yearly|lifetime) or days 1..36500, count 1..200' });
        const out = [];
        for (let i = 0; i < count; i++) {
          const c = makeCode();
          q.insertCode.run(c, days, now(), body.label ? String(body.label).slice(0, 80) : null);
          out.push(c);
        }
        return send(res, 200, { plan: body.plan || null, days, codes: out });
      }

      if (req.method === 'POST' && url.pathname === '/admin/grant') {
        // manual extension for a device (e.g. after a bank-transfer payment)
        const body = await readJson(req);
        const days = Number(body.days);
        if (!validDeviceId(body.deviceId) || !Number.isInteger(days) || days < 1) return send(res, 400, { error: 'bad_request' });
        const dev = q.getDevice.get(body.deviceId);
        if (!dev) return send(res, 404, { error: 'unknown_device' });
        q.setPaidUntil.run(Math.max(now(), dev.paid_until) + days * DAY_MS, body.deviceId);
        return send(res, 200, computeStatus(q.getDevice.get(body.deviceId)));
      }

      if (req.method === 'GET' && url.pathname === '/admin/devices') {
        const rows = q.listDevices.all().map((d) => ({ ...d, ...computeStatus(d) }));
        return send(res, 200, { devices: rows });
      }
      if (req.method === 'GET' && url.pathname === '/admin/codes') {
        return send(res, 200, { codes: q.listCodes.all() });
      }
    }

    send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e && (e.message === 'bad json' || e.message === 'too large')) return send(res, 400, { error: 'bad_request' });
    console.error(e);
    send(res, 500, { error: 'server_error' });
  }
});

if (!ADMIN_TOKEN) console.warn('WARNING: ADMIN_TOKEN is not set; /admin/* endpoints are disabled.');
server.listen(PORT, () => console.log(`license server on :${PORT} (trial ${TRIAL_DAYS} days)`));
