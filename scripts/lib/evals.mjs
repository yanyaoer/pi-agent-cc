// evals.mjs — run user-authored eval scripts in isolated child processes.
//
// Context-common.md contract:
//   runEvals(evalFiles, ctx) -> { results, totalPassed, totalFailed }
//
// Eval script template (authored by the user, one file per eval):
//
//   // evals/login-smoke.mjs
//   process.on('message', async ({ type, ctx }) => {
//     if (type !== 'run') return;
//     try {
//       // do work, access ctx.workspace, ctx.tasks, etc.
//       process.send({ type: 'result', result: {
//         name: 'login smoke',
//         passed: true,
//         metrics: { latencyMs: 42 },
//         output: 'ok',
//       }});
//     } catch (err) {
//       process.send({ type: 'result', result: {
//         name: 'login smoke',
//         passed: false,
//         error: err.message,
//       }});
//     } finally {
//       process.exit(0);
//     }
//   });
//
// Each eval runs in a separate `child_process.fork` with IPC, so it cannot
// crash the companion. A hard timeout kills any runaway eval.

import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Run a list of eval script files and aggregate results.
 *
 * @param {string[]} evalFiles - absolute or workspace-relative paths
 * @param {object} ctx - passed to each eval script via IPC
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=60000] - per-eval hard timeout
 * @param {string} [opts.cwd] - base dir for resolving relative eval paths
 * @returns {Promise<{ results: object[], totalPassed: number, totalFailed: number }>}
 */
export async function runEvals(evalFiles, ctx, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const cwd = opts.cwd ?? process.cwd();
  const results = [];

  for (const file of evalFiles || []) {
    const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    if (!fs.existsSync(abs)) {
      results.push({ file, passed: false, error: `eval file not found: ${abs}` });
      continue;
    }
    try {
      const res = await _runOne(abs, ctx, timeoutMs);
      results.push({ file, ...res });
    } catch (err) {
      results.push({ file, passed: false, error: err.message });
    }
  }

  return {
    results,
    totalPassed: results.filter((r) => r.passed).length,
    totalFailed: results.filter((r) => !r.passed).length,
  };
}

function _runOne(absFile, ctx, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = fork(absFile, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout?.on('data', (d) => stdoutChunks.push(d));
    child.stderr?.on('data', (d) => stderrChunks.push(d));

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(resolve, { passed: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.on('message', (msg) => {
      if (msg && msg.type === 'result') {
        const result = msg.result || {};
        finish(resolve, {
          passed: !!result.passed,
          metrics: result.metrics,
          name: result.name,
          output: result.output,
          error: result.error,
        });
      }
    });

    child.on('error', (err) => finish(reject, err));

    child.on('exit', (code, signal) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(-4000);
      finish(resolve, {
        passed: false,
        error: `eval exited without result (code=${code}, signal=${signal}). stderr tail: ${stderr}`,
      });
    });

    try {
      child.send({ type: 'run', ctx });
    } catch (err) {
      finish(reject, err);
    }
  });
}
