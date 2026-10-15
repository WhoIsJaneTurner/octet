import { useCallback, useEffect, useRef, useState } from 'react';
import type { State } from './types';

const token = document.querySelector('meta[name=octet-token]')?.getAttribute('content') ?? '';

export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

const OUTPUT_CAP = 100_000;

export function useOctet() {
  const [state, setState] = useState<State | null>(null);
  const [online, setOnline] = useState(false);
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setState(await api<State>('/api/state'));
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.addEventListener('change', () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void refresh(), 80);
    });
    es.addEventListener('output', (e) => {
      const { beadId, text } = JSON.parse((e as MessageEvent<string>).data) as { beadId: string; text: string };
      setOutputs((o) => ({ ...o, [beadId]: ((o[beadId] ?? '') + text).slice(-OUTPUT_CAP) }));
    });
    es.onopen = () => { setOnline(true); void refresh(); };
    es.onerror = () => setOnline(false);
    return () => es.close();
  }, [refresh]);

  const loadOutput = useCallback(async (beadId: string) => {
    const { output } = await api<{ output: string }>(`/api/beads/${beadId}/output`);
    setOutputs((o) => (o[beadId] ? o : { ...o, [beadId]: output }));
  }, []);

  return { state, online, outputs, loadOutput, refresh };
}
