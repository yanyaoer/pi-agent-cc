// orchestrate.mjs — main loop: dispatch ready tasks in parallel, run
// developer → tester → (resume on FAIL) → merge on PASS, then evaluate.

import handleDevelop from './develop.mjs';
import handleTest from './test.mjs';
import handleReview from './review.mjs';
import handleEvaluate from './evaluate.mjs';
import { getReadyTasks, findCycles } from '../task-graph.mjs';
import { getOrchestrationConfig } from '../config.mjs';
import {
  parseArgs,
  nowIso,
  getStateDir,
  stateLib,
  workspaceLib,
  worktreeLib,
  loadLatestTestReport,
  loadReports,
  writeJsonLine,
} from './_shared.mjs';

async function latestReviewReport(stateDir, taskId) {
  const all = await loadReports(stateDir, taskId);
  const reviews = all.filter((r) => r.kind === 'review');
  return reviews.length ? reviews[reviews.length - 1] : null;
}

const SLEEP_MS = 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default async function handleOrchestrate(argv) {
  const { opts } = parseArgs(argv);
  const parallel = Math.max(1, Number(opts.parallel) || 4);
  const autoApprove = !!opts['auto-approve'];
  const ws = await workspaceLib();
  const orch = getOrchestrationConfig(ws.resolveWorkspaceRoot());
  // CLI override: --no-review disables; --review forces on.
  const reviewEnabled = opts['no-review'] ? false : (opts.review === true ? true : !!orch.review?.enabled);

  const { loadState, saveState, listTasks, loadTask, saveTask, appendHistory } = await stateLib();
  const state = (await loadState()) || {};
  if (state.planStatus !== 'frozen' && state.planStatus !== 'running' && state.planStatus !== 'rework') {
    throw new Error(`plan not frozen (current: ${state.planStatus || 'none'}). Run /pi:plan-confirm first.`);
  }
  state.planStatus = 'running';
  state.runStartedAt = nowIso();
  state.autoApprove = autoApprove;
  await saveState(state);

  const initialTasks = await listTasks();
  const cyc = findCycles(initialTasks);
  if (cyc.length) {
    throw new Error(`dependency cycle detected in plan: ${cyc.join(' -> ')}`);
  }

  writeJsonLine({
    event: 'orchestrate.start',
    parallel,
    taskCount: initialTasks.length,
    reviewEnabled,
  });

  const inFlight = new Map(); // taskId -> Promise

  while (true) {
    const tasks = await listTasks();

    // Check terminal condition: every task done / blocked / cancelled.
    const open = tasks.filter((t) => !['done', 'blocked', 'cancelled'].includes(t.status));
    if (open.length === 0 && inFlight.size === 0) break;

    // Fill parallel slots.
    if (inFlight.size < parallel) {
      const ready = getReadyTasks(tasks).filter((t) => !inFlight.has(t.id));
      const slotsLeft = parallel - inFlight.size;
      for (const t of ready.slice(0, slotsLeft)) {
        const p = runTaskLoop(t.id).catch((err) => {
          writeJsonLine({ event: 'task.error', taskId: t.id, error: err.message });
        }).finally(() => {
          inFlight.delete(t.id);
        });
        inFlight.set(t.id, p);
        writeJsonLine({ event: 'task.dispatched', taskId: t.id });
      }
    }

    if (inFlight.size === 0) {
      // No in-flight, no ready → some tasks are blocked on deps that will
      // never complete (everyone else blocked). Exit loop.
      const stillOpen = tasks.filter((t) => !['done', 'blocked', 'cancelled'].includes(t.status));
      if (stillOpen.length > 0) {
        writeJsonLine({ event: 'orchestrate.stalled', open: stillOpen.map((t) => t.id) });
        for (const t of stillOpen) {
          t.status = 'blocked';
          t.history = [...(t.history || []), { ts: nowIso(), event: 'blocked.stalled' }];
          await saveTask(t);
        }
      }
      break;
    }

    // Wait for any in-flight to finish (or short poll tick).
    await Promise.race([
      Promise.race([...inFlight.values()]).catch(() => {}),
      sleep(SLEEP_MS),
    ]);
  }

  await Promise.allSettled([...inFlight.values()]);

  // Summary before evaluator.
  const finalTasks = await listTasks();
  const doneCount = finalTasks.filter((t) => t.status === 'done').length;
  const blockedCount = finalTasks.filter((t) => t.status === 'blocked').length;
  writeJsonLine({
    event: 'orchestrate.tasksComplete',
    done: doneCount,
    blocked: blockedCount,
    total: finalTasks.length,
  });

  // Gate evaluator on at least some success and no blocked tasks (unless autoApprove).
  if (blockedCount > 0 && !autoApprove) {
    const st = (await loadState()) || {};
    st.planStatus = 'blocked';
    await saveState(st);
    writeJsonLine({
      event: 'orchestrate.done',
      evaluator: 'skipped',
      reason: 'blocked tasks present',
    });
    return;
  }

  if (doneCount === 0) {
    const st = (await loadState()) || {};
    st.planStatus = 'blocked';
    await saveState(st);
    writeJsonLine({ event: 'orchestrate.done', evaluator: 'skipped', reason: 'no tasks completed' });
    return;
  }

  // Run final evaluator.
  await handleEvaluate([]);
  writeJsonLine({ event: 'orchestrate.done', evaluator: 'ran' });

  async function runTaskLoop(taskId) {
    const stateDir = await getStateDir();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const t = await loadTask(taskId);
      if (!t) return;
      if (['done', 'blocked', 'cancelled'].includes(t.status)) return;
      if ((t.attempts || 0) >= (t.maxAttempts || 5)) {
        t.status = 'blocked';
        await saveTask(t);
        await appendHistory(taskId, { ts: nowIso(), event: 'blocked.maxAttempts' });
        writeJsonLine({ event: 'task.blocked', taskId, reason: 'maxAttempts' });
        return;
      }

      // Developer step: fresh if no session, otherwise resume.
      const hasDevSession = !!t.sessions?.developer;
      const devArgs = hasDevSession
        ? ['--task', taskId, '--resume']
        : ['--task', taskId];
      await handleDevelop(devArgs);

      // Tester step.
      const freshTask = await loadTask(taskId);
      const hasTestSession = !!freshTask.sessions?.tester;
      const testArgs = hasTestSession
        ? ['--task', taskId, '--resume']
        : ['--task', taskId];
      await handleTest(testArgs);

      const latest = await loadLatestTestReport(stateDir, taskId);
      const verdict = latest?.body?.verdict;
      if (verdict !== 'PASS') {
        // FAIL → loop back for another iteration.
        writeJsonLine({ event: 'task.retry', taskId, attempts: freshTask.attempts || 0, stage: 'test' });
        // attempts counter is bumped inside handleTest on FAIL.
        continue;
      }

      // Optional review stage — adversarial reviewer gate before merge.
      if (reviewEnabled) {
        const taskForReview = await loadTask(taskId);
        const hasReviewSession = !!taskForReview.sessions?.reviewer;
        const reviewArgs = hasReviewSession
          ? ['--task', taskId, '--resume']
          : ['--task', taskId];
        try {
          await handleReview(reviewArgs);
        } catch (err) {
          writeJsonLine({
            event: 'task.retry',
            taskId,
            attempts: (await loadTask(taskId)).attempts || 0,
            stage: 'review',
            error: err.message,
          });
          continue; // reviewer threw (e.g. schema invalid) → retry via dev resume
        }
        const rev = await latestReviewReport(stateDir, taskId);
        if (rev?.body?.verdict !== 'approve') {
          writeJsonLine({
            event: 'task.retry',
            taskId,
            attempts: (await loadTask(taskId)).attempts || 0,
            stage: 'review',
            findingCount: (rev?.body?.findings || []).length,
          });
          // review.mjs already bumped attempts and flipped status to 'developing'.
          continue;
        }
      }

      // Merge and mark done.
      const { mergeWorktree, removeWorktree } = await worktreeLib();
      let merge;
      try {
        merge = await mergeWorktree(taskId, /* targetBranch */ 'main');
      } catch (err) {
        merge = { ok: false, error: err.message };
      }
      const current = await loadTask(taskId);
      if (merge && merge.ok !== false) {
        current.status = 'done';
        await saveTask(current);
        await appendHistory(taskId, { ts: nowIso(), event: 'merged' });
        try { await removeWorktree(taskId, { force: false }); } catch { /* best effort */ }
        writeJsonLine({ event: 'task.done', taskId });
      } else {
        current.status = 'blocked';
        await saveTask(current);
        await appendHistory(taskId, { ts: nowIso(), event: 'merge.failed', error: merge?.error });
        writeJsonLine({ event: 'task.blocked', taskId, reason: 'merge-conflict', error: merge?.error });
      }
      return;
    }
  }
}
