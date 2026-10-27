# Internals

This page is for people who want to change the launcher or the host, or who want to know exactly what happens to T3 Code. The [README](../README.md) has the short version.

## What `launch` and `attach` do

`t3ext launch` (what T3 Code+ runs) and `t3ext attach` first check which of these states T3 Code is in, and act on it:

| T3 Code is | `launch` | `attach` |
| --- | --- | --- |
| not running | starts it with `--inspect-brk` and loads the host before T3's own code | does nothing (with `--wait <ms>`, first waits that long for T3 to start) |
| still starting | waits until macOS reports it finished launching, then checks again | same |
| running without the host | sends `SIGUSR1`, loads the host over the inspector on port 9229, then brings T3 to the front | the same, but never brings T3 to the front |
| running with the host | brings it to the front | does nothing |

Both commands hold a per-app lock while they act, so two launches at once start or attach only once. `launch` brings T3 Code to the front whenever it is running when `launch` ends, even after a failure.

## Starting T3 Code

The launcher runs `open -a "<T3 Code app>" --args --inspect-brk=127.0.0.1:<random port>`. T3 Code then starts paused, before its own code runs. The launcher connects to the Node inspector on that port and calls `require("<this repo>/host/index.cjs").start()` inside T3's main process. Then it lets T3 continue and closes the inspector.

The launcher starts T3 through LaunchServices (`open`), not as its own child process. So T3 stays its own "responsible process" for macOS privacy prompts, and its existing microphone, camera and file permissions keep applying.

## What was tried first

- **Patching `app.asar`.** Any edit inside the bundle breaks its code signature, and macOS then refuses to open the app ("is damaged and can't be opened").
- **Re-signing the patched app.** The app uses entitlements and a provisioning profile tied to the T3 team. Without them, passkeys, keychain access and auto-update break.
- **`NODE_OPTIONS=--require`.** Electron ignores most `NODE_OPTIONS` in packaged apps.

The inspector route needs no bundle edit, so updates and the signature stay intact.

## Attaching to a running T3 Code

T3 Code also starts without the launcher, from the Dock, Spotlight or a `t3code://` link, and when it restarts itself after an auto-update. For these, `t3ext attach` waits until macOS reports that T3 finished launching, because a `SIGUSR1` that arrives before Node installs its handler quits T3. Then it sends `SIGUSR1` to T3's main process. Node opens its inspector on `127.0.0.1:9229`. The launcher checks that the inspector belongs to that pid, calls `require("<this repo>/host/index.cjs").start()` through `Runtime.evaluate`, and closes the inspector again. The host then:

- reloads every open T3 Code window, so the preload adds `window.t3ext` and each extension's `style.css` and `renderer.js` load;
- sets T3's current application menu again, so the **Extensions** menu appears;
- runs the `main.js` of each enabled extension.

Attaching late has costs. Each open window reloads once. `main.js` runs after T3's own startup, not before it. The port is always 9229, because Node offers no other port for `SIGUSR1`. The inspector listens on it for about a second. If another program holds port 9229, attach stops with a message that names the program, and T3 keeps running without extensions.

## Knowing whether the host is loaded

Starting the host a second time does nothing, and the launcher checks for the host before it signals. The host listens on a Unix socket named after T3's pid (`t3ext-host-<pid>.sock` in your user temp folder) and answers with that pid. Only a live process can answer, so a socket left behind by a crashed T3 whose pid a new T3 reuses reads as "no host".

## The fuse

Both routes need the `EnableNodeCliInspectArguments` [Electron fuse](https://www.electronjs.org/docs/latest/tutorial/fuses), which T3 Code ships turned on. It is the one thing a T3 Code update could take away. `launch` and `attach` read the fuse from the app's Electron Framework binary first. If it is off, they stop with a message that says so. Neither `--inspect-brk` nor `SIGUSR1` would open the inspector then, and a `SIGUSR1` that T3 does not handle quits it. `launch` then opens T3 Code normally, without extensions. `t3ext status` shows the fuse.

## What the host does inside T3

`host/index.cjs` runs in T3's main process and uses ordinary Electron APIs:

- registers `host/preload.cjs` on the default session, which exposes `window.t3ext` to `t3code://` pages;
- inserts each enabled extension's `style.css` with `webContents.insertCSS` and runs its `renderer.js` with `executeJavaScript`, in every T3 window, each time its page reaches `dom-ready`. Each `renderer.js` runs inside a function whose `extensionId` argument is its folder name;
- wraps `Menu.setApplicationMenu` so every menu T3 sets gets an **Extensions** menu;
- answers the `t3ext:*` IPC calls behind `window.t3ext`, and refuses them from any page that is not `t3code://`;
- after a `t3ext:setConfig`, sends `t3ext:config` with the id and the saved value to every `t3code://` page, the sender included. The preload passes it on to `onConfigChange` listeners without the IPC event;
- `require`s each enabled extension's `main.js`.

`host/registry.cjs` reads the extension folders and `~/.t3/extensions.json`, which holds `{ "disabled": [ids], "config": { id: value } }`. A file that is missing or not JSON reads as nothing disabled and no config. Every write keeps both keys, and removing an extension drops its id from both. The built-in extension manager in `host/builtin/extension-manager` is an ordinary extension that uses `window.t3ext`. Settings panels register in the page's `window.t3extSettings` map, not on `window.t3ext`, because the context bridge freezes that object.

## The launcher app

`t3ext install-launcher` builds `~/Applications/T3 Code+.app` with T3's icon, and signs it ad hoc. It refers to this repository by absolute path, so keep the checkout where it is.

T3 Code+ runs the launcher with T3's own binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), so it does not depend on the Node.js in your shell. If that fails, it falls back to the `node` you ran `install-launcher` with. Launcher output goes to `~/Library/Logs/t3ext.log`. On failure you get a notification.

## The LaunchAgent

`t3ext install-agent` writes `~/Library/LaunchAgents/dev.t3ext.reattach.plist` and loads it with `launchctl bootstrap gui/$UID`. The agent watches T3's `Contents/Info.plist`, which an update replaces. When the file changes, the agent runs `t3ext attach --wait 120000`. That waits up to two minutes for T3 to start again, then attaches. Within those two minutes it also keeps waiting if T3 quits and starts again, and retries while the update is still replacing files. If T3 does not start in that time (for example, it updated while closed), the agent exits quietly. It never brings T3 to the front, and it does nothing when the host is already loaded.

It runs on T3's own binary as Node, like T3 Code+. While an update is still replacing the app, it retries for about 30 seconds, then uses the `node` you ran `install-agent` with. Both first read T3's `RunAsNode` fuse with that `node`: with the fuse off, T3's binary would start the T3 app instead of Node, so they skip it. Output goes to `~/Library/Logs/t3ext.log`. You get a notification only when attaching fails.

The tests check the plist and run the agent's command by hand. A real launchd trigger on a real update has not been tested. The agent does not react to a start from the Dock, Spotlight or a link.

## Source map

| Path | What it does |
| --- | --- |
| `bin/t3ext.cjs` | The command line: argument parsing and `status` |
| `src/launcher.cjs` | `launch` and `attach`: app state, lock, `open`, `SIGUSR1` |
| `src/cdp.cjs` | A small Chrome DevTools Protocol client for the Node inspector |
| `src/fuses.cjs` | Reads Electron fuses from the app's framework binary |
| `src/launcher-app.cjs` | Builds T3 Code+.app |
| `src/agent.cjs` | Writes, loads and removes the LaunchAgent |
| `src/pick-node.cjs` | Chooses T3's binary or your `node` to run the launcher |
| `host/index.cjs` | The extension host that runs inside T3 |
| `host/registry.cjs` | Extension folders, enabled state and config |
| `host/presence.cjs` | The per-pid socket that tells the launcher the host is loaded |
| `host/preload.cjs` | Exposes `window.t3ext` |

## Tests

```sh
npm test       # unit tests: registry, CLI, LaunchAgent plist, fuse reader, host presence, launch race (starts a fake app)
npm run e2e    # clones the installed app into a temp dir and drives it over CDP: test/e2e.cjs, then test/e2e-attach.cjs
```

The end-to-end tests never touch the installed app. Each makes an APFS clone of the app in a temp directory, isolated with its own `HOME` and `T3CODE_HOME`. `test/e2e.cjs` opens the clone through a T3 Code+ built in the temp directory, and checks the sample extension in `test/fixtures/sample`, the menu, the manager and the settings item. `test/e2e-attach.cjs` opens the clone without the launcher, then checks `attach` (including with port 9229 taken), a second `attach`, `launch`, `status`, and the LaunchAgent's command waiting for the clone to start. When they finish, they kill every process running from the temp directory. `test/e2e.cjs` rewrites `docs/*.png`.
