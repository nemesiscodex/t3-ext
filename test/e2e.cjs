"use strict";

// End to end on an untouched clone of the real app:
// T3 Code+.app -> t3ext launch (on T3's own binary) -> open --inspect-brk -> host injected.
// Usage: node test/e2e.cjs [--keep]   (T3EXT_E2E_APP overrides the source app)

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const h = require("./harness.cjs");
const { runningPid } = require("../src/launcher.cjs");

const SOURCE_APP = process.env.T3EXT_E2E_APP ?? "/Applications/T3 Code (Nightly).app";
const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "t3ext.cjs");
const DOCS = path.join(ROOT, "docs");
const keep = process.argv.includes("--keep");

const step = (message) => console.log(`ok - ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluateUntil(page, what, expression, timeoutMs = 20_000) {
  return h.waitFor(what, () => page.evaluate(expression), { timeoutMs });
}

// T3 shows onboarding to a fresh home and redirects every route to it until it is done.
// Only these buttons are clicked; anything else fails the run instead of guessing.
async function reachSettings(page) {
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const state = await page.evaluate(`(async () => {
      if (!location.hash.startsWith("#/welcome")) location.hash = "#/settings/general";
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return {
        hash: location.hash,
        sidebar: [...document.querySelectorAll('ul[data-sidebar="menu"] li')].some((li) => li.textContent.trim() === "Appearance"),
        buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean),
      };
    })()`);
    if (state.hash.startsWith("#/settings") && state.sidebar) return seen;
    if (!state.hash.startsWith("#/welcome")) continue;
    const next = ["Continue", "Do not import projects"].find((label) => state.buttons.includes(label));
    assert.ok(next, `onboarding step has a known safe button; saw: ${JSON.stringify(state.buttons)}`);
    seen.push(next);
    await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(next)}).click()`);
  }
  throw new Error(`could not reach settings; clicked ${JSON.stringify(seen)}`);
}

async function main() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-e2e-")));
  console.log(`# work dir ${dir}`);
  try {
    const app = h.cloneApp(SOURCE_APP, dir);
    execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
    step("the clone keeps a valid code signature (nothing in the bundle is modified)");

    const home = path.join(dir, "home");
    const fakeHome = path.join(dir, "fakehome");
    fs.mkdirSync(path.join(home, "extensions"), { recursive: true });
    fs.mkdirSync(fakeHome);
    fs.symlinkSync(path.join(__dirname, "fixtures", "sample"), path.join(home, "extensions", "sample"));

    const launcherDir = path.join(dir, "launcher");
    fs.mkdirSync(launcherDir);
    execFileSync(process.execPath, [CLI, "install-launcher", "--app", app, "--dest", launcherDir], { stdio: "inherit" });
    const wrapper = path.join(launcherDir, "T3 Code+.app");
    execFileSync("codesign", ["--verify", "--strict", wrapper]);
    step("install-launcher built an ad-hoc signed T3 Code+.app");

    const rendererPort = await h.freePort();
    const launchArgs = [
      `--env HOME=${fakeHome}`,
      `--env T3CODE_HOME=${home}`,
      "--env T3CODE_DISABLE_AUTO_UPDATE=1",
      `-- --remote-debugging-port=${rendererPort} --use-mock-keychain`,
    ].join(" ");
    const openEnv = { ...process.env };
    delete openEnv.ELECTRON_RUN_AS_NODE;
    execFileSync("open", [wrapper, "--env", `HOME=${fakeHome}`, "--env", `T3EXT_APP=${app}`, "--env", `T3EXT_LAUNCH_ARGS=${launchArgs}`], { env: openEnv });

    const logFile = path.join(fakeHome, "Library", "Logs", "t3ext.log");
    const log = await h.waitFor("the launcher log line", () => fs.existsSync(logFile) && /Started|did not|failed/.test(fs.readFileSync(logFile, "utf8")) && fs.readFileSync(logFile, "utf8"), { timeoutMs: 60_000 });
    const started = log.match(/Started .* \(pid (\d+)\) with the extension host\. Inspector 127\.0\.0\.1:(\d+) closed\./);
    assert.ok(started, `launcher reports a started app with a closed inspector; log:\n${log}`);
    assert.doesNotMatch(log, /cannot run as node/, "launcher ran on T3's own binary, not the fallback node");
    const pid = Number(started[1]);
    const inspectorPort = Number(started[2]);
    step(`T3 Code+ started the clone (pid ${pid}) and injected the host; inspector ${inspectorPort} closed`);

    assert.equal(Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()), 1, "T3's parent is launchd");
    step("T3 was started by LaunchServices (parent pid 1), not as a child of the launcher");
    await assert.rejects(h.targets(inspectorPort), "nothing answers on the inspector port after launch");
    step("inspector port refuses connections after injection");

    const page = await h.appPage(rendererPort, 90_000);
    await evaluateUntil(page, "the sample renderer marker", "!!window.__t3extSample");
    step("sample renderer.js ran in the t3code:// page");
    assert.equal(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--t3ext-sample").trim()`), "applied");
    step("sample style.css applied (computed --t3ext-sample is 'applied')");
    assert.equal(await page.evaluate("typeof window.t3ext"), "object");
    const ids = await page.evaluate("window.t3ext.list().then((list) => list.map((e) => e.id))");
    assert.deepEqual(ids, ["builtin:extension-manager", "sample"]);
    step(`window.t3ext.list() returns ${JSON.stringify(ids)}`);

    const mainMarker = JSON.parse(fs.readFileSync(path.join(home, "sample-main-ran.json"), "utf8"));
    assert.equal(mainMarker.pid, pid, "main.js ran inside T3's main process");
    assert.equal(mainMarker.hasApp, true, "main.js received electron");
    step("sample main.js ran in the main process and received { id, dir, electron }");

    await assert.rejects(page.evaluate(`window.t3ext.remove("builtin:extension-manager")`), /built in and cannot be removed/);
    step("removing the builtin manager is refused");

    const exe = path.join(app, "Contents", "MacOS", path.basename(app, ".app"));
    const again = execFileSync(exe, [CLI, "launch", "--app", app], { encoding: "utf8", env: { ...openEnv, ELECTRON_RUN_AS_NODE: "1", HOME: fakeHome } });
    assert.match(again, /is already running \(pid (\d+)\); brought it to the front/);
    assert.equal(runningPid(app), pid, "LaunchServices still reports the original instance");
    step("a second launch only activates the running app");

    process.kill(pid, "SIGUSR1");
    const mainTarget = await h.waitFor("the SIGUSR1 inspector", async () => (await h.targets(inspectorPort))[0], { timeoutMs: 10_000 });
    const main = await h.Cdp.connect(mainTarget.webSocketDebuggerUrl);
    const menu = await main.evaluate(`(() => {
      const { Menu } = process.mainModule.require("electron");
      const item = Menu.getApplicationMenu().getMenuItemById("t3ext-menu");
      return { top: Menu.getApplicationMenu().items.map((i) => i.label), sub: item && item.submenu.items.map((i) => i.label) };
    })()`);
    assert.ok(menu.top.includes("Extensions"), `application menu has Extensions; saw ${JSON.stringify(menu.top)}`);
    assert.deepEqual(menu.sub, ["Manage Extensions…", "Open Extensions Folder", "", "Reload Window"]);
    step(`application menu: ${JSON.stringify(menu.top)}; Extensions submenu ${JSON.stringify(menu.sub)}`);

    const clicked = await reachSettings(page);
    step(`reached Settings > General (onboarding clicks: ${JSON.stringify(clicked)})`);

    await main.evaluate(`process.mainModule.require("electron").Menu.getApplicationMenu().getMenuItemById("t3ext-menu").submenu.items[0].click()`);
    await evaluateUntil(page, "the manager modal", `document.querySelectorAll("[data-t3ext-manager] .t3ext-row").length === 2`);
    step("Extensions > Manage Extensions… opens the manager with 2 rows");
    await sleep(300);
    await h.screenshot(page, path.join(DOCS, "manager.png"));
    step("saved docs/manager.png");
    await page.evaluate(`document.querySelector("[data-t3ext-manager]").remove()`);
    await main.evaluate(`setImmediate(() => process.mainModule.require("node:inspector").close()), "closing"`);
    main.close();

    await evaluateUntil(page, "the settings nav item", `!!document.querySelector("[data-t3ext-nav]") && document.querySelector("[data-t3ext-nav]").textContent.trim() === "Extensions"`);
    const navClasses = await page.evaluate(`(() => {
      const ours = document.querySelector("[data-t3ext-nav] button").className;
      const native = [...document.querySelectorAll('[data-sidebar="menu-item"]:not([data-t3ext-nav]) button')].find((b) => b.textContent.trim() === "Appearance").className;
      return ours === native;
    })()`);
    assert.equal(navClasses, true, "nav item uses the same classes as T3's own items");
    await h.screenshot(page, path.join(DOCS, "settings-nav.png"));
    step("settings sidebar has a native-looking Extensions item; saved docs/settings-nav.png");
    await page.evaluate(`document.querySelector("[data-t3ext-nav] button").click()`);
    await evaluateUntil(page, "the manager from the nav item", `!!document.querySelector("[data-t3ext-manager]")`);
    step("clicking the nav item opens the manager");
    await page.evaluate(`document.querySelector("[data-t3ext-manager]").remove()`);
    await page.evaluate(`[...document.querySelectorAll('[data-sidebar="menu-item"] button')].find((b) => b.textContent.trim() === "Appearance").click()`);
    await evaluateUntil(page, "Settings > Appearance with the nav item", `location.hash.startsWith("#/settings/appearance") && !!document.querySelector("[data-t3ext-nav]")`);
    step("the nav item survives navigating to Settings > Appearance");

    await page.evaluate(`window.t3ext.setEnabled("sample", false)`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "extensions.json"), "utf8")), { disabled: ["sample"] });
    step("setEnabled('sample', false) persisted to extensions.json");
    await page.evaluate("location.reload()");
    await sleep(1000);
    await evaluateUntil(page, "the reloaded page with the manager", "document.readyState === 'complete' && window.__t3extManager === true");
    assert.equal(await page.evaluate("window.__t3extSample === undefined"), true, "sample renderer.js no longer runs");
    assert.equal(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--t3ext-sample").trim()`), "");
    step("after reload the disabled sample's renderer and style are gone, the manager still loads");

    page.close();
    console.log("# all e2e checks passed");
  } finally {
    const left = keep ? [] : await h.killUnder(dir);
    if (left.length) console.error(`# could not kill: ${left.join(", ")}`);
    if (!keep && left.length === 0) fs.rmSync(dir, { recursive: true, force: true });
    if (keep) console.log(`# kept running; clean up with: kill $(ps -axww -o pid=,comm= | grep -F '${dir}' | awk '{print $1}')`);
  }
}

main()
  .catch((error) => {
    console.error(`not ok - ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
