export type PushPayload = { title: string; body: string; url: string; tag?: string };

export async function triggerPush(userId: string, payload: PushPayload): Promise<void> {
  const url = process.env.INTERNAL_PUSH_URL;
  const secret = process.env.INTERNAL_PUSH_SECRET;
  if (!url || !secret) return; // feature-gated
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ userId, payload }),
      signal: controller.signal,
    });
    if (!res.ok) console.warn('[push-trigger] non-2xx', res.status);
  } catch (err) {
    console.error('[push-trigger]', err);
  } finally {
    clearTimeout(timeout);
  }
}
