import test from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from '../src/logging.js';

test('keeps the message and stack of startup errors without an error code', () => {
  const error = new Error('Connection terminated due to connection timeout');
  const details = describeError(error, {});
  assert.equal(details.name, 'Error');
  assert.equal(details.message, error.message);
  assert.match(details.stack, /logging\.test\.js/);
  assert.ok(!('code' in details));
});

test('redacts configured credentials and URL credentials in nested diagnostics', () => {
  const env = { AI_API_KEY: 'secret-key', PGPASSWORD: 'secret-password' };
  const cause = new Error('postgresql://user:other-password@db:5432/app');
  const error = new Error('secret-key secret-password', { cause });
  error.code = 'ECONNREFUSED';
  const details = describeError(error, env);
  const output = JSON.stringify(details);
  for (const secret of ['secret-key', 'secret-password', 'other-password']) assert.ok(!output.includes(secret));
  assert.equal(details.code, 'ECONNREFUSED');
  assert.match(details.cause.message, /\[REDACTED\]@db:5432\/app/);
});

test('preserves individual connection errors inside AggregateError', () => {
  const error = new AggregateError([Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' })], '');
  assert.equal(describeError(error, {}).errors[0].code, 'ECONNREFUSED');
});
