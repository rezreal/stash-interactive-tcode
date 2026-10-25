# TCode Player – Stash UI plugin

Plays single- and multi-axis funscripts on TCode devices (OSR2, SR6) directly from the Stash scene player over **Web Serial**.

## Requirements

- **Stash v0.31 or newer** (scene custom fields)
- **Chrome, Edge or Opera on desktop** (Web Serial)
- Stash opened on a **secure origin**: `https://…` or `http://localhost:9999`.
  On a plain LAN address like `http://192.168.1.10:9999` the browser hides Web Serial.
  Options: enable HTTPS in Stash (place `stash.crt` and `stash.key` next to your `config.yml`), put it behind a reverse proxy with TLS,
  or as a test, launch Chrome with `--unsafely-treat-insecure-origin-as-secure=http://192.168.1.10:9999`.

## Install

**From the Plugin Manager:** in Stash, **Settings → Plugins → Available Plugins → Add Source** with
`https://rezreal.github.io/stash-interactive-tcode/index.yml`, install *TCode Player* from that source and
reload the browser tab.

**Manually:**

1. Copy the contents of `plugin/` into a `TCodePlayer` folder in your Stash plugins directory
   (default: `~/.stash/plugins/TCodePlayer/`, or next to your `config.yml` under `plugins/`).
   The folder must be named `TCodePlayer` – the 3D preview loads its assets from `/plugin/TCodePlayer/assets/vendor/`.
2. In Stash: **Settings → Plugins → Reload plugins**, make sure *TCode Player* is enabled.
3. Reload the browser tab.

## Use

- **Navbar icon (wave):** connect / disconnect, motion on/off, home, and **Device settings**.
  The dot shows the state: grey = off, green = connected, glowing = sending motion.
- **Device settings → Device:** pick a preset – **OSR2/OSR2+** (L0, R0–R2), **SR6** (adds L1/L2 surge & sway),
  **SSR1** (L0 only) – or **Custom**. The preset decides which axes are active; your range, invert and
  speed limits per axis are kept when switching. Ticking an axis on/off by hand switches to Custom.
  Auxiliary axes (V0/V1 vibe, A0–A2 valve/suction/lube) are active in every preset but only sent when a channel maps to them.
- **Scene page → "Interactive" tab:** every channel found in the scene's script, with a preview line (an orange marker follows the video's position),
  live output meter, and per channel:
  - target axis (or off)
  - invert
  - min/max range – the full 0–100 script range is **lerped** into this window, so the motion keeps its shape
  - **Test** – sweeps the axis through its mapped range so you can check direction and limits
  - scene offset (ms)

  Changes apply live while playing. **Save to scene** stores them; **Use defaults** + Save removes the override.

## Alongside other plugins

TCode Player runs *in addition* to Stash's own interactive (Handy) support and other interactive plugins – it
never replaces or blocks them:

- It only **listens** to the video player; it never plays, pauses or seeks, and leaves Stash's Handy sync alone.
- Its tab and navbar menu are added next to whatever other plugins add.
- **Serial ports:** the browser shares serial permissions between all plugins on your Stash site. Auto-connect
  therefore only reopens the port *this* plugin connected to before, skips ports that are already open, and
  quietly stays disconnected if another plugin, tab or app (e.g. Intiface) is using the device. Connect
  manually from the menu once to pick the device.
- The 3D preview library is loaded on demand and leaves only `window.OSREmulator` behind.

## 3D preview

In the Interactive tab, **Show 3D preview** renders the selected device (OSR2, SR6 or SSR1; Custom picks SR6 if
surge/sway are enabled). It receives exactly the TCode lines the device gets – after channel mapping, axis caps,
invert and speed limits – so it shows what the hardware will really do. Drag to rotate, scroll to zoom.

Without a connected device the preview acts as a **virtual device**: playback and the Test buttons drive it,
so you can tune mappings without hardware.

The preview uses [osr-emu](https://github.com/ayvasoftware/osr-emu) (MIT, includes three.js, MIT). The ~8 MB file
in `vendor/` is served locally by Stash and only loaded when you open the preview. See `vendor/THIRD_PARTY_NOTICES.md`.

## Filling in missing axes

Many scripts only have a stroke. **Device settings → Fill in missing axes** (Off / Gentle / Medium / Strong,
off by default) makes up the other axes from it:

| Axis | Gets | Feels like |
|---|---|---|
| Pitch (R2), Surge (L1, half) | the stroke shifted by a quarter cycle | leans one way going up, the other way going down, centred at the turning points |
| Roll (R1), Twist (R0), Sway (L2, half) | smooth random wander | drifts while the stroke moves, faster when it is busy, frozen during holds, less near the stroke's ends |
| Vibe (V0), with *Vibration follows stroke speed* | how fast the stroke moves | stronger in busy parts, quiet in pauses |

- Only axes your device has enabled are filled (OSR2: pitch, roll, twist; SR6 adds surge and sway), and never
  an axis the script already has.
- Everything is calculated from the script when it loads: the same scene always moves the same way, and the
  generated channels show up in the Interactive tab (badge *generated*) with their own preview line, so you can
  remap, invert, narrow or switch them off like any other channel. Generated motion is never faster than the
  stroke itself.
- **Per scene:** the Interactive tab has its own *Fill in missing axes* choice (Default follows the device
  setting); Save stores it with the scene.

The idea of generating motion that only runs while the stroke moves comes from
[MultiFunPlayer](https://github.com/Yoooi0/MultiFunPlayer)'s motion providers (MIT).

## Supported script formats

| Format | Structure |
|---|---|
| 1.0 | `{ "actions": [...] }` |
| 1.1 | `{ "actions": [...], "axes": [{ "id": "R1", "actions": [...] }] }` |
| 2.0 | `{ "actions": [...], "channels": { "roll": { "actions": [...] } } }` |

Channel names map to axes via the default table in Device settings (`roll→R1`, `pitch→R2`, `twist→R0`,
`surge→L1`, `sway→L2`, `vib→V0`, …). Channels named like TCode IDs (`R1`) map to themselves.
You can add aliases for unusual names.

### Separate axis files (optional)

Stash itself only serves `video.funscript`. To also load `video.roll.funscript` etc.:

1. Expose your library folder in Stash's `config.yml`:
   ```yaml
   custom_served_folders:
     /videos: /data/videos
   ```
   (served at `/custom/videos/…`)
2. Device settings → *Separate axis files* → add `/data/videos` → `/custom/videos`.

Separate files take priority over embedded channels with the same name.

## Where settings are stored

| What | Where |
|---|---|
| Device profile (baud, rate, axis limits, invert, speed limits, default channel map, offsets, fill-in level `generate` and `generateVibe`) | Stash plugin config (`plugins.TCodePlayer.profile`, JSON string) |
| Per-scene mapping, offset and fill-in level | Scene custom field **`tcode_map`** (JSON string) |

`tcode_map` only contains what differs from the defaults. If nothing is customised, the field is removed:

```json
{ "v": 2, "offsetMs": 40, "generate": "gentle", "channels": { "pitch": { "invert": true, "min": 20, "max": 80 }, "surge": { "axis": "off" } } }
```

`generate` (`off`, `gentle`, `medium`, `strong`) is only present when the scene overrides the device setting.

Stash custom fields can't hold objects, so the value is stored as a JSON string. You can also edit it by hand
in the scene's Edit tab. Channel names that don't exist in the current script are ignored.
(The older v1 format with per-file hashes is still read and converted on the next save.)

## Signal chain

```
script pos (0–100)
  → channel stage: invert (XOR script "inverted"), lerp into [min, max]   ← per scene
  → device stage: axis invert, lerp into axis [min, max], speed limit     ← device profile
  → TCode  e.g.  L05166I17 R17583I17 R22417I17
```

Defaults: 115200 baud, 60 Hz updates (one tick look-ahead), 400 ms ramp after play/seek so the device doesn't jump.
The default device is OSR2, so surge/sway channels are ignored until you select SR6 (or enable L1/L2 in Custom).

## Debugging

`window.TCodePlayer.engine.state` in the browser console shows connection, channels, mapping and live values.
`window.TCodePlayer.engine.sendRaw("D2")` sends a raw TCode command.

## Development

No build step: `plugin/` is the plugin exactly as Stash loads it (plain JS on `window.PluginApi`, React 17 via
`createElement`). The pure core of `TCodePlayer.js` is exported via `module.exports` when loaded in Node.

```bash
node --test test/*.test.js   # core + coexistence tests, no deps
./build.sh                   # produces dist/index.yml + dist/TCodePlayer.zip
```

`build.sh` emits a Stash *package source*: a flat zip of `plugin/` (plus README and LICENSE) and the
`index.yml` that advertises it. The zip must stay flat – Stash writes each entry verbatim under
`plugins/<id>/`, so a wrapping directory would nest. Subfolders like `vendor/` are fine.

### Publishing

Bump `version` in `plugin/TCodePlayer.yml` for a release; Stash offers the update when the version in
`index.yml` changes.

The GitHub Actions workflow tests and builds on every push. The publish step is skipped while the repo is
private – GitHub Pages needs a public repo (or a paid plan), and publishing should be deliberate anyway. To go
live: make the repo public, enable Pages under Settings > Pages with **Source: GitHub Actions**, and push.
`https://rezreal.github.io/stash-interactive-tcode/index.yml` is then the source URL users add under
Settings > Plugins > Available Plugins > Add Source.

## License

[MIT](LICENSE). Bundled third-party code (osr-emu, three.js) is MIT as well – see
`plugin/vendor/THIRD_PARTY_NOTICES.md`.
