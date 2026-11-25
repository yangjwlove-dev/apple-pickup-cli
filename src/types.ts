export interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

export interface TimeWindow {
  start: number;
  end: number;
}

export interface PublicStoreMeta {
  country: string;
  store: string;
  slug: string;
  name: string;
  city: string;
  directoryCountry?: string;
  directoryStatus?: string;
  timeZone?: string;
  evidenceIntervalSeconds: number | null;
  checkIntervalSeconds: number | null;
  pollingSource: string | null;
  pollingTier: string;
  pollingDegraded: boolean;
}

export interface StoreConfigItem {
  source?: string | null;
  observedIntervalSeconds?: number | null;
  config: string;
  name: string;
  checkedAt: number | null;
  availability: 'available' | 'unavailable' | 'unknown' | (string & {});
  model?: string;
  modelName?: string;
  capacity?: string;
  color?: string;
}

export interface RestockEvent {
  country: string;
  store: string;
  config: string;
  configName: string;
  time: number;
  endedAt: number | null;
  durationMinutes: number | null;
}

export interface StoreRestockWindowEvent {
  config: string;
  startedAt: number;
  endedAt: number | null;
  durationMinutes: number | null;
}

export interface StoreRestockWindow {
  count: number;
  events?: StoreRestockWindowEvent[];
  window?: TimeWindow;
  measuredHours?: number;
  unit?: string;
}

export interface StoreReliability {
  value: number | null;
  sampleSize: number;
  successes: number;
  minimumSamples: number;
  percentage: number | null;
  window?: TimeWindow;
  meaning?: string;
}

export interface PublicStoreDetail {
  generatedAt: number;
  monitoringStartedAt?: number | null;
  store: PublicStoreMeta;
  window?: TimeWindow;
  lastSuccessfulCheckAt: number | null;
  polling: string;
  checkIntervalSeconds: number | null;
  pollingTier: string;
  pollingDegraded: boolean;
  evidenceIntervalSeconds: number | null;
  source: string | null;
  configs: StoreConfigItem[];
  lastRestock: RestockEvent | null;
  restockHistory: RestockEvent[];
  medianInStockMinutes: number | null;
  availability: string;
  reliability: StoreReliability | null;
  restocks24h: StoreRestockWindow | null;
  restocks7d: StoreRestockWindow | null;
}

export interface EnrichedStore extends PublicStoreMeta {
  inStockCount: number | null;
  totalConfigs: number | null;
  restocks24h: number | null;
  restocks7d: number | null;
  medianInStockMinutes: number | null;
  lastSuccessfulCheckAt: number | null;
  availability: string;
}

export interface QuantileMetric {
  sampleSize: number;
  totalEvents?: number;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  window?: TimeWindow;
  minimumSamples?: number;
  method?: string;
  scope?: string;
  deprecated?: boolean;
}

export interface PollingTierReport {
  source: string;
  intervalSeconds: number;
  firstMeasuredAt: number | null;
  checks: number;
  checkInterval: QuantileMetric;
  observationAge: QuantileMetric;
}

export interface PublicServiceReport {
  generatedAt: number;
  scope: Record<string, unknown>;
  window: TimeWindow;
  pollingTiers: PollingTierReport[];
  alertSentLatency: QuantileMetric;
  observationAge?: QuantileMetric;
  checkInterval?: QuantileMetric;
  stores?: Array<{
    store: PublicStoreMeta;
    currentStatus?: string;
    lastSuccessfulCheckAt?: number | null;
  }>;
}

export interface PublicSummary {
  generatedAt: number;
  scope: {
    monitoredStores: number;
    polledConfigs: number;
    countries: string[];
    nationwide: boolean;
    availabilityFreshnessMs: number;
    restocks?: string;
  };
  byCountry: Record<string, { monitored: number; inStock: number }>;
  storesCurrentlyInStock: number;
  lastRestock: RestockEvent | null;
  lastRestockByCountry: Record<string, RestockEvent | null>;
  restocks24h: { count: number; window: TimeWindow };
  restocks7d: { count: number; window: TimeWindow };
  observationFreshness: QuantileMetric;
}
