// Persistence for the pi-agent-cc companion.
//
// All files live under `getStateDir(workspace)`. Layout (see plan §
// "任务状态模型"):
//
//   state/{slug}-{hash}/
//     state.json                  global
//     plan.json                   latest plan (draft|frozen)
//     tasks/tNNN.json             per-task record
//     sessions/                   pi --session / --resume targets
//     worktrees/index.json        { taskId -> {path, branch} }
//     reports/
//       tNNN.test.v{n}.json
//       tNNN.eval.v{n}.json
//       final.eval.json
//
// Writes are "good enough" atomic: write to `<file>.tmp` then rename.
// Concurrent writers on the same file are UB; companion is single-process
// and the orchestrator serializes state mutations.

import fs from "node:fs";
import path from "node:path";

import { getStateDir, resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const STATE_FILE = "state.json";
const PLAN_FILE = "plan.json";
const TASKS_DIR = "tasks";
const SESSIONS_DIR = "sessions";
const WORKTREES_DIR = "worktrees";
const WORKTREES_INDEX = "index.json";
const REPORTS_DIR = "reports";

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  const ts = nowIso();
  return {
    version: STATE_VERSION,
    planStatus: "none", // none|draft|frozen|running|done|blocked
    config: { maxAttempts: 5, defaultParallel: 4 },
    jobs: [],
    workspace: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await fs.promises.writeFile(tmp, body, { encoding: "utf8", flag: "w" });
  await fs.promises.rename(tmp, filePath);
  return filePath;
}

async function readJson(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

// ---------- paths ----------

function paths(workspaceRoot = resolveWorkspaceRoot()) {
  const stateDir = getStateDir(workspaceRoot);
  return {
    workspaceRoot,
    stateDir,
    stateFile: path.join(stateDir, STATE_FILE),
    planFile: path.join(stateDir, PLAN_FILE),
    tasksDir: path.join(stateDir, TASKS_DIR),
    sessionsDir: path.join(stateDir, SESSIONS_DIR),
    worktreesDir: path.join(stateDir, WORKTREES_DIR),
    worktreesIndex: path.join(stateDir, WORKTREES_DIR, WORKTREES_INDEX),
    reportsDir: path.join(stateDir, REPORTS_DIR),
  };
}

/** Re-export so CLI handlers can obtain the state dir without importing workspace. */
export { getStateDir };

export function getSessionPath(role, taskId, workspaceRoot = resolveWorkspaceRoot()) {
  const p = paths(workspaceRoot);
  ensureDir(p.sessionsDir);
  const safeTask = taskId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const safeRole = role.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(p.sessionsDir, `${safeRole}-${safeTask}.jsonl`);
}

export function ensureStateLayout(workspaceRoot = resolveWorkspaceRoot()) {
  const p = paths(workspaceRoot);
  ensureDir(p.stateDir);
  ensureDir(p.tasksDir);
  ensureDir(p.sessionsDir);
  ensureDir(p.worktreesDir);
  ensureDir(p.reportsDir);
  return p;
}

// ---------- state.json ----------

export async function loadState(workspaceRoot = resolveWorkspaceRoot()) {
  const p = paths(workspaceRoot);
  const existing = await readJson(p.stateFile);
  if (!existing) return defaultState();
  const merged = { ...defaultState(), ...existing };
  merged.config = { ...defaultState().config, ...(existing.config ?? {}) };
  merged.jobs = Array.isArray(existing.jobs) ? existing.jobs : [];
  return merged;
}

export async function saveState(nextState, workspaceRoot = resolveWorkspaceRoot()) {
  const p = ensureStateLayout(workspaceRoot);
  const toWrite = {
    ...defaultState(),
    ...nextState,
    version: STATE_VERSION,
    updatedAt: nowIso(),
  };
  toWrite.config = { ...defaultState().config, ...(nextState.config ?? {}) };
  await writeJsonAtomic(p.stateFile, toWrite);
  return toWrite;
}

// ---------- plan.json ----------

export async function loadPlan(workspaceRoot = resolveWorkspaceRoot()) {
  return readJson(paths(workspaceRoot).planFile);
}

export async function savePlan(plan, workspaceRoot = resolveWorkspaceRoot()) {
  const p = ensureStateLayout(workspaceRoot);
  const body = { ...plan, updatedAt: nowIso() };
  await writeJsonAtomic(p.planFile, body);
  return body;
}

// ---------- tasks/ ----------

function taskFile(taskId, workspaceRoot = resolveWorkspaceRoot()) {
  const p = paths(workspaceRoot);
  return path.join(p.tasksDir, `${taskId}.json`);
}

export async function loadTask(taskId, workspaceRoot = resolveWorkspaceRoot()) {
  return readJson(taskFile(taskId, workspaceRoot));
}

export async function saveTask(task, workspaceRoot = resolveWorkspaceRoot()) {
  if (!task || typeof task.id !== "string" || !task.id) {
    throw new Error("saveTask: task.id is required");
  }
  ensureStateLayout(workspaceRoot);
  const body = { ...task, updatedAt: nowIso() };
  await writeJsonAtomic(taskFile(task.id, workspaceRoot), body);
  return body;
}

export async function listTasks(workspaceRoot = resolveWorkspaceRoot()) {
  const p = paths(workspaceRoot);
  let entries;
  try {
    entries = await fs.promises.readdir(p.tasksDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const files = entries.filter((name) => name.endsWith(".json"));
  const tasks = [];
  for (const name of files) {
    const task = await readJson(path.join(p.tasksDir, name));
    if (task) tasks.push(task);
  }
  tasks.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return tasks;
}

export async function appendHistory(taskId, event, workspaceRoot = resolveWorkspaceRoot()) {
  const task = (await loadTask(taskId, workspaceRoot)) ?? {
    id: taskId,
    status: "unknown",
    history: [],
  };
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({
    ts: nowIso(),
    role: event?.role ?? "system",
    event: event?.event ?? "note",
    summary: event?.summary ?? "",
    ...event,
  });
  await saveTask(task, workspaceRoot);
  return task;
}

// ---------- reports/ ----------

function reportFile(taskId, kind, version, workspaceRoot = resolveWorkspaceRoot()) {
  const p = paths(workspaceRoot);
  const v = Number.isFinite(version) ? `.v${version}` : "";
  return path.join(p.reportsDir, `${taskId}.${kind}${v}.json`);
}

export async function saveReport(taskId, kind, body, workspaceRoot = resolveWorkspaceRoot()) {
  if (!["test", "eval"].includes(kind)) {
    throw new Error(`saveReport: kind must be 'test' or 'eval', got '${kind}'`);
  }
  ensureStateLayout(workspaceRoot);
  const existing = await loadReports(taskId, workspaceRoot);
  const priorCount = existing.filter((r) => r.kind === kind).length;
  const version = priorCount + 1;
  const fullBody = { taskId, kind, version, savedAt: nowIso(), ...body };
  await writeJsonAtomic(reportFile(taskId, kind, version, workspaceRoot), fullBody);
  return fullBody;
}

export async function loadReports(taskId, workspaceRoot = resolveWorkspaceRoot()) {
  const p = paths(workspaceRoot);
  let entries;
  try {
    entries = await fs.promises.readdir(p.reportsDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const prefix = `${taskId}.`;
  const files = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  const reports = [];
  for (const name of files) {
    const body = await readJson(path.join(p.reportsDir, name));
    if (body) reports.push(body);
  }
  return reports;
}

// ---------- worktrees/index.json ----------

async function loadWorktreeIndex(workspaceRoot = resolveWorkspaceRoot()) {
  return (await readJson(paths(workspaceRoot).worktreesIndex)) ?? {};
}

async function saveWorktreeIndex(index, workspaceRoot = resolveWorkspaceRoot()) {
  const p = ensureStateLayout(workspaceRoot);
  await writeJsonAtomic(p.worktreesIndex, index);
  return index;
}

export async function recordWorktree(taskId, { path: wtPath, branch }, workspaceRoot = resolveWorkspaceRoot()) {
  const index = await loadWorktreeIndex(workspaceRoot);
  index[taskId] = { path: wtPath, branch, recordedAt: nowIso() };
  return saveWorktreeIndex(index, workspaceRoot);
}

export async function clearWorktree(taskId, workspaceRoot = resolveWorkspaceRoot()) {
  const index = await loadWorktreeIndex(workspaceRoot);
  if (index[taskId]) {
    delete index[taskId];
    await saveWorktreeIndex(index, workspaceRoot);
  }
  return index;
}

export async function getWorktreeRecord(taskId, workspaceRoot = resolveWorkspaceRoot()) {
  const index = await loadWorktreeIndex(workspaceRoot);
  return index[taskId] ?? null;
}

export async function listWorktreeRecords(workspaceRoot = resolveWorkspaceRoot()) {
  return loadWorktreeIndex(workspaceRoot);
}
