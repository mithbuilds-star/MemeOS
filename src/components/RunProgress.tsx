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

  const total = Number(meta.items_total ?? NaN);
  const processed = Number(meta.items_processed ?? NaN);
  const importing = running && meta.import_partial === true && total > 0;

  let state = "Idle";
  let tone = "";
  let width = 0;
  let indeterminate = false;
  let percent: string | null = null;
  if (job.status === "completed") {
    state = `Done: ${imported} imported, ${duplicates} already had`;
    width = 100;
    percent = "100%";
    tone = "ok";
  } else if (job.status === "failed") {
    state = "Failed";
    tone = "bad";
    width = 100;
  } else if (importing) {
    // Importing: show how many of this run's posts have been handled so far.
    width = Math.min(100, Math.round((processed / total) * 100));
    percent = `${width}%`;
    state = `Importing posts: ${processed} of ${total} handled, ${imported} new so far`;
  } else if (running) {
    // Apify is still running; posts are only available once the run finishes.
    state = "Apify run in progress. Posts appear here when it finishes.";
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
        {percent && <span>{percent}</span>}
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
