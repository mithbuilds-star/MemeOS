import { test } from "node:test";
import assert from "node:assert/strict";
import { planAdvance } from "./discovery.mjs";

const page = (over = {}) => ({ rawCount: 25, inWindowCount: 25, oldestInWindowMs: Date.parse("2026-11-10T00:00:00Z"), newestInWindowMs: Date.parse("2026-11-18T10:00:00Z"), insertErrors: 0, inserted: 3, ...over });

test("newest full page moves cursor to newest post and sets no catch-up bound", () => {
  const r = planAdvance("newest", { last_scraped_at: "2026-11-17T00:00:00Z" }, page(), Date.now());
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.equal(r.patch.discovery_upper_bound, null);
  assert.equal(r.patch.last_scraped_at, new Date(Date.parse("2026-11-18T10:00:00Z")).toISOString());
});

test("deep page older than the cursor never moves the cursor backwards", () => {
  const r = planAdvance("newest", { last_scraped_at: "2026-11-18T10:00:00Z" }, page({ newestInWindowMs: Date.parse("2026-11-12T00:00:00Z") }), Date.now());
  assert.equal(r.patch.last_scraped_at, "2026-11-18T10:00:00.000Z");
  assert.equal(r.patch.discovery_upper_bound, null);
  assert.equal(r.complete, true);
});

test("insert errors still freeze the cursor", () => {
  const r = planAdvance("newest", { last_scraped_at: "2026-11-17T00:00:00Z" }, page({ insertErrors: 2 }), Date.now());
  assert.equal(r.retry, true);
  assert.equal(r.patch.last_scraped_at, undefined);
});

test("empty newest page completes without moving the cursor", () => {
  const r = planAdvance("newest", { last_scraped_at: "2026-11-17T00:00:00Z" }, page({ rawCount: 0, inWindowCount: 0, oldestInWindowMs: null, newestInWindowMs: null, inserted: 0 }), Date.now());
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.equal(r.patch.last_scraped_at, "2026-11-17T00:00:00.000Z");
});
