// develop.mjs — dispatch (or resume) the developer subagent on a single task.

import path from 'node:path';
import { loadPrompt } from '../prompts.mjs';
import { buildDevResumePrompt } from '../handoff.mjs';
import {
  parseArgs,
  nowIso,
  getStateDir,
  stateLib,
  runnerLib,
  worktreeLib,
  sessionPath,
  loadLatestTestReport,
  writeJsonLine,
} from './_shared.mjs';

export default async function handleDevelop(argv) {
  const { opts } = parseArgs(argv);
  const taskId = opts.task || opts.taskId;
  if (!taskId) throw new Error('usage: pi-companion develop --task <id> [--resume]');
  const resume = !!opts.resume;

  const stateDir = await getStateDir();
  const { loadTask, saveTask, appendHistory } = await stateLib();
  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  // First-run: create worktree if not present.
  if (!resume) {
    if (!task.worktree) {
      const { createWorktree } = await worktreeLib();
      const wt = await createWorktree(taskId, opts.baseBranch || 'main');
      task.worktree = wt;
    }
    task.status = 'developing';
    await saveTask(task);
    await appendHistory(taskId, { ts: nowIso(), role: 'developer', event: 'dispatched' });
  } else {
    await appendHistory(taskId, { ts: nowIso(), role: 'developer', event: 'resuming' });
  }

  const sessPath = sessionPath(stateDir, 'dev', taskId);

  // Build prompt.
  let prompt;
  if (resume) {
    const latestTest = await loadLatestTestReport(stateDir, taskId);
    const issues = latestTest?.body?.issues || [];
    prompt = buildDevResumePrompt({ taskId, issues });
  } else {
    const acceptance = (task.acceptance || []).map((a) => `- ${a}`).join('\n');
    prompt = `Task ${task.id}: ${task.title}\n\n${task.description}\n\nAcceptance criteria:\n${acceptance}\n\nYou are already cd'd into this task's worktree. Implement, run any cheap local checks, and conclude with the "## Completed / ## Files Changed / ## Notes" summary.`;
  }

  const runner = await runnerLib();
  const result = await runner.runPi({
    systemPromptPath: loadPrompt('developer'),
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'],
    sessionPath: sessPath,
    resume,
    prompt,
    cwd: task.worktree?.path || process.cwd(),
    model: opts.model,
  });

  const summaryRaw = typeof result?.lastMessage?.text === 'string'
    ? result.lastMessage.text
    : (typeof result?.lastMessage === 'string' ? result.lastMessage : '');
  const summary = summaryRaw.slice(0, 600);

  task.sessions = { ...(task.sessions || {}), developer: sessPath };
  if (!task.status || task.status === 'ready') task.status = 'developing';
  await saveTask(task);
  await appendHistory(taskId, {
    ts: nowIso(),
    role: 'developer',
    event: resume ? 'resumed' : 'completed',
    summary,
    exitCode: result?.exitCode,
  });

  writeJsonLine({
    event: resume ? 'develop.resumed' : 'develop.completed',
    taskId,
    exitCode: result?.exitCode ?? 0,
    sessionPath: sessPath,
    summary,
  });
}
