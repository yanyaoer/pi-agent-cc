# Example profiles

Each subdirectory is a ready-to-use **pi-agent-cc** configuration pair:

- `models.json` — registers the provider in `~/.pi/agent/models.json` so pi
  can actually talk to the gateway (sets `baseUrl`, API style, auth).
- `pi-agent.config.json` — tells pi-agent-cc which model each role
  (planner / developer / tester / reviewer / evaluator) should use.

## Install a profile

```bash
# 1. Register the gateway with pi (merge or symlink; don't overwrite an
#    existing models.json if you already have providers there).
mkdir -p ~/.pi/agent
cp examples/<profile>/models.json ~/.pi/agent/models.json

# 2. Point the workspace at the matching role config.
cp examples/<profile>/pi-agent.config.json ./pi-agent.config.json

# 3. Export the key the gateway needs.
export ZENMUX_API_KEY=sk-zm-...

# 4. Verify pi can see the models.
node_modules/.bin/pi --list-models | head
```

## Profiles

### `zenmux-responses/` — OpenAI Responses API via ZenMux

- **Gateway**: `https://zenmux.ai/api/v1`
- **Wire**: `openai-responses` (the same protocol Codex uses)
- **Models**: `openai/gpt-5.5-pro`
- **Role split**: all five roles on `gpt-5.5-pro`. The model is capable
  enough to cover every role; there is no cheaper sibling in this profile.
- **Env**: `ZENMUX_API_KEY`

### `zenmux-anthropic/` — Anthropic Messages via ZenMux

- **Gateway**: `https://zenmux.ai/api/anthropic`
- **Wire**: `anthropic-messages`
- **Models**:
  - `anthropic/claude-haiku-4.5` — cheap + fast, used for the read-only tester
  - `anthropic/claude-sonnet-4.6` — balanced, used for planner and developer
  - `anthropic/claude-opus-4.7` — strongest reasoning, used for the
    adversarial reviewer and the final evaluator
- **Env**: `ZENMUX_API_KEY`

## Role assignment rationale

- **planner** — mid-tier reasoning; breaks a request into tasks without
  needing long-context tracing. Sonnet-class is usually the sweet spot.
- **developer** — writes/edits code, runs local checks; benefits from a
  strong code model. Sonnet-class unless the repo is large, in which case
  Opus-class is worth the cost.
- **tester** — read-only, runs existing tests, extracts a verdict JSON.
  Haiku-class is usually enough; use a stronger model only if reports
  come back malformed.
- **reviewer** — adversarial, has to chase cross-references from
  `ast-grep` + `rg` and reason about failure modes. Give this role the
  best reasoning model you can afford.
- **evaluator** — aggregates across all tasks, reads multiple reports,
  decides ACCEPT/REWORK/REJECT. Also benefits from the strongest model.

## Overriding per-run

You can still override on a per-run basis without editing files:

```bash
PI_AGENT_REVIEWER_MODEL=zenmux-anthropic/anthropic/claude-opus-4.7 \
PI_AGENT_TESTER_MODEL=zenmux-anthropic/anthropic/claude-haiku-4.5 \
  /pi:start --parallel 2
```

Precedence: CLI `--model` > `PI_AGENT_<ROLE>_MODEL` env > `pi-agent.config.json` > built-in default.

## Adding your own profile

1. `mkdir examples/<your-profile>`
2. Copy one of the existing pairs as a starting point.
3. Edit `models.json` to point at your gateway (`baseUrl`, `api`, `apiKey`
   env var, optional `authHeader`, list of `models[]`).
4. Edit `pi-agent.config.json` to map each role to one of those model
   ids. The `model` string is what pi itself understands, usually
   `<provider>/<model-id>`.
5. Smoke test: `node_modules/.bin/pi --list-models | rg <provider>`
   should show your models; `node_modules/.bin/pi --model <id> "say hi"`
   should complete.
