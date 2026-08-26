# Diagnosing a scene

Every question this page answers has a tool that answers it by
measurement. Reaching for one is the first step, not a last resort after
reasoning fails: the reasoning is only worth as much as the evidence
under it.

Three rules make the rest of this page work:

- **Capture before theorizing.** A hypothesis that was not derived from a
  capture is a guess, and a guess that sounds mechanical is the expensive
  kind.
- **Never call a residual a floor from statistics alone.** "It is
  probably a sampling floor" is a claim about a mechanism, and a
  mechanism claim needs a mechanism: the pinned line that does something
  ours does not. Percentages of exactly-matching pixels are not that.
- **Look for the missing line in an *arm*, not in the arithmetic.**
  Upstream forks whole blocks on a boolean that records where an object
  came from, and a fork this port does not model looks exactly like a
  small systematic bias. `createClearcoatFragment` composes its base-F0
  remap unless `gltf-ext-clearcoat.ts` passes `useF0Remap: false`;
  `createSheenFragment` builds materially different arithmetic from
  `hasAlbedoScaling`; `createDefaultPipelineDescriptor` defaults
  `_cullMode` to `"back"` and only the image skybox overrides it. An
  uncomposed arm reads as rounding at any magnitude: a clearcoat region
  at 0.430 and a hard-edged background quad at 7.312 each measure as
  sampling noise once the arm the scene reaches composes.
  **So before writing "floor", find which arm the scene reaches and
  check that this port composes that one.**

## The ladder

Work down it. Each rung answers a question that makes the rungs below it
meaningful, and stopping early is how a wrong branch gets taken.
`scene -- diagnose <id>` walks rungs 2, 3 and 7 in that order over one
shared capture and prints each rung's verdict — the ladder as one command;
the individual rungs remain the tools for going deeper.

| # | Question | Command |
| --- | --- | --- |
| 1 | Am I measuring the build and golden I think I am? | `scene -- parity <id>` (it refuses a stale binary or payload by itself) |
| 2 | Is the difference on the CPU or the GPU side? | `scene -- parity <id> --differential` |
| 3 | Which value differs from Babylon Lite's? | `scene -- diff <id>` |
| 4 | What exactly did the browser upload into that buffer? | `scene -- capture <id>` then `scene -- uniforms <id> --size N` |
| 4b | What did *we* put in the pinned variant's blocks? | `scene -- diff <id>` — its pinned section pairs `pinnedMaterialBlocks` / `pinnedMeshBlocks` (built by the same writers the draw path calls, CPU-side) against the browser's uploads row by row, flagging blocks no draw carries as refused. The raw listings stay in `artifacts/capture/<id>/native-gpu.json`; a pinned-path residual is an input, never the shader, once the report's shader arms match |
| 5 | Which draw owns the bad pixels? | attribution buffers in `artifacts/parity/<id>` |
| 6 | Does removing the feature remove the residual? | copy the scene to `examples/`, strip it, `parity --recapture-reference` |
| 7 | Did we derive the material's features at all? | `scene -- compose <id>` — composes each material through the pin and checks the whole fragment against the captured one |

### 1. Is the measurement real?

Three things go stale independently, and any one of them can be the whole
answer:

- **The executable.** `parity` compares the binary's build stamp against
  the generated tree and refuses a mismatch. Never work around this.
- **The deployed payload.** Shaders and assets beside the executable are
  compared file by file; a shader step that failed without stopping the
  build is otherwise invisible.
- **The golden.** A reference is only valid for the registry parameters
  it was captured under
  ([development](development.md#integrating-a-curated-parity-scene) carries
  the full contract). If native and `scene -- capture <id> --seek <t>`
  agree with each other but the golden disagrees with both, the golden is
  stale — recapture it with `parity <id> --recapture-reference` before
  debugging anything else.

One more, off the parity path: `artifacts/shader-cache` keys on the DXC
binaries, the profile and flags, and the *transformed HLSL* — so edits to
`tools/compile-shaders.ps1`'s transformation passes are captured
transitively through the HLSL bytes, and the Tint half re-runs on every
invocation regardless. The one unkeyed surface is an inline change to the
DXC invocation shape itself; delete the cache only after one of those.

### 2. Which side is it on?

```powershell
npm run scene -- parity scene33 --differential
```

SDL_GPU and Dawn are two independent compiler and API stacks: agreement
to one LSB puts the cause on the CPU side, disagreement on the GPU side
([backends](backends.md) carries the rationale). One command separates
the two.

Scenes 9, 37 and 120 are not bit-stable from run to run, so a moved cell for
those three means nothing on its own — `scene -- neutrality` knows that and
reports them as expected wobble. The scope is measured rather than assumed,
per scene and per backend: every one of them is bit-identical under
`BBLITE_MSAA=1`, so the wobble is the multisampled path, and it is not
Dawn's alone — scene 9 wobbles on Dawn while measuring bit-stable on
SDL_GPU across four runs, and scenes 37 and 120 wobble on both (peak
run-to-run MAD 0.000059 and 0.000250 on SDL_GPU). That pair of `stability`
runs is the entry fee, because a whitelist row excuses those cells
permanently: scene 120's Dawn wobble spans 0.002 against a 0.004 foreground,
so a regression smaller than that would hide behind it.

That check is a command for any scene:

```powershell
npm run scene -- stability scene9 --backend dawn
npm run scene -- stability scene9 --backend dawn --single-sample
npm run scene -- stability scene120 --backend sdl_gpu
```

It renders the native side N times (default 5, `--runs N`; `--seek <t>` at a
non-registry pose suppresses the golden columns and suffixes the artifacts
`-seek<t>`) and prints every
run against run 1 *and* against the golden — both columns always, because
comparing runs only against each other hides a stable-but-wrong image, and the
report says so out loud when the runs agree while all differing from the
golden. `--single-sample` re-runs at one sample — the bisection that separates
multisampling from everything else; its golden column is context only, since
the goldens are multisampled.

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
  list in submission order, including scene renderables outside the mesh
  render plan such as Gaussian splats, and the scene, camera, light, mesh
  and material records those are built from.

The report is ordered so that a difference appears above everything it
can cause:

1. **Draw counts.** A different set of draws explains every uniform and
   every pixel below it. Settle this first: it usually means a mesh that
   did not load, a bucket that sorted differently, or a background quad
   one side draws and the other does not.
2. **Uniform blocks, field by field.** Native blocks are decoded through
   the struct declarations in the scene's own generated headers —
   `renderer_plan.hpp`, plus the pinned uniform mirrors in
   `standard_variants.hpp`/`pbr_variants.hpp`, which is where the
   Standard material block and the shared scene/light/mesh blocks live;
   browser buffers through the struct declarations
   in the browser's own composed shaders. So a difference reads
   `emissive_factor native 1, 1, 1 / browser 0, 0, 0` rather than as an
   offset into base64. The capture's `pinnedMaterialBlocks` and
   `pinnedMeshBlocks` ride the same pairing as vec4 rows named
   `pinned ...`, with per-block tallies in the report's pinned section —
   rung 4b's two listings, diffed instead of read. A material block no
   PBR draw carries is flagged refused: its values never reached the
   GPU, so a divergence there cannot explain a pixel. Mesh worlds ride
   the mirror convention (end of this page), so a sign-flipped lane
   against the browser's is documented, not a finding.
3. **Texture palettes.** Babylon Lite uploads each skin's bone matrices
   as an Nx1 rgba32float texture, and the capture keeps those texels'
   raw bytes in `tex-uploads.json`. The report decodes them and looks
   each native `bone0`/`bone1` palette matrix up among them with the
   mirror map already applied, so the skinning comparison is a
   matched/divergent verdict rather than a by-eye hexfloat diff with a
   sign-flip caveat; an unmatched palette is promoted to a finding.
4. **Shader arms.** Every captured module hashed against the generated
   `pbr-variants/*.wgsl` and the deployed `*.native.wgsl` set, per-line
   trailing whitespace ignored: matched groups name their counterparts,
   both one-sided sets are listed — arms the browser did not compose at
   this pose are normal on the native side — and the closest near miss
   prints its first divergent line, which names the arm. A captured PBR
   fragment matching no arm is promoted to a finding; that is the
   compose-class defect, caught without a compose run.
5. **Texture sample expressions.** The set of `textureSample(...)` calls
   in the browser's fragments against the generated ones. A sample taken
   against a different UV than the pin is invisible in every uniform and
   obvious here.

Values are matched rather than blocks: every float tuple the browser
uploaded is indexed, and each native field is looked up in it, so a
native value with no browser counterpart reads as its own finding
instead of forcing a block pairing — which usually means the generated
material composes a different feature set than the pin's, a finding in
itself.

`diff` reuses captures already on disk only while they are still valid
evidence: it compares the native capture's embedded build stamp against
the current generated tree and each capture's recorded seek against the
requested pose, and recaptures on any mismatch, saying why. Pass
`--recapture` to force both sides fresh regardless.

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

If a stage looks like it is reading the *wrong* block — a uniform whose
values belong to a different one, a texture sampling as another — read the
`.slots` file beside that stage in `generated/<scene>/upstream/shaders/`
before anything else:

```powershell
Get-Content generated/scene93/upstream/shaders/sprite_custom.frag.slots
```

Each line is a register and the block that kept it (`b0 fx`, `t0 atlasTex`).
That file, not the WGSL, is what SDL_GPU binds against — a declared-but-unread
block does not survive Tint and the compaction that follows is dense
([backends](backends.md#dawn-backend-architecture-nativesrcpal_dawncpp)
owns the contract) — so counting declarations in the `.native.wgsl` gives
the wrong answer.

### 5. Which draw, which pixels

Registry-enabled scenes emit draw-id and triangle-cluster buffers, and
the parity report joins them to glTF nodes, meshes, materials, alpha mode
and double-sided state. Read `report-<backend>.json`'s hotspots to get a
tile, then the id attribution to get the draw.

`scene -- capture <id> --skip-draw <indexCount>` drops matching draws in
the browser, which isolates one draw's contribution when paired with a
matching temporary filter natively.

When a native render is wrong, **measure the PNG, do not eyeball it**:

```powershell
npm run scene -- measure artifacts\parity\scene50\native-gpu.png
npm run scene -- measure probe.png --background 51,51,76
```

It prints the non-background bounding box, pixel count and mean RGB. An
exact box and count — "7200 px at (640,180)-(719,269)" — inverts through
the vertex shader to the quad corners that produced it, which a
description like "the sprites are in the wrong place" cannot. The
background defaults to the top-left pixel and matches exactly, because
the exact count is the point: native renders clear to one solid color
while browser goldens dither theirs, so point it at the native PNG.

### 6. Isolation

The decisive experiment is removing the feature. Copy the scene into
`examples/`, delete the call, and measure:

```powershell
npm run scene -- process examples\probe.ts
npm run scene -- parity examples\probe.ts --recapture-reference
```

Isolation says which feature; it does not say which line. Naming the line
takes reading the browser's own composed fragment beside the generated
one — a residual isolated to a clearcoat, for instance, resolves only
once the coat's base-F0 remap shows up as a block present in the
browser's fragment and absent from the generated one.
`compile` refuses sources outside the repository, which is why the copy
goes in `examples/`; delete it and its `generated/` directory afterwards.

For an animated scene, bracket the pose:

```powershell
npm run scene -- capture scene5 --seek-bracket
```

That captures the browser at the seek and at ±1 frame (into
`seek-minus1/` and `seek-plus1/` beside the main capture) and prints the
MAD between the exact frame and each neighbour — the *scale* of one
frame of motion, so a residual can be judged against it instead of
against intuition. Only the exact-seek capture keeps the byte-identity
check against the golden; the brackets are one frame away from its pose
by design.

The same experiment works one level lower, on a single shader arm,
without touching the scene — and it is a command:

```powershell
npm run scene -- probe-variants scene9 --shader variant-std-base-f0.frag --term "shadowFactors[lightIndex]" --with "1.0"
```

The build deploys every generated shader next to the executable in
`native\build-<id>-release\shaders\`, and the Dawn backend compiles the
deployed `.native.wgsl` at startup. `probe-variants` copies that
directory aside, substitutes the named term in the chosen shader
(`--replace-file <path>` swaps in a whole file's content instead),
renders the native frame through the existing capture entry point
before and after the edit — the same executable, no rebuild — and
restores the directory unconditionally, success or failure. It prints
both `scene -- measure` measurements, the MAD between the two frames —
that is the arm's exact contribution to the residual — and both frames
against the golden when the scene has one; artifacts land in
`artifacts/capture/<id>/probe-variants/`. One limit: the probe is
Dawn-only — SDL_GPU consumes its target-selected offline shader artifact
beside the WGSL, which only `tools/compile-shaders.ps1` refreshes, so an SDL_GPU
run would measure the unedited compiled artifacts. That is the point:
the probe is an ephemeral measurement, and what it finds flows back
into generation, never into a hand-edited shader.

### 7. Did we derive the material's features at all?

`scene -- compose <id|all>` runs every glTF material the scene loads through
Babylon Lite's own `_computePbrMaterialFeatures` and `composeShader`, and
checks the result against the fragments `scene -- capture` recorded from the
browser. Byte-for-byte, not bit-by-bit: a fragment that matches proves the
whole derivation at once, and one that does not prints the line where it
stops agreeing, which names the arm.

```
scene253: 14 material(s), 15 captured PBR fragment(s)
  ok   "PBRProperties-OcclusionStrength" [ibl|linear|reflectance] == 13-module-13.wgsl  (lights 2 +tonemap)
  GAP  "Fringe" [ibl|reflectance|sheen] matches no captured fragment
       closest 07-module-7.wgsl, diverges at line 60:
         ours   ["@group(1)@binding(8) var brdfLUT:texture_2d<f32>;"]
         theirs ["@group(1)@binding(8) var occlusionTexture:texture_2d<f32>;"]
```

That divergence is the finding: the reference binds a dedicated occlusion
texture the generated fragment does not, so the uv2 mask is wrong. Every
material-mapping defect reads that way.

Two things it does not derive, because they belong to the scene rather than to
its asset and guessing them is wrong in both directions: the **light mode** —
Scene 39's glTF declares two punctual lights while none of its captured
fragments composes a light path at all — and **tone mapping**, which Scene 21
disables in scene code after `loadEnvironment` enables it. Both are swept and
the combination that reproduces the capture is reported, so the
`(lights 2 +tonemap)` suffix is a measurement of the scene rather than an
assumption about it.

Its one blind spot is a material the *scene* built rather than the asset —
`createPbrMaterial` plus a `setPbr*` call — which it flags rather than
reporting as a bare gap.

`--capture <dir>` compares against a capture written somewhere other than
`artifacts/capture/<scene>`; it names one scene's capture directory, so it
does not compose with `all`.

## Sizing a scene before writing any code

A blocker names a capability; it does not size one. The first error a
scene reports is the first line of its chain, not its length — scenes
4, 111, 140, 226, 251 and 270 each hide a whole subsystem behind a
one-line blocker.

**Compile-probe first.** This works without a registry entry:

```powershell
node dist\src\scene-command.js compile corpus\babylon-lite\lab\lite\src\lite\scene38.ts
```

**Then the stripped probe.** Copy the scene into `examples/`, replace the
blocking call with a supported sibling, compile, and repeat until it
comes back clean. Ten minutes, and it gives the exact scope instead of a
guess. The outcomes it separates: a substitution that comes back clean
scopes the scene to that one call; one that exposes a further contract
scopes it to a chain the TODO label does not name — a scene labelled
with a rendering API commonly reports several language contracts ahead
of it.

Peel the non-intrinsic half first. It is often the cheaper half, and it
is the half no label mentions.

Then answer the two sizing questions in
[development](development.md#sizing-a-capability-before-implementing-it)
before choosing a shape.

## Before calling a scene done

- **Both backends, or it is not integrated.** A scene measured on one
  backend has no independent check on it at all. Making the gap visible
  (a flag, an unmeasured column, a TODO) documents an unfinished job
  rather than making it acceptable.
- **Compose its materials.** If the scene loads a glTF, `scene -- compose
  <id>` should report every material matching. A green parity gate does not
  prove the derivation: a fragment missing an arm entirely still renders,
  still measures, and simply comes out slightly wrong, so a scene can hold
  a published gate while only some of its materials compose correctly.
- **Orbit it.** A gate renders the one pose its author chose, and a defect
  that is off-screen or edge-on at that pose passes a green matrix — a
  skybox the far plane clips, or one that breaks into a hard-edged quad
  outside the cube, are both invisible from a fixed camera. When orbiting
  finds something, turn it into a measurement: copy the scene to
  `examples/`, move the camera there, and `parity --recapture-reference`
  so both sides are compared at that pose.
- **Then bisect before believing the description.** A background defect
  identified by eye can be filed against the wrong element.
  `BBLITE_GROUND=0` and `BBLITE_BACKGROUND=0` each remove one background
  element, and the one whose removal makes the measurement *worse* is not
  the cause. On a scene where the ground is the named suspect, disabling
  the ground moves the measurement from 6.455 to 9.619 while disabling the
  skybox moves it to 1.202 — that ordering names the skybox, with no code
  read.
  `scene -- parity <id> --without ground|background` runs the native side
  with one element suppressed against the unchanged golden, artifacts
  suffixed `-without-<element>` so the standard run's stay untouched, and
  no threshold gate — the number *is* the answer.
- **Measure the cost of anything you are about to scope out.** A belief
  that makes remaining work look large is often checkable in minutes.

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
| `geometry` | Frame-graph copy-task attachments at full resolution. `diff` does not look at render targets at all. Takes `--backend`, `--seek`, `--gpu-debug` and `--exe` under the same rules as `diff`: the pose defaults to the registry's, and a cached reference at another pose (or without provenance) is recaptured rather than compared. |
| `BBLITE_DEFORMATION_DUMP` | Bone palettes and morph weights per mesh, in full. `diff`'s texture-palette section verdicts the first two matrices per mesh against the browser's uploads; this dump is what to read when that verdict says divergent. |
| `stability` | **Whether a number is reproducible at all.** Every other tool measures one run; only repeated runs separate a residual from the scenes 9/37/120 run-to-run wobble class — and its golden column prints beside the run-to-run one because a stable-but-wrong image passes the latter. |
| `compose` | Whether our *feature derivation* is right, which every tool above assumes. They compare what two renderers did; `compose` compares what Babylon Lite would have built against what we built it from, so it catches a fragment that is missing an arm entirely — the failure that renders as a plausible small bias and never as an error. |

The shape to expect: `parity` says something is wrong, `--differential`
says which side, `diff` names the value, and `capture`/`uniforms`/the
attribution buffers confirm it against the browser's own state.

`compose` sits slightly outside that chain and is worth running *first* when
the suspect is a material: it needs no native build and no parity run, only a
capture, and a scene whose materials all compose byte-identically has ruled
out the entire class of defect in one command.

## Artifacts

| Path | Written by | Holds |
| --- | --- | --- |
| `artifacts/parity/<id>/report-{gpu,dawn}.json` | `parity` | MAD, region breakdown, hotspots, attribution, per backend |
| `artifacts/parity/<id>/report-differential.json` | `parity --differential` | both backends plus their direct comparison |
| `artifacts/parity/<id>/native-{gpu,dawn}.png` | `parity` | the native actual, suffixed per backend so runs cannot overwrite each other |
| `artifacts/parity/<id>/diff-map-<backend>.png`, `hotspots-<backend>.png` | `parity` | where the pixels differ |
| `artifacts/parity/<id>/geometry/<task>-{lite,native-<backend>,diff-<backend>}.png`, `report-<backend>.json` | `geometry` | frame-graph copy-task attachments: the browser reference (backend-free `-lite`), the native attachment and diff per backend |
| `artifacts/capture/<id>/shaders/*.wgsl` | `capture` | the browser's own composed shader modules |
| `artifacts/capture/<id>/buffers.json` | `capture` | every browser buffer, with the last eight writes |
| `artifacts/capture/<id>/draws.json` | `capture` | the browser draw census, bundles included |
| `artifacts/capture/<id>/tex-uploads.json` | `capture` | texture uploads, with raw bytes for small texels; `diff`'s palette matching reads the rgba32float ones |
| `artifacts/capture/<id>/seek-{minus1,plus1}/`, `seek-bracket.json` | `capture --seek-bracket` | the ±1-frame captures and the one-frame motion scale |
| `artifacts/capture/<id>/native-{gpu,dawn}.json` | `capture --native` | our scene model, draw list and uniform blocks |
| `artifacts/capture/<id>/capture-meta.json`, `native-{gpu,dawn}.meta.json` | `capture` / `capture --native` | the seek, the served browser-module digest and the golden byte-identity verdict — `diff`, `compose` and `uniforms` refuse or recapture on a mismatch |
| `artifacts/capture/<id>/compose-report.json` | `compose` (single scene) | the per-material compose verdicts with provenance |
| `artifacts/capture/<id>/diff-{gpu,dawn}.json` | `diff` | the paired report |
| `artifacts/capture/<id>/probe-variants/{before,after}/native-dawn.*`, `probe-variants/probe-variants.json` | `probe-variants` | the two native renders around one neutralized shader term, and the before/after measurement |
| `artifacts/parity/<id>/report-<token>-without-{ground,background}.json`, `native-...png` | `parity --without` | the suppression run, suffixed so the standard run's artifacts stay |
| `artifacts/parity/<id>/stability/run<N>-<token>[-single-sample].png`, `stability-<token>[-single-sample].json` | `stability` | per-run renders and the run-to-run/golden comparison |

One filename token per backend everywhere: `gpu` is SDL_GPU and `dawn` is
Dawn, in parity, capture, diff and geometry artifacts alike — `--backend`
values stay `sdl_gpu|dawn`. Every tool-written report above carries
`tool` and `writtenAt` provenance, plus `backend` and `generatedStamp`
wherever a backend and a generated tree were in play — the browser-side
`seek-bracket.json` has neither, and the raw capture records (buffers,
draws, tex-uploads, the native captures and the meta sidecars) are
data, not reports: their provenance is the embedded build stamp and the
seek sidecar the reuse check reads. The
provenance fields are strings, which is what keeps them invisible to
`scene -- neutrality`'s numeric cell comparison.

## Runtime switches worth knowing

The full list is in [development](development.md#runtime-switches).
These are the diagnostic ones:

| Variable | Effect |
| --- | --- |
| `BBLITE_RENDER_CAPTURE=<path>` | write the frame's full CPU-side description as JSON |
| `BBLITE_DEFORMATION_DUMP=<path>` | append first-frame bone palettes and morph weights as hexfloats |
| `BBLITE_GPU_BACKEND=dawn` | select Dawn in a dual-backend build |
| `BBLITE_GPU_DEBUG=1` | enable the backend debug layer (prefer `--gpu-debug`, which `parity`, `diff`, `capture --native` and `probe-variants` all take and which also defuses SDL's assertion handler) |
| `BBLITE_MSAA=1` | render single-sampled |
| `BBLITE_SCREENSHOT`, `BBLITE_SCREENSHOT_FRAME`, `BBLITE_MAX_FRAMES` | drive a headless measured run |

**A backend error message is rarely the error.** `SDL_GPU` reports a bad
render pass only when the command list is submitted
(`SDL_SubmitGPUCommandBufferAndAcquireFence: Failed to close command list`),
which names neither the pass nor the parameter. Add `--gpu-debug` and it
names both:

```bash
npm run scene -- parity scene116 --gpu-debug
```

A refusal that surfaces as that generic message reads as
`'!"Store op is RESOLVE or RESOLVE_AND_STORE but texture is not
multisample!"'` under the flag. `--gpu-debug` does two things, and the second
is why `BBLITE_GPU_DEBUG=1` set by hand hangs instead of answering: SDL's
default assertion handler *prompts*, so the run blocks forever waiting for an
input nothing will give it. `--gpu-debug` sets `SDL_ASSERT=always_ignore` as
well, which makes the assertion print and the run continue.

**`BBLITE_MSAA=1` is a bisection tool, not just a diagnostic.** Comparing a
backend against *itself* at one sample separates multisampling from
everything else — it is what placed the scenes 9/37/120 run-to-run wobble in
the multisampled path ([which side is it on?](#2-which-side-is-it-on)
carries the measurement). Compare backend-to-backend or run-to-run when you
do this — the goldens are multisampled, so every scene looks worse against
them at one sample and that number means nothing.

Comparing native bone palettes against the browser's requires the mirror
similarity map — negate column-major indexes 1, 2, 3, 4, 8 and 12 — which
is the documented `diag(-1, 1, 1)` convention difference, not a bug.
`scene -- diff` applies that map for you in its texture-palette section;
the raw rule stays here for reading `BBLITE_DEFORMATION_DUMP` output by
hand.
