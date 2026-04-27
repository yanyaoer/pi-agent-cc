// git worktree CRUD + merge coordination.
//
// All git commands run with `git -C <workspaceRoot>` — never from inside
// the worktree itself — so the same logic works whether the companion
// was launched from the main repo or a subdirectory.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { clearWorktree, recordWorktree } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const WORKTREE_DIR = ".worktrees";
const BRANCH_PREFIX = "pi/";

/**
 * Spawn `git ...args` in `cwd`, capture stdout/stderr, return structured result.
 * Never throws for non-zero exit codes — callers decide based on `status`.
 */
function runGit(cwd, args, { stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (error) => {
      resolve({ status: -1, stdout, stderr, error });
    });
    child.on("close", (code) => {
      resolve({ status: code ?? -1, stdout, stderr, error: null });
    });
    if (stdin) {
      child.stdin.end(stdin);
    }
  });
}

function branchFor(taskId) {
  return `${BRANCH_PREFIX}${taskId}`;
}

function worktreePath(workspaceRoot, taskId) {
  return path.join(workspaceRoot, WORKTREE_DIR, taskId);
}

function formatError(prefix, result) {
  const parts = [prefix];
  if (result.error) parts.push(result.error.message);
  if (result.stderr) parts.push(result.stderr.trim());
  if (result.stdout) parts.push(result.stdout.trim());
  return parts.filter(Boolean).join(" | ");
}

/**
 * Create a new worktree at `.worktrees/<taskId>` tracking branch `pi/<taskId>`.
 * If the branch already exists, it is reused (checkout without -b).
 * Returns { path, branch, reused }.
 */
export async function createWorktree(taskId, baseBranch = "main", workspaceRoot = resolveWorkspaceRoot()) {
  const branch = branchFor(taskId);
  const target = worktreePath(workspaceRoot, taskId);

  // Make sure the parent dir exists.
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // If the target is already a checked-out worktree, reuse it.
  const existing = await listWorktrees(workspaceRoot);
  const alreadyThere = existing.find((w) => path.resolve(w.path) === path.resolve(target));
  if (alreadyThere) {
    await recordWorktree(taskId, { path: target, branch: alreadyThere.branch ?? branch }, workspaceRoot);
    return { path: target, branch: alreadyThere.branch ?? branch, reused: true };
  }

  // Does the branch already exist? If yes, add without -b; else create.
  const branchCheck = await runGit(workspaceRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  const branchExists = branchCheck.status === 0;

  const addArgs = branchExists
    ? ["worktree", "add", target, branch]
    : ["worktree", "add", "-b", branch, target, baseBranch];
  const result = await runGit(workspaceRoot, addArgs);
  if (result.status !== 0) {
    throw new Error(formatError(`git worktree add failed for ${taskId}:`, result));
  }

  await recordWorktree(taskId, { path: target, branch }, workspaceRoot);
  return { path: target, branch, reused: branchExists };
}

/**
 * Remove the worktree for `taskId`. If `force` is true, pass --force and
 * also delete the branch (-D); otherwise attempt a safe removal and leave
 * the branch in place so the user can inspect it.
 */
export async function removeWorktree(taskId, { force = false, deleteBranch = force, workspaceRoot = resolveWorkspaceRoot() } = {}) {
  const target = worktreePath(workspaceRoot, taskId);
  const branch = branchFor(taskId);

  const removeArgs = ["worktree", "remove"];
  if (force) removeArgs.push("--force");
  removeArgs.push(target);
  const rm = await runGit(workspaceRoot, removeArgs);
  if (rm.status !== 0 && !/not a working tree/i.test(rm.stderr ?? "")) {
    // If the path is already gone, prune and continue.
    await runGit(workspaceRoot, ["worktree", "prune"]);
  }

  if (deleteBranch) {
    const del = await runGit(workspaceRoot, ["branch", "-D", branch]);
    if (del.status !== 0 && !/not found/i.test(del.stderr ?? "")) {
      // Don't fail the whole operation — record it in the response.
      await clearWorktree(taskId, workspaceRoot);
      return { ok: true, branchDeleted: false, warning: (del.stderr ?? "").trim() };
    }
  }

  await clearWorktree(taskId, workspaceRoot);
  return { ok: true, branchDeleted: !!deleteBranch };
}

/**
 * Merge `pi/<taskId>` into `targetBranch`.
 *
 * On conflict, abort the merge and return `{ok:false, conflict:true, files}`
 * instead of throwing — orchestrator decides how to surface it.
 */
export async function mergeWorktree(
  taskId,
  { targetBranch = "main", message, workspaceRoot = resolveWorkspaceRoot() } = {},
) {
  const branch = branchFor(taskId);

  // Capture current branch so we can restore on failure.
  const currentRes = await runGit(workspaceRoot, ["branch", "--show-current"]);
  const previousBranch = currentRes.status === 0 ? currentRes.stdout.trim() : null;

  const checkout = await runGit(workspaceRoot, ["checkout", targetBranch]);
  if (checkout.status !== 0) {
    throw new Error(formatError(`git checkout ${targetBranch} failed:`, checkout));
  }

  const msg = message ?? `Merge ${branch} into ${targetBranch}`;
  const merge = await runGit(workspaceRoot, ["merge", "--no-ff", branch, "-m", msg]);
  if (merge.status === 0) {
    return { ok: true, conflict: false, branch, targetBranch };
  }

  // Collect conflicted files, then abort to leave the tree clean.
  const conflictsRes = await runGit(workspaceRoot, ["diff", "--name-only", "--diff-filter=U"]);
  const files = conflictsRes.status === 0
    ? conflictsRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
    : [];
  await runGit(workspaceRoot, ["merge", "--abort"]);
  if (previousBranch && previousBranch !== targetBranch) {
    await runGit(workspaceRoot, ["checkout", previousBranch]);
  }
  return { ok: false, conflict: true, branch, targetBranch, files, message: (merge.stderr ?? merge.stdout ?? "").trim() };
}

/**
 * Parse `git worktree list --porcelain` into an array of
 * `{ path, branch, head, bare, detached }` records.
 */
export async function listWorktrees(workspaceRoot = resolveWorkspaceRoot()) {
  const result = await runGit(workspaceRoot, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) {
    if (result.error && result.error.code === "ENOENT") {
      throw new Error("git CLI is not installed or not on PATH.");
    }
    return [];
  }

  const entries = [];
  let current = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim(), branch: null, head: null, bare: false, detached: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}
