# Workspace Default

Choose where a project's new threads start, Current checkout or New worktree, right from the composer's Workspace menu. You no longer need to open Settings, find the project and change its Workspace setting there.

## What it does

- Each choice in the Workspace menu gets a pin. It shows when the pointer or keyboard is on that row.
- Click the pin to make that choice the project's default for new threads. The row then shows **Default** with a filled pin.
- Click **Default** again to remove the project's own default. New threads then follow the default for every project again.
- If the project has no default of its own, but the environment has one for every project (Settings > Projects, All projects), that row shows **Default** with an empty pin. Click it to make it this project's own default.
- The pin only changes the default. The thread you are writing keeps the choice you made, and the menu stays open so you can see the change. Click the row itself to pick it for this thread, as before.
- The change is the same one Settings makes, so Settings > Projects shows it, and other windows and devices get it from the server.

The menu appears only in a new thread. A thread that has already started keeps its workspace, and T3 shows no menu there.

## How it finds what it needs

**The menu** is the composer's Workspace control, `[data-composer-shortcut="composer.workspace"]` (`BranchToolbarEnvModeSelector.tsx` in T3's web app). Its menu is open while the control has `aria-expanded="true"`. Its rows are `[data-slot="select-item"]` elements, and each row's mode is the `value` prop of its Base UI `SelectItem`, `"local"` or `"worktree"`, read from React's fibers. The Previous worktree row has no pin, because it is not a default.

**The project** comes from the `projectId` and `environmentId` props of `BranchToolbar`, found by walking up the control's fibers. Its name comes from `ext.t3.projects()`.

**The setting** is `projectSettingsOverrides[projectId].defaultThreadEnvMode` in the environment's server settings. Settings > Projects writes the same key (`planScopedSettingsPatch` in T3's `scopedSettings.ts`). The extension reads the settings with the `server.getSettings` RPC and saves them with `server.updateSettings`, both through `ext.t3.request`. T3's own app no longer calls `server.getSettings`, so if a server drops it, the extension reads the same settings from the much larger `server.getConfig`. A patch replaces the project's whole override entry, so the extension first reads the entry again and changes only `defaultThreadEnvMode`. When nothing is left in the entry, it sends `null`, which removes the entry.

**The pin's clicks** stop at the button. Base UI picks a row on pointer and mouse events, so none of them reach the row.

**When T3 changes,** check these first: the `data-composer-shortcut` of the Workspace control, the `projectId` and `environmentId` props of `BranchToolbar`, the `projectSettingsOverrides` key in `ServerSettings`, and the `server.getSettings`, `server.getConfig` and `server.updateSettings` RPCs (`WS_METHODS` in T3's `contracts/src/rpc.ts`). If the extension cannot read or save the settings, the pin turns red and its tooltip gives the error. Click it to try again: after a failed save, the click saves the same choice again.

## Known limits

- The pin has no keyboard shortcut. Arrow keys still move through the rows, and Enter still picks one.
- Only a project's own default and its environment's default for every project are shown. When neither is set, T3 can still choose a mode by itself, from the project's `t3.json` or from whether the project has threads yet, and no row shows **Default**.
- In a project that spans several environments, the pin changes the default on the environment of the thread you are writing.

## Try it

From the root of this repository:

```sh
mkdir -p ~/.t3/extensions && ln -s "$PWD/examples/workspace-default" ~/.t3/extensions/workspace-default
```

This extension uses `ext.t3.request`, which came with this version of the host. If your T3 Code was opened through T3 Code+ before you updated this checkout, choose **Extensions > Reload Window**. In DevTools, `window.t3WorkspaceDefault.states` shows what the extension read for each project.
