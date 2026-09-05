# Diagnosing a scene

Use captures and numerical comparisons to locate a rendering discrepancy.
A small MAD does not establish a rounding floor: identify the pinned arm,
input or backend operation that explains it. Never tune a shader to a golden.

## The ladder

Commands below follow `npm run scene --`. `diagnose <id>` runs differential
parity, paired captures and material composition over one capture directory.

| Question | Command |
| --- | --- |
| Are the binary, payload and golden current? | `parity <id>` |
| Does the difference depend on the GPU backend? | `parity <id> --differential` |
| Which draw/input/shader differs? | `diff <id>` |
| What did the browser actually upload? | `capture <id>` then `uniforms <id> --size N` |
| Which draw owns the pixels? | Registry-enabled ID/cluster attribution in parity reports |
| Which render-target attachment differs? | `geometry <id>` |
| Is the feature responsible? | `parity <id> --without ground|background`, or an isolated source probe |
| Did asset-derived material composition match? | `compose <id>` |
| Does the result repeat? | `stability <id> --backend dawn` |
| Does process memory settle under sustained input? | `memory <id|all> --replay-file <tape>` |

### 1. Is the measurement real?

Measured native runs reject stale build stamps and deployed payloads.
The golden must also match source, module, query, seek/frame and UI settings.
After pulling main, regenerate and rebuild before diagnosing stale artifacts;
rebuild patched dependencies separately. See [development](development.md#build-identity).

Tint and DXC both have content-addressed caches. Do not delete them to diagnose
ordinary source changes; use `process --cold` to bypass the outer stage skip.
Compiler DLLs and transformation options must participate in invalidation.

### 2. Which side is it on?

Backend agreement narrows the search toward shared inputs/behavior; it does
not prove either image correct. Disagreement directs attention to shader
translation, bindings, uploads and backend state.

Use `stability <id> --backend <b> --runs N`, then `--single-sample`, to
distinguish repeatability from multisample variation. Both run-to-run and
golden differences are reported. Single-sample results against multisampled
goldens are context, not parity gates. A changed seek suppresses golden
comparison and uses separate artifacts.

The neutrality allowlist in `src/scene-neutrality.ts` is per scene/backend.
Do not expand it without repeated measurements and a mechanism. A browser
capture can also vary; repeat it before attributing a non-identical screenshot
to instrumentation or an upstream behavior change.

### 3. `scene -- diff` — the two captures, paired

`diff <id> [--backend dawn] [--seek <t>] [--capture <dir>] [--recapture]`
refreshes missing/stale captures and reports, in order:

1. Draw shapes/order and renderables.
2. Uniform fields decoded through generated C++ and captured WGSL layouts,
   including pinned material/mesh blocks and blocks unused by any draw.
3. Native bone palettes against browser float-texture uploads.
4. Captured/generated shader hashes, one-sided arms and nearest mismatches.
5. Texture-sample expressions.

Native captures rebuild CPU-side blocks with the same generated writers used
by rendering. They do not intercept GPU uploads: correct bytes sent to a wrong
slot can look correct here. Uniform values are matched across captured tuples;
matches are evidence of presence, not proof of exact draw/binding correspondence.
Pinned mesh blocks marked `worldSource: effective-draw` include late asset-root
transforms and resolved skin/instance conventions for the main draw lists.
They use the backend's shared block builder; geometry/shadow pass uploads still
require separate capture or GPU inspection.
The palette comparison covers the first two matrices; read the full deformation
dump for other bones. Expected native-only shader permutations are not errors.

### 4. One buffer, in detail

`capture <id>` hooks the browser's shader, buffer, texture and draw operations,
including render bundles. An unfiltered capture compares its screenshot with
the golden. `--skip-draw <indexCount>` isolates matching browser draws;
`--seek-bracket` captures the chosen pose and its neighboring frames.

`uniforms <id> --size N [--module <substring>] [--capture <dir>]` decodes every
candidate layout of that size and labels ambiguity. Several material layouts
can share one buffer size. For SDL binding questions, inspect generated
`upstream/shaders/*.slots`: unused declarations can disappear during Tint
translation, so counting WGSL declarations does not give native slot order.

### 5. Which draw, which pixels

Read parity hotspots and ID/triangle-cluster attribution, where enabled.
`measure <png> [--background r,g,b]` prints the non-background bounding box,
pixel count and mean color. Its default background is the top-left pixel and
matching is exact; explicitly choose the background for unsuitable images.

### 6. Isolation

Keep original corpus files unchanged. Put a temporary modified source under
`examples/`, process it and intentionally capture its own reference.
For ground/skybox isolation, use `--without` against the unchanged golden;
the ungated artifacts are suffixed separately.

`probe-variants <id> --shader <stem> --term <text> --with <text>` temporarily
changes a deployed Dawn WGSL term, renders before/after and restores it.
`--replace-file <path>` supplies a complete replacement. It is Dawn-only;
SDL_GPU needs offline shader compilation. A probe result must become a source
fix in the compiler/lowerer/PAL, never a permanent generated shader edit.

### 7. Did we derive the material's features at all?

`compose <id|all> [--capture <dir>]` executes pinned glTF material feature
derivation/composition and compares complete fragments with browser captures.
Light mode and tone mapping are swept because they also depend on scene code.
`--capture` applies only to a single scene.

This tool derives asset materials. Scene-created materials and later setters
can change the result; use `diff`'s actual generated/captured shader comparison
for those cases. A green asset-only compose report does not validate arbitrary
scene-code material mutation.

## Sizing a scene before writing any code

Compile the exact unregistered source first. Inspect all usages of the blocked
capability, including assets, before choosing its implementation. The first
error is not a complete inventory. See [development](development.md#sizing-a-capability-before-implementing-it).

## Before calling a scene done

- Build and measure both backends with current generated output/dependencies.
- Check composed materials when applicable and investigate unexplained gaps.
- Exercise camera/input and scene changes. Turn discoveries into reproducible
  capture or input-replay checks; a single fixed pose cannot cover all behavior.
- Preserve corpus inputs, references and thresholds as evidence.
- Record semantic adaptations and any unmeasured boundary explicitly.

## Why each tool still exists

The ladder separates image comparison, captured state, asset composition,
repeatability and sustained memory behavior. Prefer these shared commands over
one-off diagnostic scripts. `diff` cannot replace GPU differential measurements,
full buffer decoding, render-target views, interaction replay or lifetime tests.

`memory` defaults to 6,000 frames and a 32 MB post-warm-up growth threshold;
`all` selects application demos. Use `--frames`, `--max-growth-mb`, `--backend`
and either `--replay` or `--replay-file`. It writes raw stderr, samples and a
provenance-bearing JSON verdict. Missing/incomplete samples fail as unmeasured.
Working-set stability is a coarse signal, not proof that objects are reclaimed;
small cycles and GPU leaks need ownership/resource tests. Scene-less loops
currently do not emit memory samples.

## Artifacts

| Path | Content |
| --- | --- |
| `artifacts/parity/<id>/report-{gpu,dawn}.json` | Golden comparisons, thresholds and attribution |
| `artifacts/parity/<id>/report-differential.json` | Both backends and their direct comparison |
| `artifacts/parity/<id>/native-*.png`, `diff-map-*.png`, `hotspots-*.png` | Captured and diagnostic images |
| `artifacts/parity/<id>/geometry/` | Render-target attachment comparisons |
| `artifacts/parity/<id>/stability/` | Repeated-run images/reports |
| `artifacts/parity-canvas/` | UI-free attribution references and reports |
| `artifacts/capture/<id>/` | Browser shaders, buffer/texture bytes, draws, screenshot and metadata |
| `artifacts/capture/<id>/native-{gpu,dawn}.json` | Native CPU model and uniforms |
| `artifacts/capture/<id>/diff-*.json`, `compose-report.json` | Derived analysis |
| `artifacts/capture/<id>/seek-*/`, `probe-variants/` | Isolated pose/shader experiments |
| `artifacts/memory/<id>-{gpu,dawn}.{json,log}` | Sustained-run verdict, samples and raw trace |

Artifact token `gpu` means SDL_GPU; CLI backend names are `sdl_gpu|dawn`.
Shared report writers add tool/time and available backend/build provenance.
Raw captures have their own build/pose sidecars. Do not reuse a capture after
its source, compiler, package, pose or native stamp changes.

## Runtime switches worth knowing

| Variable | Purpose |
| --- | --- |
| `BBLITE_RENDER_CAPTURE=<path>` | CPU-side native capture |
| `BBLITE_DEFORMATION_DUMP=<path>` | Full bone/morph dump on supported SDL paths |
| `BBLITE_MSAA=1` | Single-sample isolation |
| `BBLITE_RUNTIME_TRACE=1`, `BBLITE_RUNTIME_TRACE_INTERVAL=<n>` | Input/camera/topology/window traces |
| `BBLITE_INPUT_REPLAY=<tape>` | Keyboard, mouse, UI and window-close events, one action per frame |
| `BBLITE_UI_STYLE_TRACE=1` | Computed RmlUi styles/layout |
| `BBLITE_PHYSICS_TRACE=1`, `BBLITE_CPU_PROFILE=1` | Solver trajectory and timing/counters |
| `BBLITE_MEM_PROFILE=1` | Working-set/geometry samples every 30 frames |
| `BBLITE_AUDIO_CAPTURE=<wav>`, `BBLITE_AUDIO_CAPTURE_SECONDS=<t>` | Offline audio in capture-enabled builds |

Use `--gpu-debug` rather than setting only `BBLITE_GPU_DEBUG`: it also sets
`SDL_ASSERT=always_ignore`, preventing an unattended validation run from
blocking on SDL's assertion prompt. File-dialog/storage/capture controls are
listed in [development](development.md#runtime-switches).
