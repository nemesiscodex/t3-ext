#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const patcher = require("../src/patcher.cjs");
const launchAgent = require("../src/launch-agent.cjs");

const DEFAULT_APP = "/Applications/T3 Code (Nightly).app";
const USAGE = `Usage: t3ext <command> [--app <path>] [--dry-run]

Commands:
  patch            Add the extension loader to the app (safe to rerun)
  unpatch          Restore the original app.asar from the backup
  status           Show app version, patch state, backup, and launch agent
  install-agent    Install a LaunchAgent that repatches after app updates (--dry-run prints it)
  uninstall-agent  Remove that LaunchAgent

--app defaults to "${DEFAULT_APP}".`;

function parseArgs(argv) {
  const options = { command: undefined, app: DEFAULT_APP, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--app") {
      if (!argv[i + 1]) throw new Error("--app needs a path");
      options.app = argv[++i];
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "-h" || arg === "--help") options.command = "help";
    else if (!options.command) options.command = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  options.app = path.resolve(options.app.replace(/\/+$/, ""));
  return options;
}

function appVersion(infoPlist) {
  try {
    return execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", infoPlist], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const commands = {
  help() {
    console.log(USAGE);
  },
  patch({ app }) {
    const result = patcher.patch(app);
    const messages = {
      patched: "Patched. Restart T3 Code to load extensions.",
      "already-patched": "Already patched with the current shim. Nothing to do.",
      repatched: "Repatched from the backup with the updated shim. Restart T3 Code to apply.",
    };
    console.log(`${messages[result.action]} (shim ${result.hash.slice(0, 12)}, ${app})`);
  },
  unpatch({ app }) {
    const result = patcher.unpatch(app);
    console.log(result.action === "unpatched" ? `Restored the original app.asar (${app}).` : `Not patched. Nothing to do (${app}).`);
  },
  status({ app }) {
    const state = patcher.inspect(app);
    const archive = state.archive;
    const lines = [
      ["app", app],
      ["version", appVersion(state.paths.infoPlist)],
      ["patched", archive.kind === "patched" ? "yes" : "no"],
      ["shim", archive.kind === "patched" ? (archive.hash === state.shimHash ? "current" : `outdated (run patch)`) : "-"],
      ["backup", state.backup.kind === "missing" ? "missing" : `present (${state.backup.kind})`],
      ["agent", launchAgent.isInstalled() ? `installed (${launchAgent.plistPath()})` : "not installed"],
    ];
    for (const [key, value] of lines) console.log(`${key.padEnd(8)} ${value}`);
  },
  "install-agent"({ app, dryRun }) {
    if (!fs.existsSync(app)) throw new Error(`${app} does not exist`);
    const options = { appPath: app, cliPath: __filename };
    if (dryRun) {
      process.stdout.write(launchAgent.plist(options));
      return;
    }
    console.log(`Installed ${launchAgent.install(options)}. It runs "patch" at login and whenever the app's Info.plist changes.`);
  },
  "uninstall-agent"() {
    console.log(`Removed ${launchAgent.uninstall()}.`);
  },
};

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const command = commands[options.command];
  if (!command) {
    console.error(options.command ? `Unknown command: ${options.command}\n\n${USAGE}` : USAGE);
    return 2;
  }
  try {
    command(options);
    return 0;
  } catch (error) {
    console.error(`t3ext ${options.command}: ${error.message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
