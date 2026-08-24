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
| [Compressed geometry](#compressed-geometry) | Compile | Draco and meshopt decoded, quantized accessors rewritten, to ordinary geometry |
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
| [Animation playback](#animation-playback) | Run | deterministic seeking, property clips, glTF channels |
| [Deformation and instancing](#deformation-and-instancing) | Run | GPU skinning, morph targets, storage morphing, GPU instancing |
| [Sprites](#sprites) | Run | frame derivation, per-sprite instances, the pure-2D pass, world-space facing billboards, per-layer custom fragment shaders |
| [Node particles](#node-particles) | Compile | a graph's CPU simulation run by the pin at generation and its particle state baked; the billboard or pure-2D bridge that draws it is folded |
| [Physics](#physics) | Run | rigid bodies, primitive shapes, one fixed step per frame — over a substituted solver |
| [Frame graph](#frame-graph) | Run | render targets, tasks, geometry MRTs, blits, MSAA resolve |
| [Post-process passes](#post-process-passes) | Compile → Run | each effect's stage composed by the pin at generation; the fullscreen pass, its uniforms and its viewport at run time |
| [Fullscreen effects](#fullscreen-effects) | Compile → Run | the caller's WGSL wrapped in the pin's own vertex stage at generation; the swapchain renderer or the frame-graph task at run time |
| [Image processing](#image-processing) | Compile → Run | the tone-mapping curve composed into the PBR fragment; exposure and contrast live per frame |
| [Render backends](#render-backends) | Run | SDL_GPU, Dawn, transmission, image processing |
| [Runtime scene mutation](#runtime-scene-mutation) | Run | removal with plan rematching, material-family append, instance counts |
| [Diagnostics and capture](#diagnostics-and-capture) | Run | screenshots, benchmarks, attribution buffers |

Ten families have work on both sides of the line; the shader pipeline's
second stage changes phase with the backend. Where the cut falls in each is
[tabulated below](#where-the-boundary-falls-inside-a-family).

## Compile-time feature sets

### Program compilation

The reachable subset of TypeScript that lowers to C++20, from one statically
analyzable entry file against one engine.

- **Modules and functions.** Local imports and re-exports, module constants,
  typed non-generic functions with defaults, lexical scopes, `if`/`else`,
  `for`/`while`, `switch` with `break`/`continue`, and `for-of`. Functions
  whose parameters and return type map entirely into the plain-data model are
  emitted once as real C++ functions; handle-touching helpers inline per call
  site.
- **Classes and factory records** exist only as compile-time instances: fields
  become locals, methods and single-return getters inline at their call sites,
  and a record carries the scope it closed over.
- **The plain-data model.** Interface structs, `T | null` optionals, dynamic
  arrays, `Float32Array`/`Uint32Array`, string-literal enum tags,
  `Record<Union, T>` indexed by tag, readonly numeric tables, tuples,
  destructuring, object spread, and constant arrays materialized on demand.
  Resource handles are storable inside data. Const locals bind container
  elements as aliases; function-valued parameters inline. `Math` and the
  pinned seeded `Math.random` are available.
- **Browser erasure and AOT promises.** The browser `main` wrapper, DOM,
  timing, and dataset instrumentation are erased, and every `await` on a
  materialized asset resolves immediately. `window.location.search` reads as
  the query the scene's reference pose is captured at, so a scene that
  branches on one takes the branch its golden was captured under.
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

**Why compile time:** this is the compiler. There is no interpreter, no
run-time module loading, and no run-time object identity — a compile-time
record has no native representation to store or select between, so it cannot
outlive generation. Static evaluation and inlining are how the subset reaches
C++ at all. Each divergence this introduces is recorded per scene in
`fidelity.json` (`plain-data-value-model`, `deterministic-seeded-random`,
`entry-main-wrapper-erasure`, `synchronous-aot-await`,
`material-tracking-observers-dropped`).

### Feature and capability selection

Three generated lists decide what exists in the binary, and they answer
different questions:

| List | Source of truth | Decides |
| --- | --- | --- |
| `BBLITE_RUNTIME_FEATURES` in `features.cmake` | the scene's own TypeScript | which generated modules and PAL translation units compile |
| `render_capabilities.hpp` | the materialized assets, after specialization | transmission, deformation, morph storage, instancing, material extensions, uv2 occlusion, Standard bump and 2D reflection, image and solid-colour skyboxes, and the composed PBR/Standard variant counts |
| `BBLITE_IMAGE_CODECS` in `features.cmake` | the materialized assets' image types | which image decoders link and ship |

The feature list is finalized during compilation, before remote assets are
materialized, with two deliberate exceptions joined afterwards: an asset's
own lights — glTF `KHR_lights_punctual` kinds and `.babylon` point
lights — and `EXT_lights_image_based` become `light:*` and
`environment:ibl` features, because light features select `light_*.cpp`
translation units, which only the feature list can. Every
other capability an asset reaches without the scene source naming it lives
in the capability header instead — scene transmission is the standing
example, because Babylon Lite enables it from any transmissive material a
loaded asset carries. Every activation across all the mechanisms — the
feature list, the capability defines, the codecs, the emit options,
variant composition, and the generation-time refusals — is recorded per
scene in `upstream/feature-activation.json`, with the first reaching call
site or asset and the pinned module each unit mirrors.

The rule that decides which mechanism owns a feature: a runtime feature
exists for API the scene's own source can reach, and a capability exists for
what assets decide. An extension family with a scene-code setter therefore
has both (clearcoat, sheen and iridescence are feature-or-capability), and one
without a setter has only the capability (dispersion, and the spec-gloss
workflow replacement, which no scene API reaches at all).

**Why compile time:** there is no dynamic module loading, so upstream's own
`import()`-behind-a-predicate boundaries have to be resolved somewhere, and
generation is the only place that can see both the source and the assets. The
asset specializer mirrors upstream's predicates directly, which is what keeps
a capability upstream holds off its core path from becoming unconditional
here. It is also the whole of tree shaking: a scene reaching no skins emits no
skinning code, no deformation vertex layout, and no matching shader variant.

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
in the pinned loaders marks the case. Only the base64 form is read; a
percent-encoded body refuses rather than decoding through a second path.

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

`KHR_mesh_quantization` resolves in the same pass and for the same reason, by
an easier route: the extension *is* one pinned `preParse` hook, which rewrites
every quantized accessor — signed, normalized, strided, or the unnormalized
unsigned POSITION/TEXCOORD storage gltfpack emits — into a freshly appended
tightly-packed FLOAT bufferView. It touches only the document and its binary
chunk, with no browser API in it, so generation runs the pin's own module
rather than reimplementing the conversion and the packaged asset drops the
extension. Upstream imports that module only when `extensionsUsed` lists it,
which is the boundary this pass keeps.

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
  format the *device* reports, and tries them in order — a run-time question a
  native build cannot ask, because it has no network to fetch a second
  candidate with. Generation answers it once with block compression, which
  is what the validated platform reports, and that is the golden's answer
  too: the browser reference runs D3D12, where a WebGPU adapter reports
  `texture-compression-bc` and neither ASTC nor ETC2. A call listing no
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

The texture object's own `invertY` travels with it either way, because it is
not an upload flip: the pin applies it in the material's UV transform, which
is what keeps a compressed texture correct where an in-place row swap is
impossible. `loadKtxTexture2D` leaves it unset and `loadBasisTexture2D` sets
it, so a Standard material sampling a Basis texture flips its UV block and one
sampling a KTX texture does not.

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
formula to port. It is built with canvas2D — rotated wedges, `arc`, `hsl` —
so its pixels are a browser rasterizer's antialiasing rather than an
expression. Recorded per scene as `drawn-sprite-atlas`. The frame grid is
**not** baked with it — see
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

**Why the simulation is compile time**, and it is the strongest case of the
executed kind in this repository:

- **The graph build is closures.** `npe-build.ts` walks the document and
  dynamically imports one evaluator per block class, each installing getters
  and update steps onto the system as JavaScript functions. There is no shape
  to fold — the "shader" of a particle graph is a call tree assembled at load
  — and this compiler lowers no closures.
- **The value is fragile past any rounding argument.** The seed each scene
  installs draws through `Math.sin`, which is not bit-portable between V8 and
  a native maths library, and the graph consumes that sequence in an order
  the block walk decides. A lowered simulation would diverge into a
  *different set of particles* within a few hundred draws, not a slightly
  different one.

So generation runs the pin's own parser, builder and simulation in headless
Chromium and bakes the particle buffer. Recorded per scene as
`executed-node-particle-simulation`; the baked state depends on the Chrome
that ran it, exactly as the drawn atlas and the pinned GGX prefilter do.

**What stays folded is everything downstream**, on both render targets.
`createParticleBillboard` and `syncParticleBillboard` are lowered from their
own pinned declarations — the
grid atlas over the graph's texture, the blend its numeric mode selects, the
five props the sync writes per particle — so the generated scene builds the
billboard system the pin would have built and writes the sprites the pin
would have written. From there it is an ordinary facing-billboard scene.

The driver holds the scene state the pin reads while it builds. That is the
graph, the emitter and the texture base URL — and the **camera**, because
`UpdateFlowMapBlock` derives a view-projection during the build and a build
with no camera leaves the flow update a silent no-op.

**Two render targets, and the exact blends on both.** A frozen set draws
either as camera-facing billboards or through the pure-2D Sprite2D bridge,
and each has a plain mapping and an exact one. The plain builders map three
Babylon blend modes and degrade the rest; `enableNodeParticleBlendModes` (or
the builder that applies it) resolves all five, which turns mode 3 into the
pin's own private Multiply fragment and mode 4 into that pass followed by a
stock Add pass over the same instances. The pure-2D bridge takes the same
five through `registerNodeParticleSet2DWithBlendModes`, where mode 4 is two
equal-order layers the renderer's stable sort keeps adjacent.

**A registered set is folded, and the fold is measured.**
`registerNodeParticleSet` appends a callback that animates and
re-synchronizes every frame, which one frozen state cannot answer in
general. It can for a system the scene froze, and generation proves it
rather than assuming it: the driver takes each registered system's state,
steps it once more, and compares every column the sync reads. A registration
whose system still moves, or whose `updateSpeed` is not zero, refuses.

**A particle buffer is generation-time state.** The simulation runs at
generation, so `buffer.alive` and every column exist only there: a scene that
writes a column afterwards is editing the state the bake hands on, and one
that checks the live count is asserting about it. Both move to the driver and
emit nothing.

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
| Toolchain | pinned Tint CLI → HLSL → register normalization → DXC → DXIL/SPIR-V; MSL straight from Tint | Dawn's embedded Tint → HLSL → its own built DXC → DXIL |
| Artifacts | `.dxil`/`.spv`/`.msl` deployed beside the executable | none — the `.native.wgsl` text ships instead |
| Cache | `artifacts/shader-cache`, content-addressed, reused across scenes | none |
| Runtime payload | no compiler | `webgpu_dawn.dll` plus Dawn's own `dxcompiler.dll`/`dxil.dll` |
| Startup | no shader work | first-frame compile cost |
| A new platform costs | its own offline path, one per target | nothing — Dawn's Tint emits HLSL, SPIR-V, or MSL itself |

The SDL_GPU offline paths:

| Target | Offline path |
| --- | --- |
| D3D12 | WGSL → Tint HLSL → normalized registers/signatures → DXC DXIL |
| Vulkan | WGSL → Tint HLSL → normalization → DXC SPIR-V |
| Metal | WGSL → Tint MSL |

Tint *can* emit SPIR-V directly, but its separate WGSL texture and sampler
binding numbers do not satisfy SDL_GPU's dense corresponding-slot contract, so
Vulkan temporarily recompiles normalized Tint HLSL through DXC pending a
verified binding remap. Only D3D12 is device-validated
([boundaries](#platform-validation)). Dawn bypasses this table entirely.

**Why SDL_GPU's half must be compile time:** D3D12, Vulkan, and Metal consume
DXIL, SPIR-V, and MSL, and SDL_GPU carries no shader compiler at all, so those
binaries have to exist before the executable runs. DXC cannot be dropped from
the D3D12 path either, because Tint does not emit DXIL.

**Why Dawn's half is run time:** Dawn is the browser's own WebGPU
implementation and carries Tint and DXC *inside* it — the same components the
offline path invokes as tools. Compiling at startup is the parity mechanism:
the goldens were produced by that stack, so running it in-process removes the
offline-versus-browser compile split rather than adapting to it, and Dawn is
bit-exact on scenes where SDL_GPU carries DXC-versus-browser rounding. The
identity of that compiler is measurable: a Dawn built without
`DAWN_USE_BUILT_DXC` falls back to FXC and carries a systemic one-LSB error on
lit surfaces, which DXC does not.

## Run-time feature sets

### Engine, scene, and frame loop

Engine creation, scene creation and registration, fixed delta timing,
before-render callbacks, and the frame conductor both backends share: the
runtime flag matrix, the capture gate that decides when a run may stop
(including the bounded grace a deferred capture needs), and the clock the
scene callbacks advance by.

### Cameras and input

ArcRotate and Free cameras, default framing, target assignment and reads,
per-frame clamping of the reached properties, and the `enableOrthographicCamera`
opt-in with its aspect-derived view volume. SDL provides the platform
boundary: left-drag orbit, right/middle-drag pan, wheel zoom, with arrows and
`W`/`S` as keyboard fallbacks.

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
  record, and texture-less PBR factors bake into 1x1 texels.
- `KHR_materials_variants`: the loader reads each primitive's mappings and the
  document's variant order, and draws the material the scene's one static
  `selectVariant` name resolves to. Only that name is compiled in; the pin's
  run-time variant table is not carried, so a second differing selection, a
  second selecting asset, a selection made from a frame callback,
  `getVariantNames` and `resetVariant` all refuse at generation
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
  are sampled in the vertex stage; the fragment stage reads only varyings.

The reached slice is the plain `.ply` and `.splat` row layout. A compressed or
spherical-harmonic PLY refuses at generation, because it needs the pin's second
parser and its own SH pipeline; `.sog` and `.spz` need a ZIP and a gzip decoder
first. The sort runs on the frame's own thread before the draw that reads it
rather than in a worker, which is the state `mesh.firstSortReady` waits for
([fidelity](fidelity.md#semantic-contract)).

### Geometry and meshes

Box, sphere, subdivided ground, plane, and torus primitives;
`createMeshFromData` typed-array meshes; indexed glTF/GLB and `.babylon`
geometry; glTF triangle-list and triangle-strip primitive modes; generated and
flat normals; negative transforms; and fixed-capacity thin-instance pools —
the capacity is established when the pool is set and the matrix array stays
aliased, so flush and count updates re-read it per frame. An array the caller
builds at the call site is bound to a name first, because the pool keeps
referencing it for the whole frame loop; one built inside a block refuses,
since the binding would not outlive it.

A **line system** is one of those meshes rather than a renderer of its own.
`createLineSystem` concatenates its polylines into a single indexed mesh —
all points in line order, an index pair per segment, no index joining one
line to the next, and one zero normal per vertex because the shared mesh
uploader requires the buffer while the line shader binds no normal — and
draws it with the `ShaderMaterial` `createLineMaterial` builds, whose
`_topology` is `"line-list"`. Everything after that is the shader-material
path: `updateLineSystem` rewrites positions and colours over an unchanged
connectivity (a changed line or point count refuses, as upstream throws),
and `setThinInstanceColors` binds the per-instance RGBA stream a material
created with `useThinInstanceColors` reads. The colour precedence is the
pin's own: vertex colours, instance colours, their product, or the
`lineColor` uniform. `createLines`, `createDashedLines`,
`updateDashedLines` and `setLineMaterialColor` are unreached and refuse by
name, as does a line system whose material's vertex-colour setting
disagrees with its geometry.

### Lights

Directional, hemispheric, point, and spot lights with diffuse and specular
colors. Standard surfaces shade through the pin's own composed fragment,
which declares `array<LightEntry, MAX_LIGHTS>` and walks
`min(mesh.lc, MAX_LIGHTS)` of it — light count, kind dispatch, and the
per-mesh light sets an asset names are all run-time UBO data, written by the
pin's own per-kind light writers. `MAX_LIGHTS` is the pin's frozen 16; an
asset carrying more punctual light nodes refuses at generation where
upstream would grow the constant. Spot cones shade under the pinned
cosine-and-exponent falloff on Standard surfaces and the physical falloff in
the PBR extra lights. PBR carries two analytic slots in single-light mode;
under multi-light the second analytic slot is deliberately empty and every
light past the primary is walked by the pin's own `min(mesh.lc, MAX_LIGHTS)`
loop over the same lights buffer.

### Materials and material state

Standard, PBR, and GridMaterial records, no-color material views, Standard
cotangent-frame normal maps, PBR vertex colors and the Standard RGB ones
behind `enableStandardVertexColors`, the opt-in `setPbrUnlit`, `setPbrSkybox`,
`setPbrEmissive`, `setPbrClearCoat`, `setPbrSheen` and `setPbrIridescence`
setters, and scene-local custom shader variants driven through their reflected
uniform offsets. A setter stamps the material the call names, so a scene
carrying several scene-code materials reaches each of them independently.

A Standard material's `diffuseTexture` also takes a colour render target,
which is how one pass displays another's output. The pin hands that
attachment back carrying `invertY: true` and reads exactly that property to
build the material's UV block, so the slot samples V-flipped — where a
loaded image carries no such property and is flipped at upload instead.
A `createTexture2DFromPixels` texture is the second source the slot takes:
upstream has one `Texture2D` whatever built it, so the record copies the
texels, the sampler and the texture-object properties across, and the
already-decoded arm of the shared upload reads them straight through. A
loaded image — an ordinary one, a KTX container or a transcoded Basis file —
is the third, and travels whole for the same reason: the sampler, the upload
flip and the texture-object `invertY` the UV block reads are the texture's
rather than the slot's. `setStandardEmissiveTexture` takes an image too, and
the composed variant follows: only a render target carries the pin's
`_sampleType === "depth"`, which is what selects the extension's
unfilterable-float binding. Three sources still refuse by name with a source
location: a depth-only render target is the wrong *aspect*, because the pin
gives that arm the opposite flip and a different sampler; a geometry task's
attachment is the wrong *source*, owned by a pass rather than by the scene;
and an image whose own `srgb` option is set is the wrong *encoding*, since
the slot's is the material family's.

`enableMaterialUvTransform(material)` marks a hand-built Standard material
for independent per-texture transforms, which is the pin's own opt-in for its
ninth Standard extension. The mark is the whole native contract: it is what
`stdUvTransformExt._meshFeatures` reads back, so it joins the composed
variant key, and the extension's own uniform block — one 2x2 matrix plus a
translation per texture channel, in the pin's fixed diffuse/emissive/bump/
specular/ambient/lightmap/opacity order — is filled by that module's own
writer over the `uScale`, `vScale`, `uOffset`, `vOffset`, `uAng` and
`invertY` the scene wrote on each texture. A material nothing marks composes
exactly what it always did.

A shader material also takes the two remaining halves of its own program.
Its `samplers` become the pin's own `<name>` / `<name>Sampler` pair, every
one declared as the pin declares it and re-homed into this backend's
fragment texture group, bound per material by `setShaderTexture`. Which
pairs the compiled stage keeps, and at which registers, is the caller's own
WGSL to decide — a sampler read only inside a branch a define folds away is
dropped and the registers behind it move up — so SDL_GPU binds by the
`.slots` sidecar the compaction pass publishes, resolving each surviving
register back to the slot the material stored, exactly as the composed
material families do. Dawn compiles the deployed WGSL directly, where the
declared order is the binding order. Its `defines` become the module-scope
WGSL `const` declarations the pin's own prelude writes — WGSL has no
preprocessor, so a define is a constant the shader compiler folds a branch
against, and the set is part of the program's identity rather than per-draw
state.

A shader material also states the primitive its pipeline is built at. The
pin resolves `material._topology ?? "triangle-list"` inside its own pipeline
builder and keys its cache on it, so the topology travels with the program
rather than with a draw; the line family is the one reached material that
names the second one, and both backends translate the same generated
enumerator.

Material state written and read per frame: alpha mask/blend/coverage,
reflectance, emissive strength, lighting intensities, double-sided, normal
scale, shared texture scaling, transmission, IOR, volume, dispersion,
clearcoat, sheen, iridescence, anisotropy, and the spec-gloss workflow
replacement.

### Node materials

A node material is a graph, not a shader. `parseNodeMaterialFromSnippet`
parses a Babylon NME document, walks it from its two output blocks through one
emitter per block class, and wraps the two bodies into the module the browser
compiles — a hundred and three emitters, which are the graph's semantics rather
than a formula to restate.

**Compile time: the whole compiler.** Generation runs that entry point against
a recording device, so what deploys is the module the pin built for this
graph: its WGSL, the layout of the uniform block its named inputs produced,
the vertex inputs it declares, and its cull state. The block's bytes are
folded from the graph's own defaults, because a scene changing one would go
through the `inputs` handles, which are not lowered.

Two routes reach a graph, because the corpus writes them both ways. A module
exporting the document as a literal is read as data — the fold, and the one to
prefer, since a literal cannot drift. A module that *builds* its graph at load
from id counters, spread-composed inputs and arrays it pushes into is code
this compiler does not lower, so it is executed instead. That one runs under
Node rather than in headless Chromium, which is the difference between this
and the two executed asset kinds beside it: those produce *pixels*, so they
run where the golden runs them and record an adaptation for it, while a graph
is structure — an object of numbers, strings and arrays that no two ECMAScript
engines can disagree about.

**Run time: the draw.** A node draw binds the pin's own group scheme — the
per-pass scene block and lights in group 0, the graph's mesh block and uniform
block in group 1 — and both backends execute the compiled stages, entered at
the pin's own `vs_main`/`fs_main`.

The reached slice covers the scene's lights and its environment. Both are
resources the port already holds for the material families — the lights array
at the group-0 slot all three composed families share, and the specular cube
and BRDF LUT the pin's own `node-env.ts` binds from the scene's
`EnvironmentTextures` — so a graph reaching them declares bindings rather than
needing anything new. The five PBR layer blocks (clearcoat, sheen,
anisotropy, iridescence, subsurface) declare nothing at all: each changes what
`PBRMetallicRoughnessBlock` composes and the module binds the same resources
either way.

`FragDepthBlock` composes too: a graph writing `@builtin(frag_depth)` puts
the depth *convention* into its own output, and both backends render under
the pin's ([fidelity](fidelity.md#shader-contract)).

A graph may also sample textures. `TextureBlock` and `ImageSourceBlock` each
declare a binding named after the block, and the pin's own pipeline builder
allocates the group-1 texture/sampler pair for it out of the same running
counter the node UBO and the environment take — so the pair belongs to the
composition rather than to any ordering this port could choose. What the
scene supplies is the image, under that binding's name
(`parseNodeMaterialFromSnippet`'s `textures` record), and generation joins the
two: a binding the record omits, or a name the graph declares no binding for,
refuses at generation where upstream raises it at the first render.

What refuses at generation, naming the block that reached it: morph targets,
shadows, clip planes and the mesh-attribute test. A graph fetched by snippet
id refuses too, because the fetch is a network read at page load, and a graph
handed its own `blockLoader` refuses because that function is scene code
deciding which emitter serves each block class.

### Animation playback

Deterministic scene-level seeking over two separate runtimes: property
animation clips and groups over position, `position.x`, scaling and
quaternion paths with LINEAR/STEP tracks, ranges, looping and speed ratios;
and glTF LINEAR/CUBICSPLINE transform channels with LINEAR morph weights.
A glTF file's animations arrive as one group each, in the document's order,
reachable as `scene.animationGroups` and by name: upstream starts only the
first and loops each over its own length, so `playAnimation`,
`pauseAnimation`, `stopAnimation`, `goToFrame` and `loopAnimation` select
among clips of different durations.

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

### Sprites

Pure-2D `depth: "none"` layers drawn by their own sprite renderer with no
scene at all: the frame grid derived at load from the decoded atlas,
per-sprite instance writes, and the straight-alpha blend, on both GPU
backends from one generated WGSL pair. The pinned renderer split and
instance layout are in [fidelity](fidelity.md#shader-contract).

A layer opts into per-sprite UV scroll by setting an offset: the first
`setSprite2DUvOffset` widens that layer's instance layout in place, adds the
attribute the pin stashes for it, and selects the shader variant that adds the
offset to the sampled UV. The widening is per layer, so a pipeline describes a
layer's layout rather than its renderer's, and a scene that never scrolls
keeps the narrow layout. The atlas address modes a tiling scroll needs come
through `textureOptions`, which the pin spreads over the loader's own
defaults.

Either family may draw with a custom fragment shader. The caller supplies a
WGSL body; the pin's own composer wraps it in the stage the engine owns, and
generation folds that composer rather than assembling a second one, so the
program is the pin's around the caller's text. Building the descriptor is the
opt-in — upstream it registers the hook the always-loaded path reaches the
feature through — and a layer or system without one draws the stock shader.
The `fx` block a body may read (`fx.time`, and the `fx.params` vec4 the
per-family setter writes) binds beside the family's own block, declared
whether or not the body names it, as upstream declares it. What the body does
NOT read still matters: a block nothing reads does not survive to the compiled
shader, and SDL_GPU takes uniform buffers by dense slot. Which blocks a stage
kept, and at which slots, is read from the sidecar the shader step writes
beside that stage — the same one the pinned material variants bind through,
written by both of its compaction passes. The compiled artifact answers it;
nothing infers it from the WGSL. A scene whose every layer or
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

### Physics

Rigid-body simulation, and the one family here whose numbers are not the
pin's. It is worth reading the split before the feature list, because the
split is the whole design.

**The pin already drew the boundary.** `createHavokWorld(scene, hknp)` takes
the solver as a *parameter* and every call the pinned physics layer makes on
it is an `HP_*` entry point, so `src/physics/havok.ts` is not "the Havok
integration" — it is Babylon's rigid-body semantics written against a fixed
back-end surface. That splits exactly along this repository's ownership rule:

- **Generated**, lowered from the pinned module: the world record and its
  body list, the step gate (`_fixedDeltaMs > 0 ? _fixedDeltaMs : deltaMs`,
  the non-finite rejection, and the `Math.min(stepMs, MAX_STEP_MS) / 1000`
  tunnelling clamp), the four phases of a frame in order (pre-step node→body
  sync, step, post-step body→node sync, after-step callbacks), the
  aggregate's own ordering, and the shape parameters derived from the mesh's
  bounds. Every constant is read from the pinned declaration rather than
  restated, so a bump that moves one moves what is emitted.
- **PAL**, `native/include/bblite/pal_physics.hpp` and one implementation
  translation unit: the `HP_*` surface itself. That is a third-party library
  behind a fixed entry-point list, which is the role SDL already plays.

**The solver is Bullet, and that is the divergence.** The Havok WASM module
is a proprietary binary this project cannot redistribute; Bullet is Zlib.
Nothing generated names a solver, so a different implementation is a
different translation unit — but two rigid-body solvers integrate different
contact models, so a body's pose after N steps is a *different number*
rather than a rounding of the same one. This is the only adaptation in the
repository that is not bit-faithful by construction, it is recorded per
scene as `substituted-physics-solver`, and it is why a physics scene cannot
carry a pixel threshold against a Havok golden at a moving pose. What it can
be measured by is a trajectory, plus a pixel comparison at rest, where the
configuration is static and phase drops out — and there the two solvers
agree to 16 pixels in 921,600 ([fidelity](fidelity.md#physics-contract)).

`@babylonjs/havok` is a **browser-only devDependency**: the capture harness
serves it to the reference page so a physics scene has a golden at all. It
is never linked, never shipped, and reaches nothing in the native binary —
`await HavokPhysics(...)` compiles to nothing, and the solver a build links
is selected by the `physics:world` feature.

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
Every one in the corpus pins its measured pose the same way: it counts
steps in `onPhysicsAfterStep`, and at the step its `?captureFrame=` query
names it calls `stopEngine` from a zero-delay `setTimeout`. Both halves are
reached rather than erased, because both have a native meaning:

- **`stopEngine`** is a flag the frame conductor reads. The pin cancels its
  animation frame and clears `_renderFn`, so nothing further submits; here
  nothing further *advances* — the conductor stops running the scene's
  callbacks and keeps presenting the frozen frame only while a capture is
  still pending, which is how a screenshot lands on it exactly as the
  browser harness takes one off the frozen canvas.
- **`setTimeout(callback, 0)`** is a one-shot deferred callback the
  conductor drains after the frame's own callbacks — the same boundary a
  browser runs a zero-delay timeout at. Seventeen of the corpus's
  twenty-one call sites pass a delay of exactly 0, which is the reached
  slice; the four real waits (scenes 44, 48, 156 and 173) refuse rather
  than being rounded to the next frame, which would be a different scene.
  Babylon Native, which embeds a JavaScript engine and must serve any
  delay, needs a timer thread and a time-ordered queue for this; none of
  that applies where the frame conductor is the only thread.

Without those two the scene runs free and the two sides are at different
steps, which makes any pixel comparison meaningless. With them, both sides
stop at the same physics step.

Everything else in the pinned physics layer refuses at generation naming
what it reached: mesh and convex-hull shapes (the pin's own mesh
accumulator), containers, heightfields, constraints, queries, triggers,
collision events, the character controller, the debug viewer, floating
origin, and every body control past creation.

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

### Post-process passes

Every post-process Babylon Lite ships is one `createPostProcessTask`: a
fullscreen triangle over a single-sample source texture, a bind group of
sampler, source view, the effect's extra views and its optional uniform block,
and an output that is either the target the caller named or one the pass makes
from the source's own descriptor. Blur, chromatic aberration, black and white,
the red/cyan anaglyph and the circle of confusion are reached; each contributes
only a shader record and a `writeUniforms` body.

A **composite** — depth of field — is one entry point that builds a chain of
those passes over intermediate targets it owns, and the caller still sees one
task: one `addTask`, one `updateUniforms`, one output. Which passes, in what
order, over which textures and at which sizes is decided entirely by its
config, so generation runs the pin's own factory and emits the chain it built.
Nothing about depth of field is written into this port: its eight passes and
seven intermediates are what the factory made, its pass names derive from the
name the scene gave the task, and the entry points it builds through are
`@internal` in the pin and refused at a scene's call site here for the same
reason.

An intermediate is sized as a fraction of the source — the blur pyramid runs
at 0.75, 0.375 and 0.1875 — re-evaluated whenever the frame graph is built, so
a window resize moves the whole chain with it. The fractions are not read off
one run: generation composes twice against sources of different sizes and
formats, and refuses any extent a single fraction does not reproduce exactly.

**Compile time: the stage.** The effect's factory runs under Node against a
descriptor-only render target and the pin's own `getShaderModule` concatenates
the module — so what deploys is the text the browser compiles, for the options
this scene passed. That matters most for the blur, whose text is not fixed at
all: its kernel decides how many taps the vertex stage carries, and each tap's
offset and weight is a Gaussian evaluated in doubles and printed through the
pin's own formatter. Both stages live in one module, so it deploys twice — once
per entry point — and SDL_GPU re-addresses the pin's groups exactly as it does
for a composed material variant. What identifies a module is that text and not
the pass that reached it: a blur pair differing only in its `direction` uniform
composes one module and deploys it once.

**Run time: the pass.** The parameters live on the task record and
`updateUniforms` marks them for rewrite, which is the pin's own split between
mutating a parameter and uploading the block. The uniform bytes are written by
a generated writer lowered from each effect's own `writeUniforms`, so a pass
whose values depend on the attachments — the blur's per-pixel delta, the
chromatic aberration's screen size — reads them from the real targets. A
normalized viewport becomes the pin's own pixel rectangle, which rounds its far
edges *up* where a frame-graph copy task rounds them down, so the two do not
share a resolver.

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
fragment, so generation lifts that constant out of the pinned module and
performs the same concatenation. Both entry points live in the one module, so
it deploys twice — once per stage — exactly as a post-process module does. The
bind-group layout is the descriptor's `bindings` array rather than anything
reflected out of the WGSL, which is why it travels to the generated table
whole; a sampler's `textureBinding` is resolved to the texture binding it
samples through at generation, so the runtime reads one number where the pin
runs a lookup with a fallback.

**Run time: the pass.** Two entry points draw the same pair of halves. An
`EffectRenderer` is its own rendering context, so a scene registering one and
no `SceneContext` compiles no scene renderer and draws from a translation unit
of its own — the same split a `SpriteRenderer` already takes, and for the same
reason. A `createEffectRenderTask` is a frame-graph task into a
`RenderTarget` the caller made, which a Standard material can then sample as
its diffuse texture. Either way the pipeline is built against the *output
target's* format and sample count, which is what the pin's own
`targetSignatureKey` cache is keyed by.

What refuses at generation, by name: a custom `vertexWGSL`, a `blend` state,
the `EffectRenderer`'s per-frame `update` callback, the per-binding record
form of `setEffectUniforms`, an effect texture from anything but
`createSolidTexture2D`, and every `EffectBindingLayout` field past the five
the corpus writes (`visibility`, `textureSampleType`, `viewDimension`,
`samplerType`). The `UniformEffectWrapper` family — the pin's smaller
uniform-only path — is unreached and unlowered.

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

`removeFromScene` with render-plan rematching, material-family append after
registration, thin-instance flush and count updates, and mesh appends that
wait for submitted work before rebuilding the mesh set.

### Diagnostics and capture

Screenshot and benchmark modes, draw-ID and triangle-cluster buffers,
deformation dumps, the render capture that writes the
frame's whole CPU-side description for diffing against the browser
([debugging](debugging.md)), and the build stamp the parity harness checks
before it trusts a measurement.

## Where the boundary falls inside a family

| Family | Compile time | Run time |
| --- | --- | --- |
| glTF assets | download, Draco/meshopt decode, upstream feature-predicate specialization, capability defines | parse, build meshes/materials/skins, deindex, strip expansion, upload |
| Environments | HDR and DDS packaged (GGX prefilter, SH projection); BRDF LUT integrated | `.env` parsed, RGBD decoded, cubes uploaded and sampled |
| Shaders | composition, specialization and reflection for both backends, plus DXIL/SPIR-V/MSL for SDL_GPU | Dawn's embedded Tint and DXC compile the same WGSL at startup; pipelines built lazily per kind |
| Sprites | the atlas image executed and baked | the frame grid derived from it, instance writes, the pass, the billboard sort |
| Node particles | the graph parsed, built and simulated by the pin, its particle state baked | nothing of the simulation; the billboard or Sprite2D layers it folds to draw like any others |
| Animation | property clips and groups lowered to typed records | glTF channel data read from the asset; all evaluation and seeking |
| Deformation | which vertex layout and shader variant exist, from the asset | joint palettes, morph weights, skinning and morphing, post-deformation face normals |
| Lights | which light-kind writers and `light_*.cpp` units exist | the lights buffer, per-mesh light sets, uniforms |
| Textures | which image codecs link and ship | decode, mip generation, factor texels, sampler state |
| Compressed textures | which container the device's formats select, and a Basis file transcoded into one | the container parsed, its blocks uploaded, its own chain sampled |
| Post-process passes | each effect's composed stage, for the options the scene passed | the pass, its uniform block, its viewport rectangle and its blend |
| Node materials | the graph compiled to a module by the pin's own emitter, its uniform block folded to the graph's defaults | the draw, its mesh block, the textures the scene supplied, and the per-mesh light selection that block carries |
| Fullscreen effects | the caller's fragment wrapped in the pin's own vertex stage, and the bind-group layout the descriptor declared | the pass, its uniform bytes, and the textures the scene bound |

## Knobs

The same split applies to the switches.

**Compile-time** (CMake cache values and generation output; see
[development](development.md#build-switches)): `BBLITE_GENERATED_DIR`,
`BBLITE_BACKEND` (which backends are compiled in at all), `BBLITE_DAWN_DIR`,
`BBLITE_SDL_DIR`, `BBLITE_MINSIZE`, `VCPKG_TARGET_TRIPLET`, and the
generated `BBLITE_IMAGE_CODECS`.

**Run-time** (environment variables; see
[development](development.md#runtime-switches)): `BBLITE_GPU_BACKEND`,
`BBLITE_GPU_DEBUG`,
`BBLITE_MSAA`, `BBLITE_BACKGROUND`, `BBLITE_GROUND`, `BBLITE_MAX_FRAMES`,
`BBLITE_SCREENSHOT(_FRAME)`, `BBLITE_BENCHMARK_FRAMES`,
`BBLITE_ANIMATION_SEEK_SECONDS`, `BBLITE_ASSET_DIR`, `BBLITE_GPU_SHADER_DIR`,
`BBLITE_DEFORMATION_DUMP`, `BBLITE_RENDER_CAPTURE`, and
`BBLITE_BUILD_STAMP_OUT`.

Requested environment grounds and DDS/HDR/solid-colour skyboxes render by
default and are disabled independently with `BBLITE_GROUND=0` and
`BBLITE_BACKGROUND=0`. Which skybox arm a scene gets is decided at generation
from the two URLs and the pinned `skipSkybox` flag
([fidelity](fidelity.md#shader-contract) carries the three-way rule).

## Boundaries

Almost every boundary is enforced at generation: an unsupported feature is a
build error with a source location, not a silently different image.

### Rejected at generation

- one statically analyzable entry file and one engine; selected TypeScript
  expressions, assignments, callbacks, and intrinsics
- no arbitrary object graphs, run-time object identity, or run-time module
  loading. A class instance is a compile-time record that cannot be stored in
  data or selected at run time, and a field holding a resource is wired once
  rather than reassigned. Recursion, inheritance, statics, and value-returning
  methods stay rejected
- the plain-data model is value-semantic apart from const locals bound to a
  container element or member, which bind a native reference; object
  parameters pass by native reference; `new Array` elements zero-initialize;
  and `Math.random` is the pinned seeded sequence — each recorded in
  `fidelity.json`
- no audio or networking. Physics is reached, behind a substituted solver
  ([below](#physics))
- property animation covers LINEAR/STEP scalar and vector tracks, quaternion
  slerp, group ranges/looping/speed, and deterministic seeking for the reached
  mesh `position`, `position.x`, `scaling`, and `rotationQuaternion` paths
- glTF animation covers LINEAR/CUBICSPLINE rotation, translation, and scale
  plus LINEAR morph weights, one addressable group per declared animation.
  glTF STEP channels, a group's speed ratio, weight and mask, and broader
  property targets remain unsupported
- direct `createMorphTargets` covers one target attached to one mesh
- a spot light created in scene code carries its colors and intensity; its
  `angle`, `exponent`, and `range` setters fail explicitly
- a directional light's `position` and a spot light's `position` and
  `direction` are settable after creation through the pin's own
  `ObservableVec3.set`, which rebuilds that kind's local matrix; the vectors
  no reached scene writes stay unlowered and fail by name
- scene fog is ported for PBR, Standard, and image-skybox surfaces; fog
  composed with Grid, custom-shader, environment-ground/DDS-skybox background,
  transmission, or geometry-output surfaces fails explicitly
- PBR material extensions cover clearcoat, sheen, iridescence, anisotropy,
  dispersion, and the spec-gloss workflow replacement with one shared UV
  transform. Anisotropy carries the layer's own parameters; its per-layer
  texture and its UV transform are not reached, and the pinned writer's own
  early return drops that arm from the emitted writer rather than leaving it
  to a run-time branch. Specular textures remain unsupported, and an asset
  carrying an extension the pinned loader implements that this port does not
  fails at generation naming it
- a compressed texture is a KTX1 container or a Basis file loaded from scene
  code. Neither loader's sampler options are lowered, because the reached
  calls pass none; a `loadKtxTexture2D` whose suffixes are not an array
  literal, or whose listed suffixes name no block-compression format, fails
  at generation, as does a KTX file whose `glInternalFormat` is outside that
  table. KTX2 — the container `KHR_texture_basisu` redirects a glTF texture
  to — needs the pin's second decoder and is unreached
- custom shader variants are bounded by the supported WGSL subset and the
  `world`, `viewProjection` and `worldViewProjection` system uniforms,
  which head a stage's block in declaration order. The pin's other six
  (`view`, `projection`, `worldView`, `cameraPosition`, `screenSize`,
  `alphaCutoff`), matrix-valued custom uniforms, and a stage reading both a
  system and a custom uniform all remain unsupported. A sampler is named by a
  string and binds a 2D float texture, loaded by `loadTexture2D`, in the
  fragment stage: a typed `ShaderSamplerDecl`, a depth or comparison
  sampler, a `2d-array` view, a sampler the vertex stage reads (SDL_GPU
  gives a vertex texture its own register space), a fifth sampler (the
  fifth pair of the shared mesh texture group is the reflection cube) and
  a texture from anywhere but `loadTexture2D` all fail by name, as do
  storage buffers
- a node material graph is taken inline; a snippet id fetches it from the
  snippet server at page load and fails. The graph itself is read as a JSON
  literal or executed as the module that builds it, and every block outside
  the reached slice — morph targets, shadows, clip planes, the
  mesh-attribute test and alpha blending — refuses at generation naming the
  block that reached it. An executed graph module may import its own relative
  siblings, which is how the corpus composes one document out of another; a
  package import refuses, because that is the boundary keeping the route to
  plain data
- an asset carrying more punctual light nodes than the pinned `MAX_LIGHTS`
  (16) fails, where upstream grows the constant at run time
- a scene-code mesh or PBR material created before a later glTF load fails,
  because it would interleave the variant table's creation-order key
- an orthographic camera composed with an environment skybox or ground fails,
  because those build their own perspective view-projection
- a skin larger than the transcribed vertex stage's 64-matrix bone palette,
  in a scene composing no pinned skeleton variant, fails naming the joint
  count and the transport. Deformation runs on the GPU or not at all, so
  the palette is a bound rather than a slow path; the generated loader
  keeps the same check as the `BBLITE_ASSET_DIR` defense

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
