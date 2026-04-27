// review.mjs — adversarial reviewer pass over a single task's worktree.
//
// Flow:
//   1. Load the task; require a worktree (developer must have run first).
//   2. Build a repository-context pack via scripts/lib/context-collector.mjs
//      (git diff + ast-grep + ripgrep cross-refs).
//   3. Spawn pi with prompts/reviewer.md. Tools: read, bash, grep, find, ls
//      — no write/edit, to enforce review-only semantics.
//   4. Validate the reply's last JSON block against review-report.schema.json.
//   5. Persist the report (kind='review', versioned) and advance task state:
//        approve          → task.status = 'evaluating' (ready for evaluator)
//        needs-attention  → task.status = 'developing' + attempts++
//                           (orchestrator will resume the developer with the
//                            findings as the follow-up prompt)
//
// Resume semantics (`--resume`): reopen the prior reviewer session to
// re-check after a dev fix, mirroring how tester --resume works.

import { loadPrompt } from '../prompts.mjs';
import { parseAndValidate } from '../schema.mjs';
import { collectReviewContext } from '../context-collector.mjs';
import {
  parseArgs,
  nowIso,
  getStateDir,
  stateLib,
  runnerLib,
  resolveRoleModel,
  sessionPath,
  saveReport,
  loadReports,
  writeJsonLine,
} from './_shared.mjs';

async function latestReview(stateDir, taskId) {
  const all = await loadReports(stateDir, taskId);
  const reviews = all.filter((r) => r.kind === 'review');
  return reviews.length ? reviews[reviews.length - 1] : null;
}

function buildResumePrompt({ taskId, priorFindings }) {
  const ids = (priorFindings || []).map((f) => f.id).filter(Boolean);
  return [
    `Prior reviewer findings that were handed back to the developer:`,
    '```json',
    JSON.stringify(priorFindings || [], null, 2),
    '```',
    '',
    `The developer claims to have addressed these. Re-verify each finding id (${ids.join(', ') || 'n/a'}) is now resolved.`,
    `Issue a fresh review-report JSON for task ${taskId}. Keep or escalate any finding that is still live; drop resolved ones.`,
  ].join('\n');
}

function buildFreshPrompt({ taskId, contextPack }) {
  return [
    `Task under review: ${taskId}`,
    '',
    contextPack.text,
    '',
    'Emit the adversarial review-report JSON object as the LAST message of your reply.',
  ].join('\n');
}

export default async function handleReview(argv) {
  const { opts } = parseArgs(argv);
  const taskId = opts.task || opts.taskId;
  if (!taskId) throw new Error('usage: pi-companion review --task <id> [--resume]');
  const resume = !!opts.resume;

  const stateDir = await getStateDir();
  const { loadTask, saveTask, appendHistory } = await stateLib();
  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (!task.worktree?.path) {
    throw new Error(`task ${taskId} has no worktree; run develop first`);
  }

  task.status = 'reviewing';
  await saveTask(task);
  await appendHistory(taskId, {
    ts: nowIso(),
    role: 'reviewer',
    event: resume ? 'resuming' : 'dispatched',
  });

  const sessPath = sessionPath(stateDir, 'review', taskId);

  let prompt;
  let contextPack = null;
  if (resume) {
    const prior = await latestReview(stateDir, taskId);
    prompt = buildResumePrompt({
      taskId,
      priorFindings: prior?.body?.findings || [],
    });
  } else {
    contextPack = collectReviewContext({
      worktreePath: task.worktree.path,
      taskId,
      baseBranch: task.worktree.baseBranch || opts.baseBranch || 'main',
    });
    prompt = buildFreshPrompt({ taskId, contextPack });
  }

  const runner = await runnerLib();
  const result = await runner.runPi({
    systemPromptPath: loadPrompt('reviewer'),
    // read-only plus bash (for rg/ast-grep/lsp-backed checkers); no write/edit
    tools: ['read', 'bash', 'grep', 'find', 'ls'],
    sessionPath: sessPath,
    resume,
    prompt,
    cwd: task.worktree.path,
    model: await resolveRoleModel('reviewer', opts.model),
  });

  const raw = typeof result?.lastMessage?.text === 'string'
    ? result.lastMessage.text
    : (typeof result?.lastMessage === 'string' ? result.lastMessage : '');

  const parsed = parseAndValidate(raw, 'review-report');
  if (!parsed.ok) {
    writeJsonLine({
      event: 'review.invalid',
      taskId,
      errors: parsed.errors,
      raw: raw.slice(-2000),
    });
    // Don't advance state on malformed output — leave it reviewable.
    task.status = 'developing';
    task.attempts = (task.attempts || 0) + 1;
    await saveTask(task);
    await appendHistory(taskId, {
      ts: nowIso(),
      role: 'reviewer',
      event: 'output-invalid',
      errors: parsed.errors,
    });
    throw new Error(`reviewer output failed schema validation:\n  ${parsed.errors.join('\n  ')}`);
  }

  const report = parsed.data;
  const reportPath = await saveReport(stateDir, taskId, 'review', report);

  task.sessions = { ...(task.sessions || {}), reviewer: sessPath };
  const findingCount = (report.findings || []).length;
  if (report.verdict === 'approve') {
    task.status = 'evaluating';
  } else {
    task.status = 'developing';
    task.attempts = (task.attempts || 0) + 1;
  }
  await saveTask(task);
  await appendHistory(taskId, {
    ts: nowIso(),
    role: 'reviewer',
    event: report.verdict === 'approve' ? 'approved' : 'needs-attention',
    summary: report.summary,
    findingCount,
  });

  writeJsonLine({
    event: 'review.reported',
    taskId,
    verdict: report.verdict,
    findingCount,
    reportPath,
    sessionPath: sessPath,
    collectedSymbols: contextPack?.symbols?.length ?? 0,
    crossRefSymbols: contextPack?.refCount ?? 0,
  });
}
