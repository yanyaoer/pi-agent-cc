// evaluate.mjs — final two-layer evaluation (eval scripts + LLM review).

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadPrompt } from '../prompts.mjs';
import { runEvals } from '../evals.mjs';
import { parseAndValidate } from '../schema.mjs';
import {
  parseArgs,
  nowIso,
  getStateDir,
  stateLib,
  workspaceLib,
  runnerLib,
  resolveRoleModel,
  sessionPath,
  evalRunPath,
  loadPlan,
  loadAllReports,
  saveReport,
  writeJsonLine,
} from './_shared.mjs';

export default async function handleEvaluate(argv) {
  const { opts } = parseArgs(argv);
  const stateDir = await getStateDir();
  const plan = await loadPlan(stateDir);
  if (!plan) throw new Error('no plan found; nothing to evaluate');

  const { listTasks, loadState, saveState } = await stateLib();
  const ws = await workspaceLib();
  const workspaceRoot = typeof ws.resolveWorkspaceRoot === 'function'
    ? ws.resolveWorkspaceRoot()
    : process.cwd();

  const tasks = await listTasks();
  const evalFiles = [...new Set(tasks.flatMap((t) => t.evals || []))];
  const evalRun = await runEvals(evalFiles, { workspace: workspaceRoot, tasks }, { cwd: workspaceRoot });

  await fs.promises.writeFile(evalRunPath(stateDir), JSON.stringify(evalRun, null, 2));
  writeJsonLine({
    event: 'eval.layer1',
    totalPassed: evalRun.totalPassed,
    totalFailed: evalRun.totalFailed,
    files: evalFiles.length,
  });

  let diffStat = '(git diff --stat unavailable)';
  try {
    diffStat = execFileSync('git', ['-C', workspaceRoot, 'diff', '--stat'], { encoding: 'utf8' }).trim();
  } catch { /* ignore */ }

  const reports = await loadAllReports(stateDir);
  const prompt = [
    '## Plan',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
    '',
    '## Tasks',
    '```json',
    JSON.stringify(tasks, null, 2),
    '```',
    '',
    '## Test reports',
    '```json',
    JSON.stringify(reports.filter((r) => r.kind === 'test'), null, 2),
    '```',
    '',
    '## Automated eval run',
    '```json',
    JSON.stringify(evalRun, null, 2),
    '```',
    '',
    '## Git diff stat (since plan freeze)',
    '```',
    diffStat || '(no changes)',
    '```',
    '',
    'Produce your verdict as the LAST JSON object of your reply, per eval-report.schema.json.',
  ].join('\n');

  const runner = await runnerLib();
  const sessPath = sessionPath(stateDir, 'evaluator');
  const result = await runner.runPi({
    systemPromptPath: loadPrompt('evaluator'),
    tools: ['read', 'grep', 'find', 'ls', 'bash'],
    sessionPath: sessPath,
    resume: false,
    prompt,
    cwd: workspaceRoot,
    model: await resolveRoleModel('evaluator', opts.model),
  });

  const raw = typeof result?.lastMessage?.text === 'string'
    ? result.lastMessage.text
    : (typeof result?.lastMessage === 'string' ? result.lastMessage : '');

  const parsed = parseAndValidate(raw, 'eval-report');
  if (!parsed.ok) {
    writeJsonLine({ event: 'eval.invalid', errors: parsed.errors, raw: raw.slice(-2000) });
    throw new Error(`evaluator output failed schema validation:\n  ${parsed.errors.join('\n  ')}`);
  }
  const report = parsed.data;
  const reportPath = await saveReport(stateDir, '_final', 'eval', report);

  // Update global state based on verdict.
  const state = (await loadState()) || {};
  state.lastEvalVerdict = report.verdict;
  state.lastEvalScore = report.score;
  state.lastEvalAt = nowIso();
  if (report.verdict === 'ACCEPT') state.planStatus = 'done';
  else if (report.verdict === 'REJECT') state.planStatus = 'blocked';
  else state.planStatus = 'rework'; // REWORK
  await saveState(state);

  writeJsonLine({
    event: 'eval.reported',
    verdict: report.verdict,
    score: report.score,
    reportPath,
    planStatus: state.planStatus,
  });

  console.log(`\nEvaluator verdict: ${report.verdict} (score ${report.score}).`);
  if (report.recommendations) console.log(report.recommendations);
}
