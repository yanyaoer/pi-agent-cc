// plan-confirm.mjs — freeze the current draft plan into task records.

import { loadSchema, validate } from '../schema.mjs';
import {
  getStateDir,
  stateLib,
  loadPlan,
  nowIso,
  writeJsonLine,
} from './_shared.mjs';

export default async function handlePlanConfirm(_argv) {
  const stateDir = await getStateDir();
  const plan = await loadPlan(stateDir);
  if (!plan) throw new Error('no plan found. Run /pi:plan <requirement> first.');

  // Re-validate in case the file was hand-edited.
  const schema = loadSchema('plan');
  const vr = validate(plan, schema);
  if (!vr.valid) {
    throw new Error(`plan.json failed schema validation:\n  ${vr.errors.join('\n  ')}`);
  }

  const { saveTask, loadState, saveState, loadTask } = await stateLib();

  let created = 0;
  let skipped = 0;
  for (const spec of plan.tasks) {
    const existing = await loadTask(spec.id).catch(() => null);
    if (existing && existing.status && existing.status !== 'ready') {
      // already in-flight; keep existing record, just refresh description/title/acceptance
      const updated = {
        ...existing,
        title: spec.title,
        description: spec.description,
        acceptance: spec.acceptance,
        deps: spec.deps || [],
        evals: spec.evals || [],
        touchedPaths: spec.touchedPaths || [],
        effort: spec.effort || existing.effort,
        history: [...(existing.history || []), { ts: nowIso(), event: 'plan.refresh' }],
      };
      await saveTask(updated);
      skipped++;
      continue;
    }
    const record = {
      id: spec.id,
      title: spec.title,
      description: spec.description,
      acceptance: spec.acceptance,
      deps: spec.deps || [],
      evals: spec.evals || [],
      touchedPaths: spec.touchedPaths || [],
      effort: spec.effort,
      status: 'ready',
      attempts: 0,
      maxAttempts: 5,
      worktree: null,
      sessions: {},
      history: [{ ts: nowIso(), event: 'created', version: plan.version }],
    };
    await saveTask(record);
    created++;
  }

  const state = (await loadState()) || {};
  state.planStatus = 'frozen';
  state.planVersion = plan.version;
  state.frozenAt = nowIso();
  await saveState(state);

  writeJsonLine({
    event: 'plan.frozen',
    planStatus: 'frozen',
    version: plan.version,
    tasksCreated: created,
    tasksRefreshed: skipped,
    totalTasks: plan.tasks.length,
  });

  console.log(`\nPlan v${plan.version} frozen. ${created} task(s) created, ${skipped} refreshed. Run /pi:start to dispatch.`);
}
