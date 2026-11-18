// Pure discovery rules shared by the Worker (worker/index.ts) and its tests.
// Nothing here calls the network or the database.
//
// Actor facts (coregent/instagram-posts-scraper, verified on its Apify page):
//  - resultsLimit is a per-profile maximum.
//  - Results come newest-first.
//  - postsNewerThan / postsOlderThan are date filters with early stop; the actor
//    scans at most max(10 x resultsLimit, 240) posts per run when filtering.
// Consequently a run returns the newest N posts inside its window. A full page
// means more posts may exist inside the window, so the window must be narrowed
// and re-run instead of advancing the cursor.

export const SCRAPE_PAGE = 25;
export const MAX_BACKFILL_PAGES = 20;
// Instagram timestamps are second-precision. Re-fetching one second of overlap is
// harmless because identities are deduplicated; skipping a post is not.
export const OVERLAP_MS = 1000;

const CODE_RE = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;

function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function pick(obj, keys) {
  for (const key of keys) {
    let cur = obj;
    for (const part of key.split(".")) cur = cur?.[part];
    const s = str(cur);
    if (s) return s;
  }
  return null;
}

// Canonical identity: Instagram shortcode. Numeric media IDs are not used as the
// primary key because some responses carry them as JS numbers, which loses
// precision (stored values end in zeros). Legacy IDs are kept only for matching.
export function discoveryIdentity(item) {
  const permalink = pick(item, ["url", "permalink", "postUrl", "post_url"]);
  const shortcode =
    pick(item, ["shortCode", "shortcode"]) || (permalink && (permalink.match(CODE_RE) || [])[1]) || null;
  const legacyIds = [item?.id, item?.pk, item?.postId]
    .filter((v) => typeof v === "string" || typeof v === "number")
    .map(String);
  const uniqueLegacy = [...new Set(legacyIds)];
  const key = shortcode || uniqueLegacy[0] || permalink || null;
  return {
    key,
    shortcode,
    permalink: shortcode ? `https://www.instagram.com/p/${shortcode}/` : permalink,
    legacyIds: uniqueLegacy,
  };
}

// PostgREST filter that matches an existing row for this post under any identity
// format it may have been saved with. Returns null when the identity is unusable.
export function dedupeOrClause(identity) {
  const parts = [];
  if (identity.key) parts.push(`source_post_id.eq.${identity.key}`);
  for (const id of identity.legacyIds) parts.push(`source_post_id.eq.${id}`);
  if (identity.shortcode && /^[A-Za-z0-9_-]+$/.test(identity.shortcode)) {
    parts.push(`source_permalink.like.*/${identity.shortcode}/*`);
  }
  return parts.length ? `or=(${parts.join(",")})` : null;
}

// Splits one actor page into explicit categories.
// window: { newerThan, olderThan } as epoch ms or null; exclusive on both ends.
export function classifyPage(items, window, { parseTs }) {
  const newer = window.newerThan ?? null;
  const older = window.olderThan ?? null;
  const page = {
    seen: items.length,
    rawCount: items.length,
    invalid: 0,
    outOfWindow: 0,
    missingTimestamp: 0,
    inWindowCount: 0,
    oldestInWindowMs: null,
    newestInWindowMs: null,
    eligible: [],
  };
  for (const item of items) {
    const identity = discoveryIdentity(item);
    if (!identity.key) {
      page.invalid++;
      continue;
    }
    const ts = parseTs(item);
    if (ts == null) {
      // Cannot be placed in the window. Import it (deduplicated) but never use it to move a cursor.
      page.missingTimestamp++;
      page.eligible.push({ item, identity, ts: null });
      continue;
    }
    if ((newer != null && ts <= newer) || (older != null && ts >= older)) {
      page.outOfWindow++;
      continue;
    }
    page.inWindowCount++;
    page.oldestInWindowMs = page.oldestInWindowMs == null ? ts : Math.min(page.oldestInWindowMs, ts);
    page.newestInWindowMs = page.newestInWindowMs == null ? ts : Math.max(page.newestInWindowMs, ts);
    page.eligible.push({ item, identity, ts });
  }
  return page;
}

const ms = (value) => (value ? Date.parse(value) : null);
const iso = (value) => new Date(value).toISOString();

// Decides the cursor/window update after a page has been processed.
// source: reference_accounts row fields. page: summary from classifyPage plus insertErrors.
// Returns { ok, error?, patch, complete?, next? }. `patch` is never applied when !ok.
export function planAdvance(phase, source, page, jobCreatedMs) {
  const truncated = page.rawCount >= SCRAPE_PAGE;

  // Any failed insert freezes every cursor, so the same window is retried and
  // the already-inserted posts are deduplicated. Nothing is skipped.
  if (page.insertErrors > 0) {
    return { ok: true, retry: true, patch: { last_scrape_status: "partial_failure" } };
  }

  if (phase === "backfill") {
    const before = ms(source.backfill_before);
    if (page.rawCount === 0) {
      return { ok: true, complete: true, patch: { backfill_complete: true, backfill_stop_reason: "The actor returned no older posts for this window.", last_scrape_status: "completed" } };
    }
    if (page.inWindowCount === 0) {
      return { ok: false, error: "The actor did not apply the historical date window. No cursor was moved." };
    }
    if (!truncated) {
      return {
        ok: true,
        complete: true,
        patch: {
          backfill_complete: true,
          backfill_stop_reason: "The actor returned fewer than a full page of older posts. Deeper history can be unreachable because each run scans a limited number of posts.",
          last_scrape_status: "completed",
        },
      };
    }
    if (page.oldestInWindowMs == null) return { ok: false, error: "The historical page has no usable timestamps, so pagination is unsafe." };
    const pages = (source.backfill_pages || 0) + 1;
    const next = page.oldestInWindowMs + OVERLAP_MS;
    if (before != null && next >= before) {
      return { ok: false, error: "Historical pagination made no progress (identical timestamps). Stopped instead of repeating the page." };
    }
    if (pages >= MAX_BACKFILL_PAGES) {
      return {
        ok: true,
        complete: true,
        patch: { backfill_complete: true, backfill_pages: pages, backfill_stop_reason: `Stopped after ${MAX_BACKFILL_PAGES} pages to cap Apify usage.`, last_scrape_status: "completed" },
      };
    }
    return { ok: true, complete: false, patch: { backfill_before: iso(next), backfill_pages: pages, backfill_complete: false, last_scrape_status: "backfilling" } };
  }

  // Incremental.
  const cursor = ms(source.last_scraped_at);
  const upper = ms(source.discovery_upper_bound);
  const sweepTop = ms(source.discovery_sweep_top);

  if (cursor == null && upper == null) {
    // Baseline: the first run imports the newest page and sets the cursor to the
    // newest real post. Older history is reached by backfill, seeded from the oldest post here.
    const top = page.newestInWindowMs ?? jobCreatedMs;
    const patch = { last_scraped_at: iso(top), discovery_upper_bound: null, discovery_sweep_top: null, last_scrape_status: "completed" };
    if (!source.backfill_before && page.oldestInWindowMs != null) patch.backfill_before = iso(page.oldestInWindowMs);
    return { ok: true, patch };
  }

  if (page.rawCount > 0 && page.inWindowCount === 0) {
    return { ok: false, error: "The actor did not apply the incremental date window. No cursor was moved." };
  }

  if (truncated) {
    // Full page: posts inside the window may remain below this page. Save the
    // next window bound and continue from there without touching the cursor.
    if (page.oldestInWindowMs == null) return { ok: false, error: "A full discovery page has no usable timestamps, so catch-up is unsafe." };
    const next = page.oldestInWindowMs + OVERLAP_MS;
    if (upper != null && next >= upper) return { ok: false, error: "Catch-up made no progress (identical timestamps). Stopped instead of repeating the page." };
    const top = Math.max(sweepTop ?? -Infinity, page.newestInWindowMs ?? -Infinity);
    return {
      ok: true,
      complete: false,
      patch: { discovery_upper_bound: iso(next), discovery_sweep_top: Number.isFinite(top) ? iso(top) : null, last_scrape_status: "catching_up" },
    };
  }

  // Short page: everything inside the window has been seen. Advance to the
  // newest post processed during this sweep.
  const top = Math.max(sweepTop ?? -Infinity, page.newestInWindowMs ?? -Infinity, cursor ?? -Infinity);
  const patch = { discovery_upper_bound: null, discovery_sweep_top: null, last_scrape_status: "completed" };
  if (Number.isFinite(top)) patch.last_scraped_at = iso(top);
  return { ok: true, complete: true, patch };
}
