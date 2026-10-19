if (!window.t3SettleBoom) {
  // Effect Institute's look: off-white ink on black, a dot grid, thin rings, glitch glyphs, and
  // the occasional "small greenish square". The sound follows its Tone.js death/success voices.
  const INK = "241, 239, 232";
  const GREEN = "134, 239, 172";
  const GLYPHS = "@#$%&*/=-+?!~<>\\|█▓▒░";
  const WORD = "SETTLED";
  const DURATION = 1800;
  const MUTED_KEY = "t3ext.settle-boom.muted";
  const ROW = "[data-thread-item]";

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (text) => text[Math.floor(Math.random() * text.length)];
  const clamp01 = (value) => Math.min(1, Math.max(0, value));
  const easeOutExpo = (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p));
  const easeOutCubic = (p) => 1 - (1 - p) ** 3;
  const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace";

  // --- Where the thread was --------------------------------------------------------------------

  // A row's data-thread-item is "<environmentId>:<threadId>".
  const threadIdOf = (row) => row.getAttribute("data-thread-item").split(":").pop();
  const rowFor = (threadId) => [...document.querySelectorAll(ROW)].find((row) => threadIdOf(row) === threadId);

  // Clicking Settle removes the row before the server confirms, so remember rows as they are used.
  const touched = new Map();
  const remember = (event) => {
    const row = event.target instanceof Element ? event.target.closest(ROW) : null;
    if (row) touched.set(threadIdOf(row), { rect: row.getBoundingClientRect(), at: performance.now() });
  };
  for (const type of ["pointerdown", "contextmenu", "focusin"]) addEventListener(type, remember, true);

  function originFor(threadId) {
    const remembered = touched.get(threadId);
    const rect = rowFor(threadId)?.getBoundingClientRect() ?? (remembered && performance.now() - remembered.at < 10_000 ? remembered.rect : null);
    if (rect && rect.width > 0) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    return { x: innerWidth / 2, y: innerHeight / 2 };
  }

  // --- When a thread settles -------------------------------------------------------------------

  // The server pushes `thread.updated` with `settledAt` set when a thread settles, by hand or
  // automatically. The socket opened before this script ran, so the frames are read through the
  // MessageEvent `data` getter instead of a listener. It runs inside T3's own handler, before
  // T3 removes the row, so it must never throw.
  const FRESH_MS = 30_000;
  const seen = new Set();

  function onFrame(text) {
    const frame = JSON.parse(text);
    for (const value of Array.isArray(frame?.values) ? frame.values : []) {
      const thread = value?.kind === "thread.updated" ? value.thread : null;
      if (!thread?.settledAt) continue;
      const key = `${thread.id}@${thread.settledAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (Date.now() - Date.parse(thread.settledAt) < FRESH_MS) boom({ ...originFor(thread.id), title: thread.title });
    }
  }

  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
  const inspected = new WeakSet();
  Object.defineProperty(MessageEvent.prototype, "data", {
    ...data,
    get() {
      const value = data.get.call(this);
      if (typeof value === "string" && !inspected.has(this) && this.target instanceof WebSocket) {
        inspected.add(this);
        if (value.includes('"settledAt":"')) {
          try {
            onFrame(value);
          } catch (error) {
            console.error("[settle-boom]", error);
          }
        }
      }
      return value;
    },
  });

  // --- The explosion ---------------------------------------------------------------------------

  let canvas = null;
  let ctx = null;
  let scenes = [];
  let frame = 0;

  // Debris with drag and a little gravity, in closed form so any frame is a function of time.
  const DRAG = 3.4;
  const GRAVITY = 140;
  const travel = (v, t) => (v / DRAG) * (1 - Math.exp(-DRAG * t));
  const fall = (t) => (GRAVITY / DRAG) * (t - (1 - Math.exp(-DRAG * t)) / DRAG);

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

  function label(x, y, title) {
    const node = document.createElement("div");
    node.className = "t3-settle-boom-label";
    const word = document.createElement("div");
    word.className = "t3-settle-boom-word";
    const name = document.createElement("div");
    name.className = "t3-settle-boom-title";
    name.textContent = title.length > 40 ? `${title.slice(0, 39)}…` : title;
    node.append(word, name);
    document.documentElement.append(node);
    const { width, height } = node.getBoundingClientRect();
    node.style.left = `${Math.min(Math.max(12, x + 34), innerWidth - width - 12)}px`;
    node.style.top = `${Math.min(Math.max(12, y - height - 18), innerHeight - height - 12)}px`;
    return { node, word };
  }

  function shake() {
    const root = document.getElementById("root") ?? document.body;
    const hops = Array.from({ length: 5 }, () => ({ transform: `translate(${rand(-5, 5)}px, ${rand(-4, 4)}px) rotate(${rand(-0.35, 0.35)}deg)` }));
    root.animate([{ transform: "none" }, ...hops, { transform: "none" }], { duration: 380, easing: "ease-out" });
  }

  function boom({ x, y, title = "", pauseAt = null }) {
    const calm = reducedMotion.matches;
    scenes.push({
      x,
      y,
      calm,
      pauseAt,
      start: performance.now(),
      spin: rand(0, Math.PI * 2),
      debris: calm ? [] : debris(),
      sparks: calm ? [] : sparks(),
      label: label(x, y, title),
    });
    if (!calm) shake();
    sound.play();
    if (!frame) frame = requestAnimationFrame(tick);
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
      if (elapsed >= DURATION) {
        scene.label.node.remove();
        return false;
      }
      draw(scene, elapsed);
      return true;
    });
    if (scenes.length) frame = requestAnimationFrame(tick);
    else {
      canvas.remove();
      canvas = null;
    }
  }

  function draw(scene, e) {
    const { x, y } = scene;
    ctx.save();
    if (!scene.calm) drawGrid(x, y, e);
    drawRings(scene, e);
    if (!scene.calm) {
      drawCore(x, y, e);
      drawSparks(scene, e);
      drawDebris(scene, e);
    }
    ctx.restore();
    drawLabel(scene, e);
  }

  // The dot grid lights up as the shock wave passes through it.
  function drawGrid(x, y, e) {
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
        ctx.fillStyle = `rgba(${INK}, ${Math.min(0.9, lit)})`;
        ctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5);
      }
    }
  }

  // Three thin rings, the middle one dashed and turning like the Institute's lettered ring.
  const RINGS = [
    { delay: 0, duration: 650, radius: 95, width: 2 },
    { delay: 70, duration: 820, radius: 160, width: 1.25, dash: [3, 7] },
    { delay: 160, duration: 980, radius: 240, width: 1 },
  ];

  function drawRings(scene, e) {
    for (const ring of scene.calm ? RINGS.slice(0, 1) : RINGS) {
      const p = (e - ring.delay) / ring.duration;
      if (p <= 0 || p >= 1) continue;
      ctx.beginPath();
      ctx.setLineDash(ring.dash ?? []);
      ctx.lineDashOffset = ring.dash ? -e * 0.04 : 0;
      ctx.lineWidth = ring.width * (1 - p * 0.5);
      ctx.strokeStyle = `rgba(${INK}, ${(1 - p) ** 1.5})`;
      ctx.arc(scene.x, scene.y, Math.max(1, ring.radius * easeOutExpo(p)), scene.spin, scene.spin + Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawCore(x, y, e) {
    if (e >= 240) return;
    const r = e < 50 ? 22 * (e / 50) : 22 * (1 - (e - 50) / 190);
    ctx.shadowColor = `rgba(${INK}, 0.9)`;
    ctx.shadowBlur = 28;
    ctx.fillStyle = `rgb(${INK})`;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawSparks(scene, e) {
    ctx.lineCap = "round";
    for (const spark of scene.sparks) {
      const p = e / spark.life;
      if (p >= 1) continue;
      const head = travel(spark.speed, e / 1000);
      const tail = Math.max(0, head - spark.speed * 0.04 * (1 - p));
      const dx = Math.cos(spark.angle);
      const dy = Math.sin(spark.angle);
      ctx.strokeStyle = `rgba(${INK}, ${1 - p})`;
      ctx.lineWidth = 1.5 * (1 - p) + 0.3;
      ctx.beginPath();
      ctx.moveTo(scene.x + dx * tail, scene.y + dy * tail);
      ctx.lineTo(scene.x + dx * head, scene.y + dy * head);
      ctx.stroke();
    }
  }

  // Glyphs flicker through the glitch set while they fly, then cool into squares.
  function drawDebris(scene, e) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const font = monoFont();
    for (const bit of scene.debris) {
      const p = e / bit.life;
      if (p >= 1) continue;
      const t = e / 1000;
      const glyph = bit.green || p > 0.55 ? "■" : GLYPHS[(bit.seed + Math.floor(e / 60)) % GLYPHS.length];
      ctx.save();
      ctx.translate(scene.x + travel(bit.vx, t), scene.y + travel(bit.vy, t) + fall(t));
      ctx.rotate(bit.spin * t);
      ctx.font = `600 ${bit.green ? bit.size * 0.7 : bit.size}px ${font}`;
      ctx.fillStyle = `rgba(${bit.green ? GREEN : INK}, ${1 - p ** 2})`;
      ctx.fillText(glyph, 0, 0);
      ctx.restore();
    }
  }

  // "SETTLED" resolves letter by letter out of glitch glyphs, holds, then blurs away.
  function drawLabel(scene, e) {
    const { node, word } = scene.label;
    word.textContent = [...WORD].map((letter, i) => (e >= 180 + i * 45 ? letter : pick(GLYPHS))).join("");
    const fadeIn = clamp01((e - 120) / 120);
    const fadeOut = clamp01((e - 1250) / (DURATION - 1250));
    node.style.opacity = String(fadeIn * (1 - fadeOut));
    node.style.filter = `blur(${(fadeOut * 4).toFixed(2)}px)`;
    node.style.transform = `translateY(${((1 - fadeIn) * 6 - fadeOut * 8).toFixed(2)}px)`;
  }

  // --- The sound -------------------------------------------------------------------------------

  // Web Audio versions of the Institute's voices: a distorted detuned-saw stab and low rumble
  // (its "death"), a filtered noise burst and sub thump for the blast, then a soft triangle triad
  // through reverb (its "success"), since settling is good news.
  const sound = (() => {
    let live = null;

    // The voices are built on any BaseAudioContext, so the same sound can be rendered offline.
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

    function voice({ audio }, type, frequency, t, shape, destinations, detune = 0) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = type;
      osc.frequency.value = frequency;
      osc.detune.value = detune;
      osc.connect(gain);
      for (const destination of destinations) gain.connect(destination);
      osc.start(t);
      osc.stop(envelope(gain.gain, t, shape));
      return osc;
    }

    // Like Tone's "fatsawtooth": a few detuned saws.
    const fatSaw = (g, frequency, t, shape) =>
      [-12, 0, 12].forEach((cents) => voice(g, "sawtooth", frequency, t, { ...shape, peak: shape.peak / 3 }, [g.drive], cents));

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

      const thump = voice(g, "sine", 120, t, { attack: 0.002, decay: 0.3, sustain: 0.2, hold: 0.25, release: 0.3, peak: 0.9 }, [g.out, g.wet]);
      thump.frequency.setValueAtTime(120, t);
      thump.frequency.exponentialRampToValueAtTime(36, t + 0.35);
    }

    function schedule(g, t) {
      blast(g, t);
      fatSaw(g, 155.56, t, { attack: 0.01, decay: 0.5, sustain: 0.3, hold: 0.0625, release: 1.5, peak: 0.45 }); // D#3
      fatSaw(g, 32.7, t + 0.1, { attack: 0.01, decay: 0.5, sustain: 0.3, hold: 0.5, release: 1.2, peak: 0.55 }); // C1
      [523.25, 659.25, 783.99].forEach((frequency, i) =>
        voice(g, "triangle", frequency, t + 0.3 + i * 0.07, { attack: 0.02, decay: 0.3, sustain: 0.1, hold: 0.25, release: 1.2, peak: 0.18 }, [g.out, g.wet]),
      ); // C5 E5 G5
    }

    const context = () => (live ??= graph(new AudioContext())).audio;

    function play() {
      if (localStorage.getItem(MUTED_KEY) === "1") return;
      if (context().state === "suspended") context().resume();
      schedule(live, context().currentTime + 0.01);
    }

    function render(seconds = 3.2, sampleRate = 44_100) {
      const offline = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
      schedule(graph(offline), 0.01);
      return offline.startRendering();
    }

    // Some windows only allow audio after a gesture; open the context on the first one.
    addEventListener("pointerdown", () => context().resume(), { once: true, capture: true });

    return { play, render, state: () => live?.audio.state ?? "not started" };
  })();

  window.t3SettleBoom = {
    // Plays the effect at a point (default: the middle of the window). `pauseAt` freezes it at
    // that many milliseconds, for screenshots.
    play: ({ x = innerWidth / 2, y = innerHeight / 2, title = "", pauseAt = null } = {}) => boom({ x, y, title, pauseAt }),
    clear: () => {
      for (const scene of scenes) scene.label.node.remove();
      scenes = [];
    },
    get muted() {
      return localStorage.getItem(MUTED_KEY) === "1";
    },
    set muted(value) {
      localStorage.setItem(MUTED_KEY, value ? "1" : "0");
    },
    audioState: () => sound.state(),
    // Renders the sound offline into an AudioBuffer, for previews and checks.
    renderSound: () => sound.render(),
  };
}
