import { createHash } from 'node:crypto';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export type Window = { key: string; reset: number; pct: number };
export type UsageEvent = {
  id: string; subscription: string; at: number; model: string; input: number; cached: number;
  cacheWrite: number; output: number; status: number; complete: boolean; windows: Window[];
};
export function pressureWeight(peak: number | null, sharedDemand = true): number | null {
  return peak === null ? null : 0.25 + (sharedDemand ? 0.75 : 0) * (Math.max(0, Math.min(100, peak)) / 100) ** 2;
}
export function validEvent(e: any, now = Date.now()): e is UsageEvent {
  return e && /^[a-f0-9-]{36}$/.test(e.id) && /^[a-f0-9]{64}$/.test(e.subscription)
    && Number.isFinite(e.at) && e.at <= now + 300000 && e.at >= now - 30 * 86400000
    && typeof e.model === 'string' && e.model.length <= 160 && !/[\x00-\x1f]/.test(e.model)
    && ['input','cached','cacheWrite','output'].every(k => Number.isSafeInteger(e[k]) && e[k] >= 0 && e[k] <= 1e9)
    && e.cached <= e.input && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599
    && typeof e.complete === 'boolean' && Array.isArray(e.windows) && e.windows.length <= 12
    && e.windows.every((w: any) => typeof w.key === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(w.key)
      && Number.isFinite(w.reset) && w.reset * 1000 >= e.at - 60000 && w.reset * 1000 < e.at + 32 * 86400000
      && Number.isFinite(w.pct) && w.pct >= 0 && w.pct <= 100);
}
