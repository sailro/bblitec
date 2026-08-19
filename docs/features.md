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
   of the executable entirely. The Dawn backend is the deliberate exception —
   it ships a shader compiler on purpose, and
   [why](#stage-2-compiling-wgsl-for-the-device) is the sharpest illustration
   of what these forces trade against.
4. **No dynamic module loading.** Upstream's `import()`-behind-a-predicate
   feature registry has no native equivalent, so the same predicates are
   evaluated at generation. This is what preserves tree shaking: a scene that
   reaches nothing carries nothing.
5. **The answer is decided entirely by the asset or the source.** Nothing at
   run time can change a DDS file's irradiance harmonics or which material
   families a scene declares, so computing them once is not an optimization —
   it is where the information already lives.

The counterweight matters as much. **Bytes the browser produced are baked;
decisions the loader can make are not.** The sprite frame table is derived at
run time from the decoded atlas, so a changed atlas needs no compiler change.
An unset skybox size is passed through as zero for the generated loader to
resolve, rather than substituted by the compiler. Mip chains, factor texels,
and samplers are built at upload. Each of those could have been folded and was
deliberately left live.

## Feature map

| Feature family | Phase | Summary |
| --- | --- | --- |
| [Program compilation](#program-compilation) | Compile | the TypeScript subset, the plain-data model, browser erasure, AOT promises |
| [Feature and capability selection](#feature-and-capability-selection) | Compile | which generated modules, shader variants, codecs, and capability defines exist at all |
| [Asset materialization](#asset-materialization) | Compile | every reached remote URL downloaded into the generated tree |
| [Compressed geometry](#compressed-geometry) | Compile | Draco and meshopt decoded to ordinary geometry |
| [Environment compilation](#environment-compilation) | Compile | HDR and DDS cubemaps, GGX prefiltering, SH projection, BRDF LUT |
| [Drawn assets](#drawn-assets) | Compile | canvas2D sprite atlases executed and baked to PNG |
| [Shader pipeline](#shader-pipeline) | Compile → Run | composed and specialized at generation; compiled offline for SDL_GPU, in-process by Dawn |
| [Engine, scene, and frame loop](#engine-scene-and-frame-loop) | Run | registration, fixed delta, before-render callbacks, frame gates |
| [Cameras and input](#cameras-and-input) | Run | ArcRotate/Free, default framing, orthographic opt-in, SDL controls |
| [Asset loading and upload](#asset-loading-and-upload) | Run | glTF/`.babylon`/`.env` parsing, image decode, mips, samplers |
| [Geometry and meshes](#geometry-and-meshes) | Run | primitives, typed-array meshes, thin instances, transforms |
| [Lights](#lights) | Run | directional, hemispheric, point, spot; per-mesh light sets |
| [Materials and material state](#materials-and-material-state) | Run | Standard, PBR, Grid, no-color views, alpha and extension state |
| [Animation playback](#animation-playback) | Run | deterministic seeking, property clips, glTF channels |
| [Deformation and instancing](#deformation-and-instancing) | Run | GPU skinning, morph targets, storage morphing, GPU instancing |
| [Sprites](#sprites) | Run | frame derivation, per-sprite instances, the pure-2D pass, world-space facing billboards |
| [Frame graph](#frame-graph) | Run | render targets, tasks, geometry MRTs, blits, MSAA resolve |
| [Render backends](#render-backends) | Run | SDL_GPU, Dawn, CPU fallback, transmission, image processing |
| [Runtime scene mutation](#runtime-scene-mutation) | Run | removal with plan rematching, material-family append, instance counts |
| [Diagnostics and capture](#diagnostics-and-capture) | Run | screenshots, benchmarks, attribution buffers |

Eight families have work on both sides of the line — the shader pipeline most
sharply, since its second stage changes phase with the backend. Where the cut
falls in each is
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
  materialized asset resolves immediately.

**Why compile time:** this is the compiler. There is no interpreter, no
run-time module loading, and no run-time object identity — a compile-time
record has no native representation to store or select between, so it cannot
outlive generation. Static evaluation and inlining are how the subset reaches
C++ at all. Each divergence this introduces is recorded per scene in
`fidelity.json` (`plain-data-value-model`, `deterministic-seeded-random`,
`entry-main-wrapper-erasure`, `synchronous-aot-await`).

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
without a setter has only the capability (dispersion).

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

### Environment compilation

Three environment routes exist and they do not split the same way, which makes
this family the clearest illustration of the rule:

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

### Drawn assets

A sprite atlas that is *drawn* rather than fetched is executed at generation:
the pinned module is served from a local server, its exported factory is
called in headless Chromium, and the PNG its data URL carries is baked as a
generated asset.

**Why compile time:** there is no file to download and no formula to port. The
atlas is built with canvas2D — rotated wedges, `arc`, `hsl` — so its pixels
are a browser rasterizer's antialiasing rather than an expression. It is
executed, not reimplemented. The tradeoff is the HDR prefilter's and is the
same one: the baked bytes depend on the Chrome that compiled them, which is
recorded per scene as `drawn-sprite-atlas`. The frame grid is **not** baked
with them — see [the boundary table](#where-the-boundary-falls-inside-a-family).

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

**Why Dawn's half is legitimately run time, and deliberate:** Dawn is the
browser's own WebGPU implementation and carries Tint and DXC *inside* it — the
same components the offline path invokes as tools. Compiling at startup is not
a shortcut around the offline step; it is the parity mechanism. The goldens
were produced by that stack, so running it in-process removes the
offline-versus-browser compile split rather than adapting to it, which is why
Dawn is bit-exact on scenes where SDL_GPU carries DXC-versus-browser rounding.
The identity of that compiler is measurable, not assumed: a Dawn built without
`DAWN_USE_BUILT_DXC` falls back to FXC and puts a systemic one-LSB error on lit
surfaces, which disappears with DXC.

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

### Geometry and meshes

Box, sphere, subdivided ground, plane, and torus primitives;
`createMeshFromData` typed-array meshes; indexed glTF/GLB and `.babylon`
geometry; glTF triangle-list and triangle-strip primitive modes; generated and
flat normals; negative transforms; and fixed-capacity thin-instance pools —
the capacity is established when the pool is set and the matrix array stays
aliased, so flush and count updates re-read it per frame.

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

Material state written and read per frame: alpha mask/blend/coverage,
reflectance, emissive strength, lighting intensities, double-sided, normal
scale, shared texture scaling, transmission, IOR, volume, dispersion,
clearcoat, sheen, and iridescence.

### Animation playback

Deterministic scene-level seeking over two separate runtimes: property
animation clips and groups over position, `position.x`, scaling and
quaternion paths with LINEAR/STEP tracks, ranges, looping and speed ratios;
and glTF LINEAR/CUBICSPLINE transform channels with LINEAR morph weights.
A glTF file's animations arrive as one group each, in the document's order,
reachable as `scene.animationGroups` and by name: upstream starts only the
first and loops each over its own length, so `playAnimation`,
`pauseAnimation`, `stopAnimation` and `goToFrame` select among clips of
different durations.

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
normals. Morph deltas apply before skinning. Two narrow CPU fallbacks remain:
skins beyond 64 joints, and face-normal recomputation for primitives with no
source normals.

### Sprites

Pure-2D `depth: "none"` layers drawn by their own sprite renderer with no
scene at all: the frame grid derived at load from the decoded atlas,
per-sprite instance writes, and the straight-alpha blend, on both GPU
backends from one generated WGSL pair. The pinned renderer split and
instance layout are in [fidelity](fidelity.md#shader-contract).

Camera-facing world-space billboards share that atlas and nothing else. A
billboard system is a scene renderable rather than a renderer of its own: it
draws at the end of the scene's pass, expanding its quad around a basis taken
from the scene camera and testing against the depth the scene wrote, so a
billboard occludes and is occluded by geometry. Because the transparent modes
write no depth, the back-to-front sort by view depth IS the composite, and it
runs every frame. Any of the pin's blend descriptors that names a colour
blend is lowered as data — straight alpha, premultiplied, additive and
one-one — while `billboardBlendCutout`, the axis-locked orientation, custom
shaders and alpha-to-coverage refuse at the call.

### Frame graph

Render targets and tasks, material overrides, depth-only passes, 7+4 geometry
MRTs, blits, and MSAA resolve, with Babylon Lite's double-precision viewport
coordinates floored to integer bounds and applied as a scissor.

### Render backends

Two peer GPU backends render the same generated plans and are selected at run
time in a build that compiled both (`BBLITE_GPU_BACKEND=dawn`; SDL_GPU is the
default), plus a deterministic SDL_Renderer CPU fallback. They do not start the
same way: SDL_GPU loads content-addressed offline binaries and does no shader
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
| Animation | property clips and groups lowered to typed records | glTF channel data read from the asset; all evaluation and seeking |
| Deformation | which vertex layout and shader variant exist, from the asset | joint palettes, morph weights, skinning and morphing, CPU fallbacks |
| Lights | which light-kind writers and `light_*.cpp` units exist | the lights buffer, per-mesh light sets, uniforms |
| Textures | which image codecs link and ship | decode, mip generation, factor texels, sampler state |

## Knobs

The same split applies to the switches, and mixing them up is the usual cause
of a measurement that does not mean what it looks like.

**Compile-time** (CMake cache values and generation output; see
[development](development.md#build-switches)): `BBLITE_GENERATED_DIR`,
`BBLITE_BACKEND` (which backends are compiled in at all), `BBLITE_DAWN_DIR`,
`BBLITE_SDL_DIR`, `BBLITE_MINSIZE`, `BBLITE_CPU_FALLBACK`,
`VCPKG_TARGET_TRIPLET`, and the generated `BBLITE_IMAGE_CODECS`.

**Run-time** (environment variables; see
[development](development.md#runtime-switches)): `BBLITE_GPU`,
`BBLITE_GPU_BACKEND`, `BBLITE_GPU_REQUIRED`, `BBLITE_GPU_DEBUG`,
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

Almost every boundary is enforced at generation, which is the point: an
unsupported feature is a build error with a source location, not a silently
different image.

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
- no physics, audio, or networking
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
- scene fog is ported for PBR, Standard, and image-skybox surfaces; fog
  composed with Grid, custom-shader, environment-ground/DDS-skybox background,
  transmission, or geometry-output surfaces fails explicitly
- PBR material extensions cover clearcoat, sheen, iridescence, and dispersion
  with one shared UV transform; specular textures and anisotropy remain
  unsupported, and an asset carrying an extension the pinned loader
  implements that this port does not fails at generation naming it
- custom shader variants are bounded by the supported WGSL subset and the
  `worldViewProjection` system uniform; arbitrary system-uniform sets and
  matrix-valued custom uniforms remain unsupported
- an asset carrying more punctual light nodes than the pinned `MAX_LIGHTS`
  (16) fails, where upstream grows the constant at run time
- a scene-code mesh or PBR material created before a later glTF load fails,
  because it would interleave the variant table's creation-order key
- an orthographic camera composed with an environment skybox or ground fails,
  because those build their own perspective view-projection

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
([backends](backends.md#honest-comparison)).

---

Every feature above is generated from the pinned upstream release. Unfinished
work is tracked only in [TODO](../TODO.md); measured results are in
[status](status.md).
