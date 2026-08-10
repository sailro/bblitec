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
| `src/upstream-source.ts` | pinned source-map reconstruction |
| `src/upstream-graph.ts` | conservative reachable-module analysis |
| `src/upstream-lower.ts` | lowerer orchestration, provenance, generated capabilities |
| `src/lowering/*-lowerer.ts` | focused Babylon API and formula lowering |
| `src/lowering/templates/` | generated C++ and portable shader templates |
| `native/include/bblite/` | typed runtime records, handles, PAL contracts |
| `native/src/pal.cpp` | filesystem, paths, environment, timing, host engine |
| `native/src/pal_sdl.cpp` | deterministic SDL_Renderer fallback |
| `native/src/pal_sdl_gpu.cpp` | SDL_GPU resources, uploads, pipelines, readback, submission |

`generated\` is disposable and never the source of a fix.

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
- negative-transform winding, generated normals, and cotangent normal mapping
- `.env`/DDS parsing plus compile-time RGBE HDR/SH/cubemap materialization and
  pinned 1024-sample GGX prefiltering
- generated infinite-distance solid, DDS, and HDR skybox behavior
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
- morph deltas are applied before skinning
- authored normals/tangents deform in the vertex shader
- primitives without source normals are deindexed; CPU recomputes their face
  normals after deformation while positions remain GPU-skinned

Asset specialization enables the deformation vertex variant only when a
materialized glTF contains animation. Static scenes retain the compact
96-byte/8-attribute vertex layout and one vertex uniform block. Reached
animated scenes use the 200-byte/16-attribute layout and a second vertex
uniform block containing up to 64 matrices and two morph targets. Larger
reached inputs keep the general CPU deformation path rather than truncating.

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
- PAL executes generated draw-command indices and pipeline keys rather than
  rescanning every mesh once per pipeline
- screenshot capture uses a readable target, then blits to the swapchain
- capture is deferred one frame when scene topology changes so D3D12 upload
  and readback commands do not share an invalid command list
- native builds place reached assets and snapshotted shaders beside the
  executable to avoid absolute paths and cross-scene drift

The SDL_Renderer path remains a deterministic CPU fallback and supports the
same reached quaternion mesh transforms.

## Repository invariants

- Curated scene sources and committed references are evidence, not tuning
  knobs. Change them only when intentionally adding a new pinned scene or
  recapturing an explicitly approved reference.
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
