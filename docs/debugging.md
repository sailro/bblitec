# Diagnosing a scene

Compare at the [reference pose](fidelity.md#the-reference-pose) with matching
[build identity](development.md#build-identity). Backend agreement does not exclude shared defects.

## The ladder

Commands follow `npm run scene --`. `diagnose <id>` runs parity, `diff` and `diff --compose` in one pass.

| Command | Purpose |
| --- | --- |
| parity <id> [--backend sdl_gpu\|dawn] | Golden against both backends (or one) and the backend differential |
| parity <id> --attribute | Instrumented draw/triangle attribution |
| parity <id> --without ground\|background | Diagnostic isolation |
| parity <id> --seek <t> | Another pose against its own browser capture, in `seek-<t>/` |
| parity <id> --runs N [--single-sample] | Repeatability against run 1 and the golden |
| parity <id> --geometry | Impostor copy-task attachments |
| diff <id> [--backend dawn] | Draws, uniforms, palettes, shaders |
| diff <id> --uniforms --size N [--module text] | Candidate uniform layouts |
| diff <id\|all> --compose | Asset material variants |
| capture <id> [--native] [--skip-draw N] [--seek-bracket] | Browser/native captures; one frame of motion either side |
| probe <id> --shader <name> --term <text> --with <text> | One deployed Dawn WGSL term's contribution |
| memory <id\|all> [--replay-file <tape>] | Sustained memory |
| measure <png> [--background r,g,b] | Image bounds/color |

Browser evidence is reused only at its pose, pin and scene module; stale evidence is recaptured and
--recapture forces it. Only a plain parity run at the registry pose gates or recaptures a golden
(--recapture-reference); `npm run corpus:manifest -- --adopt-reference <id> --write` then records the new
golden's digest and capture time as its provenance, refusing when its source, module, query or host
page moved. --no-fail, suppressed features, seeked poses and single-sample comparisons
against MSAA goldens are diagnostic. Shared residuals point to common inputs/behavior; backend-specific
residuals to translation or transport.

## Same-device rendering comparisons

Capture native and WebGPU pixels on the same device, at the same canvas dimensions, query and pose.
Do not use Windows goldens for Linux, macOS or Android. Retain device/build identity and both images.
Exclude physics through generated feature reach; keep UI-heavy applications and suppress only their UI pixels.

Desktop canvas-only captures use `BBLITE_CAPTURE_UI=0`. Run parity with `--recapture-reference` on that
host before comparing either native backend; its browser image stays in `artifacts/parity-canvas/`.
Android native captures accept `tools/android-smoke.mjs --canvas-only`. Browser captures must run on
the selected Android device, not the build host. Verify actual client dimensions and DPR: Android Chrome's
toolbar can reduce the viewport despite Playwright's requested size. Direct CDP device-metrics emulation
sets the rendering viewport. Emulator presentation failures require explicit GPU render-target readback,
including worker canvases, rather than treating a black screenshot as a rendering result.

iOS Simulator captures use native GPU readback at the actual drawable size. `ios-smoke.mjs` supports
`--canvas-only`, `--frame` and `--replay`; interactive captures require an isolated Simulator.
iOS 16.2 WebKit has no WebGPU. Same-Mac Chrome comparisons are cross-platform diagnostics, not
iOS-browser parity. Viewport, DPR and display dimensions must match; authored supersampling uses
the browser compositor, never offline PNG resizing.

`BBLITE_TEST_PASS` windows stay visible; run Windows regression captures on an inactive desktop when
they must not appear on the user's desktop. A `platform:window` scene paces on the desktop compositor
clock, which stops while the console session is locked: a run with a frame budget or capture fails after
30 s without a heartbeat, naming the clock's last status; an unbounded run waits for the display.

## Captured state and its limits

| Evidence | Boundary |
| --- | --- |
| Ordinary native captures | Reconstructed CPU blocks, not intercepted GPU uploads |
| Browser capture | Shaders, buffers, textures, bundles and draws |
| .slots | SDL's compiled bindings after dead declarations disappear; the module's declared layout for Dawn |
| diff --compose | Asset materials; excludes scene-created materials/later writes |
| textGpu | Writes joined to draws; pushedUniformBytes are actual SDL inputs |
| nodeGpu | Opt-in upload/attribute/per-view/uniform receipts; bytes outside writtenRanges lack evidence |
| retainedDataFile | CPU splat bytes, not texture uploads |
| Palette summary | Two matrices; full dumps needed for wider deformation |

Enable BBLITE_NODE_GPU_CAPTURE with BBLITE_RENDER_CAPTURE for node receipts. Scene149-transport joins
those receipts to browser buffers and checks stamps, bindings and numeric worlds; signed zero is separate.
`probe` temporarily changes and restores the deployed Dawn WGSL; SDL_GPU changes need offline compilation.
Bounds and mesh-handle generations are checked in every build; set BBLITE_CHECKED_HANDLES=1 before building
(CMake: BBLITE_CHECKED_HANDLES=ON) to name the call site in a handle refusal.

## Before calling a scene done

[Integration](development.md#integrating-a-curated-parity-scene) includes the declared interaction checks:

```powershell
npm run scene -- check <check-id> --observe
npm run scene -- check <check-id> [--backend sdl_gpu|dawn] [--phase <id>] [--keep]
```

Checks live in `checks/<id>.json` (scope in `notes`); plugins hold scene-specific arithmetic. Phases
define frames/input/env; expectations compare captures, state, images and logs. A twin builds the
unchanged no-query source. `observe.captureReady` selects the canvas dataset flag awaited for
`captureFrames`. Results are in artifacts/check/<id>/. Use numeric checks where small missing objects
could pass image gates.

Scene149 browser live resize throws from the pin's buildResolvePath; its resized reference uses
unchanged-module startup at 960x600. Input tape `-`/UiIdle@0:0 is idle; UiWheelUp/Down uses SDL
packets, WheelUp/Down a browser notch. `<entry>*<n>` repeats entries. Recovery tapes include Dataset,
GlobalCall and DeviceLoss.

`memory` runs 6,000 frames, or the `frames` a demo's tape declares when its content grows for longer than a
warm-up third (minecraft's streamed world), and judges the samples after the warm-up third. It fails a working-set trend
above `--max-slope-mb` (MB per 1,000 frames, default 2; Theil–Sen, over the whole window and over its
later half, so one allocation step or a rise that settles does not fail), occupied mesh records the scene does not draw
or geometry records without vertices that pile up, and GC nodes that rise steadily; missing samples fail. The report
also states the occupied transform-node records. Each engine prints its own numbered stream (a Window host runs one
per canvas) and every stream is judged. `all` selects
the application demos. A demo with `checks/memory/<id>.json` plays that gameplay tape by default;
`--replay`/`--replay-file` supply another and `--replay -` idles.

## Artifacts

| Directory | Contents |
| --- | --- |
| artifacts/parity/<id>/ | Backend reports/images/diffs; `seek-<t>/`, `geometry/`, `stability/` |
| artifacts/parity-attribution/<id>/ | Instrumented attribution |
| artifacts/parity-canvas/<id>/ | Canvas-only lane and UI-free attribution |
| artifacts/capture/<id>/ | Captures, bytes, shaders, diff/composition, probe |
| artifacts/check/<id>/ | Check phases, browser observations, report |
| artifacts/memory/ | Verdicts, samples, logs |
| artifacts/status/ | `status --run` frames |
| artifacts/survey/<directory>-<stem>/ | Survey census and API readiness |

Artifact suffix gpu means SDL_GPU; CLI values are sdl_gpu/dawn.

## Runtime switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GPU_BACKEND` | Runtime backend in dual builds: exactly `sdl_gpu` or `dawn` |
| `BBLITE_RENDER_CAPTURE`, `BBLITE_NODE_GPU_CAPTURE` | Capture path; optional node GPU receipts |
| `BBLITE_SCREENSHOT`, `BBLITE_SCREENSHOT_FRAME`, `BBLITE_MAX_FRAMES` | Image path, frame, run limit |
| `BBLITE_SCREENSHOT_FRAMES` | Window only: ascending comma-separated presentation frames before the final screenshot, written as `<stem>.frame-<n>.png` with build stamps; excludes engine-frame capture |
| `BBLITE_ANIMATION_SEEK_SECONDS`, `BBLITE_FRAME_DELTA_MS` | Deterministic pose/timing |
| `BBLITE_MSAA=1`, `BBLITE_CAPTURE_UI=0` | Single-sample/canvas-only diagnosis |
| `BBLITE_INPUT_REPLAY`, `BBLITE_RUNTIME_TRACE`, `BBLITE_RUNTIME_TRACE_INTERVAL` | Event tape/state trace |
| `BBLITE_WINDOW_TRACE`, `BBLITE_CAPTURE_ENGINE_FRAME` | Worker presentation trace/per-engine frame |
| `BBLITE_UI_STYLE_TRACE`, `BBLITE_PHYSICS_TRACE`, `BBLITE_TRACE_PHYSICS_RAYS` | Subsystem traces |
| `BBLITE_CPU_PROFILE`, `BBLITE_MEM_PROFILE` | CPU stages and memory every 30 frames; CPU also records renderer frames ≥10 ms, Window frames ≥4 ms, UI updates, font shaping and SDL presentation/resource costs |
| `BBLITE_FPS_PROFILE` | Scene FPS over one-second windows, with p99 and maximum frame intervals |
| `BBLITE_AUDIO_CAPTURE`, `BBLITE_AUDIO_CAPTURE_SECONDS` | WAV path/duration in enabled builds |
| `BBLITE_LOCAL_STORAGE_ROOT` | Isolated storage |
| `BBLITE_FILE_DIALOG_SAVE_PATH`, `BBLITE_FILE_DIALOG_OPEN_PATH` | Noninteractive dialog paths |
| `BBLITE_ASSET_DIR`, `BBLITE_GPU_SHADER_DIR`, `BBLITE_NATIVE_EXE` | Diagnostic overrides; `BBLITE_NATIVE_EXE` reaches every measuring command (`parity`, `memory`, `check`, `diff`, `capture --native`, `probe`, `status`) |
| `BBLITE_GPU_DEBUG` | SDL_GPU validation layer (Dawn validation is always on) |
| `BBLITE_TEST_PASS` | Nonfocusable test pass: camera controls disabled (set by the harness) |
| `BBLITE_GROUND`, `BBLITE_BACKGROUND` | Suppress ground/background (set by `parity --without`) |
| `BBLITE_ID_BUFFER`, `BBLITE_CLUSTER_BUFFER`, `BBLITE_COPY_TASK` | Attribution outputs and copy-task filter (set by `parity` for id-diagnostic scenes) |
| `BBLITE_BENCHMARK_FRAMES`, `BBLITE_BUILD_STAMP_OUT` | Frame count and stamp path of a measured run; `BBLITE_BENCHMARK_FRAMES=0` disables VSync without a frame limit for direct renderers; Window hosts remain display-paced |
| `BBLITE_AUDIO_LOG` | LabSound log level (`trace`, `debug`, ...) |

Prefer `--gpu-debug` over `BBLITE_GPU_DEBUG=1`: it also prevents blocking SDL assertion prompts.

Android debug intents accept `nativeResolution=true` to bypass the source pixel-ratio cap for
profiling. Automated captures also bypass it to retain the requested golden dimensions.
