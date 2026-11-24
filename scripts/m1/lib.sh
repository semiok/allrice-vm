# Shared helpers for the M1 tools (sourced, not run). Absolute paths throughout: launchd
# jobs and agents run these tools with minimal PATHs (/usr/sbin is often missing).
M1_LAUNCHCTL=/bin/launchctl
M1_PY=/usr/bin/python3
M1_UID=$(/usr/bin/id -u)
M1_TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
M1_DEV_DISABLED="$HOME/allrice40-dev/qa/deploy-disabled"
M1_DEV_BACKUP_DIRS="storage executions dsh-runtime-m1 native-once-control-m1 native-recurring-control-m1 dsh-platform"
M1_QA="$HOME/allrice-qa"
# The 3.x glob counts these directories, but its task-name grammar rejects them.
M1_QA_PREFIX=_allrice40-

qa_instance_dir() { printf '%s/%s%s\n' "$M1_QA" "$M1_QA_PREFIX" "$1"; }
qa_lock_file() { printf '%s/.task40-%s.lock\n' "$M1_QA" "$1"; }
qa_label() { printf 'ai.bplabs.allrice40-qa-%s-%s\n' "$1" "$2"; }

# Require the 4.0 namespace and repository identity for instance operations.
qa_owned() {
  "$M1_PY" "$M1_TOOLS/service_target.py" qa-owned "$1"
}
qa_database() {
  "$M1_PY" "$M1_TOOLS/service_target.py" qa-database "$1"
}

# A refused recovery parks the plists outside LaunchAgents so login cannot start
# incompatible code. Keep their environment available for recovery and forward fixes.
dev_plist() { # web|worker -> active plist, or the parked configuration
  local p="$HOME/Library/LaunchAgents/ai.bplabs.allrice40-dev-$1.plist"
  [ -f "$p" ] || p="$M1_DEV_DISABLED/$1.plist"
  printf '%s\n' "$p"
}

# Check the exact launchd target and parse the connection URL before a caller
# starts a service, stops one, or uses the database. Query parameters can
# override libpq's host, port or database and are excluded from these URLs.
service_plist_config() { # path label port-key port database [exports]
  "$M1_PY" "$M1_TOOLS/service_target.py" "$@"
}

dev_plist_config() { # web|worker [plist path] [exports]
  local role=$1 key port
  case "$role" in
    web) key=ALLRICE_WEB_PORT; port=3311 ;;
    worker) key=ALLRICE_WORKER_PORT; port=3312 ;;
    *) return 2 ;;
  esac
  service_plist_config "${2:-$(dev_plist "$role")}" "ai.bplabs.allrice40-dev-$role" "$key" "$port" allrice40_dev ${3:+"$3"}
}

dev_plist_pair() { dev_plist_config web && dev_plist_config worker; }

dev_release_config() { "$M1_PY" "$M1_TOOLS/service_target.py" release "$@"; }

# flock_fd <fd> [seconds]: take an exclusive kernel lock on the file open at <fd>, waiting
# up to [seconds] (default 0). Exit 0 = held, 1 = still busy. The lock belongs to the open
# file, so every child that inherits <fd> keeps it: it is released only when the last of
# them exits, never while a killed parent's child is still working.
flock_fd() {
  "$M1_PY" -c 'import fcntl,sys,time
fd,end=int(sys.argv[1]),time.time()+float(sys.argv[2])
while True:
    try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); sys.exit(0)
    except BlockingIOError:
        if time.time()>=end: sys.exit(1)
        time.sleep(0.5)' "$1" "${2:-0}"
}

# Every QA task-lock consumer must open/try/unlink under the allocator lock.
# Never wait on a task lock while holding the allocator (the owner needs it to
# release). Fixed fd 8 belongs to this operation; fd 7 is only held briefly.
qa_task_lock() {
  exec 7>>"$M1_QA/.alloc.lock"
  flock_fd 7 30 || { exec 7>&-; return 1; }
  exec 8>>"$1"
  if ! flock_fd 8 0; then exec 8>&- 7>&-; return 1; fi
  exec 7>&-
}

qa_task_unlock() {
  exec 7>>"$M1_QA/.alloc.lock"
  if flock_fd 7 30; then rm -f -- "$1"; fi
  exec 8>&- 7>&-
}

# lock_held <file>: exit 0 when someone holds the lock on <file>, 1 when it is free.
lock_held() {
  "$M1_PY" -c 'import fcntl,sys
f=open(sys.argv[1],"a")
try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: sys.exit(0)
sys.exit(1)' "$1"
}

# job_state <label> [plist cwd]: prints "running <pid>", "loaded" or "gone".
# With a plist and cwd, require the loaded job to match both before accepting it.
job_state() {
  local out rc=0
  out=$("$M1_LAUNCHCTL" print "gui/$M1_UID/$1" 2>&1) || rc=$?
  if [ "$rc" = 113 ]; then echo gone; return 0; fi # "Could not find service"
  [ "$rc" = 0 ] || { echo "launchctl print $1 failed (exit $rc)" >&2; return 2; }
  if [ "$#" -eq 3 ] && ! "$M1_PY" -c 'import sys
lines = [line.strip() for line in sys.stdin]
for field, expected in zip(("path", "working directory"), sys.argv[1:]):
    key = field + " = "
    if [line[len(key):] for line in lines if line.startswith(key)] != [expected]:
        sys.exit(1)' "$2" "$3" <<<"$out"; then
    echo "loaded LaunchAgent $1 does not match its published plist and worktree" >&2
    return 2
  fi
  local pid; pid=$(printf '%s\n' "$out" | /usr/bin/awk '$1=="pid" && $2=="=" {print $3; exit}')
  if [ -n "$pid" ]; then echo "running $pid"; else echo loaded; fi
}

# port_open <port>: exit 0 for a listening port, 1 for a refused connection and 2 for an unknown result.
port_open() {
  "$M1_PY" -c 'import socket,sys
try:
    port=int(sys.argv[1])
    if not 1<=port<=65535: sys.exit(2)
    socket.create_connection(("127.0.0.1",port),0.5).close()
except ConnectionRefusedError: sys.exit(1)
except (ValueError,OSError): sys.exit(2)' "$1"
}

port_closed() { local rc=0; port_open "$1" || rc=$?; [ "$rc" -eq 1 ]; }

# stop_job <label> [port [plist cwd]]: boot the job out and wait (max 90s) until launchd no longer
# knows it, its last process has exited and the port is closed. launchd kills the job's
# whole process group when the job ends (AbandonProcessGroup is not set), so children go
# with it. Exit 1 on timeout or when the state cannot be read.
stop_job() {
  local label=$1 port=${2:-} state pid="" i
  shift; if [ "$#" -gt 0 ]; then shift; fi
  state=$(job_state "$label" "$@") || return 1
  case "$state" in running*) pid=${state#running } ;; esac
  if [ "$#" -eq 0 ] || [ "$state" != gone ]; then
    "$M1_LAUNCHCTL" bootout "gui/$M1_UID/$label" 2>/dev/null || true
  fi
  for i in $(seq 1 90); do
    state=$(job_state "$label" "$@") || return 1
    if [ "$state" = gone ] && { [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; } && { [ -z "$port" ] || port_closed "$port"; }; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not stop within 90s (state: $state${pid:+, pid $pid})" >&2
  return 1
}

# migration_diff <release>: compare the migration names on stdin (what a database has
# applied) with the names <release> knows: its migrations/*.sql plus the archived names
# its built dist/migration-compatibility.js exports (as its db:verify does). Only that file is
# imported; dist/migrate.js would run the migrations as soon as it loads. Prints
# "unknown <name>" for each applied name the release does not know (its db:verify refuses
# such a database) and "pending <name>" for each file not applied yet (its db:prepare
# runs it). Exit 1, printing the reason, when the release's names cannot be read.
migration_diff() {
  local db="$1/packages/database" files archived applied
  files=$(ls "$db/migrations" 2>/dev/null | grep '\.sql$' | LC_ALL=C sort) || { echo "no migrations in $db/migrations"; return 1; }
  archived=$(node --input-type=module -e 'import { pathToFileURL } from "node:url";
const names = (await import(pathToFileURL(process.argv[1]).href)).archivedMigrationNames;
if (!Array.isArray(names) || !names.every((n) => /^[\w.-]+\.sql$/.test(n))) throw Error("no archivedMigrationNames list");
for (const n of names) console.log(n);' "$db/dist/migration-compatibility.js" 2>/dev/null) \
    || { echo "cannot read archivedMigrationNames from $db/dist/migration-compatibility.js"; return 1; }
  applied=$(LC_ALL=C sort -u)
  LC_ALL=C comm -23 <(printf '%s\n' "$applied") <(printf '%s\n%s\n' "$files" "$archived" | LC_ALL=C sort -u) | sed '/^$/d; s/^/unknown /'
  LC_ALL=C comm -13 <(printf '%s\n' "$applied") <(printf '%s\n' "$files") | sed '/^$/d; s/^/pending /'
}

# start_job <label> <plist>: load and start the job (bootstrap can briefly fail while a
# previous instance is still being torn down).
start_job() {
  local i
  for i in 1 2 3 4 5; do
    if "$M1_LAUNCHCTL" bootstrap "gui/$M1_UID" "$2" 2>/dev/null; then "$M1_LAUNCHCTL" kickstart "gui/$M1_UID/$1"; return 0; fi
    sleep 3
  done
  echo "could not load $1" >&2
  return 1
}
