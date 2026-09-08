# Diagnosing a scene

Locate rendering differences with source and captured data. A small MAD alone
does not explain a residual. Keep corpus inputs and goldens unchanged.

## The ladder

Commands follow `npm run scene --`; `diagnose <id>` combines differential
parity, paired captures and asset composition.

| Need | Command |
| --- | --- |
| Check both renderers and payload | `parity <id> --differential` |
| Compare draws, uniforms, palettes, shaders | `diff <id> [--backend dawn]` |
| Record browser uploads/draws | `capture <id>` |
| Decode candidate uniform layouts | `uniforms <id> --size N [--module <substring>]` |
| Compare attachments | `geometry <id>` |
| Inspect asset material variants | `compose <id\|all>` |
| Measure repeatability | `stability <id> --backend dawn --runs N` |
| Check sustained memory | `memory <id\|all> --replay-file <tape>` |
| Isolate ground/background | `parity <id> --without ground\|background` |
| Measure image bounds/color | `measure <png> [--background r,g,b]` |

`diff` refreshes missing/stale captures; `--recapture` forces refresh. Match
source, module, query, pose, UI and [build identity](development.md#build-identity).
`--seek <t>` requires intentional reference recapture for gated comparisons.
`--no-fail`, suppressed features and changed poses are diagnostic-only.
`--differential` accepts only `--gpu-debug` alongside it.

If both backends differ alike, inspect shared inputs/behavior. Otherwise inspect
translation, uploads, slots and backend state. Repeat browser captures too.
`stability --single-sample` isolates MSAA variation; comparison with an MSAA
golden is not an integration gate. Change the neutrality allowlist only with
repeated measurements and a cause.

## Captured state and its limits

`diff` matches values through captured WGSL/generated layouts; matching values
do not establish draw/binding identity. Standard native captures reconstruct CPU
blocks rather than intercept GPU uploads. Effective main-draw worlds include
late root transforms; other passes need their own observations. The palette
summary covers two matrices; use the full deformation dump for more.

`capture` records browser shaders, buffers, textures, bundles and draws.
`--skip-draw <indexCount>` filters draws; `--seek-bracket` captures neighboring
poses. Inspect generated shader `.slots` for SDL bindings: Tint can remove
unused WGSL declarations. Asset-only `compose` does not validate scene-created
materials or later setters.

Text `textGpu` receipts join writes to draws. SDL `pushedUniformBytes` are actual
draw inputs; `uniform-shadow` is CPU storage. Enable `BBLITE_NODE_GPU_CAPTURE=1`
with `BBLITE_RENDER_CAPTURE` for node vertex/index uploads, attributes, per-view
bindings and uniform uploads/pushes. These captures can be large. SDL group ID
zero means no native bind-group object. Bytes outside `writtenRanges` are
unobserved.

`tools/check-scene149-transport.mjs` joins saved browser/native receipts,
checking attributes, indices, texture sharing and bindings. It rejects stale
stamps and numerical world differences; signed-zero differences are reported
separately. `--allow-stale` is diagnostic-only. Retained splat
`retainedDataFile` sidecars contain CPU bytes, not texture uploads.

`probe-variants <id> --shader <stem> --term <text> --with <text>` temporarily
changes/restores deployed Dawn WGSL. Turn useful results into source fixes.
SDL probes need offline shader compilation.

## Before calling a scene done

Run [checkpoint validation](development.md#validation), then exercise input,
live state and resize on both backends. Check significant state numerically
when a missing small object or changed buffer could pass an image gate.

| Control | Tool / evidence |
| --- | --- |
| Morph/skeleton picking | `check-scene114-input.mjs`: reference picking observations/golden, four markers. `test/fixtures/morph-picking-standard.ts` covers immediate update/pick. |
| Splat updates | `check-scene121-input.mjs`: reference splat observations/golden, complete retained buffer through idle/input. Use the source's raw SPLAT asset. |
| TAA | `check-scene261-input.mjs`: frozen/live observations, history and camera state. |
| Text | `check-scene275-input.mjs`: operation observations for scene/shared/blend fixtures. |
| Node geometry | `check-scene149-input.mjs`: browser orbit/resize observations. Live browser resize throws error84; compare unchanged-module startup at resized dimensions. |
| Local cubemaps | `check-scene186-input.mjs`: native camera, idle and resize captures; eight faces and four reflective ORM replacements on both backends. |
| Live text | `check-scene181-input.mjs`: edit/clear/regrow, glyph/palette receipts, textarea/window resize, orbit and zoom on both backends. |
| Shared-engine canvases | `check-surface-input.mjs`: scenes 227/228 left/right drags, divider-crossing capture, idle isolation and geometry after resize. |
| Worker windows | `check-offscreen-window.mjs`: held presses, worker progress, resize, shutdown. |
| Physics timing | `check-break-meshes-timing.mjs`: unchanged fixed overrides and live timing. |
| Heightfields | `observe-scene47.mjs` then `check-scene47-controls.mjs`: free-fall, terrain contact, live viewer poses, unhandled input and resize. The native checker requires a processed byte-identical `artifacts/scene47-live.ts` copy without a capture query. |
| Constraints | `observe-scene46.mjs` then `check-scene46-controls.mjs`: seven groups, pivot/axis/limit state, unhandled input and resize. Process a byte-identical `artifacts/scene46-live.ts` copy without a capture query first. |
| KHR_interactivity | `check-calculator-input.mjs [calculator\|scene304]`: press control, "7" then "x" taps at the scene's golden pose; display digits and dispatched nodes by name on both backends. |

Scripts are under `tools/`. Checkers use scene defaults or take an executable, generated
directory and saved browser observations; see each script's usage. Build its
matching source first. A registry `nativeEnvironment` carries
`BBLITE_SCREENSHOT_FRAME` beside its clock; a checker spreads it before its own
frame window. `measure-offscreen-cadence.mjs` measures Window/Worker
rates independently and does not correct runtime speed.

`memory` defaults to 6,000 frames and 32 MB post-warm-up growth; `all` selects
applications. Override with `--frames`, `--max-growth-mb`, `--backend` and one
replay source. Missing samples fail as unmeasured; scene-less loops lack samples.
Working-set stability does not establish object/GPU resource reclamation.

## Artifacts

| Directory | Contents |
| --- | --- |
| `artifacts/parity/<id>/` | Backend/differential reports, images, diffs, hotspots, geometry/stability outputs |
| `artifacts/parity-canvas/` | UI-free attribution |
| `artifacts/capture/<id>/` | Browser/native captures, byte sidecars, shaders, metadata, diff/compose reports |
| `artifacts/memory/` | Verdicts, samples and raw traces |

Artifact suffix `gpu` means SDL_GPU; CLI values are `sdl_gpu|dawn`.
Store detailed runs and experiments here, outside project documentation.

## Runtime switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GPU_BACKEND` | Runtime backend in dual builds |
| `BBLITE_RENDER_CAPTURE`, `BBLITE_NODE_GPU_CAPTURE` | Capture path; optional node GPU receipts |
| `BBLITE_DEFORMATION_DUMP` | Supported SDL bone/morph dump |
| `BBLITE_SCREENSHOT`, `BBLITE_SCREENSHOT_FRAME`, `BBLITE_MAX_FRAMES` | Image path, frame, run limit |
| `BBLITE_ANIMATION_SEEK_SECONDS`, `BBLITE_FRAME_DELTA_MS` | Deterministic pose/timing |
| `BBLITE_MSAA=1`, `BBLITE_CAPTURE_UI=0` | Single-sample/canvas-only diagnosis |
| `BBLITE_INPUT_REPLAY`, `BBLITE_RUNTIME_TRACE`, `BBLITE_RUNTIME_TRACE_INTERVAL` | Event tape/state trace |
| `BBLITE_WINDOW_TRACE`, `BBLITE_CAPTURE_ENGINE_FRAME` | Worker presentation trace/per-engine frame |
| `BBLITE_UI_STYLE_TRACE`, `BBLITE_PHYSICS_TRACE`, `BBLITE_TRACE_PHYSICS_RAYS` | Subsystem traces |
| `BBLITE_CPU_PROFILE`, `BBLITE_MEM_PROFILE` | Timing/counters and memory samples |
| `BBLITE_AUDIO_CAPTURE`, `BBLITE_AUDIO_CAPTURE_SECONDS` | WAV path/duration in enabled builds |
| `BBLITE_LOCAL_STORAGE_ROOT` | Isolated storage |
| `BBLITE_FILE_DIALOG_SAVE_PATH`, `BBLITE_FILE_DIALOG_OPEN_PATH` | Noninteractive dialog paths |
| `BBLITE_ASSET_DIR`, `BBLITE_GPU_SHADER_DIR`, `BBLITE_NATIVE_EXE` | Diagnostic overrides |

Prefer `--gpu-debug` over `BBLITE_GPU_DEBUG=1`: it also prevents blocking SDL
assertion prompts. Build configuration belongs in [development](development.md).
