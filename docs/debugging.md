# Diagnosing a scene

## Measurement

- Parity compares the full page (canvas plus reached UI) against the pinned browser golden; canvas-only gates are additional.
- A valid comparison needs matching source/module hashes, query, time/frame, canvas size, UI and
  [build identity](development.md#build-identity).
- Reports give full/foreground MAD, byte ratios, bias and spatial attribution. They locate residuals; they do not
  explain them. Backend agreement does not exclude shared defects: shared residuals point to common inputs,
  backend-specific ones to translation or transport.
- Captures wait for the same settles in browser and native: a reached canvas `dataset.ready` write gates capture until a
  canvas has `data-ready="true"` and publishes a fresh frame, plus any registered `referenceSettle`. A nonempty
  `data-error` fails the capture.

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
| probe <id> --shader <name> --term <text> --with <text> | One deployed Dawn WGSL term's contribution (restored after) |
| memory <id\|all> [--replay-file <tape>] | Sustained memory |
| measure <png> [--background r,g,b] | Image bounds/color |

- Browser evidence is reused only at its pose, pin and module; `--recapture` forces it.
- Only a plain parity run at the registry pose gates or recaptures a golden (`--recapture-reference`); then
  `npm run corpus:manifest -- --adopt-reference <id> --write` records its provenance (refused if source, module, query or
  host page moved).
- `--no-fail`, suppressed features, seeked poses and single-sample runs against MSAA goldens are diagnostic only.
- SDL_GPU shader changes need offline compilation; `probe` covers Dawn only.

## Same-device comparisons

- Compare native and WebGPU captures from the same device, canvas size, query and pose. Never use Windows goldens for
  Linux, macOS or Android. Keep device/build identity and both images.
- Canvas-only lane: `BBLITE_CAPTURE_UI=0`; run parity with `--recapture-reference` on that host first; browser images
  go to `artifacts/parity-canvas/`. Canvas-only capture excludes UI filters.
- Android: `tools/android-smoke.mjs --canvas-only`; capture the browser on the target device and verify client size and
  DPR (Chrome's toolbar shrinks the viewport; use CDP device-metrics emulation). Emulator black screenshots need explicit
  GPU readback. Debug intents accept `nativeResolution=true` to bypass the pixel-ratio cap.
- iOS Simulator: `ios-smoke.mjs` supports `--canvas-only`, `--frame`, `--replay`, `--render-state`, `--lifecycle --frame
  1800`, `--max-frames`, `--runtime-trace`; staged bundles need `--build-directory`. iOS 16.2 WebKit has no WebGPU.
- Fresh drivers can pass `applied-group-pose-v1` as the final `suiteBrowserModule`/`suiteBrowserModuleDigest` argument to
  apply property poses; active groups must share one manager.
- `BBLITE_TEST_PASS` windows are visible: run Windows captures on an inactive desktop. A `platform:window` scene paces on
  the compositor clock, which stops while the session is locked: bounded runs fail after 30 s without a heartbeat.
  Capture runs have a five-minute backstop.

## Captured state limits

| Evidence | Boundary |
| --- | --- |
| Native captures | Main-scene draw plan and reconstructed CPU blocks; no utility-layer draws or GPU uploads |
| Browser capture | Shaders, buffers, textures, bundles, draws |
| `.slots` | SDL's compiled bindings; the declared layout for Dawn |
| `diff --compose` | Asset materials only |
| textGpu | Writes joined to draws; `pushedUniformBytes` are actual SDL inputs |
| nodeGpu | Opt-in receipts (`BBLITE_NODE_GPU_CAPTURE` with `BBLITE_RENDER_CAPTURE`); bytes outside `writtenRanges` lack evidence |
| retainedDataFile | CPU splat bytes, not uploads |
| Palette summary | Two matrices; dump fully for wider deformation |

The scene149-transport and node-local-transport checks join node receipts to `checks/plugins/webgpu-recorder.init.js`
buffers. `BBLITE_CHECKED_HANDLES=1` before building (CMake `BBLITE_CHECKED_HANDLES=ON`) names the call site of a handle refusal.

## Checks

```powershell
npm run scene -- check <check-id> --observe
npm run scene -- check <check-id> [--backend sdl_gpu|dawn] [--phase <id>] [--keep]
```

- `checks/<id>.json` defines phases (frames, input, env) and expectations (captures, state, images, logs); plugins in
  `checks/plugins/`. A twin builds the unchanged no-query source. `observe.captureReady` selects the awaited dataset flag.
- Prefer numeric checks where small missing objects could pass image gates.
- Input tape: `-` or `UiIdle@0:0` idles; `UiWheelUp/Down` are SDL packets, `WheelUp/Down` a browser notch; `<entry>*<n>`
  repeats; recovery tapes include `Dataset`, `GlobalCall`, `DeviceLoss`.
- Scene149 resized reference uses unchanged-module startup at 960x600 (live resize throws in the pin).

## Memory

`memory` runs 6,000 frames (or a demo tape's `frames`) and judges samples after the warm-up third. It fails on a
working-set slope above `--max-slope-mb` (MB per 1,000 frames, default 2, Theil–Sen over the window and its later half),
accumulating undrawn mesh records or vertex-less geometry, rising GC nodes, or missing samples. Every engine stream is
judged. `all` selects application demos; `checks/memory/<id>.json` supplies the default tape; `--replay -` idles.

## Artifacts

| Directory | Contents |
| --- | --- |
| `artifacts/parity/<id>/` | Reports, images, diffs; `seek-<t>/`, `geometry/`, `stability/` |
| `artifacts/parity-attribution/<id>/` | Instrumented attribution |
| `artifacts/parity-canvas/<id>/` | Canvas-only lane |
| `artifacts/capture/<id>/` | Captures, shaders, diff/composition, probe |
| `artifacts/check/<id>/` | Check phases, observations, report |
| `artifacts/memory/` | Verdicts, samples, logs |
| `artifacts/status/` | `status --run` frames |
| `artifacts/survey/<directory>-<stem>/` | Survey census and API readiness |

Artifact suffix `gpu` means SDL_GPU; CLI values are `sdl_gpu`/`dawn`.

## Runtime switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GPU_BACKEND` | `sdl_gpu` or `dawn` in dual builds (also Android debug intents) |
| `BBLITE_RENDER_CAPTURE`, `BBLITE_NODE_GPU_CAPTURE` | Capture path; node GPU receipts |
| `BBLITE_SCREENSHOT`, `BBLITE_SCREENSHOT_FRAME`, `BBLITE_MAX_FRAMES` | Image path, frame, run limit |
| `BBLITE_SCREENSHOT_FRAMES` | Window: ascending extra frames, written as `<stem>.frame-<n>.png` |
| `BBLITE_ANIMATION_SEEK_SECONDS`, `BBLITE_FRAME_DELTA_MS` | Deterministic pose/timing; pre-start timers keep wall time |
| `BBLITE_MSAA=1`, `BBLITE_CAPTURE_UI=0` | Single-sample; canvas-only |
| `BBLITE_INPUT_REPLAY`, `BBLITE_RUNTIME_TRACE`, `BBLITE_RUNTIME_TRACE_INTERVAL` | Input tape; state trace |
| `BBLITE_WINDOW_TRACE`, `BBLITE_CAPTURE_ENGINE_FRAMES=1` | Worker presentation trace; `BBLITE_SCREENSHOT_FRAME` counts engine frames |
| `BBLITE_UI_STYLE_TRACE`, `BBLITE_PHYSICS_TRACE`, `BBLITE_TRACE_PHYSICS_RAYS` | UI boxes, body poses per step, ray queries |
| `BBLITE_CPU_PROFILE`, `BBLITE_MEM_PROFILE` | CPU stages and memory every 30 frames |
| `BBLITE_PHYSICS_PAIR_PROFILE=1` | With CPU profile: narrow-phase time per shape pair |
| `BBLITE_SOURCE_PROFILE` | Timing scopes in named source functions (below) |
| `BBLITE_PHYSICS_THREADS` | Bullet workers incl. controller (default ≤ 8; `1` = serial) |
| `BBLITE_FPS_PROFILE` | FPS per second with p99/max frame intervals |
| `BBLITE_TIMER_PROFILE=1` | `[cpu][timer-set]`, `[cpu][timer]`, `[cpu][timer-clear]` timestamps |
| `BBLITE_AUDIO_CAPTURE`, `BBLITE_AUDIO_CAPTURE_SECONDS`, `BBLITE_AUDIO_LOG` | WAV capture; LabSound log level |
| `BBLITE_LOCAL_STORAGE_ROOT` | Isolated storage |
| `BBLITE_FILE_DIALOG_SAVE_PATH`, `BBLITE_FILE_DIALOG_OPEN_PATH` | Noninteractive dialogs |
| `BBLITE_MESSAGE_BOX_RESPONSE` | `accept` or `dismiss` answers `alert`/`confirm` without a message box |
| `BBLITE_ASSET_DIR`, `BBLITE_GPU_SHADER_DIR`, `BBLITE_NATIVE_EXE` | Overrides; `BBLITE_NATIVE_EXE` reaches every measuring command |
| `BBLITE_GPU_DEBUG` | SDL_GPU validation (Dawn always validates); prefer `--gpu-debug`, which also stops SDL assertion prompts |
| `BBLITE_TEST_PASS` | Harness: nonfocusable, camera controls off |
| `BBLITE_GROUND`, `BBLITE_BACKGROUND` | Set by `parity --without` |
| `BBLITE_ID_BUFFER`, `BBLITE_CLUSTER_BUFFER`, `BBLITE_COPY_TASK` | Set by `parity` for attribution |
| `BBLITE_BENCHMARK_FRAMES`, `BBLITE_BUILD_STAMP_OUT` | Measured run length and stamp; `0` disables VSync for direct renderers |

`BBLITE_SOURCE_PROFILE=<name>,...` is read by `process`/`compile`, which regenerate with `--source-profile`: a timing scope
in each named function (`name`, `Class.method`, or the binding of an unnamed function). Generation fails for names that
time nothing (misspelled, async, generator or inlined; select the caller). Output: `[cpu][source-startup]`,
`[cpu][alloc-startup]`, and with `BBLITE_CPU_PROFILE=1` per frame `[cpu][source]` (`self_ms` excludes selected callees)
and `[cpu][alloc]`. Unset it and `process` again to restore the normal build.

CPU physics output sums island times, so parallel phases overlap; contacts count in setup, split impulses in iterations.
