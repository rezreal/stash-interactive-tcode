// Hismith PiuPiu lube launcher: follows the A2 (lube) axis during playback,
// resending the squirt command while the lube value is above half, with no
// time cap. Loads plugin/TCodePlayer.js in a vm with stubbed browser APIs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "../plugin/TCodePlayer.js"), "utf8");
const SQUIRT = [0xcc, 0x0b, 0x01, 0x0c];

class FakeLauncher {
  constructor(id) {
    this.id = id; this.name = "Hismith Piupiu"; this.writes = []; this.connects = 0;
    const self = this;
    this.gatt = {
      connected: false,
      async connect() {
        self.connects++;
        this.connected = true;
        return {
          getPrimaryService: async (svc) => {
            assert.equal(svc, 0xffe5);
            return {
              getCharacteristic: async (ch) => {
                assert.equal(ch, 0xffe9);
                return {
                  properties: { writeWithoutResponse: true },
                  writeValueWithoutResponse: async (d) => { self.writes.push(Array.from(d)); },
                };
              },
            };
          },
        };
      },
      disconnect() { this.connected = false; },
    };
  }
  addEventListener() {}
  removeEventListener() {}
}

class FakeVideo {
  constructor() { this.paused = true; this.ended = false; this.currentTime = 0; this.handlers = {}; }
  addEventListener(ev, fn) { this.handlers[ev] = fn; }
  removeEventListener(ev) { delete this.handlers[ev]; }
  play() { this.paused = false; (this.handlers.play || (() => {}))(); }
  pause() { this.paused = true; (this.handlers.pause || (() => {}))(); }
}

// stroke plus a lube channel that is high from 1 s to 9 s
const SCRIPT = {
  version: "2.0",
  actions: [{ at: 0, pos: 0 }, { at: 10000, pos: 100 }],
  channels: {
    lube: { actions: [{ at: 0, pos: 0 }, { at: 999, pos: 0 }, { at: 1000, pos: 100 }, { at: 9000, pos: 100 }, { at: 9001, pos: 0 }] },
  },
};

// engines from finished tests: stop their timers so node can exit
const envs = [];
test.afterEach(() => {
  for (const { engine } of envs.splice(0)) {
    engine.disconnectLube();
    engine._stopVideoWatch();
    engine._attachVideo(null);
    engine._stopTimer();
  }
});

function load({ devices = [], storage = {} } = {}) {
  const store = new Map(Object.entries(storage));
  const any = new Proxy({}, { get: () => ({}) });
  const video = new FakeVideo();
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
  const navigator = {
    serial: { getPorts: async () => [], requestPort: async () => { throw Object.assign(new Error(), { name: "NotFoundError" }); }, addEventListener() {} },
    bluetooth: { requestDevice: async () => devices[0], getDevices: async () => devices },
  };
  const document = {
    baseURI: "http://localhost:9999/",
    createElement: () => ({ remove() {} }),
    head: { appendChild() {} },
    querySelector: (sel) => (sel === ".VideoPlayer video" ? video : null),
  };
  const ctx = vm.createContext(window);
  Object.assign(window, {
    window, navigator, document, console, URL, TextEncoder, TextDecoderStream, performance,
    ReadableStream, WritableStream, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: true, json: async () => SCRIPT }),
  });
  vm.runInContext(SRC, ctx);
  const env = { store, video, engine: window.TCodePlayer.engine };
  envs.push(env);
  return env;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function playScene(env) {
  env.engine.bindScene({
    id: "1", interactive: true, paths: { funscript: "http://localhost:9999/scene/1/funscript" },
    files: [{ id: "1", path: "/v.mp4", duration: 10, fingerprints: [] }], custom_fields: {},
  });
  await wait(30); // script loaded, video attached
  env.video.play();
}

test("fires while the lube channel is high and stops when it drops", async () => {
  const dev = new FakeLauncher("piu");
  const env = load({ devices: [dev] });
  await env.engine.connectLube();
  assert.equal(env.engine.state.lubeStatus, "connected");
  assert.equal(env.store.get("tcp-lube"), "piu");

  env.video.currentTime = 0.2;
  await playScene(env);
  await wait(150);
  assert.equal(dev.writes.length, 0, "no squirt while lube is low");

  env.video.currentTime = 2;
  await wait(350);
  assert.equal(env.engine.state.lubeActive, true);
  assert.ok(dev.writes.length >= 3, `resends while held (got ${dev.writes.length})`);
  assert.deepEqual(dev.writes[0], SQUIRT);

  env.video.currentTime = 9.5;
  await wait(100);
  const n = dev.writes.length;
  await wait(250);
  assert.equal(env.engine.state.lubeActive, false);
  assert.ok(dev.writes.length <= n + 1, "stops resending once the lube value drops");
  env.video.pause();
  env.engine.disconnectLube();
});

test("keeps firing for as long as the script says - no time cap", async () => {
  const dev = new FakeLauncher("piu");
  const env = load({ devices: [dev] });
  await env.engine.connectLube();
  env.video.currentTime = 1.5;
  await playScene(env);
  await wait(1300);
  assert.equal(env.engine.state.lubeActive, true);
  const n = dev.writes.length;
  await wait(250);
  assert.ok(dev.writes.length >= n + 2, "still resending after more than a second");
  env.video.pause();
  env.engine.disconnectLube();
});

test("pausing the video stops the launcher", async () => {
  const dev = new FakeLauncher("piu");
  const env = load({ devices: [dev] });
  await env.engine.connectLube();
  env.video.currentTime = 2;
  await playScene(env);
  await wait(200);
  assert.equal(env.engine.state.lubeActive, true);
  env.video.pause();
  const n = dev.writes.length;
  await wait(300);
  assert.equal(env.engine.state.lubeActive, false);
  assert.equal(dev.writes.length, n);
  env.engine.disconnectLube();
});

test("hold-to-squirt fires until released", async () => {
  const dev = new FakeLauncher("piu");
  const env = load({ devices: [dev] });
  await env.engine.connectLube();
  env.engine.squirt(true);
  await wait(250);
  assert.ok(dev.writes.length >= 2);
  env.engine.squirt(false);
  const n = dev.writes.length;
  await wait(250);
  assert.equal(dev.writes.length, n);
  env.engine.disconnectLube();
});

test("shows on the preview without a launcher connected", async () => {
  const env = load();
  env.engine.addEmulator({ write() {} }); // a mounted 3D preview acts as the virtual device
  env.video.currentTime = 2;
  await playScene(env);
  await wait(100);
  assert.equal(env.engine.state.lubeActive, true);
  env.video.pause();
});

test("auto-connects only the launcher it paired with, and not one in use", async () => {
  const other = new FakeLauncher("other");
  const mine = new FakeLauncher("piu");
  let env = load({ devices: [other, mine], storage: { "tcp-lube": "piu" } });
  await wait(30);
  assert.equal(other.connects, 0);
  assert.equal(mine.connects, 1);
  assert.equal(env.engine.state.lubeStatus, "connected");
  env.engine.disconnectLube();

  const busy = new FakeLauncher("piu");
  busy.gatt.connected = true; // held by another plugin in this page
  env = load({ devices: [busy], storage: { "tcp-lube": "piu" } });
  await wait(30);
  assert.equal(busy.connects, 0);
  assert.equal(env.engine.state.lubeStatus, "disconnected");

  const none = new FakeLauncher("piu");
  env = load({ devices: [none] });
  await wait(30);
  assert.equal(none.connects, 0, "never paired: no auto-connect");
});

test("connecting a launcher another plugin holds reports it instead of taking it", async () => {
  const busy = new FakeLauncher("piu");
  busy.gatt.connected = true;
  const env = load({ devices: [busy] });
  await env.engine.connectLube();
  assert.equal(busy.connects, 0);
  assert.equal(env.engine.state.lubeStatus, "error");
  assert.match(env.engine.state.lubeError, /in use/);
});
