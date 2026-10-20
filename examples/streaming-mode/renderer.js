if (!window.t3StreamingMode) {
  const STORAGE_KEY = "t3ext.streaming-mode";
  const LOG = "[streaming-mode]";
  const TRIGGER = 'button[data-slot="combobox-trigger"][aria-label^="Filter threads by project"]';
  const MARK = "data-t3sm-blur";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const GITHUB = "github.com/";
  const RECHECK_MS = 24 * 60 * 60 * 1000;
  const RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
  // T3's label for threads outside any project. It names nothing.
  const PLACEHOLDER = "No project";

  // From T3's bundle (lucide, ISC license).
  const ICONS = {
    eye: [["path", { d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
    "eye-off": [
      ["path", { d: "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" }],
      ["path", { d: "M14.084 14.158a3 3 0 0 1-4.242-4.242" }],
      ["path", { d: "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" }],
      ["path", { d: "m2 2 20 20" }],
    ],
  };

  // --- Saved state ------------------------------------------------------------------------------

  // on:      streaming mode is on.
  // repos:   "github.com/owner/name" -> { public, checkedAt }, what GitHub said without a login.
  // secrets: every name and path of a project not known to be public, from the last time T3's
  //          project list was readable, so names stay blurred while the sidebar is collapsed.
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved?.version === 1) return { version: 1, on: saved.on === true, repos: saved.repos ?? {}, secrets: Array.isArray(saved.secrets) ? saved.secrets : [] };
    } catch {}
    return { version: 1, on: false, repos: {}, secrets: [] };
  }

  let state = load();
  let secrets;
  let longest;
  function setSecrets(list) {
    secrets = new Set(list);
    longest = Math.max(0, ...list.map((text) => text.length));
  }
  setSecrets(state.secrets);
  const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  // --- Reading T3 -------------------------------------------------------------------------------

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

  // The sidebar's memoized project catalog, found from T3's project filter button.
  function readCatalog(trigger) {
    for (let fiber = fiberOf(trigger), i = 0; fiber && i < 80; fiber = fiber.return, i++) {
      for (const cached of fiber.updateQueue?.memoCache?.data ?? []) {
        for (const value of Array.isArray(cached) ? cached : []) {
          if (Array.isArray(value?.projectGroups) && value.projectGroups.every((group) => Array.isArray(group?.memberProjects))) return value;
        }
      }
    }
    return null;
  }

  // "github.com/owner/name" for a project on github.com, null for any other remote or none.
  function repoOf(project) {
    const key = project.repositoryIdentity?.canonicalKey?.toLowerCase();
    return key?.startsWith(GITHUB) && key.split("/").length === 3 ? key : null;
  }

  const isPublic = (repo) => repo !== null && state.repos[repo]?.public === true;

  // Every text T3 shows for a project that is not known to be public: the sidebar name, the
  // folder name, its path, and its repository's name.
  function secretsOf(catalog) {
    const found = new Set();
    for (const group of catalog.projectGroups) {
      const hidden = group.memberProjects.filter((project) => !isPublic(repoOf(project)));
      if (hidden.length) found.add(group.displayName);
      for (const project of hidden) {
        const identity = project.repositoryIdentity;
        [project.title, project.workspaceRoot, identity?.displayName, identity?.canonicalKey].forEach((text) => found.add(text));
      }
    }
    return [...found].filter((text) => typeof text === "string" && text.trim() && text !== PLACEHOLDER).map((text) => text.trim()).sort();
  }

  // --- Asking GitHub ----------------------------------------------------------------------------

  // Without a login GitHub answers 200 for a public repository and 404 for a private one. It
  // allows 60 requests an hour, so answers are kept for a day and a rate limit pauses checks.
  const checking = new Set();
  let pausedUntil = 0;
  let projectRepos = [];

  // "answered", "limited", "failed", or "skipped" when a check is already running or paused.
  // Without an answer the repository keeps its last one, or stays blurred.
  async function check(repo) {
    if (checking.has(repo) || Date.now() < pausedUntil) return "skipped";
    checking.add(repo);
    try {
      const response = await fetch(`https://api.github.com/repos/${repo.slice(GITHUB.length)}`, { headers: { Accept: "application/vnd.github+json" } });
      if (response.status === 200 || response.status === 404) {
        const visible = response.status === 200 && (await response.json()).private === false;
        state = { ...state, repos: { ...state.repos, [repo]: { public: visible, checkedAt: Date.now() } } };
        save();
        sync();
        return "answered";
      }
      if (response.status === 403 || response.status === 429) {
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
        pausedUntil = reset > Date.now() ? reset : Date.now() + RATE_LIMIT_PAUSE_MS;
        return "limited";
      }
      return "failed";
    } catch {
      return "failed";
    } finally {
      checking.delete(repo);
    }
  }

  // Right-clicking the eye asks GitHub about every repository again, whatever the age of its
  // answer, so one you just made public shows up.
  let checkingAll = false;
  let lastCheck = null; // { at, total, answered, limited, failed }

  async function checkAll() {
    if (checkingAll) return;
    const repos = [...new Set([...projectRepos, ...Object.keys(state.repos)])];
    checkingAll = true;
    pausedUntil = 0;
    paintButton();
    const results = await Promise.all(repos.map(check));
    const count = (kind) => results.filter((result) => result === kind).length;
    lastCheck = { at: Date.now(), total: repos.length, answered: count("answered"), limited: count("limited"), failed: count("failed") };
    checkingAll = false;
    paintButton();
  }

  function checkStale(repos, maxAgeMs) {
    for (const repo of new Set(repos)) {
      const known = state.repos[repo];
      if (!known || Date.now() - known.checkedAt > maxAgeMs) check(repo);
    }
  }

  // --- Blurring ---------------------------------------------------------------------------------

  // The closest element whose whole text is a secret. Walking up covers a name split over
  // several nodes, as when sidebar search highlights the matched part.
  function evaluate(node) {
    if (!state.on || !secrets.size) return;
    for (let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node, i = 0; element && i < 4; element = element.parentElement, i++) {
      const text = element.textContent.trim();
      if (text.length > longest) return;
      if (secrets.has(text)) return element.setAttribute(MARK, "");
    }
  }

  function scan(root) {
    if (root.nodeType === Node.TEXT_NODE) return evaluate(root);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()); ) if (node.data.trim()) evaluate(node);
  }

  // A blurred element whose text changed to something that is not a secret.
  function unmarkStale(node) {
    const element = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest(`[${MARK}]`);
    if (element && !(state.on && secrets.has(element.textContent.trim()))) element.removeAttribute(MARK);
  }

  function rescan() {
    document.querySelectorAll(`[${MARK}]`).forEach((element) => element.removeAttribute(MARK));
    if (state.on) scan(document.body);
  }

  // --- The eye button ---------------------------------------------------------------------------

  function lucide(name) {
    const icon = document.createElementNS(SVG_NS, "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "t3sm-icon" })) icon.setAttribute(key, value);
    for (const [tag, attributes] of ICONS[name]) {
      const part = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, value);
      icon.append(part);
    }
    return icon;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("data-t3sm-toggle", "");
  button.addEventListener("click", () => setOn(!state.on));
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    checkAll();
  });

  // After T3's filter button and its hidden input, before "Add project".
  function placeButton(trigger) {
    const anchor = trigger.nextElementSibling?.tagName === "INPUT" ? trigger.nextElementSibling : trigger;
    if (anchor.nextElementSibling !== button) anchor.after(button);
    if (button.className !== trigger.className) button.className = trigger.className;
    paintButton();
  }

  const clock = (time) => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function checkStatus() {
    if (checkingAll) return "Checking GitHub…";
    if (!lastCheck) return "Right-click to check GitHub again.";
    const { at, total, answered, limited, failed } = lastCheck;
    if (limited) return `GitHub's rate limit stopped ${limited} of ${total} checks. Right-click to try again after ${clock(pausedUntil)}.`;
    if (failed) return `${failed} of ${total} checks failed. Right-click to try again.`;
    return `Checked ${answered} repositories on GitHub at ${clock(at)}. Right-click to check again.`;
  }

  let painted = "";

  function paintButton() {
    const label = state.on ? "Streaming mode is on: show project names" : "Streaming mode: blur private project names";
    const title = `${label}\n${checkStatus()}`;
    if (painted === `${state.on}\n${title}`) return;
    painted = `${state.on}\n${title}`;
    button.setAttribute("aria-pressed", String(state.on));
    button.setAttribute("aria-label", label);
    button.toggleAttribute("data-t3sm-checking", checkingAll);
    button.title = title;
    button.replaceChildren(lucide(state.on ? "eye-off" : "eye"));
  }

  // --- Keeping it applied -----------------------------------------------------------------------

  let warned = false;

  function sync() {
    const trigger = document.querySelector(TRIGGER);
    if (!trigger) return;
    placeButton(trigger);
    const catalog = readCatalog(trigger);
    if (!catalog) {
      if (!warned) console.warn(LOG, "could not read T3's project list; blurring the names it last saw");
      warned = true;
      return;
    }
    projectRepos = catalog.projectGroups.flatMap((group) => group.memberProjects.map(repoOf)).filter(Boolean);
    checkStale(projectRepos, RECHECK_MS);
    const next = secretsOf(catalog);
    if (next.join("\n") === state.secrets.join("\n")) return;
    state = { ...state, secrets: next };
    setSecrets(next);
    save();
    rescan();
  }

  function setOn(on) {
    state = { ...state, on };
    save();
    paintButton();
    rescan();
  }

  // Marks are set right after each change, before the next paint, so a name never flashes.
  // Changes in the chat area cannot change the project list, so they skip reading it.
  new MutationObserver((mutations) => {
    try {
      const inChat = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('[data-slot="sidebar-inset"]');
      if (mutations.some((mutation) => !button.contains(mutation.target) && !inChat(mutation.target))) sync();
      for (const mutation of mutations) {
        unmarkStale(mutation.target);
        if (mutation.type === "characterData") evaluate(mutation.target);
        else mutation.addedNodes.forEach(scan);
      }
    } catch (error) {
      console.error(LOG, error);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Another T3 window turned streaming mode on or off, or learned a repository's visibility.
  addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    state = load();
    setSecrets(state.secrets);
    paintButton();
    rescan();
  });

  window.t3StreamingMode = {
    get on() {
      return state.on;
    },
    set on(on) {
      setOn(Boolean(on));
    },
    get repos() {
      return structuredClone(state.repos);
    },
    get secrets() {
      return [...secrets];
    },
    // Same as right-clicking the eye. Resolves with { at, total, answered, limited, failed }.
    async refresh() {
      await checkAll();
      return lastCheck;
    },
  };

  sync();
  rescan();
}
