// Output timing: replays what the plugin sends through a model of how TCode
// firmware moves (from where it is, linearly to the target, within the I time)
// and checks the device keeps up with fast strokes without standing still -
// including when every serial write takes longer than a frame.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = process.env.TCP_SRC || path.join(__dirname, "../plugin/TCodePlayer.js");

class TimedPort {
  /** failEvery: every n-th write fails with a system error, after which the browser offers a fresh stream */
  constructor(writeMs, failEvery) {
    this.writeMs = writeMs; this.failEvery = failEvery; this.n = 0; this.opened = 0;
    this.cmds = []; this.readable = null; this._ws = null; this._broken = false;
  }
  getInfo() { return { usbVendorId: 0x10c4, usbProductId: 0xea60 }; }
  async open() { this.opened++; this.readable = new ReadableStream(); this._ws = this._stream(); }
  async close() { this.readable = null; this._ws = null; }
  get writable() {
    if (this._broken && this._ws) { this._ws = this._stream(); this._broken = false; }
    return this._ws;
  }
  _stream() {
    return new WritableStream({
      write: async (chunk) => {
        if (this.failEvery && ++this.n % this.failEvery === 0) {
          this._broken = true;
          throw new DOMException("An unknown system error has occurred.", "UnknownError");
        }
        const at = performance.now();
        const m = /L0(\d{4})(?:I(\d+))?/.exec(new TextDecoder().decode(chunk));
        if (m) this.cmds.push({ at, target: Number(m[1]) / 9999 * 100, I: Number(m[2] || 0) });
        await new Promise((r) => setTimeout(r, this.writeMs));
      },
    });
  }
}

class PlayingVideo {
  constructor() { this.paused = true; this.ended = false; this.playbackRate = 1; this._t = 0; this._wall = 0; this.handlers = {}; }
  get currentTime() { return this.paused ? this._t : this._t + (performance.now() - this._wall) / 1000; }
  addEventListener(ev, fn) { this.handlers[ev] = fn; }
  removeEventListener(ev) { delete this.handlers[ev]; }
  play() { this._wall = performance.now(); this.paused = false; (this.handlers.play || (() => {}))(); }
  pause() { this._t = this.currentTime; this.paused = true; (this.handlers.pause || (() => {}))(); }
}

// full 0 <-> 100 strokes every 150 ms - a fast sequence
const STROKE_MS = 150;
const SCRIPT = { actions: Array.from({ length: 200 }, (_, i) => ({ at: i * STROKE_MS, pos: i % 2 ? 100 : 0 })) };

const envs = [];
test.afterEach(async () => {
  for (const { engine, video } of envs.splice(0)) {
    video.pause();
    engine._stopVideoWatch();
    engine._attachVideo(null);
    await engine._cleanup(null);
  }
});

async function play(writeMs, ms, failEvery) {
  const port = new TimedPort(writeMs, failEvery);
  const video = new PlayingVideo();
  const any = new Proxy({}, { get: () => ({}) });
  const window = {
    isSecureContext: true,
    localStorage: { getItem: () => null, setItem() {} },
    PluginApi: {
      React: { createElement: () => null, Fragment: {}, forwardRef: (fn) => fn },
      libraries: { Bootstrap: any, ReactFontAwesome: any, FontAwesomeSolid: any, Apollo: { gql: (s) => s.join("") } },
      utils: { StashService: { getClient: () => ({ query: async () => ({ data: {} }) }) } },
      hooks: {},
      patch: { after() {} },
    },
  };
  const navigator = { serial: { getPorts: async () => [], requestPort: async () => port, addEventListener() {} } };
  const document = {
    baseURI: "http://localhost:9999/", createElement: () => ({ remove() {} }), head: { appendChild() {} },
    querySelector: (sel) => (sel === ".VideoPlayer video" ? video : null),
  };
  const quiet = Object.assign(Object.create(console), { warn() {}, info() {} });
  const ctx = vm.createContext(window);
  Object.assign(window, {
    window, navigator, document, console: quiet, URL, TextEncoder, TextDecoderStream, performance,
    ReadableStream, WritableStream, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: true, json: async () => SCRIPT }),
  });
  vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx);
  const engine = window.TCodePlayer.engine;
  envs.push({ engine, video });
  await engine.connect();
  engine.bindScene({
    id: "1", interactive: true, paths: { funscript: "http://localhost:9999/scene/1/funscript" },
    files: [{ id: "1", path: "/v.mp4", duration: 60, fingerprints: [] }], custom_fields: {},
  });
  await new Promise((r) => setTimeout(r, 30));
  video.play();
  await new Promise((r) => setTimeout(r, ms));
  return { port, engine };
}

/** Device position over time from the commands, per TCode: move linearly to the target within I. */
function simulate(cmds, from, to) {
  let start = cmds[0].target, k = 0;
  const posAt = (c, s, t) => (c.I > 0 ? s + (c.target - s) * Math.min(1, (t - c.at) / c.I) : c.target);
  let lo = Infinity, hi = -Infinity, idle = 0;
  for (let t = from; t < to; t++) {
    while (k + 1 < cmds.length && cmds[k + 1].at <= t) { start = posAt(cmds[k], start, cmds[k + 1].at); k++; }
    const c = cmds[k];
    const p = posAt(c, start, t);
    lo = Math.min(lo, p); hi = Math.max(hi, p);
    if (t - c.at > c.I) idle++; // arrived, and the next command is not there yet
  }
  return { reach: (hi - lo) / 100, idle: idle / (to - from) };
}

for (const writeMs of [2, 25]) {
  test(`keeps up with fast strokes when a write takes ${writeMs} ms`, async () => {
    const { port, engine } = await play(writeMs, 1600);
    const from = port.cmds[0].at + 600, to = performance.now();
    const { reach, idle } = simulate(port.cmds, from, to);
    if (process.env.TCP_SRC) console.log(`writes ${writeMs} ms: reach ${(reach * 100).toFixed(0)} %, idle ${(idle * 100).toFixed(0)} %`);
    assert.ok(reach >= 0.8, `device covers ${(reach * 100).toFixed(0)} % of the stroke`);
    assert.ok(idle <= 0.1, `device stands waiting ${(idle * 100).toFixed(0)} % of the time`);
    if (engine.state.stats) assert.ok(engine.state.stats.fps > 0);
  });
}

test("a write failing every half second does not pause the output", async () => {
  const { port } = await play(2, 1600, 30); // about every 0.5 s at 60 frames a second, as seen on an SR6
  const from = port.cmds[0].at + 600, to = performance.now();
  const late = port.cmds.filter((c) => c.at >= from);
  const maxGap = Math.max(...late.slice(1).map((c, k) => c.at - late[k].at));
  const { idle } = simulate(port.cmds, from, to);
  assert.equal(port.opened, 1, "recovered on a fresh stream, no reopen");
  assert.ok(maxGap < 100, `longest gap between commands ${maxGap.toFixed(0)} ms`);
  assert.ok(idle <= 0.1, `device stands waiting ${(idle * 100).toFixed(0)} % of the time`);
});
