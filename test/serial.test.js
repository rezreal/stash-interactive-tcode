// Serial write errors: after one failed write the port's output stream is
// broken and every later write fails at once (seen with an SR6 ESP32 board on
// Chrome: "UnknownError: An unknown system error has occurred"). The plugin has
// to recover instead of silently sending into nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "../plugin/TCodePlayer.js"), "utf8");

class FlakyPort {
  /** fail(i) decides whether the i-th write overall fails; fresh = the browser hands out a new stream after an error */
  constructor(fail, { fresh = false } = {}) {
    this.fail = fail; this.fresh = fresh; this.n = 0; this.ok = []; this.opened = 0;
    this.readable = null; this._ws = null; this._broken = false;
  }
  getInfo() { return { usbVendorId: 0x10c4, usbProductId: 0xea60 }; }
  async open() { this.opened++; this.readable = new ReadableStream(); this._ws = this._stream(); this._broken = false; }
  async close() { this.readable = null; this._ws = null; }
  get writable() {
    if (this.fresh && this._broken && this._ws) { this._ws = this._stream(); this._broken = false; }
    return this._ws;
  }
  _stream() {
    return new WritableStream({
      write: (chunk) => {
        const i = this.n++;
        if (this.fail(i)) {
          this._broken = true;
          throw new DOMException("An unknown system error has occurred.", "UnknownError");
        }
        this.ok.push(new TextDecoder().decode(chunk).trim());
      },
    });
  }
}

const envs = [];
test.afterEach(async () => {
  for (const { engine } of envs.splice(0)) await engine._cleanup(null);
});

function load(port) {
  const any = new Proxy({}, { get: () => ({}) });
  const warnings = [];
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
  const document = { baseURI: "http://localhost:9999/", createElement: () => ({ remove() {} }), head: { appendChild() {} }, querySelector: () => null };
  const quiet = Object.assign(Object.create(console), { warn: (...a) => warnings.push(a), info() {} });
  const ctx = vm.createContext(window);
  Object.assign(window, {
    window, navigator, document, console: quiet, URL, TextEncoder, TextDecoderStream, performance,
    ReadableStream, WritableStream, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(SRC, ctx);
  const env = { engine: window.TCodePlayer.engine, warnings };
  envs.push(env);
  return env;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function stream(engine, frames) {
  for (let i = 0; i < frames; i++) {
    engine.sendRaw("L0" + String(i % 10000).padStart(4, "0") + "I17");
    await wait(10);
  }
}

test("reopens the port after a failed write and the device gets data again", async () => {
  const port = new FlakyPort((i) => i === 3);
  const { engine, warnings } = load(port);
  await engine.connect();
  await stream(engine, 30);
  assert.equal(port.opened, 2, "reopened once");
  assert.equal(engine.state.status, "connected");
  assert.ok(port.ok.length >= 20, `writes reach the device again (${port.ok.length})`);
  assert.equal(warnings.length, 1, "one warning, not one per frame");
  assert.ok(engine.state.deviceLog.some((l) => l.includes("write failed")), "noted in the device log");
});

test("takes a fresh stream without reopening when the browser offers one", async () => {
  const port = new FlakyPort((i) => i === 3, { fresh: true });
  const { engine } = load(port);
  await engine.connect();
  await stream(engine, 20);
  assert.equal(port.opened, 1, "no reopen, so the board is not restarted");
  assert.ok(port.ok.length >= 15);
});

test("gives up with a clear error when writes keep failing", async () => {
  const port = new FlakyPort((i) => i >= 3);
  const { engine } = load(port);
  await engine.connect();
  await stream(engine, 80);
  assert.equal(engine.state.status, "error");
  assert.match(engine.state.error, /keeps rejecting data/);
  assert.equal(port.opened, 4, "the first open plus three reopens");
});
