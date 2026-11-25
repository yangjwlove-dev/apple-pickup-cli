#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CLI_VERSION,
  SUPPORTED_COUNTRIES,
  fetchEnrichedStores,
  fetchServiceReport,
  fetchStoreDetail,
  filterConfigsBySku,
  filterRestocksBySku,
  parseStoreTarget,
  type ApiClientOptions,
} from './api.js';
import {
  formatServiceReport,
  formatStoreCheck,
  formatStoresTable,
  shouldUseColor,
} from './format.js';
import { validateNotificationUrl, type NotifyOptions } from './notify.js';
import {
  MAX_WATCH_INTERVAL_SECONDS,
  MIN_WATCH_INTERVAL_SECONDS,
  runWatchLoop,
} from './watch.js';

export type ParsedCommand =
  | { kind: 'help'; topic?: string }
  | { kind: 'version' }
  | {
      kind: 'stores';
      country?: string;
      active: boolean;
      json: boolean;
    }
  | {
      kind: 'check';
      country: string;
      slug: string;
      sku?: string;
      json: boolean;
    }
  | {
      kind: 'watch';
      country: string;
      slug: string;
      sku?: string;
      interval?: number;
      bark?: string;
      webhook?: string;
      once: boolean;
    }
  | {
      kind: 'report';
      json: boolean;
    };

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color?: boolean;
  bell?: boolean;
  apiOptions?: ApiClientOptions;
  notifyOptions?: NotifyOptions;
  signal?: AbortSignal;
}

const HELP_TEXT = `apple-pickup v${CLI_VERSION} — Live Apple Store pickup availability & restock alerts

Usage:
  apple-pickup stores [--country us|gb|jp|cn] [--active] [--json]
  apple-pickup check <country>/<slug> [--sku <filter>] [--json]
  apple-pickup watch <country>/<slug> [--sku <filter>] [--interval 15] [--bark <url>] [--webhook <url>] [--once]
  apple-pickup report [--json]

Commands:
  stores    List monitored hub Apple Stores with live in-stock SKU counts, 24h/7d restocks,
            median sellout duration, and polling cadence.
  check     Inspect per-configuration availability and recent restock windows for one store.
  watch     Poll a store (minimum 10s interval), ring terminal bell on new in-stock transitions,
            and optionally dispatch Bark, Discord, Slack, Telegram, or JSON webhook alerts.
  report    Show live CC BY 4.0 polling freshness quantiles (P50/P90/P95) and alert latency.

Global Options:
  -h, --help      Show help
  -v, --version   Print version

Examples:
  apple-pickup stores --country gb --active
  apple-pickup check gb/regent-street-r092 --sku 256GB
  apple-pickup watch us/soho-r032 --interval 15 --webhook https://discord.com/api/webhooks/...
  apple-pickup report
`;

function validateHttpUrl(value: string, flagName: string): string {
  validateNotificationUrl(value, flagName);
  return value;
}

export function parseCliArgs(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0) {
    return { kind: 'help' };
  }

  const first = argv[0]!;
  if (first === '-h' || first === '--help' || first === 'help') {
    return { kind: 'help', topic: argv[1] };
  }
  if (first === '-v' || first === '--version') {
    return { kind: 'version' };
  }

  const rest = argv.slice(1);

  if (first === 'stores') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        country: { type: 'string', short: 'c' },
        active: { type: 'boolean', short: 'a', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) return { kind: 'help', topic: 'stores' };
    if (positionals.length > 0) {
      throw new Error(`Unexpected positional argument for "stores": ${positionals.join(' ')}`);
    }
    let country: string | undefined;
    if (values.country !== undefined) {
      country = values.country.trim().toLowerCase();
      if (!(SUPPORTED_COUNTRIES as readonly string[]).includes(country)) {
        throw new Error(
          `Unsupported country "${values.country}". Supported values: ${SUPPORTED_COUNTRIES.join(', ')}.`,
        );
      }
    }
    return {
      kind: 'stores',
      country,
      active: Boolean(values.active),
      json: Boolean(values.json),
    };
  }

  if (first === 'check') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        sku: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) return { kind: 'help', topic: 'check' };
    if (positionals.length !== 1 || !positionals[0]) {
      throw new Error(
        'Command "check" requires exactly one store target: apple-pickup check <country>/<slug>',
      );
    }
    const { country, slug } = parseStoreTarget(positionals[0]);
    return {
      kind: 'check',
      country,
      slug,
      sku: values.sku?.trim() || undefined,
      json: Boolean(values.json),
    };
  }

  if (first === 'watch') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        sku: { type: 'string' },
        interval: { type: 'string', short: 'i' },
        bark: { type: 'string' },
        webhook: { type: 'string' },
        once: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) return { kind: 'help', topic: 'watch' };
    if (positionals.length !== 1 || !positionals[0]) {
      throw new Error(
        'Command "watch" requires exactly one store target: apple-pickup watch <country>/<slug>',
      );
    }
    const { country, slug } = parseStoreTarget(positionals[0]);
    let interval: number | undefined;
    if (values.interval !== undefined) {
      const parsedInterval = Number(values.interval);
      if (
        !Number.isFinite(parsedInterval) ||
        parsedInterval <= 0 ||
        parsedInterval > MAX_WATCH_INTERVAL_SECONDS
      ) {
        throw new Error(
          `Invalid --interval "${values.interval}". Provide a number of seconds between ${MIN_WATCH_INTERVAL_SECONDS} and ${MAX_WATCH_INTERVAL_SECONDS}.`,
        );
      }
      interval = parsedInterval;
    }
    const bark = values.bark ? validateHttpUrl(values.bark.trim(), '--bark') : undefined;
    const webhook = values.webhook
      ? validateHttpUrl(values.webhook.trim(), '--webhook')
      : undefined;

    return {
      kind: 'watch',
      country,
      slug,
      sku: values.sku?.trim() || undefined,
      interval,
      bark,
      webhook,
      once: Boolean(values.once),
    };
  }

  if (first === 'report') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) return { kind: 'help', topic: 'report' };
    if (positionals.length > 0) {
      throw new Error(`Unexpected positional argument for "report": ${positionals.join(' ')}`);
    }
    return {
      kind: 'report',
      json: Boolean(values.json),
    };
  }

  throw new Error(`Unknown command "${first}". Run "apple-pickup --help" for usage.`);
}

export async function runCli(argv: readonly string[], io?: Partial<CliIO>): Promise<number> {
  const stdout = io?.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const stderr = io?.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const color = io?.color ?? shouldUseColor();

  let command: ParsedCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (command.kind === 'help') {
    stdout(HELP_TEXT.trimEnd());
    return 0;
  }

  if (command.kind === 'version') {
    stdout(CLI_VERSION);
    return 0;
  }

  try {
    if (command.kind === 'stores') {
      const { totalMonitored, stores } = await fetchEnrichedStores(
        { country: command.country, active: command.active },
        io?.apiOptions,
      );
      if (command.json) {
        stdout(
          JSON.stringify(
            {
              totalMonitored,
              count: stores.length,
              filters: {
                country: command.country ?? null,
                active: command.active,
              },
              stores,
            },
            null,
            2,
          ),
        );
      } else {
        stdout(
          formatStoresTable(stores, {
            color,
            totalMonitored,
            country: command.country,
            activeOnly: command.active,
          }),
        );
      }
      return 0;
    }

    if (command.kind === 'check') {
      const detail = await fetchStoreDetail(command.country, command.slug, io?.apiOptions);
      const configs = filterConfigsBySku(detail.configs ?? [], command.sku);
      const restocks = filterRestocksBySku(detail.restockHistory ?? [], command.sku);
      if (command.json) {
        stdout(
          JSON.stringify(
            {
              ...detail,
              skuFilter: command.sku ?? null,
              configs,
              restockHistory: restocks,
            },
            null,
            2,
          ),
        );
      } else {
        stdout(
          formatStoreCheck(detail, configs, restocks, {
            color,
            skuFilter: command.sku,
          }),
        );
      }
      return 0;
    }

    if (command.kind === 'watch') {
      const controller = new AbortController();
      const externalSignal = io?.signal;
      const forwardAbort = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort();
        } else {
          externalSignal.addEventListener('abort', forwardAbort, { once: true });
        }
      }

      const onSigInt = () => {
        stderr('\nStopping watch loop.');
        controller.abort();
      };
      if (!externalSignal) {
        process.once('SIGINT', onSigInt);
        process.once('SIGTERM', onSigInt);
      }

      try {
        const result = await runWatchLoop({
          country: command.country,
          slug: command.slug,
          skuFilter: command.sku,
          intervalSeconds: command.interval,
          barkUrl: command.bark,
          webhookUrl: command.webhook,
          once: command.once,
          bell: io?.bell ?? Boolean(process.stdout.isTTY),
          signal: controller.signal,
          apiOptions: io?.apiOptions,
          notifyOptions: io?.notifyOptions,
          onWrite: stdout,
          onError: stderr,
        });
        const allAlertsFailed =
          result.lastNotifyResults.length > 0 &&
          result.lastNotifyResults.every((r) => !r.ok);
        if (command.once && (result.lastError || allAlertsFailed)) {
          return 1;
        }
        return 0;
      } finally {
        if (externalSignal) {
          externalSignal.removeEventListener('abort', forwardAbort);
        } else {
          process.off('SIGINT', onSigInt);
          process.off('SIGTERM', onSigInt);
        }
      }
    }

    if (command.kind === 'report') {
      const report = await fetchServiceReport(io?.apiOptions);
      if (command.json) {
        const compactStores = (report.stores ?? []).map((entry) => ({
          country: entry.store.country,
          slug: entry.store.slug,
          name: entry.store.name,
          city: entry.store.city,
          pollingTier: entry.store.pollingTier,
          pollingDegraded: entry.store.pollingDegraded,
          currentStatus: entry.currentStatus ?? null,
          lastSuccessfulCheckAt: entry.lastSuccessfulCheckAt ?? null,
        }));
        stdout(
          JSON.stringify(
            {
              generatedAt: report.generatedAt,
              scope: report.scope,
              window: report.window,
              pollingTiers: report.pollingTiers,
              alertSentLatency: report.alertSentLatency,
              stores: compactStores,
            },
            null,
            2,
          ),
        );
      } else {
        stdout(formatServiceReport(report, { color }));
      }
      return 0;
    }

    return 0;
  } catch (error) {
    stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function isDirectExecution(): boolean {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
