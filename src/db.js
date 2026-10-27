import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export function createPool(config) {
  return new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000 });
}

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize migrations when several app containers start together.
    await client.query('SELECT pg_advisory_xact_lock(741852963)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const directory = new URL('../migrations/', import.meta.url);
    const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    for (const name of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (applied.rowCount) continue;
      await client.query(await readFile(new URL(name, directory), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    // A broken connection may also reject ROLLBACK; preserve the original failure.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function expirePending(pool) {
  await pool.query(`UPDATE chat_turns SET status = 'failed', error_code = 'request_interrupted', finished_at = now()
    WHERE status = 'pending' AND deadline_at < now()`);
}
