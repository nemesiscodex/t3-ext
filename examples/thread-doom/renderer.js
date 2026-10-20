if (!window.t3Doom) {
  // doom-js (github.com/spipu/doom-js), played from its own site. One frame lives for the whole
  // window and is only shown and hidden, so the game carries on from thread to thread.
  const GAME_URL = "https://doom.spipu.net/";
  const GAME_ORIGIN = new URL(GAME_URL).origin;
  const RUNNING = ["preparing", "queued", "starting", "running", "waiting"];
  // The sidebar's status labels, for threads no server message has mentioned yet.
  const ROW_PHASES = { Working: "working", Connecting: "working", "Pending Approval": "needs-you", "Awaiting Input": "needs-you" };

  const guard = (fn) => (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      console.error("[thread-doom]", error);
    }
  };

  // --- What the open thread is doing -----------------------------------------------------------

  // A phase is "working" (play), "needs-you" (a question or an approval) or "idle" (done).
  // T3 sends a `thread.updated` message whenever a thread's run status or pending request
  // changes. Its first snapshot arrives before this script runs, so until a thread changes, its
  // sidebar row says what it is doing.
  const threads = new Map();
  const openThreadId = () => location.hash.match(/^#\/[^/?]+\/([^/?]+)$/)?.[1] ?? null; // "#/<environmentId>/<threadId>"

  function remember(thread) {
    if (!thread?.id) return;
    threads.set(thread.id, {
      working: RUNNING.includes(thread.activityRunStatus ?? thread.status),
      waitingOnYou: thread.pendingRuntimeRequest != null,
      parentId: thread.lineage?.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null,
    });
  }

  function rowPhase(threadId) {
    for (const row of document.querySelectorAll(`[data-thread-item$=":${threadId}"]`)) {
      for (const node of row.querySelectorAll("[aria-label]")) {
        const phase = ROW_PHASES[node.getAttribute("aria-label")];
        if (phase) return phase;
      }
    }
    return "idle";
  }

  // A subagent waiting on you counts for its parent, as in the sidebar.
  function phaseOf(threadId) {
    const thread = threads.get(threadId);
    if (!thread) return rowPhase(threadId);
    const child = [...threads.values()].some((other) => other.parentId === threadId && other.waitingOnYou);
    if (thread.waitingOnYou || child) return "needs-you";
    return thread.working ? "working" : "idle";
  }

  // T3's socket opened before this script ran, so the hook sits on the prototype. It runs
  // inside T3's own code, so it must never throw.
  const onFrame = guard((text) => {
    const values = JSON.parse(text)?.values;
    for (const value of Array.isArray(values) ? values : []) {
      if (value?.kind === "thread.updated") remember(value.thread);
      else if (value?.kind === "snapshot") value.snapshot?.threads?.forEach(remember);
    }
    update();
  });

  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
  const inspected = new WeakSet();
  Object.defineProperty(MessageEvent.prototype, "data", {
    ...data,
    get() {
      const value = data.get.call(this);
      if (typeof value === "string" && !inspected.has(this) && this.target instanceof WebSocket) {
        inspected.add(this);
        if (value.includes('"thread.updated"') || value.includes('"kind":"snapshot"')) onFrame(value);
      }
      return value;
    },
  });

  // --- The game --------------------------------------------------------------------------------

  let host = null;
  let frame = null;
  let pill = null;
  let shown = false;
  let bridged = false;
  let warned = false;
  let lastKey = null;
  let placing = 0;

  // Where the thread's messages are: the chat column, down to the top of the composer.
  function area() {
    const canvas = document.querySelector("[data-chat-canvas]");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const composer = canvas.querySelector("[data-chat-composer-stack]");
    const bottom = composer ? composer.getBoundingClientRect().top - 8 : rect.bottom;
    if (rect.width < 80 || bottom - rect.top < 80) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: bottom - rect.top };
  }

  function create() {
    host = document.createElement("div");
    host.className = "t3-doom";
    frame = document.createElement("iframe");
    frame.src = GAME_URL;
    frame.title = "Doom";
    frame.allow = "fullscreen; gamepad; autoplay";
    host.append(frame);
    pill = document.createElement("button");
    pill.type = "button";
    pill.className = "t3-doom-pill";
    pill.addEventListener("click", () => (shown ? hide() : show()));
    document.body.append(host, pill);
  }

  // The pill sits just after the thread title in the header.
  function place() {
    if (!host) return;
    const box = openThreadId() ? area() : null;
    const title = document.querySelector("[data-chat-header] h2")?.getBoundingClientRect();
    pill.hidden = !box || !title;
    if (!box) return;
    Object.assign(host.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    if (!title) return;
    pill.style.left = `${title.right + 12}px`;
    pill.style.top = `${title.top + title.height / 2}px`;
  }

  function follow() {
    place();
    placing = shown ? requestAnimationFrame(follow) : 0;
  }

  function show() {
    if (!host) create();
    shown = true;
    frame.contentWindow?.postMessage("t3doom:play", GAME_ORIGIN);
    host.classList.add("t3-doom-shown");
    if (!placing) follow();
    label();
  }

  // The game is told to pause while it is still on screen; it fades out and is hidden once it
  // had time to handle that (see style.css). Focus leaves the game, so keys go to T3 again.
  function hide() {
    if (!shown) return;
    shown = false;
    frame.contentWindow?.postMessage("t3doom:pause", GAME_ORIGIN);
    if (!bridged && !warned) {
      warned = true;
      console.warn("[thread-doom] main.js is not loaded, so the game cannot be paused. Restart T3 Code through T3 Code+.");
    }
    host.classList.remove("t3-doom-shown");
    if (document.activeElement === frame) {
      frame.blur();
      document.querySelector('[data-chat-composer-form] [contenteditable="true"], [data-chat-composer-form] textarea')?.focus();
    }
    label();
  }

  function label() {
    if (!pill) return;
    const threadId = openThreadId();
    const phase = threadId ? phaseOf(threadId) : "idle";
    pill.textContent = shown ? "Hide DOOM" : phase === "needs-you" ? "Paused: the agent needs you · ▶ DOOM" : "▶ Resume DOOM";
  }

  // The game comes up when the open thread starts working, and goes away when it stops or needs
  // you, or when you leave the thread. In between, the pill shows or hides it by hand.
  const update = guard(() => {
    const threadId = openThreadId();
    const phase = threadId && area() ? phaseOf(threadId) : "away";
    const key = `${threadId}:${phase}`;
    if (key !== lastKey) {
      lastKey = key;
      if (phase === "working") show();
      else hide();
    }
    place();
    label();
  });

  addEventListener("message", (event) => {
    if (event.origin === GAME_ORIGIN && event.data === "t3doom:ready") bridged = true;
  });
  addEventListener("hashchange", update);
  setInterval(update, 500);

  window.t3Doom = {
    show,
    hide,
    // What the extension sees, for checks in DevTools.
    state: () => ({ threadId: openThreadId(), phase: openThreadId() ? phaseOf(openThreadId()) : null, shown, loaded: !!frame, bridged }),
  };
}
