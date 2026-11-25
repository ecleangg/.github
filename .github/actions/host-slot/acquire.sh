#!/usr/bin/env bash
# Queues for a slot of host-slot's class. Needs flock (util-linux).
set -euo pipefail

out() { echo "$1" >> "$GITHUB_OUTPUT"; }
none() { echo "$1"; out acquired=false; out slot=; exit 0; }

slots="${SLOT_COUNT:-3}"
[[ "$slots" =~ ^[0-9]+$ ]] || { echo "::warning::Slot count '$slots' is not a number; using 3"; slots=3; }
[ "$slots" -gt 0 ] || none "Slots are off (0): no limit."
base="${SLOT_DIR:-${CI_LOCAL_CACHE:+$CI_LOCAL_CACHE/slots}}"
[ -n "$base" ] || none "No CI_LOCAL_CACHE: not a runner with a shared disk, so no limit."
command -v flock > /dev/null || none "::warning::flock is missing; running without a slot."

class="${SLOT_CLASS:-heavy}"
dir="$base/$class"
state="${RUNNER_TEMP:-/tmp}/host-slot/$class"
mkdir -p "$dir" "$state"
rm -f "$state/ready" "$state/ready.tmp" "$state/release"

nohup setsid bash "$GITHUB_ACTION_PATH/hold.sh" "$dir" "$slots" "$state" "${SLOT_WAIT:-90}" "${SLOT_HOLD:-240}" \
  > "$state/holder.log" 2>&1 < /dev/null &
pid=$!

echo "Waiting for one of $slots '$class' slots on $(hostname)."
start=$SECONDS
last=0
until [ -s "$state/ready" ]; do
  if ! kill -0 "$pid" 2> /dev/null && [ ! -s "$state/ready" ]; then
    echo "::warning::The slot holder died: running without a slot."
    cat "$state/holder.log" || true
    none "No slot."
  fi
  if [ $((SECONDS - last)) -ge 60 ] && [ "$SECONDS" -gt "$start" ]; then
    echo "Still waiting after $(((SECONDS - start) / 60)) min."
    last=$SECONDS
  fi
  sleep 1
done

got="$(cat "$state/ready")"
if [ "$got" = timeout ]; then
  if [ "${SLOT_ON_TIMEOUT:-proceed}" = fail ]; then
    echo "::error::No '$class' slot after ${SLOT_WAIT:-90} min."
    exit 1
  fi
  echo "::warning::No '$class' slot after ${SLOT_WAIT:-90} min: running without one."
  out acquired=false
  out slot=
  exit 0
fi
echo "Got slot $got of $slots after $((SECONDS - start)) s."
echo "Slot $got of $slots (waited $((SECONDS - start)) s)." >> "$GITHUB_STEP_SUMMARY"
out acquired=true
out slot="$got"
