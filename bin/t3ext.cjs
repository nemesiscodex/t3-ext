#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readFuses } = require("../src/fuses.cjs");
const launcher = require("../src/launcher.cjs");
const launcherApp = require("../src/launcher-app.cjs");

const DEFAULT_APP = "/Applications/T3 Code (Nightly).app";
const USAGE = `Usage:
  t3ext launch [--app <path>] [--env KEY=VALUE]... [--timeout <ms>] [-- <app args>]
      Start T3 Code with extensions, or load them into the running T3 Code. Brings it to the front.
  t3ext attach [--app <path>] [--wait <ms>] [--timeout <ms>]
      Load extensions into the running T3 Code without focusing it. Does nothing if they are
      loaded. --wait first waits up to <ms> for T3 Code to start; if it does not, exits 0.
  t3ext status [--app <path>]
      Show the app version, running pid, whether the host is loaded, the inspect fuse, and
      whether T3 Code+ is installed.
  t3ext install-launcher [--app <path>] [--dest <dir>] [--dry-run]
      Build "T3 Code+.app" in <dir> (default ~/Applications) that runs "t3ext launch".

--app defaults to "${DEFAULT_APP}".`;

function parseArgs(argv) {
  const options = { command: argv[0], app: DEFAULT_APP, env: {}, appArgs: [], timeoutMs: 20_000, waitMs: 0, dest: undefined, dryRun: false };
  const value = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  const milliseconds = (i, flag) => {
    const ms = Number(value(i, flag));
    if (!Number.isFinite(ms) || ms <= 0) throw new Error(`${flag} must be a positive number of milliseconds`);
    return ms;
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.appArgs = argv.slice(i + 1);
      break;
    } else if (arg === "--app") options.app = value(i++, arg);
    else if (arg === "--dest") options.dest = path.resolve(value(i++, arg));
    else if (arg === "--timeout") options.timeoutMs = milliseconds(i++, arg);
    else if (arg === "--wait") options.waitMs = milliseconds(i++, arg);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--env") {
      const pair = value(i++, arg);
      const eq = pair.indexOf("=");
      if (eq < 1) throw new Error(`--env expects KEY=VALUE, got "${pair}"`);
      options.env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else throw new Error(`Unexpected argument: ${arg}`);
  }
  options.app = path.resolve(options.app.replace(/\/+$/, ""));
  return options;
}

function requireApp(app) {
  if (!fs.existsSync(path.join(app, "Contents", "Info.plist"))) throw new Error(`${app} is not an app bundle`);
}

const SUCCESS = {
  launch: {
    started: ({ pid, port }, app) => `Started ${app} (pid ${pid}) with the extension host. Inspector 127.0.0.1:${port} closed.`,
    attached: ({ pid, reloaded }, app) => `Loaded the extension host into the running ${app} (pid ${pid}) and reloaded ${reloaded} window(s); brought it to the front. Inspector 127.0.0.1:${launcher.SIGNAL_PORT} closed.`,
    "already-hosted": ({ pid }, app) => `${app} is already running (pid ${pid}) with the extension host; brought it to the front.`,
  },
  attach: {
    attached: ({ pid, reloaded }, app) => `Loaded the extension host into ${app} (pid ${pid}) and reloaded ${reloaded} window(s). Inspector 127.0.0.1:${launcher.SIGNAL_PORT} closed.`,
    "already-hosted": ({ pid }, app) => `${app} (pid ${pid}) already has the extension host; nothing to do.`,
    "not-running": (_result, app, { waitMs }) => (waitMs ? `${app} did not start within ${waitMs} ms; nothing to attach to.` : `${app} is not running; nothing to attach to.`),
  },
};

async function drive(mode, options) {
  requireApp(options.app);
  const result = await launcher.run({ ...options, mode });
  const stamp = new Date().toISOString();
  if (result.kind === "failed") {
    console.error(`${stamp} ${result.message}`);
    return 1;
  }
  console.log(`${stamp} ${SUCCESS[mode][result.kind](result, options.app, options)}`);
  return 0;
}

const yesNo = (value) => (value ? "yes" : "no");

const commands = {
  launch: (options) => drive("launch", options),
  attach: (options) => drive("attach", options),
  async status({ app }) {
    requireApp(app);
    const { state, pid } = await launcher.observe(app);
    let fuse;
    try {
      fuse = readFuses(app).fuses.EnableNodeCliInspectArguments;
    } catch (error) {
      fuse = `unreadable (${error.message})`;
    }
    const launcherBundle = path.join(os.homedir(), "Applications", `${launcherApp.NAME}.app`);
    const rows = [
      ["app", app],
      ["version", launcher.plistValue(app, "CFBundleShortVersionString")],
      ["running", pid ? `yes (pid ${pid}${state === "starting" ? ", still starting" : ""})` : "no"],
      ["host loaded", pid ? yesNo(state === "hosted") : "no (not running)"],
      ["inspect fuse", fuse],
      ["launcher installed", fs.existsSync(launcherBundle) ? `yes (${launcherBundle})` : "no"],
    ];
    for (const [label, value] of rows) console.log(`${label.padEnd(19)}${value}`);
    return 0;
  },
  async "install-launcher"({ app, dest, dryRun }) {
    requireApp(app);
    const version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
    const planned = launcherApp.plan({ app, destDir: dest, cliPath: __filename, version });
    if (dryRun) {
      console.log(`Would create ${planned.bundle} (ad-hoc signed):`);
      for (const file of planned.files) {
        console.log(`\n== ${file.path}${file.copyFrom ? ` (copied from ${file.copyFrom})` : ""}`);
        if (file.content) process.stdout.write(file.content);
      }
      return 0;
    }
    console.log(`Created ${launcherApp.build(planned)}. Open it instead of T3 Code to load extensions.`);
    return 0;
  },
};

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const command = commands[options.command];
  if (!command) {
    console.error(USAGE);
    return options.command === "help" || options.command === "--help" ? 0 : 2;
  }
  try {
    return await command(options);
  } catch (error) {
    console.error(`t3ext ${options.command}: ${error.message}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
