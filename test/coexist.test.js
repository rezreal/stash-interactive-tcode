// The plugin must work alongside other interactive plugins: it may not grab
// serial ports they own, and the 3D preview bundle may not leave stray globals.
// Loads plugin/TCodePlayer.js in a vm with a minimal stub of Stash's PluginApi.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "../plugin/TCodePlayer.js"), "utf8");
const EMU = path.join(__dirname, "../plugin/vendor/osr-emu.dist.min.js");

class FakePort {
  constructor(info, { busy = false } = {}) {
    this.info = info; this.busy = busy; this.readable = null; this.writable = null; this.opened = 0;
  }
  getInfo() { return this.info; }
  async open() {
    if (this.busy) throw Object.assign(new Error("Failed to open serial port."), { name: "NetworkError" });
    this.opened++;
    this.readable = new ReadableStream();
    this.writable = new WritableStream();
  }
  async close() { this.readable = null; this.writable = null; }
}

function load({ ports = [], storage = {} } = {}) {
  const store = new Map(Object.entries(storage));
  const scripts = [];
  const any = new Proxy({}, { get: () => ({}) });
  const window = {
    isSecureContext: true,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    PluginApi: {
      React: { createElement: () => null, Fragment: {}, forwardRef: (fn) => fn },
      libraries: {
        Bootstrap: any, ReactFontAwesome: any, FontAwesomeSolid: any,
        Apollo: { gql: (s) => s.join("") },
      },
      utils: { StashService: { getClient: () => ({ query: async () => ({ data: {} }) }) } },
      hooks: {},
      patch: { after() {} },
    },
  };
  const navigator = { serial: { getPorts: async () => ports, requestPort: async () => ports[0], addEventListener() {} } };
  const document = {
    baseURI: "http://localhost:9999/",
    createElement: () => ({ remove() {} }),
    head: { appendChild: (el) => scripts.push(el) },
    querySelector: () => null,
  };
  const ctx = vm.createContext(window);
  Object.assign(window, {
    window, navigator, document, console, URL, TextEncoder, TextDecoderStream,
    ReadableStream, WritableStream, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(SRC, ctx);
  return { ctx, window, store, scripts, engine: window.TCodePlayer.engine };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const USB = { usbVendorId: 0x10c4, usbProductId: 0xea60 };
const OTHER = { usbVendorId: 0x2341, usbProductId: 0x0043 };

test("does not auto-connect to a port it never used", async () => {
  const other = new FakePort(OTHER);
  const { engine } = load({ ports: [other] });
  await settle();
  assert.equal(other.opened, 0);
  assert.equal(engine.state.status, "disconnected");
});

test("auto-connects only to the remembered port, skipping other plugins' ports", async () => {
  const other = new FakePort(OTHER);
  const mine = new FakePort(USB);
  const { engine } = load({ ports: [other, mine], storage: { "tcp-port": JSON.stringify(USB) } });
  await settle();
  assert.equal(other.opened, 0);
  assert.equal(mine.opened, 1);
  assert.equal(engine.state.status, "connected");
  await engine._cleanup(null);
});

test("leaves a remembered port alone when another plugin has it open", async () => {
  const mine = new FakePort(USB);
  mine.readable = new ReadableStream(); // already open in this page
  const { engine } = load({ ports: [mine], storage: { "tcp-port": JSON.stringify(USB) } });
  await settle();
  assert.equal(mine.opened, 0);
  assert.equal(engine.state.status, "disconnected");
  assert.equal(engine.state.error, null);
});

test("backs off quietly when the remembered port is busy elsewhere", async () => {
  const mine = new FakePort(USB, { busy: true });
  const { engine } = load({ ports: [mine], storage: { "tcp-port": JSON.stringify(USB) } });
  await settle();
  assert.equal(engine.state.status, "disconnected");
  assert.equal(engine.state.error, null);
});

test("manual connect to a port in use reports it instead of taking it", async () => {
  const mine = new FakePort(USB);
  mine.readable = new ReadableStream();
  const { engine } = load({ ports: [mine] });
  await settle();
  await engine.connect();
  assert.equal(mine.opened, 0);
  assert.equal(engine.state.status, "error");
  assert.match(engine.state.error, /in use/);
});

test("3D preview bundle leaves only window.OSREmulator behind", async () => {
  const { ctx, window, scripts } = load();
  await settle();
  const loading = window.TCodePlayer.loadEmulator();
  assert.equal(scripts.length, 1);
  vm.runInContext(fs.readFileSync(EMU, "utf8"), ctx); // what the <script> tag would run
  scripts[0].onload();
  const Emu = await loading;
  assert.equal(typeof Emu, "function");
  assert.equal("default" in window, false);
  assert.equal("__esModule" in window, false);
});
