const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-'));
process.env.DATA_DIR = dir; process.env.ADMIN_PIN = '4321'; process.env.PORT = '0';
let base, server;
before(async () => {
  const { app } = require('../server.js');
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.close(); setTimeout(() => process.exit(0), 50); });
const j = (method, url, body, headers = {}) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

test('inscripción, duplicados y baja', async () => {
  const a = await j('POST', '/api/players', { nombre: '  Agus ' });
  assert.equal(a.status, 201); assert.ok(a.body.token);
  assert.equal((await j('POST', '/api/players', { nombre: 'agus' })).status, 409);
  assert.equal((await j('POST', '/api/players', { nombre: '   ' })).status, 400);
  const s = await j('GET', '/api/state');
  assert.equal(s.body.players[0].nombre, 'Agus'); assert.equal(s.body.players[0].token, undefined);
  assert.equal((await j('GET', '/api/state?since=' + s.body.version)).body.changed, false);
  assert.equal((await j('DELETE', '/api/players/' + a.body.id, null, { 'X-Player-Token': 'mal' })).status, 403);
  assert.equal((await j('DELETE', '/api/players/' + a.body.id, null, { 'X-Player-Token': a.body.token })).status, 200);
});

test('organizador', async () => {
  assert.equal((await j('POST', '/api/admin/login', { pin: 'x' })).status, 401);
  assert.equal((await j('POST', '/api/admin/login', { pin: '4321' })).status, 200);
  assert.equal((await j('PUT', '/api/admin/torneo', { torneo: { fase: 'equipos' } })).status, 401);
  const H = { 'X-Admin-Pin': '4321' };
  assert.equal((await j('PUT', '/api/admin/torneo', { torneo: { fase: 'equipos', equipos: [] } }, H)).status, 200);
  const p = await j('POST', '/api/admin/players', { nombre: 'Juan' }, H);
  assert.equal((await j('DELETE', '/api/players/' + p.body.id, null, H)).status, 200);
  assert.equal((await j('GET', '/api/state')).body.torneo.fase, 'equipos');
});

test('configuración e inscripción cerrada', async () => {
  const H = { 'X-Admin-Pin': '4321' };
  assert.equal((await j('PUT', '/api/admin/config', { formato: 'doble' })).status, 401);
  assert.equal((await j('PUT', '/api/admin/config', { equiposPorGrupo: 12 }, H)).status, 400);
  const c = await j('PUT', '/api/admin/config', { formato: 'doble', equiposPorGrupo: 3, eliminatoria: 4, tantos: 15 }, H);
  assert.equal(c.status, 200); assert.equal(c.body.config.formato, 'doble');
  // cerrar a mano
  await j('PUT', '/api/admin/config', { inscripcionAbierta: false }, H);
  assert.equal((await j('POST', '/api/players', { nombre: 'Tarde' })).status, 403);
  assert.equal((await j('POST', '/api/admin/players', { nombre: 'Tarde' }, H)).status, 201);
  // reabrir con cierre automático ya vencido
  await j('PUT', '/api/admin/config', { inscripcionAbierta: true, cierre: new Date(Date.now() - 1000).toISOString() }, H);
  const s = await j('GET', '/api/state');
  assert.equal(s.body.inscripcionAbierta, false); assert.equal(s.body.config.equiposPorGrupo, 3);
  assert.equal((await j('POST', '/api/players', { nombre: 'Otro' })).status, 403);
  await j('PUT', '/api/admin/config', { cierre: null }, H);
  assert.equal((await j('POST', '/api/players', { nombre: 'Otro' })).status, 201);
});
