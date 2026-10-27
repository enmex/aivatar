// Keep diagnostics useful without logging credentials from configuration or URLs.
export function describeError(error, env = process.env, depth = 0) {
  const secrets = ['AI_API_KEY', 'PGPASSWORD', 'POSTGRES_PASSWORD', 'DATABASE_URL']
    .map(name => env[name]).filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = value => {
    let text = String(value);
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
    return text.replace(/\b((?:postgres(?:ql)?|https?):\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
  };
  const details = {
    name: error?.name || 'Error',
    message: redact(error?.message ?? error),
  };
  if (error?.code !== undefined) details.code = redact(error.code);
  if (error?.stack) details.stack = redact(error.stack);
  if (depth < 3 && error?.cause) details.cause = describeError(error.cause, env, depth + 1);
  if (depth < 3 && Array.isArray(error?.errors)) {
    details.errors = error.errors.map(item => describeError(item, env, depth + 1));
  }
  return details;
}
