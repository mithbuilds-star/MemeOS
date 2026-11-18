// Progress card for the most recent discovery run: what it is doing now, how far it got, and what looks stuck.
type RunJob = {
  id: string;
  created_at: string;
  last_attempt_at?: string | null;
  status: string;
  last_error?: string | null;
  metadata?: any;
};

const STUCK_AFTER_MS = 10 * 60 * 1000;

export function RunProgress({ job }: { job: RunJob }) {
  const meta = job.metadata || {};
  const sources = Array.isArray(meta.source_usernames) ? meta.source_usernames.join(", ") : "";
  const phase = meta.phase || "discovery";
  const fetched = Number(meta.items_seen ?? NaN);
  const imported = Number(meta.inserted ?? 0);
  const duplicates = Number(meta.duplicates ?? 0);
  const ageMs = Date.now() - Date.parse(job.created_at);
  const running = job.status === "running" || job.status === "queued";
  const stuck = running && ageMs > STUCK_AFTER_MS;
  const minutes = Math.round(ageMs / 60000);

  let state = "Idle";
  let tone = "";
  let width = 0;
  let indeterminate = false;
  if (job.status === "completed") {
    state = `Done: ${imported} imported, ${duplicates} already had`;
    width = 100;
    tone = "ok";
  } else if (job.status === "failed") {
    state = "Failed";
    tone = "bad";
    width = 100;
  } else if (running) {
    // Sync runs return all posts in one call, so the total is unknown until the response arrives.
    state = "Waiting for Apify to finish the run, then importing its posts";
    indeterminate = true;
  }

  return (
    <div className={`run-progress ${tone}`} aria-live="polite">
      <div className="run-progress-head">
        <strong>{phase} · {sources || "—"}</strong>
        <span>{job.status}{running ? ` · ${minutes} min` : ""}</span>
      </div>
      <div className={`run-bar${indeterminate ? " indeterminate" : ""}`} role="progressbar" aria-valuenow={width} aria-valuemin={0} aria-valuemax={100}>
        <i style={indeterminate ? undefined : { width: `${width}%` }} />
      </div>
      <div className="run-progress-meta">
        <span>{state}</span>
        {!Number.isNaN(fetched) && <span>{fetched} fetched</span>}
      </div>
      {job.last_error && <div className="run-progress-error">Error: {job.last_error}</div>}
      {stuck && (
        <div className="run-progress-error">
          Running for {minutes} min with no result. Last poll: {job.last_attempt_at ? new Date(job.last_attempt_at).toLocaleTimeString() : "never"}. The sweeper will fail it if it passes its time limit.
        </div>
      )}
    </div>
  );
}
