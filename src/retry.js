// Free AI tiers often answer 503 "high demand" for a few seconds. Retry quietly before giving up.
const RETRY = new Set([500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(doFetch, { tries = 3, delayMs = 1500 } = {}) {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await doFetch();
    if (!RETRY.has(res.status) || i === tries - 1) return res;
    await sleep(delayMs * (i + 1));
  }
  return res;
}
