#!/usr/bin/env node
// pi-companion: entry-point CLI for the pi-agent-cc Claude Code plugin.
//
// P1 scope: dispatcher + `init` + `status`. The other handlers are stubs
// that throw `to be implemented by P2`; P2 will replace them in place.
//
// All subcommands consume their args from `process.argv.slice(3)` and
// should write progress/errors to stderr, JSON/markdown payload to stdout.

import fs from "node:fs";

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

// P2 business handlers (wired in during P4).
import planHandler from "./lib/handlers/plan.mjs";
import planConfirmHandler from "./lib/handlers/plan-confirm.mjs";
import developHandler from "./lib/handlers/develop.mjs";
import testHandler from "./lib/handlers/test.mjs";
import reviewHandler from "./lib/handlers/review.mjs";
import evaluateHandler from "./lib/handlers/evaluate.mjs";
import orchestrateHandler from "./lib/handlers/orchestrate.mjs";
import resumeHandler from "./lib/handlers/resume.mjs";
import reportHandler from "./lib/handlers/report.mjs";
import approveHandler from "./lib/handlers/approve.mjs";
import cancelHandler from "./lib/handlers/cancel.mjs";

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

const HANDLERS = {
  init: handleInit,
  status: handleStatus,
  plan: planHandler,
  "plan-confirm": planConfirmHandler,
  develop: developHandler,
  test: testHandler,
  review: reviewHandler,
  evaluate: evaluateHandler,
  orchestrate: orchestrateHandler,
  resume: resumeHandler,
  report: reportHandler,
  approve: approveHandler,
  cancel: cancelHandler,
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
