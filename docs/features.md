# Features

This page owns the supported surface and where work runs. It is a bounded
TypeScript/Babylon Lite compiler: unsupported constructs usually refuse during
generation, while device- and loaded-resource-dependent checks can fail at
runtime. Some intentional substitutions are recorded in
[fidelity](fidelity.md). Current measurements belong in [status](status.md);
unfinished capabilities belong in [TODO](../TODO.md).

## Why anything is compile time

The native executable has no browser, runtime network loader or dynamic
TypeScript module system. Generation materializes remote assets, executes
browser-dependent producers and composes the closed shader set. Live scene
state, animation, input, resource uploads and draw submission remain native.

A family can span both phases. Baking browser-produced pixels does not require
baking a sprite frame grid; the grid can still derive from the decoded texture
at load time. Preserve the pinned boundary rather than moving every computation
to generation merely because it is possible.

## Feature and capability selection

Babylon Lite activates optional behavior through both lazy API registration
and asset-loader discovery. The port represents those different upstream
triggers, then merges their consequences before emission.

| Mechanism | Authority | Consumer |
| --- | --- | --- |
| Runtime features | Reached API calls, plus asset-discovered light/environment/splat families | `features.cmake`, generated source lists, PAL translation units |
| Renderer capabilities | Settled material/mesh/asset shape and explicit opt-ins | `render_capabilities.hpp`, resource/layout guards |
| Image codecs | Packaged image types | `BBLITE_IMAGE_CODECS`, CMake and shipping dependencies |
| Emit options | Final compiler/asset decisions | Dedicated lowerers and generated loader arms |
| Composition | Pinned feature words and lazy extension registration | PBR, Standard, node and custom variant tables |
| Refusals | Unsupported combinations | Generation diagnostics |

`src/feature-activation.ts` records all six mechanisms in
`upstream/feature-activation.json`, using the values the pipeline actually
selected. Each row identifies its reason, upstream origin and consumers. The
inventory is an audit aid; a provenance label alone does not establish semantic
equivalence.

For example, source clearcoat setters register an optional feature, while a
glTF clearcoat extension reaches the loader's material builder. Both can
require the same native material state. An explicit `isEnabled: false` does
not undo a module registration whose factory the source already reached.

`shadowCapabilities` derives the Standard, PBR and node receiver gates and
their shared generator resources. Use the union
`BBLITE_SHADOW_RECEIVERS` for common shadow resources and each family gate for
its binding path. `BBLITE_SHADOWS` records reachability; it does not imply every
receiver/resource path is needed. ESM resources have their own gate.

Optional audio, physics, navigation, retained UI and image decoding must be
selected at both generated-source and dependency boundaries. See
[development](development.md) for minimal-build commands and
[audit](../audit.md) for partitioning defects being resolved.

## Program compilation

| Surface | Supported shape |
| --- | --- |
| Entry | Local `main`, supported top-level entry statements, or an imported entry helper with an erased reporting-only rejection handler |
| Modules | Named local imports/re-exports and dependency-ordered reached module initializers |
| Control flow | Scoped blocks, `if`, supported `switch`, `for`/`while`/`for-of`, and applicable `break`/`continue` |
| Functions | Once-emitted data-typed functions, supported mutually recursive groups, defaults and inlined handle-dependent helpers |
| Closures | Supported stored callbacks, shared outer cells, timer/RAF and API-owned retained callbacks; function identity where represented |
| Classes | Local fields, constructor/parameter properties, methods/accessors and demanded shared instances; stored subclass dispatch remains unsupported |
| Data | Typed records, nullable values, arrays, insertion-ordered Map/Set, tuples, destructuring, spreads and bounded static records |
| Binary data | ArrayBuffer, DataView, reached typed-array constructors, indexing, fill/set/copyWithin/slice |
| Numeric/string | Reached runtime Math, including JavaScript `Math.round`, deterministic random, string operations and coercions |
| JSON | Generated stringify codecs and dynamic parsed values with source-level shape checks; unsupported replacers/cyclic serialization refuse |
| Exceptions | `throw`, bounded catch handling and finally cleanup; catch bindings must satisfy the compiler's supported/erased binding rules |
| Browser state | Reference query folding, bounded browser erasure, immediate AOT asset promises and live canvas extents |
| Storage/files | Per-user localStorage, bounded Blob/object URLs, one-file open and download; [UI](ui.md#file-transfer-controls) owns controls |
| UI | Supported retained DOM/CSS/Canvas2D operations; [UI](ui.md) owns their complete compatibility boundary |

This is not a complete typed user-code IR. Handle-dependent helper inlining,
escape classification, generic bodies, resource loops and aliasing have
limitations. The [runtime ownership contract](architecture.md#runtime-and-memory)
defines which retained graphs are traced and which native owners remain roots.

No arbitrary JavaScript execution or dynamic modules run in the native
executable. AOT `await` and frame-yield continuations have different semantics;
the latter schedule work across the frame conductor rather than blocking a
browser promise loop.

## Asset materialization

Reached file/remote URLs are packaged under the generated scene. glTF external
buffers/images are embedded as needed; local application assets retain reviewed
logical paths. Base64 data URLs decode at generation. Dynamic URLs outside a
supported producer and percent-encoded data bodies refuse.

### Compressed geometry

The packager executes the pinned Draco/meshopt decoders and document hooks.
Meshopt, sparse-accessor, quantization and splat hooks keep the pin's order so
later hooks consume earlier outputs. Native loading sees ordinary accessors
after those transformations. A packaged document still containing an
unsupported extension refuses rather than silently reading an unpatched base.

### Compressed textures

KTX1 is parsed at native load and uploads its own blocks/mips. Basis and glTF
KTX2 routes execute the pinned browser transcoder during generation, packaging
the resulting container. The selected compression target is fixed for the
validated device family. Native upload checks device support. Texture
`invertY`, encoding and sampler choices retain their own contracts.

### Environment compilation

HDR runs the pinned WebGPU GGX prefilter during generation. DDS preserves its
stored specular mips and derives harmonics through the pinned source. Native
`.env` loading parses its container and uploads decoded cube data. The
image-based-lighting BRDF LUT is generated offline.

### Drawn and computed assets

Bounded module producers can run in Chromium to bake drawn atlases or computed
pixel buffers. CSG plans execute the pinned CSG implementation under Node.
Cache identity covers producer inputs and the relevant implementation. Browser
rasterization and numerically fragile executed output are recorded adaptations.

### Browser-produced textures

A bounded scene function can own a canvas and call the pinned pixel/texture
factories. The executor records the resulting RGBA or blob and texture options;
unrecognized pinned calls or engine reads refuse. Selection is structural, but
some specialized source gates remain tracked in TODO. Runtime Canvas2D UI is a
separate retained surface.

### Node particles

Generation runs the pinned parser, normalizer, builder and simulation, then
bakes a frozen particle state. Billboard and Sprite2D bridges derive their
layout, blend and synchronization rules from pinned declarations. A registered
set is accepted only when the observed extra step leaves consumed columns
unchanged. Moving emitters, general live simulation and several graph/texture
input shapes remain outside this slice.

## Shader pipeline

### Stage 1: composition and specialization

PBR and Standard stages come from the pinned composer and extension registry;
node materials execute the pinned graph compiler. Post-process and effect
factories provide their shader text/layouts. Packaged literals are lifted,
and supported builders are AST-folded. Custom source uses typed shader IR where
supported and a strict reflected path elsewhere.

One handwritten shared vertex stage remains for specialized diagnostic,
depth/background paths. Skybox specialization also retains text rewriting.
These are audited maintenance debts, not proof that all shaders are derived
automatically.

### Stage 2: compiling WGSL for the device

| Backend/target | Compilation |
| --- | --- |
| SDL_GPU D3D12 | Pinned Tint to normalized HLSL, then DXC to DXIL |
| SDL_GPU Vulkan | Normalized Tint HLSL through DXC to SPIR-V |
| SDL_GPU Metal | Pinned Tint to MSL |
| Dawn | Deployed WGSL compiled by Dawn at runtime |

SDL_GPU binds from the compiled `.slots` sidecar; Dawn uses the deployed
module's binding numbers. See [backends](backends.md) for layouts and
[development](development.md) for cache/toolchain commands.

## Engine, scene, and frame loop

Engine/scene registration, ordered rendering contexts, fixed or live frame
time, supported before-render/update callbacks, timers and frame gates run
through the shared conductor. Scene, SpriteRenderer, EffectRenderer and
scene-less FrameGraphContext drivers compile independently when reached.

## Cameras and input

ArcRotate/Free cameras, default framing, bounded orthographic projection,
viewports and supported SDL controls are live. Canvas dimensions follow the
drawable extent. Off-center orthographic planes and wider camera combinations
remain unfinished; general browser input APIs are not implied.

## Asset loading and upload

Generated glTF and `.babylon` loaders construct supported meshes, materials,
lights, cameras, skins and animation. glTF supports reached external resources,
sparse/quantized/compressed inputs after packaging, texture transforms and
material extensions. Unsupported extension fields and loader branches refuse.
The `.babylon` parented/geometry-less-node surface remains incomplete.

## Geometry and meshes

Reached primitives, mesh data, ribbons/extrusion/polyhedra, line systems, CSG,
thin instances and transform mutations are supported within their intrinsic
option sets. Runtime geometry/source arrays follow the data model; builder
presence does not imply every option or update form. User-written resource
loops may still expand heavily; see the active audit.

## Scene hierarchy

Scene-created transform nodes, parenting, local/world transforms, visibility,
supported imported-hierarchy walks and bounded cloning are represented.
Imported roots and runtime TransformNode values still have distinct paths;
full imported-root cloning/rotation/scaling and arbitrary hierarchy visitor
effects remain unfinished.

## Lights

Directional, hemispheric, point and spot lights, supported live setters and
per-mesh light selection feed generated writers. Asset light discoveries join
the runtime feature list. The primary PBR analytic slot has a restricted spot
shape; wider combinations must not silently invent a fallback.

### Clustered lights

The optional PBR clustered container selects its fragments at generation.
Native code updates the reached light field, binning and data textures per
frame. Reuse the pinned registration and writer rules for further variants.

## Materials and material state

Standard, PBR and Grid materials, shader materials, supported no-colour views,
alpha/culling state and live property writes are available. PBR layers include
clearcoat, sheen, iridescence, anisotropy and transmission where reached by
supported source APIs or asset extensions. Support is per entry point: direct
anisotropy does not imply glTF `KHR_materials_anisotropy` support.
Explicit PBR lightmap/Standard UV/vertex-colour opt-ins remain distinct from
asset-driven shape.

Shader materials support bounded typed 2D/2D-array samplers, float/depth sample
types and comparison mode, plus declared storage buffers and their reached
create/update/dispose/bind operations. Custom uniform declarations and the
supported system-matrix list drive generated writers; wider fixed-function
options and system values still refuse.

### Node materials

Pinned NME graphs compose at generation with bounded graph inputs, textures
and block-loader forms. Supported alpha-combine graphs draw transparently.
Uniform input state is generally frozen. Node geometry-MRT output, wider input
mutation and delegating block-loader forms remain unfinished.

### Material plugins

Explicit plugin enablement installs the pin's bridges. The compiler folds
supported custom-code and sampler/texture declarations. Standard plugin
textures are retained per material; wider uniform writers, runtime signature
changes and PBR sampler plugins remain incomplete.

## Animation playback

Property clips and glTF channels use separate runtimes with deterministic
seeking. Supported glTF slices include TRS, skinning, morph weights and reached
animation-pointer material/visibility targets. Track interpolation and target
support are independent; a property-animation option does not establish glTF
support for the same spelling.

## Deformation and instancing

GPU skinning, morph/storage morph, baked vertex animation and dynamic
thin-instance pools are supported. The glTF skin path retains four influences
when an asset supplies eight, recorded as an adaptation. Direct morph factories
have a narrower target/shared-weight surface than loaded glTF morphs.
Scene-authored skeletons and Standard skeleton palettes remain unfinished.

The reached thin-instance pool includes set/count/matrix/colour/flush,
add/remove and count reads. GPU-culling enablement records omission of its
compute/indirect path; the native fallback draws active instances.

## Sprites

Sprite2D layers, standalone renderers, offscreen targets, depth-hosted layers,
billboards, atlas-frame factories, sprite animation, custom fragments and
renderer Y-sort have supported paths. Per-layer/system options select pinned
shader and blend arms. Handle-object APIs, mixed-family transparent ordering,
coverage gamma and several picking combinations remain incomplete.

## Picking

GPU picking supports the basic and detailed pipelines, mesh/cloud identities,
sampled picked points and the reached skinned detailed-deformation arms.
Billboard picking has a bounded contributor path. Detailed support does not
yet cover every morph-only/basic deformation combination, scene-authored
skeleton, filter/ignore/discard option, thin instance/VAT id or result property.
Viewport and unsupported multi-contributor cases refuse at their boundary.

## Display gizmos

Display, editing and bounding-box gizmos share a generated utility-layer path.
Supported pointer registrations enable position-edit behavior; display-only
gizmos do not imply interaction. Retargeting and shape-specific options retain
explicit limits. Several widget builders remain transcribed and are tracked
as lowering debt.

## Physics

The generated Babylon physics layer runs over Bullet through the Havok-shaped
PAL seam. Reached bodies, primitive/convex/static-mesh shapes, forces/impulses,
velocity/motion/prestep controls, aggregate options, masks, collisions,
triggers, raycasts and floating-origin regions have supported paths.
Constraints, character controllers, heightfields, full mass-property behavior
and wider lifecycle controls remain incomplete. Dynamic concave meshes and
non-Y-aligned capsule/cylinder segments refuse. Solver substitution is not
pixel or trajectory equivalence; [fidelity](fidelity.md#physics-contract)
defines the distinction.

## Audio

The reached Web Audio graph runs through LabSound and an SDL3 device; encoded
clips are packaged before runtime decode. Engine lifecycle, gain, oscillators,
buffers, filters, panning and reached AudioParam scheduling have supported
paths. Babylon's broader sound/bus/spatial APIs and master-volume ramps remain
outside the measured slice. Audio is feature-selected, including dependencies.

## Shadows

PCF spot/directional, ESM directional and CSM generators support reached
receiver/caster families, array layers, blur and morph-bound refresh.
Imported/runtime mesh collections can select supported receiver states, but
the source `receiveShadows` assignment still requires a static supported value.
A false assignment does not provide a general live variant toggle.
CSM fitting remains structurally transcribed; thin-instance CSM bounds and
generator options beyond the accepted sets remain unfinished.

## Navigation

Recast/Detour supports reached solo and obstacle tile-cache builds, debug
geometry, raycast/closest-point queries, crowds, agents and obstacle updates.
The tiled-without-obstacles build and unimplemented queries/disposal refuse.
This PAL is independent of either GPU backend.

## Frame graph

Scene-owned and scene-less graphs support reached render targets, ordered
tasks, material overrides, depth passes, geometry MRTs, blits and MSAA resolve.
A compiler-created default scene task retains skybox/mesh/ground ordering;
application-created tasks obey their explicit lists. Target, depth and viewport
contracts are shared across backends.

### Post-process passes

Reached leaf effects and composites execute pinned factories at generation.
Their writers, target relationships and parameters drive live native passes.
Source-relative intermediate sizes follow resize. Temporal accumulation such
as TAA needs additional history, camera-jitter and composite-output contracts.

### Fullscreen effects

EffectWrapper/EffectRenderer, UniformEffectWrapper and their frame-graph tasks
have supported layout/uniform/texture slices. Custom vertex stages, wider
binding descriptors, arbitrary texture sources, per-frame renderer updates and
disposal APIs are not generally supported. Retained UI under scene-less effect
or frame-graph drivers currently refuses.

### Image processing

Exposure and contrast are live uniform state. The selected tone-mapping record
participates in material composition. Transmission uses the pinned linear-frame
and trailing image-processing contract.

## Runtime scene mutation

Supported removal, material-family append and dynamic instance updates trigger
plan/resource updates. Removed unshared geometry can be reclaimed; re-adding
that retired mesh is not generally supported. Some retired shadow topology
remains engine-owned and needs explicit reclamation work.

## Diagnostics and capture

[Debugging](debugging.md) owns scene analysis, capture/diff, attribution,
memory and artifact commands. [Development](development.md) owns compile-time
and runtime switches.

## Platform validation

D3D12 on Windows is the validated local target. SDL_GPU Vulkan has a known PBR
shading divergence; Linux and Metal validation remain open. Dawn's native
surface integration is currently Windows-specific. Generated portability
artifacts do not establish a tested platform.
