// Generated axes: missing channels made up from the stroke.
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../plugin/TCodePlayer.js");

// full strokes every 500 ms, then a 3 s hold at 30, then more strokes
function strokeScript() {
  const acts = [];
  let t = 0;
  for (let i = 0; i < 20; i++) { acts.push({ at: t, pos: i % 2 ? 100 : 0 }); t += 500; }
  acts.push({ at: t, pos: 30 }); t += 3000;
  acts.push({ at: t, pos: 30 }); t += 500;
  for (let i = 0; i < 10; i++) { acts.push({ at: t, pos: i % 2 ? 20 : 80 }); t += 250; }
  return [{ name: "stroke", actions: acts, inverted: false, source: "embedded" }];
}

const profile = (model, extra) => Core.normalizeProfile(Object.assign({ model }, extra));
const names = (chs) => chs.map((c) => c.name).sort();
const gen = (scripts, p, level, seed) => Core.generateChannels(scripts, p, level || "medium", seed || "42");

test("off generates nothing", () => {
  assert.deepEqual(gen(strokeScript(), profile("osr2"), "off"), []);
  assert.deepEqual(gen(strokeScript(), profile("osr2"), "nonsense"), []);
});

test("fills only the axes the device has", () => {
  assert.deepEqual(names(gen(strokeScript(), profile("osr2"))), ["pitch", "roll", "twist"]);
  assert.deepEqual(names(gen(strokeScript(), profile("sr6"))), ["pitch", "roll", "surge", "sway", "twist"]);
  assert.deepEqual(gen(strokeScript(), profile("ssr1")), []);
  for (const c of gen(strokeScript(), profile("osr2"))) assert.equal(c.source, "generated");
});

test("never replaces what the script already has", () => {
  const acts = [{ at: 0, pos: 50 }, { at: 1000, pos: 60 }];
  const byName = strokeScript().concat([{ name: "roll", actions: acts, inverted: false }]);
  const byId = strokeScript().concat([{ name: "R2", actions: acts, inverted: false }]);
  assert.deepEqual(names(gen(byName, profile("osr2"))), ["pitch", "twist"]);
  assert.deepEqual(names(gen(byId, profile("osr2"))), ["roll", "twist"]);
  assert.deepEqual(gen([{ name: "roll", actions: acts, inverted: false }], profile("osr2")), []); // no stroke
});

test("vibration only when switched on", () => {
  assert.ok(!names(gen(strokeScript(), profile("osr2"))).includes("vib"));
  assert.ok(names(gen(strokeScript(), profile("osr2", { generateVibe: true }))).includes("vib"));
});

test("deterministic per scene, different across scenes", () => {
  const roll = (seed) => gen(strokeScript(), profile("osr2"), "medium", seed).find((c) => c.name === "roll").actions;
  assert.deepEqual(roll("42"), roll("42"));
  assert.notDeepEqual(roll("42"), roll("43"));
});

test("follow is centred at the turning points and leans with direction", () => {
  const stroke = strokeScript()[0].actions;
  const pitch = gen(strokeScript(), profile("osr2")).find((c) => c.name === "pitch").actions;
  for (const a of stroke) assert.equal(Core.valueAt(pitch, a.at), 50);
  const up = Core.valueAt(pitch, 250), down = Core.valueAt(pitch, 750); // 0->100, then 100->0
  assert.ok(up > 50 && down < 50, `up ${up} down ${down}`);
  assert.equal(Core.valueAt(pitch, 10000 + 1500), 50); // hold
});

test("noise freezes during holds", () => {
  const roll = gen(strokeScript(), profile("osr2")).find((c) => c.name === "roll").actions;
  const holdStart = 10000, holdEnd = 13000;
  const v = Core.valueAt(roll, holdStart);
  for (let t = holdStart; t <= holdEnd; t += 250) assert.equal(Core.valueAt(roll, t), v);
});

test("speed vibration goes quiet during long holds", () => {
  const vib = gen(strokeScript(), profile("osr2", { generateVibe: true })).find((c) => c.name === "vib").actions;
  assert.ok(Core.valueAt(vib, 2000) > 20);
  assert.equal(Core.valueAt(vib, 10000 + 1500), 0);
});

test("generated motion is never faster than the stroke", () => {
  const stroke = strokeScript()[0].actions;
  const strokeSpeed = (t0, t1) => Math.abs(Core.valueAt(stroke, t1) - Core.valueAt(stroke, t0));
  for (const level of ["gentle", "medium", "strong"]) {
    for (const c of gen(strokeScript(), profile("sr6"), level)) {
      for (let t = 0; t < 16000; t += 50) {
        const d = Math.abs(Core.valueAt(c.actions, t + 50) - Core.valueAt(c.actions, t));
        // noise changes with stroke travel, plus a little from the edge damping
        assert.ok(d <= strokeSpeed(t, t + 50) + 1e-9, `${level} ${c.name} at ${t}: ${d}`);
      }
    }
  }
});

test("levels scale the swing", () => {
  const swing = (level) => {
    const pitch = gen(strokeScript(), profile("osr2"), level).find((c) => c.name === "pitch").actions;
    return Math.max(...pitch.map((a) => Math.abs(a.pos - 50)));
  };
  assert.ok(swing("gentle") < swing("medium") && swing("medium") < swing("strong"));
  assert.ok(swing("strong") <= 50);
});

test("scene cfg keeps the per-scene level", () => {
  assert.equal(Core.parseSceneCfg('{"v":2,"generate":"strong","channels":{}}').generate, "strong");
  assert.equal(Core.parseSceneCfg('{"v":2,"generate":"bogus","channels":{}}').generate, undefined);
  assert.equal(Core.isEmptyFileCfg({ offsetMs: 0, channels: {}, generate: "off" }), false);
  assert.equal(Core.isEmptyFileCfg({ offsetMs: 0, channels: {} }), true);
});

test("profile defaults and validation", () => {
  const d = Core.defaultProfile();
  assert.equal(d.generate, "off");
  assert.equal(d.generateVibe, false);
  assert.equal(Core.normalizeProfile({ generate: "bogus" }).generate, "off");
  assert.equal(Core.normalizeProfile({ generate: "gentle", generateVibe: 1 }).generateVibe, true);
});

// the same up-and-down motion sampled every 20 ms, as motion-tracked or generated scripts are
function denseScript(jitter) {
  const acts = [];
  for (let t = 0, i = 0; t <= 10000; t += 20, i++) {
    const pos = 50 - 50 * Math.cos(Math.PI * t / 500) + (jitter ? (i % 2 ? jitter : -jitter) : 0);
    acts.push({ at: t, pos: Math.min(100, Math.max(0, pos)) });
  }
  return [{ name: "stroke", actions: acts, inverted: false, source: "embedded" }];
}

test("follow leans fully on densely sampled scripts, jitter and all", () => {
  const swing = (chs, name) => Math.max(...chs.find((c) => c.name === name).actions.map((a) => Math.abs(a.pos - 50)));
  const sparse = gen(strokeScript(), profile("sr6"));
  for (const scripts of [denseScript(0), denseScript(2)]) {
    const dense = gen(scripts, profile("sr6"));
    for (const name of ["pitch", "surge"]) {
      assert.ok(swing(dense, name) >= 0.95 * swing(sparse, name), `${name}: ${swing(dense, name)} vs ${swing(sparse, name)}`);
    }
  }
});

test("follow holds still while the stroke pauses mid-stroke", () => {
  const acts = [{ at: 0, pos: 0 }, { at: 400, pos: 50 }, { at: 2400, pos: 50 }, { at: 2800, pos: 100 }, { at: 3200, pos: 0 }];
  const pitch = gen([{ name: "stroke", actions: acts, inverted: false }], profile("osr2"))
    .find((c) => c.name === "pitch").actions;
  const held = Core.valueAt(pitch, 400);
  assert.ok(Math.abs(held - 50) > 10, "leans at the middle of the stroke");
  for (const t of [800, 1400, 2000, 2400]) assert.equal(Core.valueAt(pitch, t), held);
  assert.equal(Core.valueAt(pitch, 2800), 50); // centred at the turning point
});
