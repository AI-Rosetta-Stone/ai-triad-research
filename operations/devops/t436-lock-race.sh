#!/bin/sh
# t/436 (TL p/9#318): does a concurrent mkdir, or exclusive file creation (O_EXCL), let two callers
# both win the same path on this filesystem? Run on the CI runner before the lock change, and kept as
# a measurement. Usage: t436-lock-race.sh [trials]. Prints the counts; exits 0.
N=${1:-1000}
D=$(mktemp -d) || exit 0
mk=0
ex=0
i=0
while [ "$i" -lt "$N" ]; do
  i=$((i + 1))
  rm -rf "$D/M" "$D/F" "$D/ra" "$D/rb" "$D/xa" "$D/xb"
  ( mkdir "$D/M" 2>/dev/null; echo $? > "$D/ra" ) &
  ( mkdir "$D/M" 2>/dev/null; echo $? > "$D/rb" ) &
  wait
  [ "$(cat "$D/ra")" = 0 ] && [ "$(cat "$D/rb")" = 0 ] && mk=$((mk + 1))
  ( set -C; { : > "$D/F"; } 2>/dev/null; echo $? > "$D/xa" ) &
  ( set -C; { : > "$D/F"; } 2>/dev/null; echo $? > "$D/xb" ) &
  wait
  [ "$(cat "$D/xa")" = 0 ] && [ "$(cat "$D/xb")" = 0 ] && ex=$((ex + 1))
done
echo "t436 race: $N trials of two concurrent callers. mkdir both-succeed: $mk. O_EXCL both-succeed: $ex."
rm -rf "$D"
exit 0
