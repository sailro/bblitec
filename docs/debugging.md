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
`--seek <t>` requires an intentional reference recapture (`--recapture-reference`)
for gated comparisons.
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

`scene -- check scene149-transport` joins the native `nodeGpu` receipts of one
canonical frame against the saved browser identity observation and instrumented
buffer capture under `artifacts/scene149-reference`, checking attributes, indices,
texture sharing and bindings. It rejects stale stamps and numerical world
differences; signed-zero differences are reported separately. Retained splat
`retainedDataFile` sidecars contain CPU bytes, not texture uploads.

`probe-variants <id> --shader <stem> --term <text> --with <text>` temporarily
changes/restores deployed Dawn WGSL. Turn useful results into source fixes.
SDL probes need offline shader compilation.

## Before calling a scene done

Run [checkpoint validation](development.md#validation), then the scene's declared
interaction check on both backends:

```powershell
npm run scene -- observe <check-id>   # when the check declares a browser observation
npm run scene -- check <check-id> [--backend sdl_gpu|dawn] [--phase <id>] [--keep]
```

A check is `checks/<check-id>.json`: the native phases (frame window, input tape,
environment), a typed expectation vocabulary (`capture-path`, `capture-same`,
`capture-differs`, `capture-compare`, `camera-delta`, `image-mad`, `viewport`,
`golden-mad`, `backends-agree`, `log-match`, `plugin`) and the browser observation
the expectations compare against; `checks/plugins/*.mjs` hold scene-specific
arithmetic. The driver spreads the registry `nativeEnvironment` before the phase
window, so a check measures at parity's pose unless it declares another clock. A
check declaring `twin: true` first generates and builds the byte-identical no-query
copy into `generated/<id>-live` and `native/build-<id>-live-release`. Outputs land
in `artifacts/check/<check-id>/` (`report.json`, per-phase
`<backend>-<phase>.{png,json,log}`, `browser/observations.json`). Check significant
state numerically when a missing small object or changed buffer could pass an image gate.

| Control | Check |
| --- | --- |
| Morph/skeleton picking | `scene114`: four markers against the browser picks; idle holds. `test/fixtures/morph-picking-standard.ts` covers immediate update/pick. |
| Splat updates | `scene121`: the retained buffer through idle and orbit against the browser digest and the source's raw SPLAT asset. |
| TAA | `scene261` (frozen words against the browser), `scene261-live` (twin: reset, recovery, resize). |
| Text | `scene275`: native text GPU receipts against the browser's WebGPU receipts; idle, input, resize. |
| Node geometry | `scene149`: orbit/resize against the browser observation (a live browser resize throws Babylon error #84, so the resized comparison is an unchanged-module startup at 960x600); `scene149-transport` for the GPU receipts. |
| Local cubemaps | `scene186`: camera, idle and resize captures; eight faces and four reflective ORM replacements. |
| Live text | `scene181` (edit/clear/regrow, textarea/window resize, orbit, zoom) and `scene180` (weight, colour, rotation, opacity, drag, scale, resizes); glyph/palette receipts against the browser. |
| Shared-engine canvases | `scene227`, `scene228`: left/right drags, divider crossing, idle isolation, geometry after resize. |
| Worker windows | `offscreen`: held presses, worker progress, resize; `offscreen-cadence` measures Window/Worker rates in a headed browser without correcting runtime speed. |
| Physics timing | `break-meshes-60`, `break-meshes-240`, `break-meshes-live`: fixed overrides and live timing (headed browser). |
| Heightfields | `scene47` (twin): free-fall, terrain contact, live viewer poses, unhandled input, resize. |
| Constraints | `scene46` (twin): seven groups, pivot/axis/limit state, unhandled input, resize. |
| Debug viewer / queries | `scene41` (twin): seven retained overlays, clone geometry, fixed camera; `scene49` (twin): Havok proximity/cast markers, gizmo drags, orbit, resize. |
| Animation manager / emitter | `scene153`, `scene153-live`, `scene302`, `scene302-live`: frozen registry tree against the live twin; `scene231`, `scene241`: palette/texture animation and orbit. |
| Device recovery | `scene164`: dataset handshake, resize, input, dispose; the recovery tape (`Dataset@key=value`, `GlobalCall@name`, `DeviceLoss`). |
| KHR_interactivity | `calculator`, `scene304`: press control, "7" then "x" taps at the golden pose; display digits and dispatched nodes by name. |
| Split-screen surfaces | `antigravity-racer`: the menu's two-player selection; the run-time second canvas has no layout rectangle, so both equal panes must present. |

Tape spellings: `-` is an idle frame (`UiIdle@0:0` is the retained-UI spelling of the
same); `UiWheelUp|UiWheelDown` queue SDL wheel packets at the canvas centre and
`WheelUp|WheelDown` dispatch a browser-sized notch (`native/src/pal_platform_events.hpp`);
`"<entry>*<n>"` repeats an entry in a check file.

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
| `BBLITE_ASSET_DIR`, `BBLITE_GPU_SHADER_DIR`, `BBLITE_NATIVE_EXE` | Diagnostic overrides; the executable override reaches every measuring command (`parity`, `geometry`, `memory`, `stability`, `check`, `diff`, `capture --native`, `probe-variants`) |
| `BBLITE_GPU_DEBUG` | SDL_GPU validation layer (Dawn validation is always on) |
| `BBLITE_TEST_PASS` | Hidden test pass: camera controls disabled (set by the harness) |
| `BBLITE_GROUND`, `BBLITE_BACKGROUND` | Suppress ground/background (set by `parity --without`) |
| `BBLITE_ID_BUFFER`, `BBLITE_CLUSTER_BUFFER`, `BBLITE_COPY_TASK` | Attribution outputs and copy-task filter (set by `parity` for id-diagnostic scenes) |
| `BBLITE_BENCHMARK_FRAMES`, `BBLITE_BUILD_STAMP_OUT` | Frame count and stamp path of a measured run (set by `memory`/`parity`) |
| `BBLITE_AUDIO_LOG` | LabSound log level (`trace`, `debug`, ...) |

Prefer `--gpu-debug` over `BBLITE_GPU_DEBUG=1`: it also prevents blocking SDL
assertion prompts. Build configuration belongs in [development](development.md).
