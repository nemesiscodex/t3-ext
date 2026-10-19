<img src="assets/icon.svg" width="64" height="64" alt="">

# t3-extensions

Load your own extensions into T3 Code on macOS without changing the T3 Code app.

You start T3 Code through a small launcher app, **T3 Code+**. The launcher starts the real T3 Code and loads an extension host into it. The host then loads every extension folder in `~/.t3/extensions`. Each extension can add CSS and JavaScript to the T3 window, and it can run code in T3's main process. An **Extensions** menu and an **Extensions** item in Settings let you turn extensions on or off, add them, and remove them.

![Extension manager](docs/manager.png)

## How it works

The launcher runs `open -a "T3 Code (Nightly)" --args --inspect-brk=127.0.0.1:<random port>`. T3 Code then starts paused, before its own code runs. The launcher connects to the Node inspector on that port and calls `require("<this repo>/host/index.cjs").start()` inside T3's main process. Then it lets T3 continue and closes the inspector.

The T3 Code bundle is never modified. We tried patching `app.asar` first. Any edit inside the bundle breaks its code signature, and macOS then refuses to open the app ("is damaged and can't be opened"). Re-signing the app ourselves is not an option either: the app uses entitlements and a provisioning profile tied to the T3 team. Without them, passkeys, keychain access and auto-update break. `NODE_OPTIONS=--require` is also rejected: Electron ignores most `NODE_OPTIONS` in packaged apps. The inspector route needs no bundle edit, so updates and the signature stay intact. It only needs the `EnableNodeCliInspectArguments` Electron fuse, which T3 Code ships turned on.

The launcher starts T3 through LaunchServices (`open`), not as its own child process. So T3 stays its own "responsible process" for macOS privacy prompts, and its existing microphone, camera and file permissions keep applying.

## Install

You need this repository checked out somewhere permanent. The launcher app refers to it by absolute path.

```sh
node bin/t3ext.cjs install-launcher
```

This builds `~/Applications/T3 Code+.app` with T3's icon, and signs it ad hoc. Add `--dry-run` to print the files without writing them. Use `--app <path>` for a T3 Code that is not at `/Applications/T3 Code (Nightly).app`.

From now on, open **T3 Code+** (from Spotlight, or pin it to the Dock) instead of T3 Code. If T3 Code is already running, T3 Code+ only brings it to the front. Quit T3 Code first to get extensions.

T3 Code+ runs the launcher with T3's own binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), so it does not depend on the Node.js in your shell. If that fails, it falls back to the `node` you ran `install-launcher` with. Launcher output goes to `~/Library/Logs/t3ext.log`. On failure you get a notification.

You can also launch from a terminal:

```sh
node bin/t3ext.cjs launch
```

## Write an extension

An extension is a folder in `~/.t3/extensions/<id>/`, or in `$T3CODE_HOME/extensions/` if you set `T3CODE_HOME`. The folder name is the extension id. Only `manifest.json` is required:

```json
{ "name": "My Extension", "version": "1.0.0", "description": "What it does" }
```

Add any of these optional files:

- `style.css` is inserted into every T3 Code window (`t3code://` pages only; never into web pages in the preview browser).
- `renderer.js` runs in every T3 Code window after the page has loaded its HTML, which can be before React has rendered. Use a `MutationObserver` to wait for elements. Errors are caught and logged with the extension id.
- `main.js` runs once in T3's main process, before T3's own code. If it exports a function, that function is called with `{ id, dir, electron }`. An error is caught and shown in the extension manager; T3 keeps running.

Style your UI with T3's CSS variables, such as `var(--background)`, `var(--foreground)`, `var(--border)` and `var(--primary)`, so it follows light and dark mode.

T3 Code windows have a `window.t3ext` object:

```js
await window.t3ext.list();                    // every extension, with enabled, parts and error
await window.t3ext.setEnabled("my-ext", false);
await window.t3ext.remove("my-ext");          // moves the folder to the Trash
await window.t3ext.add();                     // asks for a folder, then copies it in
await window.t3ext.openFolder("my-ext");      // or openFolder() for the extensions folder
```

Changes to `style.css` and `renderer.js` apply when you reload the window (**Extensions > Reload Window**). Changes to `main.js` apply when you restart T3 Code through T3 Code+.

Enabled state lives in `~/.t3/extensions.json` as `{ "disabled": ["id", ...] }`.

### Develop with a symlink

Keep your extension in its own repository and link it in:

```sh
ln -s ~/code/my-ext ~/.t3/extensions/my-ext
```

Edit, then reload the window. **Remove** in the manager moves only the link to the Trash, not your repository.

### The built-in extension manager

The manager is itself an extension, in `host/builtin/extension-manager`. You can disable it but not remove it. If you disable it, **Extensions > Manage Extensions…** offers to turn it back on. The settings item is added on a best-effort basis by matching T3's settings sidebar. If a T3 update changes that sidebar, the menu keeps working.

## Uninstall

Delete `~/Applications/T3 Code+.app`, and optionally `~/.t3/extensions` and `~/.t3/extensions.json`. T3 Code itself was never changed.

## Known limits

- Extensions load only when T3 Code starts through T3 Code+ or `t3ext launch`. When you start T3 Code from the Dock, Spotlight, Finder or a `t3code://` link, it runs without extensions. The same happens when T3 restarts itself after an auto-update. Quit and open T3 Code+ to get them back.
- During startup, the inspector listens on `127.0.0.1` for about a second. Another program running as your user could connect in that window. Such a program could already do worse things to your account.
- If the launcher crashes after starting T3 and before connecting, T3 stays paused with no window. Quit it and launch again. The log says what happened.
- If a T3 Code release turns off the `EnableNodeCliInspectArguments` fuse, the launcher cannot load the host. T3 then starts normally without extensions and the launcher reports the failure.
- The settings item depends on T3's sidebar markup (`ul[data-sidebar="menu"]` containing an "Appearance" item).

## Tests

```sh
npm test       # unit tests: registry, CLI, launcher app, launch race (starts a fake app)
npm run e2e    # clones the installed app into a temp dir and drives it over CDP
```

The end-to-end test never touches the installed app. It makes an APFS clone of the app and builds T3 Code+ into a temp directory. It opens the clone through that T3 Code+, isolated with its own `HOME` and `T3CODE_HOME`, and checks the sample extension in `test/fixtures/sample`, the menu, the manager and the settings item. When it finishes, it kills every process running from the temp directory.
