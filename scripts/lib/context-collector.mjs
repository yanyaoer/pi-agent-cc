// context-collector.mjs — builds the "Repository Context" pack passed to the
// reviewer. Uses `git diff` for the primary evidence, then ast-grep / ripgrep
// to surface the other call sites that reference the symbols touched by the
// diff. Designed to degrade gracefully: missing tools simply drop their
// section, never abort the collector.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const DEFAULT_MAX_CONTEXT_FILES = 25;
const DEFAULT_MAX_REFS_PER_SYMBOL = 6;
const DEFAULT_MAX_DIFF_CHARS = 40_000;

const LANG_BY_EXT = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".c":  "c",
  ".h":  "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
};

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      ...opts,
    });
  } catch (err) {
    return null;
  }
}

function hasBin(name) {
  const r = sh("which", [name]);
  return !!(r && r.trim());
}

function truncate(str, limit, label = "diff") {
  if (!str) return "";
  if (str.length <= limit) return str;
  return `${str.slice(0, limit)}\n\n… (${str.length - limit} chars of ${label} truncated)`;
}

function langForFile(file) {
  const i = file.lastIndexOf(".");
  if (i < 0) return null;
  return LANG_BY_EXT[file.slice(i).toLowerCase()] || null;
}

/**
 * Parse the third field of a git diff hunk header — the "function context"
 * hint git prints after `@@`. Works across many languages because git's
 * built-in per-language userdiff drivers populate it.
 * Example input line: `@@ -10,5 +10,8 @@ def compute_score(user):`
 */
function extractHunkSymbols(diffText) {
  const syms = new Set();
  const re = /^@@ .*? @@\s*(.+)$/gm;
  let m;
  while ((m = re.exec(diffText)) !== null) {
    const ctx = m[1].trim();
    // Heuristic: take the first identifier-looking token(s).
    const id = ctx.match(/[A-Za-z_][A-Za-z0-9_]*/g);
    if (!id) continue;
    // Filter out keywords that are usually noise as stand-alone refs.
    const kw = new Set([
      "function","async","class","const","let","var","def","struct","enum",
      "interface","type","public","private","protected","static","trait",
      "impl","fn","pub","module","namespace","if","for","while","switch",
    ]);
    for (const tok of id) {
      if (!kw.has(tok) && tok.length >= 3) {
        syms.add(tok);
        break; // first meaningful id per header is enough
      }
    }
  }
  return [...syms];
}

function runGitDiff(worktree, baseBranch) {
  const stat = sh("git", ["-C", worktree, "diff", `${baseBranch}...HEAD`, "--stat"]) || "";
  const nameOnly = sh("git", ["-C", worktree, "diff", `${baseBranch}...HEAD`, "--name-only"]) || "";
  const full = sh("git", ["-C", worktree, "diff", `${baseBranch}...HEAD`, "-U3"]) || "";
  const files = nameOnly.split("\n").map((s) => s.trim()).filter(Boolean);
  return { stat, nameOnly, full, files };
}

function astGrepDefinitions(worktree, file) {
  if (!hasBin("ast-grep")) return [];
  const lang = langForFile(file);
  if (!lang) return [];
  // Ask ast-grep to list top-level callable / type identifiers in the file.
  // We try a small set of generic patterns per language; misses are fine —
  // the diff-hunk heuristic picks up the rest.
  const patterns = {
    javascript: ["function $NAME($$$) { $$$ }", "export function $NAME($$$) { $$$ }"],
    typescript: ["function $NAME($$$) { $$$ }", "export function $NAME($$$) { $$$ }"],
    tsx:        ["function $NAME($$$) { $$$ }", "export function $NAME($$$) { $$$ }"],
    python:     ["def $NAME($$$):\n    $$$", "class $NAME:\n    $$$"],
    go:         ["func $NAME($$$) $$$ { $$$ }"],
    rust:       ["fn $NAME($$$) { $$$ }", "pub fn $NAME($$$) { $$$ }"],
    java:       ["class $NAME { $$$ }"],
    ruby:       ["def $NAME\n$$$\nend"],
  };
  const pats = patterns[lang] || [];
  const found = new Set();
  for (const p of pats) {
    const out = sh("ast-grep", ["run", "--pattern", p, "--lang", lang, "--json=stream", file], { cwd: worktree });
    if (!out) continue;
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const meta = j.metaVariables?.single?.NAME?.text;
        if (meta) found.add(meta);
      } catch { /* tolerate */ }
    }
  }
  return [...found];
}

function findReferences(worktree, symbol, { ignoreFiles = [], limit = DEFAULT_MAX_REFS_PER_SYMBOL } = {}) {
  if (!symbol || symbol.length < 3) return [];
  if (!hasBin("rg")) return [];
  const args = ["-n", "--no-messages", "-F", "--word-regexp", symbol, "."];
  const out = sh("rg", args, { cwd: worktree });
  if (!out) return [];
  const ignore = new Set(ignoreFiles);
  const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
  // format: path:line:content
  const refs = [];
  for (const l of lines) {
    const m = l.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineNo, content] = m;
    if (ignore.has(file)) continue;
    refs.push({ file, line: Number(lineNo), content: content.slice(0, 200) });
    if (refs.length >= limit) break;
  }
  return refs;
}

/**
 * Build the reviewer's repository-context pack.
 * @param {Object} opts
 * @param {string} opts.worktreePath absolute path to the task worktree
 * @param {string} opts.taskId
 * @param {string} opts.baseBranch defaults to 'main'
 * @param {number} [opts.maxContextFiles] cap for per-file refs section
 * @param {number} [opts.maxRefsPerSymbol]
 * @param {number} [opts.maxDiffChars]
 */
export function collectReviewContext(opts) {
  const {
    worktreePath,
    taskId,
    baseBranch = "main",
    maxContextFiles = DEFAULT_MAX_CONTEXT_FILES,
    maxRefsPerSymbol = DEFAULT_MAX_REFS_PER_SYMBOL,
    maxDiffChars = DEFAULT_MAX_DIFF_CHARS,
  } = opts;

  if (!worktreePath || !fs.existsSync(worktreePath)) {
    throw new Error(`collectReviewContext: worktreePath '${worktreePath}' does not exist`);
  }

  const { stat, full, files } = runGitDiff(worktreePath, baseBranch);
  const symbols = extractHunkSymbols(full);

  // Try ast-grep per-file to enrich the symbol set.
  for (const f of files.slice(0, maxContextFiles)) {
    for (const name of astGrepDefinitions(worktreePath, f)) symbols.push(name);
  }
  const uniqueSymbols = [...new Set(symbols)].slice(0, 30);

  // Reverse-lookup refs for each symbol.
  const refsBySymbol = {};
  for (const sym of uniqueSymbols) {
    const refs = findReferences(worktreePath, sym, {
      ignoreFiles: files,
      limit: maxRefsPerSymbol,
    });
    if (refs.length > 0) refsBySymbol[sym] = refs;
  }

  const parts = [];
  parts.push(`## Repository Context (task ${taskId})`);
  parts.push(`Base branch: \`${baseBranch}\` · worktree: \`${worktreePath}\``);
  parts.push("");
  parts.push("### Changed files");
  parts.push("```");
  parts.push(stat.trim() || "(git diff --stat empty)");
  parts.push("```");
  parts.push("");

  parts.push("### Full diff (truncated if large)");
  parts.push("```diff");
  parts.push(truncate(full, maxDiffChars));
  parts.push("```");
  parts.push("");

  if (uniqueSymbols.length > 0) {
    parts.push(`### Symbols touched by the diff`);
    parts.push(uniqueSymbols.map((s) => `- \`${s}\``).join("\n"));
    parts.push("");
  }

  const symKeys = Object.keys(refsBySymbol);
  if (symKeys.length > 0) {
    parts.push("### Cross-references (ast-grep + ripgrep)");
    parts.push("These are other places in the repo that reference the symbols you just changed. Follow them to see how callers are affected.");
    parts.push("");
    for (const sym of symKeys) {
      parts.push(`**${sym}**`);
      for (const r of refsBySymbol[sym]) {
        parts.push(`- \`${r.file}:${r.line}\` — ${r.content}`);
      }
      parts.push("");
    }
  } else {
    parts.push("### Cross-references");
    parts.push("(none found by ast-grep / ripgrep — either the diff touches only internal/new symbols, or the tools are unavailable on this host.)");
    parts.push("");
  }

  parts.push("### Tools you may run via bash");
  parts.push("- `rg <pat>` / `ast-grep run --pattern '...' --lang <l>` to keep digging");
  parts.push("- `git log -p -- <file>` / `git blame <file>` for provenance");
  parts.push("- Any LSP-backed CLI already on PATH (`tsc --noEmit`, `pyright`, `cargo check`, `go vet`, `mypy`, etc.) — do not install anything new");
  parts.push("");

  return { text: parts.join("\n"), symbols: uniqueSymbols, refCount: symKeys.length };
}
