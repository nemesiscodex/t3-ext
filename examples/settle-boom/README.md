# Settle Boom

When a thread changes, its sidebar row plays a short effect with a synthesized sound: when it starts work, needs you, finishes, is snoozed, wakes up, or settles. Settling is the big one: the row shakes, charges up and explodes, and the thread moves to Settled only once the explosion is over. The look and sound follow Kit Langton's [Effect Institute](https://www.effect.institute/): off-white ink on black, a dot grid, thin rings, glitch glyphs, small green squares, and Tone.js-style voices.

![Frames at 150, 330, 415, 480, 600 and 900 ms](preview.png)

## What it does

| Change | Where it plays | What you see | What you hear |
| --- | --- | --- | --- |
| **Start** | on the row | A flash, three soft blue bands sweeping across the row, a pulse of its border, and a brief jitter | One quiet "running" blip, a pentatonic note from C5 to A5 |
| **Wait**: the agent needs your approval or an answer | on the row | An amber outline breathes twice while radar rings go out from the row's left edge. A "■ NEEDS APPROVAL" or "■ NEEDS INPUT" label shows next to the row | A soft chime, C5 then E5 |
| **Done** | on the row | A green flash, a soft ring growing out of the row, and green squares popping up from its status | One quiet triangle note in octave 4 |
| **Snooze** | on a copy of the row, which leaves for Snoozed | The copy turns grey, switches off like an old CRT (it squeezes into a bright line, then a dot), and z's drift up. A "■ SNOOZED" label shows the title and the time it wakes | Two falling notes, G3 then C3 |
| **Wake** | on the row, once it is back in Active | The card springs into place with a flash, an amber border and radar rings from its "Woke" status. A "■ WOKE" label shows next to it | A pager, B4 E5 B4 E5, when the snooze runs out; three rising notes, E5 G5 C6, when you wake it yourself |
| **Settle** | on a copy of the row, which leaves for Settled | The explosion below | The boom below |

Start and done happen often, so they have no label. The labels are drawn like T3 tooltips, in the colors of the current theme, with the square in T3's own color for that status. On the light theme the effects use T3's foreground and status colors, because the Institute's pale ink and pastels would not show on a white sidebar.

The settle explosion:

1. **Charge:** a copy of the row stays where the row was, then shakes harder and brightens for 0.4 seconds while three quick rising ticks play. It then bursts.
2. **Flash:** a white core flashes.
3. **Rings:** three thin rings expand, the middle one dashed and turning.
4. **Dot grid:** a shock wave lights up a dot grid as it passes.
5. **Debris:** sparks streak out, and glyphs fly out, flicker through `@#$%&*/=-+?!~<>\|█▓▒░` and cool into squares.
6. **Label:** a "■ SETTLED" label with the thread's title resolves letter by letter, then blurs away.
7. **Shake:** the window shakes slightly.

Its sound has four parts:

- **Ticks:** three short rising sine blips while the row charges, like Effect Institute's "running" sound.
- **Blast:** a filtered noise burst and a sub thump.
- **Stab:** Effect Institute's distorted, detuned-saw "death" stab and low rumble.
- **Chime:** its triangle "success" triad, C5, E5 and G5, through reverb.

Start, wait and done play only when the row is on screen and the window is visible. A subagent's question plays on its parent's row; nothing else plays for subagents. When several threads change together, the sound plays once. When several threads finish within 100 ms, their notes stack into a chord (the root, then +4 and +7 semitones), as in the Institute. Each change plays once. When one thread goes through several changes within a second, only the most important plays: settle, then wait, wake, done and start. Snooze always plays.

With **Reduce motion** on in macOS, the effects keep their flash, outline, one ring, label and sound, and drop the rest of the movement: no jitter, sweep, spring, debris, CRT or z's. Settling fades the row instead of shaking it.

T3 can play its own sounds when a thread finishes or needs you: **Settings > General > Thread notifications**, set to "Sound only" or "Notifications with sound". It is off by default. If you turn it on, done and wait play two sounds, T3's and this one. Turn one of them off, for example with `t3SettleBoom.off = ["done", "wait"]`.

## How it knows

T3's server sends a `thread.updated` message with the whole thread after every change, with no event type. The extension keeps the last version of each thread and compares the next one with it, the way T3's own notifications do:

- **Start:** the thread is working (preparing, queued, starting, running, or finishing its turn) on a run it was not working on before.
- **Wait:** it has a new pending request that waits on you, as T3's sidebar decides: an approval, or a question. A question the agent keeps working past does not count until the run stops.
- **Done:** its run completed and T3's sidebar shows it as ready. A run you stopped does not count.
- **Snooze** and **settle:** it has a new `snoozedAt` or `settledAt`.
- **Wake:** a snooze that had not run out yet ended without a settle, for example from another window or by pinning or writing to the thread.

A change plays only if it happened after the window loaded, less than 30 seconds ago. So a reload, or opening the app with threads that are working, done, snoozed or waiting, plays nothing. When T3 reconnects, the server replays what changed while it was away, up to a `synchronized` message; those replays only set the starting point.

Some changes show up before the server reports them:

- **The Settle button and ⌘⇧S are held.** The extension stops the click or key press before T3 sees it and hides the real row behind the effect. About 1.8 seconds later, when the debris is gone, it replays the same click or key press. T3 then settles as usual, with its "⌘Z to undo". If you moved to another thread in the meantime, it clicks the row's Settle button instead. Only T3's default ⌘⇧S is held; a remapped shortcut settles at once.
- **Settling from the menu, snoozing and waking yourself** send a `thread.settle`, `thread.snooze` or `thread.unsnooze` command to T3's server, and T3 moves the row right after. The extension catches the command as it is sent, so the settle and snooze effects start on a copy of the row while it is still on screen. A woken thread's effect waits up to two seconds for its card to appear in Active.
- **A snooze that runs out** ends only in T3's sidebar, on a timer; the server sends nothing. T3 then shows the card in Active with a "Woke" button. The extension watches for that button, and plays the wake when the row's `wokeAt` (read from T3's React props) is recent.

T3's connection opens before `renderer.js` runs, so the hooks wrap `WebSocket.prototype.send` and the `MessageEvent` `data` getter. They run inside T3's own code, so they never throw.

Rows are found by `data-thread-item="<environmentId>:<threadId>"`. If the row of a settle or snooze is not on screen (a filter hides it, or its project is collapsed), or a T3 update renames that attribute, the effect plays without the charge in the middle of the window. Start, wait, done and wake wait up to two seconds for their row, since a row can move a render after the change, then skip. They look for the row's card through `data-testid="sidebar-row-card"` and its slim variant, which the legacy sidebar does not have, so there only settle and snooze play. The effects animate T3's own rows only with the Web Animations API, never through the style attribute React owns.

## Controls

In the window's DevTools console:

```js
t3SettleBoom.play();                              // the settle explosion in the middle of the window
t3SettleBoom.play({ effect: "done", threadId: "…" });   // on a thread's row, without changing it
t3SettleBoom.play({ effect: "wait", kind: "input", threadId: "…" });
t3SettleBoom.play({ effect: "wake", timer: false, x: 120, y: 140, title: "Fix the build" });
t3SettleBoom.play({ effect: "snooze", threadId: "…", pauseAt: 720 });   // frozen at 720 ms, for screenshots
t3SettleBoom.clear();                             // stop every effect that is playing
t3SettleBoom.effects;                             // ["settle", "wait", "wake", "done", "start", "snooze"]
t3SettleBoom.off = ["start"];                     // effects that never play, saved in localStorage
t3SettleBoom.muted = true;                        // no sound at all, saved in localStorage
await t3SettleBoom.renderSound("wait");           // an effect's sound as an AudioBuffer, rendered offline
```

With settle in `off`, the Settle button and ⌘⇧S are no longer held. Each effect that plays dispatches a `t3-settle-boom` event on `window`, with `{ effect, threadId }` in its `detail`.
