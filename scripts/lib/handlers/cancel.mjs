// cancel.mjs — terminate running pi subprocesses for one or all tasks.

import {
  parseArgs,
  nowIso,
  stateLib,
  writeJsonLine,
} from './_shared.mjs';

export default async function handleCancel(argv) {
  const { positional } = parseArgs(argv);
  const taskId = positional[0]; // optional — if absent, cancel all

  const { loadState, saveState, loadTask, saveTask, appendHistory, listTasks } = await stateLib();
  const state = (await loadState()) || {};
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];

  const toCancel = taskId ? jobs.filter((j) => j.taskId === taskId) : jobs;
  let killed = 0;
  const remaining = [];
  for (const job of jobs) {
    const targeted = !taskId || job.taskId === taskId;
    if (!targeted) { remaining.push(job); continue; }
    if (typeof job.pid === 'number') {
      try {
        process.kill(job.pid, 'SIGTERM');
        killed++;
      } catch (err) {
        // pid gone already
        writeJsonLine({ event: 'cancel.killFailed', taskId: job.taskId, pid: job.pid, error: err.message });
      }
    }
  }
  state.jobs = remaining;
  await saveState(state);

  // Mark cancelled tasks.
  const affectedIds = taskId
    ? [taskId]
    : [...new Set(toCancel.map((j) => j.taskId).filter(Boolean))];

  // If no job records exist but caller still named a task id, mark it cancelled.
  if (affectedIds.length === 0 && taskId) affectedIds.push(taskId);

  for (const id of affectedIds) {
    const t = await loadTask(id).catch(() => null);
    if (!t) continue;
    if (['done', 'blocked'].includes(t.status)) continue;
    t.status = 'cancelled';
    await saveTask(t);
    await appendHistory(id, { ts: nowIso(), event: 'cancelled', killed: !!killed });
  }

  // If no target given, also mark running-ish tasks cancelled.
  if (!taskId) {
    const tasks = await listTasks();
    for (const t of tasks) {
      if (['developing', 'testing', 'evaluating'].includes(t.status)) {
        t.status = 'cancelled';
        await saveTask(t);
        await appendHistory(t.id, { ts: nowIso(), event: 'cancelled.global' });
      }
    }
    state.planStatus = 'cancelled';
    await saveState(state);
  }

  writeJsonLine({ event: 'cancel.done', taskId: taskId || null, killed, affected: affectedIds });
  console.log(`Cancelled ${killed} job(s)${taskId ? ` for ${taskId}` : ' (all tasks)'}.`);
}
