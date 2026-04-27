// resume.mjs — human-triggered resume for a specific task + role.

import handleDevelop from './develop.mjs';
import handleTest from './test.mjs';
import { parseArgs, writeJsonLine } from './_shared.mjs';

export default async function handleResume(argv) {
  const { opts, positional } = parseArgs(argv);
  const taskId = opts.task || opts.taskId || positional[0];
  const role = opts.role || 'developer';
  if (!taskId) throw new Error('usage: pi-agent-cc resume <taskId> [--role developer|tester]');
  if (!['developer', 'tester'].includes(role)) {
    throw new Error(`unsupported role for resume: ${role} (expected developer|tester)`);
  }

  writeJsonLine({ event: 'resume.start', taskId, role });
  if (role === 'developer') {
    await handleDevelop(['--task', taskId, '--resume']);
  } else {
    await handleTest(['--task', taskId, '--resume']);
  }
}
