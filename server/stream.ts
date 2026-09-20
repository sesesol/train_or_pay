import type { Response } from 'express';

/** Invalidation only: never broadcast profile values, PINs or training records. */
export function storageChangeEvent(key: string) {
  if (!key.startsWith('session:')) return null;
  return `event: storage_change\ndata: ${JSON.stringify({ key, ts: Date.now() })}\n\n`;
}
export class StorageStream {
  private clients = new Map<Response, ReturnType<typeof setInterval>>();
  add(res: Response) {
    const close = () => {
      clearInterval(this.clients.get(res));
      this.clients.delete(res);
      if (!res.writableEnded) res.end();
    };
    const send = (payload: string) => {
      // Do not accumulate an unbounded write buffer for a disconnected/slow browser.
      try { if (res.destroyed || res.writableEnded || !res.write(payload)) close(); }
      catch { close(); }
    };
    const heartbeat = setInterval(() => send(': keepalive\n\n'), 20000);
    heartbeat.unref();
    this.clients.set(res, heartbeat);
    res.once('close', close);
    res.once('error', close);
    send('event: connected\ndata: {"status":"connected"}\n\n');
  }
  notify(key: string) {
    const event = storageChangeEvent(key);
    if (!event) return;
    for (const [res, timer] of this.clients) {
      let failed = res.destroyed || res.writableEnded;
      try { if (!failed) failed = !res.write(event); } catch { failed = true; }
      if (failed) {
        clearInterval(timer); this.clients.delete(res); res.end();
      }
    }
  }
}
