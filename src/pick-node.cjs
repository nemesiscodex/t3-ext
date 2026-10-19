"use strict";

// Shell that sets NODE to T3's own binary when it can run as Node, else leaves it empty so the
// caller uses FALLBACK_NODE. Expects APP, CLI and FALLBACK_NODE. The RunAsNode fuse is read
// first (with the fallback node), because with that fuse off, running T3's binary with
// ELECTRON_RUN_AS_NODE=1 starts the T3 app instead. Exit 3 means "fuse off"; any other
// failure of that check (no fallback node, a bundle mid-update) falls through to the probe.
function pickNodeShell({ attempts = 1, retryDelayS = 3 } = {}) {
  return `FUSES="$(dirname "$CLI")/../src/fuses.cjs"
NODE=""
attempt=1
while [ "$attempt" -le ${attempts} ]; do
  "$FALLBACK_NODE" -e 'process.exitCode = require(process.argv[1]).readFuses(process.argv[2]).fuses.RunAsNode === "on" ? 0 : 3' "$FUSES" "$APP" >/dev/null 2>&1
  [ "$?" -eq 3 ] && break
  EXE="$APP/Contents/MacOS/$(/usr/bin/plutil -extract CFBundleExecutable raw "$APP/Contents/Info.plist" 2>/dev/null)"
  if ELECTRON_RUN_AS_NODE=1 "$EXE" -e 0 >/dev/null 2>&1; then NODE="$EXE"; break; fi
  [ "$attempt" -lt ${attempts} ] && sleep ${retryDelayS}
  attempt=$((attempt + 1))
done`;
}

module.exports = { pickNodeShell };
