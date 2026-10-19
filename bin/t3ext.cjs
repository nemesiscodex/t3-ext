#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { launch } = require("../src/launcher.cjs");
const launcherApp = require("../src/launcher-app.cjs");
const { targets, waitFor } = require("../src/cdp.cjs");

const DEFAULT_APP = "/Applications/T3 Code (Nightly).app";
const USAGE = `Usage:
  t3ext launch [--app <path>] [--env KEY=VALUE]... [--timeout <ms>] [-- <app args>]
      Start T3 Code with extensions loaded. If it is already running, bring it to the front.
  t3ext install-launcher [--app <path>] [--dest <dir>] [--dry-run]
      Build "T3 Code+.app" in <dir> (default ~/Applications) that runs "t3ext launch".

--app defaults to "${DEFAULT_APP}".`;

function parseArgs(argv) {
  const options = { command: argv[0], app: DEFAULT_APP, env: {}, appArgs: [], timeoutMs: 20_000, dest: undefined, dryRun: false };
  const value = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.appArgs = argv.slice(i + 1);
      break;
    } else if (arg === "--app") options.app = value(i++, arg);
    else if (arg === "--dest") options.dest = path.resolve(value(i++, arg));
    else if (arg === "--timeout") options.timeoutMs = Number(value(i++, arg));
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--env") {
      const pair = value(i++, arg);
      const eq = pair.indexOf("=");
      if (eq < 1) throw new Error(`--env expects KEY=VALUE, got "${pair}"`);
      options.env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout must be a positive number of milliseconds");
  options.app = path.resolve(options.app.replace(/\/+$/, ""));
  return options;
}

function requireApp(app) {
  if (!fs.existsSync(path.join(app, "Contents", "Info.plist"))) throw new Error(`${app} is not an app bundle`);
}

const commands = {
  async launch({ app, env, appArgs, timeoutMs }) {
    requireApp(app);
    const result = await launch({ app, env, appArgs, timeoutMs });
    const stamp = new Date().toISOString();
    switch (result.kind) {
      case "activated":
        console.log(`${stamp} ${app} is already running (pid ${result.pid}); brought it to the front. Extensions load on the next start through t3ext launch.`);
        return 0;
      case "injected": {
        const closed = await waitFor("the inspector to close", async () => !(await targets(result.port).then(() => true, () => false)), { timeoutMs: 5000 }).then(
          () => "closed",
          () => "STILL OPEN",
        );
        console.log(`${stamp} Started ${app} (pid ${result.pid}) with the extension host. Inspector 127.0.0.1:${result.port} ${closed}.`);
        return closed === "closed" ? 0 : 1;
      }
      case "no-inspector":
        console.error(
          `${stamp} ${app} did not open its inspector on 127.0.0.1:${result.port} (${result.error}). Extensions were not loaded. ` +
            "If T3 Code is open but blank, it is waiting for a debugger: quit it and launch again.",
        );
        return 1;
      case "inject-failed":
        console.error(`${stamp} ${app} (pid ${result.pid}) continues without extensions; loading the host failed: ${result.error}`);
        return 1;
    }
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
