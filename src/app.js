import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';
import { buildMessages, complete } from './gateway.js';

const cookieName = 'ai_session';
const hash = token => createHash('sha256').update(token).digest('hex');
const fields = 'id, prompt, response, status, model, error_code, created_at, finished_at';

export function createApp({ pool, config, gateway = complete, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    strictTransportSecurity: config.cookieSecure ? undefined : false,
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.cookieSecure ? [] : null } },
  }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if ((req.headers.origin && req.headers.origin !== config.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new AppError(403, 'origin_not_allowed', 'Запрос с этого сайта запрещён.');
      }
      if (!req.is('application/json')) throw new AppError(415, 'json_required', 'Ожидается Content-Type: application/json.');
    }
    next();
  });
  app.use(express.json({ limit: '40kb' }));
  app.use(cookieParser());

  const limited = { error: { code: 'rate_limited', message: 'Слишком много запросов. Попробуйте позже.' } };
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, message: limited }));
  const sessionLimit = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: limited });
  const chatLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: limited });

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', aiConfigured: Boolean(config.aiApiKey) });
  });

  async function findSession(req) {
    const token = req.cookies[cookieName];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const result = await pool.query('SELECT id, created_at, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > now()', [hash(token)]);
    return result.rows[0] || null;
  }

  async function newSession(res) {
    const token = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + config.sessionDays * 86400000);
    const result = await pool.query('INSERT INTO sessions(id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id, created_at, expires_at', [randomUUID(), hash(token), expires]);
    res.cookie(cookieName, token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/', expires });
    return result.rows[0];
  }

  app.post('/api/sessions', sessionLimit, async (req, res) => {
    const existing = await findSession(req);
    res.status(existing ? 200 : 201).json({ session: existing || await newSession(res) });
  });
  app.post('/api/sessions/new', sessionLimit, async (_req, res) => {
    res.status(201).json({ session: await newSession(res) });
  });

  app.use('/api', async (req, _res, next) => {
    req.session = await findSession(req);
    if (!req.session) throw new AppError(401, 'session_required', 'Сессия истекла. Начните новую сессию.');
    next();
  });

  app.get('/api/messages', async (req, res) => {
    const before = req.query.before;
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n))) {
      throw new AppError(400, 'invalid_pagination', 'limit: 1–100, before: ID записи.');
    }
    await pool.query(`UPDATE chat_turns SET status = 'failed', error_code = 'request_interrupted', finished_at = now()
      WHERE session_id = $1 AND status = 'pending' AND deadline_at < now()`, [req.session.id]);
    const result = await pool.query(`SELECT ${fields} FROM chat_turns
      WHERE session_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [req.session.id, before ?? null, limit + 1]);
    const hasMore = result.rows.length > limit;
    const turns = result.rows.slice(0, limit).reverse();
    res.json({ turns, nextBefore: hasMore ? turns[0].id : null });
  });

  app.post('/api/messages', chatLimit, async (req, res) => {
    const prompt = req.body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > config.maxPromptLength) {
      throw new AppError(400, 'invalid_prompt', `Введите запрос длиной от 1 до ${config.maxPromptLength} символов.`);
    }
    if (!config.aiApiKey) throw new AppError(503, 'ai_not_configured', 'Укажите AI_API_KEY на сервере.');
    let turn;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE chat_turns SET status = 'failed', error_code = 'request_interrupted', finished_at = now()
        WHERE session_id = $1 AND status = 'pending' AND deadline_at < now()`, [req.session.id]);
      const result = await client.query(`INSERT INTO chat_turns(session_id, prompt, model, deadline_at)
        VALUES ($1, $2, $3, now() + $4::int * interval '1 millisecond') RETURNING ${fields}`,
      [req.session.id, prompt.trim(), config.aiModel, config.aiTimeoutMs + 15000]);
      turn = result.rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') throw new AppError(409, 'request_in_progress', 'Дождитесь ответа на предыдущий запрос.');
      throw error;
    } finally {
      client.release();
    }

    try {
      const history = await pool.query(`SELECT prompt, response FROM chat_turns
        WHERE session_id = $1 AND status = 'completed' ORDER BY id DESC LIMIT 20`, [req.session.id]);
      const messages = buildMessages(history.rows.reverse(), turn.prompt, config.contextChars);
      const response = await gateway(config, messages);
      const result = await pool.query(`UPDATE chat_turns SET response = $2, status = 'completed', finished_at = now()
        WHERE id = $1 AND status = 'pending' AND deadline_at > now() RETURNING ${fields}`, [turn.id, response]);
      if (!result.rowCount) throw new AppError(504, 'request_interrupted', 'Запрос прерван. Повторите попытку.');
      res.status(201).json({ turn: result.rows[0] });
    } catch (error) {
      await pool.query(`UPDATE chat_turns SET status = 'failed', error_code = $2, finished_at = now()
        WHERE id = $1 AND status = 'pending'`, [turn.id, error instanceof AppError ? error.code : 'internal_error']);
      throw error;
    }
  });

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'not_found', 'Маршрут не найден.')));
  app.use(express.static(fileURLToPath(new URL('../client/build/', import.meta.url))));
  app.use((_req, _res, next) => next(new AppError(404, 'not_found', 'Страница не найдена.')));
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') error = new AppError(400, 'invalid_json', 'Некорректный JSON.');
    if (error.type === 'entity.too.large') error = new AppError(413, 'body_too_large', 'Слишком большой запрос.');
    if (!(error instanceof AppError)) logger.error('Request failed', { name: error.name, code: error.code });
    res.status(error instanceof AppError ? error.status : 500).json({ error: {
      code: error instanceof AppError ? error.code : 'internal_error',
      message: error instanceof AppError ? error.message : 'Внутренняя ошибка сервера.',
    } });
  });
  return app;
}
