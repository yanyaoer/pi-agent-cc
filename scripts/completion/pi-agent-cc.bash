# bash completion for pi-agent-cc.
#
# Install (requires bash-completion):
#   pi-agent-cc completion bash > /usr/local/etc/bash_completion.d/pi-agent-cc
# Or eval inline (per-shell, not persisted):
#   source <(pi-agent-cc completion bash)

_pi_agent_cc_task_ids() {
    command pi-agent-cc status --json 2>/dev/null \
        | command jq -r '.tasks[]?.id' 2>/dev/null
}

_pi_agent_cc_complete() {
    local cur prev words cword
    if declare -F _init_completion >/dev/null 2>&1; then
        _init_completion -n = 2>/dev/null || return
    else
        cur="${COMP_WORDS[COMP_CWORD]}"
        prev="${COMP_WORDS[COMP_CWORD-1]}"
        words=("${COMP_WORDS[@]}")
        cword=$COMP_CWORD
    fi

    local subs="init status plan plan-confirm chat develop test review evaluate orchestrate resume report approve cancel completion"

    # Top-level subcommand position
    if [[ $cword -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "$subs" -- "$cur") )
        return
    fi

    local sub="${words[1]}"

    # --task value → task ids
    if [[ "$prev" == "--task" ]]; then
        COMPREPLY=( $(compgen -W "$(_pi_agent_cc_task_ids)" -- "$cur") )
        return
    fi
    # resume --role value
    if [[ "$prev" == "--role" ]]; then
        COMPREPLY=( $(compgen -W "developer tester" -- "$cur") )
        return
    fi
    # completion <shell>
    if [[ "$sub" == "completion" && $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "fish bash zsh" -- "$cur") )
        return
    fi

    # Flags per subcommand
    local flags=""
    case "$sub" in
        status)       flags="--json --banner" ;;
        report)       flags="--json" ;;
        develop|test|review)
                      flags="--task --resume --model" ;;
        orchestrate)  flags="--parallel --auto-approve --review --no-review" ;;
        resume)       flags="--role" ;;
        plan|evaluate) flags="--model" ;;
        chat)         flags="--fresh" ;;
    esac

    # When typing a --flag, complete flags; otherwise (positional) offer
    # task ids where sensible.
    if [[ "$cur" == --* && -n "$flags" ]]; then
        COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
        return
    fi

    case "$sub" in
        status|approve|cancel|resume)
            COMPREPLY=( $(compgen -W "$(_pi_agent_cc_task_ids)" -- "$cur") )
            ;;
        *)
            [[ -n "$flags" ]] && COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
            ;;
    esac
}

complete -F _pi_agent_cc_complete pi-agent-cc
complete -F _pi_agent_cc_complete pi-companion
