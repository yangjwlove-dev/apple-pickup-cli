import { describe, expect, it, vi } from 'vitest';
import { parseCliArgs, runCli } from '../src/cli.js';
import { CLI_VERSION } from '../src/api.js';

describe('CLI argument parsing', () => {
  it('parses stores command flags', () => {
    expect(parseCliArgs(['stores', '--country', 'GB', '--active', '--json'])).toEqual({
      kind: 'stores',
      country: 'gb',
      active: true,
      json: true,
    });
  });

  it('rejects unsupported country code on stores command', () => {
    expect(() => parseCliArgs(['stores', '--country', 'fr'])).toThrow(/Unsupported country/);
  });

  it('parses check command with sku filter', () => {
    expect(parseCliArgs(['check', 'us/soho-r032', '--sku', '256GB', '--json'])).toEqual({
      kind: 'check',
      country: 'us',
      slug: 'soho-r032',
      sku: '256GB',
      json: true,
    });
  });

  it('parses watch command with interval, bark, webhook, and once', () => {
    expect(
      parseCliArgs([
        'watch',
        'gb/regent-street-r092',
        '--sku',
        'Star White',
        '--interval',
        '20',
        '--bark',
        'https://api.day.app/key123',
        '--webhook',
        'https://hooks.slack.com/services/A/B/C',
        '--once',
      ]),
    ).toEqual({
      kind: 'watch',
      country: 'gb',
      slug: 'regent-street-r092',
      sku: 'Star White',
      interval: 20,
      bark: 'https://api.day.app/key123',
      webhook: 'https://hooks.slack.com/services/A/B/C',
      once: true,
    });
  });

  it('rejects invalid URLs, credentials, and out-of-range intervals on watch command', () => {
    expect(() => parseCliArgs(['watch', 'us/soho-r032', '--interval', 'abc'])).toThrow(
      /Invalid --interval/,
    );
    expect(() => parseCliArgs(['watch', 'us/soho-r032', '--interval', '9999999'])).toThrow(
      /Invalid --interval/,
    );
    expect(() => parseCliArgs(['watch', 'us/soho-r032', '--webhook', 'ftp://bad.test'])).toThrow(
      /Invalid URL protocol/,
    );
    expect(() =>
      parseCliArgs(['watch', 'us/soho-r032', '--bark', 'https://u:secret@api.day.app/KEY123']),
    ).toThrow(/embedded credentials/);
    try {
      parseCliArgs(['watch', 'us/soho-r032', '--webhook', 'not-a-url-secret-token']);
    } catch (err) {
      expect((err as Error).message).not.toContain('not-a-url-secret-token');
    }
  });

  it('returns exit code 1 in watch --once mode when all configured alert channels fail', async () => {
    const apiFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
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
            configs: [
              {
                config: 'MK2D4QN/A',
                name: 'iPhone Duo 256GB Star White (MK2D4QN/A)',
                checkedAt: 1795607442865,
                availability: 'available',
              },
            ],
            lastRestock: null,
            restockHistory: [],
            medianInStockMinutes: 3.5,
            availability: 'available',
            reliability: null,
            restocks24h: { count: 1 },
            restocks7d: { count: 5 },
          },
        }),
        { status: 200 },
      ),
    );

    const notifyFetchFail = vi.fn(async () => new Response('down', { status: 503 }));

    const exitCode = await runCli(
      [
        'watch',
        'gb/regent-street-r092',
        '--webhook',
        'https://hooks.example.test/restock',
        '--once',
      ],
      {
        stdout: () => {},
        stderr: () => {},
        bell: false,
        apiOptions: { fetchFn: apiFetch as unknown as typeof fetch },
        notifyOptions: { fetchFn: notifyFetchFail as unknown as typeof fetch },
      },
    );

    expect(exitCode).toBe(1);
  });

  it('parses report, help, and version flags', () => {
    expect(parseCliArgs(['report', '--json'])).toEqual({ kind: 'report', json: true });
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help', topic: undefined });
    expect(parseCliArgs(['--version'])).toEqual({ kind: 'version' });
  });

  it('runs --version and report --json cleanly via runCli', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code1 = await runCli(['--version'], {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    expect(code1).toBe(0);
    expect(out[0]).toBe(CLI_VERSION);

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            generatedAt: 1795607463536,
            scope: { monitoredStores: 31 },
            window: { start: 1793012400000, end: 1795607463536 },
            pollingTiers: [],
            alertSentLatency: { sampleSize: 56, p50Ms: 3430, p90Ms: 5693, p95Ms: 7589 },
          },
        }),
        { status: 200 },
      ),
    );

    const jsonOut: string[] = [];
    const code2 = await runCli(['report', '--json'], {
      stdout: (s) => jsonOut.push(s),
      stderr: (s) => err.push(s),
      apiOptions: { fetchFn: fetchMock as unknown as typeof fetch },
    });
    expect(code2).toBe(0);
    expect(JSON.parse(jsonOut[0]!).alertSentLatency.p50Ms).toBe(3430);
    expect(err).toEqual([]);
  });
});
