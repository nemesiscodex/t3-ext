# Thread Doom

While the agent in the open thread works, Doom plays over the thread's messages. When the agent asks you something, needs an approval, or finishes, the game pauses and goes away, and the composer gets the keyboard back.

## What it does

- When the open thread starts working, the game appears over the chat column, down to the top of the composer.
- When the thread needs you, finishes, or you open another thread, the game pauses and hides. A subagent that needs you counts for its parent, as in the sidebar.
- A button after the thread title shows or hides the game by hand: **▶ Resume DOOM**, **Hide DOOM**, or **Paused: the agent needs you · ▶ DOOM**.
- One game lives for the whole window, so it carries on from thread to thread.

The game is [doom-js](https://github.com/spipu/doom-js), loaded from `https://doom.spipu.net/`. It needs a network connection, and it plays the shareware episode that site serves.

## How it knows

**What the thread is doing comes from T3's own messages.** T3 sends a `thread.updated` message over its WebSocket whenever a thread's run status or pending request changes. `renderer.js` reads those messages as T3 receives them. Until a thread changes, the extension reads the status label on its sidebar row (Working, Pending Approval, Awaiting Input).

**Pausing needs `main.js`.** The game runs in a frame from another origin, so the T3 window cannot reach into it. The main process can: `main.js` adds a small listener to every Doom frame, which pauses the game and its sound when the window asks. Without `main.js`, the game hides but keeps running, and the console says so. `main.js` loads when T3 Code starts through T3 Code+, or when extensions are attached.

## Try it

From the root of this repository:

```sh
mkdir -p ~/.t3/extensions && ln -s "$PWD/examples/thread-doom" ~/.t3/extensions/thread-doom
```

Then restart T3 Code through T3 Code+, so `main.js` loads. In DevTools, `window.t3Doom.state()` shows what the extension sees.
