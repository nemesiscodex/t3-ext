# Thread Tree

When an agent starts other threads with T3's `t3_thread_launch` or `create_threads` tools, those threads show right below the thread that started them in the sidebar, indented one step per level, with a thin guide line in the indent. A thread an agent started from one of those threads shows below it, one level deeper.

## What it does

- A launched thread moves below its parent, and its own launched threads below it. Siblings keep T3's order among themselves.
- A thread nests only under a parent in the same group of rows: the same section (Pinned, Active, Working, Snoozed, Settled) or the same project folder. So settling, snoozing and project folders work as before.
- When the parent is in another group, or not shown at all (collapsed, archived, or never loaded), the launched threads stay in their own group, under a **parent copy**: a small, quiet row with an arrow and the parent's title. All the threads in one group that share that parent gather under one copy, placed where the first of them sits. Clicking the copy opens the parent. When the parent's title is not known, no copy shows, and the thread stays where T3 put it, without an indent.
- A thread launched by a subagent counts as launched by the thread the subagent belongs to, since subagents have no row.
- The indent stops growing after four levels.
- The arrow keys move through the rows in the order you see them, since T3 walks them in page order.

Nothing else changes. Threads you start yourself and forks stay where T3 puts them. Launched threads on linked machines nest like local ones.

## How it finds what it needs

**Which thread started a thread is not in the sidebar.** T3 gives every thread a `lineage`, but for a launched thread its `parentThreadId` is empty. The launching thread is recorded only as the `senderThreadId` of the launched thread's first message (in T3's source, `apps/server/src/mcp/toolkits/project/handlers.ts` for `t3_thread_launch` and `OrchestratorMcpService.ts` for `create_threads`). The window does not load those messages for threads that are not open.

**So `main.js` asks T3's own MCP server.** The launching thread's first message lives on the machine that runs the thread. With linked environments, that is often another machine, whose database this Mac cannot read. T3's MCP server can: its `t3_thread_read` tool reads a thread on any linked environment, and T3 forwards the call itself. `main.js` calls it over the server's Streamable HTTP endpoint, `POST <origin>/mcp`, where the origin comes from `$T3CODE_HOME/userdata/server-runtime.json` (`~/.t3` by default), read again after the server cannot be reached.

**It uses its own read-only token.** The first time it needs one, `main.js` runs T3's `t3` command with T3's own binary, the way `~/.t3/bin/t3` does: `t3 auth session issue --scope orchestration:read --subject mcp-client --ttl 12h --label "Thread Tree" --json`. The token can read threads and nothing else, lives only in `main.js`'s memory, never in a file or a log, and expires after 12 hours. It shows in T3's list of sessions (`t3 auth session list`) as "Thread Tree". When the server refuses it, `main.js` gets a new one and revokes the old one, and it revokes the token in use when T3 Code quits.

For each launched thread the window asks about, `main.js` calls `t3_thread_read` with the row's `environmentId` and `{ afterPosition: -1, limit: 1, maxCharsPerItem: 1, runLimit: 1 }`, which returns the thread and its first item, about 5 KB:

1. Only a thread whose `thread.creationSource` is `"mcp"` was launched by an agent. Any other thread has no parent.
2. The first item's `senderThreadId` is the parent. When the sender is a subagent (`thread.relationshipToParent` is `"subagent"`), it reads the sender and follows `thread.parentThreadId` up to the first thread that is not one, at most 20 steps.
3. The parent's `thread.title` is the copy's title. A parent T3 no longer has (`thread_not_found`) gets no title.

It answers `{ parents: { [threadId]: parentThreadId | null }, titles: { [parentThreadId]: title } }`, for rows of one environment at a time. At most four calls run at once. A thread's parent never changes, so `main.js` keeps each answer, and keeps titles for five minutes. The window reaches `main.js` through `ext.main.invoke("parents", rows)`, and saves each answer in its config as `{ version: 1, parents: { "<environmentId>:<threadId>": "<environmentId>:<parentThreadId>" | null } }`, so after a restart the tree shows at once and only new threads are asked about. Titles are not saved.

A thread with no message yet, as right after a launch, gets no answer, and the window asks again when T3 next updates that thread. So does every thread while T3's server cannot be reached or refuses the token; `main.js` then logs once. A thread T3 does not know gets no parent.

**When T3 changes,** check these first: the `t3 auth session issue` flags and its `--json` output (`token`, `sessionId`); that a token needs `--subject mcp-client` for `/mcp`; the `server-runtime.json` `origin`; and the fields above in `t3_thread_read`'s result, in its `structuredContent` or as JSON in its first text content.

**The rows are moved, not redrawn.** T3's sidebar is one `<ul>` of `<li>`s: thread rows (`data-thread-item="<environmentId>:<threadId>"`) mixed with section headers and project folder headers. After each change React makes to that list, a `MutationObserver` reads the list's order from React, not from the page, since the page shows the moved order: it takes the list's live fiber (`ext.t3.fiberOf`) and collects its elements in the order React renders them. It splits them into runs of thread rows between the other items, puts each launched thread after its parent within the run, and moves the `<li>`s inside the same list with `insertBefore`, only those out of place. React keeps working: it finds each row under the same list when it next moves or removes it, and the observer sorts again right after, before the next paint. It reads each row's thread, for `creationSource`, from the row's React props with `ext.t3.rowData`. A nested row gets `data-thread-tree-depth="1"` to `"4"`, which `style.css` turns into `padding-inline-start` and the guide lines, drawn with T3's `var(--border)`.

**Parent copies are the extension's own rows.** A copy is an `<li class="thread-tree-parent" data-thread-tree-parent="<environmentId>:<threadId>">` that the extension puts into T3's list, holding one button. React does not know about it and leaves it alone. The same copy element is kept while it is wanted, and its text is written only when the title changes. Its title comes from the freshest source: the parent's own row (`ext.t3.rowData`), then T3's latest update for the thread (`ext.t3.threads.get`), then `main.js`. A click clicks the parent's own `[data-sidebar-row]` element, so T3's own handler opens it, or, with no row, sets T3's route, `#/<environmentId>/<threadId>`. The copy has no `data-sidebar-row`, so T3's arrow keys skip it.

If T3 renames `data-thread-item`, or the list's fiber cannot be found, the extension logs it once and leaves the list alone.

## Known limits

- Dragging a row in a group that has nested rows can show the drop preview in the wrong place, because T3's drag and drop expects the rows in its own order. After the drop, the rows are arranged again.
- A launched thread whose first message is older than T3 recording `senderThreadId` has no known parent and stays where T3 puts it.
- When a parent is renamed, its copies show the new title the next time T3 changes the list, not at once.

## Try it

From the root of this repository:

```sh
mkdir -p ~/.t3/extensions && ln -s "$PWD/examples/thread-tree" ~/.t3/extensions/thread-tree
```

Then restart T3 Code through T3 Code+, so `main.js` loads. In DevTools, `window.t3ThreadTree.parents` shows each launched thread the window has seen with its parent, and `window.t3ThreadTree.waiting` the ones with no answer yet.
