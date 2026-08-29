# Features

`bblitec` produces a scene in two phases, and every feature belongs to one of
them:

| Phase | Runs | Produces |
| --- | --- | --- |
| **Compile time** | `bblitec` on Node, during `scene -- compile`/`process` | generated C++20 and shaders, materialized assets, feature and capability lists, offline shader binaries |
| **Run time** | the native executable | loading, scene state, animation, deformation, draw submission, presentation |

The compiler is not an interpreter. Anything it cannot lower fails at
generation with a source location, so an unsupported feature is a build error
rather than a runtime one. That makes the phase of a feature the most useful
thing to know about it: a compile-time feature is fixed in the binary and can
only change by regenerating, and a run-time feature is live and can change per
frame.

This page is the supported feature set, by family. It does not carry measured
numbers — those are in [status](status.md) — nor the semantic contracts behind
individual formulas, which are in [fidelity](fidelity.md).

## Why anything is compile time

Babylon Lite is a browser engine: it fetches, decompresses, prefilters,
composes shaders, and dynamically imports feature modules while the page
loads. The native runtime has none of those services, so each one is either
performed during generation or dropped. Five forces decide it, and every
compile-time family below cites at least one:

1. **No network at run time.** A built scene opens only local files, so every
   reached URL is downloaded during generation and every `await` on an asset
   resolves immediately.
2. **No browser at run time.** Canvas2D rasterization and WebGPU compute exist
   only in a browser. Where the pinned code needs one, generation *executes*
   the pinned module in headless Chromium rather than transcribing it, which
   is exact where a transcription is an approximation.
3. **No extra run-time dependency.** Draco and meshopt decoders are WebAssembly
   modules; image codecs are libraries. Decoding at generation keeps them out
   of the executable entirely. The Dawn backend is the one exception — it
   ships a shader compiler, for the reasons in
   [stage 2](#stage-2-compiling-wgsl-for-the-device).
4. **No dynamic module loading.** Upstream's `import()`-behind-a-predicate
   feature registry has no native equivalent, so the same predicates are
   evaluated at generation. This is what preserves tree shaking: a scene that
   reaches nothing carries nothing.
5. **The answer is decided entirely by the asset or the source.** Nothing at
   run time can change a DDS file's irradiance harmonics or which material
   families a scene declares, so computing them once is not an optimization —
   it is where the information already lives.

The counterweight is as binding. **Bytes the browser produced are baked;
decisions the loader can make are not.** The sprite frame table is derived at
run time from the decoded atlas, so a changed atlas needs no compiler change.
An unset skybox size is passed through as zero for the generated loader to
resolve, rather than substituted by the compiler. Mip chains, factor texels,
and samplers are built at upload. Each of those is foldable and stays live.

## Feature map

| Feature family | Phase | Summary |
| --- | --- | --- |
| [Program compilation](#program-compilation) | Compile | the TypeScript subset, the plain-data model, browser erasure, AOT promises |
| [Feature and capability selection](#feature-and-capability-selection) | Compile | which generated modules, shader variants, codecs, and capability defines exist at all |
| [Asset materialization](#asset-materialization) | Compile | every reached remote URL downloaded into the generated tree |
| [Compressed geometry](#compressed-geometry) | Compile | Draco and meshopt decoded, quantized accessors rewritten, sparse accessors materialized, to ordinary geometry |
| [Compressed textures](#compressed-textures) | Compile → Run | which container to fetch, and a Basis file transcoded, at generation; the container parsed and its blocks uploaded at load |
| [Environment compilation](#environment-compilation) | Compile | HDR and DDS cubemaps, GGX prefiltering, SH projection, BRDF LUT |
| [Drawn and computed assets](#drawn-and-computed-assets) | Compile | canvas2D sprite atlases executed and baked to PNG, computed pixel buffers baked to RGBA |
| [Shader pipeline](#shader-pipeline) | Compile → Run | composed and specialized at generation; compiled offline for SDL_GPU, in-process by Dawn |
| [Engine, scene, and frame loop](#engine-scene-and-frame-loop) | Run | registration, fixed delta, before-render callbacks, frame gates |
| [Cameras and input](#cameras-and-input) | Run | ArcRotate/Free, default framing, orthographic opt-in, SDL controls |
| [Asset loading and upload](#asset-loading-and-upload) | Run | glTF/`.babylon`/`.env` parsing, image decode, mips, samplers |
| [Geometry and meshes](#geometry-and-meshes) | Run | primitives, typed-array meshes, thin instances, transforms |
| [Lights](#lights) | Run | directional, hemispheric, point, spot; per-mesh light sets |
| [Materials and material state](#materials-and-material-state) | Run | Standard, PBR, Grid, no-color views, alpha and extension state |
| [Node materials](#node-materials) | Compile → Run | a Babylon NME graph compiled by the pin's own emitter at generation; its draw and its blocks at run time |
| [Material plugins](#material-plugins) | Compile | a scene's own WGSL spliced into the PBR or Standard fragment by the pin's own bridges |
| [Animation playback](#animation-playback) | Run | deterministic seeking, property clips, glTF channels |
| [Deformation and instancing](#deformation-and-instancing) | Run | GPU skinning, morph targets, storage morphing, GPU instancing |
| [Sprites](#sprites) | Run | frame derivation, per-sprite instances, the pure-2D pass, world-space facing billboards, per-layer custom fragment shaders |
| [Node particles](#node-particles) | Compile | a graph's CPU simulation run by the pin at generation and its particle state baked; the billboard or pure-2D bridge that draws it is folded |
| [Physics](#physics) | Run | rigid bodies, primitive shapes, one fixed step per frame — over a substituted solver |
| [Shadows](#shadows) | Compile → Run | the receiver fragment composed per shadow-casting light at generation; the caster pass, the map and the comparison sampling at run time |
| [Frame graph](#frame-graph) | Run | render targets, tasks, geometry MRTs, blits, MSAA resolve |
| [Post-process passes](#post-process-passes) | Compile → Run | each effect's stage composed by the pin at generation; the fullscreen pass, its uniforms and its viewport at run time |
| [Fullscreen effects](#fullscreen-effects) | Compile → Run | the caller's WGSL wrapped in the pin's own vertex stage at generation; the swapchain renderer or the frame-graph task at run time |
| [Image processing](#image-processing) | Compile → Run | the tone-mapping curve composed into the PBR fragment; exposure and contrast live per frame |
| [Render backends](#render-backends) | Run | SDL_GPU, Dawn, transmission, image processing |
| [Runtime scene mutation](#runtime-scene-mutation) | Run | removal with plan rematching, material-family append, instance counts |
| [Diagnostics and capture](#diagnostics-and-capture) | Run | screenshots, benchmarks, attribution buffers |

Thirteen families have work on both sides of the line; the shader pipeline's
second stage changes phase with the backend. Where the cut falls in each is
[tabulated below](#where-the-boundary-falls-inside-a-family).

## Compile-time feature sets

### Program compilation

The reachable subset of TypeScript that lowers to C++20, from one statically
analyzable entry file against one engine.

- **Modules and functions.** Local imports and re-exports, module constants,
  dependency-ordered top-level initializers (including private state observed
  through exports and cross-module registrars),
  typed non-generic functions with defaults, lexical scopes, `if`/`else`,
  `for`/`while`, `switch` with `break`/`continue`, and `for-of`. Functions
  whose parameters and return type map entirely into the plain-data model are
  emitted once as real C++ functions; handle-touching helpers inline per call
  site. Mutually recursive plain-data functions lower as one native call-graph
  component.
- **Classes and factory records.** Reached local classes retain native identity,
  fields, constructors, methods, getters, and parameter properties; purely
  static factory records remain compile-time values and carry the scopes their
  methods close over.
- **The plain-data model.** Interface structs, `T | null` optionals, dynamic
  arrays, insertion-ordered `Map`/`Set`, `ArrayBuffer`/`DataView`,
  `Uint8Array`/`Float32Array`/`Uint16Array`/`Uint32Array`, runtime strings,
  string-literal enum tags,
  `Record<Union, T>` indexed by tag, readonly numeric tables, tuples,
  destructuring, object spread, and constant arrays materialized on demand.
  Resource handles are storable inside data. Const locals bind container
  elements as aliases; function-valued parameters inline. `Math` and the
  pinned seeded `Math.random` are available. A typed array takes `fill` and
  `set(source, offset)`, the latter for a source of the target's own kind —
  the spec converts every other source through the target's own store, and
  no reached scene writes one. A number lane inside a tuple or a static
  record is written at each sink's own width rather than at the width its
  first sink asked for ([fidelity](fidelity.md#shader-contract)).
- **Browser erasure and AOT promises.** The browser `main` wrapper, DOM,
  timing, and dataset instrumentation are erased, and every `await` on a
  materialized asset resolves immediately. `window.location.search` reads as
  the query the scene's reference pose is captured at, so a scene that
  branches on one takes the branch its golden was captured under.
  `canvas.width`/`canvas.height` lower to the engine's live drawing-buffer
  dimensions. The shared SDL event path updates them in backing-store pixels
  before application callbacks run; SDL_GPU acquires that same extent from
  the swapchain, and the reached scene-less Dawn sprite driver reconfigures
  its WebGPU surface to it before acquisition. Generation-only size decisions
  still use the configured startup dimensions because they cannot vary at
  runtime.
- **`??` over the data model.** A nullish coalesce lowers by the left
  operand's own type: a static record property still settles at compile
  time, an asset-derived handle collection resolves through its concept,
  a `T | null` optional evaluates once and selects natively with the fallback
  staying lazy exactly as JavaScript leaves it unevaluated, and a value
  the model proves non-nullish is the result with the dead fallback
  discarded. Anything outside those routes fails naming them.
- **Material tracking.** `installPbrTracking` and `installStdTracking` define
  value-preserving accessors so a later write marks the material's UBO dirty.
  Generation already emits the re-upload for every property a scene writes, so
  the installers emit nothing and the scene records
  `material-tracking-observers-dropped`. `enableMaterialTracking`, the async
  entry point that picks between them, is not reached and refuses by name.
- **Preconditions and cleanup.** A scene's own `throw new Error("...")` lowers
  to a runtime error carrying that message, which the generated `main` already
  catches and prints; a message built from state refuses, because this runtime
  holds none of what one would report. A `try` with a `finally` whose body
  erases to nothing lowers to the try block alone — that is how the corpus
  revokes an object URL and puts back a `Math.random` it replaced — and a
  `catch`, or a finalizer that emits, refuses.

**Why compile time:** this is the compiler. There is no interpreter or run-time
module loading. Values that remain compile-time records have no native
representation and cannot outlive generation; values whose identity becomes
observable materialize as shared/reference-backed native storage instead.
Static evaluation and inlining are how the remaining subset reaches C++ at all.
Each divergence this introduces is recorded per scene in
`fidelity.json` (`plain-data-value-model`, `deterministic-seeded-random`,
`entry-main-wrapper-erasure`, `synchronous-aot-await`,
`material-tracking-observers-dropped`).

### Feature and capability selection

Three generated lists decide what exists in the binary, and they answer
different questions:

| List | Source of truth | Decides |
| --- | --- | --- |
| `BBLITE_RUNTIME_FEATURES` in `features.cmake` | the scene's own TypeScript | which generated modules and PAL translation units compile |
| `render_capabilities.hpp` | the materialized assets, after specialization | transmission, deformation, morph storage, instancing, material extensions, uv2 occlusion, Standard bump and 2D reflection, image and solid-colour skyboxes, the shadow family's five defines, and the composed PBR/Standard variant counts |
| `BBLITE_IMAGE_CODECS` in `features.cmake` | the materialized assets' image types | which image decoders link and ship |

**The shadow family's defines are five, and they are not independent.** A
`#if` in either backend has to ask the right one, so the split is stated here
rather than left to be read off the guards:

| Define | True when | Gates |
| --- | --- | --- |
| `BBLITE_SHADOWS` | the scene reaches either generator | nothing under `native/`. It is the reach itself, published for the inventory and for a guard that needs the generator without either family's receiver; a scene reaching a generator that composes no receiver renders no shadow, so no `#if` has yet wanted it |
| `BBLITE_STANDARD_SHADOWS` | above, and Standard variants are composed | the Standard family's receiver bind path only |
| `BBLITE_PBR_SHADOWS` | above, and PBR variants are composed | the PBR family's receiver bind path only |
| `BBLITE_SHADOW_RECEIVERS` | the union of the two family defines | the GENERATOR half, which belongs to no family: the maps, the samplers, the receiver blocks, the caster pass, its standard-Z depth state, the per-frame matrix update and the release path |
| `BBLITE_SHADOWS_ESM` | `shadow:esm`, and Standard variants are composed | the ESM generator's own four textures and separable blur. Still a Standard conjunction because what it gates includes the caster's own material view, and only the Standard family has one |

The union is emitted as one — `#define BBLITE_SHADOW_RECEIVERS
(BBLITE_STANDARD_SHADOWS || BBLITE_PBR_SHADOWS)` — so the containment is
visible to whoever writes a guard, and a helper's guard checks against its
callers' by reading. All five come from one `shadowCapabilities` record,
which the activation inventory then checks against its own derivation from
the reached features — a check only while the two stay different expressions.

The feature list is finalized during compilation, before remote assets
materialize, with two exceptions joined afterwards: an asset's own lights
(glTF `KHR_lights_punctual` kinds, `.babylon` point lights) and
`EXT_lights_image_based` become `light:*` and `environment:ibl` features,
because light features select `light_*.cpp` translation units and only the
feature list can. Every other capability an asset reaches without the source
naming it lives in the capability header — scene transmission being the
standing example, since Babylon Lite enables it from any transmissive
material a loaded asset carries. Every activation across all mechanisms is
recorded per scene in `upstream/feature-activation.json`, with the first
reaching call site or asset and the pinned module each unit mirrors.

The rule that decides which mechanism owns a feature: a runtime feature
exists for API the scene's own source can reach, and a capability exists for
what assets decide. An extension family with a scene-code setter therefore
has both (clearcoat, sheen and iridescence are feature-or-capability), and one
without a setter has only the capability (dispersion, and the spec-gloss
workflow replacement, which no scene API reaches at all).

**Why compile time:** with no dynamic module loading, upstream's own
`import()`-behind-a-predicate boundaries must resolve somewhere, and
generation is the only place that sees both the source and the assets. The
asset specializer mirrors upstream's predicates directly, which keeps a
capability upstream holds off its core path from becoming unconditional here.
It is also the whole of tree shaking: a scene reaching no skins emits no
skinning code, no deformation vertex layout and no matching shader variant.

### Asset materialization

Every remote URL the scene reaches is downloaded into
`generated/<scene>/assets` and rewritten to a deterministic local read: glTF
and GLB with their external buffers and images, `.babylon` scenes with their
textures, `.env`/`.hdr`/`.dds` environments, PNG/JPEG/WebP images, cubemap
faces, and the pinned BRDF LUT.

A `data:` URL is the one source that names no location: its bytes are in the
scene's own text, so materializing it is a decode rather than a download, and
what it packages under is derived from its media type. Upstream draws no
distinction — `fetch` serves a data URL from the string — which is why nothing
in the pinned loaders marks the case. The generated manifest records a
content-addressed opaque source identity rather than duplicating the base64
payload; generation keeps the URL in-process until the asset is decoded. Only
the base64 form is read; a percent-encoded body refuses rather than decoding
through a second path.

**Why compile time:** the native runtime has no network stack and no
asynchronous scheduler, while every Babylon Lite loader is `fetch`-based. A
built scene opens only local files, and the awaits that fetched them resolve
immediately. Recorded per scene as `compile-time-asset-materialization`
alongside `synchronous-aot-await`.

### Compressed geometry

`KHR_draco_mesh_compression` and `EXT_meshopt_compression` are decoded during
generation; what ships is ordinary uncompressed geometry, and an asset using
neither is passed through byte-for-byte.

**Why compile time:** both decoders are WebAssembly modules the browser
fetches at run time. Decoding during generation keeps the native runtime free
of a decompression dependency, and because the pinned artifacts are part of
the upstream pin, the browser reference and this pass run *the same decoder
build over the same bytes* — the vertices agree by construction rather than by
argument.

Sparse accessors resolve in the same pass, and they are core glTF rather than
an extension: an accessor's value array is a base — its `bufferView`, or all
zeros when it has none — plus a compact list of `(index, value)` overrides.
The pin's own `preParse` hook materializes each one into a freshly appended
tightly-packed bufferView of the same component type and deletes `.sparse`, so
every downstream consumer — geometry, animation, morph, skeleton, instancing —
sees an ordinary bufferView-backed accessor. Generation runs that module, and
the specializer then refuses a packaged document that still carries one, which
is how a document produced by anything but this pass is named rather than
silently read at its unpatched base values.

`KHR_mesh_quantization` resolves in the same pass and for the same reason, by
an easier route: the extension *is* one pinned `preParse` hook, which rewrites
every quantized accessor — signed, normalized, strided, or the unnormalized
unsigned POSITION/TEXCOORD storage gltfpack emits — into a freshly appended
tightly-packed FLOAT bufferView. It touches only the document and its binary
chunk, with no browser API in it, so generation runs the pin's own module
rather than reimplementing the conversion and the packaged asset drops the
extension. Upstream imports that module only when `extensionsUsed` lists it,
which is the boundary this pass keeps.

All three run in the pinned registry's own order — meshopt, then sparse, then
quantization — because each reads what the one before it wrote: a sparse base
may live in a decompressed bufferView, and a meshopt-filtered animation output
is itself quantized data the last hook has to see.

### Compressed textures

A `.ktx` container and a `.basis` file both end at the same place — GPU
blocks and the mip chain the file carries, uploaded with nothing decoded and
nothing generated — but they divide across the two phases differently, and
the split is the same one `.env` and `.hdr` already take.

- **A KTX1 container is parsed at load.** It already holds blocks and its own
  chain, so there is no browser work to reproduce: the pinned parser is
  lowered to C++ and runs at startup, resolving the file's `glInternalFormat`
  against the pin's own format table.
- **Which container to fetch is decided at generation.** `loadKtxTexture2D`
  takes a base URL and a suffix list, keeps the suffixes whose compressed
  format the *device* reports, and tries them in order — a run-time question
  a native build cannot ask, so generation answers it once with block
  compression, the format the validated platform and the browser reference
  both report ([fidelity](fidelity.md#shader-contract)). A call listing no
  block-compression suffix refuses rather than packaging the pin's
  uncompressed fallback, which is a different texture; a device that cannot
  sample the packaged format refuses it by name at upload, on both backends.
- **A Basis file is transcoded at generation**, and is the one texture whose
  bytes the browser produces. Its transcoder is a JavaScript+WebAssembly
  module the page injects with a `<script>` tag, and the format it transcodes
  *into* is another device question. So generation runs the pinned loader in
  headless Chromium and packages what it uploaded, as a KTX1 container — the
  runtime already reads one, so the transcode needs no second reader.
  Recorded per scene as `executed-basis-transcode`; the baked bytes depend on
  the Chrome that compiled them, exactly as the drawn atlas does.

The texture object's own `invertY` travels with it either way — a UV-block
flip rather than an upload flip, which is what keeps a compressed texture
correct where an in-place row swap is impossible. `loadBasisTexture2D` sets
it and `loadKtxTexture2D` does not ([fidelity](fidelity.md#shader-contract)
carries the contract).

Neither loader's sampler options are lowered, because the reached calls pass
none. A `loadKtxTexture2D` whose suffixes are not an array literal fails at
generation, as does a KTX file whose `glInternalFormat` is outside the pin's
table. KTX2 — the container `KHR_texture_basisu` redirects a glTF texture to —
needs the pin's second decoder and is unreached.

### Environment compilation

Three environment routes exist and they do not split the same way:

- **HDR (`.hdr`)** is compiled completely. Generation parses RGBE, projects
  the cubemap, and runs the pinned 1024-sample GGX prefilter as the pinned
  WebGPU compute shader in headless Chromium, emitting one package with mip
  zero preserved. *Why:* prefiltering is a GPU compute pass over the whole
  cubemap; executing the pinned shader is exact where a CPU transcription is
  not, and the runtime then reads a package instead of running a compute pass
  at startup. Recorded as `compile-time-hdr-cubemap`.
- **DDS** is compiled to the same package. The file's face-major mip chain is
  transposed to mip-major and the nine irradiance harmonics are projected out
  of mip 0, each texel weighted by the solid angle it subtends. *Why:* both
  halves are decided entirely by the asset, so nothing at run time can change
  them; the projected floats are bit-identical to the ones the browser
  uploads.
- **`.env` is deliberately not compiled.** It already carries a prefiltered
  mip chain and its harmonics, so there is no browser work to reproduce: the
  pinned parser is lowered to C++ and runs at load like any other loader.

The `EXT_lights_image_based` BRDF LUT is also integrated offline — 256 square,
1024 samples, emitted as `rgba16f` — because it is a fixed integration with no
scene input.

### Drawn and computed assets

An asset a scene module *produces* rather than fetches is executed at
generation: the module is served from a local server, its zero-argument
export is called in headless Chromium, and what it returned is baked. Two
kinds reach this — a drawn sprite atlas, and a computed pixel buffer.

**Why the atlas is compile time:** there is no file to download and no
formula to port — its canvas2D pixels are a browser rasterizer's
antialiasing rather than an expression
([fidelity](fidelity.md#shader-contract) carries the execution recipe).
Recorded per scene as `drawn-sprite-atlas`. The frame grid is **not** baked
with it — see
[the boundary table](#where-the-boundary-falls-inside-a-family).

**Why a pixel buffer is compile time**, a larger adaptation recorded
separately as `computed-pixel-buffer`: those bytes *are* an expression, so
unlike the atlas they are portable in principle. Two facts stand against it.
The function is not lowerable in THIS compiler: the module memoizes through
a module-level binding the data model does not carry. And the value is fragile: three of the palette's 768 channel values
land 2.8e-14 below a rounding boundary, one ulp of `sin`, so a reassociated
expression or a different rounding rule flips an entry and with it a pixel.
Executing it under the engine the golden runs in makes the result checkable
by parity measurement, and the scenes measure byte-identical.

Both share the HDR prefilter's tradeoff: the baked bytes depend on the Chrome
that compiled them.

### Node particles

A Node Particle Editor graph is a CPU simulation, and a corpus scene runs it
to a fixed frame before the first render: it seeds `Math.random` itself,
steps `animateParticleSystem` a couple of hundred times, and synchronizes the
result into a camera-facing billboard system. What ships is that frozen
state.

**The simulation is executed, not lowered** — the strongest case of the
executed kind in this repository: the graph build is JavaScript closures
(one dynamically imported evaluator per block class), and the seed each
scene installs draws through `Math.sin`, which is not bit-portable between
V8 and a native maths library. So generation runs the pin's own parser,
builder and simulation in headless Chromium and bakes the particle buffer.
Recorded per scene as `executed-node-particle-simulation`; the baked state
depends on the Chrome that ran it, exactly as the drawn atlas and the
pinned GGX prefilter do. [Fidelity](fidelity.md#shader-contract) carries
the full rationale and each downstream fold's contract.

**What stays folded is everything downstream**, on both render targets.
`createParticleBillboard` and `syncParticleBillboard` are lowered from
their own pinned declarations, so the generated scene builds the billboard
system the pin would have built and writes the sprites the pin would have
written; from there it is an ordinary facing-billboard scene. The driver
holds the scene state the pin reads while it builds — the graph, the
emitter, the texture base URL, and the **camera**, because
`UpdateFlowMapBlock` derives a view-projection during the build.

**Two render targets, and the exact blends on both.** A frozen set draws
either as camera-facing billboards or through the pure-2D Sprite2D bridge,
and each has a plain mapping and an exact one: the plain builders map three
Babylon blend modes and degrade the rest, while
`enableNodeParticleBlendModes` and
`registerNodeParticleSet2DWithBlendModes` resolve all five — mode 4 as two
passes over one renderable on the billboard path, and as two equal-order
layers the renderer's stable sort keeps adjacent on the pure-2D one.

**A registered set is folded, and the fold is measured**: the driver steps
each registered system's state once more and compares every column the sync
reads, refusing a registration whose system still moves or whose
`updateSpeed` is not zero. **A particle buffer is generation-time state**: a
scene that writes a column after the freeze, or checks the live count, is
editing or asserting about the bake, so both move to the driver and emit
nothing.

What refuses at generation, by name: a snippet id (a network read at page
load), a live set (one whose per-frame step moves particles), a system
stepped or synced twice, `parseNodeParticleSetFromSnippet`, and a flow-map
build whose scene camera is not a static arc-rotate construction.

### Shader pipeline

This family has two stages, and only the first has a single answer. **Where
WGSL is *compiled* depends on the backend — and the backend set is itself a
compile-time choice (`BBLITE_BACKEND`), so even the phase of this feature is
decided at generation.**

#### Stage 1: composition and specialization

**Compile time, both backends.** All native GPU shaders originate as WGSL,
composed per scene from the pinned sources: the Standard and PBR variants the
pin's own composer builds, the shared material vertex stage, Grid, background
ground and skybox, geometry MRT outputs, frame-graph blit and depth, and the
sprite pair. The pin-composed variants deploy with the pin's own
`@group`/`@binding` scheme unchanged — SDL_GPU re-addresses them later,
during HLSL register normalization — while the remaining stages are
specialized for SDL bindings, locations, and depth at generation; either way
the deployed text is `*.native.wgsl`, checked against Tint's binding
reflection, with custom uniform writes resolved to reflected byte
offsets. Scene-local custom shaders enter the same stage from the entry file's
own WGSL through the typed shader IR — parse, validate, reflect, re-emit — with
pipeline state from the pinned mapping. Every family originates as WGSL: no
HLSL or MSL source templates remain under `src/`.

**Why compile time:** Babylon Lite composes WGSL per material at run time
through its own composer, and there is no native equivalent — the composer is
executed at generation instead, so the variant set is one answer per scene,
the same tree-shaking question as feature selection.
Both backends consume this stage's output unchanged: Dawn reads the same
deployed `.native.wgsl`, whose `@group` scheme maps onto WebGPU
natively.

#### Stage 2: compiling WGSL for the device

**Compile time on SDL_GPU, run time on Dawn** — a *phase* difference, not a
toolchain difference. `upstream/tint.json` pins the Dawn repository, and the
standalone Tint CLI and the Dawn library are built from that one commit, so
the same compiler runs in both paths: either as an offline tool or inside the
process.

| | SDL_GPU | Dawn |
| --- | --- | --- |
| WGSL compiled | offline, during generation | in-process, at startup, as shader modules and pipelines are created |
| Toolchain | pinned Tint CLI → target-selected HLSL/MSL; normalized HLSL → DXC → selected DXIL/SPIR-V | Dawn's embedded Tint → HLSL → its own built DXC → DXIL |
| Artifacts | the selected `.dxil`, `.spv`, or `.msl` deployed beside the executable | none — the `.native.wgsl` text ships instead |
| Cache | `artifacts/shader-cache`, content-addressed, reused across scenes | none |
| Runtime payload | no compiler | `webgpu_dawn.dll`, Dawn's own `dxcompiler.dll`, and Dawn's selected Windows SDK `dxil.dll` |
| Startup | no shader work | first-frame compile cost |
| A new platform costs | its own offline path, one per target | nothing — Dawn's Tint emits HLSL, SPIR-V, or MSL itself |

The SDL_GPU offline paths:

| Target | Offline path |
| --- | --- |
| D3D12 | WGSL → Tint HLSL → normalized registers/signatures → DXC DXIL |
| Vulkan | WGSL → Tint HLSL → normalization → DXC SPIR-V |
| Metal | WGSL → Tint MSL |

Processing defaults to the current host's one target; `--shader all` is an
explicit cross-target compiler check. Switching target also removes stale
non-target artifacts, so deployment cannot accidentally hide a missing
compile behind a previous `all` run.

Tint *can* emit SPIR-V directly, but its separate WGSL texture and sampler
binding numbers do not satisfy SDL_GPU's dense corresponding-slot contract, so
Vulkan temporarily recompiles normalized Tint HLSL through DXC pending a
verified binding remap. Only D3D12 is device-validated
([boundaries](#platform-validation)). Dawn bypasses this table entirely.

**Why SDL_GPU's half must be compile time:** D3D12, Vulkan, and Metal consume
DXIL, SPIR-V, and MSL, and SDL_GPU carries no shader compiler at all, so those
binaries have to exist before the executable runs. DXC cannot be dropped from
the D3D12 path either, because Tint does not emit DXIL.

**Why Dawn's half is run time:** Dawn carries Tint and DXC *inside* it — the
components the offline path invokes as tools — so compiling at startup is the
parity mechanism: the goldens came from that stack, and running it in-process
removes the offline-versus-browser compile split rather than adapting to it.
Dawn is bit-exact on scenes where SDL_GPU carries DXC-versus-browser
rounding. That compiler's identity is measurable: a Dawn built without
`DAWN_USE_BUILT_DXC` falls back to FXC and carries a systemic one-LSB error
on lit surfaces, which DXC does not.

**What a custom shader variant may reach.** The supported WGSL subset plus
the `world`, `view`, `projection`, `viewProjection` and `worldViewProjection`
system uniforms, which head a stage's block in declaration order — `view` and
`projection` are the two factors of the product the pass already built,
carried beside it so the three cannot come from two cameras. The pin's other
four (`worldView`, `cameraPosition`, `screenSize`, `alphaCutoff`),
matrix-valued custom uniforms, and a stage reading both a system and a custom
uniform all refuse. A sampler is named by a string and binds a 2D float
texture from `loadTexture2D` in the fragment stage: a typed
`ShaderSamplerDecl`, a depth or comparison sampler, a `2d-array` view, a
sampler the vertex stage reads (SDL_GPU gives a vertex texture its own
register space), a fifth sampler (the fifth pair of the shared mesh texture
group is the reflection cube), a texture from any other loader, and storage
buffers each fail by name.

## Run-time feature sets

### Engine, scene, and frame loop

Engine creation, scene creation and registration, fixed delta timing,
before-render callbacks, and the frame conductor both backends share: the
runtime flag matrix, the capture gate that decides when a run may stop
(including the bounded grace a deferred capture needs), and the clock the
scene callbacks advance by.

An application-owned `requestAnimationFrame` loop registers its callback on
that same conductor, including a scene-less sprite application. Its timestamp
comes from the PAL's browser-facing `performance.now()` clock: monotonic in an
interactive run and advanced by the measured fixed delta in a capture, with
JavaScript-number/double precision retained through the callback. The first
engine frame receives a zero delta. Registration order remains the browser's
phase boundary: callbacks installed before `startEngine` update before its
renderer; callbacks installed after awaiting `startEngine` run after the
renderer and affect the following frame. The application may schedule itself
again without growing the callback list. Browser `setInterval`/`clearInterval`
are the recurring-timer arm of the same conductor: callbacks become due from
that monotonic clock and run at the frame boundary, with no independent timer
thread racing application state.

### Cameras and input

ArcRotate and Free cameras, default framing, target assignment and reads,
per-frame clamping of the reached properties, and the `enableOrthographicCamera`
opt-in with its aspect-derived view volume. SDL provides the platform
boundary: left-drag orbit, right/middle-drag pan, and wheel zoom for ArcRotate;
Free cameras additionally take `WASD`/arrows plus `Space`/`Shift`.
Application window listeners use the same event bridge in scene, sprite,
effect, and frame-graph executables. SDL scancodes become DOM-compatible
`KeyboardEvent.code`/`key` pairs (`Space`/`" "` included), pointer button
events and visibility changes reach their registered callbacks, and no
scene-less driver may silently consume those events as window management.

### Asset loading and upload

Everything the browser would do while the page loads, minus what was already
compiled away:

- glTF/GLB parsing and typed loading — nodes, meshes, primitives, accessors,
  materials, skins, animation channels, and the reached extensions.
- `.babylon` parsing, including its material and texture slots and each
  light's included/excluded mesh lists.
- `.env` container parsing and RGBD cubemap decoding.
- Image decoding through the codecs the scene links, GPU mip-chain generation
  on both backends, sampler construction from the glTF sampler modes, and
  upload under the sRGB/linear/RGBD conventions.
- Load-time folds the pinned engine also performs: primitives without normals
  are deindexed with face normals baked in, triangle strips expand to the
  triangle list they describe, `KHR_node_visibility` cascades into each mesh
  record, and texture-less PBR factors bake into 1x1 texels. Points, lines and
  line strips are *not* folded: they describe primitives no triangle list can,
  so each reaches the pipeline as its own topology, at the fixed-function
  state `buildPrimitiveState` gives it.
- `KHR_materials_variants`: the loader reads each primitive's mappings and the
  document's variant order, and draws the material the scene's one static
  `selectVariant` name resolves to. Only that name is compiled in, and every
  shape the fold cannot represent — a second differing selection, a selection
  on a second asset, one made from a frame callback, `getVariantNames`,
  `resetVariant` — refuses at generation
  ([fidelity](fidelity.md#semantic-contract)).

`loadSplat` loads a Gaussian-splat cloud, split across the two halves of the
pipeline the way each half is best at:

- The **container parse runs at generation**. A `.ply` header is a
  per-exporter property list, so what must not drift is the parsed value
  rather than the parser's shape, and only the pin's own parser can promise
  that. What is packaged is the 32-byte-per-splat row buffer — upstream's own
  `.splat` files are that buffer written to disk, so a `.ply` scene and a
  `.splat` scene package to the same bytes and the runtime reads one layout.
- The **geometry build and the depth sort are folded** from their pinned
  declarations: the rotate-then-scale covariance whose six unique entries
  become two RGB triples, and the uniform-key counting sort that puts splats
  in back-to-front order for the alpha-combine blend. Both are fixed math over
  a fixed layout, where the shape is the contract.
- The **projection is the pin's own WGSL**, extracted from the bundle rather
  than transcribed, and split into a stage per file. The four data textures
  are sampled in the vertex stage; the stock fragment stage reads only
  varyings.
- The **shader plugins are spliced by the pin's own splicer**, at generation.
  `loadSplat`'s third argument is a list of `GsShaderFragment` records — pure
  data, either one of `gs-depth-fragments.ts`'s own exports or a record the
  scene declares — and `applyGsFragments` both concatenates their slots and
  runs a field-name mangler over the whole result, so it is executed rather
  than reimplemented ([fidelity](fidelity.md#shader-contract)). The call
  passing the list is the opt-in, which is where upstream puts it too: it
  inlines that mangling table so a plugin-free scene tree-shakes it away.
  A plugin body may read the pin's own uniform block, which is the one
  resource its bind-group layout offers the fragment stage.

A cloud is a `SceneNode` upstream, so its world matrix composes from its own
TRS through the same emitted composition a thin-instanced mesh's parent world
takes, and the reached slice writes all three of its lanes.

`bakeCurrentTransformIntoVertices` then rewrites the cloud so that world
matrix is no longer needed: every splat's position, scale and packed
quaternion move through it, the geometry is rebuilt from the rewritten rows,
and the TRS resets to the identity. It is **folded** like the geometry build
beside it -- fixed math over the fixed row layout -- and it is the one entry
point that reads the packaged rows back, so the loader retains them for a
scene that reaches it and drops them otherwise
([fidelity](fidelity.md#shader-contract) carries the Euler-proxy rule the
reset turns on).

The reached slice is the plain `.ply` and `.splat` row layout. A compressed or
spherical-harmonic PLY refuses at generation, because it needs the pin's second
parser and its own SH pipeline; `.sog` and `.spz` need a ZIP and a gzip decoder
first. The sort runs on the frame's own thread before the draw that reads it
rather than in a worker, which is the state `mesh.firstSortReady` waits for
([fidelity](fidelity.md#semantic-contract)).

### Geometry and meshes

Box, sphere, subdivided ground, heightmap-displaced ground, plane, torus,
and tube primitives;
`createMeshFromData` typed-array meshes; indexed glTF/GLB and `.babylon`
geometry; every glTF primitive mode WebGPU has a topology for — triangle list,
triangle strip, points, lines and line strip; generated and
flat normals; negative transforms; and fixed-capacity thin-instance pools —
the capacity is established when the pool is set and the matrix array stays
aliased, so flush and count updates re-read it per frame. An array the caller
builds at the call site is bound to a name first, because the pool keeps
referencing it for the whole frame loop; one built inside a block refuses,
since the binding would not outlive it.

`createGroundFromHeightMap` is the flat ground builder plus the pin's
displacement pass, both lowered from their own bodies: the grid's Y is
displaced by the image's weighted luminance, the normals rebuilt from
per-face cross products, and the arrays handed to `create_mesh_from_data` as
the pinned wrapper hands them over. The image is packaged and decoded like
any other — which is where a greyscale PNG arrived a level dark, because
SDL_image synthesises a palette-less PNG's ramp as `(i * 255) / ncolors`
rather than dividing by the last index. The PAL rebuilds that ramp only where
the file carries no `PLTE`, the one case where the correct ramp is derivable
rather than guessed.

`createTube` is lowered from its pinned chain — a circle swept along
`computePath3D`'s Frenet frames by Rodrigues rotation, triangulated by the
ribbon builder with computed normals — every formula shape-asserted against
the pinned AST and finished through `create_mesh_from_data`, so the only
float rounding is the pin's typed-array store. The reached slice is a
multi-point path with explicit `radius` and `tessellation`; `cap`, `arc`,
`radiusFunction`, an instance to update and a single-point path refuse by
name, and the pinned defaults making the dropped arms unreachable (cap
`NONE`, arc `1`) are anchored rather than assumed.

**The rest of the builder family** — `createCylinder` (cylinders, cones,
truncated cones), `createDisc` (discs and pie slices), `createPolyhedron`,
`createRibbon` and `createExtrudeShape` — is lowered from each pinned body by
the same translator, all byte-exact against the browser on scene 38. What
separates them from the five that shipped earlier is storage: those
preallocate a typed array and store into it, while these GROW a `number[]`
and convert at the end, which is where their float rounding happens. The
translator therefore gained a growable list (`push`, `length`, indexing, and
the `new F32(list)` that rounds it), a jagged list of lists, the pin's
`{x, y, z}` record as a value, and a local helper closure written out at each
call site — which is how `createCap(false)` and `createCap(true)` fold their
`isTop` the way the pin would have written both bodies out.

Two resolve at generation. The polyhedron's `POLYHEDRA` table is data and the
`type` a scene names is a compile-time index, so one polyhedron costs one
table rather than fifteen. And a builder option is resolved from the
factory's own `??` before the call, binding each option to the present arm —
the specialization the shadow generators take, read from the pin rather than
restated. `createExtrudeShape` reuses the tube's frames and Rodrigues
rotation and finishes through the ribbon under its own mesh name, as the pin
composes it. `cap` refuses by name, as does a zero `diameter` that never
named which end the cone belongs to: the pin asks `options.diameterTop === 0`
of the NAMED option, so a zero arriving through the shorthand would take an
arm the pin does not.

A **line system** is one of those meshes rather than a renderer of its own:
`createLineSystem` concatenates its polylines into a single indexed mesh — an
index pair per segment, nothing joining one line to the next — drawn with the
`ShaderMaterial` `createLineMaterial` builds, whose `_topology` is
`"line-list"`. The flatten's asserted rules and the composed program are the
pin's own ([fidelity](fidelity.md#shader-contract)); everything after is the
shader-material path. `updateLineSystem` rewrites positions and colours over
unchanged connectivity (a changed line or point count refuses, as upstream
throws), and `setThinInstanceColors` binds the per-instance RGBA stream a
material created with `useThinInstanceColors` reads, at the pin's own colour
precedence: vertex colours, instance colours, their product, or the
`lineColor` uniform. `createLines`, `createDashedLines`, `updateDashedLines`
and `setLineMaterialColor` refuse by name, as does a line system whose
material's vertex-colour setting disagrees with its geometry.

### Scene hierarchy

`createTransformNode` is a scene-graph node with a TRS and children, and a
mesh assigned `mesh.parent = node` composes its world through it —
`world = parent.worldMatrix * local`, walked to the root, exactly as
`createWorldMatrixState` resolves it. Upstream a `TransformNode` is a pure
alias for `SceneNode`, so a node's local matrix is the same
`composeTrsLocalMatrix` a mesh's is and one emitted composition serves both.

Two halves stay apart because the pin keeps them apart: writing
`child.parent` registers the child for invalidation and drives the
transform math, while `node.children.push(child)` fills the traversal list
and nothing else. An in-engine hierarchy is push-based upstream — a TRS
write reaches `markLocalDirty`, which recurses into the children the
parent setter registered — so this port pushes at the same setters: each
bumps the transform version of every mesh under the node, which is what
every re-bake already keys on. (The pin's version snapshot is its
*foreign*-parent fallback, for a host it cannot tag; a mesh under a
transform node is tagged on both ends and never takes it.)

`enableMirroredMeshes(scene)` is the opt-in that adds winding reversal from
the live world determinant. The Standard pipeline has none of its own
upstream, which is why the pin installs a primitive resolver for it, and
this port composes the family's clockwise arms only under the same opt-in.
A mesh mirrored before its renderable was built carries the winding from
the first frame; one mirrored later flips its pipeline through a plan
rebuild, which is where this port chooses a front face. The opt-in seeds
every mesh present and then appends its watcher to the scene's own
before-render list, exactly as `installMirroredMeshSupport` does, so the
frame position is the pin's rather than a rule spelled in each backend. The PBR family
gets no back-culled twin: the glTF loader rewinds a single-sided mirrored
primitive's indices at load instead.

`setParent`, a matrix-declared node's reparent, and a recursive
`SceneNode.children` walk are not reached; scene 269 is the scene behind
them ([TODO](../TODO.md)).

### Lights

Directional, hemispheric, point, and spot lights with diffuse and specular
colours. Light count, kind dispatch and the per-mesh light sets an asset names
are run-time UBO data rather than composition keys; the pin's own loop over its
own entries is in [fidelity](fidelity.md#lights). Spot cones shade under the
cosine-and-exponent falloff on Standard surfaces and the physical falloff in
the PBR extra lights. PBR carries two analytic slots in single-light mode;
under multi-light the second is deliberately empty and every light past the
primary is walked over the same lights buffer.

A scene-code spot light's colours, intensity and cone are all settable after
creation. `range` and `exponent` are plain number fields on the pinned light,
so each write is one record store; `angle` is the family's one accessor, whose
setter recomputes the cone cosine `_writeLightUbo` packs, so the write goes
through an emitted entry point that stores the pair from the pin's own
`Math.cos(angle * 0.5)`. A point or directional light's
`position`, and a spot light's `position` and `direction`, are settable after
creation through the pin's own `ObservableVec3` semantics — whole-vector and
reached point component writes both rebuild that kind's local matrix, and
vectors no reached scene writes fail by name.

### Materials and material state

Standard, PBR and GridMaterial records, no-colour material views, Standard
cotangent-frame normal maps, PBR vertex colours and the Standard RGB ones
behind `enableStandardVertexColors`, the opt-in `setPbrUnlit`, `setPbrSkybox`,
`setPbrEmissive`, `setPbrClearCoat`, `setPbrSheen`, `setPbrIridescence`,
`setPbrAnisotropy`, `setPbrGammaAlbedo` and the reached `setPbrSubsurface`
translucency/thickness shape, plus scene-local custom shader variants driven
through their reflected uniform offsets. Scene-code PBR also carries the
static `enableSpecularAA` and `usePhysicalLightFalloff` creation options into
the pin's derivative roughness arm and its punctual falloff lane, the second
of which is also writable afterwards — it selects a punctual arm per draw and
composes nothing, so a write is the same record store the option fills, on a
material a scene may have read back off a mesh. A setter
stamps the material the call names, so a scene carrying several scene-code
materials reaches each independently.

Each glTF texture slot samples the UV set its own `textureInfo` selects —
base colour, metallic-roughness, normal, emissive, spec-gloss and occlusion —
through the pin's per-channel uv2 mask, and through
`KHR_texture_transform.texCoord` where a transform overrides the slot's own.
The mask composes into the fragment rather than uploading, so the loader
carries only what a UV set cannot express: the dedicated occlusion pair a
TEXCOORD_1 occlusion binds, and the second ORM sample the orm-unpack split
takes at occlusion's own transform.

A Standard `diffuseTexture` takes three sources, because upstream has one
`Texture2D` whatever built it. A colour render target is how one pass
displays another's output: the pin hands the attachment back carrying
`invertY: true`, so the slot samples V-flipped through the material's UV
block (the flip contract is in [fidelity](fidelity.md#shader-contract)). A
`createTexture2DFromPixels` texture copies its texels, sampler and
texture-object properties across, and the already-decoded arm of the shared
upload reads them through. A loaded image — ordinary, KTX or transcoded Basis
— travels whole, because the sampler, the upload flip and the texture-object
`invertY` the UV block reads belong to the texture, not the slot.
`setStandardEmissiveTexture` takes an image too, and the composed variant
follows: only a render target carries the pin's `_sampleType === "depth"`,
which selects the extension's unfilterable-float binding. Three sources
refuse by name with a source location: a depth-only render target (wrong
*aspect* — that arm takes the opposite flip and a different sampler), a
geometry task's attachment (wrong *source*, owned by a pass), and an image
setting its own `srgb` option (wrong *encoding*, which is the family's).

`enableMaterialUvTransform(material)` marks a hand-built Standard material
for independent per-texture transforms — the pin's opt-in for its ninth
Standard extension. The mark is the whole native contract: it is what
`stdUvTransformExt._meshFeatures` reads back, so it joins the variant key,
and the extension's uniform block (a 2x2 matrix plus translation per channel,
in the pin's fixed diffuse/emissive/bump/specular/ambient/lightmap/opacity
order) is filled by that module's own writer over the `uScale`, `vScale`,
`uOffset`, `vOffset`, `uAng` and `invertY` the scene wrote. A material
nothing marks composes exactly what it did before.

A shader material also takes the two remaining halves of its own program.
Its `samplers` become the pin's own `<name>` / `<name>Sampler` pair, every
one declared as the pin declares it and re-homed into this backend's
fragment texture group, bound per material by `setShaderTexture`. Which
pairs the compiled stage keeps, and at which registers, is the caller's own
WGSL to decide — a sampler read only inside a branch a define folds away is
dropped — so SDL_GPU binds by the `.slots` sidecar and Dawn by the deployed
WGSL's declared order
([backends](backends.md#dawn-backend-architecture-nativesrcpal_dawncpp)
owns the sidecar contract). Its `defines` become the module-scope
WGSL `const` declarations the pin's own prelude writes — WGSL has no
preprocessor, so a define is a constant the shader compiler folds a branch
against, and the set is part of the program's identity rather than per-draw
state. Shader geometry remains in local space: `world` and
`worldViewProjection` are bound per draw, so transform-only animation changes
uniform data rather than rebuilding a vertex buffer. Exact repeated shader
geometries share immutable vertex/index buffers across dynamic mesh entries;
generated PBR/Standard texture lanes and globally compiled instance streams
are not allocated for a custom-shader draw that does not consume them.

A shader material also states the primitive its pipeline is built at. The
pin resolves `material._topology ?? "triangle-list"` inside its own pipeline
builder and keys its cache on it, so the topology travels with the program
rather than with a draw; the line family is the one reached material that
names the second one, and both backends translate the same generated
enumerator.

Two shader materials come from the pin rather than from scene WGSL, and both
are folded out of the factory that builds them: `createLineMaterial`, and
`createLinearDepthMaterial`, whose stage writes `(viewZ - near) / (far -
near)` from the `view` and `projection` system uniforms and carries the
caller's plane pair as the one custom uniform's default. The planes are part
of the variant's identity here, because this port keeps a uniform default on
the variant where the pin keeps a slot on each material.

A PBR material also states two things about how its albedo and its punctual
lights are read. `setPbrGammaAlbedo` is the pin's opt-in sRGB decode: the
extension contributes one feature bit and the base template's own
`pow(baseColorSample.rgb, 2.2)` block, with no fragment slot, UBO field or
binding of its own — so it is composition input and nothing else, and the
image it decodes is loaded in a linear format because the encoding travels
with the texture rather than with the slot (`loadTexture2D`'s `srgb` option
picks the format upstream keeps on the `Texture2D`). `usePhysicalLightFalloff`
is the opposite shape: every composed punctual arm carries both the physical
inverse-square falloff and the Standard-style linear range with its spot
exponent, and the material UBO's `lightFalloffMode` lane selects one per draw.

Material state written and read per frame: alpha mask/blend/coverage,
reflectance, emissive strength, lighting intensities, double-sided, normal
scale, shared texture scaling, the punctual falloff mode, transmission, IOR,
volume, dispersion, clearcoat, sheen, iridescence, anisotropy, and the
`KHR_materials_pbrSpecularGlossiness` workflow replacement.

### Node materials

A node material is a graph, not a shader. `parseNodeMaterialFromSnippet`
parses a Babylon NME document, walks it from its two output blocks through one
emitter per block class, and wraps the two bodies into the module the browser
compiles — over a hundred emitters, which are the graph's semantics rather
than a formula to restate.

**Compile time: the whole compiler.** Generation runs that entry point against
a recording device, so what deploys is the module the pin built for this
graph: its WGSL, the layout of the uniform block its named inputs produced,
the vertex inputs it declares, and its cull state, with the block's bytes
folded from the graph's own defaults.

Two routes reach a graph, because the corpus writes them both ways. A module
exporting the document as a literal is read as data — the fold, and the one
to prefer, since a literal cannot drift. A module that *builds* its graph at
load from id counters, spread-composed inputs and pushed arrays is code this
compiler does not lower, so it is executed under Node instead. Why under Node
rather than headless Chromium, and the fold contracts, are in
[fidelity](fidelity.md#shader-contract).

**Run time: the draw.** A node draw binds the pin's own group scheme — the
per-pass scene block and lights in group 0, the graph's mesh block and uniform
block in group 1 — and both backends execute the compiled stages, entered at
the pin's own `vs_main`/`fs_main`.

The reached slice covers the scene's lights and its environment, both
resources the port already holds for the material families — the lights array
at the group-0 slot all three composed families share, and the specular cube
and BRDF LUT the pin's `node-env.ts` binds from the scene's
`EnvironmentTextures` — so a graph reaching them declares bindings rather than
needing anything new. The five PBR layer blocks (clearcoat, sheen, anisotropy,
iridescence, subsurface) declare nothing: each changes what
`PBRMetallicRoughnessBlock` composes, and the module binds the same resources
either way.

`FragDepthBlock` composes too: a graph writing `@builtin(frag_depth)` puts
the depth *convention* into its own output, and both backends render under
the pin's ([fidelity](fidelity.md#shader-contract)).

A graph may also sample textures: `TextureBlock` and `ImageSourceBlock` each
declare a binding named after the block, and the scene supplies the image
under that name through `parseNodeMaterialFromSnippet`'s `textures` record.
Generation joins the two, refusing a binding the record omits or a name the
graph declares no binding for. The pair's group-1 allocation belongs to the
pin's composition ([fidelity](fidelity.md#shader-contract)).

What refuses at generation, naming the block that reached it: morph targets,
shadows, clip planes and the mesh-attribute test. A graph fetched by snippet
id refuses too, because the fetch is a network read at page load, and a graph
handed its own `blockLoader` refuses because that function is scene code
deciding which emitter serves each block class.

### Material plugins

`material.plugins = [plugin]` layers a scene's own WGSL onto a built-in PBR
or Standard material while the whole lighting, IBL and shadow pipeline stays
the pin's. It is an explicit opt-in: `enableMaterialPlugins(scene)` registers
the two plugin bridges into the global extension registries, and the hook
loops the two families already walk carry the plugin from there — upstream
changes no shared file for it, and neither does this port.

**Compile time, all of it.** A `MaterialPlugin` is a plain object whose
`name` and `getCustomCode(shaderType)` are constants the scene wrote, so the
plugin is folded from its own declaration; everything after that is the pin's
own `buildPluginFragment`, executed — which injection point maps onto which
template slot, how two plugins sharing a slot concatenate, and the
per-signature index that keys the compose and pipeline caches. What deploys
is the composed fragment, byte-identical to the one the browser compiles.

**Where the index rides differs by family, because the two variant selectors
do.** A PBR draw resolves its variant by material index, so its composed row
already carries the plugin and nothing travels at run time; the bridge's own
`detect` puts the index into `features2` while generation derives the
material. A Standard draw resolves by the feature word the material record
derives, so the record carries the index and the generated derivation shifts
it back in — which is exactly the pre-bake `registerStdPlugins` performs
upstream, and for the same reason: Standard's feature computation is not
extension-extensible.

The reached slice is a plugin declaring a name and custom code. Everything
past that refuses at generation naming the member: `getUniforms`/`writeUbo`
(PBR material-UBO fields and the Standard self-managed `pluginUbo`),
`getSamplers`/`bindTextures`/`getActiveTextures` (a texture and sampler pair
the composed fragment reads), and `priority`, `isEnabled` and `defines`. The
first two groups are what a plugin would need a bind-group contract for,
which is why the reached slice adds no native binding at all.

### Animation playback

Deterministic scene-level seeking over two separate runtimes: property
animation clips and groups over the paths that resolve against a mesh's
`position`, `scaling` and `rotationQuaternion` or a camera's `alpha` — the
lane itself, or one of its `x`/`y`/`z`/`w` components — with LINEAR/STEP
tracks, ranges, looping and speed ratios;
and glTF LINEAR/STEP/CUBICSPLINE transform channels with LINEAR or STEP morph
weights.
A glTF file's animations arrive as one group each, in the document's order,
reachable as `scene.animationGroups` and by name: upstream starts only the
first and loops each over its own length, so `playAnimation`,
`pauseAnimation`, `stopAnimation`, `goToFrame`, `loopAnimation`,
`currentTime` and `speedRatio` select among clips of different durations.
`goToFrame`'s optional engine argument is the pin's own guard: with one, a
group the scene has stopped is still posed.

A group also takes an `AnimationGroupMask` — `createAnimationGroupMask(names,
mode)` assigned to `group.mask` — which filters the targets it animates by
glTF node name, in Include or Exclude mode. A masked target keeps its rest
pose, which is what upstream's controller leaves behind when it skips a
channel. The names and the mode are compile-time, because the pin's own lazy
re-resolution exists to notice an array that moves; nothing else about the
mask is folded away.

A scene may also drive those clips itself. `createAnimationManager({ engine })`
plus `addAnimationGroups` moves ownership from the scene to a manager the
scene ticks through `updateAnimationManager`, which is what a file added
entity by entity needs — iterating a container's `entities` adds its nodes
and nothing else, exactly as the pinned `addToScene` splits the two. A
manager also owns the two weighted mixers, each an opt-in of its own:
`enablePropertyAnimationBlending` blends the property tracks several groups
share into one weighted write per property, and `enableAnimationBlending`
blends glTF clips into one skeleton pose, both under `setAnimationWeight`.
Without a mixer the groups write in turn and the last one wins, which is
also the pin's behaviour.

`KHR_animation_pointer` reaches node visibility; punctual light color,
intensity, range and outer cone angle; and fifteen material targets — base
color factor, emissive factor, emissive strength, texture transforms, normal
texture scale, occlusion strength, transmission factor, index of refraction,
volume thickness, volume attenuation distance and color, and the three
iridescence ones (factor, IOR, maximum thickness). A `metallicFactor` channel
drives *roughness*, because Babylon.js registers that pointer twice and the
second registration wins; `roughnessFactor` has no handler at all, in the pin
or here. Scene 253 gates the set with 69 channels.

Several of those targets change what the material *composes*, not just what
it writes: an animated occlusion strength registers the reflectance extension
(which then takes occlusion over entirely), an animated texture transform
forces the UV matrix fields, and an animated base color factor with no base
color image makes the factor texture white and moves the factor into the UBO.
Those are the loader's own rules, ported rather than inferred; see
[fidelity](fidelity.md).

### Deformation and instancing

Recursive skeleton hierarchies with inverse bind matrices, four-weight GPU
skinning, GPU position and normal morph targets through the pin's uncapped
storage-buffer path — Babylon Lite's one morph mechanism, compiled in for
any morph target at all — direct single-target morph attachment on generated
meshes, static `EXT_mesh_gpu_instancing`, and post-deformation flat
normals. Morph deltas apply before skinning. Deformation runs on the GPU or
not at all: a skin of any size rides the pin's own per-bone palette texture
wherever the scene composes its skeleton variants, and one exceeding the
transcribed vertex stage's 64-matrix array elsewhere is refused at
generation rather than deformed CPU-side. The one deformation quantity still
computed per frame on the CPU is the face normal of a primitive that carries
none, whose positions stay GPU-skinned.
[Architecture](architecture.md#animation-and-deformation) carries both
mechanisms.

A thin-instanced mesh may also carry a per-instance RGBA stream
(`setThinInstanceColors`), which a material declaring
`useThinInstanceColors` reads as the lane the pin's own thin-instance module
appends after the matrix columns. It is its own tightly-packed instance
buffer on both backends, and only a material that declares the lane builds a
pipeline wide enough to bind it. The per-instance `setThinInstanceColor`
twin is unreached and unlowered, which is why the record takes a copy of the
array where the matrix pool keeps the caller's own.

A **Standard** material reads that stream through the pin's own composed
fragment instead: the colours turn into a second mesh feature bit, and the
renderable splices a final-colour slot of its own where the shared fragment
carries a base-colour one ([fidelity](fidelity.md#shader-contract)). So a
coloured pool and an uncoloured one compose two variants, keyed as every
other mesh-phase bit is.

### Sprites

Pure-2D `depth: "none"` layers drawn by their own sprite renderer with no
scene at all: the frame grid derived at load from the decoded atlas,
per-sprite instance writes, and the straight-alpha blend, on both GPU
backends from one generated WGSL pair. The pinned renderer split and
instance layout are in [fidelity](fidelity.md#shader-contract).

A sprite already added can be edited and a layer emptied.
`updateSprite2DIndex` rewrites one slot from a `Partial<Sprite2DProps>`,
every omitted field keeping the value already there, and
`clearSprite2DLayer` drops a layer's count and size shadow without touching
the instance floats. Both go through the pin's single writer, whose add and
update arms are the only place the preserve rules live
([fidelity](fidelity.md#shader-contract) says which quantity each reads back
and why the size cannot come from the instance data).

A renderer's layer list is live too: `addSpriteRendererLayer`,
`removeSpriteRendererLayer` and `disposeSpriteRenderer` each move it after
the renderer exists. Both backends keep one GPU record per layer, keyed by
that layer as the pin keys its own, so a moved list adds and drops records
rather than rebuilding the set, with a version compare saying when to walk it
— the shape a scene whose mesh set changed takes. Disposing also
unregisters, stopping the frame loop from walking that renderer and moving
the frame's clear to whichever context is now first.

A sprite renderer may target a `SpriteRenderTexture` instead of the screen,
and that texture may in turn become another layer's atlas. Render textures and
renderers created by an application callback are synchronized before the
frame's update/record split, then consecutive renderers for one target share a
pass in registration order. Both backends end the offscreen pass before a
later screen pass samples it, which is the platformer's scene-to-CRT chain.

A layer opts into per-sprite UV scroll by setting an offset: the first
`setSprite2DUvOffset` widens that layer's instance layout in place, adds the
attribute the pin stashes for it, and selects the shader variant that adds the
offset to the sampled UV. The widening is per layer, so a pipeline describes a
layer's layout rather than its renderer's, and a scene that never scrolls
keeps the narrow layout. The atlas address modes a tiling scroll needs come
through `textureOptions`, which the pin spreads over the loader's own
defaults.

Either family may draw with a custom fragment shader: the caller supplies a
WGSL body and the pin's own composer wraps it in the stage the engine owns,
folded rather than reassembled, so the program is the pin's around the
caller's text. Building the descriptor is the opt-in — upstream it registers
the hook the always-loaded path reaches the feature through — and a layer or
system without one draws the stock shader.
The `fx` block a body may read (`fx.time`, and the `fx.params` vec4 the
per-family setter writes) binds beside the family's own block, declared
whether or not the body names it, as upstream declares it. What the body does
NOT read still matters: a block nothing reads does not survive to the
compiled shader, so which blocks a stage kept, and at which slots, is read
from the `.slots` sidecar rather than inferred from the WGSL
([backends](backends.md#dawn-backend-architecture-nativesrcpal_dawncpp)
owns the contract). A scene whose every layer or
system opts in never loads the stock program, so it is not composed either.

A body may also sample textures the caller supplies. Each is named in the
descriptor and reaches WGSL as the `<name>Tex` / `<name>Samp` pair the pin's
own builder writes, re-homed after the atlas in this backend's fragment
texture group. Their pixels come from `createTexture2DFromPixels`, whose
bytes a scene module computes and generation bakes — see
[drawn and computed assets](#drawn-and-computed-assets) for why they are
executed rather than ported. Its four sampler overrides
(`addressModeU`/`V`, `minFilter`, `magFilter`) travel as "named, and this
value", because the generated factory resolves `?? default` where upstream
resolves it; `srgb` picks a second texture format and no reached call
passes one, so it refuses by name.

Every blend mode either family exports is lowered as the pure data upstream
keeps it as — the descriptors are read out of the pinned modules rather than
listed here, so a mode the pin adds needs no compiler change. Sprites reach
alpha, premultiplied, additive, multiply and the opaque replacement; the
billboard family reaches every one of its own, cutout included.

World-space billboards share that atlas and nothing else. A
billboard system is a scene renderable rather than a renderer of its own: it
draws at the end of the scene's pass, expanding its quad around a basis taken
from the scene camera and testing against the depth the scene wrote, so a
billboard occludes and is occluded by geometry. Because the transparent modes
write no depth, the back-to-front sort by view depth IS the composite, and it
runs every frame. Both orientations the pin composes are reached: a facing
system builds its basis from the camera alone, and an axis-locked one rotates
only around a lock axis it normalises where the pin normalises it — that basis
reads the axis out of the system block, so the vertex stage binds it only for
the orientation that needs it.

Both of the pin's depth paths are reached, and they are not the same drawing.
A transparent system blends without writing depth, so the back-to-front sort
is its composite and it draws once the scene's own stages are done. A cutout
system discards below its alpha cutoff and writes depth, so the GPU resolves
overlap instead: it takes no sort, uploads in insertion order, and draws among
the opaque meshes — the slot the pin gives it. `setAlphaToCoverage` turns the
binary cutoff into sample coverage on a multisampled target, which is the one
permutation where a cutout system shares the transparent fragment stage,
because the pin drops the discard when coverage carries the edge.

A custom billboard program brings its own vertex stage, which is the one place
the two families differ: the pin's billboard composer writes the view distance
and the world position a custom body may read, and the stock stage does not.

### Picking

A GPU pick is a render, not a ray cast. `createGpuPicker(scene)` builds the
picker, `pickAsync(picker, x, y)` renders every candidate into a ONE-PIXEL
target through a view projection sheared so the sampled point lands on that
pixel, writes each candidate's id as a colour and its clip depth to a second
attachment, and reads the id back; `disposePicker` releases what the pass
allocated. Nothing intersects geometry, which is why a Gaussian cloud picks
at all -- it has no triangles, and its own pass draws the same splats it
draws for the frame with the pick colour substituted for the blended one.

Both modules are the pin's own text, composed by running
`pickingShaderSource` and `buildPickingWgsl` at generation. The mesh
pipeline compares GREATER over a depth buffer cleared to 0, this renderer's
reverse-Z; the cloud pipeline compares LESS, which is what its own pinned
pipeline declares and is kept rather than reconciled.

`PickingInfo` carries WHICH node was hit -- the collection and the index --
and `pickedMesh.name` reads through that pair where the scene asks for it,
because upstream `pickedMesh` is a live node reference and a scene may
rename the node between the pick and the read. Every other member refuses
at the read site rather than returning a value this port cannot fill.
[fidelity](fidelity.md#picking-contract) carries the two contracts the port
owns, and the family's remaining arms are in `TODO.md`.

### Physics

Rigid-body simulation, and the one family whose numbers are not the pin's.
The seam is the pin's own: `createHavokWorld(scene, hknp)` takes the solver as
a *parameter* and the pinned layer calls only `HP_*` entry points on it, so
the rigid-body semantics generate from the pinned module while the `HP_*`
surface is one PAL translation unit
(`native/include/bblite/pal_physics.hpp`). Behind it is Bullet rather than the
proprietary Havok WASM module: `await HavokPhysics(...)` compiles to nothing,
`@babylonjs/havok` stays a browser-only devDependency serving the reference
page, and the `physics:world` feature selects the solver a build links. Two
rigid-body solvers integrate different contact models, so this is the one
adaptation not bit-faithful by construction — recorded per scene as
`substituted-physics-solver` and measured by trajectory and by a pixel
comparison at rest rather than against a threshold driven toward zero.
[fidelity](fidelity.md#physics-contract) carries the substitution's why, what
stays lowered from the pinned declarations, and every measurement.

The reached slice: `createHavokWorld` with an explicit or defaulted gravity,
`createPhysicsAggregate` over the four primitive shapes
`createPrimitivePhysicsShapeHandle` builds without a mesh (sphere, box,
capsule, cylinder) with `mass`, `friction` and `restitution`, and
`onPhysicsAfterStep`. The step registers at the *front* of the scene's
before-render list, as the pin's `unshift` puts it, so a scene reading a
pose in its own callback reads this frame's rather than the previous
frame's. A body's integrated position and rotation are written onto the same
`MeshRecord` fields property animation writes, and bump the same
`transform_version` the renderer re-reads.

**A physics scene freezes itself, and that is what makes it measurable.**
Every one in the corpus counts steps in `onPhysicsAfterStep` and, at the
step its `?captureFrame=` query names, calls `stopEngine` from a zero-delay
`setTimeout` — both halves reached rather than erased: the flag the frame
conductor reads, and the one-shot callback it drains after the frame's own
callbacks. Without those two the scene runs free and the two sides are at
different steps, which makes any pixel comparison meaningless; with them,
both sides stop at the same physics step. The reached zero-delay slice, its
census, and the real-delay scenes that refuse are in
[fidelity](fidelity.md#physics-contract).

Everything else in the pinned physics layer refuses at generation naming
what it reached: mesh and convex-hull shapes (the pin's own mesh
accumulator), containers, heightfields, constraints, queries, triggers,
collision events, the character controller, the debug viewer, floating
origin, and every body control past creation.

### Shadows

Two shadow filters, both reached: a percentage-closer-filtered spot and an
exponential-shadow-map directional light, and a single receiver may sample
one of each.

`createPcfSpotlightShadowGenerator(engine, light, cfg)` owns the GPU state —
a `depth32float` map at `mapSize`, a comparison sampler under the pin's
`less`, and the receiver block — while the casters are a *task* input
(`setShadowTaskCasterMeshes`), where upstream keeps them.
`registerSceneWithShadowSupport` installs the scheduling: `registerScene`
plus the scene-owned shadow task, unshifted ahead of the scene's render task.
The split exists upstream so an ordinary bundle retains no shadow code, and
this port keeps it as a separate generated call for that reason.

**Compile time: which fragment a receiver composes.** `mesh.receiveShadows`
becomes the pin's `MSH_RECEIVE_SHADOWS`, a composition key rather than a
uniform lane: the variant carries the shadow fragment's per-light varyings,
bindings and sampling code, named after each light's index in `scene.lights`.
The scene's shadow-light slots are therefore composition input, and a light
added at a different position composes a different fragment. The caster draws
through its material's no-colour view — the arm a scene-code
`createStandardNoColorMaterialView` reaches — with the receive bit dropped,
as `rebuildSingle` computes `receiveShadows` as `!shadowOutput && ...`.

**Both material families receive.** `createStdShadowFragment` and
`createPbrShadowFragment` wrap one pinned core, differing only in which
fragment slot the sampling code lands in, so this port composes them through
one path and reflects one shape of group-2 row. The PBR receiver carries one
further pinned rule: `rebuildSingle` resolves
`lightCount === 1 && !receiveShadows ? 1 : 2`, so a receiving PBR mesh never
lands on the single-light arm — its shadow factor applies inside the
multi-light loop — and generation composes no such pair.

**The ESM directional generator.**
`createEsmDirectionalShadowGenerator(engine, light, cfg)` differs from the
spot generator in what it stores, not in how it is scheduled. A directional
light has no position to project from, so its light-space volume is fitted to
the CASTERS: `computeDirectionalLightMatrix` folds each caster's eight
world-space AABB corners into light space and sizes an orthographic
projection to that box, refitted every frame. Its caster pass writes an
*exponential* depth into an `rgba16float` colour attachment through
`createStandardEsmShadowMaterialView` — not the depth-only view a PCF caster
takes — and the map is blurred in two separable Gaussian passes whose tap
table the pin FOLDS from `blurKernel`: `createShadowBlurFragmentWGSL(64)`
emits 33 linear-sampled taps with their offsets and weights, so the kernel
decides shader text. The receiver samples the second blur half, which is what
the pinned factory sets `sg._depthTexture` to.

Everything that generator builds is read by running the pinned factory
against a device that records what it was asked for — four textures with
their formats and usages, both blur stages, the two texel steps, the
sampler — so none of it is restated here. The blur stages deploy and compile
like any other composed pair.

**The PCF directional generator.** The third factory is the other two
combined, and is built as such: the spot generator's `depth32float` map,
comparison sampler and shared receiver block, sized by the same
`computeDirectionalLightMatrix` caster fit the ESM directional one uses. It
needs no define of its own — every resource it wants some sibling already
builds — so what the port adds for it is the factory, its defaults read off
the pinned module, and the third arm of the per-frame refresh.

**A composed row names a LIGHT, not a generator.** The pin numbers a
receiver's group-2 rows `shadowTex_<lightIndex>`, where the index is "the
position of its light in `scene.lights`" — so a scene whose shadow-casting
light sits behind an ambient one names row 1 with one generator in the
scene. Both backends resolve a row through that light slot. Counting
generators instead agrees exactly while every light carries one, which is
why it survived until a scene put a hemispheric light first.

**Group 2 is reflected, not counted.** `createShadowFragment` picks each
binding's TYPE from its own light's filter, so a scene mixing the two
filters declares a `texture_2d<f32>` beside a `texture_depth_2d`, and a
plain `sampler` beside a `sampler_comparison`, in one group. A layout driven
by a light count could not express that, so the group is read out of the
composed text exactly as group 1 is, and both backends build their layout
and their resources from those rows — one row shape and one builder for
either material family, because the rows describe the shadow family rather
than the material one.

**Run time: two passes and one exception.** The caster pass is a depth-only
render task over the generator's map (an ESM one stores a colour beside that
depth), rendered from the light: standard-Z
(`less-equal`, cleared to the far value 1), which is the pin's own one
exception to this port's reverse-Z convention, and the pin's clip-space bias
baked into the *caster's* view-projection alone — the receiver samples with
the unbiased matrix, and biasing both would shift the comparison twice. The
receiver then binds the map, the comparison sampler and the receiver block as
the pin's group 2, and `shadowFactors[lightIndex]` scales that light's diffuse
and specular contribution.

What refuses at generation, by name: the cascaded generator, a node
receiver (`node-shadow.ts` is the third sibling of that one
core, and needs the node family's group-2 wiring), a `receiveShadows` written
to anything but `true` (the variant is selected at generation), an imported
mesh as caster or receiver, and every generator option past the two factories'
own reached sets (`mapSize`, `bias`,
`darkness`, `near`, `far` for the spot and the directional PCF; those plus
`depthScale`,
`blurKernel`, `blurScale`, `frustumEdgeFalloff` and the two ortho bounds for
the directional) — `normalBias` and `forceRefreshEveryFrame` among them.

### Navigation

Runtime Recast/Detour navigation behind the same boundary shape physics
draws — `createNavigationPluginAsync` hands the pin a module and the pinned
wrapper calls a fixed entry-point surface on it, held in one PAL
translation unit (`native/include/bblite/pal_navigation.hpp`) — but where
physics substitutes the solver, navigation links the very recastnavigation
commit the wrapper's own WASM builds (a vcpkg overlay port), with
`/fp:strict` and a libm-shaped `cosf` patch pinning the arithmetic, so the
numbers stay the pin's: measured equal on the current corpus. The wrapper's
`recastConfigDefaults` are baked into the PAL verbatim and drift-gated at
generation against the installed `@recast-navigation/core`, so a bumped
package that moves a default names the constant to move. Its
`crowdAgentParamsDefaults` are gated the other way round and reach the PAL
not at all: the pinned `addAgent` supplies every key that table holds, so
the wrapper's spread is fully overridden, and what generation checks is
that this stays true — a package that grows a twelfth default fails
naming it.

The reached slice: a solo navmesh built from the numeric config subset of
`createNavMesh`, over either mesh kind the corpus casts from. The merge
applies each caster's own `worldMatrix` as the pin does, and where that
matrix already is decides the arm: a glTF-imported mesh's vertices carry
the loader-baked mirrored world (measured equal to the pin's stream on
the corpus) so its rows are the identity and the positions pass through,
while a factory mesh keeps local vertices and its transform on the
record, so its rows are the TRS composed from the pin's own
`composeTrsLocalMatrix`. A glTF mesh carrying scene-code TRS would need
both at once and refuses at runtime naming the mesh. Winding is reversed
over a running vertex base either way.

Beyond the build: `createDebugNavMeshGeometry`'s detached triangles with
the pin's reversed storage winding; `raycast`, which finds the nearest
poly in the wrapper's ±1 half-extents, reports a hit exactly when
`0 < t < 1`, and lerps the hit point in JS-double width;
`getClosestPoint`, which is the wrapper's own two-call snap
(`findNearestPoly` for the polygon, then `closestPointOnPoly` for the
point) at those same half-extents; and a **crowd** — `createNavCrowd`,
`addAgent` with the pinned module's own `?? 7` / `?? 0` parameter
defaults resolved before the wrapper's spread sees them, and
`getAgentPosition` reading the agent's `npos` with the pin's `{0, 0, 0}`
for an index the crowd never held. Tiled meshes, the tile cache and
obstacles, off-mesh connections, `agentGoto`, `updateNavCrowd`,
`computePath` and the rest of the query family refuse at generation by
name.

### Frame graph

Render targets and tasks, material overrides, depth-only passes, 7+4 geometry
MRTs, blits, and MSAA resolve, with Babylon Lite's double-precision viewport
coordinates floored to integer bounds and applied as a scissor. A render task
whose target is multisampled may name a single-sample target to resolve into
at end-of-pass, so an MSAA render feeds a post-process that requires a
single-sample source without a separate resolve pass; the pin ignores it when
the target is single-sample and so does this port, judged by the sample count
the target was *allocated* at. A render task
may bind a depth attachment another task owns instead of its target's own —
the pin's own eager-wrapper contract, which the geometry renderer hands over
and the borrowing pass loads rather than clears. It may also draw through a
camera of its own rather than the scene's — the anaglyph's
left eye is the reached case — which gives that task its own copy of the pin's
per-pass scene block and nothing else, since a second camera moves the
view-projection and the eye position and no other value in it.

A `FrameGraphContext` is the scene-less ownership form: it registers directly
on the engine, runs its `update(deltaMs)` callback, and executes only the tasks
added to its graph. Its SDL_GPU and Dawn drivers contain no scene, camera,
mesh, material, image-loader, or PBR renderer. Render-target allocation is a
separate reached feature shared with scene-owned graphs, so a program that
uses both forms gets one resource implementation, while an effect-only graph
does not compile post-process factories, shaders, samplers, or pass state.

### Post-process passes

Every post-process Babylon Lite ships is one `createPostProcessTask`: a
fullscreen triangle over a single-sample source texture, a bind group of
sampler, source view, the effect's extra views and its optional uniform block,
and an output that is either the target the caller named or one the pass makes
from the source's descriptor. The same record runs inside a scene-owned graph
or a registered scene-less `FrameGraphContext`. Blur, chromatic aberration,
black and white, the red/cyan anaglyph and the circle of confusion are
reached, each contributing only a shader record and a `writeUniforms` body.

A **composite** — depth of field, and bloom — is one entry point building a
chain of those passes over intermediate targets it owns, while the caller
still sees one task: one `addTask`, one `updateUniforms`, one output. Bloom's
chain is extract-highlights, two separable blurs and a merge that adds the
blurred highlights back over the source, its three intermediates sized to
`floor(sourceSize * bloomScale)` and its blur kernels scaled by the same
factor. Which passes, in what order, over which textures and at which sizes
is decided entirely by the config, so generation runs the pin's factory and
emits the chain it built. Nothing about depth of field is written into this
port: its eight passes and seven intermediates are what the factory made, its
pass names derive from the name the scene gave the task, and the entry points
it builds through are `@internal` in the pin and refused at a scene's call
site for that reason.

An intermediate is a fraction of the source — the blur pyramid runs at 0.75,
0.375 and 0.1875 — re-evaluated whenever the frame graph is built, so a
window resize moves the chain with it. The fractions are not read off one
run: generation composes twice against sources of different sizes and
formats, and refuses any extent a single fraction does not reproduce exactly.

Bloom's merge is the one pass not built through a leaf factory: it calls
`createPostProcessTask` itself with a `_shader` written inline in the
composite's body. The observation therefore watches that entry point beside
the leaves, and the merge's parameters and uniform writer are read from the
composite rather than from the pass, which publishes neither
([fidelity](fidelity.md#attribution)).

**Compile time: the stage.** The effect's factory runs under Node against a
descriptor-only render target and the pin's `getShaderModule` concatenates
the module, so what deploys is the text the browser compiles for the options
this scene passed. Both stages live in one module, so it deploys twice — once
per entry point — and SDL_GPU re-addresses the pin's groups as it does for a
composed material variant. A module is identified by its text, not the pass
that reached it: a blur pair differing only in its `direction` uniform
composes one module and deploys it once. Why the factory is executed rather
than folded is in [fidelity](fidelity.md#attribution).

**Run time: the pass.** Parameters live on the task record and
`updateUniforms` marks them for rewrite — the pin's own split between
mutating a parameter and uploading the block — while the bytes come from a
generated writer lowered from each effect's `writeUniforms`, so a pass whose
values depend on the attachments reads them from the real targets. The two
rules it takes from the pin (the output target's sample count, and the
far-edges-up viewport rounding a copy task does not share) are in
[fidelity](fidelity.md#attribution).

### Fullscreen effects

`createEffectWrapper` is the pin's own equivalent of Babylon.js's
`EffectWrapper`/`EffectRenderer`: a fullscreen fragment the caller writes, one
explicitly declared bind group, and a three-vertex draw over a
`@builtin(vertex_index)` triangle. It is deliberately outside the frame graph
in its simplest form — an `EffectRenderer` registers on the engine as its own
rendering context and owns a swapchain target, so a procedural fullscreen
scene needs no `SceneContext` at all.

**Compile time: the module and the layout.** The pin builds one shader module
as `vertexWGSL ?? DEFAULT_VERTEX_WGSL` concatenated with the caller's
fragment, and generation performs the same concatenation; both entry points
live in the one module, so it deploys twice — once per stage — exactly as a
post-process module does. The bind-group layout is the descriptor's
`bindings` array rather than anything reflected out of the WGSL, so it
travels to the generated table whole, with a sampler's `textureBinding`
fallback resolved once at generation. Everything else the pin decides about
the pass is asserted at generation rather than restated;
[fidelity](fidelity.md#shader-contract) carries the checked list.

**Run time: the pass.** Two entry points draw the same pair of halves. An
`EffectRenderer` is its own rendering context, so a scene registering one and
no `SceneContext` compiles no scene renderer and draws from a translation unit
of its own — the same split a `SpriteRenderer` already takes, and for the same
reason. A `createEffectRenderTask` is a frame-graph task into a
`RenderTarget` the caller made, which a Standard material can then sample as
its diffuse texture. Either way the pipeline is built against the *output
target's* format and sample count, which is what the pin's own
`targetSignatureKey` cache is keyed by.

The smaller `UniformEffectWrapper` family takes the same fullscreen path with
one aligned uniform block at binding zero. Generation lifts its own pinned
default vertex stage and validates the uniform byte length; the per-frame
setter updates the existing wrapper buffer. Its render task may be added to a
scene-less `FrameGraphContext`, so a procedural graph needs neither an
`EffectRenderer` nor a `SceneContext`.

What refuses at generation, by name: a custom `vertexWGSL`, a `blend` state,
the `EffectRenderer`'s per-frame `update` callback, the per-binding record
form of `setEffectUniforms`, an effect texture from anything but
`createSolidTexture2D`, and every `EffectBindingLayout` field past the five
the corpus writes (`visibility`, `textureSampleType`, `viewDimension`,
`samplerType`). The uniform-only family likewise refuses a custom
`vertexWGSL`; its contract is deliberately the pinned default fullscreen
stage plus the caller's fragment.

### Image processing

Exposure, contrast and the tone-mapping opt-in, written on the scene's
`imageProcessing` record. Exposure and contrast are live scene-UBO fields the
frame reads; the tone-mapping *curve* is not, because upstream models one as a
value — `{ id, helpersWGSL, callWGSL }` — that `pbr-renderable.ts` composes
straight into the PBR fragment. So a scene naming one of the pin's three
exported records selects which WGSL reaches composition, and an unset
selection reaches the pin's own default for the same reason the pin resolves
`toneMapping ?? StandardToneMapping`. A scene naming two different records
refuses at generation, because the composed arm set is closed there.

A node graph's own `ImageProcessingBlock` is unaffected: it reads the
tone-mapping *state* out of the scene block and carries the standard
exponential curve inline, so the selection reaches the material families
alone.

### Render backends

Two peer GPU backends render the same generated plans and are selected at run
time in a build that compiled both (`BBLITE_GPU_BACKEND=dawn`; SDL_GPU is the
default). **bblitec requires a GPU**, and there is no third choice: a backend
that cannot bring a device up throws rather than degrading into a software
picture nothing measures. They do not start the same way: SDL_GPU loads
content-addressed offline binaries and does no shader
work at all, while Dawn compiles the generated WGSL through its own embedded
Tint and DXC as modules and pipelines are created — see
[shader pipeline](#shader-pipeline). Ordered opaque and
transparent draw lists, camera matrices and per-draw uniforms are built each
frame; transmission renders linear RGBA16F with a scene-color grab and one
final image-processing pass. A backend that does not implement a run-time flag
refuses it rather than rendering something else.

### Runtime scene mutation

`removeFromScene` with incremental render-plan rematching, material-family
append after registration, thin-instance flush and count updates, and mesh
appends without a queue-wide idle. SDL_GPU batches a frame's small buffer
creates and rewrites into one transfer/copy submission. Short-lived
custom-shader meshes reuse exact local geometry while their per-entry
transforms and material values remain independent. Their texture/sampler pairs
are owned once by the material rather than re-uploaded for every replacement;
reference counts retire geometry as soon as no draw uses it, so repeated
replacement does not turn the reuse cache into an ever-growing search.

### Diagnostics and capture

Screenshot and benchmark modes, draw-ID and triangle-cluster buffers,
deformation dumps, the render capture that writes the
frame's whole CPU-side description for diffing against the browser — mesh
draw lists and independent scene renderables such as Gaussian splats both
carry their indexed shape and exact uniform block —
([debugging](debugging.md)), and the build stamp the parity harness checks
before it trusts a measurement.

## Where the boundary falls inside a family

| Family | Compile time | Run time |
| --- | --- | --- |
| glTF assets | download, Draco/meshopt decode, upstream feature-predicate specialization, capability defines | parse, build meshes/materials/skins, deindex, strip expansion, upload |
| Environments | HDR and DDS packaged (GGX prefilter, SH projection); BRDF LUT integrated | `.env` parsed, RGBD decoded, cubes uploaded and sampled |
| Shaders | composition, specialization and reflection for both backends, plus the selected DXIL, SPIR-V, or MSL target for SDL_GPU | Dawn's embedded Tint and DXC compile the same WGSL at startup; pipelines built lazily per kind |
| Sprites | the atlas image executed and baked | the frame grid derived from it, instance writes, the pass, the billboard sort |
| Node particles | the graph parsed, built and simulated by the pin, its particle state baked | nothing of the simulation; the billboard or Sprite2D layers it folds to draw like any others |
| Animation | property clips and groups lowered to typed records | glTF channel data read from the asset; all evaluation and seeking |
| Deformation | which vertex layout and shader variant exist, from the asset | joint palettes, morph weights, skinning and morphing, post-deformation face normals |
| Lights | which light-kind writers and `light_*.cpp` units exist | the lights buffer, per-mesh light sets, uniforms |
| Textures | which image codecs link and ship | decode, mip generation, factor texels, sampler state |
| Compressed textures | which container the device's formats select, and a Basis file transcoded into one | the container parsed, its blocks uploaded, its own chain sampled |
| Post-process passes | each effect's composed stage, for the options the scene passed | the pass, its uniform block, its viewport rectangle and its blend |
| Shadows | which receiver variant carries the pin's shadow fragment, and the per-light slots it names | the caster pass, the map, the light-space matrices, the comparison sampling |
| Node materials | the graph compiled to a module by the pin's own emitter, its uniform block folded to the graph's defaults | the draw, its mesh block, the textures the scene supplied, and the per-mesh light selection that block carries |
| Material plugins | the plugin folded from its own declaration and spliced by the pin's own bridge; the signature index that keys each family's variant | nothing, for the reached slice — a Standard record carries its index so the derived feature word can select the composed variant |
| Fullscreen effects | the caller's fragment wrapped in the pin's own vertex stage, and the bind-group layout the descriptor declared | the pass, its uniform bytes, and the textures the scene bound |

## Knobs

The same split applies to the switches.

**Compile-time** (CMake cache values and generation output; see
[development](development.md#build-switches)): `BBLITE_GENERATED_DIR`,
`BBLITE_BACKEND` (which backends are compiled in at all), `BBLITE_DAWN_DIR`,
`BBLITE_SDL_DIR`, `BBLITE_MINSIZE`, `VCPKG_TARGET_TRIPLET`, and the
generated `BBLITE_IMAGE_CODECS`.

**Run-time**: the environment variables — `BBLITE_GPU_BACKEND` and the rest —
are tabulated once in [development](development.md#runtime-switches).

Requested environment grounds and DDS/HDR/solid-colour skyboxes render by
default and are disabled independently with `BBLITE_GROUND=0` and
`BBLITE_BACKGROUND=0`. Which skybox arm a scene gets is decided at generation
from the two URLs and the pinned `skipSkybox` flag
([fidelity](fidelity.md#shader-contract) carries the three-way rule).

## Boundaries

Almost every boundary is enforced at generation: an unsupported feature is a
build error with a source location, not a silently different image.

### Rejected at generation

**Each family section above ends with its own refusals, by name.** What follows
is the boundaries that belong to no single family.

- one statically analyzable entry file and one engine; selected TypeScript
  expressions, assignments, callbacks, and intrinsics
- no arbitrary object graphs or run-time module loading. Observable imported
  module state initializes once in dependency order; purely static builders
  remain generation-time values. Reached local classes retain identity, but
  inheritance and statics remain rejected, and resource-holding fields cannot
  be rebound after construction. Mutually recursive plain-data groups lower;
  recursion carrying engine resources still refuses
- the plain-data model preserves observable JavaScript identity for arrays,
  maps, sets, stored/recursive records, composite parameters, and borrowed
  typed-array spans. Aliases that cannot remain safe across container resizing
  reject later use; `new Array` elements zero-initialize; and `Math.random` is
  the pinned seeded sequence — each adaptation is recorded in `fidelity.json`
- no networking. Physics is reached behind a substituted solver
  ([above](#physics)) and a Web Audio prototype behind a substituted engine
  ([fidelity](fidelity.md#audio-contract))
- scene fog is ported for PBR, Standard, and image-skybox surfaces; fog
  composed with Grid, custom-shader, environment-ground/DDS-skybox background,
  transmission, or geometry-output surfaces fails explicitly
- a scene-code mesh or PBR material created before a later glTF load fails,
  because it would interleave the variant table's creation-order key
- an orthographic camera composed with an environment skybox or ground fails,
  because those build their own perspective view-projection
- an asset carrying more punctual light nodes than the pinned `MAX_LIGHTS`
  (16) fails, where upstream grows the constant at run time
- a skin larger than the transcribed vertex stage's 64-matrix bone palette,
  in a scene composing no pinned skeleton variant, fails naming the joint
  count and the transport. Deformation runs on the GPU or not at all, so the
  palette is a bound rather than a slow path

### Refused at run time

A few contracts cannot be settled until the assets are loaded, so the
generated code refuses them explicitly instead of shading something plausible:

- a spot light landing in the **primary** PBR analytic slot, whose direction
  component encodes the light kind and carries no cone
- requesting a GPU backend the build did not compile
- a run-time flag a backend does not implement

### Platform validation

D3D12 is validated locally. Vulkan has one recorded device run (Windows NVIDIA
through SDL_GPU: the Standard family correct, the PBR family mis-shading —
[TODO](../TODO.md)'s Vulkan section carries the findings); Metal artifacts are
generated but untested, and the Dawn integration is Windows-only today by
configuration rather than architecture
([backends](backends.md#backend-comparison)).

---

Every feature above is generated from the pinned upstream release. Unfinished
work is tracked only in [TODO](../TODO.md); measured results are in
[status](status.md).
