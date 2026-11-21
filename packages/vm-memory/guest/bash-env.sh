# Same-person root cooperation only. Native bash sources this public BASH_ENV.
# No retry, sleep, second command runner, or guest-authoritative model admission.
allrice_memory_fail() {
  printf 'COMMAND_MEMORY_SETUP_FAILED: 命令内存保护未就绪，本次命令未执行，会话保留\n' >&2
  if [ -n "${allrice_memory_child:-}" ]; then
    rmdir "$allrice_memory_child" 2>/dev/null || true
  fi
  exit 75
}
[ -n "${ALLRICE_MEMORY_COMMANDS_GROUP:-}" ] || allrice_memory_fail
[ -n "${ALLRICE_MEMORY_DSH_GROUP:-}" ] || allrice_memory_fail
[ -n "${ALLRICE_MEMORY_PROC_ROOT:-}" ] || allrice_memory_fail
allrice_memory_child="$ALLRICE_MEMORY_COMMANDS_GROUP/command-$$"
mkdir "$allrice_memory_child" || allrice_memory_fail
printf '%s\n' "${ALLRICE_MEMORY_COMMAND_HIGH:?}" > "$allrice_memory_child/memory.high" || allrice_memory_fail
printf '%s\n' "${ALLRICE_MEMORY_COMMAND_MAX:?}" > "$allrice_memory_child/memory.max" || allrice_memory_fail
printf '%s\n' "${ALLRICE_MEMORY_COMMAND_SWAP_MAX:?}" > "$allrice_memory_child/memory.swap.max" || allrice_memory_fail
printf '%s\n' 0 > "$allrice_memory_child/memory.oom.group" || allrice_memory_fail
allrice_memory_oom_before=$(awk '$1=="oom_kill" {print $2}' "$allrice_memory_child/memory.events.local") || allrice_memory_fail
allrice_memory_local_before=$(awk '$1=="oom" {print $2}' "$allrice_memory_child/memory.events.local") || allrice_memory_fail
[ -n "$allrice_memory_oom_before" ] && [ -n "$allrice_memory_local_before" ] || allrice_memory_fail
allrice_memory_exit() {
  allrice_memory_status=$?
  trap - EXIT
  allrice_memory_oom_after=$(awk '$1=="oom_kill" {print $2}' "$allrice_memory_child/memory.events.local" 2>/dev/null)
  allrice_memory_local_after=$(awk '$1=="oom" {print $2}' "$allrice_memory_child/memory.events.local" 2>/dev/null)
  if [ "${allrice_memory_oom_after:-0}" -gt "$allrice_memory_oom_before" ]; then
    if [ "${allrice_memory_local_after:-0}" -gt "$allrice_memory_local_before" ]; then
      printf 'COMMAND_MEMORY_LIMIT: 该命令内存/交换额度不足，请分批处理，会话保留\n' >&2
    else
      printf 'COMMAND_OOM_KILLED: 该命令被内存回收终止，原因需核实，会话保留\n' >&2
    fi
    allrice_memory_status=137
  fi
  # Leave the child before rmdir. Surviving descendants keep their memcg;
  # never kill/replay a command merely to make cleanup look successful.
  printf '%s\n' "$$" > "$ALLRICE_MEMORY_DSH_GROUP/cgroup.procs" 2>/dev/null || true
  rmdir "$allrice_memory_child" 2>/dev/null || true
  exit "$allrice_memory_status"
}
trap allrice_memory_exit EXIT
printf '%s\n' "$$" > "$allrice_memory_child/cgroup.procs" || allrice_memory_fail
printf '%s\n' "${ALLRICE_MEMORY_COMMAND_OOM_SCORE:?}" > "$ALLRICE_MEMORY_PROC_ROOT/$$/oom_score_adj" || allrice_memory_fail
