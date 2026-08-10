# bblitec TODO

Only unfinished work belongs here. Completed capabilities and measured
baselines belong in [status](docs/status.md) and Git history.

## Constraints

- derive Babylon behavior from the pinned upstream TypeScript
- keep handwritten C++ at the PAL/resource boundary
- preserve tree shaking, provenance, typed records, and C++20 portability
- do not add scene, geometry, or golden-image heuristics
- validate generation, native builds, and relevant parity gates locally

## P0 — General shader pipeline

- [ ] Extract reachable composed WGSL per material feature set.
- [ ] Define a typed shader IR for declarations, bindings, varyings,
  expressions, control flow, and entry points.
- [ ] Lower the required WGSL subset into the IR.
- [ ] Emit/reflection-check HLSL/DXIL, SPIR-V, MSL, and eventually WGSL.
- [ ] Cache identical variants across meshes and scenes.
- [ ] Evaluate Tint or SDL_shadercross as the backend.

**Done when:** a new material feature does not require another hand-maintained
backend shader template.

## P0 — Renderer correctness

- [ ] Generate opaque, mask, blend, double-sided, and alpha-to-coverage draw
  commands directly from Babylon render-task semantics.
- [ ] Sort transparent draws back-to-front per frame.
- [ ] Move remaining material/order decisions out of PAL.
- [ ] Generate final skybox/opaque/transparent/ground ordering.
- [ ] Add base-color and pre-tone-map HDR diagnostics.
- [ ] Map hotspots to shader variants and intermediate deltas.
- [ ] Reduce scene 145/146 geometry-output residuals.
- [ ] Reduce BoomBox below `0.19` full and `0.03` foreground MAD.

### Remaining PBR gaps

- [ ] Implement normal texture scale.
- [ ] Match Babylon transparent luminance-over-alpha behavior.
- [ ] Add horizon/specular occlusion gates.
- [ ] Validate BRDF LUT and cubemap orientation on every backend.
- [ ] Revisit generated-ground composition against a Babylon Lite golden.
- [ ] Add optional background dither matching if upstream requires it.

## P0 — Next scene gates

- [ ] Scene 8: HDR environment, PBR glass alpha, reflectance, material
  intensities, exposure, and contrast.
- [ ] Add smaller independent gates for skybox mode, scene-color transmission,
  IOR, and volume.
- [ ] Scene 176: MosquitoInAmber, after those prerequisites pass.

## P0 — Backend portability

### Vulkan

- [ ] Build and run generated SPIR-V on Linux.
- [ ] Validate depth, clip space, cubemap orientation, and texture color spaces.
- [ ] Test discrete and integrated adapters.

### Metal

- [ ] Build and run generated MSL on macOS.
- [ ] Validate uniform layout, derivatives, cubemaps, and blending.
- [ ] Investigate iOS after macOS is stable.

### WebGPU

- [ ] Track SDL issue
  [`#10768`](https://github.com/libsdl-org/SDL/issues/10768).
- [ ] Evaluate experimental SDL/SDL_shadercross WebGPU forks separately.
- [ ] Produce SDL-compatible WGSL bindings and an Emscripten proof of concept.

## P1 — TypeScript compiler coverage

### Modules and functions

- [ ] Resolve local multi-file imports and exports.
- [ ] Lower typed user functions and return values.
- [ ] Support lexical scopes and safe variable shadowing.
- [ ] Lower `if`, `switch`, `for`, `for...of`, and `while`.
- [ ] Generalize typed object and array literals.
- [ ] Add enums, discriminated unions, and narrowing.

### Closures and async

- [ ] Classify escaping and non-escaping closures.
- [ ] Lower general render/update callbacks.
- [ ] Define ownership for escaping captures.
- [ ] Generalize immediate AOT promises and dynamic-import dispatch.
- [ ] Add a native scheduler only for genuinely runtime-dependent async work.

### Classes and objects

- [ ] Lower the required class/method/getter/setter/inheritance subset.
- [ ] Define object identity and ownership.
- [ ] Add optional GC only for cyclic or JavaScript-managed graphs that cannot
  use deterministic ownership.

## P1 — Assets and materials

### glTF

- [ ] Multiple UV sets and texture-coordinate selection.
- [ ] Texture transforms and vertex colors.
- [ ] Sparse accessors and additional primitive modes.
- [ ] Animation, skinning, morph targets, cameras, and punctual lights.
- [ ] KTX2/Basis and compression investigations.

### Material extensions

- [ ] Emissive strength, IOR/specular, clearcoat, sheen.
- [ ] Transmission/volume, iridescence, anisotropy.
- [ ] Require typed metadata specialization, focused tests, and a non-BoomBox
  parity scene for each extension.

### Packed native assets

- [ ] Define a versioned native scene format with deterministic hashes.
- [ ] Prepack geometry, materials, textures, hierarchy, and animation data.
- [ ] Retain source loaders for development and parity.
- [ ] Measure startup, runtime, and size tradeoffs.

## P1 — Runtime and validation

- [ ] Add generation-checked handles and resource lifetime/leak checks.
- [ ] Add dirty flags and incremental GPU updates.
- [ ] Add device-loss and resize-safe resource recreation.
- [ ] Add multiple registered scenes and scene switching.
- [ ] Add headless renderer tests.
- [ ] Add differential tests for camera, environment, material, and transform
  functions.
- [ ] Add malformed asset and backend-layout tests.
- [ ] Add a validation bundle command that preserves artifacts on failure.

## P1 — Developer experience

- [ ] Add portable CMake presets.
- [ ] Improve missing-tool and stale-output diagnostics.
- [ ] Add `--explain-feature` and generated-code-to-upstream inspection.
- [ ] Document adding a lowerer and curated scene fixture.

## P2 — Platform and performance

- [ ] Add touch, gamepad, and fuller keyboard mapping.
- [ ] Inventory and lower static audio playback behind an SDL audio PAL.
- [ ] Add runtime HTTP/files only when compile-time materialization is
  insufficient.
- [ ] Keep physics behind an independent PAL/dependency boundary.
- [ ] Separate CPU submission, GPU execution, decode, and startup timing.
- [ ] Track executable, shader, and asset sizes consistently.
- [ ] Deduplicate resources and batch uploads before investigating meshlets,
  indirect draws, or GPU-driven culling.

## Documentation maintenance

- [ ] Keep status metrics and the README comparison image synchronized with
  validated results.
- [ ] Update development and repository instructions when build workflows or
  recurring pitfalls change.
- [ ] Keep this file free of completed-history checklists.
