#compdef pi-agent-cc pi-companion
# zsh completion for pi-agent-cc.
#
# Install:
#   pi-agent-cc completion zsh > "${fpath[1]}/_pi-agent-cc"
#   autoload -U compinit && compinit
# Or eval inline (per-shell, not persisted):
#   source <(pi-agent-cc completion zsh)

_pi_agent_cc_task_ids() {
    local -a ids
    ids=(${(f)"$(command pi-agent-cc status --json 2>/dev/null | command jq -r '.tasks[]? | "\(.id):\(.status // "?") — \(.title // "")"' 2>/dev/null)"})
    _describe -t task-ids 'task id' ids
}

_pi_agent_cc() {
    local curcontext="$curcontext" state line
    typeset -A opt_args

    _arguments -C \
        '1: :->sub' \
        '*::arg:->args'

    case $state in
        sub)
            local -a subs
            subs=(
                'init:Create the per-workspace state directory'
                'status:Show plan and task status'
                'plan:Iterate or draft a plan'
                'plan-confirm:Freeze the current draft plan'
                'chat:Interactive REPL with the planner'
                'develop:Dispatch the developer on a task'
                'test:Run the tester on a task'
                'review:Run the adversarial reviewer on a task'
                'evaluate:Run the final evaluator'
                'orchestrate:Run the full dev→test→review→eval loop'
                'resume:Resume a developer or tester session'
                'report:Print aggregated report'
                'approve:Force-approve a task'
                'cancel:Cancel running tasks'
                'completion:Emit shell completion script'
            )
            _describe -t commands 'subcommand' subs
            ;;
        args)
            case $words[1] in
                status)
                    _arguments \
                        '--json[Machine-readable JSON]' \
                        '--banner[One-line banner]' \
                        '*:taskId:_pi_agent_cc_task_ids'
                    ;;
                report)
                    _arguments '--json[Machine-readable JSON]'
                    ;;
                develop|test|review)
                    _arguments \
                        '--task[Task id]:taskId:_pi_agent_cc_task_ids' \
                        '--resume[Resume existing session]' \
                        '--model[Override role model]:model:'
                    ;;
                orchestrate)
                    _arguments \
                        '--parallel[Max concurrent tasks]:N:' \
                        '--auto-approve[Auto-approve blocked tasks]' \
                        '--review[Force review stage on]' \
                        '--no-review[Skip the adversarial reviewer]'
                    ;;
                resume)
                    _arguments \
                        '--role[developer or tester]:role:(developer tester)' \
                        '*:taskId:_pi_agent_cc_task_ids'
                    ;;
                approve|cancel)
                    _arguments '*:taskId:_pi_agent_cc_task_ids'
                    ;;
                plan|evaluate)
                    _arguments '--model[Override role model]:model:'
                    ;;
                chat)
                    _arguments '--fresh[Wipe the planner session first]'
                    ;;
                completion)
                    _arguments '1:shell:(fish bash zsh)'
                    ;;
            esac
            ;;
    esac
}

compdef _pi_agent_cc pi-agent-cc pi-companion
