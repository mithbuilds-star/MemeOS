// Pure job-lifecycle rules shared by the Worker and its tests.
// Lifecycle: queued -> processing -> completed
//            queued -> processing -> retry_wait -> queued
//            queued -> processing -> discarded
// A job is only reclaimable when no live lease holds it. Ownership is a token
// written on claim; every later write must match it (compare-and-set).

export const DEFAULTS = {
  maxAttempts: 5, // discard after this many consecutive errors\n  sameErrorLimit: 3, // discard sooner when the exact same error repeats
  attemptTimeoutMs: 120_000,       // per-attempt OCR/classify timeout
  renderWatchdogMs: 30 * 60_000,   // how long a dispatched GitHub render may run
  backoffBaseMs: 60_000,           // retry_wait backoff: base * 2^(attempt-1), capped
  backoffCapMs: 30 * 60_000,
};

export function leaseMs(cfg = DEFAULTS) {
  // Lease covers one attempt plus a margin; the worker renews it before each long step.
  return cfg.attemptTimeoutMs * 2 + 60_000;
}

const ACTIVE = new Set(["needs_ocr", "ocr_complete", "ready_for_asset"]);

export function isActive(row) {
  return ACTIVE.has(row.processing_status);
}

const ms = (iso) => (iso ? new Date(iso).getTime() : null);

// True only if no live lease, no pending retry, and no render in flight.
export function canClaim(row, nowMs) {
  if (!isActive(row)) return false;
  const lock = ms(row.processing_locked_until);
  if (lock !== null && lock > nowMs) return false;
  const retry = ms(row.processing_next_retry_at);
  if (retry !== null && retry > nowMs) return false;
  return true;
}

export function claimPatch(nowMs, token, cfg = DEFAULTS) {
  return {
    processing_token: token,
    processing_locked_until: new Date(nowMs + leaseMs(cfg)).toISOString(),
  };
}

// The renewal must only extend a lease we still own.
export function renewPatch(nowMs, cfg = DEFAULTS) {
  return { processing_locked_until: new Date(nowMs + leaseMs(cfg)).toISOString() };
}

export function ownsRow(row, token) {
  return !!token && row.processing_token === token;
}

export function backoffMs(attempt, cfg = DEFAULTS) {
  return Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1)));
}

// Outcome after a failed attempt (exception or failed render dispatch).
// attempt = attempts already recorded + 1.
export function failureOutcome(row, message, nowMs, cfg = DEFAULTS) {
  const attempt = Number(row.processing_attempts || 0) + (row.reel_status === "rendering" ? 0 : 1);
  const error = String(message || "Unknown error").trim().replace(/\s+/g, " ").slice(0, 500);
  const key = error.toLowerCase();
  const consecutive = Number(row.processing_consecutive_errors || 0) + 1;
  const same = key && key === String(row.processing_last_error_key || "") 
    ? Number(row.processing_same_error_count || 0) + 1 : 1;
  const terminal = same >= cfg.sameErrorLimit || consecutive >= cfg.maxAttempts;
  const base = {
    processing_attempts: attempt,
    processing_consecutive_errors: consecutive,
    processing_same_error_count: same,
    processing_last_error_key: key,
    processing_error: error,
    processing_locked_until: null,
    processing_token: null,
  };
  if (terminal) {
    return { ...base, processing_status: "discarded", reel_status: "discarded", processing_next_retry_at: null, reel_render_next_retry_at: null, reel_render_locked_until: null, processing_failed_at: new Date(nowMs).toISOString(), _terminal: true, _attempt: attempt };
  }
  // Keep the current stage: a failed step retries at the same point without regressing progress.
  return { ...base, processing_next_retry_at: new Date(nowMs + backoffMs(consecutive, cfg)).toISOString(), _terminal: false, _attempt: attempt };
}

// A dispatched GitHub render is "in flight": keep it out of the queue until the watchdog.
export function renderDispatchPatch(row, nowMs, cfg = DEFAULTS) {
  return {
    processing_locked_until: null,
    // processing_token is kept: the GitHub renderer must match it to write its result.
    processing_next_retry_at: new Date(nowMs + cfg.renderWatchdogMs).toISOString(),
    processing_attempts: Number(row.processing_attempts || 0) + 1,
  };
}

export function shouldFailRender(row, cfg = DEFAULTS) {
  // Dispatches are not failures. Only recorded consecutive errors can exhaust a render.
  return Number(row.processing_consecutive_errors || 0) >= cfg.maxAttempts;
}

// Recovery: a lease that expired without renewal means the worker is gone.
// It is retried through retry_wait (attempt counted), never requeued straight away.
export function staleRecovery(row, nowMs, cfg = DEFAULTS) {
  if (!isActive(row)) return null;
  const lock = ms(row.processing_locked_until);
  if (lock === null || lock > nowMs) return null;
  return failureOutcome(row, "Worker lease expired before the attempt finished.", nowMs, cfg);
}

// Compare-and-set against an in-memory or PostgREST-shaped store.
// `store.patchWhere(id, where, patch)` returns the matched rows.
export async function casPatch(store, id, token, patch) {
  const rows = await store.patchWhere(id, { processing_token: token }, patch);
  return rows;
}

export function logEvent(event, fields) {
  return JSON.stringify({ at: new Date().toISOString(), event, ...fields });
}
