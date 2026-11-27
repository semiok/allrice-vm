#!/bin/sh
# Guest runtime owner invokes this with its original DSH executable and argv.
set -eu
: "${ALLRICE_MEMORY_DSH_GROUP:?memory_setup_required}"
: "${ALLRICE_MEMORY_DSH_OOM_SCORE:?memory_setup_required}"
: "${ALLRICE_MEMORY_PROC_ROOT:?memory_setup_required}"
printf '%s\n' "$$" > "$ALLRICE_MEMORY_DSH_GROUP/cgroup.procs"
printf '%s\n' "$ALLRICE_MEMORY_DSH_OOM_SCORE" > "$ALLRICE_MEMORY_PROC_ROOT/$$/oom_score_adj"
if [ -n "${ALLRICE_PUBLIC_PROXY_CONFIG:-}" ]; then
  # Read data from the private epoch file after launch. Never source code or
  # put the proxy capability into the Host's msb exec arguments.
  {
    IFS= read -r proxy_url
    IFS= read -r proxy_bypass
  } < "$ALLRICE_PUBLIC_PROXY_CONFIG"
  export http_proxy="$proxy_url" HTTP_PROXY="$proxy_url"
  export https_proxy="$proxy_url" HTTPS_PROXY="$proxy_url"
  export no_proxy="localhost,127.0.0.1,[::1],$proxy_bypass"
  export NO_PROXY="$no_proxy"
fi
exec "$@"
