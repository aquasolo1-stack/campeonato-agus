'use strict';
// Campeonato Agus — servidor web + API. Datos en SQLite dentro de DATA_DIR (montado como volumen).

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PIN = process.env.ADMIN_PIN || '';
if (!ADMIN_PIN) console.warn('[aviso] ADMIN_PIN no está definido: nadie va a poder entrar como organizador.');

// ---------- base de datos ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'campeonato.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL COLLATE NOCASE UNIQUE,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const q = {
  players: db.prepare('SELECT id, nombre, created_at AS ts FROM players ORDER BY created_at, rowid'),
  insertPlayer: db.prepare('INSERT INTO players (id, nombre, token, created_at) VALUES (?, ?, ?, ?)'),
  playerById: db.prepare('SELECT id, token FROM players WHERE id = ?'),
  deletePlayer: db.prepare('DELETE FROM players WHERE id = ?'),
  getKv: db.prepare('SELECT value FROM kv WHERE key = ?'),
  setKv: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};
const getKv = (k) => { const r = q.getKv.get(k); return r ? r.value : null; };
const version = () => Number(getKv('version') || 0);
const bump = () => q.setKv.run('version', String(version() + 1));

// configuración que define el organizador
const DEFAULT_CONFIG = {
  inscripcionAbierta: true, // abrir/cerrar a mano
  cierre: null,             // ISO: cierre automático (opcional)
  formato: 'simple',        // 'simple' (una rueda) | 'doble' (ida y vuelta) | 'directo' (sin grupos)
  equiposPorGrupo: 4,       // 2..8
  tantos: 30,               // 15 | 30
  eliminatoria: 8,          // equipos que arrancan la llave: 2 final, 4 semis, 8 cuartos, 16 octavos, 32 16avos
};
function config() {
  const c = getKv('config');
  return { ...DEFAULT_CONFIG, ...(c ? JSON.parse(c) : {}) };
}
function inscripcionAbierta(c = config()) {
  return !!c.inscripcionAbierta && !(c.cierre && Date.now() >= Date.parse(c.cierre));
}
function validConfig(body) {
  const c = { ...config() };
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (has('inscripcionAbierta')) c.inscripcionAbierta = !!body.inscripcionAbierta;
  if (has('cierre')) {
    if (body.cierre === null || body.cierre === '') c.cierre = null;
    else { const t = Date.parse(body.cierre); if (!Number.isFinite(t)) throw new HttpError(400, 'Fecha de cierre inválida.'); c.cierre = new Date(t).toISOString(); }
  }
  if (has('formato')) { if (!['simple', 'doble', 'directo'].includes(body.formato)) throw new HttpError(400, 'Formato inválido.'); c.formato = body.formato; }
  if (has('equiposPorGrupo')) { const n = Number(body.equiposPorGrupo); if (!Number.isInteger(n) || n < 2 || n > 8) throw new HttpError(400, 'Equipos por grupo: entre 2 y 8.'); c.equiposPorGrupo = n; }
  if (has('tantos')) { const n = Number(body.tantos); if (![15, 30].includes(n)) throw new HttpError(400, 'Los partidos son a 15 o a 30.'); c.tantos = n; }
  if (has('eliminatoria')) { const n = Number(body.eliminatoria); if (![2, 4, 8, 16, 32].includes(n)) throw new HttpError(400, 'La llave arranca con 2, 4, 8, 16 o 32 equipos.'); c.eliminatoria = n; }
  return c;
}

function state() {
  const t = getKv('torneo'); const c = config();
  return { version: version(), players: q.players.all(), torneo: t ? JSON.parse(t) : null, config: c, inscripcionAbierta: inscripcionAbierta(c), serverTime: Date.now() };
}

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const newId = (p) => p + crypto.randomBytes(6).toString('hex');

function cleanName(v) {
  const s = String(v ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!s) throw new HttpError(400, 'Escribí tu nombre o apodo.');
  return s;
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const isAdmin = (req) => !!ADMIN_PIN && safeEqual(req.get('x-admin-pin') || '', ADMIN_PIN);

// rate limit simple en memoria: max eventos por IP en una ventana
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, _res, next) => {
    const now = Date.now(); const k = req.ip;
    let h = hits.get(k); if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    if (++h.n > max) return next(new HttpError(429, 'Demasiados intentos. Esperá unos minutos.'));
    next();
  };
}
function requireAdmin(req, _res, next) { if (!isAdmin(req)) return next(new HttpError(401, 'PIN incorrecto.')); next(); }

function addPlayer(nombre) {
  const id = newId('p'); const token = crypto.randomBytes(18).toString('hex');
  try {
    db.transaction(() => { q.insertPlayer.run(id, nombre, token, Date.now()); bump(); })();
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, `Ya hay alguien anotado como "${nombre}". Probá con tu apodo o agregá el apellido.`);
    throw e;
  }
  return { id, token };
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});
app.use(express.json({ limit: '300kb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const since = Number(req.query.since);
  if (Number.isFinite(since) && since === version()) return res.json({ changed: false, version: since });
  res.json({ changed: true, ...state() });
});

// inscripción pública
app.post('/api/players', limiter(20, 10 * 60 * 1000), (req, res) => {
  if (!inscripcionAbierta() && !isAdmin(req)) throw new HttpError(403, 'La inscripción está cerrada.');
  res.status(201).json(addPlayer(cleanName(req.body?.nombre)));
});

// darse de baja (con el token que recibió al anotarse) o borrar (organizador)
app.delete('/api/players/:id', (req, res) => {
  const p = q.playerById.get(req.params.id);
  if (!p) throw new HttpError(404, 'No se encontró esa inscripción.');
  const token = req.get('x-player-token') || '';
  if (!isAdmin(req) && !safeEqual(token, p.token)) throw new HttpError(403, 'No podés borrar esta inscripción.');
  db.transaction(() => { q.deletePlayer.run(p.id); bump(); })();
  res.json({ ok: true });
});

// organizador
app.post('/api/admin/login', limiter(10, 15 * 60 * 1000), (req, res) => {
  const ok = !!ADMIN_PIN && safeEqual(String(req.body?.pin ?? ''), ADMIN_PIN);
  if (!ok) throw new HttpError(401, 'PIN incorrecto.');
  res.json({ ok: true });
});
app.post('/api/admin/players', requireAdmin, (req, res) => {
  res.status(201).json({ id: addPlayer(cleanName(req.body?.nombre)).id });
});
app.put('/api/admin/torneo', requireAdmin, (req, res) => {
  const t = req.body?.torneo;
  if (!t || typeof t !== 'object' || Array.isArray(t) || typeof t.fase !== 'string') throw new HttpError(400, 'Datos del torneo inválidos.');
  db.transaction(() => { q.setKv.run('torneo', JSON.stringify(t)); bump(); })();
  res.json({ ok: true, version: version() });
});
app.put('/api/admin/config', requireAdmin, (req, res) => {
  const c = validConfig(req.body || {});
  db.transaction(() => { q.setKv.run('config', JSON.stringify(c)); bump(); })();
  res.json({ ok: true, config: c, inscripcionAbierta: inscripcionAbierta(c) });
});
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  if (req.body?.confirm !== 'BORRAR TODO') throw new HttpError(400, 'Falta la confirmación.');
  db.transaction(() => { db.exec("DELETE FROM players; DELETE FROM kv WHERE key = 'torneo';"); bump(); })();
  res.json({ ok: true });
});

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Ruta inexistente.')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error del servidor.' : err.message });
});

const server = app.listen(PORT, () => console.log(`Campeonato Agus en http://localhost:${PORT} · datos en ${DATA_DIR}`));
const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

module.exports = { app };
