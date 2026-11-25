import { createTimeoutSignal, sanitizeErrorMessage } from './abort.js';
import { USER_AGENT } from './api.js';
import type { StoreConfigItem } from './types.js';

export type WebhookProvider = 'discord' | 'slack' | 'telegram' | 'generic';

export interface RestockAlertEvent {
  country: string;
  slug: string;
  storeId: string;
  storeName: string;
  city: string;
  checkedAt: number;
  skus: StoreConfigItem[];
  storeUrl: string;
}

export interface NotifyResult {
  channel: 'bark' | 'webhook';
  provider?: WebhookProvider;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface NotifyOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  signal?: AbortSignal;
}

export function validateNotificationUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL for ${label}: expected a valid http:// or https:// URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid URL protocol for ${label}: expected http:// or https://.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `Invalid URL for ${label}: embedded credentials (username/password) are not allowed.`,
    );
  }
  return parsed;
}

export function detectWebhookProvider(rawUrl: string): WebhookProvider {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'generic';
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (
    (host === 'discord.com' ||
      host === 'discordapp.com' ||
      host.endsWith('.discord.com')) &&
    path.includes('/api/webhooks/')
  ) {
    return 'discord';
  }
  if (host === 'hooks.slack.com' || host.endsWith('.slack.com')) {
    return 'slack';
  }
  if (host === 'api.telegram.org' && path.includes('/sendmessage')) {
    return 'telegram';
  }
  return 'generic';
}

export function buildAlertSummary(event: RestockAlertEvent): {
  title: string;
  body: string;
  lines: string[];
} {
  const count = event.skus.length;
  const title = `Apple ${event.storeName} (${event.city}): ${count} ${count === 1 ? 'SKU' : 'SKUs'} in stock`;
  const lines = event.skus.map((sku) => {
    const cleanName = sku.name.replace(/\s*\([^)]+\)\s*$/, '');
    return `• ${cleanName} (${sku.config})`;
  });
  const body = lines.join('\n');
  return { title, body, lines };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildWebhookRequest(
  rawUrl: string,
  event: RestockAlertEvent,
): { provider: WebhookProvider; targetUrl: string; body: Record<string, unknown> } {
  const parsed = validateNotificationUrl(rawUrl, '--webhook');
  const provider = detectWebhookProvider(rawUrl);
  const summary = buildAlertSummary(event);
  const isoTime = new Date(event.checkedAt).toISOString();

  if (provider === 'discord') {
    return {
      provider,
      targetUrl: parsed.toString(),
      body: {
        content: `**${summary.title}**`,
        embeds: [
          {
            title: `In-Store Pickup Available — Apple ${event.storeName}`,
            url: event.storeUrl,
            description: summary.body,
            color: 0x22c55e,
            fields: [
              { name: 'Store', value: `${event.country}/${event.slug} (${event.storeId})`, inline: true },
              { name: 'City', value: event.city, inline: true },
            ],
            timestamp: isoTime,
            footer: { text: 'apple-pickup-cli · CC BY 4.0 telemetry' },
          },
        ],
      },
    };
  }

  if (provider === 'slack') {
    return {
      provider,
      targetUrl: parsed.toString(),
      body: {
        text: `${summary.title}\n${summary.body}`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: summary.title, emoji: true },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${summary.body}\n\n<${event.storeUrl}|View store telemetry> · \`${event.country}/${event.slug}\``,
            },
          },
        ],
      },
    };
  }

  if (provider === 'telegram') {
    const chatId = parsed.searchParams.get('chat_id');
    if (chatId) {
      parsed.searchParams.delete('chat_id');
    }
    const htmlLines = event.skus.map((sku) => {
      const cleanName = sku.name.replace(/\s*\([^)]+\)\s*$/, '');
      return `• ${escapeHtml(cleanName)} (<code>${escapeHtml(sku.config)}</code>)`;
    });
    const text = [
      `<b>${escapeHtml(summary.title)}</b>`,
      ...htmlLines,
      `<a href="${escapeHtml(event.storeUrl)}">View live store telemetry</a>`,
    ].join('\n');

    const payload: Record<string, unknown> = {
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (chatId) {
      payload.chat_id = chatId;
    }
    return {
      provider,
      targetUrl: parsed.toString(),
      body: payload,
    };
  }

  return {
    provider,
    targetUrl: parsed.toString(),
    body: {
      event: 'restock',
      source: 'apple-pickup-cli',
      country: event.country,
      slug: event.slug,
      storeId: event.storeId,
      storeName: event.storeName,
      city: event.city,
      checkedAt: isoTime,
      storeUrl: event.storeUrl,
      title: summary.title,
      text: `${summary.title}\n${summary.body}`,
      skus: event.skus.map((sku) => ({
        sku: sku.config,
        name: sku.name,
        availability: sku.availability,
        capacity: sku.capacity,
        color: sku.color,
        checkedAt: sku.checkedAt,
      })),
    },
  };
}

export function buildBarkRequest(
  rawUrl: string,
  event: RestockAlertEvent,
): { targetUrl: string; body: Record<string, unknown> } {
  const parsed = validateNotificationUrl(rawUrl, '--bark');
  const normalizedUrl = parsed.toString().replace(/\/+$/, '');
  const summary = buildAlertSummary(event);
  return {
    targetUrl: normalizedUrl,
    body: {
      title: summary.title,
      body: summary.body,
      group: 'apple-pickup-cli',
      url: event.storeUrl,
    },
  };
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  options: NotifyOptions,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const userAgent = options.userAgent ?? USER_AGENT;
  const { signal: requestSignal, cleanup } = createTimeoutSignal(timeoutMs, options.signal);

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: sanitizeErrorMessage(`HTTP ${response.status} ${response.statusText}`.trim()),
      };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: sanitizeErrorMessage(rawMsg),
    };
  } finally {
    cleanup();
  }
}

export async function sendWebhook(
  webhookUrl: string,
  event: RestockAlertEvent,
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  const request = buildWebhookRequest(webhookUrl, event);
  const res = await postJson(request.targetUrl, request.body, options);
  return {
    channel: 'webhook',
    provider: request.provider,
    ...res,
  };
}

export async function sendBark(
  barkUrl: string,
  event: RestockAlertEvent,
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  const request = buildBarkRequest(barkUrl, event);
  const res = await postJson(request.targetUrl, request.body, options);
  return {
    channel: 'bark',
    ...res,
  };
}

export async function dispatchAlerts(params: {
  event: RestockAlertEvent;
  barkUrl?: string;
  webhookUrl?: string;
  options?: NotifyOptions;
}): Promise<NotifyResult[]> {
  const tasks: Promise<NotifyResult>[] = [];
  if (params.barkUrl) {
    tasks.push(sendBark(params.barkUrl, params.event, params.options));
  }
  if (params.webhookUrl) {
    tasks.push(sendWebhook(params.webhookUrl, params.event, params.options));
  }
  return Promise.all(tasks);
}
