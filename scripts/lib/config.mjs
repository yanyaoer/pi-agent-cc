// Role-aware configuration loader for pi-agent-cc.
//
// Resolution order (highest-precedence last):
//   1. Built-in defaults (DEFAULT_CONFIG)
//   2. <workspaceRoot>/pi-agent.config.json
//   3. Environment overrides:
//        PI_AGENT_DEFAULT_MODEL=<model>
//        PI_AGENT_<ROLE>_MODEL=<model>         (ROLE = PLANNER|DEVELOPER|TESTER|EVALUATOR)
//        PI_AGENT_<ROLE>_TOOLS=<csv|"all">
//        PI_AGENT_<ROLE>_APPEND_SYSTEM_PROMPT=<absolute file path>
//
// Config file schema:
//   {
//     "defaultModel": "claude-sonnet-4-6",
//     "roles": {
//       "planner":   { "model": "...", "tools": "read,grep,find,ls", "appendSystemPrompt": "/abs/path.md" },
//       "developer": { "model": "..." },
//       "tester":    { "model": "..." },
//       "evaluator": { "model": "..." }
//     }
//   }
//
// Unknown keys are passed through so future runPi options (e.g. thinking level)
// can be wired without changing this file.

import fs from "node:fs";
import path from "node:path";

export const ROLES = ["planner", "developer", "tester", "reviewer", "evaluator"];

const DEFAULT_CONFIG = {
  defaultModel: undefined,
  roles: {
    planner:   {},
    developer: {},
    tester:    {},
    reviewer:  {},   // adversarial review; inherits defaultModel
    evaluator: { model: "claude-opus-4-7" },
  },
  orchestration: {
    review: { enabled: true, maxContextFiles: 25 },
  },
};

const CONFIG_FILENAME = "pi-agent.config.json";

let cached = null;
let cachedWorkspace = null;

/**
 * Load (or return cached) merged config for a given workspace root.
 * @param {string} workspaceRoot absolute path; config file is resolved relative to it
 * @returns {{defaultModel?: string, roles: Record<string, Record<string, any>>, source: {file?: string}}}
 */
export function loadConfig(workspaceRoot) {
  if (cached && cachedWorkspace === workspaceRoot) return cached;

  const merged = {
    defaultModel: DEFAULT_CONFIG.defaultModel,
    roles: {},
    orchestration: {
      review: { ...DEFAULT_CONFIG.orchestration.review },
    },
    source: {},
  };
  for (const role of ROLES) {
    merged.roles[role] = { ...(DEFAULT_CONFIG.roles[role] || {}) };
  }

  // Layer 2: config file
  const configFile = path.join(workspaceRoot, CONFIG_FILENAME);
  if (fs.existsSync(configFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (raw && typeof raw === "object") {
        if (typeof raw.defaultModel === "string") merged.defaultModel = raw.defaultModel;
        if (raw.roles && typeof raw.roles === "object") {
          for (const role of ROLES) {
            if (raw.roles[role] && typeof raw.roles[role] === "object") {
              merged.roles[role] = { ...merged.roles[role], ...raw.roles[role] };
            }
          }
        }
        if (raw.orchestration && typeof raw.orchestration === "object") {
          if (raw.orchestration.review && typeof raw.orchestration.review === "object") {
            merged.orchestration.review = {
              ...merged.orchestration.review,
              ...raw.orchestration.review,
            };
          }
        }
        merged.source.file = configFile;
      }
    } catch (err) {
      process.stderr.write(`[pi-agent] warning: failed to parse ${configFile}: ${err.message}\n`);
    }
  }

  // Layer 3: env overrides
  if (process.env.PI_AGENT_DEFAULT_MODEL) {
    merged.defaultModel = process.env.PI_AGENT_DEFAULT_MODEL;
  }
  for (const role of ROLES) {
    const upper = role.toUpperCase();
    const m = process.env[`PI_AGENT_${upper}_MODEL`];
    const t = process.env[`PI_AGENT_${upper}_TOOLS`];
    const s = process.env[`PI_AGENT_${upper}_APPEND_SYSTEM_PROMPT`];
    if (m) merged.roles[role].model = m;
    if (t) merged.roles[role].tools = t;
    if (s) merged.roles[role].appendSystemPrompt = s;
  }
  if (process.env.PI_AGENT_REVIEW_ENABLED !== undefined) {
    const v = process.env.PI_AGENT_REVIEW_ENABLED.toLowerCase();
    merged.orchestration.review.enabled = v === "1" || v === "true" || v === "yes";
  }

  cached = merged;
  cachedWorkspace = workspaceRoot;
  return merged;
}

/**
 * Resolve the effective model for a role:
 *   role override → defaultModel → undefined (let pi pick its own default)
 * Explicit `override` (e.g. CLI flag) wins over everything.
 */
export function getRoleModel(workspaceRoot, role, override) {
  if (override) return override;
  if (!ROLES.includes(role)) {
    throw new Error(`getRoleModel: unknown role '${role}'`);
  }
  const cfg = loadConfig(workspaceRoot);
  return cfg.roles[role].model || cfg.defaultModel || undefined;
}

/**
 * Full resolved role config (model + any extras like tools / appendSystemPrompt).
 * Useful when a handler wants to apply more than just `model`.
 */
export function getRoleConfig(workspaceRoot, role) {
  if (!ROLES.includes(role)) {
    throw new Error(`getRoleConfig: unknown role '${role}'`);
  }
  const cfg = loadConfig(workspaceRoot);
  return {
    ...cfg.roles[role],
    model: cfg.roles[role].model || cfg.defaultModel || undefined,
  };
}

/**
 * Resolve orchestration-level toggles (currently just the review stage).
 */
export function getOrchestrationConfig(workspaceRoot) {
  const cfg = loadConfig(workspaceRoot);
  return {
    review: { ...cfg.orchestration.review },
  };
}

/** Clear the module-level cache. Exposed primarily for tests. */
export function _resetConfigCache() {
  cached = null;
  cachedWorkspace = null;
}
