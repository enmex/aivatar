import React, { FormEvent, useEffect, useState } from 'react';
import './App.css';

type Turn = {
  id: string;
  prompt: string;
  response: string | null;
  status: 'pending' | 'completed' | 'failed';
  model: string;
  error_code: string | null;
  created_at: string;
};
type History = { turns: Turn[]; nextBefore: string | null };

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Не удалось выполнить запрос.');
  return data;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось связаться с сервером.';

function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState(true);
  const pending = turns.some(turn => turn.status === 'pending');

  useEffect(() => {
    let active = true;
    async function init() {
      try {
        await api('/sessions', {});
        const [history, health] = await Promise.all([
          api<History>('/messages'), api<{ aiConfigured: boolean }>('/health'),
        ]);
        if (!active) return;
        setTurns(history.turns);
        setNextBefore(history.nextBefore);
        setConfigured(health.aiConfigured);
        setReady(true);
      } catch (failure) {
        if (active) setError(errorText(failure));
      }
    }
    void init();
    return () => { active = false; };
  }, []);

  // Recover the result of a request still running after a page reload.
  useEffect(() => {
    if (!pending || busy) return;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const history = await api<History>('/messages');
        if (!active) return;
        setTurns(previous => {
          const fresh = new Map(history.turns.map(turn => [turn.id, turn]));
          return previous.map(turn => fresh.get(turn.id) || turn);
        });
      } catch (failure) {
        if (active) setError(errorText(failure));
      }
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pending, busy]);

  async function refresh() {
    const history = await api<History>('/messages');
    setTurns(history.turns);
    setNextBefore(history.nextBefore);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || pending || !prompt.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ turn: Turn }>('/messages', { prompt: prompt.trim() });
      setTurns(previous => [...previous, result.turn]);
      setPrompt('');
    } catch (failure) {
      setError(errorText(failure));
      try { await refresh(); } catch { /* Keep the original request error visible. */ }
    } finally {
      setBusy(false);
    }
  }

  async function newSession() {
    setBusy(true);
    setError('');
    try {
      await api('/sessions/new', {});
      const health = await api<{ aiConfigured: boolean }>('/health');
      setConfigured(health.aiConfigured);
      setTurns([]);
      setNextBefore(null);
      setPrompt('');
      setReady(true);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function loadOlder() {
    setBusy(true);
    setError('');
    try {
      const history = await api<History>('/messages?before=' + nextBefore);
      setTurns(previous => [...history.turns, ...previous]);
      setNextBefore(history.nextBefore);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app">
      <header className="header">
        <div><span className="eyebrow">AI GATEWAY</span><h1>Диалог с ИИ</h1></div>
        <button className="secondary" onClick={newSession} disabled={busy || (!ready && !error)}>Новая сессия</button>
      </header>
      <p className="intro">Без регистрации. История этой сессии сохраняется автоматически.</p>
      <p className="session-note">Новая сессия начинает пустой диалог. Вернуться к предыдущей через эту форму нельзя.</p>
      {!configured && <p className="notice">Подключение к ИИ ещё не настроено. Обратитесь к администратору.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!ready && !error && <p role="status">Открываем сессию…</p>}
      {nextBefore && <button className="secondary older" onClick={loadOlder} disabled={busy}>Показать предыдущие сообщения</button>}
      <section className="history" aria-label="История диалога" aria-live="polite">
        {ready && turns.length === 0 && <div className="empty"><h2>С чего начнём?</h2><p>Задайте вопрос, попросите объяснить тему или помочь с идеей.</p></div>}
        {turns.map(turn => <article className="turn" key={turn.id}>
          <div className="message user"><span className="label">Вы</span><p>{turn.prompt}</p></div>
          <div className="message assistant"><span className="label">ИИ · {turn.model}</span>
            {turn.status === 'completed' && <p>{turn.response}</p>}
            {turn.status === 'pending' && <p role="status">Готовим ответ…</p>}
            {turn.status === 'failed' && <p className="failed">Не удалось получить ответ. Можно отправить запрос ещё раз.</p>}
          </div>
        </article>)}
      </section>
      <form onSubmit={send} className="composer">
        <label htmlFor="prompt">Ваш запрос</label>
        <textarea id="prompt" value={prompt} onChange={event => setPrompt(event.target.value)}
          placeholder="Напишите, чем вам помочь…" maxLength={8000} rows={4}
          disabled={!ready || busy || pending || !configured} required />
        <div className="form-footer"><small>{prompt.length} / 8000</small>
          <button type="submit" disabled={!ready || busy || pending || !configured || !prompt.trim()}>
            {busy || pending ? 'Подождите…' : 'Отправить запрос'}
          </button>
        </div>
      </form>
    </main>
  );
}

export default App;
