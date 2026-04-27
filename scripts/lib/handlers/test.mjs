// test.mjs — dispatch (or resume) the tester subagent on a single task.

import { loadPrompt } from '../prompts.mjs';
import {
  buildTesterContextFromInputs,
  buildTesterResumePrompt,
} from '../handoff.mjs';
import { parseAndValidate } from '../schema.mjs';
import {
  parseArgs,
  nowIso,
  getStateDir,
  stateLib,
  runnerLib,
  sessionPath,
  loadLatestTestReport,
  saveReport,
  writeJsonLine,
} from './_shared.mjs';

export default async function handleTest(argv) {
  const { opts } = parseArgs(argv);
  const taskId = opts.task || opts.taskId;
  if (!taskId) throw new Error('usage: pi-companion test --task <id> [--resume]');
  const resume = !!opts.resume;

  const stateDir = await getStateDir();
  const { loadTask, saveTask, appendHistory } = await stateLib();
  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (!task.worktree?.path) throw new Error(`task ${taskId} has no worktree; run develop first`);

  task.status = 'testing';
  await saveTask(task);
  await appendHistory(taskId, { ts: nowIso(), role: 'tester', event: resume ? 'resuming' : 'dispatched' });

  const sessPath = sessionPath(stateDir, 'test', taskId);

  // Build prompt
  let prompt;
  if (resume) {
    const latest = await loadLatestTestReport(stateDir, taskId);
    const issueIds = (latest?.body?.issues || []).map((i) => i.id).filter(Boolean);
    prompt = buildTesterResumePrompt({ taskId, issueIds });
  } else {
    const devHistory = [...(task.history || [])].reverse().find((h) => h.role === 'developer' && h.summary);
    const devSummary = devHistory?.summary || '(developer did not leave a summary)';
    prompt = buildTesterContextFromInputs({
      task,
      devSummary,
      worktreePath: task.worktree.path,
      baseBranch: task.worktree.baseBranch || 'main',
    });
  }

  const runner = await runnerLib();
  const result = await runner.runPi({
    systemPromptPath: loadPrompt('tester'),
    tools: ['read', 'bash', 'grep', 'find', 'ls'],
    sessionPath: sessPath,
    resume,
    prompt,
    cwd: task.worktree.path,
    model: opts.model,
  });

  const raw = typeof result?.lastMessage?.text === 'string'
    ? result.lastMessage.text
    : (typeof result?.lastMessage === 'string' ? result.lastMessage : '');

  const parsed = parseAndValidate(raw, 'test-report');
  if (!parsed.ok) {
    writeJsonLine({ event: 'test.invalid', taskId, errors: parsed.errors, raw: raw.slice(-2000) });
    task.status = 'developing';
    task.attempts = (task.attempts || 0) + 1;
    await saveTask(task);
    await appendHistory(taskId, { ts: nowIso(), role: 'tester', event: 'output-invalid', errors: parsed.errors });
    throw new Error(`tester output failed schema validation:\n  ${parsed.errors.join('\n  ')}`);
  }

  const report = parsed.data;
  const reportPath = await saveReport(stateDir, taskId, 'test', report);

  task.sessions = { ...(task.sessions || {}), tester: sessPath };
  const verdict = report.verdict;
  if (verdict === 'PASS') {
    task.status = 'evaluating';
  } else {
    task.status = 'developing';
    task.attempts = (task.attempts || 0) + 1;
  }
  await saveTask(task);
  await appendHistory(taskId, {
    ts: nowIso(),
    role: 'tester',
    event: verdict === 'PASS' ? 'passed' : 'failed',
    summary: report.summary,
    issueCount: (report.issues || []).length,
  });

  writeJsonLine({
    event: 'test.reported',
    taskId,
    verdict,
    issueCount: (report.issues || []).length,
    reportPath,
    sessionPath: sessPath,
  });
}
