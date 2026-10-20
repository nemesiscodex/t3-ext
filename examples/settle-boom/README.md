# Settle Boom

When you settle a thread, its sidebar row shakes, charges up and explodes, with a synthesized boom. The thread moves to Settled only once the explosion is over. The look and sound follow Kit Langton's [Effect Institute](https://www.effect.institute/): off-white ink on black, a dot grid, thin rings, glitch glyphs, small green squares, and Tone.js-style voices.

![Frames at 150, 330, 415, 480, 600 and 900 ms](preview.png)

## What it does

1. **Charge:** a copy of the row stays where the row was, then shakes harder and brightens for 0.4 seconds while three quick rising ticks play. It then bursts.
2. **Flash:** a white core flashes.
3. **Rings:** three thin rings expand, the middle one dashed and turning.
4. **Dot grid:** a shock wave lights up a dot grid as it passes.
5. **Debris:** sparks streak out, and glyphs fly out, flicker through `@#$%&*/=-+?!~<>\|█▓▒░` and cool into squares.
6. **Label:** a "■ SETTLED" label with the thread's title resolves letter by letter, then blurs away. The label is drawn like a T3 tooltip, in the colors of the current theme.
7. **Shake:** the window shakes slightly.

The sound has four parts:

- **Ticks:** three short rising sine blips while the row charges, like Effect Institute's "running" sound.
- **Blast:** a filtered noise burst and a sub thump.
- **Stab:** Effect Institute's distorted, detuned-saw "death" stab and low rumble.
- **Chime:** its triangle "success" triad, C5, E5 and G5, through reverb.

With **Reduce motion** on in macOS, the row fades instead of shaking, and only one ring, the label and the sound play.

It fires for every settle: the Settle button, a menu, a keyboard shortcut, auto-settle, or an agent settling through T3's tools.

## How it knows

**The Settle button and ⌘⇧S are held.** The extension stops the click or key press before T3 sees it and hides the real row behind the effect. About 1.8 seconds later, when the debris is gone, it replays the same click or key press. T3 then settles as usual, with its "⌘Z to undo". If you moved to another thread in the meantime, it clicks the row's Settle button instead. Only T3's default ⌘⇧S is held; a remapped shortcut settles at once.

**Everything else settles at once.** The **Settle thread** menu is a native menu, so it cannot be held. It sends a `thread.settle` command to T3's server, and T3 moves the row right after, so the extension catches the command as it is sent and explodes a copy of the row. Auto-settle, an agent or another window make the server send a `thread.updated` message with `thread.settledAt` set. The extension reads it before T3 handles it, while the row is still on screen. T3's connection opens before `renderer.js` runs, so these two hooks wrap `WebSocket.prototype.send` and the `MessageEvent` `data` getter.

It explodes once per settle. It skips a `settledAt` more than 30 seconds old, so reloads and old settled threads stay quiet.

Rows are found by `data-thread-item="<environmentId>:<threadId>"`. If the row is not on screen (a filter hides it, or its project is collapsed), or a T3 update renames that attribute, the effect plays without the charge in the middle of the window.

## Controls

In the window's DevTools console:

```js
t3SettleBoom.play();                         // try it in the middle of the window
t3SettleBoom.play({ threadId: "…" });       // on a thread's row, without settling it
t3SettleBoom.play({ x: 120, y: 140, title: "Fix the build" });
t3SettleBoom.muted = true;                   // saved in localStorage
await t3SettleBoom.renderSound();            // the sound as an AudioBuffer, rendered offline
```
