"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LABEL = "dev.t3ext.repatch";

function plistPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Rerun `patch` whenever the app bundle's Info.plist changes, which is what an update rewrites.
function plist({ appPath, nodePath = process.execPath, cliPath, home = os.homedir() }) {
  const log = path.join(home, "Library", "Logs", "t3ext.log");
  const args = [nodePath, cliPath, "patch", "--app", appPath];
  const string = (value) => `<string>${escapeXml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(LABEL)}
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    ${string(arg)}`).join("\n")}
  </array>
  <key>WatchPaths</key>
  <array>
    ${string(path.join(appPath, "Contents", "Info.plist"))}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  ${string(log)}
  <key>StandardErrorPath</key>
  ${string(log)}
</dict>
</plist>
`;
}

function isInstalled(home) {
  return fs.existsSync(plistPath(home));
}

function install(options) {
  const target = plistPath(options.home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, plist(options));
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  } catch {}
  execFileSync("launchctl", ["bootstrap", domain, target], { stdio: "inherit" });
  return target;
}

function uninstall(home) {
  const target = plistPath(home);
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" });
  } catch {}
  fs.rmSync(target, { force: true });
  return target;
}

module.exports = { LABEL, plist, plistPath, isInstalled, install, uninstall };
