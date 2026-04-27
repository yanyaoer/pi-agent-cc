// approve.mjs — force a task to "done" status (human override).

import {
  parseArgs,
  nowIso,
  stateLib,
  writeJsonLine,
} from './_shared.mjs';

export default async function handleApprove(argv) {
  const { positional } = parseArgs(argv);
  const taskId = positional[0];
  const reason = positional.slice(1).join(' ').trim();
  if (!taskId) throw new Error('usage: pi-agent-cc approve <taskId> <reason>');
  if (!reason) throw new Error('approval reason is required');

  const { loadTask, saveTask, appendHistory } = await stateLib();
  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const prev = task.status;
  task.status = 'done';
  task.approvedAt = nowIso();
  task.approvedReason = reason;
  await saveTask(task);
  await appendHistory(taskId, {
    ts: nowIso(),
    event: 'approved',
    from: prev,
    reason,
  });

  writeJsonLine({ event: 'task.approved', taskId, from: prev, reason });
  console.log(`Task ${taskId} marked done by human approval (was: ${prev}).`);
}
