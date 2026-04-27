// pi CLI process wrapper.
//
// Spawns `pi --mode json -p ...` and streams the JSONL event log line by line.
// The contract (documented in context-common.md and verified against
// pi-mono/packages/coding-agent/src/main.ts L149/L239/L496):
//
//   pi --mode json -p
//      [--session <absolute.jsonl> | --resume <absolute.jsonl>]
//      [--append-system-prompt <path>]  (may be passed multiple times)
//      [--tools <csv-or-"all">]
//      [--model <id>]
//      [...extraArgs]
//      <prompt>
//
// The implementation mirrors pi-mono/packages/coding-agent/examples/
// extensions/subagent/index.ts L238-400 (stdout buffering, JSONL parsing,
// abort-signal propagation, usage accumulation) ported to plain JS.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {Object} RunPiResult
 * @property {number} exitCode
 * @property {{role?: string, text: string, parsedJson: any|null, raw: any|null}} lastMessage
 * @property {Array<any>} events  parsed JSONL events from pi stdout
 * @property {string} sessionPath absolute path to the session file used
 * @property {string} stderr      captured stderr (useful on non-zero exit)
 * @property {{input:number, output:number, cacheRead:number, cacheWrite:number, cost:number, contextTokens:number, turns:number}} usage
 * @property {boolean} aborted
 */

// Resolution order for the `pi` binary:
//   1. explicit `piBin` option to runPi()
//   2. PI_BIN env
//   3. plugin-local node_modules/.bin/pi (installed via dependencies)
//   4. bare "pi" on $PATH
export function resolvePiBin() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const local = path.join(pluginRoot, "node_modules", ".bin", "pi");
  if (fs.existsSync(local)) return local;
  return "pi";
}

const DEFAULT_PI_BIN = resolvePiBin();

function assertAbsolute(p, label) {
  if (typeof p !== "string" || !p) {
    throw new Error(`${label}: expected a non-empty string`);
  }
  if (!path.isAbsolute(p)) {
    throw new Error(`${label}: expected absolute path, got '${p}'`);
  }
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

/**
 * Extract a plain-text string from a pi `message` object. pi messages carry
 * `content` as an array of `{type:'text', text:string}` blocks (plus tool
 * blocks). We concatenate text blocks in order; for non-array content we
 * coerce via String().
 */
function extractText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function tryParseJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Try to recover the last JSON object in the string (common when LLM
    // prefixes with prose). Find the last top-level `{...}` balanced pair.
    const lastBrace = text.lastIndexOf("}");
    if (lastBrace === -1) return null;
    let depth = 0;
    for (let i = lastBrace; i >= 0; i -= 1) {
      const ch = text[i];
      if (ch === "}") depth += 1;
      else if (ch === "{") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, lastBrace + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

/**
 * Build the argv for `pi`. Exported so tests can assert the shape without
 * spawning anything.
 */
export function buildPiArgs({
  systemPromptPath,
  tools,
  sessionPath,
  resume = false,
  prompt,
  model,
  appendSystemPromptExtra,
  extraArgs = [],
} = {}) {
  if (sessionPath) assertAbsolute(sessionPath, "sessionPath");
  if (systemPromptPath) assertAbsolute(systemPromptPath, "systemPromptPath");
  if (appendSystemPromptExtra) assertAbsolute(appendSystemPromptExtra, "appendSystemPromptExtra");
  if (typeof prompt !== "string") {
    throw new Error("runPi: `prompt` must be a string");
  }

  const args = ["--mode", "json", "-p"];
  if (sessionPath) {
    args.push(resume ? "--resume" : "--session", sessionPath);
  }
  if (systemPromptPath) {
    args.push("--append-system-prompt", systemPromptPath);
  }
  if (appendSystemPromptExtra) {
    args.push("--append-system-prompt", appendSystemPromptExtra);
  }
  if (tools === "all") {
    args.push("--tools", "all");
  } else if (Array.isArray(tools) && tools.length) {
    args.push("--tools", tools.join(","));
  }
  if (model) {
    args.push("--model", model);
  }
  if (Array.isArray(extraArgs) && extraArgs.length) {
    args.push(...extraArgs);
  }
  args.push(prompt);
  return args;
}

/**
 * Spawn pi and stream JSONL events.
 *
 * Behaviour:
 * - onEvent is invoked for every parsed JSONL record as-is.
 * - `lastMessage` tracks the latest `message_end` payload (assistant/user/tool).
 * - Aborts (via `signal`) kill the child with SIGTERM, then SIGKILL after 5s.
 * - Non-zero exit codes are returned (not thrown) so callers can inspect `events`.
 * - If the last message body fails JSON.parse, `lastMessage.parsedJson` is null
 *   and `lastMessage.text` holds the raw text — the caller decides.
 */
export async function runPi(options = {}) {
  const {
    systemPromptPath,
    tools,
    sessionPath,
    resume = false,
    prompt,
    cwd,
    model,
    appendSystemPromptExtra,
    onEvent,
    signal,
    extraArgs,
    piBin = DEFAULT_PI_BIN,
    env,
  } = options;

  if (sessionPath) ensureParentDir(sessionPath);

  const args = buildPiArgs({
    systemPromptPath,
    tools,
    sessionPath,
    resume,
    prompt,
    model,
    appendSystemPromptExtra,
    extraArgs,
  });

  /** @type {RunPiResult} */
  const result = {
    exitCode: 0,
    lastMessage: { role: undefined, text: "", parsedJson: null, raw: null },
    events: [],
    sessionPath: sessionPath ?? "",
    stderr: "",
    usage: emptyUsage(),
    aborted: false,
  };

  if (signal?.aborted) {
    const err = new Error("runPi: aborted before spawn");
    err.name = "AbortError";
    throw err;
  }

  const child = spawn(piBin, args, {
    cwd: cwd ?? process.cwd(),
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  let stdoutBuffer = "";

  const processLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON output (unlikely with --mode json). Skip.
      return;
    }
    result.events.push(event);
    try {
      onEvent?.(event);
    } catch {
      // Never let a listener crash the runner.
    }

    if (event.type === "message_end" && event.message) {
      const msg = event.message;
      const text = extractText(msg);
      result.lastMessage = {
        role: msg.role,
        text,
        parsedJson: null,
        raw: msg,
      };
      if (msg.role === "assistant") {
        result.usage.turns += 1;
        const usage = msg.usage;
        if (usage) {
          result.usage.input += usage.input || 0;
          result.usage.output += usage.output || 0;
          result.usage.cacheRead += usage.cacheRead || 0;
          result.usage.cacheWrite += usage.cacheWrite || 0;
          result.usage.cost += usage.cost?.total || 0;
          result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
        }
      }
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });

  child.stderr.on("data", (chunk) => {
    result.stderr += chunk.toString("utf8");
  });

  let abortHandler = null;
  let killTimer = null;
  const abortPromise = new Promise((resolve) => {
    if (!signal) return;
    abortHandler = () => {
      result.aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      killTimer = setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 5000);
      resolve();
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", (err) => {
      // Spawn error — surface as thrown for clarity.
      reject(
        Object.assign(new Error(`pi spawn failed: ${err.message}`), {
          cause: err,
          code: "PI_SPAWN_ERROR",
        }),
      );
    });
    child.on("close", (code) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      resolve(code ?? 0);
    });
  });

  if (killTimer) clearTimeout(killTimer);
  if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  // Keep abortPromise referenced to satisfy any lingering microtasks.
  void abortPromise;

  result.exitCode = exitCode;

  // Finalise lastMessage.parsedJson lazily so the caller does not pay for
  // JSON.parse when they only need the raw text.
  if (result.lastMessage.text) {
    result.lastMessage.parsedJson = tryParseJson(result.lastMessage.text);
  }

  if (result.aborted) {
    const err = new Error("runPi: aborted");
    err.name = "AbortError";
    err.partial = result;
    throw err;
  }

  return result;
}
