export interface ManagedAbortSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * Combines multiple AbortSignals without requiring AbortSignal.any (Node 20.3+),
 * ensuring full compatibility with Node >= 20.0.0.
 */
export function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): ManagedAbortSignal | null {
  const active = signals.filter((s): s is AbortSignal => s !== undefined);
  if (active.length === 0) return null;
  if (active.length === 1) {
    return { signal: active[0]!, cleanup: () => {} };
  }

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; handler: () => void }> = [];

  const cleanup = () => {
    for (const { signal, handler } of listeners) {
      signal.removeEventListener('abort', handler);
    }
    listeners.length = 0;
  };

  for (const sig of active) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      cleanup();
      return { signal: controller.signal, cleanup: () => {} };
    }
    const handler = () => {
      controller.abort(sig.reason);
      cleanup();
    };
    sig.addEventListener('abort', handler, { once: true });
    listeners.push({ signal: sig, handler });
  }

  return { signal: controller.signal, cleanup };
}

/**
 * Creates a timeout-bounded AbortSignal optionally linked to an external AbortSignal,
 * using an AbortController fallback compatible with Node >= 20.0.0.
 * Always invoke cleanup() in a finally block to clear the timer and listener.
 */
export function createTimeoutSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): ManagedAbortSignal {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
    cleanup();
  };

  const cleanup = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };

  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }

  if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  timer = setTimeout(() => {
    timer = undefined;
    controller.abort(
      new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'),
    );
    cleanup();
  }, timeoutMs);

  return { signal: controller.signal, cleanup };
}

const URL_IN_TEXT_REGEX = /https?:\/\/[^\s"'<>`]+/gi;

function splitTrailingUrlPunctuation(candidate: string): { url: string; suffix: string } {
  let url = candidate;
  let suffix = '';
  while (url.length > 0) {
    const last = url[url.length - 1]!;
    if (/[.,;:!?]/.test(last)) {
      suffix = last + suffix;
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')') {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        suffix = last + suffix;
        url = url.slice(0, -1);
        continue;
      }
    }
    if (last === ']') {
      const opens = (url.match(/\[/g) ?? []).length;
      const closes = (url.match(/\]/g) ?? []).length;
      if (closes > opens) {
        suffix = last + suffix;
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return { url, suffix };
}

/**
 * Redacts embedded credentials, query parameters, and optionally path segments from a URL
 * before including it in error messages or logs.
 */
export function sanitizeUrlForLog(rawUrl: string, keepPath = false): string {
  try {
    const parsed = new URL(rawUrl);
    if (keepPath) {
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    }
    return `${parsed.protocol}//${parsed.host}/<redacted>`;
  } catch {
    return '<redacted-url>';
  }
}

/**
 * Strips any raw http(s) URLs containing potential secrets, tokens, or credentials
 * from arbitrary error messages.
 */
export function sanitizeErrorMessage(message: string): string {
  return message.replace(URL_IN_TEXT_REGEX, (matched) => {
    const { url, suffix } = splitTrailingUrlPunctuation(matched);
    return `${sanitizeUrlForLog(url, false)}${suffix}`;
  });
}
