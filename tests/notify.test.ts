import { describe, expect, it, vi } from 'vitest';
import {
  buildBarkRequest,
  buildWebhookRequest,
  detectWebhookProvider,
  dispatchAlerts,
  sendBark,
  sendWebhook,
  type RestockAlertEvent,
} from '../src/notify.js';

const SAMPLE_EVENT: RestockAlertEvent = {
  country: 'gb',
  slug: 'regent-street-r092',
  storeId: 'R092',
  storeName: 'Regent Street',
  city: 'London',
  checkedAt: 1795607442865,
  storeUrl: 'https://restockcheck.com/gb/stores/regent-street-r092',
  skus: [
    {
      config: 'MK2D4QN/A',
      name: 'iPhone Duo 256GB Star White (MK2D4QN/A)',
      checkedAt: 1795607442865,
      availability: 'available',
      capacity: '256GB',
      color: 'Star White',
    },
  ],
};

describe('notify payload builders & dispatch', () => {
  it('detects Discord, Slack, Telegram, and generic webhook providers', () => {
    expect(detectWebhookProvider('https://discord.com/api/webhooks/123/abc')).toBe('discord');
    expect(detectWebhookProvider('https://hooks.slack.com/services/T00/B00/XXX')).toBe('slack');
    expect(
      detectWebhookProvider('https://api.telegram.org/bot123:abc/sendMessage?chat_id=999'),
    ).toBe('telegram');
    expect(detectWebhookProvider('https://example.com/hooks/apple')).toBe('generic');
  });

  it('builds Discord embed payload', () => {
    const req = buildWebhookRequest('https://discord.com/api/webhooks/123/abc', SAMPLE_EVENT);
    expect(req.provider).toBe('discord');
    expect(req.body.content).toContain('Apple Regent Street');
    const embeds = req.body.embeds as Array<{ color: number; description: string }>;
    expect(embeds).toHaveLength(1);
    expect(embeds[0]?.color).toBe(0x22c55e);
    expect(embeds[0]?.description).toContain('MK2D4QN/A');
  });

  it('builds Slack block kit payload', () => {
    const req = buildWebhookRequest('https://hooks.slack.com/services/T00/B00/XXX', SAMPLE_EVENT);
    expect(req.provider).toBe('slack');
    expect(req.body.text).toContain('MK2D4QN/A');
    expect(Array.isArray(req.body.blocks)).toBe(true);
  });

  it('builds Telegram HTML payload and extracts chat_id from query string', () => {
    const req = buildWebhookRequest(
      'https://api.telegram.org/bot123:abc/sendMessage?chat_id=-10042',
      SAMPLE_EVENT,
    );
    expect(req.provider).toBe('telegram');
    expect(req.targetUrl).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(req.body.chat_id).toBe('-10042');
    expect(req.body.parse_mode).toBe('HTML');
    expect(req.body.text).toContain('<code>MK2D4QN/A</code>');
  });

  it('builds generic JSON webhook payload', () => {
    const req = buildWebhookRequest('https://example.com/webhook', SAMPLE_EVENT);
    expect(req.provider).toBe('generic');
    expect(req.body.event).toBe('restock');
    expect(req.body.slug).toBe('regent-street-r092');
    expect((req.body.skus as Array<{ sku: string }>)[0]?.sku).toBe('MK2D4QN/A');
  });

  it('builds Bark JSON push payload and strips trailing slash', () => {
    const req = buildBarkRequest('https://api.day.app/my-device-key/', SAMPLE_EVENT);
    expect(req.targetUrl).toBe('https://api.day.app/my-device-key');
    expect(req.body.title).toContain('Apple Regent Street');
    expect(req.body.group).toBe('apple-pickup-cli');
    expect(req.body.url).toBe(SAMPLE_EVENT.storeUrl);
  });

  it('dispatches Bark and webhook in parallel and reports per-channel results', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('day.app')) {
        return new Response(JSON.stringify({ code: 200 }), { status: 200 });
      }
      return new Response('rate limited', { status: 429, statusText: 'Too Many Requests' });
    });

    const results = await dispatchAlerts({
      event: SAMPLE_EVENT,
      barkUrl: 'https://api.day.app/test-key',
      webhookUrl: 'https://discord.com/api/webhooks/1/2',
      options: { fetchFn: fetchMock as unknown as typeof fetch },
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ channel: 'bark', ok: true, status: 200 });
    expect(results[1]).toMatchObject({
      channel: 'webhook',
      provider: 'discord',
      ok: false,
      status: 429,
    });
  });

  it('rejects embedded credentials in Bark/webhook URLs without echoing raw URLs', () => {
    expect(() =>
      buildBarkRequest('https://user:secretpass@api.day.app/MY_DEVICE_KEY', SAMPLE_EVENT),
    ).toThrow(/embedded credentials/);
    try {
      buildBarkRequest('https://user:secretpass@api.day.app/MY_DEVICE_KEY', SAMPLE_EVENT);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('secretpass');
      expect(msg).not.toContain('MY_DEVICE_KEY');
    }

    expect(() =>
      buildWebhookRequest('https://bot:tok@hooks.slack.com/services/A/B/C', SAMPLE_EVENT),
    ).toThrow(/embedded credentials/);
  });

  it('cancels response bodies on both ok and non-ok responses and sanitizes network errors', async () => {
    const cancelOk = vi.fn(async () => {});
    const cancelErr = vi.fn(async () => {});

    const fetchOk = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: { cancel: cancelOk },
    }));
    const fetchErr = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: { cancel: cancelErr },
    }));

    const r1 = await sendBark('https://api.day.app/key', SAMPLE_EVENT, {
      fetchFn: fetchOk as unknown as typeof fetch,
    });
    const r2 = await sendWebhook('https://example.com/hook', SAMPLE_EVENT, {
      fetchFn: fetchErr as unknown as typeof fetch,
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(cancelOk).toHaveBeenCalledTimes(1);
    expect(cancelErr).toHaveBeenCalledTimes(1);

    const fetchLeak = vi.fn(async () => {
      throw new Error('fetch failed: https://api.telegram.org/bot999:SECRET/sendMessage?chat_id=1');
    });
    const r3 = await sendWebhook(
      'https://api.telegram.org/bot999:SECRET/sendMessage?chat_id=1',
      SAMPLE_EVENT,
      { fetchFn: fetchLeak as unknown as typeof fetch },
    );
    expect(r3.ok).toBe(false);
    expect(r3.error).not.toContain('SECRET');
    expect(r3.error).not.toContain('bot999');

    const fetchStatusTextLeak = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden for https://discord.com/api/webhooks/123/STATUS_SECRET_TOKEN',
      body: { cancel: vi.fn(async () => {}) },
    }));
    const r4 = await sendWebhook(
      'https://discord.com/api/webhooks/123/STATUS_SECRET_TOKEN',
      SAMPLE_EVENT,
      { fetchFn: fetchStatusTextLeak as unknown as typeof fetch },
    );
    expect(r4.ok).toBe(false);
    expect(r4.status).toBe(403);
    expect(r4.error).not.toContain('STATUS_SECRET_TOKEN');
    expect(r4.error).toContain('https://discord.com/<redacted>');
  });

  it('aborts in-flight notification requests when NotifyOptions.signal aborts', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    const pending = sendWebhook('https://example.com/hook', SAMPLE_EVENT, {
      fetchFn: fetchMock as unknown as typeof fetch,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    expect(seenSignal?.aborted).toBe(false);
    controller.abort();
    expect(seenSignal?.aborted).toBe(true);

    const result = await pending;
    expect(result.ok).toBe(false);
  });
});
