export function readConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
    }
    return value;
  };
  const baseUrl = new URL(env.AI_BASE_URL || 'https://openrouter.ai/api/v1');
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('AI_BASE_URL must be an HTTP(S) URL without credentials, query or fragment');
  }
  const port = integer('PORT', 3000, 1, 65535);
  const publicUrl = new URL(env.PUBLIC_ORIGIN || `http://localhost:${port}`);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without credentials');
  }
  const origin = publicUrl.origin;
  return {
    port, origin,
    databaseUrl: env.DATABASE_URL,
    aiBaseUrl: baseUrl.href.replace(/\/$/, ''),
    aiApiKey: env.AI_API_KEY || '',
    aiModel: env.AI_MODEL || 'openai/gpt-4o-mini',
    aiTimeoutMs: integer('AI_TIMEOUT_MS', 60000, 100, 300000),
    aiMaxTokens: integer('AI_MAX_TOKENS', 2048, 1, 32768),
    cookieSecure: env.COOKIE_SECURE === 'true',
    sessionDays: 30,
    maxPromptLength: 8000,
    contextChars: 48000,
  };
}
