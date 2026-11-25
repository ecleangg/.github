#!/usr/bin/env bash
# Background holder: takes the first free slot lock, writes its number to <state>/ready, and keeps
# the lock until <state>/release appears, the hold limit passes, or the process is killed.
# Usage: hold.sh <lock dir> <slots> <state dir> <wait minutes> <hold minutes>
set -eu
dir="$1" slots="$2" state="$3" wait_min="$4" hold_min="$5"
start=$SECONDS
while :; do
  for ((i = 1; i <= slots; i++)); do
    exec 9> "$dir/$i.lock"
    if flock -n 9; then
      echo "$i" > "$state/ready.tmp"
      mv "$state/ready.tmp" "$state/ready"
      end=$((SECONDS + hold_min * 60))
      while [ ! -e "$state/release" ] && [ "$SECONDS" -lt "$end" ]; do sleep 1; done
      # `release` waits for `ready` to go, so the slot is free when it returns.
      rm -f "$state/ready" "$state/release"
      exit 0
    fi
    exec 9>&-
  done
  if [ $((SECONDS - start)) -ge $((wait_min * 60)) ]; then
    echo timeout > "$state/ready"
    exit 0
  fi
  sleep $((RANDOM % 3 + 2))
done
