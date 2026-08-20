# Architecture

## Pipeline

```text
scene TypeScript
    -> AST validation and browser erasure
    -> reached features and materialized assets
    -> pinned Babylon Lite source reconstruction
    -> dedicated lowerers
    -> generated C++20, shaders, manifests, provenance
    -> typed runtime + PAL
    -> SDL3 + (SDL_GPU | Dawn)
```

`bblitec` is a compiler, not an interpreter. Unsupported syntax or Babylon APIs
produce source-located errors.

The entry frontend is built as a TypeScript `Program` with a `TypeChecker`.
Babylon intrinsics are identified by resolved import symbols, then dispatched
through focused intrinsic modules. Generated behavior must never depend on
scene names or regular-expression matching of entry-source text.

The repository pins one reviewed Babylon Lite package and source commit, in
`upstream/babylon-lite.json`. Original TypeScript is recovered from published
source maps. Lowerers assert expected upstream symbols, constants, and
formulas before emitting code.

## Ownership

| Layer | Owns |
| --- | --- |
| Entry compiler | AST validation, feature selection, assets, generated main/CMake manifest |
| Upstream lowerers | Babylon semantics, typed records, render plans, uniforms, shader variants |
| Native runtime | handles, engine-owned records, immediate AOT TypeScript/Web primitives |
| PAL | files, paths, environment, clocks, SDL window/input, GPU resources and commands |

Babylon behavior must not migrate into PAL. SDL and operating-system mechanics
must not migrate into generated code.

Primary source ownership:

| Source | Responsibility |
| --- | --- |
| `src/cli.ts` | the `bblitec` entry: one scene compile end to end — frontend, asset materialization, composition, emitters, generated tree |
| `src/compose-pipeline.ts` | the pinned variant-composition orchestration between settled assets and emitter options: scene arms, PBR/Standard variant tables, mesh-feature tables |
| `src/babylon-asset-features.ts` | the `.babylon` asset scans generation keys on: light slots, texture selections, per-light mesh lists |
| `src/feature-activation.ts` | the per-scene `upstream/feature-activation.json` activation inventory |
| `src/compiler.ts` | entry-scene AST lowering, features, assets, generated main/CMake |
| `src/compiler/program.ts` | in-memory TypeScript `Program`/`TypeChecker` frontend |
| `src/compiler/symbols.ts` | resolved Babylon import symbols and aliases |
| `src/compiler/static-evaluator.ts` | typed static scalar/vector/color expression evaluation |
| `src/compiler/expressions.ts` | the value switch and call dispatch every expression position goes through |
| `src/compiler/browser-erasure.ts` | browser-only expression identification, compile-time values, erased instrumentation |
| `src/compiler/data-types.ts` | plain-data type mapping (structs, enums, optionals, arrays, tables) and generated definition emission |
| `src/compiler/data-lowering.ts` | data paths, typed literals/sinks, container methods, runtime `Math`, aliasing contracts, destructuring |
| `src/compiler/native-functions.ts` | once-emitted real C++ functions for fully data-typed user functions |
| `src/compiler/user-functions.ts` | inline lowering for handle-touching local functions, calls, parameters, and returns |
| `src/compiler/statements.ts` | statement dispatch, conditions, expression statements, and method calls |
| `src/compiler/classes.ts` | compile-time class instances: fields as locals, inlined methods and getters |
| `src/compiler/promises.ts` | immediate AOT `Promise<T>` lowering |
| `src/compiler/assignments.ts` | typed property-assignment validation and lowering |
| `src/compiler/properties.ts` | the declared property reads: which native expression names a handle's property, and which properties are refused |
| `src/compiler/property-animation.ts` | compile-time clip/track/key lowering and group options |
| `src/compiler/shader-material.ts` | shader-material variant matching by IR identity and scene-local variant registration |
| `src/compiler/assets.ts` | asset registration from scene URLs to packaged local files |
| `src/executed-module-assets.ts` | the assets a scene module produces rather than fetches: a drawn canvas2D atlas and a computed pixel buffer, each run in headless Chromium at generation and baked |
| `src/compiler/adaptations.ts` | the reached-adaptation manifest entries generation records |
| `src/compiler/option-helpers.ts` | the shared option-object validation contracts |
| `src/compiler/intrinsics/*` | focused resolved-symbol engine, scene, asset, animation, camera, light, mesh, material, and sprite intrinsic lowerers |
| `src/compiler/types.ts` | compiler public result types and internal typed values/features |
| `src/upstream-source.ts` | pinned source-map reconstruction |
| `src/upstream-graph.ts` | conservative reachable-module analysis |
| `src/upstream-lower.ts` | lowerer orchestration, provenance, generated capabilities |
| `src/pinned-shader-composer.ts` | executes the pin's own `composeShader`, lifts named declarations out of a composition verbatim, and imports a pinned module with chosen imports observed |
| `src/pinned-post-process.ts` | runs a post-process factory and the pin's own `getShaderModule`, so a pass deploys the module the browser compiles; runs a composite's factory to learn the chain it builds |
| `src/post-process-effects.ts` | the reached effects: which options reach the composed text, which scalars the effect's writer reads, and which textures bind after the source |
| `src/pinned-pbr-variants.ts` | registers the PBR extensions in the pin's order and composes a variant |
| `src/pinned-standard-variants.ts` | the Standard sibling: derives the pin's own feature words and composes the Standard colour and geometry variants |
| `src/pinned-material-input.ts` | maps a glTF material to the shape `_computePbrMaterialFeatures` reads — the loader's own extension builders executed against a recording stub, not re-derived |
| `src/pinned-material-arms.ts` | composes every material a scene loads and refuses a fragment missing an arm one of them reaches |
| `src/pinned-scene-arms.ts` | the scene half of composition: light modes, tone mapping, fog bits |
| `src/pinned-mesh-features.ts` | the pin's mesh feature bits, imported rather than restated |
| `src/pinned-pbr-variant-cpp.ts` | the C++ mirrors of each variant's UBO layouts, offsets cross-checked against the composer's own, plus the generated variant-selector and material texture-slot tables |
| `src/pinned-pbr-variant-output.ts` | writes the composed variant stages into the generated tree verbatim |
| `src/lowering/pinned-ubo-writer-lowerer.ts` | lowers the pin's material/extension UBO writers from their own ASTs |
| `src/lowering/post-process-lowerer.ts` | the pass's own contracts — internal target, viewport rectangle, bind-group order, blend table — and each effect's `writeUniforms`, emitted from the pin's AST |
| `src/lowering/context.ts` | source-located AST declarations, expression contracts, and diagnostics |
| `src/lowering/*-lowerer.ts` | focused Babylon API and formula lowering |
| `src/lowering/templates/` | the generated `.babylon`/glTF loader C++ templates |
| `corpus/babylon-lite/` | byte-identical registered scene inputs from the pinned source commit |
| `upstream/babylon-lite-scenes.json` | immutable corpus paths and SHA-256 evidence |
| `native/include/bblite/` | typed runtime records, handles, PAL contracts |
| `native/src/pal.cpp` | filesystem, paths, environment, timing, host engine |
| `native/src/pal_sdl.cpp` | deterministic SDL_Renderer fallback |
| `native/src/pal_sdl_gpu.cpp` | SDL_GPU resources, uploads, pipelines, readback, submission |
| `native/src/pal_sdl_gpu_shared.hpp` | SDL_GPU-only mechanics: shader load, buffer/texture upload, sampler, PNG readback |
| `native/src/pal_sdl_gpu_sprite.cpp` | the pure-2D sprite pass on SDL_GPU, a separate translation unit because a sprite-only scene generates no camera or render-plan headers |
| `native/src/pal_dawn_shared.hpp` | Dawn-only device, surface and swapchain bring-up, and WGSL module loading |
| `native/src/pal_dawn_sprite.cpp` | the same sprite pass on Dawn |
| `native/src/pal_dawn.cpp` | Dawn (WebGPU) resources, uploads, pipelines, readback, submission |
| `native/src/pal_gpu_shared.hpp` | vertex packing, RGBD decode, deformation uniforms, and inverse image processing shared byte-identically by both GPU backends |
| `native/src/pal_render_capture.hpp` | the `BBLITE_RENDER_CAPTURE` writer both backends share, `pinnedMaterialBlocks`/`pinnedMeshBlocks` included |
| `native/src/pal_camera_controls.hpp` | SDL pointer/wheel/key translation into the generated camera inertia math |
| `native/src/pal_sdl_gpu_sprite.hpp` | the SDL_GPU sprite pass mechanics its `.cpp` driver draws through |
| `native/src/pal_dawn_sprite.hpp` | the Dawn sprite pass mechanics its `.cpp` driver draws through |

`generated\` is disposable and never the source of a fix.

## Compiler architecture

The entry compiler separates semantic analysis from Babylon-specific lowering
and native emission:

```text
ts.Program + TypeChecker
    -> reachable local module/function IR
    -> entry AST and static expression evaluation
    -> resolved Babylon intrinsic registry
    -> typed property-assignment contracts
    -> feature/asset/provenance collection
    -> C++20 and shader emission
```

Intrinsic identity comes from resolved TypeScript import symbols, not local
identifier spelling. Static values, assignments, and intrinsic families are
lowered by focused modules while `compiler.ts` owns compilation state and
output orchestration.

Named local imports and re-exports resolve through the same `ts.Program`.
Reached non-generic function declarations are type-checked at call sites.
Functions whose parameters and return type map entirely into the plain-data
model (numbers, booleans, interface structs, nullable objects, arrays,
readonly views, string-literal-union enums) are emitted once as real C++
functions with native early returns; object parameters pass by native
reference, matching JavaScript object aliasing. All other reached functions
are inlined per call site with isolated symbol scopes, default parameters,
and one final return. Recursive, generator, rest-parameter, and generic
functions fail explicitly. Explicit blocks and `if`/`else` branches own
nested symbol scopes and unique native names, so legal TypeScript shadowing
does not leak or collide.

The plain-data model is value-semantic by contract: locals bound from data
paths are copies that reject writes, owned locals reject writes after they
escape by copy, sparse `new Array` slots zero-initialize, and `Math.random`
lowers to the pinned mulberry32 sequence with the browser capture harness
installing the identical generator. Every such divergence is recorded in the
generated `fidelity.json`.

Upstream semantic contracts use parsed declarations and expressions from the
pinned reconstructed source. Entry behavior must not depend on scene names or
source-text matching. Mechanical refactors preserve compiler-owned generated
artifacts byte-for-byte; unfinished compiler and shader-IR coverage belongs in
`TODO.md`.

Static custom WGSL is tokenized and lowered to `ShaderIrProgram`; a reached
program either matches a predeclared variant by IR identity or registers the
scene's own WGSL as a scene-local variant. Formatting and comments are not
shader identity; reach order is the generated variant table's index order,
and uniform setters resolve their offsets from the reached program's
reflected layout.

## Upstream upgrades

The compiler supports one reviewed Babylon Lite pin at a time. It does not
carry version branches or a plugin layer for hypothetical releases.
`upstream/babylon-lite.json` is the provenance source of truth; the package
manifest and lock file must select the same published version.

An upstream change is expected to fail at semantic seams:

- missing or moved public exports fail symbol resolution
- changed defaults and formulas fail co-located AST contracts
- changed entry APIs fail typed intrinsic or assignment lowering
- changed generated behavior fails compiler-output and parity gates

This keeps a version migration explicit without spreading version checks
through the compiler. Module paths and symbol contracts stay local to the
lowerer that owns the behavior. Curated source URLs, documentation, formulas,
and references remain intentionally reviewable evidence rather than being
silently rewritten from the pin.

## Scene orchestration

`src/scene-registry.ts` defines curated source/output/build paths, references,
thresholds, environment overrides, and optional attribution. The same workflow
also accepts unregistered repository-local TypeScript and derives defaults.

`src/scene-command.ts` provides compile, build, process, parity, compose, and
validate operations, plus the diagnostic commands (geometry, capture,
uniforms, diff, stability, probe-variants, measure, neutrality,
neutrality-generated) the debugging ladder is built from.
`src/parity-scene.ts` is the common comparison runner. Generated output is
scene-local under `generated\<scene>`.

## Generated behavior

The current generated slice includes:

- engine, scene, camera, light, mesh, and material APIs
- external glTF packaging and typed GLB loading, including vertex colors
- property-animation managers, clips, groups, LINEAR/STEP scalar/vector
  tracks, quaternion slerp, ranges, looping, and deterministic seeking
- glTF LINEAR/CUBICSPLINE transform animation, recursive skeleton hierarchies,
  inverse bind matrices, and animated position/normal/tangent morph targets
- direct single-target morph attachment for generated meshes through the same
  tree-shaken deformation vertex layout
- tree-shaken vertex-shader morphing and four-weight skinning with per-mesh
  palettes and weights
- a narrow CPU fallback for post-deformation flat normals and deformation
  outside the reached 64-matrix GPU slice
- the HillValley-required `.babylon` loader slice
- Standard/PBR/Grid material records, no-color views, and typed custom shaders
- metadata-driven `KHR_materials_clearcoat`, `KHR_materials_sheen`,
  `KHR_materials_iridescence`, and `KHR_materials_dispersion` layers
- authored transmission alpha/depth state with separate post-grab draw
  ordering and full multi-light refraction composition
- negative-transform winding, including clockwise front-face pipelines for
  mirrored double-sided PBR meshes, plus generated normals and cotangent
  normal mapping
- `.env`/DDS parsing plus compile-time RGBE HDR/SH/cubemap materialization and
  pinned 1024-sample GGX prefiltering
- `EXT_lights_image_based` RGBD cubemaps plus an offline-generated,
  half-float 1024-sample BRDF LUT
- generated infinite-distance solid and HDR skybox behavior
- finite root-positioned DDS background cubes matching Babylon Lite's scene
  view-projection contract
- pure-2D sprite layers and their own `SpriteRenderer` rendering context,
  over a compile-time-drawn canvas2D atlas, on both GPU backends
- ordered opaque/transparent draw lists, camera matrices, uniforms, and
  frame-graph tasks
- Standard/PBR geometry MRTs, depth-only passes, blits, and MSAA resolve
- frame-graph post-process passes — blur, chromatic aberration, black and
  white, anaglyph, circle of confusion — each drawing the pin's own composed
  module, and the depth-of-field composite as the chain of them its own
  factory builds
- linear RGBA16F opaque/transmission rendering followed by one final
  image-processing pass
- reached custom WGSL lowered through a typed shader IR into reflected HLSL/MSL
- pinned Tint compilation from native-specialized reached WGSL to HLSL/MSL;
  DXC emits SDL-layout-compatible DXIL/SPIR-V
- generated GridMaterial WGSL compiled exclusively through Tint
- generated frame-graph blit/depth and diagnostic WGSL compiled through Tint
- generated ground and cubemap-skybox WGSL compiled through Tint
- the shared material vertex WGSL through Tint
- Babylon's own composed PBR and Standard variant stages — colour and
  geometry MRT — executed verbatim on both backends, selected per renderable
- directional, hemispheric, point, and spot Standard shading through the
  pin's own lights block and per-mesh light selection
- content-addressed DXIL/SPIR-V reuse across identical scene shader variants

Each scene records:

- `manifest.json`: features, sources, assets, adaptations
- `fidelity.json`: intentional semantic adaptations
- `upstream/provenance.json`: upstream modules and symbols
- `upstream/renderer-fidelity.json`: shader contracts and invariants
- `upstream/feature-activation.json`: every activation unit — runtime
  features, capability defines, codecs, emit options, composed variants,
  refusals — with its concrete reason and pinned mirror
- `upstream/shaders/shader-material-reflection.json`: reached custom shader
  entry points, attributes, varyings, uniform layouts, bindings, and sizes
- `upstream/shaders/*.wgsl`: reached custom material source before IR lowering
- `upstream/shaders/*.native.wgsl`: SDL binding/location/depth specialization
- `upstream/shaders/variant-*.native.wgsl`: the pin's own composed PBR
  (`variant-`) and Standard (`variant-std-`) stages, verbatim
- `upstream/shaders/postprocess-*.native.wgsl`: the composed post-process
  modules, deployed once per entry point. Indexed by the module rather than
  by the pass: two passes whose composed text is identical -- a blur pair
  differing only in its `direction` uniform -- share one
- `upstream/shaders/*.slots`: per stage, the register each block kept after
  compaction, by its own name. Written for every compiled stage, and the
  only authority on SDL_GPU slot order -- a block a stage declares but never
  reads does not survive, and the compaction is dense
- `upstream/shaders/*.tint-reflection.txt`: Tint binding reflection check
- `upstream/shaders/shader-compiler.json`: selected offline compiler backend
- `upstream/shaders/composition.json`: reached WGSL modules and content hashes

## Runtime and memory

Engine-owned data uses contiguous vectors and typed handles. The native
TypeScript subset provides typed arrays, `DataView`, `TextDecoder`, typed JSON,
and immediate AOT `Promise<T>`.

The supported subset does not need tracing GC: locals use C++ lifetimes and
engine records live in arenas. A collector remains optional future work for
escaping closures, cyclic objects, or other genuinely dynamic JavaScript
graphs.

## Animation and deformation

Property animation and glTF animation share deterministic scene-level seeking
but have separate generated runtimes:

- property clips/groups target reached mesh paths such as `position`,
  `position.x`, `scaling`, and `rotationQuaternion`
- glTF loading evaluates node hierarchies, animation channels, skins, inverse
  bind matrices, and morph weights from materialized asset metadata
- `EXT_mesh_gpu_instancing` keeps extension T/R/S matrices local and composes
  the node world matrix in the generated vertex stage
- morph deltas are applied before skinning
- authored normals/tangents deform in the vertex shader
- primitives without source normals are deindexed; CPU recomputes their face
  normals after deformation while positions remain GPU-skinned

Asset specialization enables the deformation vertex variant when a
materialized glTF contains animation; direct `createMorphTargets` reachability
enables the same variant for generated meshes. Other static scenes retain the
compact 96-byte/8-attribute vertex layout and one vertex uniform block. Reached
deformation scenes use the 200-byte/16-attribute layout and a second vertex
uniform block containing up to 64 matrices and two morph targets; when the
scene also composes pinned PBR variants the layout appends an integer
joint-index lane for the pin's own skinned stage (216 bytes) beside the
transcribed float pair. Assets with morph targets enable Babylon Lite's
uncapped storage-buffer morph path — the pin's one morph mechanism, which
the composed variants read: a flat 6-float delta buffer and a
16-byte-header weights buffer bound as vertex storage, evaluated with the
pinned accumulation loop before skinning; the two-slot vertex-attribute
morph lanes remain for direct generated-mesh morph attachment. Skins beyond
64 joints keep the general CPU deformation path rather than truncating.

Two generated lists decide what a scene compiles: `BBLITE_RUNTIME_FEATURES`
in `features.cmake` from the scene's own TypeScript, and
`render_capabilities.hpp` from the materialized assets. Which list answers
which question — including the two deliberate asset-joined light and IBL
exceptions — is in
[features](features.md#feature-and-capability-selection).

Generated `render_capabilities.hpp`, shader reflection, and native layout
declarations must stay synchronized. The D3D12 pipeline failure encountered
during the initial migration was caused by declaring only 8 SDL vertex
attributes for a 15-input shader; GridMaterial also reserves location 7 for
its local normal, so deformation inputs occupy locations 8-15.

## Renderer

Two peer GPU backends render the same generated plans; SDL_GPU is the
runtime default and `BBLITE_GPU_BACKEND=dawn` selects the Dawn
(WebGPU) backend, which renders through the browser reference's own
compiler and rasterization stack (see [backends](backends.md) for the
architecture and comparison). The SDL_GPU offline shader targets:

| Platform | Backend | Artifact |
| --- | --- | --- |
| Windows | Direct3D 12 | Tint HLSL → DXC DXIL |
| Linux / Android | Vulkan | Tint HLSL → DXC SPIR-V (temporary) |
| macOS / iOS | Metal | Tint MSL |

The Dawn backend needs none of these — it compiles the same WGSL
in-process ([features](features.md#stage-2-compiling-wgsl-for-the-device)).

Important contracts:

- base-color/emissive textures are sRGB; normal/ORM textures are linear
- `.env` RGBD cubemap faces upload Y-flipped — pinned behavior, not an SDL
  adaptation ([backends](backends.md#ported-pinned-contracts))
- compiled HDR cubemaps are linear RGBA16F with mip-major, face-major layout
- DDS skyboxes are RGBA16F with face-major, mip-minor layout
- alpha mode, cutoff, blending, culling, and coverage are material-driven
- requested environment grounds render by default and keep Babylon Lite's
  world-origin fade center ([fidelity](fidelity.md#shader-contract))
- PBR material-extension texture pairs append after the base and
  transmission bindings per the generated `material_texture_slots.hpp`
  table, selected only by the `render_capabilities.hpp` defines for the
  reached glTF extensions; extension uniform data lives in each composed
  variant's own material block, written by the pin's lowered UBO writers
- PAL executes generated draw-command indices and pipeline keys rather than
  rescanning every mesh once per pipeline
- frame-graph viewport copies keep the pinned double-precision
  floor-and-scissor viewport contract ([fidelity](fidelity.md#attribution))
- transmission preserves the multisample color and depth attachments around
  the scene-color grab ([fidelity](fidelity.md#shader-contract) carries the
  pass shape)
- screenshot capture uses a readable target, then blits to the swapchain
- capture is deferred one frame when scene topology changes so D3D12 upload
  and readback commands do not share an invalid command list; the frame loop
  extends past `BBLITE_MAX_FRAMES` by a bounded grace period until every
  requested capture lands, so deferral cannot silently skip a screenshot
- native builds place reached assets and snapshotted shaders beside the
  executable to avoid absolute paths and cross-scene drift

The SDL_Renderer path remains a deterministic CPU fallback and supports the
same reached quaternion mesh transforms.

## Repository invariants

- Curated Babylon Lite scene sources are byte-identical, hash-checked evidence
  under `corpus/babylon-lite/`; never edit, flatten, normalize, or replace
  them. Committed references are likewise evidence, not tuning knobs.
- MAD is diagnostic. A lower score does not justify scene-name, geometry,
  position, or reference-image heuristics.
- glTF material behavior is metadata-driven (`OPAQUE`, `MASK`, `BLEND`,
  cutoff, double-sided state).
- Every generated behavior retains upstream provenance; every intentional
  semantic adaptation belongs in generated `fidelity.json`.
- An upstream package/commit update is a separate reviewed migration:
  regenerate all outputs, review changed formulas/constants, rebuild, and run
  the complete parity/diagnostic matrix.

## Backend rationale

The project keeps two complete GPU backends on purpose: two stacks
that must agree pixel-for-pixel are a differential diagnostic that
separates CPU-side causes from GPU-side ones immediately.
[Backends](backends.md) carries the rationale, the full comparison,
build recipes, and the ported pinned contracts.

The shader-language migration is complete: all native GPU shaders originate as
WGSL and compile through Tint, with bblitec owning composition, SDL
specialization, reflection checks, and fixed-function state. The SDL_GPU
offline paths — including why DXC stays mandatory and why Vulkan temporarily
recompiles Tint HLSL through it — are tabulated in
[features](features.md#stage-2-compiling-wgsl-for-the-device). Remaining work
is tracked only in [TODO](../TODO.md).
