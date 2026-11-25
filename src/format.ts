import { isStoreActive } from './api.js';
import type {
  EnrichedStore,
  PollingTierReport,
  PublicServiceReport,
  PublicStoreDetail,
  PublicStoreMeta,
  RestockEvent,
  StoreConfigItem,
} from './types.js';

export type ColumnAlign = 'left' | 'right';

export interface FormatOptions {
  color?: boolean;
  nowMs?: number;
}

const ANSI_REGEX = /\x1B\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

export function shouldUseColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY);
}

function makeStyle(enabled: boolean) {
  const wrap = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    green: wrap('32'),
    yellow: wrap('33'),
    red: wrap('31'),
    cyan: wrap('36'),
    boldGreen: wrap('1;32'),
    boldCyan: wrap('1;36'),
  };
}

export function padCell(text: string, width: number, align: ColumnAlign = 'left'): string {
  const visible = stripAnsi(text).length;
  const pad = Math.max(0, width - visible);
  return align === 'right' ? `${' '.repeat(pad)}${text}` : `${text}${' '.repeat(pad)}`;
}

export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  alignments: readonly ColumnAlign[] = [],
  color = false,
): string {
  const s = makeStyle(color);
  const widths = headers.map((header, idx) => {
    let max = stripAnsi(header).length;
    for (const row of rows) {
      const cell = row[idx] ?? '';
      const len = stripAnsi(cell).length;
      if (len > max) max = len;
    }
    return max;
  });

  const headerLine = headers
    .map((header, idx) => s.bold(padCell(header, widths[idx]!, alignments[idx] ?? 'left')))
    .join('  ');

  const dividerLine = s.dim(widths.map((w) => '─'.repeat(w)).join('  '));

  const bodyLines = rows.map((row) =>
    headers
      .map((_, idx) => padCell(row[idx] ?? '', widths[idx]!, alignments[idx] ?? 'left'))
      .join('  '),
  );

  return [headerLine, dividerLine, ...bodyLines].join('\n');
}

export function formatDurationMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  if (minutes < 1) {
    return `${Math.max(1, Math.round(minutes * 60))}s`;
  }
  if (minutes < 60) {
    return `${minutes.toFixed(1)}m`;
  }
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

export function formatLatencyMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) {
    const isWhole = Math.abs(seconds - Math.round(seconds)) < 0.005;
    return isWhole ? `${Math.round(seconds)}s` : `${seconds.toFixed(2)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const remSec = Math.round(seconds % 60);
  if (mins < 60) {
    return remSec === 0 ? `${mins}m` : `${mins}m ${remSec}s`;
  }
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
}

export function formatRelativeTime(timestampMs: number | null | undefined, nowMs = Date.now()): string {
  if (timestampMs === null || timestampMs === undefined || !Number.isFinite(timestampMs)) return '—';
  const diffSec = Math.max(0, Math.round((nowMs - timestampMs) / 1_000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function formatIsoShort(timestampMs: number | null | undefined): string {
  if (timestampMs === null || timestampMs === undefined || !Number.isFinite(timestampMs)) return '—';
  return new Date(timestampMs).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

export function formatCadence(
  store: Pick<PublicStoreMeta, 'pollingTier' | 'pollingSource' | 'checkIntervalSeconds' | 'pollingDegraded'>,
): string {
  if (!isStoreActive(store)) {
    return 'paused';
  }
  const interval = `${store.checkIntervalSeconds}s`;
  const source = store.pollingSource ?? store.pollingTier;
  const suffix = store.pollingDegraded ? ' !' : '';
  return `${interval} (${source})${suffix}`;
}

export function formatStoresTable(
  stores: readonly EnrichedStore[],
  options: FormatOptions & { totalMonitored?: number; country?: string; activeOnly?: boolean } = {},
): string {
  const color = options.color ?? false;
  const s = makeStyle(color);

  const activeCount = stores.filter((st) => isStoreActive(st)).length;
  const inStockStores = stores.filter((st) => (st.inStockCount ?? 0) > 0).length;

  const filters: string[] = [];
  if (options.country) filters.push(`country=${options.country.toLowerCase()}`);
  if (options.activeOnly) filters.push('active only');
  const filterSuffix = filters.length > 0 ? ` [${filters.join(', ')}]` : '';

  const header = `${s.boldCyan('Apple Store Pickup Telemetry')}${filterSuffix}  ${s.dim(
    `(${stores.length} shown · ${activeCount} active · ${inStockStores} in stock)`,
  )}`;

  if (stores.length === 0) {
    return `${header}\n${s.dim('No monitored stores matched your filter.')}`;
  }

  const rows = stores.map((st) => {
    const key = `${st.country}/${st.slug}`;
    const stockCell =
      st.inStockCount === null || st.totalConfigs === null || st.totalConfigs === 0
        ? s.dim('—')
        : st.inStockCount > 0
          ? s.boldGreen(`${st.inStockCount}/${st.totalConfigs}`)
          : s.dim(`0/${st.totalConfigs}`);

    const r24 = st.restocks24h === null ? s.dim('—') : String(st.restocks24h);
    const r7d = st.restocks7d === null ? s.dim('—') : String(st.restocks7d);
    const median = formatDurationMinutes(st.medianInStockMinutes);
    const cadenceRaw = formatCadence(st);
    const cadence =
      cadenceRaw === 'paused'
        ? s.dim(cadenceRaw)
        : st.pollingDegraded
          ? s.yellow(cadenceRaw)
          : st.checkIntervalSeconds !== null && st.checkIntervalSeconds <= 5
            ? s.cyan(cadenceRaw)
            : cadenceRaw;

    return [key, st.name, st.city, stockCell, r24, r7d, median, cadence];
  });

  const table = renderTable(
    ['Store', 'Name', 'City', 'In Stock', '24h', '7d', 'Median', 'Cadence'],
    rows,
    ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'left'],
    color,
  );

  const legend = stores.some((st) => isStoreActive(st) && st.pollingDegraded)
    ? `\n${s.dim('! = polling degraded in current hour window · Source: CC BY 4.0 public telemetry')}`
    : `\n${s.dim('Source: RestockCheck CC BY 4.0 public telemetry')}`;

  return `${header}\n\n${table}${legend}`;
}

export function formatStoreCheck(
  detail: PublicStoreDetail,
  configs: readonly StoreConfigItem[],
  restocks: readonly RestockEvent[],
  options: FormatOptions & { skuFilter?: string } = {},
): string {
  const color = options.color ?? false;
  const nowMs = options.nowMs ?? Date.now();
  const s = makeStyle(color);

  const st = detail.store;
  const inStockCount = configs.filter((c) => c.availability === 'available').length;
  const cadence = formatCadence(st);
  const reliabilityStr =
    detail.reliability?.percentage !== null && detail.reliability?.percentage !== undefined
      ? `${detail.reliability.percentage.toFixed(1)}%`
      : '—';

  const lines: string[] = [
    `${s.boldCyan(`Apple ${st.name}`)} ${s.dim(`(${st.country}/${st.slug} · ${st.store} · ${st.city})`)}`,
    `${s.dim('Cadence:')} ${cadence}  ${s.dim('Last check:')} ${formatRelativeTime(detail.lastSuccessfulCheckAt, nowMs)}  ${s.dim('Reliability:')} ${reliabilityStr}`,
    `${s.dim('In stock:')} ${inStockCount > 0 ? s.boldGreen(`${inStockCount}/${configs.length}`) : `${inStockCount}/${configs.length}`}  ${s.dim('Restocks 24h/7d:')} ${detail.restocks24h?.count ?? 0}/${detail.restocks7d?.count ?? 0}  ${s.dim('Median window:')} ${formatDurationMinutes(detail.medianInStockMinutes)}`,
  ];

  if (options.skuFilter) {
    lines.push(`${s.dim('SKU filter:')} ${options.skuFilter}`);
  }

  lines.push('');

  if (configs.length === 0) {
    lines.push(
      s.dim(
        options.skuFilter
          ? `No configurations matched "${options.skuFilter}".`
          : 'No active configurations currently polled for this store.',
      ),
    );
  } else {
    const configRows = configs.map((cfg) => {
      const status =
        cfg.availability === 'available'
          ? s.boldGreen('IN STOCK')
          : cfg.availability === 'unavailable'
            ? s.dim('OUT')
            : s.yellow(cfg.availability.toUpperCase());
      const label = cfg.name.replace(/\s*\([^)]+\)\s*$/, '');
      return [cfg.config, label, status, formatRelativeTime(cfg.checkedAt, nowMs)];
    });
    lines.push(
      renderTable(
        ['SKU', 'Configuration', 'Status', 'Checked'],
        configRows,
        ['left', 'left', 'left', 'right'],
        color,
      ),
    );
  }

  const recent = restocks.slice(0, 10);
  lines.push('');
  lines.push(s.bold(`Recent Restock Transitions (${recent.length} of ${restocks.length})`));

  if (recent.length === 0) {
    lines.push(s.dim('No recent restock transitions recorded in this window.'));
  } else {
    const restockRows = recent.map((ev) => {
      const label = ev.configName.replace(/\s*\([^)]+\)\s*$/, '');
      const duration =
        ev.endedAt === null ? s.boldGreen('ongoing') : formatDurationMinutes(ev.durationMinutes);
      return [
        formatIsoShort(ev.time),
        ev.config,
        label,
        duration,
        formatRelativeTime(ev.time, nowMs),
      ];
    });
    lines.push(
      renderTable(
        ['Started (UTC)', 'SKU', 'Configuration', 'Duration', 'When'],
        restockRows,
        ['left', 'left', 'left', 'right', 'right'],
        color,
      ),
    );
  }

  return lines.join('\n');
}

function formatTierLabel(tier: PollingTierReport): string {
  if (tier.intervalSeconds <= 0) return tier.source;
  return `${tier.source} (${tier.intervalSeconds}s)`;
}

function formatQuantileTriple(q: {
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
}): string {
  return `${formatLatencyMs(q.p50Ms)} / ${formatLatencyMs(q.p90Ms)} / ${formatLatencyMs(q.p95Ms)}`;
}

export function formatServiceReport(
  report: PublicServiceReport,
  options: FormatOptions = {},
): string {
  const color = options.color ?? false;
  const s = makeStyle(color);

  const monitoredStores =
    typeof report.scope?.monitoredStores === 'number'
      ? report.scope.monitoredStores
      : (report.stores?.length ?? 0);

  const lines: string[] = [
    `${s.boldCyan('RestockCheck Service Telemetry Report')} ${s.dim('(CC BY 4.0)')}`,
    `${s.dim('Window:')} ${formatIsoShort(report.window.start)} → ${formatIsoShort(report.window.end)}  ${s.dim('Monitored stores:')} ${monitoredStores}`,
    '',
    s.bold('Polling Freshness Quantiles (P50 / P90 / P95)'),
  ];

  const activeTiers = report.pollingTiers.filter((t) => t.checks > 0);
  const tierRows = activeTiers.map((tier) => [
    formatTierLabel(tier),
    tier.checks.toLocaleString('en-US'),
    formatQuantileTriple(tier.checkInterval),
    formatQuantileTriple(tier.observationAge),
  ]);

  lines.push(
    renderTable(
      ['Polling Tier', 'Checks', 'Check Interval', 'Observation Age'],
      tierRows,
      ['left', 'right', 'right', 'right'],
      color,
    ),
  );

  const alert = report.alertSentLatency;
  lines.push('');
  lines.push(s.bold('Alert Dispatch Latency'));
  const alertRows = [
    [
      'Email / Push Dispatch',
      `${alert.sampleSize.toLocaleString('en-US')}${alert.totalEvents ? ` / ${alert.totalEvents.toLocaleString('en-US')} events` : ''}`,
      formatLatencyMs(alert.p50Ms),
      formatLatencyMs(alert.p90Ms),
      formatLatencyMs(alert.p95Ms),
    ],
  ];
  lines.push(
    renderTable(
      ['Metric', 'Samples', 'P50', 'P90', 'P95'],
      alertRows,
      ['left', 'right', 'right', 'right', 'right'],
      color,
    ),
  );

  if (alert.scope) {
    lines.push(s.dim(`Note: ${alert.scope}`));
  }

  return lines.join('\n');
}
