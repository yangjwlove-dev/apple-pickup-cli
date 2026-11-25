import { describe, expect, it, vi } from 'vitest';
import {
  combineAbortSignals,
  createTimeoutSignal,
  sanitizeErrorMessage,
  sanitizeUrlForLog,
} from '../src/abort.js';
import {
  ApiError,
  USER_AGENT,
  fetchEnrichedStores,
  fetchPublicJson,
  filterConfigsBySku,
  filterRestocksBySku,
  filterStores,
  parseStoreTarget,
} from '../src/api.js';
import type { PublicStoreDetail, PublicStoreMeta, RestockEvent, StoreConfigItem } from '../src/types.js';

const SAMPLE_STORES: PublicStoreMeta[] = [
  {
    country: 'us',
    store: 'R032',
    slug: 'soho-r032',
    name: 'SoHo',
    city: 'New York',
    evidenceIntervalSeconds: 5,
    checkIntervalSeconds: 5,
    pollingSource: 'evidence',
    pollingTier: 'evidence_5s',
    pollingDegraded: false,
  },
  {
    country: 'us',
    store: 'R035',
    slug: 'michigan-avenue-r035',
    name: 'Michigan Avenue',
    city: 'Chicago',
    evidenceIntervalSeconds: 60,
    checkIntervalSeconds: null,
    pollingSource: null,
    pollingTier: 'paused',
    pollingDegraded: true,
  },
  {
    country: 'gb',
    store: 'R092',
    slug: 'regent-street-r092',
    name: 'Regent Street',
    city: 'London',
    evidenceIntervalSeconds: 5,
    checkIntervalSeconds: 5,
    pollingSource: 'evidence',
    pollingTier: 'evidence_5s',
    pollingDegraded: false,
  },
];

const SAMPLE_CONFIGS: StoreConfigItem[] = [
  {
    config: 'MK2D4QN/A',
    name: 'iPhone Duo 256GB Star White (MK2D4QN/A)',
    checkedAt: 1795607442865,
    availability: 'available',
    model: 'iphoneduo',
    modelName: 'iPhone Duo',
    capacity: '256GB',
    color: 'Star White',
  },
  {
    config: 'MK2K4QN/A',
    name: 'iPhone Duo 2TB Night Sky (MK2K4QN/A)',
    checkedAt: 1795607442865,
    availability: 'unavailable',
    model: 'iphoneduo',
    modelName: 'iPhone Duo',
    capacity: '2TB',
    color: 'Night Sky',
  },
];

describe('api helpers', () => {
  it('filters stores by country and active flag', () => {
    expect(filterStores(SAMPLE_STORES, { country: 'US' }).map((s) => s.slug)).toEqual([
      'soho-r032',
      'michigan-avenue-r035',
    ]);
    expect(filterStores(SAMPLE_STORES, { active: true }).map((s) => s.slug)).toEqual([
      'soho-r032',
      'regent-street-r092',
    ]);
    expect(
      filterStores(SAMPLE_STORES, { country: 'us', active: true }).map((s) => s.slug),
    ).toEqual(['soho-r032']);
  });

  it('filters configs and restock events by SKU, capacity, or color', () => {
    expect(filterConfigsBySku(SAMPLE_CONFIGS, 'mk2d4qn/a')).toHaveLength(1);
    expect(filterConfigsBySku(SAMPLE_CONFIGS, '2TB')).toHaveLength(1);
    expect(filterConfigsBySku(SAMPLE_CONFIGS, 'star white')[0]?.config).toBe('MK2D4QN/A');
    expect(filterConfigsBySku(SAMPLE_CONFIGS)).toHaveLength(2);

    const events: RestockEvent[] = [
      {
        country: 'gb',
        store: 'R092',
        config: 'MK2D4QN/A',
        configName: 'iPhone Duo 256GB Star White (MK2D4QN/A)',
        time: 1795605166361,
        endedAt: null,
        durationMinutes: null,
      },
      {
        country: 'gb',
        store: 'R092',
        config: 'MK2K4QN/A',
        configName: 'iPhone Duo 2TB Night Sky (MK2K4QN/A)',
        time: 1795600000000,
        endedAt: 1795600180000,
        durationMinutes: 3,
      },
    ];
    expect(filterRestocksBySku(events, 'night sky')).toHaveLength(1);
  });

  it('parses and validates <country>/<slug> store targets', () => {
    expect(parseStoreTarget('GB/Regent-Street-R092')).toEqual({
      country: 'gb',
      slug: 'regent-street-r092',
    });
    expect(() => parseStoreTarget('regent-street-r092')).toThrow(/Expected <country>\/<slug>/);
    expect(() => parseStoreTarget('usa/soho-r032')).toThrow(/Invalid country code/);
    expect(() => parseStoreTarget('us/soho r032')).toThrow(/Invalid store slug/);
  });

  it('sends custom User-Agent header and unwraps API envelope', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['User-Agent']).toBe(USER_AGENT);
      return new Response(JSON.stringify({ code: 0, message: 'ok', data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const data = await fetchPublicJson<{ ok: boolean }>('/summary', {
      baseUrl: 'https://example.test/api/stock/public/',
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/stock/public/summary',
      expect.any(Object),
    );
  });

  it('throws ApiError on HTTP error or non-zero code', async () => {
    const fetchErr = vi.fn(async () =>
      new Response(JSON.stringify({ code: 404, message: 'Store not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      fetchPublicJson('/store/us/missing', { fetchFn: fetchErr as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('aborts in-flight requests immediately when caller AbortSignal fires', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    const promise = fetchPublicJson('/summary', {
      fetchFn: fetchMock as unknown as typeof fetch,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
    controller.abort();
    expect(capturedSignal?.aborted).toBe(true);

    await expect(promise).rejects.toBeInstanceOf(ApiError);
  });

  it('supports createTimeoutSignal timeout and cleanup without AbortSignal.any', async () => {
    vi.useFakeTimers();
    try {
      const external = new AbortController();
      const managed = createTimeoutSignal(500, external.signal);
      expect(managed.signal.aborted).toBe(false);
      vi.advanceTimersByTime(500);
      expect(managed.signal.aborted).toBe(true);
      managed.cleanup();

      const external2 = new AbortController();
      const managed2 = createTimeoutSignal(5_000, external2.signal);
      managed2.cleanup();
      vi.advanceTimersByTime(5_000);
      expect(managed2.signal.aborted).toBe(false);

      const a = new AbortController();
      const b = new AbortController();
      const combined = combineAbortSignals([a.signal, b.signal]);
      expect(combined?.signal.aborted).toBe(false);
      b.abort('cancelled');
      expect(combined?.signal.aborted).toBe(true);
      combined?.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sanitizes credentials and secret tokens from API error messages and URLs', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED https://alice:supersecret@example.test/api?token=xyz123');
    });

    await expect(
      fetchPublicJson('/summary', {
        baseUrl: 'https://alice:supersecret@example.test/api/stock/public',
        fetchFn: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const msg = (err as ApiError).message;
      expect(msg).not.toContain('supersecret');
      expect(msg).not.toContain('xyz123');
      expect(msg).not.toContain('alice');
      expect((err as ApiError).url).toBe('https://example.test/api/stock/public/summary');
      return true;
    });

    expect(sanitizeUrlForLog('https://user:pass@api.day.app/SECRET_KEY?foo=bar')).toBe(
      'https://api.day.app/<redacted>',
    );
    expect(
      sanitizeErrorMessage('failed calling https://discord.com/api/webhooks/123/SECRET_TOKEN'),
    ).toBe('failed calling https://discord.com/<redacted>');

    // IPv6 host brackets and parenthesized paths must be completely redacted
    const ipv6Sanitized = sanitizeErrorMessage(
      'connect ECONNREFUSED http://[::1]:8080/hooks/TEST_SECRET.',
    );
    expect(ipv6Sanitized).toBe('connect ECONNREFUSED http://[::1]:8080/<redacted>.');
    expect(ipv6Sanitized).not.toContain('TEST_SECRET');

    const parenPathSanitized = sanitizeErrorMessage(
      'failed (https://example.test/hook/public(foo)TEST_SECRET).',
    );
    expect(parenPathSanitized).toBe('failed (https://example.test/<redacted>).');
    expect(parenPathSanitized).not.toContain('TEST_SECRET');
  });

  it('keeps AbortSignal and timeout active while consuming response.json()', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          new Promise((_resolve, reject) => {
            expect(capturedSignal?.aborted).toBe(false);
            capturedSignal?.addEventListener('abort', () => {
              reject(new DOMException('Body read aborted', 'AbortError'));
            });
            queueMicrotask(() => controller.abort());
          }),
      } as unknown as Response;
    });

    await expect(
      fetchPublicJson('/summary', {
        fetchFn: fetchMock as unknown as typeof fetch,
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toContain('Network request failed');
      expect((err as ApiError).message).not.toContain('non-JSON');
      return true;
    });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('enriches and sorts stores gracefully even if one detail call fails', async () => {
    const gbDetail: PublicStoreDetail = {
      generatedAt: 1795607463536,
      store: SAMPLE_STORES[2]!,
      lastSuccessfulCheckAt: 1795607442865,
      polling: 'active',
      checkIntervalSeconds: 5,
      pollingTier: 'evidence_5s',
      pollingDegraded: false,
      evidenceIntervalSeconds: 5,
      source: 'evidence',
      configs: SAMPLE_CONFIGS,
      lastRestock: null,
      restockHistory: [],
      medianInStockMinutes: 3.7,
      availability: 'available',
      reliability: null,
      restocks24h: { count: 9 },
      restocks7d: { count: 51 },
    };

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/stores')) {
        return new Response(JSON.stringify({ code: 0, data: { stores: SAMPLE_STORES } }), {
          status: 200,
        });
      }
      if (url.endsWith('/store/gb/regent-street-r092')) {
        return new Response(JSON.stringify({ code: 0, data: gbDetail }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 500, message: 'boom' }), { status: 500 });
    });

    const result = await fetchEnrichedStores(
      { active: true },
      { fetchFn: fetchMock as unknown as typeof fetch, concurrency: 2 },
    );

    expect(result.totalMonitored).toBe(3);
    expect(result.stores).toHaveLength(2);
    expect(result.stores[0]?.slug).toBe('regent-street-r092');
    expect(result.stores[0]?.inStockCount).toBe(1);
    expect(result.stores[0]?.restocks7d).toBe(51);
    expect(result.stores[1]?.slug).toBe('soho-r032');
    expect(result.stores[1]?.inStockCount).toBeNull();
  });
});
