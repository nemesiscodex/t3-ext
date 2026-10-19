"use strict";

// The LaunchAgent that re-attaches the host after T3 restarts itself (an auto-update replaces the
// bundle, so its Info.plist changes). It runs "t3ext attach --wait", which never focuses T3 and
// does nothing when the host is already loaded.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LABEL = "dev.t3ext.reattach";
const WAIT_MS = 120_000;
const THROTTLE_S = 30;

function paths(home = os.homedir()) {
  return {
    plist: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    log: path.join(home, "Library", "Logs", "t3ext.log"),
  };
}

// The same interpreter choice as T3 Code+: T3's own binary as Node, else the node that ran
// install-agent. An update may still be swapping the bundle when the watch fires, so the
// binary gets a few tries before the fallback.
const SCRIPT = `APP="$1"; CLI="$2"; FALLBACK_NODE="$3"; WAIT_MS="$4"
echo "$(date) $APP/Contents/Info.plist changed; attaching the extension host"
NODE=""
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  EXE="$APP/Contents/MacOS/$(/usr/bin/plutil -extract CFBundleExecutable raw "$APP/Contents/Info.plist" 2>/dev/null)"
  if ELECTRON_RUN_AS_NODE=1 "$EXE" -e 0 >/dev/null 2>&1; then NODE="$EXE"; break; fi
  sleep 3
done
if [ -n "$NODE" ]; then
  ELECTRON_RUN_AS_NODE=1 "$NODE" "$CLI" attach --app "$APP" --wait "$WAIT_MS"
else
  echo "$(date) $APP cannot run as node; using $FALLBACK_NODE"
  "$FALLBACK_NODE" "$CLI" attach --app "$APP" --wait "$WAIT_MS"
fi
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  /usr/bin/osascript -e 'display notification "Extensions were not re-attached after T3 Code restarted. See ~/Library/Logs/t3ext.log" with title "t3ext"' >/dev/null 2>&1
fi
exit "$STATUS"`;

const xml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plistContent({ app, cliPath, fallbackNode, log }) {
  const args = ["/bin/sh", "-c", SCRIPT, "t3ext-reattach", app, cliPath, fallbackNode, String(WAIT_MS)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>WatchPaths</key>
  <array>
    <string>${xml(path.join(app, "Contents", "Info.plist"))}</string>
  </array>
  <key>ThrottleInterval</key>
  <integer>${THROTTLE_S}</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function domain() {
  return `gui/${process.getuid()}`;
}

// Everything install-agent writes and runs, so --dry-run can print exactly that.
function plan({ app, cliPath, fallbackNode = process.execPath, home }) {
  const { plist, log } = paths(home);
  return {
    plist,
    log,
    content: plistContent({ app, cliPath, fallbackNode, log }),
    commands: [
      ["launchctl", "bootout", `${domain()}/${LABEL}`],
      ["launchctl", "bootstrap", domain(), plist],
    ],
  };
}

// Booting out first makes a reinstall pick up a changed plist; it fails harmlessly when not loaded.
function install(planned) {
  fs.mkdirSync(path.dirname(planned.plist), { recursive: true });
  fs.mkdirSync(path.dirname(planned.log), { recursive: true });
  const tmp = `${planned.plist}.tmp`;
  fs.writeFileSync(tmp, planned.content);
  fs.renameSync(tmp, planned.plist);
  const [bootout, bootstrap] = planned.commands;
  try {
    execFileSync(bootout[0], bootout.slice(1), { stdio: "ignore" });
  } catch {}
  execFileSync(bootstrap[0], bootstrap.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
}

function uninstallPlan({ home } = {}) {
  return { plist: paths(home).plist, commands: [["launchctl", "bootout", `${domain()}/${LABEL}`]] };
}

function uninstall(planned) {
  try {
    execFileSync(planned.commands[0][0], planned.commands[0].slice(1), { stdio: "ignore" });
  } catch {}
  fs.rmSync(planned.plist, { force: true });
}

// { installed, loaded }: the plist exists, and launchd has the job.
function state({ home } = {}) {
  const installed = fs.existsSync(paths(home).plist);
  let loaded = true;
  try {
    execFileSync("launchctl", ["print", `${domain()}/${LABEL}`], { stdio: "ignore" });
  } catch {
    loaded = false;
  }
  return { installed, loaded };
}

module.exports = { plan, install, uninstallPlan, uninstall, state, paths, LABEL, WAIT_MS, THROTTLE_S };
