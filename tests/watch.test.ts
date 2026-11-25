import { describe, expect, it, vi } from 'vitest';
import {
  MAX_WATCH_INTERVAL_SECONDS,
  MIN_WATCH_INTERVAL_SECONDS,
  detectNewRestocks,
  normalizeWatchInterval,
  runWatchLoop,
} from '../src/watch.js';
import type { PublicStoreDetail, StoreConfigItem } from '../src/types.js';

function makeConfig(
  code: string,
  availability: 'available' | 'unavailable' | 'unknown',
): StoreConfigItem {
  return {
    config: code,
    name: `iPhone Duo 256GB (${code})`,
    checkedAt: 1795607442865,
    availability,
  };
}

function makeDetail(configs: StoreConfigItem[]): PublicStoreDetail {
  return {
    generatedAt: 1795607463536,
    store: {
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
    lastSuccessfulCheckAt: 1795607442865,
    polling: 'active',
    checkIntervalSeconds: 5,
    pollingTier: 'evidence_5s',
    pollingDegraded: false,
    evidenceIntervalSeconds: 5,
    source: 'evidence',
    configs,
    lastRestock: null,
    restockHistory: [],
    medianInStockMinutes: 3.5,
    availability: configs.some((c) => c.availability === 'available') ? 'available' : 'unavailable',
    reliability: null,
    restocks24h: { count: 2 },
    restocks7d: { count: 14 },
  };
}

describe('watch transition deduplication & interval enforcement', () => {
  it('enforces minimum safe interval >= 10s', () => {
    expect(normalizeWatchInterval(undefined)).toEqual({
      intervalSeconds: 15,
      requestedSeconds: 15,
      clamped: false,
    });
    expect(normalizeWatchInterval(5)).toEqual({
      intervalSeconds: MIN_WATCH_INTERVAL_SECONDS,
      requestedSeconds: 5,
      clamped: true,
    });
    expect(normalizeWatchInterval(20)).toEqual({
      intervalSeconds: 20,
      requestedSeconds: 20,
      clamped: false,
    });
    expect(() => normalizeWatchInterval(0)).toThrow(/Invalid --interval/);
    expect(() => normalizeWatchInterval(-3)).toThrow(/Invalid --interval/);
    expect(() => normalizeWatchInterval(MAX_WATCH_INTERVAL_SECONDS + 1)).toThrow(
      /Invalid --interval/,
    );
    expect(normalizeWatchInterval(MAX_WATCH_INTERVAL_SECONDS).intervalSeconds).toBe(
      MAX_WATCH_INTERVAL_SECONDS,
    );
  });

  it('preserves previousInStock membership across unknown observations without re-alerting', () => {
    const cycle1 = detectNewRestocks(new Set(), [makeConfig('SKU-A', 'available')]);
    expect(cycle1.newlyAvailable.map((c) => c.config)).toEqual(['SKU-A']);

    // Transient unknown should preserve membership
    const cycle2 = detectNewRestocks(cycle1.currentInStock, [makeConfig('SKU-A', 'unknown')]);
    expect(cycle2.newlyAvailable).toEqual([]);
    expect(cycle2.currentInStock.has('SKU-A')).toBe(true);

    // Returning to available after unknown must NOT re-alert
    const cycle3 = detectNewRestocks(cycle2.currentInStock, [makeConfig('SKU-A', 'available')]);
    expect(cycle3.newlyAvailable).toEqual([]);

    // Explicit unavailable removes membership so subsequent available DOES re-alert
    const cycle4 = detectNewRestocks(cycle3.currentInStock, [makeConfig('SKU-A', 'unavailable')]);
    expect(cycle4.currentInStock.has('SKU-A')).toBe(false);
    const cycle5 = detectNewRestocks(cycle4.currentInStock, [makeConfig('SKU-A', 'available')]);
    expect(cycle5.newlyAvailable.map((c) => c.config)).toEqual(['SKU-A']);
  });

  it('deduplicates persistent in-stock SKUs and re-alerts only after sellout + restock', () => {
    const cycle1 = detectNewRestocks(new Set(), [
      makeConfig('SKU-A', 'available'),
      makeConfig('SKU-B', 'unavailable'),
    ]);
    expect(cycle1.newlyAvailable.map((c) => c.config)).toEqual(['SKU-A']);

    // Still in stock on cycle 2 -> no duplicate alert
    const cycle2 = detectNewRestocks(cycle1.currentInStock, [
      makeConfig('SKU-A', 'available'),
      makeConfig('SKU-B', 'unavailable'),
    ]);
    expect(cycle2.newlyAvailable).toEqual([]);

    // SKU-A sells out, SKU-B comes in stock -> only SKU-B alerts
    const cycle3 = detectNewRestocks(cycle2.currentInStock, [
      makeConfig('SKU-A', 'unavailable'),
      makeConfig('SKU-B', 'available'),
    ]);
    expect(cycle3.newlyAvailable.map((c) => c.config)).toEqual(['SKU-B']);

    // SKU-A restocks again while SKU-B stays in stock -> only SKU-A alerts
    const cycle4 = detectNewRestocks(cycle3.currentInStock, [
      makeConfig('SKU-A', 'available'),
      makeConfig('SKU-B', 'available'),
    ]);
    expect(cycle4.newlyAvailable.map((c) => c.config)).toEqual(['SKU-A']);
  });

  it('preserves dedupe state across transient network errors and clamps unsafe intervals', async () => {
    const responses: Array<PublicStoreDetail | Error> = [
      makeDetail([makeConfig('SKU-A', 'available')]),
      new Error('temporary 502'),
      makeDetail([makeConfig('SKU-A', 'available')]),
      makeDetail([makeConfig('SKU-A', 'unavailable')]),
      makeDetail([makeConfig('SKU-A', 'available')]),
    ];

    const controller = new AbortController();
    let idx = 0;
    const fetchDetailFn = vi.fn(async () => {
      const item = responses[idx++]!;
      if (item instanceof Error) throw item;
      return item;
    });

    const dispatchAlertsFn = vi.fn(async () => [{ channel: 'webhook' as const, ok: true, status: 200 }]);
    const sleeps: number[] = [];
    const sleepFn = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      if (idx >= responses.length) {
        controller.abort();
      }
    });

    const logs: string[] = [];
    const errs: string[] = [];

    const summary = await runWatchLoop({
      country: 'gb',
      slug: 'regent-street-r092',
      intervalSeconds: 3,
      webhookUrl: 'https://hooks.example.test/restock',
      signal: controller.signal,
      fetchDetailFn,
      dispatchAlertsFn,
      sleepFn,
      onWrite: (line) => logs.push(line),
      onError: (line) => errs.push(line),
      nowFn: () => 1795607463536,
    });

    expect(summary.cycles).toBe(5);
    // Cycle 1 alerted, Cycle 2 errored, Cycle 3 did NOT re-alert, Cycle 4 sold out, Cycle 5 re-alerted
    expect(summary.alertsTriggered).toBe(2);
    expect(summary.notifiedSkus).toEqual(['SKU-A', 'SKU-A']);
    expect(dispatchAlertsFn).toHaveBeenCalledTimes(2);
    expect(sleeps.every((ms) => ms === 10_000)).toBe(true);
    expect(errs.some((line) => line.includes('clamping --interval'))).toBe(true);
    expect(errs.some((line) => line.includes('temporary 502'))).toBe(true);
    expect(logs.some((line) => line.includes('\x07'))).toBe(true);
  });

  it('runs a single cycle and exits in --once mode', async () => {
    const fetchDetailFn = vi.fn(async () => makeDetail([makeConfig('SKU-A', 'unavailable')]));
    const sleepFn = vi.fn(async () => {});

    const summary = await runWatchLoop({
      country: 'gb',
      slug: 'regent-street-r092',
      once: true,
      fetchDetailFn,
      sleepFn,
      onWrite: () => {},
      onError: () => {},
    });

    expect(summary.cycles).toBe(1);
    expect(summary.alertsTriggered).toBe(0);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('passes watch AbortSignal to fetchDetail so Ctrl+C aborts mid-request cleanly', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const fetchDetailFn = vi.fn(async (_c: string, _s: string, opts?: { signal?: AbortSignal }) => {
      receivedSignal = opts?.signal;
      return new Promise<PublicStoreDetail>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
        queueMicrotask(() => controller.abort());
      });
    });

    const errs: string[] = [];
    const summary = await runWatchLoop({
      country: 'gb',
      slug: 'regent-street-r092',
      signal: controller.signal,
      fetchDetailFn,
      onWrite: () => {},
      onError: (line) => errs.push(line),
    });

    expect(receivedSignal).toBe(controller.signal);
    expect(summary.cycles).toBe(1);
    expect(summary.lastError).toBeNull();
    expect(errs).toEqual([]);
  });

  it('retries newlyAvailable SKUs when all configured channels fail while retaining previously alerted SKUs', async () => {
    const controller = new AbortController();
    const snapshots: PublicStoreDetail[] = [
      // Cycle 1: SKU-A comes in stock, webhook succeeds -> SKU-A committed
      makeDetail([makeConfig('SKU-A', 'available'), makeConfig('SKU-B', 'unavailable')]),
      // Cycle 2: SKU-B newly available alongside SKU-A; ALL channels fail -> SKU-B NOT committed, SKU-A retained
      makeDetail([makeConfig('SKU-A', 'available'), makeConfig('SKU-B', 'available')]),
      // Cycle 3: SKU-A & SKU-B still available; retry fires ONLY for SKU-B and succeeds
      makeDetail([makeConfig('SKU-A', 'available'), makeConfig('SKU-B', 'available')]),
      // Cycle 4: both still available -> no duplicate alerts
      makeDetail([makeConfig('SKU-A', 'available'), makeConfig('SKU-B', 'available')]),
    ];

    let pollIdx = 0;
    const fetchDetailFn = vi.fn(async () => snapshots[pollIdx++]!);

    const dispatchedSkuBatches: string[][] = [];
    let dispatchCall = 0;
    const dispatchAlertsFn = vi.fn(async ({ event }: { event: { skus: StoreConfigItem[] } }) => {
      dispatchCall += 1;
      dispatchedSkuBatches.push(event.skus.map((s) => s.config));
      if (dispatchCall === 1) {
        return [
          { channel: 'bark' as const, ok: false, status: 500, error: 'HTTP 500' },
          { channel: 'webhook' as const, ok: true, status: 204 },
        ];
      }
      if (dispatchCall === 2) {
        return [
          { channel: 'bark' as const, ok: false, status: 502, error: 'HTTP 502' },
          { channel: 'webhook' as const, ok: false, status: 503, error: 'HTTP 503' },
        ];
      }
      return [
        { channel: 'bark' as const, ok: true, status: 200 },
        { channel: 'webhook' as const, ok: false, status: 503, error: 'HTTP 503' },
      ];
    });

    const sleepFn = vi.fn(async () => {
      if (pollIdx >= snapshots.length) {
        controller.abort();
      }
    });

    const errs: string[] = [];
    const summary = await runWatchLoop({
      country: 'gb',
      slug: 'regent-street-r092',
      barkUrl: 'https://api.day.app/test-key',
      webhookUrl: 'https://hooks.example.test/restock',
      signal: controller.signal,
      fetchDetailFn,
      dispatchAlertsFn,
      sleepFn,
      onWrite: () => {},
      onError: (line) => errs.push(line),
      nowFn: () => 1795607463536,
    });

    expect(summary.cycles).toBe(4);
    // Cycle 1: [SKU-A] (partial success -> committed)
    // Cycle 2: [SKU-B] (total failure -> NOT committed, SKU-A retained)
    // Cycle 3: [SKU-B] (retried, partial success -> committed; SKU-A NOT re-sent)
    // Cycle 4: none
    expect(dispatchedSkuBatches).toEqual([['SKU-A'], ['SKU-B'], ['SKU-B']]);
    expect(summary.alertsTriggered).toBe(2);
    expect(summary.notifiedSkus).toEqual(['SKU-A', 'SKU-B']);
    expect(errs.some((line) => line.includes('All configured notification channels failed'))).toBe(
      true,
    );
  });

  it('uses combined watchSignal consistently across apiOptions.signal, dispatch, and sleep', async () => {
    const apiController = new AbortController();
    let dispatchReceivedSignal: AbortSignal | undefined;

    const fetchDetailFn = vi.fn(async (_c: string, _s: string, opts?: { signal?: AbortSignal }) => {
      expect(opts?.signal).toBe(apiController.signal);
      return makeDetail([makeConfig('SKU-A', 'available')]);
    });

    const dispatchAlertsFn = vi.fn(async ({ options }: { options?: { signal?: AbortSignal } }) => {
      dispatchReceivedSignal = options?.signal;
      apiController.abort();
      return [{ channel: 'webhook' as const, ok: true, status: 200 }];
    });

    const sleepFn = vi.fn(async () => {});

    const summary = await runWatchLoop({
      country: 'gb',
      slug: 'regent-street-r092',
      webhookUrl: 'https://hooks.example.test/restock',
      apiOptions: { signal: apiController.signal },
      fetchDetailFn,
      dispatchAlertsFn,
      sleepFn,
      onWrite: () => {},
      onError: () => {},
    });

    expect(dispatchReceivedSignal).toBe(apiController.signal);
    expect(summary.cycles).toBe(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});
