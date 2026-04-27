// prompts.mjs — resolve role prompt markdown files to absolute paths
//
// `pi --append-system-prompt <path>` accepts absolute paths; we return those.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');

const KNOWN = new Set(['planner', 'developer', 'tester', 'evaluator']);

/**
 * Return the absolute path to a role prompt markdown file.
 *
 * @param {string} name one of "planner" | "developer" | "tester" | "evaluator"
 * @returns {string} absolute path to prompts/<name>.md
 */
export function loadPrompt(name) {
  if (!KNOWN.has(name)) {
    throw new Error(`Unknown prompt name: ${name}. Expected one of: ${[...KNOWN].join(', ')}`);
  }
  const abs = path.join(PROMPTS_DIR, `${name}.md`);
  if (!fs.existsSync(abs)) {
    throw new Error(`Prompt file missing: ${abs}`);
  }
  return abs;
}

export function getPromptsDir() {
  return PROMPTS_DIR;
}
