# Hide Offline Threads

When a linked environment is not connected, for example a machine that is turned off, its threads leave the sidebar's inbox until it connects again. Its snoozed and settled threads stay where they are.

## What it does

- A thread row is hidden when its environment is disconnected and the row is not in the Snoozed or Settled shelf. Pinned, active and working rows all count as the inbox.
- The thread you have open stays, so it never vanishes from under you. It hides once you open another one.
- When the environment connects again, its rows come back in place.
- An environment that is connecting for the first time, with no failed attempt yet, counts as connected, so rows do not flicker away while T3 Code starts.
- The arrow keys skip hidden rows, as they skip any row T3 hides.

Nothing else changes. Threads of connected environments, and of environments T3 does not list, show as before.

## How it finds what it needs

**Which environments are connected** comes from `ext.t3.environments.get()`. `host/page.js` reads it from T3's own state: T3 keeps it in an effect atom registry, which a React context provider (`AppAtomRegistryProvider` in T3's `apps/web/src/AppRoot.tsx`) hands to the whole app. `page.js` walks up the React fibers from the app's first element to that provider, finds the atom labelled `environment-presentations` among the registry's nodes, and reads its Map of each environment to `{ entry, connection: { phase } }`. It counts the phases T3 itself calls disconnected (`connectionProjectionPhase` in client-runtime's `connection/model.ts`): `available`, `offline`, `reconnecting`, `error` and `unsupported`. A phase T3 adds later counts as connected. `ext.t3.environments.subscribe` hears every change to that atom, an environment linked later included.

**Which shelf a row is in** comes from `ext.t3.rowOf(element).shelf`. T3 gives each row's `[data-sidebar-row]` element a `data-sidebar-parent` for its arrow keys, `shelf:snoozed` or `shelf:settled` in those shelves. T3 sorts a thread into a shelf only once it has the environment's settings, so until then a snoozed or settled thread of a disconnected environment shows in the inbox, and is hidden there.

**Rows are hidden with the `hidden` attribute** on the row's `<li>`, which T3's arrow keys skip. The extension marks each row it hides with `data-hide-offline-threads`, and shows again only rows it marked, never one T3 hid. It checks again after each change to the sidebar's rows, a row's shelf included, after each change to an environment, and when the open thread changes.

**When T3 changes,** check these first: the `environment-presentations` label and its value's `connection.phase`; the phases in `presentConnectionState` (client-runtime's `connection/presentation.ts`); the context provider's `value`, with `getNodes`, `get` and `subscribe`; and `data-sidebar-parent` on thread rows (`SidebarThreadRow.tsx`). If the environments cannot be read, the extension logs it once and shows every row.

## Known limits

- With [Thread Tree](../thread-tree), a parent copy row stays when every thread under it is hidden.

## Try it

From the root of this repository:

```sh
mkdir -p ~/.t3/extensions && ln -s "$PWD/examples/hide-offline-threads" ~/.t3/extensions/hide-offline-threads
```

Then choose **Extensions > Reload Window**. In DevTools, `window.t3HideOfflineThreads.disconnected` lists the disconnected environments' ids, and `window.t3HideOfflineThreads.hidden` the rows it hid.
