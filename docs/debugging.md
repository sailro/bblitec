# Diagnosing a scene

Every question this page answers has a tool that answers it by
measurement. Reaching for one is not a last resort after reasoning fails;
it is the first step, because the reasoning is only worth as much as the
evidence under it. The recurring cost in this project has never been a
hard bug — it has been an afternoon spent inferring from a pixel residual
something that one command prints directly.

Two rules make the rest of this page work:

- **Capture before theorizing.** A hypothesis that was not derived from a
  capture is a guess, and a guess that happens to sound mechanical is the
  expensive kind. Two sessions were lost to inferences from pixel
  statistics that a `scene -- diff` would have settled in a minute.
- **Never call a residual a floor from statistics alone.** "It is
  probably a sampling floor" is a claim about a mechanism, and a
  mechanism claim needs a mechanism: the pinned line that does something
  ours does not. Percentages of exactly-matching pixels are not that.

## The ladder

Work down it. Each rung answers a question that makes the rungs below it
meaningful, and stopping early is how a wrong branch gets taken.

| # | Question | Command |
| --- | --- | --- |
| 1 | Am I measuring the build and golden I think I am? | `scene -- parity <id>` (it refuses a stale binary or payload by itself) |
| 2 | Is the difference on the CPU or the GPU side? | `scene -- parity <id> --differential` |
| 3 | Which value differs from Babylon Lite's? | `scene -- diff <id>` |
| 4 | What exactly did the browser upload into that buffer? | `scene -- capture <id>` then `scene -- uniforms <id> --size N` |
| 5 | Which draw owns the bad pixels? | attribution buffers in `artifacts/parity/<id>` |
| 6 | Does removing the feature remove the residual? | copy the scene to `examples/`, strip it, `parity --recapture-reference` |

### 1. Is the measurement real?

Three things go stale independently, and each has been the whole answer
at least once:

- **The executable.** `parity` compares the binary's build stamp against
  the generated tree and refuses a mismatch. Never work around this.
- **The deployed payload.** Shaders and assets beside the executable are
  compared file by file; a shader step that failed without stopping the
  build is otherwise invisible.
- **The golden.** A reference is only valid for the registry parameters
  it was captured under. If native and `scene -- capture <id> --seek <t>`
  agree with each other but the golden disagrees with both, the golden is
  stale — recapture it with `parity <id> --recapture-reference` before
  debugging anything else. This cost an hour on scene 242.

One more, off the parity path: `artifacts/shader-cache` keys on the WGSL
and the DXC flags, not on `tools/compile-shaders.ps1`. After editing that
script, delete the cache or every "reused N cached variants" is a lie.

### 2. Which side is it on?

```powershell
npm run scene -- parity scene33 --differential
```

SDL_GPU and Dawn are two independent compiler and API stacks. Agreement
to one LSB puts the cause on the CPU side — our values, our plan, our
loader. Disagreement puts it on the GPU side — a pipeline state, a shader
translation, a format. This is the sharpest single bit of information
available, and it costs one command.

Scenes 9 and 37 are not bit-stable on Dawn from run to run; re-run before
reading anything into a moved Dawn cell for those two.

### 3. `scene -- diff` — the two captures, paired

```powershell
npm run scene -- diff scene33
npm run scene -- diff scene33 --backend dawn --recapture
```

This is the tool to reach for by default. It takes both captures and
reports where they part:

- **Browser side** (`scene -- capture`): the pinned Babylon Lite package
  rendered in headless Chromium with every WebGPU entry point hooked —
  the composed WGSL modules, every uploaded buffer with its bytes, the
  texture uploads, and the draw census across pass *and render-bundle*
  encoders.
- **Native side** (`scene -- capture <id> --native`): our runtime's
  description of the same frame — every uniform block it builds, the draw
  list in submission order, and the scene, camera, light, mesh and
  material records those are built from.

The report is ordered so that a difference appears above everything it
can cause:

1. **Draw counts.** A different set of draws explains every uniform and
   every pixel below it. Settle this first: it usually means a mesh that
   did not load, a bucket that sorted differently, or a background quad
   one side draws and the other does not.
2. **Uniform blocks, field by field.** Native blocks are decoded through
   the struct declarations in the scene's own generated
   `renderer_plan.hpp`; browser buffers through the struct declarations
   in the browser's own composed shaders. So a difference reads
   `emissive_factor native 1, 1, 1 / browser 0, 0, 0` rather than as an
   offset into base64.
3. **Texture sample expressions.** The set of `textureSample(...)` calls
   in the browser's fragments against ours. A sample taken against a
   different UV than the pin is invisible in every uniform and obvious
   here — that is exactly what scene 39's `0.581 → 0.002` was.

Blocks are paired by byte length, then by the candidate with the fewest
differing fields, because a scene uploads one buffer per material and
comparing against the wrong material reports everything as wrong. A
native block with no browser buffer of its size is reported as unpaired
rather than force-matched: that means our material composes a different
feature set than the pin's, which is a finding in itself.

`diff` reuses captures already on disk. Pass `--recapture` after any
change to the scene, the compiler, or the native build.

**What `diff` does not cover.** The native side rebuilds each uniform
block from `(scene, engine, camera, item)` — the same tuple both backends
hand to the same generated builder — rather than intercepting the
graphics API. A backend that uploaded correct bytes to the wrong slot
still looks correct here. That failure mode is what rung 2 covers, which
is why both rungs exist.

### 4. One buffer, in detail

```powershell
npm run scene -- capture scene253
npm run scene -- uniforms scene253 --size 96
npm run scene -- uniforms scene253 --size 96 --module pbr
```

`uniforms` decodes the browser's captured buffers of a given size under
every struct of that size the captured shaders declare. Several unrelated
layouts share a size, so every candidate is printed and labelled with the
module it came from rather than one being picked — reading plausible
values out of the wrong layout is worse than reporting the ambiguity.

Identify a material by a distinctive field before concluding two buffers
are two materials: a double-buffered material looks like two.

### 5. Which draw, which pixels

Registry-enabled scenes emit draw-id and triangle-cluster buffers, and
the parity report joins them to glTF nodes, meshes, materials, alpha mode
and double-sided state. Read `report.json`'s hotspots to get a tile, then
the id attribution to get the draw.

`scene -- capture <id> --skip-draw <indexCount>` drops matching draws in
the browser, which isolates one draw's contribution when paired with a
matching temporary filter natively.

When a native render is wrong, **measure the PNG, do not eyeball it**. A
twenty-line pngjs script printing the non-clear bounding box turned "the
sprites are in the wrong place" into "exactly 7200 px at
(640,180)-(719,269)", which inverted through the vertex shader to the
exact quad corners and named the bug.

### 6. Isolation

The decisive experiment is removing the feature. Copy the scene into
`examples/`, delete the call, and measure:

```powershell
npm run scene -- process examples\probe.ts
npm run scene -- parity examples\probe.ts --recapture-reference
```

Scene 19's residual was pinned on its clearcoat in one run this way.
`compile` refuses sources outside the repository, which is why the copy
goes in `examples/`; delete it and its `generated/` directory afterwards.

For an animated scene, capture the browser at the seek and at ±1 frame
and compare against each. That gives the *scale* of one frame of motion,
so a residual can be judged against it instead of against intuition.

## Sizing a scene before writing any code

A blocker names a capability; it does not size one. The first error a
scene reports is the first line of its chain, not its length — scenes
4, 21, 23, 111, 140, 142, 226, 251 and 270 all hid shadows, node
materials, anisotropy, splats or post-process tasks behind a one-line
blocker.

**Compile-probe first.** This works without a registry entry:

```powershell
node dist\src\scene-command.js compile corpus\babylon-lite\lab\lite\src\lite\scene38.ts
```

**Then the stripped probe.** Copy the scene into `examples/`, replace the
blocking call with a supported sibling, compile, and repeat until it
comes back clean. Ten minutes, and it gives the exact scope instead of a
guess: scene 15's `createSpotLight → createPointLight` came back clean
and shipped the same day; scene 19's revealed a second contract the TODO
label never mentioned; scene 50's revealed five language contracts before
the sprite API it was labelled with.

Peel the non-intrinsic half first. It is often the cheaper half, and it
is the half no label mentions.

Then answer the two sizing questions in
[development](development.md#sizing-a-capability-before-implementing-it)
before choosing a shape.

## Before calling a scene done

- **Both backends, or it is not integrated.** A scene measured on one
  backend has no independent check on it at all. Making the gap visible
  does not make it acceptable.
- **Orbit it.** A gate renders the one pose its author chose. Moving the
  camera in the demo window found a skybox large enough for the far plane
  to clip it and an environment ground drawing as a hard-edged opaque
  quad — both through a green matrix. When orbiting finds something, turn
  it into a measurement: copy the scene to `examples/`, move the camera
  there, and `parity --recapture-reference` so both sides are compared at
  that pose.
- **Measure the cost of anything you are about to scope out.** Two
  beliefs that made remaining work look large — "the Dawn bring-up is
  entangled with the renderer", "re-proving neutrality is expensive" —
  were each checkable in a few minutes and each was wrong.

## Why each tool still exists

`diff` is the default entry point, not a replacement for the rest. Each
of the others answers something it structurally cannot, and reaching for
the wrong one wastes the run:

| Tool | What only it can answer |
| --- | --- |
| `parity --differential` | **CPU side or GPU side.** `diff` rebuilds the native uniform blocks from the render plan rather than intercepting the API, so a backend fault is invisible to it by construction. Two independent GPU stacks agreeing is the only evidence that separates the two. |
| `capture` | The browser's ground truth: composed WGSL, texture uploads, per-draw isolation with `--skip-draw`. `diff` consumes a subset of it and reports differences; the capture itself is what you read when `diff` says a value has no counterpart. |
| `uniforms` | One browser buffer in full, decoded under **every** candidate layout of its size, ambiguity included. `diff` picks a correspondence; `uniforms` refuses to and shows you all of them. |
| attribution buffers | Which draw owns which pixels, joined to nodes, meshes, materials and alpha state. Nothing else maps a screen region to a draw. |
| PBR diagnostic buffers | The shader's intermediate terms — normal, reflectivity, irradiance, IBL, albedo, direct light, pre-tonemap HDR. The only view *inside* a fragment; uniforms tell you the inputs were right, these tell you which term went wrong. |
| `geometry` | Frame-graph copy-task attachments at full resolution. `diff` does not look at render targets at all. |
| `BBLITE_DEFORMATION_DUMP` | Bone palettes and morph weights per mesh. The render capture records the material and scene uniforms, not the skinning matrices. |

The shape to expect: `parity` says something is wrong, `--differential`
says which side, `diff` names the value, and `capture`/`uniforms`/the
attribution buffers confirm it against the browser's own state.

## Artifacts

| Path | Written by | Holds |
| --- | --- | --- |
| `artifacts/parity/<id>/report.json` | `parity` | MAD, region breakdown, hotspots, attribution |
| `artifacts/parity/<id>/report-differential.json` | `parity --differential` | both backends plus their direct comparison |
| `artifacts/parity/<id>/*-diff.png`, `*-hotspots.png` | `parity` | where the pixels differ |
| `artifacts/capture/<id>/shaders/*.wgsl` | `capture` | the browser's own composed shader modules |
| `artifacts/capture/<id>/buffers.json` | `capture` | every browser buffer, with the last eight writes |
| `artifacts/capture/<id>/draws.json` | `capture` | the browser draw census, bundles included |
| `artifacts/capture/<id>/tex-uploads.json` | `capture` | texture uploads, with raw bytes for small texels |
| `artifacts/capture/<id>/native-<backend>.json` | `capture --native` | our scene model, draw list and uniform blocks |
| `artifacts/capture/<id>/diff-<backend>.json` | `diff` | the paired report |

## Runtime switches worth knowing

The full list is in [development](development.md#runtime-switches).
These are the diagnostic ones:

| Variable | Effect |
| --- | --- |
| `BBLITE_RENDER_CAPTURE=<path>` | write the frame's full CPU-side description as JSON |
| `BBLITE_DEFORMATION_DUMP=<path>` | append first-frame bone palettes and morph weights as hexfloats |
| `BBLITE_GPU_BACKEND=dawn` | select Dawn in a dual-backend build |
| `BBLITE_GPU_DEBUG=1` | enable the backend debug layer |
| `BBLITE_SCREENSHOT`, `BBLITE_SCREENSHOT_FRAME`, `BBLITE_MAX_FRAMES` | drive a headless measured run |

Comparing native bone palettes against the browser's requires the mirror
similarity map — negate column-major indexes 1, 2, 3, 4, 8 and 12 — which
is the documented `diag(-1, 1, 1)` convention difference, not a bug.
