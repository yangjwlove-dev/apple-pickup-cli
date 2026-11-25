import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '../dist/cli.js');

function runCli(args) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke assertion failed: ${message}`);
  }
}

console.log('1/3 Running: apple-pickup stores --active --json');
const storesRaw = runCli(['stores', '--active', '--json']);
const storesPayload = JSON.parse(storesRaw);
assert(Array.isArray(storesPayload.stores), 'stores payload must contain stores array');
assert(storesPayload.stores.length > 0, 'expected at least 1 active monitored store');
const firstStore = storesPayload.stores[0];
const target = `${firstStore.country}/${firstStore.slug}`;
console.log(
  `    OK — ${storesPayload.stores.length} active stores (of ${storesPayload.totalMonitored} monitored); sample=${target}`,
);

console.log('2/3 Running: apple-pickup report --json');
const reportRaw = runCli(['report', '--json']);
const reportPayload = JSON.parse(reportRaw);
assert(Array.isArray(reportPayload.pollingTiers), 'report must include pollingTiers');
assert(
  typeof reportPayload.alertSentLatency?.sampleSize === 'number',
  'report must include alertSentLatency.sampleSize',
);
console.log(
  `    OK — ${reportPayload.pollingTiers.length} polling tiers, alert latency P50=${reportPayload.alertSentLatency.p50Ms}ms`,
);

console.log(`3/3 Running: apple-pickup watch ${target} --once`);
const watchOut = runCli(['watch', target, '--once']);
assert(watchOut.includes(`Watching ${target}`), 'watch output must confirm store target');
console.log(`    OK — ${watchOut.trim().split('\n').at(-1)}`);

console.log('\nAll live read-only smoke checks passed.');
