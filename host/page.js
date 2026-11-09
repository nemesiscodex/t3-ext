// Runs in each T3 Code window before any extension's renderer.js, and gives each one its `ext`.
// The host injects it on every page load, so a change here applies on Reload Window, like a
// renderer.js. It knows T3's page structure and React internals so extensions don't have to:
// when a T3 release moves something, this is the one place to fix.
(() => {
  const KEY = Symbol.for("t3ext.page");
  if (window[KEY]) return;

  const MANAGER_ID = "builtin:extension-manager";
  const api = window.t3ext;

  const safely = (label, fn) => (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      console.error("[t3ext]", label, error);
    }
  };

  // --- Config -----------------------------------------------------------------------------------

  // The host sends every extension's config changes to every window, the writer's included.
  // Here each extension hears only its own, and each distinct value once.
  function configOf(id) {
    let text; // JSON of the last value seen; undefined before the first
    let value = null;
    let loaded = null;
    let writes = Promise.resolve();
    const listeners = new Set();
    const accept = (next) => {
      const nextText = JSON.stringify(next ?? null);
      if (nextText !== text) {
        text = nextText;
        value = next ?? null;
        for (const listener of listeners) listener();
      }
      return value;
    };
    const load = () => {
      if (!loaded) {
        api.onConfigChange((changed, next) => changed === id && accept(next));
        loaded = api.getConfig(id).then(accept, (error) => {
          console.error("[t3ext]", id, "could not read config", error);
          return accept(null);
        });
      }
      return loaded;
    };
    return {
      get: () => load().then(() => value),
      // Writes run one after another, each on the value the previous one saved.
      update(change) {
        const result = writes.then(load).then(() => api.setConfig(id, change(value))).then(accept);
        writes = result.catch(() => {});
        return result;
      },
      subscribe(fn) {
        let seen;
        const listener = safely(`${id} config listener`, () => {
          if (seen === text) return;
          seen = text;
          fn(value);
        });
        listeners.add(listener);
        load().then(() => listeners.has(listener) && listener());
        return () => listeners.delete(listener);
      },
    };
  }

  // --- Settings panels --------------------------------------------------------------------------

  const panels = new Map();
  let openManager = null; // set by the extension manager

  function settingsOf(id) {
    return {
      register(render) {
        panels.set(id, render);
        return () => panels.get(id) === render && panels.delete(id);
      },
      canOpen: () => openManager !== null,
      open() {
        openManager?.(id);
        return openManager !== null;
      },
    };
  }

  const manager = {
    panelOf: (id) => panels.get(id) ?? null,
    serve(open) {
      openManager = open;
    },
  };

  // --- Reading T3's sidebar ---------------------------------------------------------------------

  const FILTER_BUTTON = 'button[data-slot="combobox-trigger"][aria-label^="Filter threads by project"]';
  const THREAD_ROW = "[data-thread-item]";

  // A DOM node can still point at the fiber of the previous render, whose props are stale. The
  // one whose root is the root's `current` is the live one.
  function fiberOf(node) {
    const key = node && Object.keys(node).find((name) => name.startsWith("__reactFiber$"));
    const fiber = key && node[key];
    if (!fiber) return null;
    let top = fiber;
    while (top.return) top = top.return;
    return top.stateNode?.current === top ? fiber : (fiber.alternate ?? fiber);
  }

  function* ancestors(node, limit) {
    for (let fiber = fiberOf(node), i = 0; fiber && i < limit; fiber = fiber.return, i++) yield fiber;
  }

  // One physical project, as a sidebar project lists it among its members or a thread row shows it.
  const memberOf = (project) =>
    project
      ? {
          title: project.title ?? null,
          workspaceRoot: project.workspaceRoot ?? null,
          repository: project.repositoryIdentity
            ? { key: project.repositoryIdentity.canonicalKey ?? null, name: project.repositoryIdentity.displayName ?? null }
            : null,
        }
      : null;

  // The sidebar's memoized project catalog, found from T3's project filter button. Null unless
  // every project has its members, so a rename in T3 reads as "not found", never as no projects.
  const isCatalog = (value) =>
    Array.isArray(value?.projectGroups) &&
    Array.isArray(value.projectScopeItems) &&
    value.projectGroups.every((group) => Array.isArray(group?.memberProjects) && Array.isArray(group.memberProjectRefs));

  function catalog() {
    for (const fiber of ancestors(document.querySelector(FILTER_BUTTON), 80)) {
      for (const cached of fiber.updateQueue?.memoCache?.data ?? []) {
        for (const value of Array.isArray(cached) ? cached : []) {
          if (isCatalog(value)) return value;
        }
      }
    }
    return null;
  }

  function projects() {
    return (
      catalog()?.projectGroups.map((group) => ({
        key: group.projectKey,
        name: group.displayName,
        icon: group.projectIcon ?? null,
        environmentId: group.environmentId,
        workspaceRoot: group.workspaceRoot,
        faviconPath: group.faviconPath || null,
        refs: group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
        members: group.memberProjects.map(memberOf),
      })) ?? null
    );
  }

  // T3 keeps its filter in a zustand store as `sidebarProjectScopeKeys`: project keys, [] for all.
  // zustand's hook passes [store, selector] as a useCallback's deps, so the store is in the hooks
  // of the sidebar component that reads it.
  function scopeStoreOf(fiber) {
    for (let hook = fiber.memoizedState; hook && typeof hook === "object" && "next" in hook; hook = hook.next) {
      const deps = Array.isArray(hook.memoizedState) ? hook.memoizedState[1] : null;
      const store = Array.isArray(deps) ? deps[0] : null;
      if (typeof store?.getState === "function" && typeof store.getState()?.setSidebarProjectScopeKeys === "function") return store;
    }
    return null;
  }

  // T3's handler reads the details Base UI passes as the second argument (a shift-click adds a
  // project instead of replacing the selection), so pass those of a plain click.
  const changeDetails = () => ({ reason: "item-press", event: new Event("base-ui"), cancel() {}, isCanceled: false });

  function projectFilter() {
    let combobox = null;
    let store = null;
    for (const fiber of ancestors(document.querySelector(FILTER_BUTTON), 80)) {
      const props = fiber.memoizedProps;
      if (!combobox && Array.isArray(props?.items) && typeof props.onValueChange === "function") combobox = props;
      store ??= scopeStoreOf(fiber);
      if (combobox && store) break;
    }
    if (!combobox || !store) return null;
    return {
      keys: () => [...store.getState().sidebarProjectScopeKeys],
      // T3's own handler first, as if the first project were picked in its menu: it also clears
      // T3's thread selection and scrolls the list to the top. Then the whole set, which that
      // handler can only build one shift-click and one render at a time.
      set(keys) {
        const first = combobox.items.find((item) => item.value === (keys[0] ?? "all"));
        if (first) combobox.onValueChange(first, changeDetails());
        store.getState().setSidebarProjectScopeKeys(keys);
      },
    };
  }

  // A row's data-thread-item is "<environmentId>:<threadId>", and a thread id can hold colons
  // itself ("mcp:<uuid>").
  function rowOf(node) {
    const element = node instanceof Element ? node.closest(THREAD_ROW) : null;
    if (!element) return null;
    const item = element.getAttribute("data-thread-item");
    const at = item.indexOf(":");
    return { element, environmentId: at < 0 ? "" : item.slice(0, at), threadId: item.slice(at + 1) };
  }

  // Sidebar rows in page order, or only those of one thread. A thread can have more than one.
  const threadRows = (threadId) =>
    [...document.querySelectorAll(THREAD_ROW)].map(rowOf).filter((row) => threadId === undefined || row.threadId === threadId);

  // What a sidebar row renders from: { thread, project, wokeAt }. Null when T3 renamed `thread`;
  // `project` or `wokeAt` is left out when T3 renamed that one.
  function rowData(element) {
    const found = { thread: null };
    for (const fiber of ancestors(element, 12)) {
      const props = fiber.memoizedProps;
      if (!props?.thread?.id) continue;
      found.thread ??= props.thread;
      if (!("project" in found) && "project" in props) found.project = memberOf(props.project);
      if (!("wokeAt" in found) && "wokeAt" in props) found.wokeAt = props.wokeAt ?? null;
    }
    return found.thread ? found : null;
  }

  // "#/<environmentId>/<threadId>"
  function openThread() {
    const match = location.hash.match(/^#\/([^/?]+)\/([^/?]+)/);
    if (!match) return null;
    const decode = (part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    };
    return { environmentId: decode(match[1]), threadId: decode(match[2]) };
  }

  // --- T3's thread updates ----------------------------------------------------------------------

  // The server pushes a `thread.updated` message with the whole thread shell after every change.
  // When T3 subscribes again after a reconnect, the server replays what changed while it was away
  // until `{kind: "synchronized"}`; those arrive with `live: false`. The first subscription goes
  // out before any extension loads. Snapshots are not a replay marker: the server also sends one
  // whenever a project's repository details refresh.
  const shells = new Map();
  const threadListeners = new Set();
  const replaying = new Set();
  let hooked = false;

  const emit = (event) => threadListeners.forEach((listener) => listener(event));
  const SUBSCRIBE = /^orchestration\.subscribe(Archived)?Shell$/;
  const COMMANDS = ["thread.settle", "thread.snooze", "thread.unsnooze"];
  const SENT = /"type":"thread\.(settle|snooze|unsnooze)"|"tag":"orchestration\.subscribe(Archived)?Shell"/;
  const FRAME = /"kind":"(thread\.|synchronized"|snapshot")/;

  const onSend = safely("thread hook", (text) => {
    for (const message of [JSON.parse(text)].flat()) {
      if (SUBSCRIBE.test(message?.tag ?? "")) replaying.add(String(message.id));
      const command = message?.payload;
      if (COMMANDS.includes(command?.type)) emit({ kind: "command", command });
    }
  });

  const onFrame = safely("thread hook", (text) => {
    for (const message of [JSON.parse(text)].flat()) {
      if (!Array.isArray(message?.values)) continue;
      const requestId = String(message.requestId);
      for (const value of message.values) {
        if (value?.kind === "synchronized") replaying.delete(requestId);
        else if (value?.kind === "thread.updated" && value.thread?.id) {
          shells.set(value.thread.id, value.thread);
          emit({ kind: "updated", shell: value.thread, live: !replaying.has(requestId) });
        } else if (value?.kind === "thread.removed") {
          shells.delete(value.threadId);
          emit({ kind: "removed", threadId: value.threadId });
        } else if (value?.kind === "snapshot" && Array.isArray(value.snapshot?.threads)) {
          for (const shell of value.snapshot.threads) if (shell?.id) shells.set(shell.id, shell);
          emit({ kind: "snapshot" });
        }
      }
    }
  });

  // Commands are read before they are sent, and pushes before T3 handles them. The socket opened
  // before any extension ran, so both hooks sit on prototypes. They run inside T3's own code, so
  // they never throw.
  function hook() {
    if (hooked) return;
    hooked = true;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (payload) {
      if (typeof payload === "string" && SENT.test(payload)) onSend(payload);
      return send.call(this, payload);
    };
    const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
    const inspected = new WeakSet();
    Object.defineProperty(MessageEvent.prototype, "data", {
      ...data,
      get() {
        const value = data.get.call(this);
        if (typeof value === "string" && !inspected.has(this) && this.target instanceof WebSocket) {
          inspected.add(this);
          if (FRAME.test(value)) onFrame(value);
        }
        return value;
      },
    });
  }

  const ACTIVE_RUN = ["preparing", "queued", "starting", "running", "waiting"];
  const isSubagent = (shell) => shell?.lineage?.relationshipToParent === "subagent";

  // T3's own reading of a raw shell: shellRuntime and presentThreadShell in client-runtime's
  // models.ts, resolveSidebarThreadStatus in Sidebar.logic.ts, subagentRequest in threadShell.ts.
  function runtimeOf(shell) {
    const parked = (shell.pendingBackgroundTasks ?? []).some((task) => task.kind !== "command") && shell.status !== "failed";
    if (shell.latestRunId === null && shell.activeProviderThreadId === null && !parked) return null;
    return parked ? "idle" : (shell.activityRunStatus ?? shell.status);
  }

  // "approval", "input", or null when the pending request waits on nobody: a question the run
  // keeps working past, or a subagent's after its run ended. A provider's own subagents ask on
  // the parent's shell.
  function asks(shell) {
    const request = shell.pendingRuntimeRequest;
    if (!request || request.kind === "auth_refresh") return null;
    const kind = request.kind === "user_input" ? "input" : "approval";
    if (isSubagent(shell)) {
      const live = shell.activityRunStatus !== undefined ? shell.activityRunStatus !== null : ACTIVE_RUN.includes(shell.status);
      return shell.creationSource !== "provider" && live ? kind : null;
    }
    if (kind === "input" && request.blocking === false && ["preparing", "starting", "running"].includes(runtimeOf(shell))) return null;
    return kind;
  }

  // "needs-you", "waiting" (on another thread), "working", "idle", "failed" or "ready".
  function status(shell) {
    if (asks(shell)) return "needs-you";
    const runtime = runtimeOf(shell);
    if (runtime === "running" && shell.blockedOnThreadWait) return "waiting";
    if (ACTIVE_RUN.includes(runtime)) return "working";
    return runtime === "idle" || runtime === "failed" ? runtime : "ready";
  }

  // A subagent's question shows on the row of its first ancestor that is not a subagent.
  function owner(shell) {
    let id = shell.id;
    for (let at = shell, i = 0; isSubagent(at) && i < 20; i++) {
      id = at.lineage.parentThreadId ?? id;
      at = shells.get(id);
    }
    return id;
  }

  // What a thread's sidebar row says, its subagents' questions included. Null before T3 has
  // sent anything about the thread since the page loaded.
  function rowStatus(threadId) {
    const shell = shells.get(threadId);
    if (!shell) return null;
    for (const other of shells.values()) {
      if (other !== shell && isSubagent(other) && asks(other) && owner(other) === threadId) return "needs-you";
    }
    return status(shell);
  }

  function threadsOf(id) {
    return {
      // listener({ kind: "updated", shell, live }), ({ kind: "removed", threadId }),
      // ({ kind: "command", command }) for a settle, snooze or unsnooze this window is about to
      // send, or ({ kind: "snapshot" }) after a snapshot filled in get().
      subscribe(listener) {
        hook();
        const wrapped = safely(`${id} thread listener`, listener);
        threadListeners.add(wrapped);
        return () => threadListeners.delete(wrapped);
      },
      get: (threadId) => shells.get(threadId) ?? null,
      status,
      rowStatus,
      asks,
      owner,
      isSubagent,
    };
  }

  // --- Page UI ----------------------------------------------------------------------------------

  const SVG_NS = "http://www.w3.org/2000/svg";
  const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])";

  // Props: `className`, `onX` listeners, and attributes; null and false are skipped.
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === false || value == null) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "className") node.className = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    node.append(...children.flat().filter((child) => child != null && child !== false));
    return node;
  }

  // A lucide icon from its node list: [["path", { d: "…" }], …].
  function icon(nodes, className) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const attributes = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
    if (className) attributes.class = className;
    for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
    for (const [tag, partAttributes] of nodes ?? []) {
      const part = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(partAttributes)) part.setAttribute(key, value);
      svg.append(part);
    }
    return svg;
  }

  // T3 handles keys on window in the capture phase and swallows some of them. This listener is
  // added before any extension's and T3's own, so the newest open layer gets each key first.
  const layers = [];
  addEventListener(
    "keydown",
    (event) => {
      for (const handle of [...layers].reverse()) if (handle(event)) return;
    },
    true,
  );

  // Puts `element` on the page as a popup over T3. `onKey` sees each key first, and a key it
  // calls preventDefault on goes no further. Unless `isolate` is false, no key pressed inside the
  // layer reaches T3 or other extensions. Escape closes it. A modal layer gets keys even with
  // focus behind it and keeps Tab inside; any other layer closes on a click outside it and its
  // anchor. close(true) returns focus to `returnTo`: the anchor, or what had focus when it opened.
  function layer(element, { anchor = null, returnTo = anchor ?? document.activeElement, modal = false, isolate = true, place = null, onKey = null, onClose = null } = {}) {
    let open = true;

    function close(returnFocus = false) {
      if (!open) return;
      open = false;
      layers.splice(layers.indexOf(handle), 1);
      removeEventListener("pointerdown", onPointerDown, true);
      removeEventListener("resize", onResize);
      element.remove();
      anchor?.setAttribute("aria-expanded", "false");
      onClose?.();
      if (returnFocus && returnTo?.isConnected) returnTo.focus();
    }

    function trapTab(event) {
      const focusable = [...element.querySelectorAll(FOCUSABLE)].filter((node) => !node.closest("[hidden]"));
      if (!focusable.length) return;
      const active = document.activeElement;
      const at = focusable.indexOf(active);
      const lost = at === -1 && (!element.contains(active) || active.tabIndex < 0);
      if (lost || at === (event.shiftKey ? 0 : focusable.length - 1)) {
        event.preventDefault();
        focusable.at(event.shiftKey ? -1 : 0).focus();
      }
    }

    // True when the layer takes the key, so older layers do not see it.
    const handle = safely("layer keys", (event) => {
      const inside = element.contains(event.target);
      if (!inside && !modal) return false;
      if (inside && isolate) event.stopImmediatePropagation();
      const prevented = event.defaultPrevented;
      onKey?.(event);
      const handled = event.defaultPrevented && !prevented;
      if (!handled && event.key === "Escape") {
        event.preventDefault();
        close(true);
      } else if (!handled && modal && event.key === "Tab") trapTab(event);
      if (event.defaultPrevented && !prevented) event.stopImmediatePropagation();
      return true;
    });
    const onPointerDown = (event) => {
      if (!element.contains(event.target) && !anchor?.contains(event.target)) close(false);
    };
    const onResize = () => place?.(element);

    document.body.append(element);
    place?.(element);
    anchor?.setAttribute("aria-expanded", "true");
    layers.push(handle);
    if (!modal) addEventListener("pointerdown", onPointerDown, true);
    addEventListener("resize", onResize);
    return { element, close, get open() { return open; } };
  }

  // --- Running each renderer.js -----------------------------------------------------------------

  const t3 = { filterButton: () => document.querySelector(FILTER_BUTTON), projects, projectFilter, threadRows, rowOf, rowData, openThread, fiberOf };
  const ui = { el, icon, layer };
  const ran = new Set();

  // Each extension runs once per page. A throw is returned, so the host shows it in the manager.
  function run(id, body) {
    if (ran.has(id)) return null;
    ran.add(id);
    const ext = { config: configOf(id), settings: settingsOf(id), t3: { ...t3, threads: threadsOf(id) }, ui };
    if (id === MANAGER_ID) ext.manager = manager;
    try {
      body(id, ext);
      return null;
    } catch (error) {
      console.error("[t3ext]", id, error);
      return String(error?.message ?? error);
    }
  }

  Object.defineProperty(window, KEY, {
    value: Object.freeze({ run, ran: (id) => ran.has(id), openManager: () => openManager?.() }),
  });
})();
