import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { migrate, expirePending } from '../../src/db.js';
import { readConfig } from '../../src/config.js';
import { AppError } from '../../src/errors.js';

test('API with real Postgres', async t => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL or run compose.test.yml');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await migrate(pool);
  await migrate(pool); // Starting again must preserve existing tables.
  const config = readConfig({ AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });
  const calls = [];
  let reply = async () => 'Тестовый ответ';
  const gateway = async (_config, messages) => { calls.push(messages); return reply(); };
  async function start() {
    server = createApp({ pool, config, gateway }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  }
  let base = await start();
  async function request(path, { cookie, body, headers = {}, method } = {}) {
    const response = await fetch(base + '/api' + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie'), data: await response.json() };
  }
  let cookie;
  let sessionId;
  await t.test('anonymous cookie, session reuse and authentication', async () => {
    assert.equal((await request('/messages')).status, 401);
    const created = await request('/sessions', { body: {} });
    assert.equal(created.status, 201);
    assert.match(created.cookie, /HttpOnly/);
    assert.match(created.cookie, /SameSite=Strict/);
    cookie = created.cookie.split(';')[0];
    sessionId = created.data.session.id;
    assert.equal((await request('/sessions', { cookie, body: {} })).data.session.id, sessionId);
    assert.equal((await request('/messages', { cookie: 'ai_session=' + sessionId })).status, 401);
    const stored = (await pool.query('SELECT token_hash FROM sessions WHERE id=$1', [sessionId])).rows[0];
    assert.notEqual(stored.token_hash, cookie.split('=')[1]);
  });
  await t.test('validates input and rejects cross-origin mutations', async () => {
    for (const prompt of ['', '   ', 123, 'x'.repeat(8001)]) {
      assert.equal((await request('/messages', { cookie, body: { prompt } })).status, 400);
    }
    assert.equal((await request('/messages', { cookie, body: { prompt: 'x' }, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('/sessions', { body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await request('/messages?before=9223372036854775808', { cookie })).status, 400);
    assert.equal((await request('/messages?limit=0', { cookie })).status, 400);
    assert.equal(calls.length, 0);
  });
  await t.test('persists turns, isolates sessions and supplies history to the AI', async () => {
    assert.equal((await request('/messages', { cookie, body: { prompt: 'Первый вопрос' } })).status, 201);
    const result = await request('/messages', { cookie, body: { prompt: 'Второй вопрос' } });
    assert.equal(result.data.turn.response, 'Тестовый ответ');
    assert.deepEqual(calls[1].map(message => message.role), ['user', 'assistant', 'user']);
    const history = await request('/messages', { cookie });
    assert.equal(history.data.turns.length, 2);
    const page = await request('/messages?limit=1', { cookie });
    assert.equal(page.data.turns[0].prompt, 'Второй вопрос');
    const older = await request('/messages?before=' + page.data.nextBefore, { cookie });
    assert.equal(older.data.turns[0].prompt, 'Первый вопрос');
    const other = await request('/sessions/new', { body: {} });
    assert.deepEqual((await request('/messages', { cookie: other.cookie.split(';')[0] })).data.turns, []);
    await new Promise(resolve => server.close(resolve));
    base = await start();
    assert.equal((await request('/messages', { cookie })).data.turns.length, 2);
  });
  await t.test('records failures and excludes them from model context', async () => {
    reply = async () => { throw new AppError(504, 'gateway_timeout', 'Timeout'); };
    assert.equal((await request('/messages', { cookie, body: { prompt: 'Failed question' } })).status, 504);
    const history = await request('/messages', { cookie });
    assert.equal(history.data.turns.at(-1).status, 'failed');
    assert.equal(history.data.turns.at(-1).error_code, 'gateway_timeout');
    reply = async () => 'Recovered';
    assert.equal((await request('/messages', { cookie, body: { prompt: 'Retry' } })).status, 201);
    assert.ok(!calls.at(-1).some(message => message.content === 'Failed question'));
  });
  await t.test('persists pending prompts and rejects concurrent requests', async () => {
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    reply = () => new Promise(resolve => { release = resolve; entered(); });
    const first = request('/messages', { cookie, body: { prompt: 'Slow' } });
    await started;
    try {
      assert.equal((await request('/messages', { cookie })).data.turns.at(-1).status, 'pending');
      assert.equal((await request('/messages', { cookie, body: { prompt: 'Concurrent' } })).status, 409);
    } finally {
      release('Finished');
    }
    assert.equal((await first).status, 201);
  });
  await t.test('recovers interrupted requests and rejects expired sessions', async () => {
    await pool.query(`INSERT INTO chat_turns(session_id, prompt, model, deadline_at) VALUES ($1, 'Interrupted', 'test', now() - interval '1 second')`, [sessionId]);
    await expirePending(pool);
    assert.equal((await request('/messages', { cookie })).data.turns.at(-1).error_code, 'request_interrupted');
    await pool.query(`UPDATE sessions SET expires_at=now() - interval '1 second' WHERE id=$1`, [sessionId]);
    assert.equal((await request('/messages', { cookie })).status, 401);
    assert.notEqual((await request('/sessions', { cookie, body: {} })).data.session.id, sessionId);
  });
});
