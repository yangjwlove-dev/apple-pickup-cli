import {
  createTimeoutSignal,
  sanitizeErrorMessage,
  sanitizeUrlForLog,
} from './abort.js';
import type {
  ApiEnvelope,
  EnrichedStore,
  PublicServiceReport,
  PublicStoreDetail,
  PublicStoreMeta,
  PublicSummary,
  RestockEvent,
  StoreConfigItem,
} from './types.js';

export const DEFAULT_API_BASE = 'https://restockcheck.com/api/stock/public';
export const CLI_VERSION = '0.1.0';
export const USER_AGENT = `apple-pickup-cli/${CLI_VERSION}`;
export const SUPPORTED_COUNTRIES = ['us', 'gb', 'jp', 'cn'] as const;

export type SupportedCountry = (typeof SUPPORTED_COUNTRIES)[number];

export interface ApiClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  signal?: AbortSignal;
}

export interface StoreFilterOptions {
  country?: string;
  active?: boolean;
}

export class ApiError extends Error {
  readonly status?: number;
  readonly code?: number;
  readonly url?: string;

  constructor(
    message: string,
    details?: { status?: number; code?: number; url?: string },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = details?.status;
    this.code = details?.code;
    this.url = details?.url;
  }
}

export function normalizeBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? process.env.RESTOCKCHECK_API_BASE ?? DEFAULT_API_BASE).trim();
  return raw.replace(/\/+$/, '');
}

export function parseStoreTarget(target: string): { country: string; slug: string } {
  const cleaned = target.trim().replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid store target "${target}". Expected <country>/<slug>, e.g. us/soho-r032 or gb/regent-street-r092.`,
    );
  }
  const country = parts[0].toLowerCase();
  const slug = parts[1].toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) {
    throw new Error(
      `Invalid country code "${parts[0]}". Expected a 2-letter country code such as us, gb, jp, or cn.`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(
      `Invalid store slug "${parts[1]}". Expected lowercase letters, digits, and hyphens (e.g. soho-r032).`,
    );
  }
  return { country, slug };
}

export function isStoreActive(store: Pick<PublicStoreMeta, 'pollingTier' | 'checkIntervalSeconds'>): boolean {
  return store.pollingTier !== 'paused' && store.checkIntervalSeconds !== null;
}

export function filterStores(
  stores: readonly PublicStoreMeta[],
  options: StoreFilterOptions = {},
): PublicStoreMeta[] {
  const countryFilter = options.country?.trim().toLowerCase();
  return stores.filter((store) => {
    if (countryFilter && store.country.toLowerCase() !== countryFilter) {
      return false;
    }
    if (options.active && !isStoreActive(store)) {
      return false;
    }
    return true;
  });
}

export function filterConfigsBySku(
  configs: readonly StoreConfigItem[],
  skuFilter?: string,
): StoreConfigItem[] {
  const needle = skuFilter?.trim().toLowerCase();
  if (!needle) return [...configs];
  return configs.filter((item) => {
    const haystack = [
      item.config,
      item.name,
      item.model,
      item.modelName,
      item.capacity,
      item.color,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function filterRestocksBySku(
  events: readonly RestockEvent[],
  skuFilter?: string,
): RestockEvent[] {
  const needle = skuFilter?.trim().toLowerCase();
  if (!needle) return [...events];
  return events.filter((item) => {
    const haystack = `${item.config} ${item.configName}`.toLowerCase();
    return haystack.includes(needle);
  });
}

export async function fetchPublicJson<T>(
  path: string,
  options: ApiClientOptions = {},
): Promise<T> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${baseUrl}${normalizedPath}`;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const userAgent = options.userAgent ?? USER_AGENT;
  const safeUrl = sanitizeUrlForLog(url, true);
  const { signal: requestSignal, cleanup } = createTimeoutSignal(timeoutMs, options.signal);

  let response: Response;
  let payload: ApiEnvelope<T>;
  try {
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
        signal: requestSignal,
      });
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      throw new ApiError(
        `Network request failed for ${safeUrl}: ${sanitizeErrorMessage(rawMsg)}`,
        { url: safeUrl },
      );
    }

    try {
      payload = (await response.json()) as ApiEnvelope<T>;
    } catch (error) {
      if (requestSignal.aborted) {
        const rawMsg = error instanceof Error ? error.message : String(error);
        throw new ApiError(
          `Network request failed for ${safeUrl}: ${sanitizeErrorMessage(rawMsg)}`,
          { status: response.status, url: safeUrl },
        );
      }
      throw new ApiError(
        `HTTP ${response.status} from ${safeUrl} (non-JSON response)`,
        { status: response.status, url: safeUrl },
      );
    }
  } finally {
    cleanup();
  }

  if (!response.ok) {
    throw new ApiError(
      `HTTP ${response.status} from ${safeUrl}: ${sanitizeErrorMessage(payload.message ?? response.statusText)}`,
      { status: response.status, code: payload.code, url: safeUrl },
    );
  }

  if (payload.code !== 0 || payload.data === undefined) {
    throw new ApiError(
      `API error from ${safeUrl}: ${sanitizeErrorMessage(payload.message ?? `code ${payload.code}`)}`,
      { status: response.status, code: payload.code, url: safeUrl },
    );
  }

  return payload.data;
}

export async function fetchStores(options: ApiClientOptions = {}): Promise<PublicStoreMeta[]> {
  const data = await fetchPublicJson<{ stores: PublicStoreMeta[] }>('/stores', options);
  return Array.isArray(data.stores) ? data.stores : [];
}

export async function fetchStoreDetail(
  country: string,
  slug: string,
  options: ApiClientOptions = {},
): Promise<PublicStoreDetail> {
  const safeCountry = encodeURIComponent(country.toLowerCase());
  const safeSlug = encodeURIComponent(slug.toLowerCase());
  return fetchPublicJson<PublicStoreDetail>(`/store/${safeCountry}/${safeSlug}`, options);
}

export async function fetchSummary(options: ApiClientOptions = {}): Promise<PublicSummary> {
  return fetchPublicJson<PublicSummary>('/summary', options);
}

export async function fetchServiceReport(
  options: ApiClientOptions = {},
): Promise<PublicServiceReport> {
  return fetchPublicJson<PublicServiceReport>('/service-report', options);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function next(): Promise<void> {
    while (cursor < items.length) {
      const current = cursor++;
      results[current] = await worker(items[current]!, current);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => next()));
  return results;
}

export function sortEnrichedStores(stores: readonly EnrichedStore[]): EnrichedStore[] {
  return [...stores].sort((a, b) => {
    const aActive = isStoreActive(a) ? 1 : 0;
    const bActive = isStoreActive(b) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;

    const aStock = a.inStockCount ?? -1;
    const bStock = b.inStockCount ?? -1;
    if (aStock !== bStock) return bStock - aStock;

    const a7d = a.restocks7d ?? -1;
    const b7d = b.restocks7d ?? -1;
    if (a7d !== b7d) return b7d - a7d;

    const aKey = `${a.country}/${a.slug}`;
    const bKey = `${b.country}/${b.slug}`;
    return aKey.localeCompare(bKey);
  });
}

export async function fetchEnrichedStores(
  filter: StoreFilterOptions = {},
  options: ApiClientOptions & { concurrency?: number } = {},
): Promise<{ totalMonitored: number; stores: EnrichedStore[] }> {
  const allStores = await fetchStores(options);
  const matched = filterStores(allStores, filter);
  const concurrency = options.concurrency ?? 6;

  const enriched = await mapWithConcurrency(matched, concurrency, async (meta) => {
    try {
      const detail = await fetchStoreDetail(meta.country, meta.slug, options);
      const configs = Array.isArray(detail.configs) ? detail.configs : [];
      const inStockCount = configs.filter((c) => c.availability === 'available').length;
      return {
        ...meta,
        inStockCount,
        totalConfigs: configs.length,
        restocks24h: detail.restocks24h?.count ?? 0,
        restocks7d: detail.restocks7d?.count ?? 0,
        medianInStockMinutes: detail.medianInStockMinutes ?? null,
        lastSuccessfulCheckAt: detail.lastSuccessfulCheckAt ?? null,
        availability: detail.availability ?? 'unknown',
      } satisfies EnrichedStore;
    } catch {
      return {
        ...meta,
        inStockCount: null,
        totalConfigs: null,
        restocks24h: null,
        restocks7d: null,
        medianInStockMinutes: null,
        lastSuccessfulCheckAt: null,
        availability: 'unknown',
      } satisfies EnrichedStore;
    }
  });

  return {
    totalMonitored: allStores.length,
    stores: sortEnrichedStores(enriched),
  };
}
