"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const CLI = path.join(__dirname, "..", "bin", "t3ext.cjs");
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const runWithHome = (home, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });

function fixtureApp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Fixture's App.app");
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIconFile</key><string>icon.icns</string><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>',
  );
  fs.writeFileSync(path.join(app, "Contents", "Resources", "icon.icns"), "icns");
  return { root, app };
}

test("install-launcher --dry-run prints the bundle without writing it", (t) => {
  const { root, app } = fixtureApp(t);
  const result = run("install-launcher", "--dry-run", "--app", app, "--dest", root);
  assert.equal(result.status, 0, result.stderr);
  const bundle = path.join(root, "T3 Code+.app");
  assert.match(result.stdout, new RegExp(`Would create ${bundle.replace(/[.+]/g, "\\$&")}`));
  assert.match(result.stdout, /copied from .*icon\.icns/);
  assert.match(result.stdout, /ELECTRON_RUN_AS_NODE=1 "\$EXE" "\$CLI" launch --app "\$APP"/);
  assert.equal(fs.existsSync(bundle), false, "dry run writes nothing");
});

test("install-launcher builds a valid ad-hoc signed app that quotes odd paths", (t) => {
  const { root, app } = fixtureApp(t);
  const result = run("install-launcher", "--app", app, "--dest", root);
  assert.equal(result.status, 0, result.stderr);
  const bundle = path.join(root, "T3 Code+.app");
  execFileSync("codesign", ["--verify", "--strict", bundle]);
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(bundle, "Contents", "Info.plist")], { encoding: "utf8" }));
  assert.equal(info.CFBundleExecutable, "t3code-plus");
  assert.equal(info.CFBundleIconFile, "icon.icns");
  assert.equal(info.LSUIElement, true);
  const script = path.join(bundle, "Contents", "MacOS", "t3code-plus");
  assert.ok(fs.statSync(script).mode & 0o111, "launcher script is executable");
  execFileSync("sh", ["-n", script]);
  const resolved = execFileSync("sh", ["-c", `eval "$(sed -n '/^DEFAULT_APP=/,/^APP=/p' "$1")"; printf %s "$APP"`, "sh", script], { encoding: "utf8" });
  assert.equal(resolved, app, "baked app path survives shell quoting");
  assert.equal(fs.readFileSync(path.join(bundle, "Contents", "Resources", "icon.icns"), "utf8"), "icns", "icon copied from the app");
});

test("bad arguments exit 2 with usage; a missing app exits 1", () => {
  assert.equal(run("frobnicate").status, 2);
  assert.equal(run("launch", "--env", "NOEQUALS").status, 2);
  assert.equal(run("attach", "--wait", "soon").status, 2);
  for (const command of ["launch", "attach", "status", "install-agent"]) {
    const missing = run(command, "--app", "/nonexistent/X.app");
    assert.equal(missing.status, 1, command);
    assert.match(missing.stderr, /is not an app bundle/, command);
  }
});

function dryRunPlist(t) {
  const { root, app } = fixtureApp(t);
  const home = path.join(root, "home");
  const result = runWithHome(home, "install-agent", "--dry-run", "--app", app);
  assert.equal(result.status, 0, result.stderr);
  const plistPath = path.join(home, "Library", "LaunchAgents", "dev.t3ext.reattach.plist");
  assert.ok(result.stdout.startsWith(`Would write ${plistPath}:`), result.stdout);
  assert.equal(fs.existsSync(path.join(home, "Library")), false, "dry run writes nothing");
  const content = result.stdout.slice(result.stdout.indexOf("<?xml"), result.stdout.indexOf("</plist>") + "</plist>\n".length);
  const file = path.join(root, "agent.plist");
  fs.writeFileSync(file, content);
  return { root, app, home, file, stdout: result.stdout };
}

test("install-agent --dry-run prints a valid LaunchAgent that watches the app's Info.plist", (t) => {
  const { app, home, file, stdout } = dryRunPlist(t);
  execFileSync("plutil", ["-lint", file]);
  const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
  assert.equal(plist.Label, "dev.t3ext.reattach");
  assert.deepEqual(plist.WatchPaths, [path.join(app, "Contents", "Info.plist")]);
  assert.equal(plist.ThrottleInterval, 30);
  assert.equal(plist.RunAtLoad, undefined, "runs only when the watched file changes");
  const log = path.join(home, "Library", "Logs", "t3ext.log");
  assert.deepEqual([plist.StandardOutPath, plist.StandardErrorPath], [log, log]);
  const [shell, flag, script, name, ...args] = plist.ProgramArguments;
  assert.deepEqual([shell, flag, name], ["/bin/sh", "-c", "t3ext-reattach"]);
  assert.deepEqual(args, [app, CLI, process.execPath, "120000"], "app, CLI, fallback node, wait; passed as arguments, never spliced into the script");
  execFileSync("sh", ["-n", "-c", script]);
  assert.match(script, /ELECTRON_RUN_AS_NODE=1 "\$NODE" "\$CLI" attach --app "\$APP" --wait "\$WAIT_MS"/);
  assert.match(script, /"\$FALLBACK_NODE" "\$CLI" attach --app "\$APP" --wait "\$WAIT_MS"/);
  assert.doesNotMatch(script, /\blaunch\b|open -a/, "the agent never activates T3");
  assert.match(stdout, new RegExp(`launchctl bootstrap gui/${process.getuid()} `));
});

test("the agent script runs attach on T3's binary as node, falls back to the recorded node, and notifies only on failure", (t) => {
  const { root, file } = dryRunPlist(t);
  const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
  const script = plist.ProgramArguments[2];
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const app = path.join(root, "Stub.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Stub</string></dict></plist>');
  const calls = path.join(root, "calls");
  const recorder = (name, status) => `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(calls)}\nexit ${status}\n`;
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "Stub"), recorder("app-binary", 0), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "fallback-node"), recorder("fallback", 3), { mode: 0o755 });
  const shim = () => spawnSync("/bin/sh", ["-c", script.replaceAll("/usr/bin/osascript", path.join(bin, "osascript")).replaceAll("sleep 3", "sleep 0"), "t3ext-reattach", app, "/cli.cjs", path.join(bin, "fallback-node"), "5000"], { encoding: "utf8" });
  fs.writeFileSync(path.join(bin, "osascript"), recorder("notify", 0), { mode: 0o755 });

  let result = shim();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["app-binary -e 0", "app-binary /cli.cjs attach --app " + app + " --wait 5000"]);

  fs.rmSync(calls);
  fs.chmodSync(path.join(app, "Contents", "MacOS", "Stub"), 0o644);
  result = shim();
  assert.equal(result.status, 3, "the CLI's failure is the agent's exit status");
  const lines = fs.readFileSync(calls, "utf8").trim().split("\n");
  assert.deepEqual(lines.slice(0, 2), ["fallback /cli.cjs attach --app " + app + " --wait 5000", "notify -e display notification \"Extensions were not re-attached after T3 Code restarted. See ~/Library/Logs/t3ext.log\" with title \"t3ext\""]);
  assert.match(result.stdout, /cannot run as node; using .*fallback-node/);
});

test("uninstall-agent --dry-run names the job and the plist without touching either", (t) => {
  const { root } = fixtureApp(t);
  const home = path.join(root, "home");
  const result = runWithHome(home, "uninstall-agent", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`launchctl bootout gui/${process.getuid()}/dev\\.t3ext\\.reattach`));
  assert.match(result.stdout, new RegExp(`remove ${path.join(home, "Library", "LaunchAgents", "dev.t3ext.reattach.plist").replace(/[.+]/g, "\\$&")}`));
});
