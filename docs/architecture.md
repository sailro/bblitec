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
    -> SDL3 / SDL_GPU
```

`bblitec` is a compiler, not an interpreter. Unsupported syntax or Babylon APIs
produce source-located errors.

The entry frontend is built as a TypeScript `Program` with a `TypeChecker`.
Babylon intrinsics are identified by resolved import symbols, then dispatched
through focused intrinsic modules. Generated behavior must never depend on
scene names or regular-expression matching of entry-source text.

The repository pins `@babylonjs/lite@1.18.0` and source commit
`7184feda683072980735f9a180e6f567ee5717ba`. Original TypeScript is recovered
from published source maps. Lowerers assert expected upstream symbols,
constants, and formulas before emitting code.

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
| `src/compiler.ts` | entry-scene AST lowering, features, assets, generated main/CMake |
| `src/compiler/program.ts` | in-memory TypeScript `Program`/`TypeChecker` frontend |
| `src/compiler/symbols.ts` | resolved Babylon import symbols and aliases |
| `src/compiler/static-evaluator.ts` | typed static scalar/vector/color expression evaluation |
| `src/compiler/user-functions.ts` | reachable typed local-function IR, calls, parameters, and returns |
| `src/compiler/statements.ts` | statement dispatch, conditions, expression statements, and method calls |
| `src/compiler/assignments.ts` | typed property-assignment validation and lowering |
| `src/compiler/intrinsics/*` | focused resolved-symbol engine, scene, asset, animation, camera, light, mesh, and material intrinsic lowerers |
| `src/compiler/types.ts` | compiler public result types and internal typed values/features |
| `src/upstream-source.ts` | pinned source-map reconstruction |
| `src/upstream-graph.ts` | conservative reachable-module analysis |
| `src/upstream-lower.ts` | lowerer orchestration, provenance, generated capabilities |
| `src/lowering/context.ts` | source-located AST declarations, expression contracts, and diagnostics |
| `src/lowering/*-lowerer.ts` | focused Babylon API and formula lowering |
| `src/lowering/templates/` | generated C++ and portable shader templates |
| `corpus/babylon-lite/` | byte-identical registered scene inputs from the pinned source commit |
| `upstream/babylon-lite-scenes.json` | immutable corpus paths and SHA-256 evidence |
| `native/include/bblite/` | typed runtime records, handles, PAL contracts |
| `native/src/pal.cpp` | filesystem, paths, environment, timing, host engine |
| `native/src/pal_sdl.cpp` | deterministic SDL_Renderer fallback |
| `native/src/pal_sdl_gpu.cpp` | SDL_GPU resources, uploads, pipelines, readback, submission |

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
Reached non-generic function declarations are type-checked at call sites and
lowered with isolated symbol scopes, default parameters, and one final return.
Recursive, generator, rest-parameter, and generic functions fail explicitly.
Explicit blocks and `if`/`else` branches own nested symbol scopes and unique
native names, so legal TypeScript shadowing does not leak or collide.

Upstream semantic contracts use parsed declarations and expressions from the
pinned reconstructed source. Entry behavior must not depend on scene names or
source-text matching. Mechanical refactors preserve compiler-owned generated
artifacts byte-for-byte; unfinished compiler and shader-IR coverage belongs in
`TODO.md`.

Static custom WGSL is tokenized and lowered to `ShaderIrProgram` before a
supported native variant is selected. Formatting and comments are not shader
identity; generating arbitrary scene-local variants from the supported IR
remains separate compiler coverage.

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

This keeps a 1.18-to-2.0 migration explicit without spreading version checks
through the compiler. Module paths and symbol contracts stay local to the
lowerer that owns the behavior. Curated source URLs, documentation, formulas,
and references remain intentionally reviewable evidence rather than being
silently rewritten from the pin.

## Scene orchestration

`src/scene-registry.ts` defines curated source/output/build paths, references,
thresholds, environment overrides, and optional attribution. The same workflow
also accepts unregistered repository-local TypeScript and derives defaults.

`src/scene-command.ts` provides compile, build, process, and parity operations.
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
- tree-shaken vertex-shader morphing and four-weight skinning with per-mesh
  palettes and weights
- a narrow CPU fallback for post-deformation flat normals and deformation
  outside the reached 64-matrix/two-morph-target GPU slice
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
- ordered opaque/transparent draw lists, camera matrices, uniforms, and
  frame-graph tasks
- Standard/PBR geometry MRTs, depth-only passes, blits, and MSAA resolve
- linear RGBA16F opaque/transmission rendering followed by one final
  image-processing pass
- reached custom WGSL lowered through a typed shader IR into reflected HLSL/MSL
- pinned Tint compilation from native-specialized reached WGSL to HLSL/MSL;
  DXC emits SDL-layout-compatible DXIL/SPIR-V
- generated GridMaterial WGSL compiled exclusively through Tint
- generated frame-graph blit/depth and diagnostic WGSL compiled through Tint
- generated ground and cubemap-skybox WGSL compiled through Tint
- shared material vertex and Standard fragment/geometry WGSL through Tint
- directional/hemispheric two-light Standard shading where reached
- PBR color, diagnostic, and geometry-output WGSL through Tint
- content-addressed DXIL/SPIR-V reuse across identical scene shader variants

Each scene records:

- `manifest.json`: features, sources, assets, adaptations
- `fidelity.json`: intentional semantic adaptations
- `upstream/provenance.json`: upstream modules and symbols
- `upstream/renderer-fidelity.json`: shader contracts and invariants
- `upstream/shaders/shader-material-reflection.json`: reached custom shader
  entry points, attributes, varyings, uniform layouts, bindings, and sizes
- `upstream/shaders/*.wgsl`: reached custom material source before IR lowering
- `upstream/shaders/*.native.wgsl`: SDL binding/location/depth specialization
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

Asset specialization enables the deformation vertex variant only when a
materialized glTF contains animation. Static scenes retain the compact
96-byte/8-attribute vertex layout and one vertex uniform block. Reached
animated scenes use the 200-byte/16-attribute layout and a second vertex
uniform block containing up to 64 matrices and two morph targets. Assets
with more than two morph targets additionally enable Babylon Lite's
uncapped storage-buffer morph path: a flat 6-float delta buffer and a
16-byte-header weights buffer bound as vertex storage, evaluated with the
pinned accumulation loop before skinning. Skins beyond 64 joints keep the
general CPU deformation path rather than truncating.

Generated `render_capabilities.hpp`, shader reflection, and native layout
declarations must stay synchronized. The D3D12 pipeline failure encountered
during the initial migration was caused by declaring only 8 SDL vertex
attributes for a 15-input shader; GridMaterial also reserves location 7 for
its local normal, so deformation inputs occupy locations 8-15.

## Renderer

SDL_GPU is the default native renderer:

| Platform | Backend | Artifact |
| --- | --- | --- |
| Windows | Direct3D 12 | Tint HLSL → DXC DXIL |
| Linux / Android | Vulkan | Tint HLSL → DXC SPIR-V (temporary) |
| macOS / iOS | Metal | Tint MSL |

Important contracts:

- base-color/emissive textures are sRGB; normal/ORM textures are linear
- `.env` RGBD cubemap rows are vertically reversed for SDL_GPU upload
- compiled HDR cubemaps are linear RGBA16F with mip-major, face-major layout
- DDS skyboxes are RGBA16F with face-major, mip-minor layout
- alpha mode, cutoff, blending, culling, and coverage are material-driven
- requested environment grounds render by default; their translated geometry
  retains Babylon Lite's world-origin fade center
- PBR material-extension textures and uniforms are appended after the base
  and transmission bindings, selected only by the generated
  `render_capabilities.hpp` defines for the reached glTF extensions
- PAL executes generated draw-command indices and pipeline keys rather than
  rescanning every mesh once per pipeline
- frame-graph viewport copies preserve Babylon Lite's double-precision
  normalized coordinates, floor them to integer target bounds, and apply the
  same scissor rectangle before drawing
- transmission resolves and stores the multisample opaque color attachment,
  copies the resolved RGBA16F scene color, then reloads the preserved
  multisample color and depth attachments for transmissive draws
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

The shader-language migration is complete: all native GPU shaders originate as
WGSL and compile through Tint. bblitec owns composition, SDL specialization,
reflection checks, and fixed-function state. Tint can emit SPIR-V directly,
but its WGSL resource layout does not yet match SDL_GPU's dense paired
texture/sampler convention; DXC therefore temporarily compiles normalized
Tint HLSL for Vulkan too. DXC remains mandatory for DXIL. Browser WebGPU is
Babylon Lite's existing target, not a bblitec backend goal. Remaining work is
tracked only in [TODO](../TODO.md).
