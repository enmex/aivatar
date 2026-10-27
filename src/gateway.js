import { AppError } from './errors.js';

export function buildMessages(turns, prompt, maxChars) {
  const messages = [];
  let remaining = maxChars - prompt.length;
  for (const turn of [...turns].reverse()) {
    const size = turn.prompt.length + turn.response.length;
    if (size > remaining) break;
    messages.unshift({ role: 'user', content: turn.prompt }, { role: 'assistant', content: turn.response });
    remaining -= size;
  }
  return [...messages, { role: 'user', content: prompt }];
}

export async function complete(config, messages, fetchImpl = fetch) {
  if (!config.aiApiKey) throw new AppError(503, 'ai_not_configured', 'Укажите AI_API_KEY на сервере.');
  try {
    const response = await fetchImpl(`${config.aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.aiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.aiModel, messages, max_tokens: config.aiMaxTokens, stream: false }),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(502, 'gateway_error', 'Гейт ИИ отклонил запрос. Попробуйте позже.');
    }
    const body = await response.json();
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AppError(502, 'invalid_gateway_response', 'Гейт ИИ вернул пустой или некорректный ответ.');
    }
    return content;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new AppError(504, 'gateway_timeout', 'Истекло время ожидания ответа ИИ.');
    }
    throw new AppError(502, 'gateway_unavailable', 'Не удалось получить ответ от гейта ИИ.');
  }
}
