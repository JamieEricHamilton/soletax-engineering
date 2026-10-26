/**
 * hmrcFetch.ts — one HMRC call with HMRC's own back-off (go-live plan A6,
 * built 2026-10-02 S230).
 *
 * HMRC's reference guide (register §H 2026-09-29): "Our standard limit is 3
 * requests per second per application." On a 429 "we recommend that your
 * code should stop making additional API requests for a short period of time
 * before retrying" and "avoid batching requests". So: on 429 wait (the
 * Retry-After header when HMRC sends one, capped; otherwise a doubling delay
 * with jitter) and try again, a few times, then hand the last response back
 * for the error mapping to call "busy". Nothing else is retried here — a
 * submission that reached HMRC must not be sent twice by a blind retry.
 *
 * Every call carries a timeout: a hanging HMRC endpoint must never hold a
 * submission open past the client's patience.
 *
 * Pure module: `fetchImpl` and `sleep` are injectable so the tests stub them.
 */

export interface HmrcFetchOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts after the first. Default 3. */
  retries?: number;
  /** Per-attempt timeout. Default 15s. */
  timeoutMs?: number;
  /** Base delay before the first retry. Default 400ms. */
  baseDelayMs?: number;
  /** Cap on any single wait, including a Retry-After. Default 5s. */
  maxDelayMs?: number;
  random?: () => number;
}

export function retryDelayMs(attempt: number, retryAfterHeader: string | null, opts: Required<Pick<HmrcFetchOptions, "baseDelayMs" | "maxDelayMs" | "random">>): number {
  const ra = Number(retryAfterHeader);
  if (retryAfterHeader && Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, opts.maxDelayMs);
  const backoff = opts.baseDelayMs * 2 ** attempt;
  const jitter = Math.floor(opts.random() * opts.baseDelayMs);
  return Math.min(backoff + jitter, opts.maxDelayMs);
}

export async function hmrcFetch(url: string, init: RequestInit, options: HmrcFetchOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const delayOpts = {
    baseDelayMs: options.baseDelayMs ?? 400,
    maxDelayMs: options.maxDelayMs ?? 5_000,
    random: options.random ?? Math.random,
  };
  let last: Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    if (res.status !== 429) return res;
    last = res;
    if (attempt === retries) break;
    await sleep(retryDelayMs(attempt, res.headers.get("retry-after"), delayOpts));
  }
  return last!;
}
