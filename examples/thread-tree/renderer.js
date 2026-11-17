{
  const LOG = "[thread-tree]";
  const THREAD_ROWS = "li[data-thread-item]";
  const DEPTH = "data-thread-tree-depth";
  const MAX_DEPTH = 4;
  const BATCH = 100;
  const ASK_AGAIN_MS = 500;
  // lucide's corner-left-up (ISC license).
  const PARENT_ICON = [["path", { d: "M14 9 9 4 4 9" }], ["path", { d: "M20 20h-7a4 4 0 0 1-4-4V4" }]];

  const warned = new Set();
  function warnOnce(message, error) {
    if (!warned.has(message)) console.warn(LOG, message, ...(error ? [error] : []));
    warned.add(message);
  }

  // --- Order ------------------------------------------------------------------------------------

  // `entries` is a list's children in T3's order: { key } for a thread row ("<environmentId>:
  // <threadId>"), { key: null } for anything else. Returns [{ entry, depth }] with each thread
  // after its parent, and [{ copy: parentKey, run, depth: 0 }] where a parent copy goes. A thread
  // nests only within its own run of rows, so T3's sections and project folders keep their
  // threads. A parent outside the run shows as a copy above its children, when its title is known.
  function treeOrder(entries, parentOf, titleOf) {
    const out = [];
    let run = [];
    let runs = 0;
    const endRun = () => {
      if (run.length) out.push(...treeOfRun(run, runs++, parentOf, titleOf));
      run = [];
    };
    for (const entry of entries) {
      if (entry.key !== null) run.push(entry);
      else {
        endRun();
        out.push({ entry, depth: 0 });
      }
    }
    endRun();
    return out;
  }

  function treeOfRun(run, index, parentOf, titleOf) {
    const byKey = new Map();
    for (const entry of run) if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    const parentIn = (key) => {
      const parent = parentOf(key);
      return parent != null && parent !== key && byKey.has(parent) ? parent : null;
    };
    const onCycle = (key) => {
      for (let at = parentIn(key), i = 0; at !== null && i < byKey.size; at = parentIn(at), i++) if (at === key) return true;
      return false;
    };
    // The run's top level in T3's order: rows, and one group per parent outside the run, at the
    // place of its first child.
    const tops = [];
    const groups = new Map();
    const children = new Map();
    for (const entry of run) {
      const parent = onCycle(entry.key) ? null : parentIn(entry.key);
      if (parent !== null) {
        if (children.has(parent)) children.get(parent).push(entry);
        else children.set(parent, [entry]);
        continue;
      }
      const outside = parentOf(entry.key);
      if (outside == null || outside === entry.key || byKey.has(outside) || titleOf(outside) == null) tops.push(entry);
      else if (groups.has(outside)) groups.get(outside).members.push(entry);
      else {
        const group = { copy: outside, members: [entry] };
        groups.set(outside, group);
        tops.push(group);
      }
    }
    const out = [];
    const visit = (entry, depth) => {
      out.push({ entry, depth: Math.min(depth, MAX_DEPTH) });
      if (byKey.get(entry.key) !== entry) return;
      for (const child of children.get(entry.key) ?? []) visit(child, depth + 1);
    };
    for (const top of tops) {
      if (!top.members) visit(top, 0);
      else {
        out.push({ copy: top.copy, run: index, depth: 0 });
        for (const entry of top.members) visit(entry, 1);
      }
    }
    return out;
  }

  // --- Arranging T3's list ----------------------------------------------------------------------

  // After the first move, the page no longer shows T3's order, so it comes from React: the list's
  // own elements, in the order React renders them. Anything else in the list stays where it is.
  function reactChildren(list) {
    const fiber = ext.t3.fiberOf(list);
    if (!fiber) return null;
    const out = [];
    const visit = (first) => {
      for (let node = first; node; node = node.sibling) {
        if (typeof node.type !== "string") visit(node.child);
        else if (node.stateNode?.parentNode === list) out.push(node.stateNode);
      }
    };
    visit(fiber.child);
    return out;
  }

  // Moves only what is out of place, so the observer's next run, on these moves, moves nothing.
  function place(list, order, owned) {
    let previous = null;
    for (const element of order) {
      let next = previous ? previous.nextSibling : list.firstChild;
      while (next && !owned.has(next)) next = next.nextSibling;
      if (next !== element) list.insertBefore(element, next);
      previous = element;
    }
  }

  function setDepth(element, depth) {
    if (depth === 0) {
      if (element.hasAttribute(DEPTH)) element.removeAttribute(DEPTH);
    } else if (element.getAttribute(DEPTH) !== String(depth)) element.setAttribute(DEPTH, String(depth));
  }

  // --- Parent copies ----------------------------------------------------------------------------

  const keyOf = (row) => `${row.environmentId}:${row.threadId}`;
  const splitKey = (key) => ({ environmentId: key.slice(0, key.indexOf(":")), threadId: key.slice(key.indexOf(":") + 1) });

  // Freshest first: the parent's own row, then T3's latest update, then T3's database.
  function titleOf(key, rendered) {
    const row = rendered.get(key);
    const fromRow = row && ext.t3.rowData(row)?.thread?.title;
    if (typeof fromRow === "string" && fromRow) return fromRow;
    const fromShell = ext.t3.threads.get(splitKey(key).threadId)?.title;
    if (typeof fromShell === "string" && fromShell) return fromShell;
    return titles.get(key) ?? null;
  }

  // T3's own row click handler runs when the parent has a row; otherwise its route opens it.
  function openThread(key) {
    const { environmentId, threadId } = splitKey(key);
    const row = ext.t3.threadRows(threadId).find((candidate) => candidate.environmentId === environmentId);
    const target = row?.element.querySelector("[data-sidebar-row]");
    if (target) target.click();
    else location.hash = `#/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  }

  function createCopy(key) {
    const label = ext.ui.el("span", { className: "thread-tree-parent-title" });
    const button = ext.ui.el("button", { type: "button", onClick: () => openThread(key) }, ext.ui.icon(PARENT_ICON, "thread-tree-parent-icon"), label);
    const element = ext.ui.el("li", { className: "thread-tree-parent", "data-thread-tree-parent": key }, button);
    return { element, button, label, title: null };
  }

  function setTitle(copy, title) {
    if (copy.title === title) return;
    copy.title = title;
    copy.label.textContent = title;
    copy.button.setAttribute("title", `Open parent thread: ${title}`);
    copy.button.setAttribute("aria-label", `Open parent thread: ${title}`);
  }

  // Each list's copies, by "<run>:<parent key>", kept across runs of the observer.
  const copiesOf = new WeakMap();

  function arrange(list, rendered) {
    const children = reactChildren(list);
    if (!children) return warnOnce("could not read T3's sidebar list from React; it stays as T3 draws it");
    const entries = children.map((element) => {
      const row = ext.t3.rowOf(element);
      if (row?.element !== element) return { element, key: null };
      const key = keyOf(row);
      learn(element, key, row);
      return { element, key };
    });
    const title = (key) => titleOf(key, rendered);
    const order = treeOrder(entries, (key) => parents.get(key), title);

    const copies = copiesOf.get(list) ?? new Map();
    const kept = new Map();
    const elements = order.map((item) => {
      if (!item.copy) return item.entry.element;
      const id = `${item.run}:${item.copy}`;
      const copy = copies.get(id) ?? createCopy(item.copy);
      setTitle(copy, title(item.copy));
      kept.set(id, copy);
      return copy.element;
    });
    for (const [id, copy] of copies) if (!kept.has(id) && copy.element.parentNode) copy.element.remove();
    copiesOf.set(list, kept);

    place(list, elements, new Set(elements));
    for (const { entry, depth } of order) if (entry && entry.key !== null) setDepth(entry.element, depth);
  }

  function refresh() {
    const rows = [...document.querySelectorAll(THREAD_ROWS)];
    const rendered = new Map();
    for (const element of rows) {
      const row = ext.t3.rowOf(element);
      if (row && !rendered.has(keyOf(row))) rendered.set(keyOf(row), element);
    }
    for (const list of new Set(rows.map((row) => row.parentNode))) if (list.nodeName === "UL") arrange(list, rendered);
    ask();
  }

  // --- Parents, from main.js --------------------------------------------------------------------

  // Row key -> its parent's row key, or null. Only threads made through T3's MCP tools have one.
  const parents = new Map();
  // Parent row key -> its title, from main.js, for parents the window may never have seen.
  const titles = new Map();
  // Row keys T3 could not answer yet, because the thread has no message yet: asked again when T3
  // sends an update for the thread.
  const waiting = new Map();
  const wanted = new Map();
  const asked = new Map();
  let broken = false;
  // False until the saved answers are in, so they are not asked for again.
  let loaded = false;
  let againTimer = null;

  function learn(element, key, row) {
    if (broken || parents.has(key) || waiting.has(key) || wanted.has(key) || asked.has(key)) return;
    const thread = ext.t3.rowData(element)?.thread;
    if (!thread) return warnOnce("could not read a sidebar row's thread; launched threads stay where T3 puts them");
    // When T3 moves this field, every row is asked: main.js answers null for a thread a person started.
    const source = thread.source?.creationSource;
    if (source !== undefined && source !== "mcp") parents.set(key, null);
    else wanted.set(key, { environmentId: row.environmentId, threadId: row.threadId });
  }

  // One request at a time, for one environment, since main answers by thread id.
  async function ask() {
    if (!loaded || broken || asked.size || !wanted.size) return;
    const { environmentId } = wanted.values().next().value;
    for (const [key, row] of wanted) {
      if (row.environmentId !== environmentId) continue;
      asked.set(key, row);
      wanted.delete(key);
      if (asked.size === BATCH) break;
    }
    let learned = false;
    const answered = {};
    try {
      const answer = await ext.main.invoke("parents", [...asked.values()]);
      const found = answer?.parents ?? {};
      for (const [threadId, title] of Object.entries(answer?.titles ?? {})) {
        if (typeof title === "string" && title) titles.set(`${environmentId}:${threadId}`, title);
      }
      for (const [key, row] of asked) {
        if (Object.hasOwn(found, row.threadId)) {
          const parent = found[row.threadId];
          parents.set(key, typeof parent === "string" ? `${environmentId}:${parent}` : null);
          answered[key] = parents.get(key);
          wanted.delete(key);
          learned ||= typeof parent === "string";
        } else if (!wanted.has(key)) waiting.set(key, row);
      }
    } catch (error) {
      broken = true;
      wanted.clear();
      waiting.clear();
      warnOnce("could not ask main.js for launched threads' parents; the sidebar stays as T3 draws it. Restart T3 Code through T3 Code+ so main.js loads.", error);
    } finally {
      asked.clear();
    }
    if (Object.keys(answered).length) {
      ext.config
        .update((value) => ({ version: 1, parents: { ...savedParents(value), ...answered } }))
        .catch((error) => warnOnce("could not save launched threads' parents; they are asked for again after a restart", error));
    }
    try {
      if (learned) refresh();
      else ask();
    } catch (error) {
      console.error(LOG, error);
    }
  }

  // Saved by the host for every window: { version: 1, parents: { "<environmentId>:<threadId>":
  // "<environmentId>:<parentThreadId>" | null } }. A parent never changes, so a saved answer holds.
  function savedParents(value) {
    const saved = {};
    if (value?.version !== 1 || typeof value.parents !== "object" || value.parents === null) return saved;
    for (const [key, parent] of Object.entries(value.parents)) {
      if (key.includes(":") && (parent === null || (typeof parent === "string" && parent.includes(":")))) saved[key] = parent;
    }
    return saved;
  }

  ext.config.subscribe((value) => {
    let learned = !loaded;
    loaded = true;
    for (const [key, parent] of Object.entries(savedParents(value))) {
      if (parents.has(key)) continue;
      parents.set(key, parent);
      wanted.delete(key);
      waiting.delete(key);
      learned ||= parent !== null;
    }
    try {
      if (learned) refresh();
    } catch (error) {
      console.error(LOG, error);
    }
  });

  ext.t3.threads.subscribe((event) => {
    if (event.kind !== "updated" || broken) return;
    let again = false;
    for (const pending of [waiting, asked]) {
      for (const [key, row] of pending) {
        if (row.threadId !== event.shell.id) continue;
        wanted.set(key, row);
        waiting.delete(key);
        again = true;
      }
    }
    if (again && againTimer === null) {
      againTimer = setTimeout(() => {
        againTimer = null;
        ask();
      }, ASK_AGAIN_MS);
    }
  });

  // Runs right after each change React makes, before the next paint, so rows never flash in T3's
  // order. Only changes to the list itself can change the order.
  const isThreadRow = (node) => node.nodeType === 1 && node.matches(THREAD_ROWS);
  const touchesRows = (mutation) =>
    (mutation.target.nodeName === "UL" && [...mutation.target.children].some(isThreadRow)) ||
    [...mutation.addedNodes].some((node) => node.nodeType === 1 && (node.matches(THREAD_ROWS) || node.querySelector(THREAD_ROWS)));
  new MutationObserver((mutations) => {
    try {
      if (mutations.some(touchesRows)) refresh();
    } catch (error) {
      console.error(LOG, error);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.t3ThreadTree = {
    // "<environmentId>:<threadId>" -> its parent's, for each launched thread seen in the sidebar.
    get parents() {
      return Object.fromEntries([...parents].filter(([, parent]) => parent !== null));
    },
    get waiting() {
      return [...waiting.keys()];
    },
  };

  refresh();
}
