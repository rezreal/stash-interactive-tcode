/*
 * TCode Player – Stash UI plugin
 * Plays single- and multi-axis funscripts on TCode devices (OSR2 / SR6) via Web Serial.
 *
 *  - Global device profile  -> Stash plugin configuration ("profile", JSON string)
 *  - Per-scene mapping      -> scene custom field "tcode_map" (JSON string, Stash >= v0.31)
 *
 * No build step: plain JS using window.PluginApi (React 17 via createElement).
 */
(function () {
  "use strict";

  const PLUGIN_ID = "TCodePlayer";
  const SCENE_FIELD = "tcode_map";
  const TAB_KEY = "scene-tcode-panel";

  /* ======================================================================
   * Core (pure functions, unit-testable in Node)
   * ==================================================================== */

  const AXES = ["L0", "L1", "L2", "R0", "R1", "R2", "V0", "V1", "A0", "A1", "A2"];
  const AXIS_LABELS = {
    L0: "Stroke", L1: "Surge", L2: "Sway",
    R0: "Twist", R1: "Roll", R2: "Pitch",
    V0: "Vibe", V1: "Vibe 2/Pump",
    A0: "Valve", A1: "Suction", A2: "Lube",
  };

  // channel name (lower case) -> TCode axis
  const DEFAULT_CHANNEL_MAP = {
    stroke: "L0", main: "L0",
    surge: "L1", sway: "L2",
    twist: "R0", roll: "R1", pitch: "R2",
    vib: "V0", vibe: "V0", vibrate: "V0", pump: "V1",
    valve: "A0", suck: "A1", suction: "A1", lube: "A2",
  };

  // channel names probed as sidecar files (video.<name>.funscript)
  const SIDECAR_NAMES = ["surge", "sway", "twist", "roll", "pitch", "vib", "pump", "valve", "suck", "lube"];

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function homeOf(axis) { return axis[0] === "V" || axis[0] === "A" ? 0 : 0.5; }

  // Device presets define which axes the hardware has. Auxiliary V/A axes (vibe, valve,
  // suction, lube add-ons) are included – they are only sent when a channel maps to them.
  const AUX_AXES = ["V0", "V1", "A0", "A1", "A2"];
  const DEVICE_PRESETS = {
    osr2: { label: "OSR2 / OSR2+", axes: ["L0", "R0", "R1", "R2"].concat(AUX_AXES) },
    sr6: { label: "SR6", axes: ["L0", "L1", "L2", "R0", "R1", "R2"].concat(AUX_AXES) },
    ssr1: { label: "SSR1 (stroke only)", axes: ["L0"].concat(AUX_AXES) },
    custom: { label: "Custom", axes: null },
  };

  function defaultAxisCfg(axis) {
    return { enabled: DEVICE_PRESETS.osr2.axes.indexOf(axis) >= 0, min: 0, max: 100, invert: false, speed: 0 };
  }

  /** Switch the device model; presets set which axes are enabled, tuning (range/invert/speed) is kept. */
  function applyPreset(profile, model) {
    const preset = DEVICE_PRESETS[model] || DEVICE_PRESETS.custom;
    const out = Object.assign({}, profile, { model: DEVICE_PRESETS[model] ? model : "custom", axes: {} });
    AXES.forEach((a) => {
      const ax = Object.assign({}, profile.axes[a]);
      if (preset.axes) ax.enabled = preset.axes.indexOf(a) >= 0;
      out.axes[a] = ax;
    });
    return out;
  }

  /** Detect which preset matches a set of enabled axes (for profiles saved before presets existed). */
  function detectModel(axes) {
    const enabled = AXES.filter((a) => axes[a] && axes[a].enabled).join(",");
    for (const k of Object.keys(DEVICE_PRESETS)) {
      const pa = DEVICE_PRESETS[k].axes;
      if (pa && AXES.filter((a) => pa.indexOf(a) >= 0).join(",") === enabled) return k;
    }
    return "custom";
  }

  function defaultProfile() {
    const axes = {};
    AXES.forEach((a) => { axes[a] = defaultAxisCfg(a); });
    return {
      v: 1,
      model: "osr2",
      baud: 115200,
      rateHz: 60,
      rampMs: 400,
      offsetMs: 0,
      autoConnect: true,
      homeOnPause: false,
      axes,
      channelMap: Object.assign({}, DEFAULT_CHANNEL_MAP),
      sidecar: { enabled: false, mappings: [] }, // [{ fs: "/media/videos", url: "/custom/videos" }]
    };
  }

  function normalizeProfile(p) {
    const d = defaultProfile();
    if (!p || typeof p !== "object") return d;
    const out = Object.assign({}, d, p);
    out.axes = {};
    AXES.forEach((a) => { out.axes[a] = Object.assign(defaultAxisCfg(a), (p.axes || {})[a] || {}); });
    out.channelMap = Object.assign({}, p.channelMap || d.channelMap);
    out.sidecar = Object.assign({}, d.sidecar, p.sidecar || {});
    out.sidecar.mappings = Array.isArray(out.sidecar.mappings) ? out.sidecar.mappings : [];
    out.rateHz = clamp(num(out.rateHz, 60), 10, 200);
    out.baud = num(out.baud, 115200);
    out.rampMs = clamp(num(out.rampMs, 400), 0, 3000);
    out.offsetMs = num(out.offsetMs, 0);
    const model = DEVICE_PRESETS[p.model] ? p.model : detectModel(out.axes);
    return applyPreset(out, model); // a preset is authoritative for which axes are enabled
  }

  function sanitizeActions(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const a of list) {
      if (!a) continue;
      const at = Number(a.at), pos = Number(a.pos);
      if (!Number.isFinite(at) || !Number.isFinite(pos)) continue;
      out.push({ at, pos: clamp(pos, 0, 100) });
    }
    out.sort((x, y) => x.at - y.at);
    return out;
  }

  /** Normalize a channel identifier: TCode IDs upper case, names lower case. */
  function normalizeChannelName(name) {
    const s = String(name || "").trim();
    if (/^[LRVA]\d$/i.test(s)) return s.toUpperCase();
    return s.toLowerCase();
  }

  /**
   * Parse any funscript flavour into a flat channel list.
   *   1.0 : { actions }
   *   1.1 : { actions, axes: [{ id, actions }] }
   *   2.0 : { actions, channels: { name: { actions } } }
   *   also tolerated: channels as array, additional_axes (HereSphere-style)
   */
  function parseFunscript(json, source) {
    source = source || "embedded";
    const channels = [];
    if (!json || typeof json !== "object") return { version: null, channels };
    const add = (name, actions, inverted, src) => {
      const acts = sanitizeActions(actions);
      if (!acts.length) return;
      name = normalizeChannelName(name);
      if (!name) return;
      const existing = channels.findIndex((c) => c.name === name);
      const ch = { name, actions: acts, inverted: !!inverted, source: src };
      if (existing >= 0) channels[existing] = ch; else channels.push(ch);
    };
    const addList = (list) => {
      if (!Array.isArray(list)) return;
      for (const ax of list) {
        if (!ax) continue;
        add(ax.id || ax.name || ax.axis || ax.channel, ax.actions, ax.inverted, source);
      }
    };

    add("stroke", json.actions, json.inverted, source);
    addList(json.axes);
    addList(json.additional_axes);
    if (Array.isArray(json.channels)) {
      addList(json.channels);
    } else if (json.channels && typeof json.channels === "object") {
      for (const key of Object.keys(json.channels)) {
        const val = json.channels[key];
        if (Array.isArray(val)) add(key, val, false, source);
        else if (val && typeof val === "object") add(key, val.actions, val.inverted, source);
      }
    }
    return { version: json.version != null ? String(json.version) : null, channels };
  }

  /** Merge sidecar channels over embedded ones (separate files win). */
  function mergeChannels(embedded, sidecars) {
    const out = embedded.slice();
    for (const s of sidecars) {
      const i = out.findIndex((c) => c.name === s.name);
      if (i >= 0) out[i] = s; else out.push(s);
    }
    return out;
  }

  /** Linear interpolation of a sorted action list at time t (ms). */
  function valueAt(actions, t) {
    const n = actions.length;
    if (!n) return null;
    if (t <= actions[0].at) return actions[0].pos;
    if (t >= actions[n - 1].at) return actions[n - 1].pos;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (actions[mid].at <= t) lo = mid; else hi = mid;
    }
    const a = actions[lo], b = actions[hi];
    const dt = b.at - a.at;
    if (dt <= 0) return b.pos;
    return a.pos + (b.pos - a.pos) * (t - a.at) / dt;
  }

  /** Default mapping for a channel, derived from the global profile. */
  function defaultEntry(name, profile) {
    const key = normalizeChannelName(name);
    let axis = (profile.channelMap || {})[key.toLowerCase()];
    if (!axis && AXES.indexOf(key) >= 0) axis = key;
    return { axis: axis || "off", invert: false, min: 0, max: 100 };
  }

  /** Effective mapping for every channel (defaults + per-scene overrides). */
  function resolveMapping(channels, profile, fileCfg) {
    const overrides = (fileCfg && fileCfg.channels) || {};
    return channels.map((ch) => {
      const base = defaultEntry(ch.name, profile);
      const ov = overrides[ch.name] || {};
      const m = Object.assign({}, base, ov);
      m.min = clamp(num(m.min, 0), 0, 100);
      m.max = clamp(num(m.max, 100), 0, 100);
      return Object.assign(m, { name: ch.name, custom: Object.keys(ov).length > 0 });
    });
  }

  /** Keep only the properties that differ from the defaults. */
  function stripDefaults(name, entry, profile) {
    const base = defaultEntry(name, profile);
    const out = {};
    ["axis", "invert", "min", "max"].forEach((k) => {
      if (entry[k] !== undefined && entry[k] !== base[k]) out[k] = entry[k];
    });
    return out;
  }

  /** Channel stage: 0..100 -> 0..100 (invert, then lerp into [min, max]). */
  function applyChannelMap(pos, m, scriptInverted) {
    let v = clamp(pos, 0, 100) / 100;
    if (!!m.invert !== !!scriptInverted) v = 1 - v;
    const lo = m.min / 100, hi = m.max / 100;
    return clamp(lo + (hi - lo) * v, 0, 1) * 100;
  }

  /** Device stage: 0..100 -> 0..1 (global per-axis invert + caps, lerped). */
  function applyAxisCaps(v, ax) {
    let x = clamp(v, 0, 100) / 100;
    if (ax.invert) x = 1 - x;
    const lo = clamp(num(ax.min, 0), 0, 100) / 100;
    const hi = clamp(num(ax.max, 100), 0, 100) / 100;
    return clamp(lo + (hi - lo) * x, 0, 1);
  }

  function tcodeValue(x) {
    return String(Math.round(clamp(x, 0, 1) * 9999)).padStart(4, "0");
  }

  function tcodeCommand(axis, x, intervalMs) {
    let s = axis + tcodeValue(x);
    if (intervalMs > 0) s += "I" + Math.max(1, Math.round(intervalMs));
    return s;
  }

  /**
   * Compute device targets (0..1) per axis for time t.
   * Later mapping entries win when two channels target the same axis.
   */
  function computeTargets(channels, mapping, profile, t) {
    const out = {};
    for (let i = 0; i < mapping.length; i++) {
      const m = mapping[i];
      if (m.axis === "off") continue;
      const ax = profile.axes[m.axis];
      if (!ax || !ax.enabled) continue;
      const ch = channels[i];
      const raw = valueAt(ch.actions, t);
      if (raw == null) continue;
      out[m.axis] = applyAxisCaps(applyChannelMap(raw, m, ch.inverted), ax);
    }
    return out;
  }

  /** Axes targeted by more than one channel. */
  function findConflicts(mapping) {
    const seen = {}, dup = {};
    mapping.forEach((m) => {
      if (m.axis === "off") return;
      if (seen[m.axis]) dup[m.axis] = true;
      seen[m.axis] = true;
    });
    return dup;
  }

  /** Build sidecar URL for a video path using the configured served-folder mappings. */
  function sidecarUrl(videoPath, mappings, name, baseUri) {
    if (!videoPath) return null;
    const p = String(videoPath).replace(/\\/g, "/");
    for (const m of mappings || []) {
      if (!m || !m.fs || !m.url) continue;
      const fs = String(m.fs).replace(/\\/g, "/").replace(/\/+$/, "");
      if (p !== fs && !p.startsWith(fs + "/")) continue;
      const rest = p.slice(fs.length).replace(/^\/+/, "");
      const noExt = rest.replace(/\.[^./]+$/, "");
      const enc = noExt.split("/").map(encodeURIComponent).join("/");
      const prefix = String(m.url).replace(/\/+$/, "");
      const rel = prefix + "/" + enc + "." + name + ".funscript";
      try { return new URL(rel.replace(/^\//, ""), baseUri).toString(); } catch (e) { return rel; }
    }
    return null;
  }

  /**
   * Scene custom field -> { v: 2, offsetMs, channels }.
   * Also reads the old per-file format { v: 1, files: { <hash>: {...} } } (prefers legacyKey, else first entry).
   */
  function parseSceneCfg(value, legacyKey) {
    const empty = { v: 2, offsetMs: 0, channels: {} };
    if (!value) return empty;
    let o;
    try { o = typeof value === "string" ? JSON.parse(value) : value; } catch (e) { return empty; }
    if (!o || typeof o !== "object") return empty;
    if (o.files && typeof o.files === "object") {
      o = o.files[legacyKey] || Object.values(o.files)[0] || {};
    }
    const channels = o.channels && typeof o.channels === "object" ? o.channels : {};
    return { v: 2, offsetMs: num(o.offsetMs, 0), channels };
  }

  function isEmptyFileCfg(fc) {
    return !fc || (!num(fc.offsetMs, 0) && Object.keys(fc.channels || {}).length === 0);
  }

  function fileKeyOf(file) {
    if (!file) return "default";
    const fps = file.fingerprints || [];
    const pick = (t) => (fps.find((f) => f.type === t) || {}).value;
    return pick("oshash") || pick("md5") || (file.id ? "file-" + file.id : "default");
  }

  const Core = {
    AXES, AXIS_LABELS, DEFAULT_CHANNEL_MAP, DEVICE_PRESETS, applyPreset, detectModel, defaultProfile, normalizeProfile,
    parseFunscript, mergeChannels, valueAt, resolveMapping, stripDefaults,
    applyChannelMap, applyAxisCaps, tcodeCommand, computeTargets, findConflicts,
    sidecarUrl, parseSceneCfg, isEmptyFileCfg, fileKeyOf, normalizeChannelName,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Core;
  }
  if (typeof window === "undefined" || !window.PluginApi) return;

  /* ======================================================================
   * Stash GraphQL helpers
   * ==================================================================== */

  const api = window.PluginApi;
  const React = api.React;
  const h = React.createElement;
  const { Button, Form, Modal, Dropdown, Nav, Tab, Badge, Table } = api.libraries.Bootstrap;
  const { FontAwesomeIcon } = api.libraries.ReactFontAwesome;
  const Icons = api.libraries.FontAwesomeSolid;
  const gql = api.libraries.Apollo.gql;

  function client() { return api.utils.StashService.getClient(); }

  const Q_PLUGIN_CFG = gql`
    query TCodePlayerConfig($include: [ID!]) {
      configuration { plugins(include: $include) }
    }`;
  const M_PLUGIN_CFG = gql`
    mutation TCodePlayerConfigure($plugin_id: ID!, $input: Map!) {
      configurePlugin(plugin_id: $plugin_id, input: $input)
    }`;
  const M_SCENE_FIELDS = gql`
    mutation TCodePlayerSceneFields($input: SceneUpdateInput!) {
      sceneUpdate(input: $input) { id custom_fields }
    }`;

  async function loadProfileFromServer() {
    const res = await client().query({
      query: Q_PLUGIN_CFG, variables: { include: [PLUGIN_ID] }, fetchPolicy: "no-cache",
    });
    const all = (res.data && res.data.configuration && res.data.configuration.plugins) || {};
    const raw = all[PLUGIN_ID] && all[PLUGIN_ID].profile;
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
    return normalizeProfile(parsed);
  }

  async function saveProfileToServer(profile) {
    await client().mutate({
      mutation: M_PLUGIN_CFG,
      variables: { plugin_id: PLUGIN_ID, input: { profile: JSON.stringify(profile) } },
    });
  }

  async function saveSceneField(sceneId, value) {
    const custom_fields = value == null
      ? { remove: [SCENE_FIELD] }
      : { partial: { [SCENE_FIELD]: value } };
    await client().mutate({
      mutation: M_SCENE_FIELDS,
      variables: { input: { id: sceneId, custom_fields } },
    });
  }

  /* ======================================================================
   * Engine (singleton): serial connection, scripts, playback loop
   * ==================================================================== */

  const encoder = new TextEncoder();
  const PORT_KEY = "tcp-port"; // getInfo() of the port this plugin last opened

  function portId(port) {
    try { return JSON.stringify(port.getInfo()); } catch (e) { return "{}"; }
  }

  const engine = {
    state: {
      supported: typeof navigator !== "undefined" && "serial" in navigator,
      secure: typeof window !== "undefined" && window.isSecureContext,
      status: "disconnected", // disconnected | connecting | connected | error
      error: null,
      deviceInfo: null,
      deviceLog: [],
      outputEnabled: true,
      profile: defaultProfile(),
      profileLoaded: false,
      scene: null,       // { id, title, durationMs, path, funscriptUrl, interactive }
      fileKey: null,
      sceneCfg: null,    // full saved custom-field object
      edit: null,        // working copy for the current file { offsetMs, channels }
      dirty: false,
      channels: [],
      scriptVersion: null,
      scriptState: "idle", // idle | loading | ready | none | error
      scriptError: null,
      mapping: [],
      conflicts: {},
      hasVideo: false,
      playing: false,
      testing: false,
      previews: 0,       // number of mounted 3D previews (they act as virtual devices)
      live: {},
    },
    _listeners: new Set(),
    _emus: new Set(),
    _port: null,
    _writer: null,
    _reader: null,
    _readDone: null,
    _writing: false,
    _timer: null,
    _videoWatch: null,
    _video: null,
    _videoHandlers: null,
    _last: {},
    _rampUntil: 0,
    _rampPending: false,
    _loadToken: 0,
    _liveNotify: 0,
    _sceneRefs: 0,

    subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
    set(patch) { Object.assign(this.state, patch); this._listeners.forEach((fn) => fn()); },

    /* ---------- profile ---------- */
    async init() {
      try {
        const profile = await loadProfileFromServer();
        this.set({ profile, profileLoaded: true });
      } catch (e) {
        console.warn("[TCodePlayer] could not load profile", e);
        this.set({ profileLoaded: true });
      }
      this.recompute();
      if (this.state.supported && this.state.profile.autoConnect) this.autoConnect();
      if (this.state.supported) {
        navigator.serial.addEventListener("disconnect", (ev) => {
          if (this._port && ev.target === this._port) this._cleanup("Device unplugged");
        });
      }
    },

    async saveProfile(profile) {
      profile = normalizeProfile(profile);
      await saveProfileToServer(profile);
      this.set({ profile });
      this.recompute();
      this._restartTimerIfRunning();
    },

    /* ---------- serial ---------- */
    async connect() {
      if (!this.state.supported) return;
      try {
        const port = await navigator.serial.requestPort();
        await this._open(port);
      } catch (e) {
        if (e && e.name === "NotFoundError") return; // user cancelled the picker
        this.set({ status: "error", error: String((e && e.message) || e) });
      }
    },

    /**
     * Serial permissions are per origin, so getPorts() also lists ports other Stash plugins were granted.
     * Only reconnect to the port this plugin used last, skip ports that are already open, and back off
     * quietly if it is busy - another plugin, tab or app (e.g. Intiface) may own it.
     */
    async autoConnect() {
      try {
        const known = lsGet(PORT_KEY);
        if (!known) return;
        const ports = await navigator.serial.getPorts();
        for (const port of ports) {
          if (this.state.status !== "disconnected") return;
          if (port.readable || portId(port) !== known) continue;
          if (await this._open(port, true)) return;
        }
      } catch (e) {
        console.warn("[TCodePlayer] auto-connect failed", e);
      }
    },

    async _open(port, quiet) {
      if (port.readable) {
        // opened by someone else in this page
        if (!quiet) this.set({ status: "error", error: "This port is already in use by another plugin." });
        return false;
      }
      this.set({ status: "connecting", error: null, deviceInfo: null, deviceLog: [] });
      try {
        await port.open({ baudRate: this.state.profile.baud });
      } catch (e) {
        if (quiet) {
          console.info("[TCodePlayer] remembered port is busy, not auto-connecting", e);
          this.set({ status: "disconnected" });
        } else {
          this.set({ status: "error", error: "Could not open port (in use by another tab or app?): " + ((e && e.message) || e) });
        }
        return false;
      }
      lsSet(PORT_KEY, portId(port));
      this._port = port;
      this._writer = port.writable.getWriter();
      this._readDone = this._readLoop(port);
      this._last = {};
      this.set({ status: "connected" });
      // ESP32/Arduino boards reset when the port opens – ask for firmware info after boot.
      setTimeout(() => this.sendRaw("D1"), 2000);
      this.updateLoop();
      return true;
    },

    async _readLoop(port) {
      if (!port.readable) return;
      const decoder = new TextDecoderStream();
      const piped = port.readable.pipeTo(decoder.writable).catch(() => {});
      const reader = decoder.readable.getReader();
      this._reader = reader;
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) this._onLine(line);
          }
        }
      } catch (e) {
        /* reader cancelled or device lost */
      } finally {
        try { reader.releaseLock(); } catch (e) { /* ignore */ }
      }
      await piped;
    },

    _onLine(line) {
      const log = this.state.deviceLog.concat(line).slice(-30);
      const patch = { deviceLog: log };
      if (!this.state.deviceInfo && /tcode|osr|sr6|tempest/i.test(line)) patch.deviceInfo = line;
      this.set(patch);
    },

    async disconnect() {
      if (!this._port) return;
      this.home(600);
      await new Promise((r) => setTimeout(r, 650));
      await this._cleanup(null);
    },

    async _cleanup(reason) {
      this._stopTimer();
      const port = this._port;
      this._port = null;
      try { if (this._reader) await this._reader.cancel(); } catch (e) { /* ignore */ }
      try { if (this._readDone) await this._readDone; } catch (e) { /* ignore */ }
      try { if (this._writer) { this._writer.releaseLock(); } } catch (e) { /* ignore */ }
      try { if (port) await port.close(); } catch (e) { /* ignore */ }
      this._reader = null; this._writer = null; this._readDone = null; this._writing = false;
      this.set({ status: reason ? "error" : "disconnected", error: reason, live: {} });
    },

    /** true when something consumes TCode: a serial device and/or a 3D preview. */
    hasOutput() { return !!this._port || this._emus.size > 0; },

    addEmulator(emu) {
      this._emus.add(emu);
      // start the preview at the device's last known position
      const parts = Object.keys(this._last).map((a) => tcodeCommand(a, this._last[a], 0));
      try { if (parts.length) emu.write(parts.join(" ") + "\n"); } catch (e) { /* ignore */ }
      this._rampPending = true;
      this.set({ previews: this._emus.size });
      this.updateLoop();
    },

    removeEmulator(emu) {
      this._emus.delete(emu);
      this.set({ previews: this._emus.size });
      this.updateLoop();
    },

    sendRaw(line) {
      // drop the frame for everyone while the serial port is busy, so device and preview stay identical
      if (this._writer && this._writing) return false;
      this._emus.forEach((emu) => { try { emu.write(line + "\n"); } catch (e) { /* ignore */ } });
      if (!this._writer) return this._emus.size > 0;
      this._writing = true;
      this._writer.write(encoder.encode(line + "\n"))
        .catch((e) => console.warn("[TCodePlayer] write failed", e))
        .finally(() => { this._writing = false; });
      return true;
    },

    /** Send absolute device positions {axis: 0..1} with an interval. */
    sendTargets(targets, intervalMs) {
      const parts = Object.keys(targets).map((a) => tcodeCommand(a, targets[a], intervalMs));
      if (!parts.length) return false;
      return this.sendRaw(parts.join(" "));
    },

    home(intervalMs) {
      const targets = {};
      const p = this.state.profile;
      const axes = new Set(this.state.mapping.filter((m) => m.axis !== "off").map((m) => m.axis));
      axes.add("L0");
      axes.forEach((a) => {
        const ax = p.axes[a];
        if (ax && ax.enabled) targets[a] = homeOf(a) === 0 ? 0 : applyAxisCaps(50, ax);
      });
      this._last = Object.assign({}, this._last, targets);
      this.sendTargets(targets, intervalMs || 800);
    },

    setOutputEnabled(on) {
      this.set({ outputEnabled: !!on });
      if (!on) this.home(600);
      this.updateLoop();
    },

    /* ---------- scene ---------- */
    bindScene(scene) {
      this._sceneRefs++;
      const file = (scene.files || [])[0];
      const fileKey = fileKeyOf(file);
      if (this.state.scene && this.state.scene.id === scene.id && this.state.fileKey === fileKey) return;

      const sceneCfg = parseSceneCfg(scene.custom_fields && scene.custom_fields[SCENE_FIELD], fileKey);
      const saved = sceneCfg;
      this.set({
        scene: {
          id: scene.id,
          title: scene.title || (file && file.path ? file.path.split(/[\\/]/).pop() : "Scene " + scene.id),
          durationMs: file && file.duration ? file.duration * 1000 : 0,
          path: file ? file.path : null,
          funscriptUrl: scene.paths && scene.paths.funscript,
          interactive: !!scene.interactive,
        },
        fileKey,
        sceneCfg,
        edit: { offsetMs: num(saved.offsetMs, 0), channels: clone(saved.channels || {}) },
        dirty: false,
        channels: [],
        scriptVersion: null,
        scriptState: "idle",
        scriptError: null,
      });
      this.recompute();
      this.loadScripts();
      this._startVideoWatch();
    },

    unbindScene(sceneId) {
      this._sceneRefs = Math.max(0, this._sceneRefs - 1);
      if (this._sceneRefs > 0) return;
      if (!this.state.scene || this.state.scene.id !== sceneId) return;
      this._stopVideoWatch();
      this._attachVideo(null);
      if (this.hasOutput()) this.home(800);
      this.set({ scene: null, fileKey: null, channels: [], mapping: [], edit: null, dirty: false, scriptState: "idle" });
    },

    async loadScripts() {
      const token = ++this._loadToken;
      const s = this.state.scene;
      if (!s) return;
      this.set({ scriptState: "loading", scriptError: null });
      let embedded = [], version = null, error = null;

      if (s.interactive && s.funscriptUrl) {
        try {
          const res = await fetch(s.funscriptUrl, { credentials: "same-origin" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const parsed = parseFunscript(await res.json(), "embedded");
          embedded = parsed.channels;
          version = parsed.version;
        } catch (e) {
          error = "Could not load funscript: " + ((e && e.message) || e);
        }
      }

      let sidecars = [];
      const sc = this.state.profile.sidecar;
      if (sc && sc.enabled && sc.mappings.length && s.path) {
        const names = new Set(SIDECAR_NAMES);
        Object.keys(this.state.profile.channelMap).forEach((n) => { if (!/^[LRVA]\d$/i.test(n)) names.add(n); });
        names.delete("stroke"); names.delete("main");
        const results = await Promise.all(Array.from(names).map(async (name) => {
          const url = sidecarUrl(s.path, sc.mappings, name, document.baseURI);
          if (!url) return null;
          try {
            const res = await fetch(url, { credentials: "same-origin" });
            if (!res.ok) return null;
            const parsed = parseFunscript(await res.json(), "file");
            const main = parsed.channels.find((c) => c.name === "stroke") || parsed.channels[0];
            return main ? Object.assign({}, main, { name, source: "file" }) : null;
          } catch (e) { return null; }
        }));
        sidecars = results.filter(Boolean);
      }

      if (token !== this._loadToken) return;
      const channels = mergeChannels(embedded, sidecars);
      this.set({
        channels,
        scriptVersion: version,
        scriptState: channels.length ? "ready" : (error ? "error" : "none"),
        scriptError: error,
      });
      this.recompute();
    },

    /* ---------- mapping edits ---------- */
    recompute() {
      const mapping = resolveMapping(this.state.channels, this.state.profile, this.state.edit);
      this.set({ mapping, conflicts: findConflicts(mapping) });
      this.updateLoop();
    },

    setChannel(name, patch) {
      if (!this.state.edit) return;
      const edit = clone(this.state.edit);
      const current = this.state.mapping.find((m) => m.name === name) || defaultEntry(name, this.state.profile);
      const merged = Object.assign({ axis: current.axis, invert: current.invert, min: current.min, max: current.max }, patch);
      if (merged.min > merged.max) { const t = merged.min; merged.min = merged.max; merged.max = t; }
      const diff = stripDefaults(name, merged, this.state.profile);
      if (Object.keys(diff).length) edit.channels[name] = diff; else delete edit.channels[name];
      this.set({ edit, dirty: true });
      this.recompute();
    },

    setSceneOffset(ms) {
      if (!this.state.edit) return;
      this.set({ edit: Object.assign({}, this.state.edit, { offsetMs: num(ms, 0) }), dirty: true });
    },

    resetSceneToDefaults() {
      this.set({ edit: { offsetMs: 0, channels: {} }, dirty: true });
      this.recompute();
    },

    revertScene() {
      const saved = this.state.sceneCfg || { offsetMs: 0, channels: {} };
      this.set({ edit: { offsetMs: num(saved.offsetMs, 0), channels: clone(saved.channels || {}) }, dirty: false });
      this.recompute();
    },

    async saveScene() {
      const s = this.state.scene;
      if (!s) return;
      const e = this.state.edit || {};
      const cfg = { v: 2 };
      if (num(e.offsetMs, 0)) cfg.offsetMs = num(e.offsetMs, 0);
      cfg.channels = clone(e.channels || {});
      // nothing customised -> remove the field entirely
      const value = isEmptyFileCfg(cfg) ? null : JSON.stringify(cfg);
      await saveSceneField(s.id, value);
      this.set({ sceneCfg: cfg, dirty: false });
    },

    /* ---------- video & playback ---------- */
    _startVideoWatch() {
      this._stopVideoWatch();
      const find = () => {
        const v = document.querySelector(".VideoPlayer video") || document.querySelector(".video-wrapper video");
        if (v !== this._video) this._attachVideo(v);
      };
      find();
      this._videoWatch = setInterval(find, 500);
    },

    _stopVideoWatch() {
      if (this._videoWatch) clearInterval(this._videoWatch);
      this._videoWatch = null;
    },

    _attachVideo(video) {
      if (this._video && this._videoHandlers) {
        for (const [ev, fn] of Object.entries(this._videoHandlers)) this._video.removeEventListener(ev, fn);
      }
      this._video = video;
      this._videoHandlers = null;
      if (video) {
        const resync = () => { this._rampPending = true; this.updateLoop(); };
        const onPause = () => {
          this.updateLoop();
          if (this.state.profile.homeOnPause && this.hasOutput()) this.home(800);
        };
        this._videoHandlers = {
          play: resync, playing: resync, seeked: resync,
          pause: onPause, ended: onPause, emptied: onPause,
        };
        for (const [ev, fn] of Object.entries(this._videoHandlers)) video.addEventListener(ev, fn);
      }
      this.set({ hasVideo: !!video });
      this._rampPending = true;
      this.updateLoop();
    },

    _shouldRun() {
      const v = this._video;
      return !!(this.hasOutput() && this.state.outputEnabled && !this.state.testing && v && !v.paused && !v.ended &&
        this.state.mapping.some((m) => m.axis !== "off"));
    },

    updateLoop() {
      const run = this._shouldRun();
      if (run && !this._timer) {
        this._rampPending = true;
        this._timer = setInterval(() => this._tick(), 1000 / this.state.profile.rateHz);
      } else if (!run && this._timer) {
        this._stopTimer();
      }
      const playing = !!(this._video && !this._video.paused && !this._video.ended);
      if (playing !== this.state.playing) this.set({ playing });
    },

    _stopTimer() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    },

    _restartTimerIfRunning() {
      if (this._timer) { this._stopTimer(); this.updateLoop(); }
    },

    _tick() {
      const v = this._video;
      if (!v || !this._shouldRun()) { this.updateLoop(); return; }
      const now = performance.now();
      if (now < this._rampUntil) return; // let the device finish the resync move

      const p = this.state.profile;
      const dt = 1000 / p.rateHz;
      const offset = num(p.offsetMs, 0) + num(this.state.edit && this.state.edit.offsetMs, 0);
      const t = v.currentTime * 1000 + offset + dt; // aim one tick ahead
      const targets = computeTargets(this.state.channels, this.state.mapping, p, t);

      let interval = dt;
      if (this._rampPending) {
        interval = p.rampMs || dt;
        this._rampPending = false;
        this._rampUntil = now + interval;
      } else {
        // per-axis speed limits (percent of range per second)
        for (const a of Object.keys(targets)) {
          const sp = num(p.axes[a].speed, 0);
          if (sp > 0 && this._last[a] != null) {
            const maxStep = (sp / 100) * (dt / 1000);
            targets[a] = clamp(targets[a], this._last[a] - maxStep, this._last[a] + maxStep);
          }
        }
      }

      if (this.sendTargets(targets, interval)) {
        Object.assign(this._last, targets);
        if (now - this._liveNotify > 100) {
          this._liveNotify = now;
          this.set({ live: Object.assign({}, this._last) });
        }
      }
    },

    /** Sweep one channel/axis through its mapped range to identify direction & limits. */
    async test(axis, lowHigh) {
      if (!this.hasOutput() || this.state.testing) return;
      const ax = this.state.profile.axes[axis];
      if (!ax) return;
      this.set({ testing: true });
      this.updateLoop();
      const lo = lowHigh[0], hi = lowHigh[1];
      const home = homeOf(axis) === 0 ? 0 : (lo + hi) / 2;
      const seq = [[lo, 700], [hi, 900], [lo, 900], [home, 700]];
      for (const [x, ms] of seq) {
        // wait for any in-flight write, then send
        for (let i = 0; i < 20 && this._writing; i++) await new Promise((r) => setTimeout(r, 10));
        this.sendTargets({ [axis]: x }, ms);
        this._last[axis] = x;
        await new Promise((r) => setTimeout(r, ms + 50));
      }
      this._rampPending = true;
      this.set({ testing: false });
      this.updateLoop();
    },

    testChannel(entry) {
      if (entry.axis === "off") return;
      const ax = this.state.profile.axes[entry.axis];
      const ch = this.state.channels.find((c) => c.name === entry.name);
      const inv = ch ? ch.inverted : false;
      const lo = applyAxisCaps(applyChannelMap(0, entry, inv), ax);
      const hi = applyAxisCaps(applyChannelMap(100, entry, inv), ax);
      return this.test(entry.axis, [lo, hi]);
    },

    testAxisCfg(axis, axCfg) {
      return this.test(axis, [applyAxisCaps(0, axCfg), applyAxisCaps(100, axCfg)]);
    },
  };

  /* ======================================================================
   * UI
   * ==================================================================== */

  function useEngine() {
    const [, force] = React.useReducer((x) => x + 1, 0);
    React.useEffect(() => engine.subscribe(force), []);
    return engine.state;
  }

  function icon(i, extra) {
    return i ? h(FontAwesomeIcon, Object.assign({ icon: i }, extra || {})) : null;
  }

  const statusText = {
    disconnected: "Not connected",
    connecting: "Connecting…",
    connected: "Connected",
    error: "Error",
  };

  function UnsupportedNotice() {
    const s = engine.state;
    if (s.supported) return null;
    return h("div", { className: "tcp-notice" },
      !s.secure
        ? "Web Serial needs a secure page. Open Stash via HTTPS or http://localhost to connect a device."
        : "This browser has no Web Serial support. Use Chrome, Edge or Opera on desktop.");
  }

  function StatusDot({ status }) {
    return h("span", { className: "tcp-dot tcp-dot-" + status, title: statusText[status] });
  }

  function ConnectButton() {
    const s = useEngine();
    if (!s.supported) return null;
    if (s.status === "connected") {
      return h(Button, { size: "sm", variant: "secondary", onClick: () => engine.disconnect() }, "Disconnect");
    }
    return h(Button, {
      size: "sm", variant: "primary", disabled: s.status === "connecting",
      onClick: () => engine.connect(),
    }, s.status === "connecting" ? "Connecting…" : "Connect device");
  }

  /* ---------- navbar menu ---------- */

  const NavToggle = React.forwardRef(function NavToggle({ onClick, status, live, id }, ref) {
    return h(Button, {
      ref, id, "aria-haspopup": true, className: "minimal tcp-nav-toggle", title: "TCode Player: " + statusText[status],
      onClick: (e) => { e.preventDefault(); onClick(e); },
    }, icon(Icons.faWaveSquare), h(StatusDot, { status: live ? "live" : status }));
  });

  function NavMenu() {
    const s = useEngine();
    const [showSettings, setShowSettings] = React.useState(false);
    const live = s.status === "connected" && s.playing && s.outputEnabled;

    const [uid] = React.useState(() => "tcp-" + Math.random().toString(36).slice(2, 8));
    const [menuOpen, setMenuOpen] = React.useState(false);
    return h(React.Fragment, null,
      h(Dropdown, { className: "tcp-nav", alignRight: true, show: menuOpen, onToggle: (v) => setMenuOpen(v) },
        h(Dropdown.Toggle, { as: NavToggle, id: uid + "-toggle", status: s.status, live }),
        h(Dropdown.Menu, { className: "tcp-nav-menu" },
          h("div", { className: "tcp-nav-body", onClick: (e) => e.stopPropagation() },
            h("div", { className: "tcp-nav-title" }, "TCode Player"),
            h(UnsupportedNotice),
            s.supported && h("div", { className: "tcp-row" },
              h(StatusDot, { status: s.status }),
              h("span", { className: "tcp-grow" }, statusText[s.status]),
              h(ConnectButton)),
            s.error && h("div", { className: "tcp-error" }, s.error),
            h("div", { className: "tcp-muted tcp-small" },
              (DEVICE_PRESETS[s.profile.model] || DEVICE_PRESETS.custom).label,
              s.deviceInfo ? " · " + s.deviceInfo : ""),
            h(Form.Check, {
              type: "switch", id: uid + "-out", label: "Send motion to device",
              checked: s.outputEnabled, onChange: (e) => engine.setOutputEnabled(e.target.checked),
            }),
            s.scene && h("div", { className: "tcp-muted tcp-small" },
              s.scriptState === "ready"
                ? `${s.channels.length} channel${s.channels.length === 1 ? "" : "s"} loaded for this scene`
                : s.scriptState === "loading" ? "Loading scripts…" : "No script for this scene"),
            h("div", { className: "tcp-row tcp-mt" },
              h(Button, { size: "sm", variant: "secondary", onClick: () => { setMenuOpen(false); setShowSettings(true); } },
                icon(Icons.faCog), " Device settings"),
              s.status === "connected" && h(Button, { size: "sm", variant: "secondary", onClick: () => engine.home(800) }, "Home")),
          ))),
      showSettings && h(SettingsModal, { onHide: () => setShowSettings(false) }));
  }

  /* ---------- device settings modal ---------- */

  function NumberInput({ value, onChange, min, max, step, width }) {
    return h(Form.Control, {
      type: "number", size: "sm", className: "tcp-num", style: width ? { width } : undefined,
      value, min, max, step: step || 1,
      onChange: (e) => onChange(e.target.value === "" ? "" : Number(e.target.value)),
    });
  }

  function AxisSelect({ value, onChange, profile }) {
    return h(Form.Control, {
      as: "select", size: "sm", className: "tcp-select", value,
      onChange: (e) => onChange(e.target.value),
    },
    h("option", { value: "off" }, "— off —"),
    AXES.map((a) => h("option", { key: a, value: a },
      `${a} ${AXIS_LABELS[a]}${profile && !profile.axes[a].enabled ? " (disabled)" : ""}`)));
  }

  function RangePair({ min, max, onChange }) {
    return h("div", { className: "tcp-range" },
      h("input", {
        type: "range", className: "custom-range", min: 0, max: 100, value: min,
        onChange: (e) => onChange(Math.min(Number(e.target.value), max), max),
      }),
      h("input", {
        type: "range", className: "custom-range", min: 0, max: 100, value: max,
        onChange: (e) => onChange(min, Math.max(Number(e.target.value), min)),
      }),
      h("span", { className: "tcp-range-label" }, `${min}–${max}`));
  }

  function SettingsModal({ onHide }) {
    const s = useEngine();
    const [p, setP] = React.useState(() => clone(s.profile));
    const [saving, setSaving] = React.useState(false);
    const [newName, setNewName] = React.useState("");
    const Toast = api.hooks.useToast();

    const upd = (patch) => setP(Object.assign({}, p, patch));
    const updAxis = (a, patch) => {
      const next = Object.assign({}, p, { axes: Object.assign({}, p.axes, { [a]: Object.assign({}, p.axes[a], patch) }) });
      if ("enabled" in patch) next.model = "custom"; // hand-picked axes -> custom device
      setP(next);
    };
    const updMap = (name, axis) => setP(Object.assign({}, p, { channelMap: Object.assign({}, p.channelMap, { [name]: axis }) }));
    const delMap = (name) => { const m = Object.assign({}, p.channelMap); delete m[name]; setP(Object.assign({}, p, { channelMap: m })); };
    const sc = p.sidecar;
    const updSc = (patch) => upd({ sidecar: Object.assign({}, sc, patch) });

    async function save() {
      setSaving(true);
      try {
        await engine.saveProfile(p);
        Toast.success("TCode device profile saved");
        if (engine.state.scene) engine.loadScripts();
        onHide(); // unmounts the modal – no state updates after this
      } catch (e) {
        Toast.error(e);
        setSaving(false);
      }
    }

    return h(Modal, { show: true, onHide, size: "lg", className: "tcp-modal" },
      h(Modal.Header, { closeButton: true }, h(Modal.Title, null, "TCode device settings")),
      h(Modal.Body, null,
        h("h6", null, "Device"),
        h("div", { className: "tcp-row" },
          h(Form.Control, {
            as: "select", size: "sm", className: "tcp-select", value: p.model,
            onChange: (e) => setP(applyPreset(p, e.target.value)),
          }, Object.keys(DEVICE_PRESETS).map((k) => h("option", { key: k, value: k }, DEVICE_PRESETS[k].label))),
          h("span", { className: "tcp-muted tcp-small" },
            p.model === "custom"
              ? "Choose the active axes yourself in the table below."
              : "Active axes come from the preset. Range, invert and speed stay as you set them.")),

        h("h6", { className: "tcp-mt" }, "Connection & playback"),
        h("div", { className: "tcp-grid" },
          h("label", null, "Baud rate"), h(NumberInput, { value: p.baud, onChange: (v) => upd({ baud: v }) }),
          h("label", null, "Update rate (Hz)"), h(NumberInput, { value: p.rateHz, min: 10, max: 200, onChange: (v) => upd({ rateHz: v }) }),
          h("label", null, "Resync ramp (ms)"), h(NumberInput, { value: p.rampMs, min: 0, max: 3000, step: 50, onChange: (v) => upd({ rampMs: v }) }),
          h("label", null, "Global offset (ms)"), h(NumberInput, { value: p.offsetMs, step: 10, onChange: (v) => upd({ offsetMs: v }) })),
        h(Form.Check, { type: "switch", id: "tcp-auto", label: "Reconnect to the last device automatically", checked: !!p.autoConnect, onChange: (e) => upd({ autoConnect: e.target.checked }) }),
        h(Form.Check, { type: "switch", id: "tcp-home", label: "Return to home position when paused", checked: !!p.homeOnPause, onChange: (e) => upd({ homeOnPause: e.target.checked }) }),

        h("h6", { className: "tcp-mt" }, "Axes (device limits)"),
        h("p", { className: "tcp-muted tcp-small" }, "Min/Max scale the full script range into this window (lerp), so motion keeps its shape. Speed limit is in % of range per second (0 = off)."),
        h(Table, { size: "sm", className: "tcp-table" },
          h("thead", null, h("tr", null,
            h("th", null, "Axis"), h("th", null, "On"), h("th", null, "Range"), h("th", null, "Invert"), h("th", null, "Speed"), h("th", null, ""))),
          h("tbody", null, AXES.map((a) => h("tr", { key: a, className: p.axes[a].enabled ? "" : "tcp-off" },
            h("td", null, h("b", null, a), " ", h("span", { className: "tcp-muted" }, AXIS_LABELS[a])),
            h("td", null, h(Form.Check, { id: "tcp-ax-on-" + a, checked: !!p.axes[a].enabled, onChange: (e) => updAxis(a, { enabled: e.target.checked }) })),
            h("td", null, h(RangePair, { min: p.axes[a].min, max: p.axes[a].max, onChange: (mn, mx) => updAxis(a, { min: mn, max: mx }) })),
            h("td", null, h(Form.Check, { id: "tcp-ax-inv-" + a, checked: !!p.axes[a].invert, onChange: (e) => updAxis(a, { invert: e.target.checked }) })),
            h("td", null, h(NumberInput, { value: p.axes[a].speed, min: 0, step: 50, width: 80, onChange: (v) => updAxis(a, { speed: v }) })),
            h("td", null, h(Button, {
              size: "sm", variant: "secondary", disabled: !(s.status === "connected" || s.previews > 0) || s.testing || !p.axes[a].enabled,
              onClick: () => engine.testAxisCfg(a, normalizeProfile(p).axes[a]),
            }, "Test")))))),

        h("h6", { className: "tcp-mt" }, "Default channel → axis mapping"),
        h("p", { className: "tcp-muted tcp-small" }, "Used for every scene without its own mapping. Add aliases for unusual channel names."),
        h(Table, { size: "sm", className: "tcp-table" },
          h("tbody", null,
            Object.keys(p.channelMap).sort().map((name) => h("tr", { key: name },
              h("td", null, h("code", null, name)),
              h("td", null, h(AxisSelect, { value: p.channelMap[name], profile: p, onChange: (v) => updMap(name, v) })),
              h("td", null, h(Button, { size: "sm", variant: "link", onClick: () => delMap(name) }, icon(Icons.faTimes))))),
            h("tr", null,
              h("td", null, h(Form.Control, { size: "sm", placeholder: "channel name", value: newName, onChange: (e) => setNewName(e.target.value) })),
              h("td", { colSpan: 2 }, h(Button, {
                size: "sm", variant: "secondary", disabled: !newName.trim(),
                onClick: () => { updMap(normalizeChannelName(newName).toLowerCase(), "off"); setNewName(""); },
              }, "Add"))))),

        h("h6", { className: "tcp-mt" }, "Separate axis files (optional)"),
        h("p", { className: "tcp-muted tcp-small" },
          "Stash only serves the main .funscript. To also load files like video.roll.funscript, expose your library folder via ",
          h("code", null, "custom_served_folders"), " in Stash's config.yml and map it here. Separate files take priority over embedded channels."),
        h(Form.Check, { type: "switch", id: "tcp-sc", label: "Load separate axis files", checked: !!sc.enabled, onChange: (e) => updSc({ enabled: e.target.checked }) }),
        sc.enabled && h(Table, { size: "sm", className: "tcp-table" },
          h("thead", null, h("tr", null, h("th", null, "Library folder (on server)"), h("th", null, "Served URL prefix"), h("th", null, ""))),
          h("tbody", null,
            sc.mappings.map((m, i) => h("tr", { key: i },
              h("td", null, h(Form.Control, { size: "sm", placeholder: "/data/videos", value: m.fs || "", onChange: (e) => { const ms = sc.mappings.slice(); ms[i] = Object.assign({}, m, { fs: e.target.value }); updSc({ mappings: ms }); } })),
              h("td", null, h(Form.Control, { size: "sm", placeholder: "/custom/videos", value: m.url || "", onChange: (e) => { const ms = sc.mappings.slice(); ms[i] = Object.assign({}, m, { url: e.target.value }); updSc({ mappings: ms }); } })),
              h("td", null, h(Button, { size: "sm", variant: "link", onClick: () => updSc({ mappings: sc.mappings.filter((_, j) => j !== i) }) }, icon(Icons.faTimes))))),
            h("tr", null, h("td", { colSpan: 3 },
              h(Button, { size: "sm", variant: "secondary", onClick: () => updSc({ mappings: sc.mappings.concat([{ fs: "", url: "" }]) }) }, "Add folder"))))),
      ),
      h(Modal.Footer, null,
        h(Button, { variant: "secondary", onClick: () => setP(defaultProfile()) }, "Reset to defaults"),
        h("span", { className: "tcp-grow" }),
        h(Button, { variant: "secondary", onClick: onHide }, "Cancel"),
        h(Button, { variant: "primary", disabled: saving, onClick: save }, saving ? "Saving…" : "Save")));
  }

  /* ---------- scene tab ---------- */

  /*
   * Playhead: one animation-frame loop moves the marker on every mounted sparkline to the video's
   * current time. It writes styles directly instead of re-rendering React, and follows the video
   * whether or not anything is connected, so seeking while paused moves it too.
   */
  const playheads = new Set(); // { el, end, t }
  let playheadRaf = 0;

  function playheadFrame() {
    playheadRaf = 0;
    if (!playheads.size) return;
    const v = engine._video;
    const t = v && Number.isFinite(v.currentTime) ? v.currentTime * 1000 : null;
    for (const p of playheads) {
      if (t === p.t) continue;
      p.t = t;
      if (t == null) { p.el.style.display = "none"; continue; }
      p.el.style.display = "";
      p.el.style.left = clamp(t / p.end, 0, 1) * 100 + "%";
    }
    playheadRaf = requestAnimationFrame(playheadFrame);
  }

  function addPlayhead(p) {
    playheads.add(p);
    if (!playheadRaf) playheadRaf = requestAnimationFrame(playheadFrame);
    return () => playheads.delete(p);
  }

  function Sparkline({ actions, durationMs, inverted }) {
    const ref = React.useRef(null);
    const headRef = React.useRef(null);
    const end = actions.length ? Math.max(durationMs || 0, actions[actions.length - 1].at) || 1 : 1;
    React.useEffect(() => {
      if (!headRef.current) return;
      return addPlayhead({ el: headRef.current, end, t: undefined });
    }, [end]);
    React.useEffect(() => {
      const c = ref.current;
      if (!c || !actions.length) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth || 160, ht = c.clientHeight || 26;
      c.width = w * dpr; c.height = ht * dpr;
      const ctx = c.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, ht);
      ctx.strokeStyle = getComputedStyle(c).color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      // downsample: at most ~2 points per pixel
      const step = Math.max(1, Math.floor(actions.length / (w * 2)));
      for (let i = 0; i < actions.length; i += step) {
        const a = actions[i];
        const pos = inverted ? 100 - a.pos : a.pos;
        const x = (a.at / end) * w, y = ht - 2 - (pos / 100) * (ht - 4);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }, [actions, end, inverted]);
    return h("div", { className: "tcp-spark-wrap" },
      h("canvas", { ref, className: "tcp-spark" }),
      h("div", { ref: headRef, className: "tcp-playhead", style: { display: "none" } }));
  }

  function Meter({ value }) {
    const pct = value == null ? 0 : Math.round(value * 100);
    return h("div", { className: "tcp-meter", title: value == null ? "" : pct + "%" },
      h("div", { className: "tcp-meter-fill", style: { width: pct + "%" } }));
  }

  /* ---------- 3D preview (osr-emu, MIT) ---------- */

  const EMU_SRC = "vendor/osr-emu.dist.min.js";
  let emuPromise = null;

  function assetUrl(path) {
    return new URL("plugin/" + PLUGIN_ID + "/assets/" + path, document.baseURI).toString();
  }

  /** Lazy-load the emulator bundle (~8 MB incl. three.js and 3D models) on first use. */
  function loadEmulator() {
    if (window.OSREmulator) return Promise.resolve(window.OSREmulator);
    if (!emuPromise) {
      emuPromise = new Promise((resolve, reject) => {
        // The dist copies its exports onto window (OSREmulator, default) and defines a non-configurable
        // window.__esModule. Keep only OSREmulator so other plugins' scripts don't see stray globals.
        const hadDefault = "default" in window, prevDefault = window.default;
        const hadEsModule = "__esModule" in window;
        if (!hadEsModule) {
          try { Object.defineProperty(window, "__esModule", { value: undefined, configurable: true, writable: true }); } catch (e) { /* ignore */ }
        }
        const tidy = () => {
          try { if (hadDefault) window.default = prevDefault; else delete window.default; } catch (e) { /* ignore */ }
          try { if (!hadEsModule) delete window.__esModule; } catch (e) { /* ignore */ }
        };
        const el = document.createElement("script");
        el.src = assetUrl(EMU_SRC);
        el.async = true;
        el.onload = () => {
          tidy();
          if (window.OSREmulator) resolve(window.OSREmulator); else reject(new Error("3D preview failed to initialise"));
        };
        el.onerror = () => { tidy(); emuPromise = null; el.remove(); reject(new Error("Could not load the 3D preview files")); };
        document.head.appendChild(el);
      });
    }
    return emuPromise;
  }

  function emuModelFor(profile) {
    if (profile.model === "sr6") return "SR6";
    if (profile.model === "ssr1") return "SSR1";
    if (profile.model === "osr2") return "OSR2";
    return profile.axes.L1.enabled || profile.axes.L2.enabled ? "SR6" : "OSR2";
  }

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  function Preview3D({ model }) {
    const ref = React.useRef(null);
    const [state, setState] = React.useState({ phase: "loading" });
    React.useEffect(() => {
      let emu = null, cancelled = false;
      setState({ phase: "loading" });
      loadEmulator().then((OSREmulator) => {
        if (cancelled || !ref.current) return;
        emu = new OSREmulator(ref.current, { model });
        engine.addEmulator(emu);
        setState({ phase: "ready" });
      }).catch((e) => { if (!cancelled) setState({ phase: "error", error: (e && e.message) || String(e) }); });
      return () => {
        cancelled = true;
        if (emu) {
          engine.removeEmulator(emu);
          try { emu.destroy(); } catch (e) { /* ignore */ }
        }
      };
    }, [model]);
    return h("div", { className: "tcp-preview" },
      h("div", { ref, className: "tcp-preview-canvas" }),
      state.phase === "loading" && h("div", { className: "tcp-preview-msg" }, "Loading 3D model…"),
      state.phase === "error" && h("div", { className: "tcp-preview-msg tcp-error" }, state.error));
  }

  function PreviewSection() {
    const s = useEngine();
    const [open, setOpen] = React.useState(() => lsGet("tcp-preview-open") === "1");
    const toggle = () => { const v = !open; setOpen(v); lsSet("tcp-preview-open", v ? "1" : "0"); };
    const model = emuModelFor(s.profile);
    return h("div", { className: "tcp-preview-section" },
      h("div", { className: "tcp-row" },
        h(Button, { size: "sm", variant: "secondary", onClick: toggle },
          icon(Icons.faCube), open ? " Hide 3D preview" : " Show 3D preview"),
        open && h("span", { className: "tcp-muted tcp-small" },
          s.status === "connected"
            ? `${model} – mirrors what the device receives. Drag to rotate, scroll to zoom.`
            : `${model} – no device connected, the preview acts as a virtual device.`)),
      open && h(Preview3D, { key: model, model }));
  }

  function SceneTabPanel() {
    const s = useEngine();
    const Toast = api.hooks.useToast();
    const [saving, setSaving] = React.useState(false);

    if (!s.scene) return null;

    async function save() {
      setSaving(true);
      try {
        await engine.saveScene();
        Toast.success("TCode mapping saved to scene");
      } catch (e) {
        Toast.error(e);
      } finally {
        setSaving(false);
      }
    }

    const customCount = Object.keys((s.edit && s.edit.channels) || {}).length;
    const hasCustom = !isEmptyFileCfg(s.edit);
    const conflictAxes = Object.keys(s.conflicts);

    return h("div", { className: "tcp-panel" },
      h(UnsupportedNotice),
      s.supported && h("div", { className: "tcp-row tcp-header" },
        h(StatusDot, { status: s.status === "connected" && s.playing && s.outputEnabled ? "live" : s.status }),
        h("span", { className: "tcp-grow" },
          statusText[s.status], s.deviceInfo ? h("span", { className: "tcp-muted" }, " · " + s.deviceInfo) : null),
        h(ConnectButton)),
      s.error && h("div", { className: "tcp-error" }, s.error),
      h(PreviewSection),

      s.scriptState === "loading" && h("div", { className: "tcp-muted" }, "Loading scripts…"),
      s.scriptState === "none" && h("div", { className: "tcp-notice" },
        "No funscript found for this scene. Stash looks for a .funscript next to the video file with the same name."),
      s.scriptState === "error" && h("div", { className: "tcp-error" }, s.scriptError),

      s.channels.length > 0 && h(React.Fragment, null,
        h("div", { className: "tcp-row tcp-muted tcp-small" },
          h("span", null, `Format ${s.scriptVersion || "1.0"} · ${s.channels.length} channel${s.channels.length === 1 ? "" : "s"}`),
          h("span", { className: "tcp-grow" }),
          hasCustom
            ? h(Badge, { variant: "info" }, `Custom mapping${customCount ? ` (${customCount})` : ""}`)
            : h(Badge, { variant: "secondary" }, "Using defaults"),
          s.dirty && h(Badge, { variant: "warning", className: "ml-1" }, "Unsaved")),

        conflictAxes.length > 0 && h("div", { className: "tcp-notice" },
          `Several channels drive ${conflictAxes.join(", ")} – the lower one in the list wins.`),

        h("div", { className: "tcp-channels" }, s.mapping.map((m, i) => {
          const ch = s.channels[i];
          const axCfg = m.axis !== "off" ? s.profile.axes[m.axis] : null;
          const disabled = axCfg && !axCfg.enabled;
          return h("div", { key: m.name, className: "tcp-channel" + (m.axis === "off" || disabled ? " tcp-off" : "") },
            h("div", { className: "tcp-ch-head" },
              h("b", null, m.name),
              ch.source === "file" && h(Badge, { variant: "secondary", className: "ml-1" }, "file"),
              m.custom && h(Badge, { variant: "info", className: "ml-1" }, "custom"),
              h("span", { className: "tcp-grow" }),
              h(Meter, { value: m.axis !== "off" ? s.live[m.axis] : null })),
            h(Sparkline, { actions: ch.actions, durationMs: s.scene.durationMs, inverted: ch.inverted }),
            h("div", { className: "tcp-ch-controls" },
              h(AxisSelect, { value: m.axis, profile: s.profile, onChange: (v) => engine.setChannel(m.name, { axis: v }) }),
              h(Form.Check, {
                id: `tcp-inv-${m.name}`, label: "Invert", checked: !!m.invert,
                onChange: (e) => engine.setChannel(m.name, { invert: e.target.checked }),
              }),
              h(RangePair, { min: m.min, max: m.max, onChange: (mn, mx) => engine.setChannel(m.name, { min: mn, max: mx }) }),
              h(Button, {
                size: "sm", variant: "secondary",
                disabled: !(s.status === "connected" || s.previews > 0) || s.testing || m.axis === "off" || disabled,
                onClick: () => engine.testChannel(m),
              }, "Test")),
            disabled && h("div", { className: "tcp-muted tcp-small" }, `${m.axis} is disabled in the device settings.`));
        })),

        h("div", { className: "tcp-row tcp-mt" },
          h("label", { className: "mb-0" }, "Scene offset (ms)"),
          h(NumberInput, { value: s.edit ? s.edit.offsetMs : 0, step: 10, width: 100, onChange: (v) => engine.setSceneOffset(v) })),

        h("div", { className: "tcp-row tcp-mt" },
          h(Button, { variant: "primary", size: "sm", disabled: !s.dirty || saving, onClick: save },
            saving ? "Saving…" : "Save to scene"),
          h(Button, { variant: "secondary", size: "sm", disabled: !s.dirty, onClick: () => engine.revertScene() }, "Revert"),
          h(Button, { variant: "secondary", size: "sm", disabled: !hasCustom, onClick: () => engine.resetSceneToDefaults() }, "Use defaults"),
          h("span", { className: "tcp-grow" }),
          h("span", { className: "tcp-muted tcp-small" }, "Changes apply live; saving stores them in the scene's custom field."))));
  }

  /** Invisible component that binds the scene page to the engine. */
  function SceneBinder({ scene }) {
    const fileKey = fileKeyOf((scene.files || [])[0]);
    React.useEffect(() => {
      engine.bindScene(scene);
      return () => engine.unbindScene(scene.id);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scene.id, fileKey]);
    return null;
  }

  /* ---------- patches ---------- */

  // after-patches receive the original render args plus the original result as the LAST argument
  function lastArg(args) { return args[args.length - 1]; }

  api.patch.after("MainNavBar.UtilityItems", function () {
    return h(React.Fragment, null, h(NavMenu, { key: "tcp-nav" }), lastArg(arguments));
  });

  api.patch.after("ScenePage.Tabs", function () {
    return h(React.Fragment, null, lastArg(arguments),
      h(Nav.Item, { key: "tcp-tab" }, h(Nav.Link, { eventKey: TAB_KEY }, "Interactive")));
  });

  api.patch.after("ScenePage.TabContent", function (props) {
    return h(React.Fragment, null, lastArg(arguments),
      h(Tab.Pane, { key: "tcp-pane", eventKey: TAB_KEY }, h(SceneTabPanel)),
      props && props.scene ? h(SceneBinder, { key: "tcp-binder", scene: props.scene }) : null);
  });

  engine.init();
  window.TCodePlayer = { engine, Core, loadEmulator }; // handy for debugging in the console
})();
