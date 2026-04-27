// report.mjs — assemble a final markdown / JSON summary of the run.

import fs from 'node:fs';
import {
  parseArgs,
  getStateDir,
  stateLib,
  loadPlan,
  loadAllReports,
  evalRunPath,
  reportsDir,
} from './_shared.mjs';
import path from 'node:path';

export default async function handleReport(argv) {
  const { opts } = parseArgs(argv);
  const stateDir = await getStateDir();
  const plan = await loadPlan(stateDir);
  const { listTasks, loadState } = await stateLib();
  const tasks = await listTasks();
  const state = (await loadState()) || {};

  const allReports = await loadAllReports(stateDir);
  const testReports = allReports.filter((r) => r.kind === 'test');
  const finalEvalPath = path.join(reportsDir(stateDir), '_final.eval.json');
  let finalEval = null;
  if (fs.existsSync(finalEvalPath)) {
    try { finalEval = JSON.parse(fs.readFileSync(finalEvalPath, 'utf8')); } catch { /* ignore */ }
  }
  let evalRun = null;
  if (fs.existsSync(evalRunPath(stateDir))) {
    try { evalRun = JSON.parse(fs.readFileSync(evalRunPath(stateDir), 'utf8')); } catch { /* ignore */ }
  }

  if (opts.json) {
    const out = { plan, tasks, testReports, evalRun, finalEval, state };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  const lines = [];
  lines.push('# pi-agent-cc Report');
  lines.push('');
  lines.push(`- Plan status: **${state.planStatus || 'unknown'}**`);
  if (plan) lines.push(`- Plan version: ${plan.version}`);
  if (state.lastEvalVerdict) lines.push(`- Last evaluator verdict: **${state.lastEvalVerdict}** (score ${state.lastEvalScore ?? '?'})`);
  lines.push('');

  if (plan?.summary) {
    lines.push('## Plan summary');
    lines.push('');
    lines.push(plan.summary);
    lines.push('');
  }

  lines.push('## Tasks');
  lines.push('');
  lines.push('| id | title | status | attempts | deps |');
  lines.push('|---|---|---|---|---|');
  for (const t of tasks) {
    lines.push(`| ${t.id} | ${escapePipe(t.title)} | ${t.status} | ${t.attempts || 0}/${t.maxAttempts || 5} | ${(t.deps || []).join(', ') || '-'} |`);
  }
  lines.push('');

  if (testReports.length) {
    lines.push('## Test reports');
    lines.push('');
    for (const r of testReports) {
      lines.push(`### ${r.taskId} — ${r.body?.verdict || '?'}`);
      if (r.body?.summary) lines.push(r.body.summary);
      const issues = r.body?.issues || [];
      if (issues.length) {
        lines.push('');
        for (const i of issues) {
          lines.push(`- **${i.severity}** \`${i.id}\` — ${i.description}`);
        }
      }
      lines.push('');
    }
  }

  if (evalRun) {
    lines.push('## Automated evals');
    lines.push('');
    lines.push(`- Passed: ${evalRun.totalPassed}`);
    lines.push(`- Failed: ${evalRun.totalFailed}`);
    for (const r of evalRun.results || []) {
      const status = r.passed ? 'PASS' : 'FAIL';
      lines.push(`  - [${status}] ${r.file}${r.error ? ` — ${r.error}` : ''}`);
    }
    lines.push('');
  }

  if (finalEval?.body) {
    lines.push('## Evaluator verdict');
    lines.push('');
    lines.push(`**${finalEval.body.verdict}** — score ${finalEval.body.score}`);
    if (finalEval.body.recommendations) {
      lines.push('');
      lines.push(finalEval.body.recommendations);
    }
    lines.push('');
  }

  process.stdout.write(lines.join('\n') + '\n');
}

function escapePipe(s) {
  return String(s || '').replace(/\|/g, '\\|');
}
