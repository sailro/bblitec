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

- [ ] Extract reachable composed WGSL per built-in material feature set.
- [ ] Emit SDL-compatible SPIR-V directly from Tint instead of recompiling
  normalized Tint HLSL with DXC.

## P0 — Renderer correctness

Corpus gates for each subject:

| Subject | Corpus scene |
| --- | --- |
| opaque/mask/blend/double-sided/A2C buckets | 249 plus existing 10/163/168/274 |
| transparent back-to-front sorting | 145 for meshes; 55 for billboards |
| mixed material families and PAL decision removal | 213 (GridMaterial opaque + transparent) |
| skybox/opaque/transparent/background ordering | 8 plus existing 13 |
| base color and pre-tone-map diagnostics | BoomBox and 146 |
| hotspot/intermediate attribution | BoomBox |
| Standard/PBR geometry-output residuals | 145 and 146 |
| normal texture scale | 253 (`AnimateAllTheThings`, broad dependency set) |
| transparent luminance-over-alpha | 8 |
| horizon/specular occlusion | 73 or focused BoomBox diagnostics |
| BRDF/cubemap orientation | 20 and 265 |
| generated-ground composition | 13 |
| background noise/dither | 112 (also requires KTX2) |

- [x] Generate material kind, alpha bucket, cull mode, shader variant, and
  alpha-to-coverage classification from Babylon render-task semantics.
- [x] Generate ordered draw-command lists so PAL no longer filters classified
  render items; scene 213 gates mixed GridMaterial opaque/transparent draws.
- [x] Sort transparent mesh draws back-to-front per frame (scene 145).
- [x] Move material-family/pipeline discovery and ordering decisions out of
  PAL; PAL now consumes generated features, stages, and draw lists.
- [x] Generate final skybox/opaque/transparent/ground ordering (scenes 8/13).
- [x] Add raw base-color and pre-tone-map HDR diagnostics.
- [x] Map final-image hotspots to shader variants and available intermediate
  buffer deltas.
- [ ] Reduce scene 145 geometry-output residuals; scene 146 is now
  `0.868 / 0.889`.
- [ ] Reduce BoomBox below `0.19` full and `0.03` foreground MAD.

### Remaining PBR gaps

- [ ] Replace the deterministic HDR box-filtered mip representation with the
  pinned 1024-sample GGX prefilter; scene 8 already gates mip zero, glass
  controls, skybox composition, and image processing.
- [ ] Implement normal texture scale.
- [x] Match the pinned glTF 4x anisotropic sampler gate (BoomBox/249).
- [x] Match Babylon transparent luminance-over-alpha behavior (scene 8).
- [ ] Add horizon/specular occlusion gates.
- [ ] Validate BRDF LUT and cubemap orientation on every backend.
- [ ] Revisit generated-ground composition against a Babylon Lite golden.
- [ ] Match position-seeded background dither without cross-backend noise
  decorrelation.

## P0 — Next scene gates

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
