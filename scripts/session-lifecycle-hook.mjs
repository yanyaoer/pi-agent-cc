#!/usr/bin/env node
// pi-agent-cc session lifecycle hook.
// On SessionStart, delegates to `pi-companion.mjs status --banner`, which
// prints a compact single-line banner only when there are running or pending
// tasks; otherwise it is silent. The hook must always exit 0 so it never
// blocks Claude Code startup — even if the companion has not been initialized
// yet (e.g. before the user ever ran `/pi:plan`).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const companionPath = path.join(__dirname, 'pi-companion.mjs');

const event = process.argv[2] ?? 'SessionStart';

function silentExit() {
  process.exit(0);
}

if (event !== 'SessionStart') {
  // Only SessionStart is wired; ignore anything else silently.
  silentExit();
}

// If companion is missing (e.g. during P3-only install), bail out quietly.
if (!existsSync(companionPath)) {
  silentExit();
}

const child = spawn(
  process.execPath,
  [companionPath, 'status', '--banner'],
  {
    stdio: ['ignore', 'inherit', 'ignore'],
    env: process.env,
  },
);

child.on('error', silentExit);
child.on('exit', silentExit);
