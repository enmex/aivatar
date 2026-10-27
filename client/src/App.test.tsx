import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

afterEach(() => jest.restoreAllMocks());

test('restores anonymous history and sends a prompt to the backend', async () => {
  const turn = { id: '1', prompt: 'Привет', response: 'Здравствуйте', status: 'completed', model: 'test-model' };
  const fetchMock = jest.fn().mockImplementation((url: string, options: RequestInit) => {
    let data: object = {};
    if (url === '/api/health') data = { aiConfigured: true };
    if (url === '/api/messages') data = options.method === 'POST' ? { turn: { ...turn, id: '2', prompt: 'Второй вопрос' } } : { turns: [turn], nextBefore: null };
    return Promise.resolve({ ok: true, json: async () => data });
  });
  global.fetch = fetchMock;
  render(<App />);
  expect(await screen.findByText('Здравствуйте')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Ваш запрос'), { target: { value: 'Второй вопрос' } });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить запрос' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/messages', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ prompt: 'Второй вопрос' }), credentials: 'same-origin',
  })));
  await waitFor(() => expect(screen.getByLabelText('Ваш запрос')).toHaveValue(''));
  expect(await screen.findByText('Второй вопрос')).toBeInTheDocument();
});

test('shows an initialization error and prevents sending', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'Сервер недоступен' } }) });
  render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступен');
  expect(screen.getByRole('button', { name: 'Отправить запрос' })).toBeDisabled();
});
