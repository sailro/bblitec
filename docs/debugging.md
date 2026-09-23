# Diagnosing a scene

Preserve corpus inputs, goldens and thresholds. Match source/module hashes, query, pose, UI and
[build identity](development.md#build-identity). Backend agreement does not exclude shared defects.

## The ladder

Commands follow `npm run scene --`. `diagnose <id>` combines parity, captures and composition.

| Command | Purpose |
| --- | --- |
| parity <id> --differential | Both backends/reference |
| parity <id> --attribute [--differential] | Instrumented draw/triangle attribution |
| diff <id> [--backend dawn] | Draws, uniforms, palettes, shaders |
| capture <id> | Browser uploads/draws |
| uniforms <id> --size N [--module text] | Candidate uniform layouts |
| geometry <id> / compose <id\|all> | Attachments / asset variants |
| stability <id> --backend dawn --runs N | Repeatability |
| memory <id\|all> --replay-file <tape> | Sustained memory |
| parity <id> --without ground\|background | Diagnostic isolation |
| measure <png> [--background r,g,b] | Image bounds/color |

Diff refreshes stale captures; --recapture forces refresh. Changed seek poses need explicit reference
recapture. --no-fail, suppressed features and single-sample comparisons against MSAA goldens are diagnostic.
Shared residuals point to common inputs/behavior; backend-specific residuals to translation or transport.

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

`BBLITE_TEST_PASS` disables physical input but does not hide SDL windows. Run Windows regression
captures on an inactive desktop when they must not appear on the user's desktop.

## Captured state and its limits

| Evidence | Boundary |
| --- | --- |
| Ordinary native captures | Reconstructed CPU blocks, not intercepted GPU uploads |
| Browser capture | Shaders, buffers, textures, bundles and draws |
| SDL .slots | Compiled bindings after dead declarations disappear |
| compose | Asset materials; excludes scene-created materials/later writes |
| textGpu | Writes joined to draws; pushedUniformBytes are actual SDL inputs |
| nodeGpu | Opt-in upload/attribute/per-view/uniform receipts; bytes outside writtenRanges lack evidence |
| retainedDataFile | CPU splat bytes, not texture uploads |
| Palette summary | Two matrices; full dumps needed for wider deformation |

Enable BBLITE_NODE_GPU_CAPTURE with BBLITE_RENDER_CAPTURE for node receipts. Scene149-transport joins
those receipts to browser buffers and checks stamps, bindings and numeric worlds; signed zero is separate.
Probe-variants temporarily changes/restores deployed Dawn WGSL; SDL changes need offline compilation.
Set BBLITE_CHECKED_HANDLES=1 before building (CMake: BBLITE_CHECKED_HANDLES=ON) for checked indices.

## Before calling a scene done

Run [validation](development.md#validation), then declared interaction checks on both backends:

```powershell
npm run scene -- observe <check-id>
npm run scene -- check <check-id> [--backend sdl_gpu|dawn] [--phase <id>] [--keep]
```

Checks live in checks/<id>.json; plugins hold scene-specific arithmetic. Phases define frames/input/env;
expectations compare captures, state, images and logs. A twin builds the unchanged no-query source.
`observe.captureReady` selects the canvas dataset flag awaited for `captureFrames`.
Results are in artifacts/check/<id>/. Use numeric checks where small missing objects could pass image gates.

| Area | Check IDs |
| --- | --- |
| Picking / splats | scene114 / scene121 |
| TAA | scene261, scene261-live |
| Text / live text | scene275 / scene180, scene181 |
| Node geometry / GPU transport | scene149 / scene149-transport |
| Local cubemaps | scene186 |
| Shared canvases | scene227, scene228, antigravity-racer |
| Workers / repaint rates | offscreen, offscreen-cadence |
| Physics timing | break-meshes-60, break-meshes-240, break-meshes-live |
| Heightfields / constraints | scene47 / scene46 |
| Viewer / queries | scene41 / scene49 |
| Animation / emitters | scene153, scene153-live, scene302, scene302-live, scene231, scene241 |
| Recovery | scene164 |
| Interactivity | calculator, scene304 |
| Desktop controls | quake, sandblox |
| Ocean simulation / controls / resolution | ocean / ocean-ui / ocean-resolution |

Scene149 browser live resize throws error #84; its resized reference uses unchanged-module startup at
960x600. Input tape `-`/UiIdle@0:0 is idle; UiWheelUp/Down uses SDL packets, WheelUp/Down a browser notch.
`<entry>*<n>` repeats entries. Recovery tapes include Dataset, GlobalCall and DeviceLoss.

Memory defaults: 6,000 frames, 32 MB growth after warm-up; all selects applications. Missing samples
fail. Working-set stability does not prove object/GPU reclamation. GC node/allocation counts are additional data.

## Artifacts

| Directory | Contents |
| --- | --- |
| artifacts/parity/<id>/ | Backend reports/images/diffs, geometry, stability |
| artifacts/parity-attribution/<id>/ | Instrumented attribution |
| artifacts/parity-canvas/ | UI-free attribution |
| artifacts/capture/<id>/ | Captures, bytes, shaders, diff/composition |
| artifacts/memory/ | Verdicts, samples, traces |

Artifact suffix gpu means SDL_GPU; CLI values are sdl_gpu/dawn.

## Runtime switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GPU_BACKEND` | Runtime backend in dual builds |
| `BBLITE_RENDER_CAPTURE`, `BBLITE_NODE_GPU_CAPTURE` | Capture path; optional node GPU receipts |
| `BBLITE_DEFORMATION_DUMP` | Supported SDL bone/morph dump |
| `BBLITE_SCREENSHOT`, `BBLITE_SCREENSHOT_FRAME`, `BBLITE_MAX_FRAMES` | Image path, frame, run limit |
| `BBLITE_SCREENSHOT_FRAMES` | Window-only comma-separated ascending presentation frames before the final screenshot; writes `<stem>.frame-<n>.png` and build-stamp sidecars in the same run; excludes engine-frame capture |
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
| `BBLITE_ASSET_DIR`, `BBLITE_GPU_SHADER_DIR`, `BBLITE_NATIVE_EXE` | Diagnostic overrides; the executable override reaches every measuring command (`parity`, `geometry`, `memory`, `stability`, `check`, `diff`, `capture --native`, `probe-variants`) |
| `BBLITE_GPU_DEBUG` | SDL_GPU validation layer (Dawn validation is always on) |
| `BBLITE_TEST_PASS` | Nonfocusable test pass: camera controls disabled (set by the harness) |
| `BBLITE_GROUND`, `BBLITE_BACKGROUND` | Suppress ground/background (set by `parity --without`) |
| `BBLITE_ID_BUFFER`, `BBLITE_CLUSTER_BUFFER`, `BBLITE_COPY_TASK` | Attribution outputs and copy-task filter (set by `parity` for id-diagnostic scenes) |
| `BBLITE_BENCHMARK_FRAMES`, `BBLITE_BUILD_STAMP_OUT` | Frame count and stamp path of a measured run; `BBLITE_BENCHMARK_FRAMES=0` disables VSync without a frame limit for direct renderers; Window hosts remain display-paced |
| `BBLITE_AUDIO_LOG` | LabSound log level (`trace`, `debug`, ...) |

Prefer `--gpu-debug` over `BBLITE_GPU_DEBUG=1`: it also prevents blocking SDL
assertion prompts. Build configuration belongs in [development](development.md).

Android debug intents accept `nativeResolution=true` to bypass the source pixel-ratio cap for
profiling. Automated captures also bypass it to retain the requested golden dimensions.
