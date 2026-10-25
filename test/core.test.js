// Smoke tests for the pure core of plugin/TCodePlayer.js (exported via
// module.exports when loaded outside the browser).
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../plugin/TCodePlayer.js");

test("parses 1.0, 1.1 axes and 2.0 channels", () => {
  const acts = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }];
  assert.deepEqual(Core.parseFunscript({ actions: acts }).channels.map((c) => c.name), ["stroke"]);
  assert.deepEqual(
    Core.parseFunscript({ actions: acts, axes: [{ id: "r1", actions: acts }] }).channels.map((c) => c.name),
    ["stroke", "R1"],
  );
  const v2 = Core.parseFunscript({ version: "2.0", actions: acts, channels: { Roll: { actions: acts, inverted: true } } });
  assert.equal(v2.version, "2.0");
  assert.deepEqual(v2.channels.map((c) => [c.name, c.inverted]), [["stroke", false], ["roll", true]]);
});

test("interpolates between actions", () => {
  const acts = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }];
  assert.equal(Core.valueAt(acts, 250), 25);
  assert.equal(Core.valueAt(acts, -5), 0);
  assert.equal(Core.valueAt(acts, 5000), 100);
  assert.equal(Core.valueAt([], 0), null);
});

test("channel stage lerps and XORs invert with the script flag", () => {
  assert.equal(Core.applyChannelMap(50, { min: 20, max: 80, invert: false }, false), 50);
  assert.equal(Core.applyChannelMap(100, { min: 20, max: 80, invert: false }, false), 80);
  assert.equal(Core.applyChannelMap(100, { min: 0, max: 100, invert: true }, false), 0);
  assert.equal(Core.applyChannelMap(100, { min: 0, max: 100, invert: true }, true), 100);
});

test("device caps and TCode formatting", () => {
  assert.equal(Core.applyAxisCaps(100, { min: 0, max: 50, invert: false }), 0.5);
  assert.equal(Core.tcodeCommand("L0", 0.5, 17), "L05000I17");
  assert.equal(Core.tcodeCommand("R1", 1, 0), "R19999");
});

test("presets decide enabled axes and keep tuning", () => {
  const p = Core.defaultProfile();
  p.axes.R1.max = 70;
  const sr6 = Core.applyPreset(p, "sr6");
  assert.equal(sr6.axes.L1.enabled, true);
  assert.equal(sr6.axes.R1.max, 70);
  assert.equal(Core.applyPreset(p, "ssr1").axes.R1.enabled, false);
  assert.equal(Core.detectModel(sr6.axes), "sr6");
  assert.equal(Core.normalizeProfile({ axes: sr6.axes }).model, "sr6");
});

test("scene cfg v2 and legacy v1", () => {
  const v2 = Core.parseSceneCfg('{"v":2,"offsetMs":40,"channels":{"pitch":{"invert":true}}}');
  assert.deepEqual(v2, { v: 2, offsetMs: 40, channels: { pitch: { invert: true } } });
  const v1 = Core.parseSceneCfg({ v: 1, files: { abc: { offsetMs: 10, channels: { roll: { min: 5 } } } } }, "abc");
  assert.deepEqual(v1, { v: 2, offsetMs: 10, channels: { roll: { min: 5 } } });
  assert.deepEqual(Core.parseSceneCfg("not json"), { v: 2, offsetMs: 0, channels: {} });
});
