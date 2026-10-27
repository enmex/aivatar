import { readConfig } from './config.js';
import { createPool, migrate, expirePending } from './db.js';
import { createApp } from './app.js';
import { once } from 'node:events';
import { describeError } from './logging.js';

let pool;
let stage = 'configuration';
try {
  const config = readConfig();
  pool = createPool(config);
  pool.on('error', error => console.error('Database connection error', describeError(error)));
  stage = 'database_connection';
  await pool.query('SELECT 1');
  stage = 'migrations';
  await migrate(pool);
  stage = 'pending_requests_cleanup';
  await expirePending(pool);
  stage = 'http_setup';
  const app = createApp({ pool, config });
  stage = 'http_listen';
  const server = app.listen(config.port, '0.0.0.0');
  await once(server, 'listening');
  console.log(`AI gateway listening on port ${config.port}`);
  if (!config.aiApiKey) console.warn('AI_API_KEY is missing: chat requests will return 503 until configured.');
  const cleanup = setInterval(() => {
    expirePending(pool).catch(error => console.error('Pending request cleanup failed', describeError(error)));
  }, 30000).unref();
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(cleanup);
    const timeout = setTimeout(() => process.exit(1), config.aiTimeoutMs + 20000).unref();
    server.close(async () => {
      await pool.end();
      clearTimeout(timeout);
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error('Startup failed', { stage, ...describeError(error) });
  if (pool) await pool.end().catch(closeError => console.error('Database shutdown failed', describeError(closeError)));
  process.exitCode = 1;
}
