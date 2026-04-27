// plan.mjs — handle `/pi:plan <text>` via the planner subagent.
//
// First invocation: start a new planner session.
// Subsequent invocations: --resume the same session so the planner keeps
// context across iterations.

import fs from 'node:fs';
import { loadPrompt } from '../prompts.mjs';
import { parseAndValidate, extractLastJsonBlock } from '../schema.mjs';
import {
  parseArgs,
  nowIso,
  getStateDir,
  stateLib,
  runnerLib,
  resolveRoleModel,
  sessionPath,
  loadPlan,
  savePlan,
  writeJsonLine,
} from './_shared.mjs';

export default async function handlePlan(argv) {
  const { opts, positional } = parseArgs(argv);
  const text = positional.join(' ').trim();
  if (!text) {
    throw new Error('usage: pi-agent-cc plan "<requirement or feedback text>"');
  }

  const stateDir = await getStateDir();
  const plannerSession = sessionPath(stateDir, 'planner');
  const exists = fs.existsSync(plannerSession);

  const runner = await runnerLib();
  const result = await runner.runPi({
    systemPromptPath: loadPrompt('planner'),
    tools: ['read', 'grep', 'find', 'ls'],
    sessionPath: plannerSession,
    resume: exists,
    prompt: text,
    cwd: process.cwd(),
    model: await resolveRoleModel('planner', opts.model),
  });

  // Prefer lastMessage.text when the runner captured it; otherwise scan the
  // event stream for the most recent assistant `message_end` and extract
  // text blocks directly. This protects us from corner cases where the pi
  // stream ends with a tool / user message or an assistant turn that
  // contained only thinking blocks before the text arrived.
  function extractAssistantTextFromEvents(events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.type === 'message_end' && ev?.message?.role === 'assistant') {
        const content = ev.message.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          const parts = content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text);
          if (parts.length) return parts.join('');
        }
      }
    }
    return '';
  }
  let rawText = '';
  if (typeof result?.lastMessage?.text === 'string' && result.lastMessage.text) {
    rawText = result.lastMessage.text;
  } else if (Array.isArray(result?.events)) {
    rawText = extractAssistantTextFromEvents(result.events);
  }
  rawText = rawText || '';

  // Two-mode planner: if the reply has no trailing JSON block, treat it as
  // a discussion turn (naming question, clarification, exploratory dialog).
  // We echo the reply back and keep the planner session open so the user can
  // keep iterating with /pi:plan <followup>.
  const jsonBlock = extractLastJsonBlock(rawText);
  if (!jsonBlock) {
    const quiet = process.env.PI_AGENT_QUIET === '1';
    if (!quiet) {
      writeJsonLine({
        event: 'plan.discussion',
        sessionPath: plannerSession,
        chars: rawText.length,
      });
    }
    // Echo the planner's reply as-is so the coordinator relays it verbatim.
    process.stdout.write(`\n${rawText.trim()}\n\n`);
    if (!quiet) {
      process.stdout.write(
        `_(planner replied in discussion mode — no plan JSON was emitted. ` +
        `Continue the conversation with \`pi-agent-cc "<reply>"\` (shell), ` +
        `\`pi-agent-cc chat\` (interactive REPL), or ` +
        `\`/pi:plan <reply>\` (in Claude Code); the planner session is preserved.)_\n`,
      );
    }
    return;
  }

  const parsed = parseAndValidate(rawText, 'plan');
  if (!parsed.ok) {
    writeJsonLine({
      event: 'plan.invalid',
      errors: parsed.errors,
      raw: rawText.slice(-2000),
    });
    throw new Error(`planner output failed plan.schema validation:\n  ${parsed.errors.join('\n  ')}`);
  }

  const prev = await loadPlan(stateDir);
  const nextVersion = (prev?.version || 0) + 1;
  const plan = { ...parsed.data, version: nextVersion, savedAt: nowIso() };
  await savePlan(stateDir, plan);

  // Update state
  const { loadState, saveState } = await stateLib();
  const st = (await loadState()) || {};
  st.planStatus = 'draft';
  st.planVersion = nextVersion;
  await saveState(st);

  writeJsonLine({
    event: 'plan.saved',
    planStatus: 'draft',
    version: nextVersion,
    taskCount: plan.tasks.length,
    sessionPath: plannerSession,
  });

  // Human-readable echo for the coordinator to pass through
  console.log(`\n## Plan v${nextVersion} (draft)`);
  if (plan.summary) console.log(`\n${plan.summary}\n`);
  for (const t of plan.tasks) {
    const deps = (t.deps || []).length ? ` (deps: ${t.deps.join(', ')})` : '';
    console.log(`- ${t.id} · ${t.title}${deps}`);
  }
  console.log(`\nRun /pi:plan-confirm to freeze this plan, or /pi:plan <feedback> to iterate.`);
}
