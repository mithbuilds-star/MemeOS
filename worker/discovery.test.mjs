import { test } from "node:test";
import assert from "node:assert/strict";
import * as D from "./discovery.mjs";

const BASE = Date.parse("2026-01-01T00:00:00Z");
const at = (sec) => new Date(BASE + sec * 1000).toISOString();
const post = (n, sec) => ({ id: String(900000 + n), shortCode: `CODE${n}`, url: `https://www.instagram.com/p/CODE${n}/`, timestamp: at(sec) });
const parseTs = (item) => (item.timestamp ? Date.parse(item.timestamp) : null);

// Fake actor with the documented behaviour: newest-first, per-run limit, exclusive date window.
function actor(posts, window, limit = D.SCRAPE_PAGE) {
  const sorted = [...posts].sort((a, b) => Date.parse(b.timestamp ?? 0) - Date.parse(a.timestamp ?? 0));
  const out = [];
  for (const p of sorted) {
    const t = parseTs(p);
    if (window.newerThan != null && (t == null || !(t > window.newerThan))) continue;
    if (window.olderThan != null && (t == null || !(t < window.olderThan))) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

// Store with the same semantics as the unique index + ignore-duplicates insert.
function makeStore() {
  const rows = new Map();
  const failOnce = new Set();
  return {
    rows, failOnce,
    insert(key, item) {
      if (failOnce.has(key)) { failOnce.delete(key); return "error"; }
      if (rows.has(key)) return "duplicate";
      rows.set(key, item);
      return "inserted";
    },
  };
}

function applyPage(store, page, tally) {
  for (const entry of page.eligible) {
    const r = store.insert(entry.identity.key, entry.item);
    if (r === "inserted") tally.inserted++;
    else if (r === "duplicate") tally.duplicates++;
    else tally.insertErrors++;
  }
}

function pageSummary(page, insertErrors) {
  return { rawCount: page.rawCount, inWindowCount: page.inWindowCount, oldestInWindowMs: page.oldestInWindowMs, newestInWindowMs: page.newestInWindowMs, insertErrors };
}

function applyPatch(source, patch) {
  Object.assign(source, patch);
}

// Runs incremental pages for one account until its sweep completes.
function runIncremental(source, store, posts, tally = { inserted: 0, duplicates: 0, insertErrors: 0 }) {
  for (let i = 0; i < 100; i++) {
    const window = { newerThan: source.last_scraped_at ? Date.parse(source.last_scraped_at) : null, olderThan: source.discovery_upper_bound ? Date.parse(source.discovery_upper_bound) : null };
    const page = D.classifyPage(actor(posts, window), window, { parseTs });
    const before = { ...tally };
    applyPage(store, page, tally);
    const insertErrors = tally.insertErrors - before.insertErrors;
    const plan = D.planAdvance("incremental", source, pageSummary(page, insertErrors), BASE + 10 * 3600e3);
    assert.equal(plan.ok, true, plan.error);
    applyPatch(source, plan.patch);
    if (plan.complete) return tally;
  }
  throw new Error("incremental run did not finish");
}

// Runs historical pages backward for one account until it is complete.
function runBackfill(source, store, posts, tally = { inserted: 0, duplicates: 0, insertErrors: 0 }) {
  const oldestSeen = [];
  for (let i = 0; i < 100; i++) {
    const window = { newerThan: null, olderThan: Date.parse(source.backfill_before) };
    const page = D.classifyPage(actor(posts, window), window, { parseTs });
    if (page.oldestInWindowMs != null) oldestSeen.push(page.oldestInWindowMs);
    const insertedBefore = tally.inserted;
    applyPage(store, page, tally);
    const plan = D.planAdvance("backfill", source, { ...pageSummary(page, 0), inserted: tally.inserted - insertedBefore }, BASE);
    assert.equal(plan.ok, true, plan.error);
    applyPatch(source, plan.patch);
    if (plan.complete) return { tally, oldestSeen };
  }
  throw new Error("backfill did not finish");
}

const freshSource = (over = {}) => ({ id: "src", username: "acct", last_scraped_at: at(0), backfill_before: null, backfill_complete: false, backfill_pages: 0, discovery_upper_bound: null, discovery_sweep_top: null, ...over });

test("1. 25 new posts after the cursor are all eligible and imported", () => {
  const posts = Array.from({ length: 25 }, (_, i) => post(i, 60 * (i + 1)));
  const store = makeStore();
  const tally = runIncremental(freshSource(), store, posts);
  assert.equal(tally.inserted, 25);
  assert.equal(store.rows.size, 25);
});

test("2. only 3 new posts exist: 3 eligible, no artificial expectation of 25", () => {
  const posts = [post(1, 60), post(2, 120), post(3, 180)];
  const store = makeStore();
  const page = D.classifyPage(actor(posts, { newerThan: 0, olderThan: null }), { newerThan: 0, olderThan: null }, { parseTs });
  assert.equal(page.eligible.length, 3);
  const tally = runIncremental(freshSource(), store, posts);
  assert.equal(tally.inserted, 3);
});

test("3. same dataset returned twice creates zero new records the second time", () => {
  const posts = Array.from({ length: 10 }, (_, i) => post(i, 60 * (i + 1)));
  const store = makeStore();
  runIncremental(freshSource(), store, posts);
  const second = runIncremental(freshSource(), store, posts);
  assert.equal(second.inserted, 0);
  assert.equal(store.rows.size, 10);
});

test("4. overlapping windows produce no duplicate records", () => {
  const posts = Array.from({ length: 30 }, (_, i) => post(i, 60 * (i + 1)));
  const store = makeStore();
  runIncremental(freshSource(), store, posts);
  // Rewind the cursor so the next window overlaps everything already imported.
  const rewound = runIncremental(freshSource({ last_scraped_at: at(0) }), store, posts);
  assert.equal(rewound.inserted, 0);
  assert.equal(store.rows.size, 30);
});

test("5. identical timestamps across posts are not skipped", () => {
  // 22 newer posts plus 5 posts sharing one timestamp: the first page cuts through the tie.
  const posts = [
    ...Array.from({ length: 22 }, (_, i) => post(i, 100 + i)),
    ...Array.from({ length: 5 }, (_, i) => post(100 + i, 50)),
  ];
  const store = makeStore();
  const tally = runIncremental(freshSource(), store, posts);
  assert.equal(tally.inserted, 27);
});

test("6. two reference accounts keep independent cursors and runs", () => {
  const a = freshSource({ id: "a", last_scraped_at: at(0) });
  const b = freshSource({ id: "b", last_scraped_at: at(500) });
  const postsA = [post(1, 60), post(2, 120)];
  const postsB = [post(10, 600), post(11, 700)];
  const storeA = makeStore(), storeB = makeStore();
  runIncremental(a, storeA, postsA);
  runIncremental(b, storeB, postsB);
  assert.equal(storeA.rows.size, 2);
  assert.equal(storeB.rows.size, 2);
  assert.equal(a.last_scraped_at, at(120));
  assert.equal(b.last_scraped_at, at(700));
});

test("7. one account's failure does not stop another account", () => {
  const a = freshSource({ id: "a" });
  const b = freshSource({ id: "b" });
  // A's actor returned a page that ignored its window: must fail without moving A's cursor.
  const badA = D.planAdvance("incremental", a, { rawCount: 5, inWindowCount: 0, oldestInWindowMs: null, newestInWindowMs: null, insertErrors: 0 }, BASE);
  assert.equal(badA.ok, false);
  assert.equal(a.last_scraped_at, at(0));
  const okB = D.planAdvance("incremental", b, { rawCount: 1, inWindowCount: 1, oldestInWindowMs: BASE + 60e3, newestInWindowMs: BASE + 60e3, insertErrors: 0 }, BASE);
  assert.equal(okB.ok, true);
  assert.equal(okB.patch.last_scraped_at, at(60));
});

test("8. partial insertion failure does not advance the cursor past the failed post", () => {
  const posts = [post(1, 60), post(2, 120), post(3, 180)];
  const store = makeStore();
  store.failOnce.add("CODE2");
  const source = freshSource();
  const window = { newerThan: 0, olderThan: null };
  const page = D.classifyPage(actor(posts, window), window, { parseTs });
  const tally = { inserted: 0, duplicates: 0, insertErrors: 0 };
  applyPage(store, page, tally);
  assert.equal(tally.insertErrors, 1);
  const plan = D.planAdvance("incremental", source, pageSummary(page, tally.insertErrors), BASE);
  assert.equal(plan.patch.last_scraped_at, undefined, "cursor must not move on partial failure");
  applyPatch(source, plan.patch);
  assert.equal(source.last_scraped_at, at(0));
  // Retry: the failed post is imported and nothing is duplicated.
  const retry = runIncremental(source, store, posts);
  assert.equal(store.rows.size, 3);
  assert.equal(retry.insertErrors, 0);
});

test("9. a missing timestamp is handled explicitly and does not move cursors", () => {
  const noDate = { id: "777", shortCode: "NODATE", url: "https://www.instagram.com/p/NODATE/" };
  const window = { newerThan: BASE, olderThan: null };
  const page = D.classifyPage([post(1, 120), noDate], window, { parseTs });
  assert.equal(page.missingTimestamp, 1);
  assert.equal(page.eligible.length, 2);
  const store = makeStore();
  const tally = { inserted: 0, duplicates: 0, insertErrors: 0 };
  applyPage(store, page, tally);
  assert.equal(tally.inserted, 2);
  const plan = D.planAdvance("incremental", freshSource(), pageSummary(page, 0), BASE);
  assert.equal(plan.patch.last_scraped_at, at(120), "cursor follows dated posts only");
});

test("10. historical pagination moves backward page by page and visits no page twice", () => {
  const older = Array.from({ length: 80 }, (_, i) => post(200 + i, -100 * (i + 1)));
  const source = freshSource({ backfill_before: at(0), last_scraped_at: at(10000) });
  const store = makeStore();
  const { tally, oldestSeen } = runBackfill(source, store, older);
  assert.equal(tally.inserted, 80);
  assert.equal(source.backfill_complete, true);
  assert.ok(source.backfill_stop_reason);
  for (let i = 1; i < oldestSeen.length; i++) assert.ok(oldestSeen[i] < oldestSeen[i - 1], "each page must be strictly older");
  assert.equal(source.last_scraped_at, at(10000), "backfill must not disturb the incremental cursor");
});

test("11. concurrent runs over the same page cannot insert duplicates", () => {
  const posts = Array.from({ length: 6 }, (_, i) => post(i, 60 * (i + 1)));
  const store = makeStore();
  const window = { newerThan: 0, olderThan: null };
  const pageA = D.classifyPage(actor(posts, window), window, { parseTs });
  const pageB = D.classifyPage(actor(posts, window), window, { parseTs });
  const tally = { inserted: 0, duplicates: 0, insertErrors: 0 };
  applyPage(store, pageA, tally);
  applyPage(store, pageB, tally);
  assert.equal(tally.inserted, 6);
  assert.equal(tally.duplicates, 6);
  assert.equal(store.rows.size, 6);
});

test("12. fewer than 25 items completes the sweep and advances the cursor to the newest post", () => {
  const posts = Array.from({ length: 4 }, (_, i) => post(i, 60 * (i + 1)));
  const source = freshSource();
  runIncremental(source, makeStore(), posts);
  assert.equal(source.discovery_upper_bound, null);
  assert.equal(source.last_scraped_at, at(240));
});

test("identity: shortcode wins over unstable numeric IDs and matches legacy rows", () => {
  const withNumber = { id: 4031243104610248123, shortCode: "Dfx2j7FiWbn", url: "https://www.instagram.com/p/Dfx2j7FiWbn/" };
  const withString = { id: "4031243104610248123", url: "https://www.instagram.com/reel/Dfx2j7FiWbn/?igsh=abc" };
  assert.equal(D.discoveryIdentity(withNumber).key, "Dfx2j7FiWbn");
  assert.equal(D.discoveryIdentity(withString).key, "Dfx2j7FiWbn");
  const clause = D.dedupeOrClause(D.discoveryIdentity(withNumber));
  assert.match(clause, /source_post_id\.eq\.Dfx2j7FiWbn/);
  assert.match(clause, /source_permalink\.like\.\*\/Dfx2j7FiWbn\/\*/);
  assert.equal(D.dedupeOrClause({ key: null, legacyIds: [], shortcode: null }), null);
});

test("13. a full backfill page with no new posts stops instead of re-walking imported history", () => {
  const source = { backfill_before: at(0), backfill_pages: 0 };
  const plan = D.planAdvance("backfill", source, { rawCount: 25, inWindowCount: 25, oldestInWindowMs: BASE - 60e3, newestInWindowMs: BASE - 1000, insertErrors: 0, inserted: 0 }, BASE);
  assert.equal(plan.ok, true);
  assert.equal(plan.complete, true);
  assert.equal(plan.patch.backfill_complete, true);
  assert.match(plan.patch.backfill_stop_reason, /already imported/);
});
