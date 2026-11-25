import { combineAbortSignals } from './abort.js';
import {
  fetchStoreDetail,
  filterConfigsBySku,
  type ApiClientOptions,
} from './api.js';
import { formatRelativeTime } from './format.js';
import {
  dispatchAlerts,
  type NotifyOptions,
  type NotifyResult,
  type RestockAlertEvent,
} from './notify.js';
import type { PublicStoreDetail, StoreConfigItem } from './types.js';

export const MIN_WATCH_INTERVAL_SECONDS = 10;
export const MAX_WATCH_INTERVAL_SECONDS = 86_400;
export const DEFAULT_WATCH_INTERVAL_SECONDS = 15;

export interface NormalizedInterval {
  intervalSeconds: number;
  requestedSeconds: number;
  clamped: boolean;
}

export interface TransitionResult {
  newlyAvailable: StoreConfigItem[];
  currentInStock: Set<string>;
}

export interface WatchOptions {
  country: string;
  slug: string;
  skuFilter?: string;
  intervalSeconds?: number;
  barkUrl?: string;
  webhookUrl?: string;
  once?: boolean;
  bell?: boolean;
  signal?: AbortSignal;
  apiOptions?: ApiClientOptions;
  notifyOptions?: NotifyOptions;
  fetchDetailFn?: (
    country: string,
    slug: string,
    options?: ApiClientOptions,
  ) => Promise<PublicStoreDetail>;
  dispatchAlertsFn?: typeof dispatchAlerts;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onWrite?: (line: string) => void;
  onError?: (line: string) => void;
  nowFn?: () => number;
}

export interface WatchSummary {
  cycles: number;
  alertsTriggered: number;
  notifiedSkus: string[];
  lastNotifyResults: NotifyResult[];
  lastDetail: PublicStoreDetail | null;
  lastError: Error | null;
}

export function normalizeWatchInterval(intervalSeconds?: number): NormalizedInterval {
  if (intervalSeconds === undefined) {
    return {
      intervalSeconds: DEFAULT_WATCH_INTERVAL_SECONDS,
      requestedSeconds: DEFAULT_WATCH_INTERVAL_SECONDS,
      clamped: false,
    };
  }
  if (
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds <= 0 ||
    intervalSeconds > MAX_WATCH_INTERVAL_SECONDS
  ) {
    throw new Error(
      `Invalid --interval "${intervalSeconds}". Provide a number of seconds between ${MIN_WATCH_INTERVAL_SECONDS} and ${MAX_WATCH_INTERVAL_SECONDS}.`,
    );
  }
  if (intervalSeconds < MIN_WATCH_INTERVAL_SECONDS) {
    return {
      intervalSeconds: MIN_WATCH_INTERVAL_SECONDS,
      requestedSeconds: intervalSeconds,
      clamped: true,
    };
  }
  return {
    intervalSeconds,
    requestedSeconds: intervalSeconds,
    clamped: false,
  };
}

export function detectNewRestocks(
  previousInStock: ReadonlySet<string>,
  configs: readonly StoreConfigItem[],
): TransitionResult {
  const currentInStock = new Set<string>();
  const newlyAvailable: StoreConfigItem[] = [];

  for (const cfg of configs) {
    if (cfg.availability === 'available') {
      currentInStock.add(cfg.config);
      if (!previousInStock.has(cfg.config)) {
        newlyAvailable.push(cfg);
      }
    } else if (cfg.availability === 'unknown' && previousInStock.has(cfg.config)) {
      currentInStock.add(cfg.config);
    }
  }

  return { newlyAvailable, currentInStock };
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildStoreTelemetryUrl(country: string, slug: string): string {
  return `https://restockcheck.com/${encodeURIComponent(country)}/stores/${encodeURIComponent(slug)}`;
}

function formatClock(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(11, 19);
}

export async function runWatchLoop(options: WatchOptions): Promise<WatchSummary> {
  const { intervalSeconds, clamped, requestedSeconds } = normalizeWatchInterval(
    options.intervalSeconds,
  );
  const write = options.onWrite ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeErr = options.onError ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fetchDetail = options.fetchDetailFn ?? fetchStoreDetail;
  const dispatch = options.dispatchAlertsFn ?? dispatchAlerts;
  const sleep = options.sleepFn ?? abortableSleep;
  const nowFn = options.nowFn ?? Date.now;
  const ringBell = options.bell ?? true;

  if (clamped) {
    writeErr(
      `[warn] Minimum safe watch interval is ${MIN_WATCH_INTERVAL_SECONDS}s; clamping --interval from ${requestedSeconds}s to ${intervalSeconds}s.`,
    );
  }

  const target = `${options.country}/${options.slug}`;
  const modeLabel = options.once ? 'single-shot (--once)' : `every ${intervalSeconds}s`;
  const skuLabel = options.skuFilter ? ` · sku="${options.skuFilter}"` : '';
  const channelLabels = [
    options.barkUrl ? 'bark' : null,
    options.webhookUrl ? 'webhook' : null,
  ].filter(Boolean);
  const alertsLabel = channelLabels.length > 0 ? ` · alerts=${channelLabels.join(',')}` : '';

  write(`Watching ${target} (${modeLabel}${skuLabel}${alertsLabel})`);

  let previousInStock = new Set<string>();
  let cycles = 0;
  let alertsTriggered = 0;
  const notifiedSkus: string[] = [];
  let lastNotifyResults: NotifyResult[] = [];
  let lastDetail: PublicStoreDetail | null = null;
  let lastError: Error | null = null;

  const combinedWatch = combineAbortSignals([options.signal, options.apiOptions?.signal]);
  const watchSignal = combinedWatch?.signal;
  const pollApiOptions: ApiClientOptions | undefined =
    watchSignal || options.apiOptions
      ? {
          ...options.apiOptions,
          ...(watchSignal ? { signal: watchSignal } : {}),
        }
      : undefined;

  const combinedNotify = combineAbortSignals([watchSignal, options.notifyOptions?.signal]);
  const notifySignal = combinedNotify?.signal;
  const dispatchNotifyOptions: NotifyOptions | undefined =
    notifySignal || options.notifyOptions
      ? {
          ...options.notifyOptions,
          ...(notifySignal ? { signal: notifySignal } : {}),
        }
      : undefined;

  try {
    while (!watchSignal?.aborted) {
      cycles += 1;
      const cycleNow = nowFn();
      const clock = formatClock(cycleNow);

      try {
        const detail = await fetchDetail(options.country, options.slug, pollApiOptions);
        if (watchSignal?.aborted) {
          break;
        }
        lastDetail = detail;
        lastError = null;

        const matchedConfigs = filterConfigsBySku(detail.configs ?? [], options.skuFilter);
        const { newlyAvailable, currentInStock } = detectNewRestocks(
          previousInStock,
          matchedConfigs,
        );

        const age = formatRelativeTime(detail.lastSuccessfulCheckAt, cycleNow);
        const total = matchedConfigs.length;
        const availableCount = matchedConfigs.filter(
          (cfg) => cfg.availability === 'available',
        ).length;

        if (newlyAvailable.length > 0) {
          const bellPrefix = ringBell ? '\x07' : '';
          const skuList = newlyAvailable
            .map((item) => `${item.name.replace(/\s*\([^)]+\)\s*$/, '')} (${item.config})`)
            .join(', ');
          write(
            `${bellPrefix}[${clock}] RESTOCK DETECTED at Apple ${detail.store.name}: ${skuList} [${availableCount}/${total} in stock · checked ${age}]`,
          );

          const hasExternalChannels = Boolean(options.barkUrl || options.webhookUrl);
          if (hasExternalChannels) {
            if (watchSignal?.aborted) {
              break;
            }
            const event: RestockAlertEvent = {
              country: detail.store.country,
              slug: detail.store.slug,
              storeId: detail.store.store,
              storeName: detail.store.name,
              city: detail.store.city,
              checkedAt: detail.lastSuccessfulCheckAt ?? cycleNow,
              skus: newlyAvailable,
              storeUrl: buildStoreTelemetryUrl(detail.store.country, detail.store.slug),
            };
            lastNotifyResults = await dispatch({
              event,
              barkUrl: options.barkUrl,
              webhookUrl: options.webhookUrl,
              options: dispatchNotifyOptions,
            });
            if (watchSignal?.aborted) {
              break;
            }
            for (const result of lastNotifyResults) {
              if (result.ok) {
                write(
                  `[${clock}] Alert sent via ${result.channel}${result.provider ? ` (${result.provider})` : ''} [HTTP ${result.status ?? 200}]`,
                );
              } else {
                writeErr(
                  `[${clock}] Alert failed via ${result.channel}${result.provider ? ` (${result.provider})` : ''}: ${result.error ?? 'unknown error'}`,
                );
              }
            }

            const anyDelivered = lastNotifyResults.some((result) => result.ok);
            if (anyDelivered) {
              previousInStock = currentInStock;
              alertsTriggered += 1;
              for (const item of newlyAvailable) {
                notifiedSkus.push(item.config);
              }
            } else {
              const retainedInStock = new Set(currentInStock);
              for (const item of newlyAvailable) {
                retainedInStock.delete(item.config);
              }
              previousInStock = retainedInStock;
              writeErr(
                `[${clock}] All configured notification channels failed; will retry ${newlyAvailable.length} SKU(s) on next poll.`,
              );
            }
          } else {
            previousInStock = currentInStock;
            alertsTriggered += 1;
            for (const item of newlyAvailable) {
              notifiedSkus.push(item.config);
            }
          }
        } else {
          previousInStock = currentInStock;
          const statusSummary =
            total === 0
              ? 'no matching SKUs'
              : availableCount > 0
                ? `${availableCount}/${total} in stock (already alerted)`
                : `0/${total} in stock`;
          write(`[${clock}] ${target} — ${statusSummary} · last observation ${age}`);
        }
      } catch (error) {
        if (watchSignal?.aborted) {
          break;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        writeErr(`[${clock}] Poll error for ${target}: ${lastError.message}`);
      }

      if (options.once || watchSignal?.aborted) {
        break;
      }

      await sleep(intervalSeconds * 1_000, watchSignal);
    }
  } finally {
    combinedNotify?.cleanup();
    combinedWatch?.cleanup();
  }

  return {
    cycles,
    alertsTriggered,
    notifiedSkus,
    lastNotifyResults,
    lastDetail,
    lastError,
  };
}
