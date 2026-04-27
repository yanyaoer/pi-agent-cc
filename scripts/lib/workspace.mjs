// Workspace root + slug/hash + state directory resolution.
//
// Algorithm (ported from codex-plugin-cc/plugins/codex/scripts/lib/state.mjs
// L29-56): find a plausible workspace root by walking upward looking for a
// `.git` directory or `package.json`; derive a filesystem-safe slug from its
// basename; append a sha256(absPath).slice(0,16) hash so two repos with the
// same basename do not collide; place state under
// `$CLAUDE_PLUGIN_DATA/state/{slug}-{hash}` (falls back to
// `$XDG_DATA_HOME/claude-pi-agent` or `~/.claude/pi-agent`).

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const XDG_DATA_HOME_ENV = "XDG_DATA_HOME";
const STATE_DIR_NAME = "state";
const FALLBACK_APP_DIR = "pi-agent";

/**
 * Walk up from `startCwd` looking for the first directory that contains
 * a `.git` entry or `package.json`. If nothing is found, return the
 * realpath of `startCwd` so callers always get a stable absolute path.
 */
export function resolveWorkspaceRoot(startCwd = process.cwd()) {
  let dir;
  try {
    dir = fs.realpathSync(path.resolve(startCwd));
  } catch {
    dir = path.resolve(startCwd);
  }

  const root = path.parse(dir).root;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const gitEntry = path.join(dir, ".git");
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(gitEntry) || fs.existsSync(pkg)) {
      return dir;
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No marker found. Return the original absolute cwd.
  try {
    return fs.realpathSync(path.resolve(startCwd));
  } catch {
    return path.resolve(startCwd);
  }
}

/**
 * Returns `{slug, hash}` derived from the workspace path.
 * slug = basename with non-alphanumeric characters squashed to `-`.
 * hash = first 16 hex chars of sha256(canonicalAbsPath).
 */
export function getWorkspaceSlug(workspaceRoot) {
  const absolute = path.resolve(workspaceRoot);
  let canonical = absolute;
  try {
    canonical = fs.realpathSync.native
      ? fs.realpathSync.native(absolute)
      : fs.realpathSync(absolute);
  } catch {
    canonical = absolute;
  }
  const base = path.basename(absolute) || "workspace";
  const slug =
    base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return { slug, hash };
}

/**
 * Returns the absolute state directory for a given workspace.
 * Respects CLAUDE_PLUGIN_DATA (preferred) > XDG_DATA_HOME > ~/.claude.
 */
export function getStateDir(workspaceRoot = resolveWorkspaceRoot()) {
  const { slug, hash } = getWorkspaceSlug(workspaceRoot);
  const base = resolveStateBaseDir();
  return path.join(base, STATE_DIR_NAME, `${slug}-${hash}`);
}

function resolveStateBaseDir() {
  const pluginData = process.env[PLUGIN_DATA_ENV];
  if (pluginData && pluginData.trim()) {
    return path.resolve(pluginData);
  }
  const xdg = process.env[XDG_DATA_HOME_ENV];
  if (xdg && xdg.trim()) {
    return path.join(path.resolve(xdg), FALLBACK_APP_DIR);
  }
  return path.join(os.homedir(), ".claude", FALLBACK_APP_DIR);
}
