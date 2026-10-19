"use strict";

// End to end on an untouched clone of the real app, started WITHOUT the launcher (as the Dock,
// Spotlight, a deep link, or an auto-update restart would): t3ext attach loads the host over
// SIGUSR1, and a second attach and a launch change nothing. Usage: node test/e2e-attach.cjs   (T3EXT_E2E_APP overrides)

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const h = require("./harness.cjs");
const { observe, runningPid, SIGNAL_PORT } = require("../src/launcher.cjs");

const SOURCE_APP = process.env.T3EXT_E2E_APP ?? "/Applications/T3 Code (Nightly).app";
const CLI = path.join(__dirname, "..", "bin", "t3ext.cjs");

const step = (message) => console.log(`ok - ${message}`);

function openEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function frontPid() {
  const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
  return Number(execFileSync("lsappinfo", ["info", "-only", "pid", asn], { encoding: "utf8" }).match(/"pid"=(\d+)/)?.[1]);
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function main() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-e2e-attach-")));
  console.log(`# work dir ${dir}`);
  try {
    const app = h.cloneApp(SOURCE_APP, dir);
    execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
    step("the clone keeps a valid code signature");

    const home = path.join(dir, "home");
    const fakeHome = path.join(dir, "fakehome");
    fs.mkdirSync(path.join(home, "extensions"), { recursive: true });
    fs.mkdirSync(fakeHome);
    fs.symlinkSync(path.join(__dirname, "fixtures", "sample"), path.join(home, "extensions", "sample"));
    const cli = (...args) => spawnSync(process.execPath, [CLI, ...args, "--app", app], { encoding: "utf8", env: openEnv({ HOME: fakeHome }) });

    // Like the Dock or Spotlight would, but in the background so focus changes are observable.
    const startBare = async () => {
      const rendererPort = await h.freePort();
      execFileSync(
        "open",
        ["-g", "-a", app, "--env", `HOME=${fakeHome}`, "--env", `T3CODE_HOME=${home}`, "--env", "T3CODE_DISABLE_AUTO_UPDATE=1", "--args", `--remote-debugging-port=${rendererPort}`, "--use-mock-keychain"],
        { env: openEnv() },
      );
      const { pid } = await h.waitFor("the clone to finish starting", async () => {
        const observed = await observe(app);
        return observed.state === "bare" && observed;
      }, { timeoutMs: 60_000 });
      return { pid, rendererPort };
    };
    const stop = async () => {
      const pid = runningPid(app);
      process.kill(pid, "SIGTERM");
      await h.waitFor("the clone to quit", () => !runningPid(app), { timeoutMs: 20_000 });
    };

    const { pid, rendererPort } = await startBare();
    assert.equal(Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()), 1);
    step(`the clone started from LaunchServices without the launcher (pid ${pid}); state is bare`);
    const page = await h.appPage(rendererPort, 90_000);
    await h.waitFor("the page to load", () => page.evaluate("document.readyState === 'complete'"));
    assert.equal(await page.evaluate("typeof window.t3ext"), "undefined");

    const before = cli("status");
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, new RegExp(`running +yes \\(pid ${pid}\\)`));
    assert.match(before.stdout, /host loaded +no/);
    assert.match(before.stdout, /inspect fuse +on/);
    console.log(before.stdout.trimEnd().replace(/^/gm, "#   "));
    step("status before attach: running, host not loaded, inspect fuse on");

    const dummy = net.createServer();
    await new Promise((resolve) => dummy.listen(SIGNAL_PORT, "127.0.0.1", resolve));
    const busy = cli("attach");
    await new Promise((resolve) => dummy.close(resolve));
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, new RegExp(`Port 9229 on 127\\.0\\.0\\.1 is in use by node \\(pid ${process.pid}\\)\\. .* keeps running\\. Free the port and try again\\.`));
    assert.equal(runningPid(app), pid, "T3 is still running");
    assert.equal((await observe(app)).state, "bare");
    assert.equal(await page.evaluate("typeof window.t3ext"), "undefined", "the page was not touched");
    step(`port 9229 held by a dummy listener: attach exits 1 with "${busy.stderr.trim().slice(25, 110)}…"; T3 keeps running, untouched`);

    const front = frontPid();
    assert.notEqual(front, pid, "the background clone is not frontmost");
    const attached = cli("attach");
    assert.equal(attached.status, 0, attached.stderr);
    assert.match(attached.stdout, new RegExp(`Loaded the extension host into .* \\(pid ${pid}\\) and reloaded 1 window\\(s\\)\\. Inspector 127\\.0\\.0\\.1:9229 closed\\.`));
    step(`attach: ${attached.stdout.trim().slice(25)}`);
    assert.equal(await listening(SIGNAL_PORT), false, "nothing listens on 9229 after attach");
    step("inspector port 9229 refuses connections after attach");
    assert.equal((await observe(app)).state, "hosted");
    step("the host answers on its presence socket (state hosted)");

    await h.waitFor("the reloaded page with the sample renderer", () => page.evaluate("document.readyState === 'complete' && !!window.__t3extSample"), { timeoutMs: 30_000 });
    assert.equal(await page.evaluate("typeof window.t3ext"), "object");
    const ids = await page.evaluate("window.t3ext.list().then((list) => list.map((e) => e.id))");
    assert.deepEqual(ids, ["builtin:extension-manager", "sample"]);
    step(`window.t3ext is present after the reload; list() returns ${JSON.stringify(ids)}`);
    assert.equal(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--t3ext-sample").trim()`), "applied");
    step("sample renderer.js ran and sample style.css applied (computed --t3ext-sample is 'applied')");
    await h.waitFor("the manager renderer", () => page.evaluate("window.__t3extManager === true"));
    step("the builtin extension manager renderer ran");
    const mainMarker = JSON.parse(fs.readFileSync(path.join(home, "sample-main-ran.json"), "utf8"));
    assert.equal(mainMarker.pid, pid);
    assert.equal(mainMarker.hasApp, true);
    step("sample main.js ran in T3's main process and received electron");
    assert.notEqual(frontPid(), pid, "attach did not bring T3 forward");
    step("attach did not bring the clone to the front");

    process.kill(pid, "SIGUSR1");
    const target = await h.waitFor("the inspector for the menu check", async () => (await h.targets(SIGNAL_PORT))[0], { timeoutMs: 10_000 });
    const main = await h.Cdp.connect(target.webSocketDebuggerUrl);
    const menu = await main.evaluate(`(() => {
      const { Menu } = process.mainModule.require("electron");
      const item = Menu.getApplicationMenu().getMenuItemById("t3ext-menu");
      return { top: Menu.getApplicationMenu().items.map((i) => i.label), sub: item && item.submenu.items.map((i) => i.label) };
    })()`);
    await main.evaluate(`setImmediate(() => process.mainModule.require("node:inspector").close()), "closing"`);
    main.close();
    await h.waitFor("the menu-check inspector to close", async () => !(await listening(SIGNAL_PORT)), { timeoutMs: 5000 });
    assert.ok(menu.top.includes("Extensions"), JSON.stringify(menu.top));
    assert.deepEqual(menu.sub, ["Manage Extensions…", "Open Extensions Folder", "", "Reload Window"]);
    step(`the current application menu gained Extensions: ${JSON.stringify(menu.top)}`);

    const after = cli("status");
    assert.match(after.stdout, /host loaded +yes/);
    console.log(after.stdout.trimEnd().replace(/^/gm, "#   "));
    step("status after attach: host loaded yes");

    await page.evaluate("window.__survivesNoReload = 'kept'");
    const again = cli("attach");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`\\(pid ${pid}\\) already has the extension host; nothing to do\\.`));
    assert.equal(await page.evaluate("window.__survivesNoReload"), "kept", "the page was not reloaded");
    assert.notEqual(frontPid(), pid, "still not brought forward");
    step("a second attach is a no-op: the page global survives (no reload) and the clone stays in the background");

    const launched = cli("launch");
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, new RegExp(`is already running \\(pid ${pid}\\) with the extension host; brought it to the front\\.`));
    await h.waitFor("the clone to come to the front", () => frontPid() === pid, { timeoutMs: 5000 });
    assert.equal(await page.evaluate("window.__survivesNoReload"), "kept");
    assert.equal(runningPid(app), pid);
    step("launch on the hosted instance only activates it: frontmost, same pid, no reload");
    page.close();

    await stop();
    step("quit the clone");

    console.log("# all attach e2e checks passed");
  } finally {
    const left = await h.killUnder(dir);
    if (left.length) console.error(`# could not kill: ${left.join(", ")}`);
    else fs.rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(`not ok - ${error.stack}`);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
