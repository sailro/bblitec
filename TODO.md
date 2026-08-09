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
- Complete local validation before committing or pushing.

## P0 — Expand generalization

### Replace specialized shader templates with a general shader pipeline

- [ ] Extract the reachable Babylon composed WGSL for each material feature
  set.
- [ ] Define a typed shader intermediate representation for declarations,
  bindings, varyings, expressions, control flow, and entry points.
- [ ] Lower the required WGSL subset into the IR.
- [ ] Emit HLSL/DXIL, SPIR-V, MSL, and eventually WGSL from the same IR.
- [ ] Preserve SDL_GPU binding-space conventions across all outputs.
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

### Add deeper per-pixel diagnostics

- [ ] Add base-color/diffuse and final pre-tone-map HDR captures.
- [ ] Map hotspot tiles to intermediate value deltas and shader variant.
- [ ] Generate side-by-side annotated intermediate comparisons.

**Done when:** a hotspot can be attributed beyond one draw/material to the
specific raster or PBR intermediate that diverges.

### Babylon Lite parity ladder

Completed scene 10, 13, 32, 116, 145, 146, 163, 168, 248, 257, 266, 273, and 274
baselines are recorded in `docs/status.md`.

- [x] Scene 248: texture filtering, wrap modes, and mip selection.
- [x] Scene 168: mirrored double-sided winding and shading normals.
- [x] Scene 257: generated node negative scale.
- [x] Scene 266: double-sided negative-scale sphere grid.
- [x] Scene 273: runtime `addToScene` introducing a new material family.
- [x] Scene 274: alpha-to-coverage.
- [x] Scene 163: custom shader alpha blend + alpha test/discard.
- [x] Scene 146: PBR geometry renderer outputs, 7+4 MRT split, blits, and resolve.
- [x] Scene 145: Standard-material geometry renderer outputs via `loadBabylon`.
- [x] Scene 116: Standard/PBR no-color depth views and offscreen depth display.

### Next balanced scene batch

1. [ ] Scene 8: HDR glass, PBR alpha, reflectance, material intensities, and
   exposure/contrast.

Scenes 163, 116, and 273 completed the custom-shader, frame-graph, and runtime
mutation stages of this batch. Scene 8 is the remaining contained PBR/HDR
extension. Scene 176 remains deferred until scene-color transmission, IOR,
volume, and skybox-mode behavior have smaller independent gates.

- [ ] Scene 176: MosquitoInAmber transmission/IOR/volume.

### Match remaining PBR behavior

- [ ] Attribute the remaining BoomBox foreground MAD by material and feature.
- [ ] Implement normal texture scale.
- [x] Implement environment intensity and direct intensity as generated
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

## P1 — Testing and validation

- [ ] Add unit tests for shader IR and backend emission.
- [ ] Add generated C++ compile tests for every new TypeScript construct.
- [ ] Add malformed GLB/DDS/environment negative tests.
- [ ] Add alpha-mode and double-sided material fixture assets.
- [ ] Add cubemap orientation fixtures.
- [ ] Add deterministic screenshot tests for resize and camera input.
- [ ] Add documented Linux compiler/build validation.
- [ ] Add documented macOS compile validation when MSL work begins.
- [ ] Add a local validation bundle command that preserves reports,
  provenance, fidelity contracts, and generated shaders on failure.

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
