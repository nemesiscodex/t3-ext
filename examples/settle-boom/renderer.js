if (!window.t3SettleBoom) {
  // Effect Institute's look: off-white ink on black, a dot grid, thin rings, glitch glyphs, and
  // the occasional "small greenish square". The sounds follow its Tone.js voices.
  const INK = "241, 239, 232";
  const GREEN = "134, 239, 172";
  const WHITE = "255, 255, 255";
  const SLATE = "71, 85, 105";
  const GLYPHS = "@#$%&*/=-+?!~<>\\|█▓▒░";
  const PENTATONIC = ["C", "D", "E", "G", "A"];
  const CHARGE = 420;
  const MUTED_KEY = "t3ext.settle-boom.muted";
  const OFF_KEY = "t3ext.settle-boom.off";
  const ROW = "[data-thread-item]";
  const SURFACE = '[data-testid^="sidebar-row-"]';
  const CARD = '[data-testid="sidebar-row-card"]';
  const WOKE = '[aria-label="Dismiss Woke notification"]';
  const HOLD_MS = CHARGE + 1350;
  const CALM_HOLD_MS = 500;
  const FRESH_MS = 30_000;
  const PLAYED_MS = 5_000;
  const BURST_MS = 1_000;
  const ARRIVE_MS = 2_000;
  const THROTTLE_MS = 400;
  const CHORD_MS = 100;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (text) => text[Math.floor(Math.random() * text.length)];
  const clamp01 = (value) => Math.min(1, Math.max(0, value));
  const easeOutExpo = (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p));
  const easeOutCubic = (p) => 1 - (1 - p) ** 3;
  const easeInCubic = (p) => p ** 3;
  const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace";

  const guard = (fn) => (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      console.error("[settle-boom]", error);
    }
  };

  // --- The effects -----------------------------------------------------------------------------

  // Each change a thread goes through, and how it plays. `placement` is where: on a copy of the
  // row that is leaving ("ghost"), on the live row ("row"), or on the row once it has moved into
  // Active ("arrival"). `rank` decides which of several changes on one thread within a second
  // plays; snooze stands alone. `dedupe` is how long a change reported by several sources (the
  // command, the server's push, the sidebar) counts as the same one. `keep` is how long a ghost
  // keeps the row's place in the sidebar once T3 has moved it.
  const EFFECTS = {
    settle: {
      placement: "ghost",
      rank: 4,
      dedupe: HOLD_MS + PLAYED_MS,
      keep: (calm) => (calm ? CALM_HOLD_MS : HOLD_MS),
      duration: 1800,
      label: () => ({ word: "SETTLED", square: "--success", at: "burst", from: 120 }),
      setup: settleSetup,
      draw: drawSettle,
      voice: settleVoice,
    },
    wait: {
      placement: "row",
      rank: 3,
      duration: 1800,
      label: ({ kind }) => (kind === "input" ? { word: "NEEDS INPUT", square: "--info" } : { word: "NEEDS APPROVAL", square: "--warning" }),
      draw: drawWait,
      voice: chimeVoice,
    },
    wake: {
      placement: "arrival",
      rank: 2,
      dedupe: PLAYED_MS,
      duration: 1300,
      // A pending request ends a snooze early in T3; the wait effect already says so.
      skip: (threadId) => !!records.get(threadId)?.shell?.pendingRuntimeRequest,
      label: () => ({ word: "WOKE", square: "--warning" }),
      setup: (scene) => ({ animations: scene.calm || !scene.surface ? [] : [spring(scene.surface)] }),
      draw: drawWake,
      voice: wakeVoice,
    },
    done: {
      placement: "row",
      rank: 1,
      chord: true,
      duration: 1100,
      setup: (scene) => ({ pops: scene.calm ? [] : pops() }),
      draw: drawDone,
      voice: successVoice,
    },
    start: {
      placement: "row",
      rank: 0,
      duration: 900,
      setup: (scene) => ({ animations: scene.calm || !scene.surface ? [] : [jitter(scene.surface)] }),
      draw: drawStart,
      voice: runningVoice,
    },
    snooze: {
      placement: "ghost",
      rank: null,
      dedupe: PLAYED_MS,
      // Until the CRT line has shrunk to a dot, or the calm fade is over.
      keep: (calm) => (calm ? 680 : 800),
      duration: 1800,
      label: ({ until }) => ({ word: "SNOOZED", square: "--muted-foreground", note: untilText(until) }),
      draw: drawSnooze,
      voice: resetVoice,
    },
  };

  const offList = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(OFF_KEY));
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  };

  function untilText(iso) {
    const date = new Date(iso ?? "");
    if (Number.isNaN(date.getTime())) return "";
    const today = date.toDateString() === new Date().toDateString();
    return `until ${date.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  }

  // --- Which thread, and where ----------------------------------------------------------------

  // A row's data-thread-item is "<environmentId>:<threadId>", and a thread id can hold colons
  // itself ("mcp:<uuid>"). Settled threads keep theirs in the Settled section further down, so
  // the active row is the first match.
  const threadIdOf = (row) => row.getAttribute("data-thread-item").replace(/^[^:]*:/, "");
  const rowsFor = (threadId) => [...document.querySelectorAll(ROW)].filter((row) => threadIdOf(row) === threadId);
  const rowFor = (threadId) => rowsFor(threadId)[0];

  const backgroundOf = (node) => {
    for (let at = node; at; at = at.parentElement) {
      const color = getComputedStyle(at).backgroundColor;
      if (color && color !== "transparent" && !/rgba\(.*, 0\)$/.test(color)) return color;
    }
    return "black";
  };

  // Everything a leaving row's effect needs from it, taken while it is still on screen. Without
  // a visible row (a filter hides it, its project is collapsed) the effect plays in the middle of
  // the window.
  function target(threadId, title) {
    const row = rowFor(threadId);
    const rect = row?.getBoundingClientRect();
    if (!rect?.width || rect.bottom < 0 || rect.top > innerHeight) return { threadId, x: innerWidth / 2, y: innerHeight / 2, title: title ?? "" };
    // Like T3's own exit clones: no duplicate ids or test ids, and out of the tab order.
    const copy = row.cloneNode(true);
    for (const node of [copy, ...copy.querySelectorAll("[id], [data-testid], [data-thread-item]")]) {
      for (const name of ["id", "data-testid", "data-thread-item"]) node.removeAttribute(name);
    }
    copy.inert = true;
    const list = row.parentElement;
    return {
      threadId,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      rect,
      title: title ?? row.innerText.split("\n")[0],
      row: { element: row, copy, rect, background: backgroundOf(row) },
      layout: { list, tops: new Map([...list.children].map((item) => [item, item.offsetTop])) },
    };
  }

  // The live row an effect can play on in place: in a visible window, on screen and not covered.
  // `card` asks for the row in Active, Pinned or Working, not a slim Snoozed or Settled one.
  function inPlace(threadId, card = false) {
    if (document.visibilityState === "hidden") return null;
    for (const row of rowsFor(threadId)) {
      const surface = row.querySelector(card ? CARD : SURFACE);
      const rect = surface?.getBoundingClientRect();
      if (!rect?.width || rect.bottom < 0 || rect.top > innerHeight) continue;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || !row.contains(hit)) continue;
      const status = row.querySelector('[role="status"]')?.getBoundingClientRect();
      return {
        threadId,
        surface,
        rect,
        radius: parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 10,
        status: status?.width ? { x: status.left + status.width / 2, y: status.top + status.height / 2 } : null,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        title: row.innerText.split("\n")[0],
      };
    }
    return null;
  }

  // A row can show up a render or two after the change: a woken thread's card in Active, or a
  // snoozed thread that asks for something and jumps back out of the collapsed Snoozed shelf.
  const arrivals = new Map();
  function arrive(threadId, card, then) {
    clearTimeout(arrivals.get(threadId));
    const until = Date.now() + ARRIVE_MS;
    const look = guard(() => {
      arrivals.delete(threadId);
      const spot = inPlace(threadId, card);
      if (spot) then(spot);
      else if (Date.now() < until) arrivals.set(threadId, setTimeout(look, 50));
    });
    look();
  }

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

  // The props of T3's SidebarThreadRow above a row's element.
  function rowProps(row) {
    for (let fiber = fiberOf(row), i = 0; fiber && i < 12; fiber = fiber.return, i++) {
      if (fiber.memoizedProps && "wokeAt" in fiber.memoizedProps) return fiber.memoizedProps;
    }
    return null;
  }

  // --- Playing a change ------------------------------------------------------------------------

  const played = new Map();
  const latest = new Map();
  let canvas = null;
  let ctx = null;
  let scenes = [];
  let frame = 0;

  // Every source reports a change here. It plays once, and of a burst of changes on one thread
  // only the most important one plays. `held` marks a fresh Settle press, which is never a repeat.
  function fire(event, threadId, details = {}) {
    const effect = EFFECTS[event];
    if (!threadId || offList().includes(event) || isSubagent(threadId) || effect.skip?.(threadId, details)) return null;
    const now = Date.now();
    const key = `${event}:${threadId}`;
    if (!details.held && now - (played.get(key) ?? -Infinity) < (effect.dedupe ?? 0)) return null;
    const recent = latest.get(threadId);
    if (effect.rank !== null && recent && now - recent.at < BURST_MS) {
      if (recent.rank >= effect.rank) return null;
      stopEffects(threadId);
    }
    played.set(key, now);
    if (effect.rank !== null) latest.set(threadId, { rank: effect.rank, at: now });
    if (effect.placement === "ghost") {
      const spot = target(threadId, details.title);
      const scene = begin(event, spot, details);
      // A held Settle press moves the row only after its effect, so it has no place to keep.
      if (spot.layout && !details.held) keepPlace(scene, spot.layout, effect.keep(scene.calm));
      return scene;
    }
    arrive(threadId, effect.placement === "arrival", (spot) => begin(event, spot, details));
    return null;
  }

  function begin(event, spot, details = {}, pauseAt = null) {
    const effect = EFFECTS[event];
    const scene = {
      event,
      effect,
      details,
      threadId: spot.threadId ?? null,
      x: spot.x,
      y: spot.y,
      rect: spot.rect ?? null,
      radius: spot.radius ?? 10,
      surface: spot.surface ?? null,
      status: spot.status ?? null,
      element: spot.row?.element ?? null,
      calm: reducedMotion.matches,
      pauseAt,
      charge: 0,
      duration: effect.duration,
      animations: [],
      start: performance.now(),
      ghost: spot.row ? ghost(spot.row) : null,
    };
    Object.assign(scene, effect.setup?.(scene));
    const text = effect.label?.(details);
    if (text) scene.label = label(scene, text, details.title || spot.title || "");
    if (pauseAt !== null) {
      for (const animation of scene.animations) {
        animation.pause();
        animation.currentTime = pauseAt;
      }
    }
    scenes.push(scene);
    sound.play(event, { ...details, charge: scene.charge / 1000 });
    dispatchEvent(new CustomEvent("t3-settle-boom", { detail: { effect: event, threadId: scene.threadId } }));
    if (!frame) frame = requestAnimationFrame(tick);
    return scene;
  }

  const removeScene = (scene) => {
    scene.label?.node.remove();
    scene.ghost?.remove();
    scene.animations.forEach((animation) => animation.cancel());
  };

  function stopEffects(threadId) {
    clearTimeout(arrivals.get(threadId));
    arrivals.delete(threadId);
    scenes = scenes.filter((scene) => {
      if (scene.threadId !== threadId || scene.effect.rank === null) return true;
      removeScene(scene);
      return false;
    });
  }

  // An in-place effect follows its row if T3 moves it, and outlives it at its last position.
  function follow(scene) {
    if (!scene.surface) return;
    if (!scene.surface.isConnected) scene.surface = inPlace(scene.threadId)?.surface ?? scene.surface;
    const rect = scene.surface.getBoundingClientRect();
    if (rect.width) scene.rect = rect;
  }

  function tick(now) {
    frame = 0;
    if (!canvas?.isConnected) {
      canvas = document.createElement("canvas");
      canvas.className = "t3-settle-boom-canvas";
      document.documentElement.append(canvas);
      ctx = canvas.getContext("2d");
    }
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(innerWidth * dpr) || canvas.height !== Math.round(innerHeight * dpr)) {
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    scenes = scenes.filter((scene) => {
      const elapsed = Math.min(now - scene.start, scene.pauseAt ?? Infinity);
      if (elapsed >= scene.charge + scene.duration) {
        removeScene(scene);
        return false;
      }
      follow(scene);
      ctx.save();
      scene.effect.draw(scene, elapsed);
      ctx.restore();
      if (scene.label) drawLabel(scene, elapsed - scene.charge);
      return true;
    });
    if (scenes.length) frame = requestAnimationFrame(tick);
    else {
      canvas.remove();
      canvas = null;
    }
  }

  // --- Keeping a leaving row's place -----------------------------------------------------------

  // T3's sidebar is one list of rows and section headers. When a row leaves, T3 slides the items
  // below up into its place within 150 ms, under the ghost that is still playing there. So once
  // T3 has moved the list, every moved item is held where it was, and the leaving row and new
  // items stay hidden, until the ghost lets go; then they slide into place. T3 starts its slide
  // in a layout effect, and a mutation observer runs after that, so these animations win.
  const leaving = new Set();

  function keepPlace(scene, { list, tops }, keep) {
    const { threadId, element: row } = scene;
    leaving.add(threadId);
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
      leaving.delete(threadId);
    };
    const observer = new MutationObserver(
      guard(() => {
        const items = [...list.children];
        // Wait for the move itself, not, say, T3 removing an earlier exit clone.
        const moved = row.parentElement !== list || items.some((item) => tops.has(item) && tops.get(item) !== item.offsetTop);
        if (!moved) return;
        observer.disconnect();
        const wait = scene.start + keep - performance.now();
        if (wait <= 0) return stop();
        const slide = scene.calm ? 0 : 220;
        for (const item of items) {
          const was = tops.get(item);
          const hide = was === undefined || (item.matches(ROW) && leaving.has(threadIdOf(item)));
          const shift = was === undefined ? 0 : was - item.offsetTop;
          if (!hide && !shift) continue;
          const held = { transform: `translateY(${shift}px)`, opacity: hide ? 0 : 1 };
          item.animate([held, { ...held, offset: wait / (wait + slide), easing: "cubic-bezier(0.22, 1, 0.36, 1)" }, { transform: "none", opacity: 1 }], {
            duration: wait + slide,
          });
        }
      }),
    );
    const timer = setTimeout(stop, keep);
    observer.observe(list, { childList: true });
  }

  // --- Holding the settle until the explosion is over ------------------------------------------

  // The row's Settle button and ⌘⇧S are held back while the row charges and explodes. Then the
  // same click or key press is replayed, so T3 settles as usual, with its "⌘Z to undo". The
  // real row stays hidden behind the effect until then.
  let replaying = false;

  const settleButtonIn = (row) => [...(row?.querySelectorAll("button") ?? [])].find((button) => button.textContent.trim() === "Settle");
  const openThreadId = () => location.hash.split("/").pop(); // "#/<environmentId>/<threadId>"

  // If the effect cannot start, the event goes on to T3 untouched.
  function hold(event, threadId, replay) {
    if (offList().includes("settle")) return;
    const holding = Date.now() - (played.get(`settle:${threadId}`) ?? 0) < HOLD_MS;
    let scene = null;
    if (!holding) {
      try {
        scene = fire("settle", threadId, { held: true });
      } catch (error) {
        console.error("[settle-boom]", error);
        return;
      }
      if (!scene) return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (holding) return; // a second press while this thread is already exploding
    const wait = reducedMotion.matches ? CALM_HOLD_MS : HOLD_MS;
    // If T3 keeps the element for the Settled section, or the settle did not happen, it shows
    // again 400 ms after the replay.
    scene.element?.animate({ visibility: ["hidden", "hidden"] }, { duration: wait + 400 });
    // A timer, not the animation, releases it: a hidden window pauses animation frames.
    setTimeout(() => {
      replaying = true;
      try {
        replay();
      } finally {
        replaying = false;
      }
    }, wait);
  }

  addEventListener(
    "click",
    (event) => {
      if (replaying || !event.isTrusted) return;
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      const row = button?.closest(ROW);
      if (!row || button.textContent.trim() !== "Settle") return;
      const threadId = threadIdOf(row);
      hold(event, threadId, () => (button.isConnected ? button : settleButtonIn(rowFor(threadId)))?.click());
    },
    true,
  );

  // T3's default shortcut. A remapped one is not held; it settles at once, like the menu.
  addEventListener(
    "keydown",
    (event) => {
      if (replaying || !event.isTrusted || event.defaultPrevented || event.repeat) return;
      if (!(event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey && event.code === "KeyS")) return;
      const from = event.target instanceof Element ? event.target : document.body;
      if (from.closest(".xterm, [class*='terminal' i]")) return; // T3 ignores it in a terminal
      const threadId = openThreadId();
      if (!rowFor(threadId)) return;
      const init = { key: event.key, code: event.code, keyCode: event.keyCode, metaKey: true, shiftKey: true, bubbles: true, cancelable: true, composed: true };
      hold(event, threadId, () => {
        if (openThreadId() === threadId) (from.isConnected ? from : document.body).dispatchEvent(new KeyboardEvent("keydown", init));
        else settleButtonIn(rowFor(threadId))?.click();
      });
    },
    true,
  );

  // --- What T3 says ----------------------------------------------------------------------------

  // The server pushes a `thread.updated` message with the whole thread shell after every change,
  // with no event type, so changes are found by comparing shells. Per thread this keeps the last
  // shell and the last key each change had. A change plays when its key is new and it happened
  // after this page loaded, within the last 30 seconds. When T3 subscribes again after a
  // reconnect, the server replays what changed while it was away until `{kind: "synchronized"}`;
  // those only set the keys. The first subscription goes out before this script loads, so the
  // page-load check covers it. Snapshots are not a marker: the server also sends one whenever a
  // project's repository details refresh.
  const records = new Map();
  const replayingRequests = new Set();
  const ACTIVE_RUN = ["preparing", "queued", "starting", "running", "waiting"];

  const isSubagentShell = (shell) => shell?.lineage?.relationshipToParent === "subagent";
  const isSubagent = (threadId) => isSubagentShell(records.get(threadId)?.shell);
  const fresh = (at) => {
    const time = Date.parse(at ?? "");
    return time >= performance.timeOrigin && Date.now() - time < FRESH_MS;
  };

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
    if (isSubagentShell(shell)) {
      const live = shell.activityRunStatus !== undefined ? shell.activityRunStatus !== null : ACTIVE_RUN.includes(shell.status);
      return shell.creationSource !== "provider" && live ? kind : null;
    }
    if (kind === "input" && request.blocking === false && ["preparing", "starting", "running"].includes(runtimeOf(shell))) return null;
    return kind;
  }

  function statusOf(shell) {
    if (asks(shell)) return "needs-you";
    const runtime = runtimeOf(shell);
    if (runtime === "running" && shell.blockedOnThreadWait) return "waiting";
    if (ACTIVE_RUN.includes(runtime)) return "working";
    return runtime === "idle" || runtime === "failed" ? runtime : "ready";
  }

  // What each change keys on in a shell, and when it happened, most important first.
  const CHANGES = {
    settle: (shell) => ({ key: shell.settledAt, at: shell.settledAt }),
    wait: (shell) => {
      const kind = asks(shell);
      const request = shell.pendingRuntimeRequest;
      // A question that stops being one the run works past starts waiting now, not when asked.
      return { key: kind && request.id, at: request?.blocking === false ? shell.updatedAt : request?.createdAt, kind };
    },
    // Settling, pinning or writing to a snoozed thread also ends its snooze. A snooze whose time
    // had already passed woke on T3's timer, which the sidebar reports.
    wake: (shell, prior) => {
      const byHand = !shell.snoozedUntil && !shell.settledAt && Date.parse(prior?.snoozedUntil ?? "") > Date.now();
      return { key: byHand ? prior.snoozedAt : null, at: shell.updatedAt, timer: false };
    },
    // A run you stopped is not done, as in T3's own notifications. Background work can hold a
    // completed run back for a while; then it is done when the hold ends, not when the run ended.
    done: (shell, prior) => {
      const completed = (shell.status === "completed" || shell.status === "idle") && !shell.latestRunStopRequested && statusOf(shell) === "ready";
      return { key: completed ? shell.latestRunCompletedAt : null, at: prior && statusOf(prior) !== "ready" ? shell.updatedAt : shell.latestRunCompletedAt };
    },
    start: (shell) => ({
      key: statusOf(shell) === "working" ? shell.latestRunId : null,
      at: shell.activityRunStartedAt ?? shell.latestRunStartedAt ?? shell.latestRunRequestedAt ?? shell.updatedAt,
    }),
    snooze: (shell) => ({ key: shell.snoozedUntil ? shell.snoozedAt : null, at: shell.snoozedAt, until: shell.snoozedUntil }),
  };

  const recordFor = (threadId) => records.get(threadId) ?? records.set(threadId, { shell: null, keys: {} }).get(threadId);

  // A subagent's question shows on the row of its first ancestor that is not a subagent.
  function rowOwner(shell) {
    let id = shell.id;
    for (let at = shell, i = 0; isSubagentShell(at) && i < 20; i++) {
      id = at.lineage.parentThreadId ?? id;
      at = records.get(id)?.shell;
    }
    return id;
  }

  function observe(shell, live) {
    const record = recordFor(shell.id);
    const prior = record.shell;
    record.shell = shell;
    const quiet = !live || shell.archivedAt || shell.deletedAt;
    const owner = isSubagentShell(shell) ? rowOwner(shell) : shell.id;
    for (const [event, change] of Object.entries(CHANGES)) {
      const { key, at, ...details } = change(shell, prior);
      if (key == null || key === record.keys[event]) continue;
      record.keys[event] = key;
      if (quiet || !fresh(at) || (owner !== shell.id && event !== "wait")) continue;
      fire(event, owner, { title: records.get(owner)?.shell?.title, ...details });
    }
  }

  // Settling, snoozing and waking are optimistic: T3 moves the row right after it sends the
  // command, so the copy of the row is taken here, before the send. Other windows, agents and auto-settle
  // only show in the server's pushes, read before T3 handles them. The socket opened before this
  // script ran, so both hooks sit on prototypes. They run inside T3's own code, so they must
  // never throw.
  const onSend = guard((text) => {
    for (const message of [JSON.parse(text)].flat()) {
      if (SUBSCRIBE.test(message?.tag ?? "")) replayingRequests.add(String(message.id));
      const command = message?.payload;
      if (command?.type === "thread.settle") fire("settle", command.threadId);
      else if (command?.type === "thread.snooze") fire("snooze", command.threadId, { until: command.snoozedUntil });
      else if (command?.type === "thread.unsnooze") fire("wake", command.threadId, { timer: false });
    }
  });

  // One bad value must not leave the rest of its frame unread.
  const observeSafely = guard(observe);

  const onFrame = guard((text) => {
    for (const message of [JSON.parse(text)].flat()) {
      if (message?._tag !== "Chunk" || !Array.isArray(message.values)) continue;
      const requestId = String(message.requestId);
      for (const value of message.values) {
        if (value?.kind === "synchronized") replayingRequests.delete(requestId);
        else if (value?.kind === "thread.updated" && value.thread?.id) observeSafely(value.thread, !replayingRequests.has(requestId));
        else if (value?.kind === "thread.removed") records.delete(value.threadId);
      }
    }
  });

  const SUBSCRIBE = /^orchestration\.subscribe(Archived)?Shell$/;
  const SENT = /"type":"thread\.(settle|snooze|unsnooze)"|"tag":"orchestration\.subscribe(Archived)?Shell"/;
  const FRAME = /"kind":"(thread\.|synchronized")/;
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

  // A snooze that runs out ends in T3's sidebar, on a timer; the server sends nothing. The woken
  // card shows a "Woke" button, and the row's `wokeAt` prop says when it woke.
  const onMutations = guard((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const button of node.matches(WOKE) ? [node] : node.querySelectorAll(WOKE)) {
          const row = button.closest(ROW);
          const wokeAt = row && rowProps(row)?.wokeAt;
          if (!wokeAt || !fresh(wokeAt)) continue;
          const record = recordFor(threadIdOf(row));
          if (record.keys.wake === wokeAt) continue;
          record.keys.wake = wokeAt;
          fire("wake", threadIdOf(row), { timer: true });
        }
      }
    }
  });
  new MutationObserver(onMutations).observe(document.documentElement, { childList: true, subtree: true });

  // --- Drawing ---------------------------------------------------------------------------------

  // Effect Institute's colors on the dark theme. On the light theme they would wash out against
  // a white sidebar, so T3's own status colors stand in.
  const TONES = {
    ink: [INK, "--foreground"],
    info: ["100, 200, 255", "--info"],
    warning: ["252, 211, 77", "--warning"],
    success: [GREEN, "--success"],
  };
  const isDark = () => document.documentElement.classList.contains("dark");
  const swatch = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const resolved = new Map();
  function tone(name) {
    const [dark, variable] = TONES[name];
    if (isDark()) return dark;
    const color = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    if (!resolved.has(color)) {
      swatch.clearRect(0, 0, 1, 1);
      swatch.fillStyle = "#000";
      swatch.fillStyle = color;
      swatch.fillRect(0, 0, 1, 1);
      resolved.set(color, [...swatch.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(", "));
    }
    return resolved.get(color);
  }

  function label(scene, { word, square, note = "", at = "beside", from = 60 }, title) {
    const node = document.createElement("div");
    node.className = "t3-settle-boom-label";
    node.style.setProperty("--t3-settle-boom-square", `var(${square})`);
    const wordNode = document.createElement("div");
    wordNode.className = "t3-settle-boom-word";
    const name = document.createElement("div");
    name.className = "t3-settle-boom-title";
    name.textContent = title.length > 40 ? `${title.slice(0, 39)}…` : title;
    const extra = document.createElement("div");
    extra.className = "t3-settle-boom-note";
    extra.textContent = note;
    node.append(wordNode, name, extra);
    document.documentElement.append(node);
    const { width, height } = node.getBoundingClientRect();
    const beside = at === "beside" && scene.rect;
    const left = beside ? scene.rect.right + 10 : scene.x + 34;
    const top = beside ? scene.rect.top + scene.rect.height / 2 - height / 2 : scene.y - height - 18;
    node.style.left = `${Math.min(Math.max(12, left), innerWidth - width - 12)}px`;
    node.style.top = `${Math.min(Math.max(12, top), innerHeight - height - 12)}px`;
    return { node, word: wordNode, text: word, from };
  }

  // The word resolves letter by letter out of glitch glyphs, holds, then blurs away. A long word
  // resolves faster, so it reads at the effect's peak.
  function drawLabel(scene, e) {
    const { node, word, text, from } = scene.label;
    const step = Math.min(45, 360 / text.length);
    word.textContent = [...text].map((letter, i) => (letter === " " || e >= from + 60 + i * step ? letter : pick(GLYPHS))).join("");
    const fadeIn = clamp01((e - from) / 120);
    const fadeOut = clamp01((e - (scene.duration - 550)) / 550);
    node.style.opacity = String(fadeIn * (1 - fadeOut));
    node.style.filter = `blur(${(fadeOut * 4).toFixed(2)}px)`;
    node.style.transform = `translateY(${((1 - fadeIn) * 6 - fadeOut * 8).toFixed(2)}px)`;
  }

  function ghost({ copy, rect, background }) {
    const node = document.createElement("div");
    node.className = "t3-settle-boom-ghost";
    node.setAttribute("aria-hidden", "true");
    Object.assign(node.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, background });
    node.append(copy);
    document.body.append(node);
    return node;
  }

  function outline(scene, grow = 0) {
    const { rect, radius } = scene;
    ctx.beginPath();
    ctx.roundRect(rect.left - grow, rect.top - grow, rect.width + grow * 2, rect.height + grow * 2, radius + grow);
  }

  function fill(scene, color, alpha) {
    if (alpha <= 0.002) return;
    outline(scene);
    ctx.fillStyle = `rgba(${color}, ${alpha})`;
    ctx.fill();
  }

  function stroke(scene, color, alpha, width, { grow = 0, glow = 0 } = {}) {
    if (alpha <= 0.002) return;
    outline(scene, grow);
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(${color}, ${alpha})`;
    ctx.shadowColor = `rgba(${color}, ${Math.min(1, alpha)})`;
    ctx.shadowBlur = glow;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // The Institute's flash: up in 20 ms, then fading.
  function flash(scene, e, color, fade, peak = isDark() ? 0.3 : 0.16) {
    fill(scene, color, e < 20 ? peak * (e / 20) : peak * Math.max(0, 1 - (e - 20) / fade));
  }

  // Its start flash is white, which would not show on the light theme's white rows.
  const startFlash = (color) => (isDark() ? WHITE : color);

  // Thin expanding rings. Settle's middle one is dashed and turns like the Institute's lettered
  // ring; the radar rings of wait and wake grow from 4 px like its badge's.
  const RINGS = [
    { delay: 0, duration: 650, radius: 95, width: 2 },
    { delay: 70, duration: 820, radius: 160, width: 1.25, dash: [3, 7] },
    { delay: 160, duration: 980, radius: 240, width: 1 },
  ];
  const RADAR = [0, 1, 2, 3].map((i) => ({ delay: i * 170, duration: 1100, from: 4, radius: 85, width: 1.25, ease: easeOutCubic }));

  function drawRings(x, y, rings, e, color, spin = 0) {
    for (const ring of rings) {
      const p = (e - ring.delay) / ring.duration;
      if (p <= 0 || p >= 1) continue;
      const from = ring.from ?? 0;
      ctx.beginPath();
      ctx.setLineDash(ring.dash ?? []);
      ctx.lineDashOffset = ring.dash ? -e * 0.04 : 0;
      ctx.lineWidth = ring.width * (1 - p * 0.5);
      ctx.strokeStyle = `rgba(${color}, ${(1 - p) ** 1.5})`;
      ctx.arc(x, y, Math.max(1, from + (ring.radius - from) * (ring.ease ?? easeOutExpo)(p)), spin, spin + Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Debris with drag and a little gravity, in closed form so any frame is a function of time.
  const DRAG = 3.4;
  const GRAVITY = 140;
  const travel = (v, t) => (v / DRAG) * (1 - Math.exp(-DRAG * t));
  const fall = (t, gravity) => (gravity / DRAG) * (t - (1 - Math.exp(-DRAG * t)) / DRAG);

  // Glyphs flicker through the glitch set while they fly, then cool into squares.
  function drawDebris(bits, x, y, e, gravity, ink, green) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const font = monoFont();
    for (const bit of bits) {
      const p = e / bit.life;
      if (p >= 1) continue;
      const t = e / 1000;
      const glyph = bit.green || p > 0.55 ? "■" : GLYPHS[(bit.seed + Math.floor(e / 60)) % GLYPHS.length];
      ctx.save();
      ctx.translate(x + travel(bit.vx, t), y + travel(bit.vy, t) + fall(t, gravity));
      ctx.rotate(bit.spin * t);
      ctx.font = `600 ${bit.green ? bit.size * 0.7 : bit.size}px ${font}`;
      ctx.fillStyle = `rgba(${bit.green ? green : ink}, ${1 - p ** 2})`;
      ctx.fillText(glyph, 0, 0);
      ctx.restore();
    }
  }

  // --- Settle: the explosion -------------------------------------------------------------------

  function settleSetup(scene) {
    const charge = scene.ghost && !scene.calm ? CHARGE : 0;
    return { charge, spin: rand(0, Math.PI * 2), debris: scene.calm ? [] : debris(), sparks: scene.calm ? [] : sparks(), shaken: scene.calm };
  }

  function debris() {
    return Array.from({ length: 38 }, () => {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(140, 660);
      return {
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        spin: rand(-10, 10),
        size: rand(9, 15),
        life: rand(700, 1350),
        green: Math.random() < 0.15,
        seed: Math.floor(rand(0, 1000)),
      };
    });
  }

  function sparks() {
    return Array.from({ length: 16 }, () => ({ angle: rand(0, Math.PI * 2), speed: rand(900, 1600), life: rand(200, 380) }));
  }

  function shake() {
    const root = document.getElementById("root") ?? document.body;
    const hops = Array.from({ length: 5 }, () => ({ transform: `translate(${rand(-5, 5)}px, ${rand(-4, 4)}px) rotate(${rand(-0.35, 0.35)}deg)` }));
    root.animate([{ transform: "none" }, ...hops, { transform: "none" }], { duration: 380, easing: "ease-out" });
  }

  // `e` counts from the start; the blast starts after the row's charge.
  function drawSettle(scene, e) {
    const ink = tone("ink");
    drawGhost(scene, e, ink);
    const b = e - scene.charge;
    if (b < 0) return;
    if (!scene.shaken) {
      scene.shaken = true;
      shake();
    }
    const { x, y } = scene;
    if (!scene.calm) drawGrid(x, y, b, ink);
    drawRings(x, y, scene.calm ? RINGS.slice(0, 1) : RINGS, b, ink, scene.spin);
    if (!scene.calm) {
      drawCore(x, y, b, ink);
      drawSparks(scene, b, ink);
      drawDebris(scene.debris, x, y, b, GRAVITY, ink, tone("success"));
    }
  }

  // The row's copy shakes harder and brightens, like a failing effect in the Institute, then
  // bursts. Each 45 ms hop has its own fixed offset, so a paused frame holds still.
  function drawGhost(scene, e, ink) {
    const node = scene.ghost;
    if (!node) return;
    if (e < scene.charge) {
      const p = e / scene.charge;
      const hop = Math.floor(e / 45);
      const jitter = (n) => (Math.sin(hop * 12.9898 + n * 78.233) * 43758.5453) % 1;
      const amp = 1.5 + 5 * p;
      node.style.transform = `translate(${(jitter(1) * amp).toFixed(2)}px, ${(jitter(2) * amp * 0.6).toFixed(2)}px) rotate(${(jitter(3) * p * 3).toFixed(2)}deg)`;
      node.style.filter = `brightness(${(1 + p * 1.6).toFixed(2)}) contrast(${(1 + p * 0.4).toFixed(2)})`;
      node.style.boxShadow = `0 0 0 1px rgba(${ink}, ${(0.25 + p * 0.6).toFixed(2)}), 0 0 ${(24 * p).toFixed(1)}px rgba(${ink}, ${(0.35 * p).toFixed(2)})`;
      return;
    }
    const p = clamp01((e - scene.charge) / 140);
    node.style.transform = `scale(${(1 + p * 0.12).toFixed(3)})`;
    node.style.filter = `brightness(${(2.6 - p).toFixed(2)}) blur(${(p * 6).toFixed(2)}px)`;
    node.style.opacity = String(1 - p);
  }

  // The dot grid lights up as the shock wave passes through it.
  function drawGrid(x, y, e, ink) {
    const p = e / 900;
    if (p >= 1) return;
    const step = 14;
    const reach = 330;
    const wave = reach * easeOutCubic(p);
    for (let gx = Math.ceil((x - reach) / step) * step; gx <= x + reach; gx += step) {
      for (let gy = Math.ceil((y - reach) / step) * step; gy <= y + reach; gy += step) {
        const d = Math.hypot(gx - x, gy - y);
        if (d > reach) continue;
        const lit = Math.exp(-((d - wave) ** 2) / (2 * 16 ** 2)) * (1 - p) + Math.exp(-d / 50) * clamp01(1 - e / 350) * 0.6;
        if (lit < 0.03) continue;
        ctx.fillStyle = `rgba(${ink}, ${Math.min(0.9, lit)})`;
        ctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5);
      }
    }
  }

  function drawCore(x, y, e, ink) {
    if (e >= 240) return;
    const r = e < 50 ? 22 * (e / 50) : 22 * (1 - (e - 50) / 190);
    ctx.shadowColor = `rgba(${ink}, 0.9)`;
    ctx.shadowBlur = 28;
    ctx.fillStyle = `rgb(${ink})`;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawSparks(scene, e, ink) {
    ctx.lineCap = "round";
    for (const spark of scene.sparks) {
      const p = e / spark.life;
      if (p >= 1) continue;
      const head = travel(spark.speed, e / 1000);
      const tail = Math.max(0, head - spark.speed * 0.04 * (1 - p));
      const dx = Math.cos(spark.angle);
      const dy = Math.sin(spark.angle);
      ctx.strokeStyle = `rgba(${ink}, ${1 - p})`;
      ctx.lineWidth = 1.5 * (1 - p) + 0.3;
      ctx.beginPath();
      ctx.moveTo(scene.x + dx * tail, scene.y + dy * tail);
      ctx.lineTo(scene.x + dx * head, scene.y + dy * head);
      ctx.stroke();
    }
  }

  // --- Start, wait, done, snooze, wake -----------------------------------------------------------

  // The Institute's running jitter, a few hops on T3's row through the Web Animations API, which
  // leaves the style attribute React owns alone.
  function jitter(surface) {
    const hop = () => ({ transform: `translate(${rand(-1.4, 1.4).toFixed(2)}px, ${rand(-0.6, 0.6).toFixed(2)}px) rotate(${rand(-0.3, 0.3).toFixed(2)}deg)` });
    return surface.animate([{ transform: "none" }, hop(), hop(), hop(), hop(), { transform: "none" }], { duration: 320, easing: "linear" });
  }

  // The Institute's node entrance: a short spring up into place.
  function spring(surface) {
    return surface.animate(
      [
        { transform: "translateY(8px) scale(0.97)", opacity: 0.4 },
        { transform: "translateY(-2px) scale(1.015)", opacity: 1, offset: 0.45 },
        { transform: "translateY(0.5px) scale(0.998)", offset: 0.75 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 560, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }

  // Start: a flash, the running sweep of three soft bands across the row (40 px wide, a little
  // faster than the Institute's 500 px/s so all three cross a sidebar row), and a border pulse.
  function drawStart(scene, e) {
    const blue = tone("info");
    ctx.save();
    outline(scene);
    ctx.clip();
    flash(scene, e, startFlash(blue), 500);
    const { rect } = scene;
    for (let i = 0; i < 3 && !scene.calm; i++) {
      const x = rect.left - 30 - i * 90 + 0.56 * e;
      if (x < rect.left - 30 || x > rect.right + 30) continue;
      const band = ctx.createLinearGradient(x - 20, 0, x + 20, 0);
      band.addColorStop(0, `rgba(${blue}, 0)`);
      band.addColorStop(0.5, `rgba(${blue}, 0.45)`);
      band.addColorStop(1, `rgba(${blue}, 0)`);
      ctx.fillStyle = band;
      ctx.fillRect(x - 20, rect.top, 40, rect.height);
    }
    ctx.restore();
    const pulse = clamp01(e / 80) * clamp01((scene.duration - e) / 300) * (0.65 + 0.35 * Math.cos((2 * Math.PI * e) / 600));
    stroke(scene, blue, pulse, 1.5, { glow: 10 });
  }

  // Wait: the amber of the Institute's "Needs review" pill breathes twice around the row while
  // radar rings go out from its left edge.
  function drawWait(scene, e) {
    const amber = tone("warning");
    const breath = 0.5 - 0.5 * Math.cos((4 * Math.PI * e) / scene.duration);
    fill(scene, amber, 0.08 * breath);
    stroke(scene, amber, breath, 1.5, { glow: 14 * breath });
    const { rect } = scene;
    drawRings(rect.left + 4, rect.top + rect.height / 2, scene.calm ? RADAR.slice(0, 1) : RADAR, e, amber);
  }

  // A handful of the Institute's green squares, popped up from the row's status.
  function pops() {
    return Array.from({ length: 7 }, () => {
      const angle = -Math.PI / 2 + rand(-1, 1);
      const speed = rand(160, 300);
      return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, spin: rand(-8, 8), size: rand(12, 16), life: rand(700, 1000), green: true, seed: 0 };
    });
  }

  // Done: a green flash, the Institute's soft success ring growing out of the row, and squares.
  function drawDone(scene, e) {
    const green = tone("success");
    flash(scene, e, green, 600, isDark() ? 0.16 : 0.14);
    const p = clamp01(e / 1000);
    stroke(scene, green, 0.7 * (1 - p) ** 1.5, 2 * (1 - p) + 0.5, { grow: 16 * easeOutCubic(p), glow: 12 });
    const { rect, status } = scene;
    drawDebris(scene.pops, status?.x ?? rect.right - 28, status?.y ?? rect.top + 14, e, 900, green, green);
  }

  // Snooze: the copy greys out to the Institute's idle slate, then switches off like a CRT: it
  // squeezes into a bright line, the line into a dot, and z's drift up where it was.
  function drawSnooze(scene, e) {
    const { rect, ghost: node } = scene;
    const grey = clamp01(e / 280);
    const squeeze = scene.calm ? 0 : easeInCubic(clamp01((e - 280) / 320));
    const shrink = scene.calm ? 0 : easeInCubic(clamp01((e - 600) / 200));
    if (node) {
      const fade = scene.calm ? 1 - clamp01((e - 280) / 400) : 1 - shrink;
      node.style.filter = `grayscale(${grey}) brightness(${(1 - 0.35 * grey + 1.8 * squeeze).toFixed(2)})`;
      node.style.opacity = String(Math.min(1, 1 - 0.6 * grey + 0.6 * squeeze) * fade);
      node.style.transform = `scale(${Math.max(0.002, 1 - shrink).toFixed(3)}, ${Math.max(0.03, 1 - squeeze).toFixed(3)})`;
    }
    if (!rect) {
      drawZs(scene, scene.x, scene.y, e);
      return;
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (node && grey * (1 - shrink) > 0) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(Math.max(0.002, 1 - shrink), Math.max(0.03, 1 - squeeze));
      ctx.translate(-cx, -cy);
      fill(scene, SLATE, 0.4 * grey * (1 - squeeze));
      ctx.restore();
    }
    const ink = tone("ink");
    if (node && squeeze > 0.5 && e < 920) {
      const width = Math.max(2, rect.width * (1 - shrink));
      const alpha = e < 800 ? 1 : 1 - (e - 800) / 120;
      ctx.shadowColor = `rgba(${ink}, ${alpha})`;
      ctx.shadowBlur = 14;
      ctx.fillStyle = `rgba(${ink}, ${alpha})`;
      ctx.fillRect(cx - width / 2, cy - 1, width, 2);
      ctx.shadowBlur = 0;
    }
    drawZs(scene, rect.right - 44, cy, e);
  }

  // Three z's float up, swaying ±12 px every 0.8 s like the Institute's sleep bubble.
  function drawZs(scene, x, y, e) {
    if (scene.calm) return;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const font = monoFont();
    const ink = tone("ink");
    for (let i = 0; i < 3; i++) {
      const q = (e - 420 - i * 200) / 900;
      if (q <= 0 || q >= 1) continue;
      ctx.font = `600 ${11 + i * 3}px ${font}`;
      ctx.fillStyle = `rgba(${ink}, ${0.9 * Math.sin(Math.PI * q)})`;
      ctx.fillText(i === 2 ? "Z" : "z", x + i * 10 + 12 * Math.sin((2 * Math.PI * e) / 800 + i * 1.3), y - 6 - 50 * easeOutCubic(q));
    }
  }

  // Wake: the card springs into Active with a flash, an amber border that fades, and radar rings
  // from its "Woke" status.
  function drawWake(scene, e) {
    const amber = tone("warning");
    flash(scene, e, startFlash(amber), 600);
    stroke(scene, amber, 0.9 * (1 - clamp01(e / 1000)) ** 2, 1.5, { glow: 12 });
    const { rect, status } = scene;
    drawRings(status?.x ?? rect.left + 4, status?.y ?? rect.top + rect.height / 2, scene.calm ? RADAR.slice(0, 1) : RADAR, e, amber);
  }

  // --- The sound -------------------------------------------------------------------------------

  // Web Audio versions of the Institute's voices. The voices are built on any BaseAudioContext,
  // so the same sound can be rendered offline.
  function graph(audio) {
    const out = audio.createGain();
    out.gain.value = 0.25; // about -12 dB, the Institute's master level
    out.connect(audio.destination);
    const reverb = audio.createConvolver();
    reverb.buffer = impulse(audio, 2.5);
    const wet = audio.createGain();
    wet.gain.value = 0.3;
    wet.connect(reverb).connect(out);
    const drive = audio.createWaveShaper();
    drive.curve = distortionCurve(0.8);
    drive.oversample = "4x";
    drive.connect(out);
    drive.connect(wet);
    return { audio, out, wet, drive };
  }

  function impulse(audio, seconds) {
    const length = Math.floor(audio.sampleRate * seconds);
    const buffer = audio.createBuffer(2, length, audio.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }
    return buffer;
  }

  // Tone.js's Distortion curve.
  function distortionCurve(amount) {
    const k = amount * 100;
    const curve = new Float32Array(4096);
    for (let i = 0; i < curve.length; i++) {
      const x = (i * 2) / curve.length - 1;
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  // An ADSR on a gain param; returns when the voice is silent.
  function envelope(param, t, { attack, decay, sustain, hold, release, peak }) {
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(peak, t + attack);
    param.setTargetAtTime(peak * sustain, t + attack, decay / 3);
    param.setTargetAtTime(0.0001, t + Math.max(hold, attack), release / 4);
    return t + hold + release;
  }

  function note(g, type, frequency, t, shape, destinations = [g.out, g.wet], detune = 0) {
    const osc = g.audio.createOscillator();
    const gain = g.audio.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    osc.detune.value = detune;
    osc.connect(gain);
    for (const destination of destinations) gain.connect(destination);
    osc.start(t);
    osc.stop(envelope(gain.gain, t, shape));
    return osc;
  }

  // "C4" and an offset in semitones to Hz.
  const FROM_A = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
  const hz = (name, semitones = 0) => 440 * 2 ** ((FROM_A[name[0]] + 12 * (Number(name.slice(1)) - 4) + semitones) / 12);

  // Like Tone's "fatsawtooth": a few detuned saws.
  const fatSaw = (g, frequency, t, shape) =>
    [-12, 0, 12].forEach((cents) => note(g, "sawtooth", frequency, t, { ...shape, peak: shape.peak / 3 }, [g.drive], cents));

  function blast(g, t) {
    const { audio } = g;
    const noise = audio.createBufferSource();
    noise.buffer = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
    const samples = noise.buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(3200, t);
    filter.frequency.exponentialRampToValueAtTime(140, t + 0.6);
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.9, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    noise.connect(filter).connect(gain).connect(g.drive);
    noise.start(t);
    noise.stop(t + 1);

    const thump = note(g, "sine", 120, t, { attack: 0.002, decay: 0.3, sustain: 0.2, hold: 0.25, release: 0.3, peak: 0.9 });
    thump.frequency.setValueAtTime(120, t);
    thump.frequency.exponentialRampToValueAtTime(36, t + 0.35);
  }

  // Settle: quick rising sine ticks while the row charges (the Institute's "running" blips),
  // then a filtered noise burst and sub thump, its distorted "death" stab and rumble, and a soft
  // triangle triad through reverb, since settling is good news.
  function settleVoice(g, t, { charge }) {
    if (charge > 0) {
      [659.25, 783.99, 880].forEach((frequency, i) =>
        note(g, "sine", frequency, t + (i * charge) / 3, { attack: 0.002, decay: 0.08, sustain: 0, hold: 0.03, release: 0.1, peak: 0.3 }),
      ); // E5 G5 A5
      t += charge;
    }
    blast(g, t);
    fatSaw(g, 155.56, t, { attack: 0.01, decay: 0.5, sustain: 0.3, hold: 0.0625, release: 1.5, peak: 0.45 }); // D#3
    fatSaw(g, 32.7, t + 0.1, { attack: 0.01, decay: 0.5, sustain: 0.3, hold: 0.5, release: 1.2, peak: 0.55 }); // C1
    [523.25, 659.25, 783.99].forEach((frequency, i) =>
      note(g, "triangle", frequency, t + 0.3 + i * 0.07, { attack: 0.02, decay: 0.3, sustain: 0.1, hold: 0.25, release: 1.2, peak: 0.18 }),
    ); // C5 E5 G5
  }

  // Note lengths are Tone's at 120 BPM: 32n is 62.5 ms, 16n 125 ms, 4n 500 ms.

  // Start: one "running" blip from the pentatonic scale. The Institute plays it in octave 3,
  // which laptop speakers barely reproduce, so it plays in octave 5, like settle's charge ticks.
  function runningVoice(g, t, { turn }) {
    note(g, "sine", hz(`${PENTATONIC[turn % 5]}5`), t, { attack: 0.002, decay: 0.08, sustain: 0, hold: 0.0625, release: 0.1, peak: 0.25 });
  }

  // Done: the "success" note in octave 4. Completions in the same chord window add +4 and +7.
  function successVoice(g, t, { turn, index }) {
    note(g, "triangle", hz(`${PENTATONIC[turn % 5]}4`, [0, 4, 7][index]), t, { attack: 0.02, decay: 0.3, sustain: 0.1, hold: 0.5, release: 1.2, peak: 0.3 });
  }

  // Wait: the notification chime, C5 then E5.
  function chimeVoice(g, t) {
    ["C5", "E5"].forEach((name, i) => note(g, "triangle", hz(name), t + i * 0.12, { attack: 0.005, decay: 0.25, sustain: 0.1, hold: 0.125, release: 0.4, peak: 0.4 }));
  }

  // Snooze: the "reset" cue, G3 down to C3.
  function resetVoice(g, t) {
    ["G3", "C3"].forEach((name, i) => note(g, "sine", hz(name), t + i * 0.1, { attack: 0.004, decay: 0.18, sustain: 0, hold: 0.125, release: 0.12, peak: 0.6 }));
  }

  // Wake: the pager when a snooze runs out, the rising "sent" notes when you wake it yourself.
  function wakeVoice(g, t, { timer }) {
    if (timer) {
      ["B4", "E5", "B4", "E5"].forEach((name, i) => note(g, "triangle", hz(name), t + i * 0.12, { attack: 0.002, decay: 0.1, sustain: 0.05, hold: 0.0625, release: 0.2, peak: 0.45 }));
    } else {
      ["E5", "G5", "C6"].forEach((name, i) => note(g, "sine", hz(name), t + i * 0.07, { attack: 0.001, decay: 0.03, sustain: 0, hold: 0.0625, release: 0.02, peak: 0.5 }));
    }
  }

  const sound = (() => {
    let live = null;
    let turn = 0;
    const bursts = {};
    const context = () => (live ??= graph(new AudioContext())).audio;

    // Threads that change together play one sound, the way T3 plays its own. Done notes that
    // land within the Institute's 100 ms chord window stack into a triad instead.
    function play(event, cue) {
      if (localStorage.getItem(MUTED_KEY) === "1") return;
      const now = performance.now();
      const burst = bursts[event];
      let index = 0;
      if (burst && now - burst.at < THROTTLE_MS) {
        if (!EFFECTS[event].chord || now - burst.at > CHORD_MS || burst.count >= 3) return;
        index = burst.count++;
      } else bursts[event] = { at: now, count: 1, turn: turn++ };
      if (context().state === "suspended") context().resume();
      EFFECTS[event].voice(live, context().currentTime + 0.01, { ...cue, index, turn: bursts[event].turn });
    }

    function render(event, cue = {}, seconds = 3.6, sampleRate = 44_100) {
      const offline = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
      EFFECTS[event].voice(graph(offline), 0.01, { charge: CHARGE / 1000, timer: true, index: 0, turn: 0, ...cue });
      return offline.startRendering();
    }

    // Some windows only allow audio after a gesture; open the context on the first one.
    addEventListener("pointerdown", () => context().resume(), { once: true, capture: true });

    return { play, render, state: () => live?.audio.state ?? "not started" };
  })();

  window.t3SettleBoom = {
    // Plays an effect on a thread's row, or at a point (default: the middle of the window),
    // without changing the thread. `pauseAt` freezes it at that many milliseconds, for
    // screenshots. Wait takes `kind: "input"`, wake `timer: false`, snooze `until`.
    play: ({ effect = "settle", threadId = null, x = innerWidth / 2, y = innerHeight / 2, title = "", pauseAt = null, ...details } = {}) => {
      const placement = EFFECTS[effect]?.placement;
      if (!placement) throw new Error(`No effect "${effect}". Effects: ${Object.keys(EFFECTS).join(", ")}`);
      const row = threadId && (placement === "ghost" ? target(threadId) : inPlace(threadId, placement === "arrival"));
      const card = { left: x - 130, top: y - 39, right: x + 130, bottom: y + 39, width: 260, height: 78 };
      const point = placement === "ghost" ? { x, y } : { x, y, rect: card };
      begin(effect, row?.x ? row : point, { timer: true, ...details, title }, pauseAt);
    },
    clear: () => {
      scenes.forEach(removeScene);
      scenes = [];
      arrivals.forEach(clearTimeout);
      arrivals.clear();
    },
    get muted() {
      return localStorage.getItem(MUTED_KEY) === "1";
    },
    set muted(value) {
      localStorage.setItem(MUTED_KEY, value ? "1" : "0");
    },
    // Effects that do not play, by name. Saved in localStorage.
    get off() {
      return offList();
    },
    set off(names) {
      localStorage.setItem(OFF_KEY, JSON.stringify([names].flat().filter((name) => Object.hasOwn(EFFECTS, name))));
    },
    effects: Object.keys(EFFECTS),
    audioState: () => sound.state(),
    // Renders an effect's sound offline into an AudioBuffer, for previews and checks.
    renderSound: (effect = "settle", cue) => sound.render(effect, cue),
  };
}
