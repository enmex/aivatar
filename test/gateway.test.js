import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, buildMessages } from '../src/gateway.js';
import { readConfig } from '../src/config.js';

const config = readConfig({ AI_API_KEY: 'private-test-key', AI_MODEL: 'test/model' });

test('sends server credentials, model and ordered conversation to the gateway', async () => {
  const messages = buildMessages([{ prompt: 'first', response: 'answer' }], 'second', 100);
  const result = await complete(config, messages, async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer private-test-key');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), {
      model: 'test/model', messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ], max_tokens: 2048, stream: false,
    });
    return Response.json({ choices: [{ message: { content: 'result' } }] });
  });
  assert.equal(result, 'result');
});

test('trims old context by whole turns and keeps the latest prompt', () => {
  const turns = [{ prompt: 'old', response: 'old answer' }, { prompt: 'new', response: 'reply' }];
  assert.deepEqual(buildMessages(turns, 'question', 16), [
    { role: 'user', content: 'new' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'question' },
  ]);
  assert.deepEqual(buildMessages(turns, 'question', 8), [{ role: 'user', content: 'question' }]);
});

test('does not expose gateway error details or credentials', async () => {
  await assert.rejects(complete(config, [], async () => new Response('secret upstream error', { status: 401 })), error => {
    assert.equal(error.status, 502);
    assert.equal(error.code, 'gateway_error');
    assert.ok(!error.message.includes('secret'));
    return true;
  });
});

test('rejects empty, malformed and error responses with HTTP 200', async () => {
  for (const body of [{}, { error: { message: 'hidden' } }, { choices: [{ message: { content: '' } }] }]) {
    await assert.rejects(complete(config, [], async () => Response.json(body)), { code: 'invalid_gateway_response' });
  }
  await assert.rejects(complete(config, [], async () => new Response('not-json')), { code: 'gateway_unavailable' });
});

test('maps timeouts and network failures to stable errors', async () => {
  await assert.rejects(complete(config, [], async () => { throw new DOMException('expired', 'TimeoutError'); }), { status: 504, code: 'gateway_timeout' });
  await assert.rejects(complete(config, [], async () => { throw new TypeError('connection failed'); }), { status: 502, code: 'gateway_unavailable' });
});

test('does not contact the gateway when no key is configured', async () => {
  await assert.rejects(complete({ ...config, aiApiKey: '' }, [], () => assert.fail('must not fetch')), { status: 503, code: 'ai_not_configured' });
});

test('validates configuration and supports another compatible gateway', () => {
  const custom = readConfig({ AI_BASE_URL: 'http://gateway:8080/v1/', AI_MODEL: 'local-model' });
  assert.equal(custom.aiBaseUrl, 'http://gateway:8080/v1');
  assert.equal(custom.aiModel, 'local-model');
  for (const env of [{ PORT: 'no' }, { AI_TIMEOUT_MS: '-1' }, { AI_MAX_TOKENS: '0' }, { AI_BASE_URL: 'file:///tmp' }, { AI_BASE_URL: 'https://name:password@example.com' }, { PUBLIC_ORIGIN: 'file:///tmp' }]) {
    assert.throws(() => readConfig(env));
  }
});
