# fish completion for pi-agent-cc.
#
# Install:
#   pi-agent-cc completion fish > ~/.config/fish/completions/pi-agent-cc.fish
# Or eval inline:
#   pi-agent-cc completion fish | source

# ---------------------------------------------------------------------------
# Dynamic task id lookup — uses the companion's own `status --json` so we
# always reflect the live plan. Falls back silently when no plan is loaded.
# ---------------------------------------------------------------------------
function __pi_agent_cc_task_ids
    command pi-agent-cc status --json 2>/dev/null \
        | command jq -r '.tasks[]? | "\(.id)\t\(.status // "?"): \(.title // "")"' 2>/dev/null
end

# ---------------------------------------------------------------------------
# Top-level subcommand set
# ---------------------------------------------------------------------------
set -l subs init status plan plan-confirm develop test review evaluate orchestrate resume report approve cancel completion

complete -c pi-agent-cc -f

# Subcommands (only when none chosen yet)
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "init"         -d "Create the per-workspace state directory"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "status"       -d "Show plan and task status"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "plan"         -d "Iterate/draft a plan with the planner"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "plan-confirm" -d "Freeze the current draft plan"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "develop"      -d "Dispatch the developer on a task"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "test"         -d "Run the tester on a task"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "review"       -d "Run the adversarial reviewer on a task"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "evaluate"     -d "Run the final evaluator (Layer-1 + Layer-2)"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "orchestrate"  -d "Run the full dev→test→review→eval loop"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "resume"       -d "Resume a developer or tester session"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "report"       -d "Print aggregated report"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "approve"      -d "Force-approve a task"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "cancel"       -d "Cancel running task(s)"
complete -c pi-agent-cc -n "__fish_use_subcommand" -a "completion"   -d "Emit shell completion script"

# Common --json / --banner flags ---------------------------------------------
complete -c pi-agent-cc -n "__fish_seen_subcommand_from status"  -l json    -d "Machine-readable JSON"
complete -c pi-agent-cc -n "__fish_seen_subcommand_from status"  -l banner  -d "One-line banner (silent when idle)"
complete -c pi-agent-cc -n "__fish_seen_subcommand_from report"  -l json    -d "Machine-readable JSON"

# develop / test / review ----------------------------------------------------
for sub in develop test review
    complete -c pi-agent-cc -n "__fish_seen_subcommand_from $sub" -l task   -d "Task ID" -xa "(__pi_agent_cc_task_ids)"
    complete -c pi-agent-cc -n "__fish_seen_subcommand_from $sub" -l resume -d "Resume the existing session"
    complete -c pi-agent-cc -n "__fish_seen_subcommand_from $sub" -l model  -d "Override the role's model (one-shot)"
end

# orchestrate ----------------------------------------------------------------
complete -c pi-agent-cc -n "__fish_seen_subcommand_from orchestrate" -l parallel     -d "Max concurrent tasks (default 4)" -x
complete -c pi-agent-cc -n "__fish_seen_subcommand_from orchestrate" -l auto-approve -d "Auto-approve blocked tasks"
complete -c pi-agent-cc -n "__fish_seen_subcommand_from orchestrate" -l review       -d "Force the review stage on"
complete -c pi-agent-cc -n "__fish_seen_subcommand_from orchestrate" -l no-review    -d "Skip the adversarial reviewer"

# resume ---------------------------------------------------------------------
complete -c pi-agent-cc -n "__fish_seen_subcommand_from resume" -l role -d "developer or tester" -xa "developer tester"
complete -c pi-agent-cc -n "__fish_seen_subcommand_from resume" -xa "(__pi_agent_cc_task_ids)"

# status / approve / cancel: taskId positional
complete -c pi-agent-cc -n "__fish_seen_subcommand_from status approve cancel"       -xa "(__pi_agent_cc_task_ids)"

# evaluate -------------------------------------------------------------------
complete -c pi-agent-cc -n "__fish_seen_subcommand_from evaluate" -l model -d "Override evaluator model"

# plan -----------------------------------------------------------------------
complete -c pi-agent-cc -n "__fish_seen_subcommand_from plan" -l model -d "Override planner model"

# completion -----------------------------------------------------------------
complete -c pi-agent-cc -n "__fish_seen_subcommand_from completion" -xa "fish bash zsh"
