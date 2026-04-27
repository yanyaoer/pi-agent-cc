#!/usr/bin/env node
// pi-companion: entry-point CLI for the pi-agent-cc Claude Code plugin.
//
// P1 scope: dispatcher + `init` + `status`. The other handlers are stubs
// that throw `to be implemented by P2`; P2 will replace them in place.
//
// All subcommands consume their args from `process.argv.slice(3)` and
// should write progress/errors to stderr, JSON/markdown payload to stdout.

import fs from "node:fs";
import path from "node:path";

import {
  ensureStateLayout,
  listTasks,
  loadState,
  saveState,
} from "./lib/state.mjs";
import {
  renderStatusJson,
  renderStatusTable,
} from "./lib/render.mjs";
import {
  getStateDir,
  resolveWorkspaceRoot,
} from "./lib/workspace.mjs";

// ---------- arg helpers ----------

function parseFlags(argv, spec = {}) {
  // spec: { booleans:[], aliases:{-p:'--parallel'} }
  const booleans = new Set(spec.booleans ?? []);
  const aliases = spec.aliases ?? {};
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i];
    if (token in aliases) token = aliases[token];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (eq !== -1) {
        out[key] = token.slice(eq + 1);
      } else if (booleans.has(key)) {
        out[key] = true;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          out[key] = true;
        } else {
          out[key] = next;
          i += 1;
        }
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

// ---------- handlers ----------

async function handleInit(args) {
  const flags = parseFlags(args, { booleans: ["json"] });
  const workspaceRoot = resolveWorkspaceRoot();
  const paths = ensureStateLayout(workspaceRoot);

  const existing = await loadState(workspaceRoot);
  const isNew = !fs.existsSync(paths.stateFile);
  const saved = await saveState(
    {
      ...existing,
      workspace: workspaceRoot,
      planStatus: existing.planStatus ?? "none",
    },
    workspaceRoot,
  );

  const payload = {
    ok: true,
    created: isNew,
    workspace: workspaceRoot,
    stateDir: paths.stateDir,
    stateFile: paths.stateFile,
    planStatus: saved.planStatus,
  };

  if (flags.json) {
    printJson(payload);
  } else {
    process.stdout.write(
      `pi-agent-cc initialised\n` +
        `  workspace : ${workspaceRoot}\n` +
        `  state dir : ${paths.stateDir}\n` +
        `  state file: ${paths.stateFile}\n` +
        `  plan      : ${saved.planStatus}\n`,
    );
  }
}

async function handleStatus(args) {
  const flags = parseFlags(args, { booleans: ["json"] });
  const workspaceRoot = resolveWorkspaceRoot();
  const stateDir = getStateDir(workspaceRoot);

  const state = await loadState(workspaceRoot);
  let tasks = await listTasks(workspaceRoot);
  const explicitId = flags._[0];
  if (explicitId) {
    tasks = tasks.filter((t) => t.id === explicitId);
  }

  const opts = {
    planStatus: state.planStatus,
    totalTasks: tasks.length,
    workspace: workspaceRoot,
    stateDir,
  };

  if (flags.json) {
    process.stdout.write(`${renderStatusJson(tasks, opts)}\n`);
  } else {
    process.stdout.write(`${renderStatusTable(tasks, { ...opts, title: "pi-agent-cc status" })}\n`);
  }
}

// Stubs — P2 fills these in.
function notImplementedBy(p) {
  return async () => {
    throw new Error(`to be implemented by ${p}`);
  };
}

const HANDLERS = {
  init: handleInit,
  status: handleStatus,
  plan: notImplementedBy("P2"),
  "plan-confirm": notImplementedBy("P2"),
  develop: notImplementedBy("P2"),
  test: notImplementedBy("P2"),
  evaluate: notImplementedBy("P2"),
  orchestrate: notImplementedBy("P2"),
  resume: notImplementedBy("P2"),
  report: notImplementedBy("P2"),
  approve: notImplementedBy("P2"),
  cancel: notImplementedBy("P2"),
};

function usage() {
  const subcommands = Object.keys(HANDLERS).join(", ");
  return (
    `Usage: pi-companion <subcommand> [args]\n` +
    `\n` +
    `Subcommands: ${subcommands}\n` +
    `\n` +
    `Common flags:\n` +
    `  --json         emit machine-readable JSON (supported by init, status)\n`
  );
}

async function main() {
  const [, , subcommand, ...rest] = process.argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(usage());
    process.exit(0);
  }
  const handler = HANDLERS[subcommand];
  if (!handler) {
    process.stderr.write(`unknown subcommand: ${subcommand}\n\n${usage()}`);
    process.exit(2);
  }
  try {
    await handler(rest);
  } catch (err) {
    const message = err?.message ?? String(err);
    process.stderr.write(`pi-companion ${subcommand}: ${message}\n`);
    if (process.env.PI_COMPANION_DEBUG) {
      process.stderr.write(`${err?.stack ?? ""}\n`);
    }
    process.exit(1);
  }
}

// Resolve __dirname even when the script is executed via `node <path>`.
const __filename = new URL(import.meta.url).pathname;
void __filename;

main();
