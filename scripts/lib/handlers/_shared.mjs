// _shared.mjs — helpers shared across companion handlers.
//
// Centralises argv parsing, state-file path helpers, and report loading so
// individual handlers stay small.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal argv parser: supports `--flag`, `--key value`, `--key=value`, and
 * positional arguments. Returns `{ opts, positional }`.
 */
export function parseArgs(argv) {
  const opts = {};
  const positional = [];
  const list = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = list[i + 1];
        if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
          opts[key] = true;
        } else {
          opts[key] = next;
          i++;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

export function nowIso() {
  return new Date().toISOString();
}

export function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

export async function getStateDir() {
  const mod = await import('../state.mjs');
  return mod.getStateDir();
}

export async function stateLib() {
  return await import('../state.mjs');
}

export async function workspaceLib() {
  return await import('../workspace.mjs');
}

export async function runnerLib() {
  return await import('../pi-runner.mjs');
}

export async function worktreeLib() {
  return await import('../worktree.mjs');
}

export async function renderLib() {
  return await import('../render.mjs');
}

export async function configLib() {
  return await import('../config.mjs');
}

/**
 * Resolve the effective model for a role, honoring CLI override →
 * env override → config file → role default → pi's own default.
 */
export async function resolveRoleModel(role, override) {
  const cfg = await configLib();
  const ws = await workspaceLib();
  const workspaceRoot = ws.resolveWorkspaceRoot();
  return cfg.getRoleModel(workspaceRoot, role, override);
}

/**
 * Resolve the full role config (model + tools + appendSystemPrompt).
 * Callers typically still pass explicit `tools` / prompt paths that match
 * the role's intent; this is provided for advanced overrides.
 */
export async function resolveRoleConfig(role) {
  const cfg = await configLib();
  const ws = await workspaceLib();
  return cfg.getRoleConfig(ws.resolveWorkspaceRoot(), role);
}

export function sessionPath(stateDir, role, taskId) {
  const base = taskId ? `${role}-${taskId}.jsonl` : `${role}.jsonl`;
  return path.join(stateDir, 'sessions', base);
}

export function planPath(stateDir) {
  return path.join(stateDir, 'plan.json');
}

export function reportsDir(stateDir) {
  return path.join(stateDir, 'reports');
}

export function evalRunPath(stateDir) {
  return path.join(stateDir, 'eval-run.json');
}

export async function loadPlan(stateDir) {
  const p = planPath(stateDir);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(await fs.promises.readFile(p, 'utf8'));
}

export async function savePlan(stateDir, plan) {
  const p = planPath(stateDir);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, JSON.stringify(plan, null, 2));
  return p;
}

export async function saveReport(stateDir, taskId, kind, body) {
  const dir = reportsDir(stateDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = `${taskId}.${kind}.json`;
  const abs = path.join(dir, filename);
  const record = { taskId, kind, savedAt: nowIso(), body };
  await fs.promises.writeFile(abs, JSON.stringify(record, null, 2));
  return abs;
}

export async function loadReports(stateDir, taskId) {
  const dir = reportsDir(stateDir);
  if (!fs.existsSync(dir)) return [];
  const files = await fs.promises.readdir(dir);
  const out = [];
  for (const f of files) {
    if (taskId && !f.startsWith(`${taskId}.`)) continue;
    try {
      const raw = await fs.promises.readFile(path.join(dir, f), 'utf8');
      out.push(JSON.parse(raw));
    } catch { /* ignore bad file */ }
  }
  return out;
}

export async function loadAllReports(stateDir) {
  return loadReports(stateDir, null);
}

/**
 * Locate the last test report for a given task id. Returns the parsed body or
 * null if none is found.
 */
export async function loadLatestTestReport(stateDir, taskId) {
  const reports = await loadReports(stateDir, taskId);
  const tests = reports.filter((r) => r.kind === 'test');
  if (tests.length === 0) return null;
  return tests[tests.length - 1];
}

export function toJsonLine(obj) {
  return JSON.stringify(obj);
}

export function writeJsonLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
