# bblitec TODO

This file tracks remaining work. Completed historical milestones belong in Git
history and `docs/status.md`; this list should contain only actionable future
work.

## Guiding constraints

- Generate Babylon Lite behavior from the pinned upstream TypeScript whenever
  possible.
- Keep handwritten C++ restricted to PAL and native resource mechanics.
- Do not add scene-name, geometry-position, or golden-image heuristics.
- Keep TypeScript free of explicit `any`.
- Preserve tree shaking and typed, data-oriented runtime records.
- Generate before building; validate compiler, CPU parity, and GPU parity
  before completing renderer milestones.
- Batch pushes because GitHub Actions compute is limited.

## P0 — Prove generalization

### Add an unrelated reference scene

- [ ] Select a second Babylon Lite scene that uses a different glTF asset,
  camera framing, material distribution, and environment.
- [ ] Add its authoritative TypeScript entry under `examples/`.
- [ ] Add deterministic asset materialization and provenance.
- [ ] Add reference capture metadata and a committed golden.
- [ ] Add CPU and GPU parity configurations.
- [ ] Add a native build target and local parity commands.
- [ ] Verify no BoomBox-specific assumptions are needed.

**Done when:** both scenes compile from clean checkout, render through the same
generated renderer, and pass independent visual regression gates.

### Replace specialized shader templates with a general shader pipeline

- [ ] Extract the reachable Babylon composed WGSL for each material feature
  set.
- [ ] Define a typed shader intermediate representation for declarations,
  bindings, varyings, expressions, control flow, and entry points.
- [ ] Lower the required WGSL subset into the IR.
- [ ] Emit HLSL/DXIL, SPIR-V, MSL, and eventually WGSL from the same IR.
- [ ] Preserve SDL_GPU binding-space conventions across all outputs.
- [ ] Generate shader variants from material/mesh/scene feature flags rather
  than a fixed `boombox` shader name.
- [ ] Cache identical variants across meshes and scenes.
- [ ] Add compiler diagnostics for unsupported WGSL constructs.
- [ ] Investigate Tint or SDL_shadercross as the backend instead of maintaining
  every textual emitter ourselves.

**Done when:** a new supported PBR material feature set produces its own shader
variant without editing a scene-specific template.

## P0 — Renderer correctness

### Complete render buckets and ordering

- [ ] Generate opaque, alpha-mask, alpha-blend, and double-sided draw buckets
  directly from Babylon render-task semantics.
- [ ] Sort transparent draws back-to-front per frame.
- [ ] Support separate pipeline state for depth write, culling, blending, and
  alpha-to-coverage.
- [ ] Remove remaining PAL-side material bucket decisions.
- [ ] Generate render order for skybox, opaque geometry, transparent geometry,
  and background ground.

**Done when:** PAL iterates generated draw commands without inspecting Babylon
material records.

### Add draw/material ID diagnostics

- [ ] Generate an optional ID render target keyed by render item and material.
- [ ] Add render-item/material metadata to parity reports.
- [ ] Map high-MAD tiles to IDs and upstream material feature sets.
- [ ] Generate an annotated hotspot image for local investigations.

**Done when:** a parity hotspot identifies the generated draw, material,
shader variant, and upstream source features responsible for the pixels.

### Match remaining PBR behavior

- [ ] Attribute the remaining BoomBox foreground MAD by material and feature.
- [ ] Implement normal texture scale.
- [ ] Implement environment intensity and direct intensity as generated
  material values.
- [ ] Validate geometric-normal orientation and double-sided normal flipping.
- [ ] Match Babylon alpha-blend luminance-over-alpha behavior.
- [ ] Add environment horizon occlusion and specular occlusion tests.
- [ ] Validate BRDF LUT addressing and all cubemap face orientations on every
  backend.
- [ ] Add optional dither matching for background passes.
- [ ] Revisit the generated ground composition against a Babylon Lite golden,
  not the Babylon.js Playground golden.

**Targets:**

- [ ] BoomBox full-image MAD at or below `0.19`.
- [ ] BoomBox foreground MAD at or below `0.03`.
- [ ] At least 99% of foreground pixels within one byte.

### GPU timing and diagnostics

- [ ] Add SDL_GPU timestamp queries where the backend supports them.
- [ ] Report CPU submission and GPU execution separately.
- [ ] Add renderer/backend/shader-format information to parity reports.
- [ ] Add optional GPU resource and draw-count diagnostics.
- [ ] Keep benchmark presentation mode immediate and three frames in flight.

## P0 — Backend portability

### Vulkan

- [ ] Build and run the generated SPIR-V shaders on Linux.
- [ ] Validate cubemap orientation, clip-space conventions, depth comparison,
  and texture color spaces.
- [ ] Capture parity output and create backend-specific regression tolerances
  only if justified by measured driver differences.
- [ ] Test at least one discrete and one integrated Vulkan adapter.

### Metal

- [ ] Build and run generated MSL on macOS.
- [ ] Validate uniform layout agreement with C++.
- [ ] Validate derivatives/specular AA, cubemap sampling, and blend behavior.
- [ ] Add an iOS build investigation after macOS is stable.

### WebGPU

- [ ] Track upstream SDL issue
  [`#10768`](https://github.com/libsdl-org/SDL/issues/10768).
- [ ] Evaluate the FriedaUCG SDL/SDL_shadercross WebGPU forks in an isolated
  experiment.
- [ ] Produce WGSL that follows SDL shader binding ordering.
- [ ] Build a browser proof of concept with Emscripten/Emdawn.
- [ ] Do not make an experimental SDL fork a required dependency.

**Done when:** one generated scene runs unchanged on D3D12, Vulkan, Metal, and
an experimental browser WebGPU target.

## P1 — TypeScript compiler coverage

### Modules and functions

- [ ] Resolve local multi-file imports and exports.
- [ ] Lower typed user functions and return values.
- [ ] Support lexical scopes and safe variable shadowing.
- [ ] Lower `if`, `switch`, `for`, `for...of`, and `while`.
- [ ] Support typed object and array literals beyond current intrinsic options.
- [ ] Add enums, discriminated unions, and narrowing needed by reachable
  Babylon modules.

### Closures and callbacks

- [ ] Classify non-escaping versus escaping closures.
- [ ] Lower non-escaping callbacks to templates or function objects.
- [ ] Define ownership for escaping captures.
- [ ] Lower render/update callbacks.
- [ ] Add a native scheduler only when reachable behavior genuinely requires
  asynchronous continuation.

### Async and dynamic imports

- [ ] Generalize immediate AOT promises beyond the current asset path.
- [ ] Generate typed dynamic-import dispatch from reachable feature metadata.
- [ ] Diagnose runtime-dependent imports that cannot be specialized.
- [ ] Preserve errors instead of silently converting unsupported async work
  into synchronous success.

### Classes and objects

- [ ] Lower the subset of classes, methods, getters, setters, and inheritance
  required by the next reachable Babylon modules.
- [ ] Define object identity and ownership rules.
- [ ] Introduce optional Boehm-backed allocations only for cyclic or
  JavaScript-managed graphs that cannot use deterministic ownership.

## P1 — glTF and asset pipeline

### glTF features

- [ ] Multiple UV sets and texture-coordinate selection.
- [ ] Texture transforms.
- [ ] Vertex colors.
- [ ] Sparse accessors.
- [ ] Additional primitive modes where Babylon supports them.
- [ ] Animation channels and samplers.
- [ ] Skinning and inverse bind matrices.
- [ ] Morph targets.
- [ ] Cameras and punctual lights.
- [ ] KTX2/Basis texture support.
- [ ] Draco/mesh compression investigation.

### Material extensions

- [ ] Emissive strength.
- [ ] IOR and specular.
- [ ] Clearcoat.
- [ ] Sheen.
- [ ] Transmission and volume.
- [ ] Iridescence.
- [ ] Anisotropy.
- [ ] Unlit materials.

Each extension must:

1. specialize from typed glTF metadata,
2. select generated shader features,
3. add focused loader and renderer tests,
4. be validated on a non-BoomBox asset.

### Packed native assets

- [ ] Define a versioned native scene/asset format.
- [ ] Prepack geometry, materials, textures, hierarchy, and animation data.
- [ ] Generate loader-free scene blobs for release builds.
- [ ] Keep source GLB loading available for development and comparison.
- [ ] Add deterministic hashes and cache invalidation.
- [ ] Measure executable, runtime, and asset-size tradeoffs.

## P1 — Runtime and data layout

- [ ] Add generation-checked handles.
- [ ] Split hot/cold record data into structure-of-arrays storage where
  profiling justifies it.
- [ ] Add dirty flags for transforms, materials, and scene bindings.
- [ ] Generate incremental GPU buffer updates.
- [ ] Add resource lifetime wrappers and leak checks.
- [ ] Add device-loss recovery.
- [ ] Add resize-safe recreation for depth and offscreen targets.
- [ ] Add multiple registered scenes and scene switching.
- [ ] Add headless renderer tests that do not require a visible desktop.

## P2 — Platform features

### Input

- [ ] Touch and pointer IDs.
- [ ] Gamepad support.
- [ ] Keyboard mapping parity.
- [ ] Configurable ArcRotate inputs.

### Audio

- [ ] Inventory reachable Babylon Lite audio APIs.
- [ ] Design an SDL audio PAL.
- [ ] Lower static sound playback first.
- [ ] Add spatial audio only after scene transforms and lifetime semantics are
  stable.

### Networking and files

- [ ] Define supported `fetch` forms beyond compile-time asset materialization.
- [ ] Add explicit native HTTP PAL only when required.
- [ ] Support local file inputs and application asset roots portably.

### Physics

- [ ] Inventory Babylon Lite physics integration.
- [ ] Keep physics behind a separate PAL/dependency boundary.
- [ ] Avoid coupling renderer migration to a physics choice.

## P1 — Testing and CI

- [ ] Add unit tests for shader IR and backend emission.
- [ ] Add generated C++ compile tests for every new TypeScript construct.
- [ ] Add malformed GLB/DDS/environment negative tests.
- [ ] Add alpha-mode and double-sided material fixture assets.
- [ ] Add cubemap orientation fixtures.
- [ ] Add deterministic screenshot tests for resize and camera input.
- [ ] Add Linux compiler/build CI without necessarily running visual parity.
- [ ] Add macOS compile CI when MSL validation begins.
- [ ] Keep hosted visual parity on the deterministic CPU path until GPU runner
  drivers are stable.
- [ ] Upload generated provenance and shader artifacts on failed CI jobs.

## P1 — Developer experience

- [ ] Add CMake presets for primitives debug, BoomBox debug, and BoomBox
  release.
- [ ] Add a single command that performs generation, shader compilation,
  configure, and build sequentially.
- [ ] Detect missing SPIR-V-capable DXC with an actionable message.
- [ ] Detect stale generated outputs before native compilation.
- [ ] Add `--explain-feature` and manifest diagnostics.
- [ ] Add a generated-code inspection command that maps C++ back to upstream
  TypeScript symbols.
- [ ] Document adding a new lowerer and a new scene fixture.

## P2 — Performance and size

- [ ] Profile CPU submission, GPU execution, asset decode, and startup
  separately.
- [ ] Measure debug and release executable sizes consistently.
- [ ] Track raw and compressed shader sizes by backend.
- [ ] Deduplicate textures and samplers.
- [ ] Batch static uploads into fewer command buffers.
- [ ] Add bind-group/pipeline caching measurements.
- [ ] Investigate meshlets, indirect draws, and GPU-driven culling only after
  correctness and general shader generation are stable.

## Documentation maintenance

- [ ] Update `docs/status.md` whenever a milestone changes supported behavior
  or measured baselines.
- [ ] Update `.github/copilot-instructions.md` when build commands, boundaries,
  or recurring pitfalls change.
- [ ] Keep the README comparison image and metrics synchronized with validated
  results.
- [ ] Keep generated provenance examples current with the pinned package.
- [ ] Remove completed items from this file and summarize them in status/Git
  history rather than leaving an ever-growing checked list.
