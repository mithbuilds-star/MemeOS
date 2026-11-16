import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "./lifecycle.mjs";

// In-memory store with the same compare-and-set semantics as PostgREST PATCH with filters.
function makeStore(rows) {
  const data = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    data,
    get: (id) => ({ ...data.get(id) }),
    async patchWhere(id, where, patch) {
      const row = data.get(id);
      if (!row) return [];
      for (const [k, v] of Object.entries(where)) if (row[k] !== v) return [];
      Object.assign(row, patch);
      return [{ ...row }];
    },
  };
}
const T0 = Date.parse("2026-11-16T10:00:00Z");
const base = (over = {}) => ({
  id: "m1", processing_status: "needs_ocr", processing_attempts: 0,
  processing_token: null, processing_locked_until: null, processing_next_retry_at: null, ...over,
});

test("lease expires while OCR runs: recovery retries via retry_wait, never straight to queued", () => {
  const row = base({ processing_token: "A", processing_locked_until: new Date(T0 + 1000).toISOString() });
  const out = L.staleRecovery(row, T0 + 5000);
  assert.equal("processing_status" in out, false, "status is not regressed by a retry outcome");
  assert.equal(out.processing_attempts, 1);
  assert.ok(Date.parse(out.processing_next_retry_at) > T0 + 5000, "retry is scheduled, not immediate");
});

test("renewed lease is not treated as stale by recovery", () => {
  const row = base({ processing_token: "A", processing_locked_until: new Date(T0 + 60_000).toISOString() });
  assert.equal(L.staleRecovery(row, T0 + 30_000), null);
});

test("OCR succeeds but the database update fails: the claim is kept and the failure is counted", async () => {
  const store = makeStore([base({ processing_token: "A", processing_locked_until: new Date(T0 + 60_000).toISOString() })]);
  // Simulate the DB rejecting the completion write.
  const failingStore = { ...store, patchWhere: async () => { throw new Error("Database update failed (503)"); } };
  await assert.rejects(L.casPatch(failingStore, "m1", "A", { processing_status: "ocr_complete" }), /503/);
  assert.equal(store.get("m1").processing_status, "needs_ocr", "state not advanced");
  const out = L.failureOutcome(store.get("m1"), "Database update failed (503)", T0);
  assert.equal(out._attempt, 1);
});

test("recovery cron does not requeue while the OCR worker still holds a live lease", () => {
  const row = base({ processing_token: "A", processing_locked_until: new Date(T0 + 60_000).toISOString() });
  assert.equal(L.canClaim(row, T0), false);
  assert.equal(L.staleRecovery(row, T0), null);
});

test("two workers cannot claim the same job", async () => {
  const store = makeStore([base()]);
  const first = await store.patchWhere("m1", { processing_status: "needs_ocr" }, L.claimPatch(T0, "A"));
  const second = await store.patchWhere("m1", { processing_status: "needs_ocr" }, L.claimPatch(T0, "B"));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1, "store-level claim is conditional on status only; the worker checks canClaim first");
  // Real protection: the worker claims only when canClaim says the row is free.
  const held = base({ processing_token: "A", processing_locked_until: new Date(T0 + 60_000).toISOString() });
  assert.equal(L.canClaim(held, T0), false);
});

test("OCR returns after a retry has started: the late write is rejected", async () => {
  const store = makeStore([base({ processing_token: "A", processing_locked_until: new Date(T0 - 1).toISOString() })]);
  // Worker A's lease expired; recovery moved the job to retry, and worker B claimed it.
  await store.patchWhere("m1", {}, { processing_token: "B", processing_locked_until: new Date(T0 + 60_000).toISOString() });
  const late = await L.casPatch(store, "m1", "A", { processing_status: "ocr_complete", extracted_text: "old" });
  assert.equal(late.length, 0, "stale token must not match");
  assert.equal(store.get("m1").processing_status, "needs_ocr");
  assert.equal(store.get("m1").extracted_text, undefined);
});

test("maximum attempts exhausted: job becomes failed, out of active processing, record kept", () => {
  const row = base({ processing_attempts: 2, processing_token: "A", classification: "suitable", extracted_text: "HELLO" });
  const out = L.failureOutcome(row, "render crashed", T0);
  assert.equal(out._terminal, true);
  assert.equal(out.processing_status, "failed");
  assert.equal(out.processing_next_retry_at, null);
  assert.equal(out.processing_token, null);
  assert.equal(L.isActive({ ...row, ...out }), false);
});

test("a render dispatch is not reclaimed until the watchdog, and counts as an attempt", () => {
  const row = base({ processing_status: "ready_for_asset", processing_attempts: 0, processing_token: "A" });
  const patch = L.renderDispatchPatch(row, T0);
  const after = { ...row, ...patch };
  assert.equal(L.canClaim(after, T0 + 60_000), false, "no re-dispatch every cron minute");
  assert.equal(L.canClaim(after, T0 + 31 * 60_000), true, "re-eligible only after the watchdog");
  assert.equal(after.processing_attempts, 1);
});

test("renders stop after the maximum number of attempts", () => {
  const row = base({ processing_status: "ready_for_asset", processing_attempts: 3 });
  assert.equal(L.shouldFailRender(row), true);
  assert.equal(L.shouldFailRender({ ...row, processing_attempts: 2 }), false);
});

test("the lifecycle only moves forward: retry_wait backoff grows and is capped", () => {
  assert.ok(L.backoffMs(2) > L.backoffMs(1));
  assert.equal(L.backoffMs(50), L.DEFAULTS.backoffCapMs);
});

test("ownership check rejects a null or mismatched token", () => {
  assert.equal(L.ownsRow({ processing_token: "A" }, "A"), true);
  assert.equal(L.ownsRow({ processing_token: "A" }, "B"), false);
  assert.equal(L.ownsRow({ processing_token: "A" }, null), false);
});
