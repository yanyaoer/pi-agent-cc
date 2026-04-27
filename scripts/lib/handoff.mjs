// handoff.mjs — cross-role context bridging for dev <-> tester handoff.
//
// Context-common.md declares:
//   buildTesterContext(taskId), buildResumePrompt(role, taskId, issues)
//
// We additionally export more ergonomic helpers used by the handlers:
//   buildTesterContextFromInputs({ task, devSummary, worktreePath, baseBranch })
//   buildDevResumePrompt({ issues })
//   buildTesterResumePrompt({ issueIds })
//
// The contract-shaped `buildTesterContext(taskId)` and `buildResumePrompt(role, taskId, issues)`
// rely on P1's `state.mjs` + `worktree.mjs` to resolve the task and worktree.
// They are implemented as thin wrappers that do the lookups then call the
// ergonomic helpers.

import { execFileSync } from 'node:child_process';

/**
 * Contract-shaped tester context builder. Resolves task + worktree via the P1
 * libs, collects the latest developer summary from session history, and builds
 * a prompt the tester agent can consume.
 *
 * @param {string} taskId
 * @returns {Promise<string>} the prompt
 */
export async function buildTesterContext(taskId) {
  const [{ loadTask }, { listWorktrees }] = await Promise.all([
    import('./state.mjs'),
    import('./worktree.mjs'),
  ]);
  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  const worktrees = (await listWorktrees()) || [];
  const wt = worktrees.find((w) => w.taskId === taskId) || task.worktree;
  const worktreePath = wt?.path;
  if (!worktreePath) throw new Error(`worktree path unknown for task ${taskId}`);

  // Pick the most recent developer history entry summary if present.
  const lastDevEntry = [...(task.history || [])]
    .reverse()
    .find((h) => h.role === 'developer');
  const devSummary = lastDevEntry?.summary || '(no developer summary available)';

  return buildTesterContextFromInputs({
    task,
    devSummary,
    worktreePath,
    baseBranch: wt?.baseBranch || 'main',
  });
}

/**
 * Ergonomic variant used directly by handlers when they already have the task
 * and worktree info in memory.
 */
export function buildTesterContextFromInputs({ task, devSummary, worktreePath, baseBranch = 'main' }) {
  let diffStat = '(git diff --stat unavailable)';
  let fileList = '(git diff --name-only unavailable)';
  try {
    diffStat = execFileSync('git', ['-C', worktreePath, 'diff', baseBranch, '--stat'], { encoding: 'utf8' }).trim();
  } catch { /* leave fallback */ }
  try {
    fileList = execFileSync('git', ['-C', worktreePath, 'diff', baseBranch, '--name-only'], { encoding: 'utf8' }).trim();
  } catch { /* leave fallback */ }

  const acceptance = (task.acceptance || []).map((a) => `- ${a}`).join('\n') || '- (none specified)';

  return `## Task ${task.id}: ${task.title}

${task.description}

## Acceptance criteria
${acceptance}

## Developer summary
${devSummary}

## Changed files (vs ${baseBranch})
${fileList || '(no changes)'}

## Diff stat (vs ${baseBranch})
${diffStat || '(no changes)'}

Verify the work meets every acceptance criterion. Output a single JSON object per test-report.schema.json as the LAST thing in your reply.`;
}

/**
 * Contract-shaped: produce a resume prompt for a given role + issues.
 *
 * @param {'developer'|'tester'} role
 * @param {string} taskId
 * @param {Array} issues - tester issues for dev-resume, or issue ids for tester-resume
 */
export function buildResumePrompt(role, taskId, issues) {
  if (role === 'developer') {
    return buildDevResumePrompt({ taskId, issues });
  }
  if (role === 'tester') {
    const issueIds = Array.isArray(issues)
      ? issues.map((i) => (typeof i === 'string' ? i : i.id)).filter(Boolean)
      : [];
    return buildTesterResumePrompt({ taskId, issueIds });
  }
  throw new Error(`unknown role for resume prompt: ${role}`);
}

export function buildDevResumePrompt({ taskId, issues }) {
  const list = Array.isArray(issues) ? issues : [];
  const header = taskId ? `Task ${taskId} — ` : '';
  return `${header}Tester reported the following issues. Please address each one, then reply with a per-issue summary (use the "## Fixes" / "## Files Changed" / "## Notes" headings):

${JSON.stringify(list, null, 2)}`;
}

export function buildTesterResumePrompt({ taskId, issueIds }) {
  const header = taskId ? `Task ${taskId} — ` : '';
  const ids = (issueIds || []).join(', ') || '(none provided)';
  return `${header}Developer claims the previously reported issues have been fixed: ${ids}. Re-verify each issue and any regressions it might have caused, then output an updated test-report.schema.json JSON object as the LAST thing in your reply.`;
}
