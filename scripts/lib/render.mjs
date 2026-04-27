// Render helpers for `/pi:status` and `/pi:report`.
// Pure string builders; no I/O.

const STATUS_ORDER = [
  "ready",
  "developing",
  "testing",
  "evaluating",
  "done",
  "blocked",
  "cancelled",
];

function pad(value, width) {
  const str = String(value ?? "");
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}

function truncate(value, max) {
  const str = String(value ?? "");
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Render a markdown table summarising the current task list.
 * `opts.planStatus` / `opts.workspace` are rendered as a header line.
 */
export function renderStatusTable(tasks, opts = {}) {
  const rows = Array.isArray(tasks) ? tasks : [];
  const lines = [];
  if (opts.title) lines.push(`# ${opts.title}`, "");
  const meta = [];
  if (opts.planStatus) meta.push(`plan: **${opts.planStatus}**`);
  if (typeof opts.totalTasks === "number") meta.push(`tasks: ${opts.totalTasks}`);
  if (opts.workspace) meta.push(`workspace: \`${opts.workspace}\``);
  if (meta.length) lines.push(meta.join(" · "), "");

  if (rows.length === 0) {
    lines.push("_No tasks yet. Run `/pi:plan` to produce a plan._");
    return lines.join("\n");
  }

  lines.push("| id | status | attempts | title | deps | branch |");
  lines.push("|----|--------|----------|-------|------|--------|");
  for (const t of rows) {
    const attempts = `${t.attempts ?? 0}/${t.maxAttempts ?? "-"}`;
    const deps = Array.isArray(t.deps) && t.deps.length ? t.deps.join(",") : "-";
    const branch = t.worktree?.branch ?? "-";
    lines.push(
      `| ${t.id ?? "?"} | ${t.status ?? "?"} | ${attempts} | ${truncate(t.title, 60)} | ${deps} | ${branch} |`,
    );
  }

  return lines.join("\n");
}

/** Render a compact JSON payload for `/pi:status --json`. */
export function renderStatusJson(tasks, opts = {}) {
  const rows = Array.isArray(tasks) ? tasks : [];
  const buckets = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  for (const t of rows) {
    if (t.status && buckets[t.status] !== undefined) buckets[t.status] += 1;
  }
  const payload = {
    planStatus: opts.planStatus ?? "none",
    totalTasks: rows.length,
    statusCounts: buckets,
    workspace: opts.workspace ?? null,
    stateDir: opts.stateDir ?? null,
    tasks: rows.map((t) => ({
      id: t.id,
      status: t.status,
      attempts: t.attempts ?? 0,
      maxAttempts: t.maxAttempts,
      title: t.title,
      deps: t.deps ?? [],
      worktree: t.worktree ?? null,
      updatedAt: t.updatedAt ?? null,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Render a final markdown report aggregating plan, test reports, and
 * (optionally) the final evaluator verdict.
 */
export function renderFinalReport({ plan, tasks, reports, evalReport } = {}) {
  const lines = [];
  lines.push("# pi-agent-cc Report", "");
  if (plan?.title) lines.push(`**Plan:** ${plan.title}`);
  if (plan?.version !== undefined) lines.push(`**Version:** ${plan.version}`);
  if (plan?.summary) lines.push("", plan.summary);
  lines.push("");

  lines.push("## Tasks", "");
  lines.push(renderStatusTable(tasks ?? [], { planStatus: plan?.status }));
  lines.push("");

  const testReports = (reports ?? []).filter((r) => r?.kind === "test");
  if (testReports.length) {
    lines.push("## Test Reports", "");
    for (const r of testReports) {
      const verdict = r.verdict ?? (r.passed ? "PASS" : "FAIL");
      lines.push(`### ${r.taskId} (v${r.version ?? "?"}) — ${verdict}`);
      if (r.summary) lines.push("", r.summary);
      if (Array.isArray(r.issues) && r.issues.length) {
        lines.push("", "Issues:");
        for (const i of r.issues) {
          lines.push(`- ${i.id ?? "?"}: ${i.detail ?? i.message ?? ""}`);
        }
      }
      lines.push("");
    }
  }

  if (evalReport) {
    lines.push("## Evaluator Verdict", "");
    if (evalReport.verdict) lines.push(`**Verdict:** ${evalReport.verdict}`);
    if (evalReport.score !== undefined) lines.push(`**Score:** ${evalReport.score}`);
    if (evalReport.dimensions) {
      lines.push("", "Dimensions:");
      for (const [k, v] of Object.entries(evalReport.dimensions)) {
        lines.push(`- ${k}: ${v}`);
      }
    }
    if (evalReport.recommendations) {
      lines.push("", evalReport.recommendations);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Convenience: fixed-width status line suitable for SessionStart banners.
export function renderStatusBanner({ planStatus, tasks } = {}) {
  const rows = Array.isArray(tasks) ? tasks : [];
  const counts = rows.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});
  const parts = [`plan=${planStatus ?? "none"}`, `tasks=${rows.length}`];
  for (const s of STATUS_ORDER) {
    if (counts[s]) parts.push(`${s}=${counts[s]}`);
  }
  return `[pi-agent] ${parts.join(" ")}`;
}

// Exported so other renderers can reuse padding helpers if needed.
export const _test = { pad, truncate };
