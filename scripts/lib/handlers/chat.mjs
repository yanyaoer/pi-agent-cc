// chat.mjs — interactive REPL wrapping the planner session.
//
// Usage:
//   pi-agent-cc chat                     → enter REPL, reuse existing planner session
//   pi-agent-cc chat --fresh             → wipe the planner session first
//
// Each line you type is sent to the planner as one /pi:plan turn. The same
// session file is --session'd across turns, so the planner remembers every
// exchange in this shell. Meta commands start with `/`:
//
//   /confirm   freeze the current draft plan (runs plan-confirm)
//   /status    run `pi-agent-cc status` in this process
//   /help      list meta commands
//   /quit, /q  exit (Ctrl-D also works)
//
// This is a thin shim over the existing plan / plan-confirm handlers.

import fs from 'node:fs';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import planHandler from './plan.mjs';
import planConfirmHandler from './plan-confirm.mjs';
import {
  parseArgs,
  getStateDir,
  sessionPath,
} from './_shared.mjs';

const META_HELP = [
  '  /confirm   freeze the current draft plan',
  '  /status    show plan / task status (markdown)',
  '  /help      show this list',
  '  /quit      exit (Ctrl-D also works)',
].join('\n');

function banner() {
  return [
    '',
    'pi-agent-cc interactive session.',
    'Everything you type goes to the planner. The session is persistent —',
    'use `/confirm` to freeze a plan, `/quit` to exit.',
    '',
    META_HELP,
    '',
  ].join('\n');
}

export default async function handleChat(argv) {
  const { opts } = parseArgs(argv);

  // `--fresh` wipes the planner's pi session so the next turn starts with a
  // blank slate. The plan / tasks on disk are untouched.
  if (opts.fresh) {
    const stateDir = await getStateDir();
    const p = sessionPath(stateDir, 'planner');
    try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
  }

  // Silence the machine-readable `{"event":"plan.discussion",…}` line in
  // interactive mode — the human just wants the reply.
  process.env.PI_AGENT_QUIET = '1';

  if (process.stdin.isTTY) process.stdout.write(banner());

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
    prompt: 'pi> ',
  });

  // Ctrl-C once cancels the current in-flight turn (the runner's signal
  // handler takes care of SIGTERM to pi); a second Ctrl-C exits.
  let currentAbort = null;
  let ctrlcArmed = false;
  rl.on('SIGINT', () => {
    if (currentAbort) {
      currentAbort.abort();
      return;
    }
    if (ctrlcArmed) {
      process.stdout.write('\n');
      rl.close();
      return;
    }
    ctrlcArmed = true;
    process.stdout.write('\n(press Ctrl-C again or type /quit to exit)\n');
    rl.prompt();
    setTimeout(() => { ctrlcArmed = false; }, 1500);
  });

  rl.prompt();

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) { rl.prompt(); continue; }

    // Meta commands
    if (line === '/quit' || line === '/q' || line === '/exit') break;
    if (line === '/help' || line === '?' || line === '/?') {
      process.stdout.write(`${META_HELP}\n`);
      rl.prompt();
      continue;
    }
    if (line === '/confirm') {
      try {
        await planConfirmHandler([]);
      } catch (err) {
        process.stderr.write(`confirm failed: ${err.message}\n`);
      }
      rl.prompt();
      continue;
    }
    if (line === '/status') {
      // Call the same companion binary — keeps the rendering path identical
      // to `pi-agent-cc status` from outside and avoids duplicating that
      // handler's import surface here.
      const r = spawnSync(process.execPath, [process.argv[1], 'status'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      void r;
      rl.prompt();
      continue;
    }
    if (line.startsWith('/')) {
      process.stderr.write(`unknown meta command: ${line}\n${META_HELP}\n`);
      rl.prompt();
      continue;
    }

    // Plain user turn → forward to planner.
    try {
      await planHandler([line]);
    } catch (err) {
      process.stderr.write(`planner turn failed: ${err.message}\n`);
    }
    rl.prompt();
  }

  rl.close();
  if (process.stdin.isTTY) process.stdout.write('bye\n');
}
