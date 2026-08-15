# bblitec repository instructions

## Project purpose

`bblitec` is an experimental compiler that lowers a reachable, statically
analyzable subset of `@babylonjs/lite` TypeScript to C++20. The native runtime
uses SDL3 for platform services and SDL_GPU for rendering.

The goal is not to reimplement Babylon Lite manually. Prefer generated code
derived from the pinned upstream TypeScript. Handwritten C++ belongs only in
the platform abstraction layer (PAL).

## Canonical documentation

Do not duplicate detailed facts in this file:

- `docs/architecture.md`: pipeline, ownership, runtime, renderer, deformation
- `docs/features.md`: supported feature families, compile-time versus run-time, boundaries
- `docs/development.md`: commands, build order, capture metadata, troubleshooting
- `docs/fidelity.md`: semantic policy, adaptations, diagnostics
- `docs/status.md`: measured metrics, parity scenes, diagnostics
- `TODO.md`: unfinished work only

Read the relevant canonical page before changing that area.

## Pinned upstream

- The package and source commit are pinned in `upstream/babylon-lite.json`;
  the README states the current pair. Never restate them elsewhere — a prose
  copy is what goes stale.
- Original TypeScript is reconstructed from published source maps.
- Generated files include provenance comments and
  `generated/<scene>/upstream/provenance.json`.
- Optional Tint compilation is pinned separately in `upstream/tint.json`.

Do not silently update the package or source commit. An upstream update
requires regenerating outputs, reviewing changed formulas/constants, and
rerunning all compiler, build, and parity checks.
Do not silently update Tint either; rebuild it explicitly and rerun the custom
shader compilation and parity gates.

## Source ownership

When logic describes Babylon behavior—scene traversal, camera matrices,
material properties, render buckets, PBR uniforms, shader equations, skybox or
ground geometry—it should be generated. When logic calls SDL or an operating
system API, it belongs in PAL. Never implement fixes in `generated/`. The
complete source map is maintained in `docs/architecture.md`.

## Type and language rules

- Explicit TypeScript `any` is forbidden. `test/no-any.test.ts` enforces this.
- Use typed records, discriminated unions, or `ts::JsonValue` narrowing.
- Avoid `as any`, broad casts, and success-shaped fallbacks.
- The native TS runtime is synchronous AOT by design: remote assets are
  materialized during transpilation and `Promise<T>` resolves immediately.
- Keep generated C++ C++20-compatible and warning-clean under MSVC `/W4
  /permissive-`.

## Renderer rules

- SDL_GPU is the default for generated PBR scenes.
- `BBLITE_GPU=0` forces the CPU fallback.
- glTF material handling must be metadata-driven:
  `OPAQUE`, `MASK`, `BLEND`, alpha cutoff, and double-sided state. Do not add
  scene-name, geometry-position, or reference-image heuristics.
- Do not conflate property-animation STEP/scaling support with glTF animation;
  consult the status and architecture pages for the current separate slices.
- Preserve the shader and texture contracts documented in architecture and
  fidelity; do not tune backend shaders against a golden.

## Build order

Generation must complete before native builds. Do not run generation and a
native build concurrently because `features.cmake`, generated headers, and
shader paths may be stale.

Follow the ordered workflow in `docs/development.md`.

Do not build multiple CMake trees concurrently against the same vcpkg install.
An executing debug `.exe` may also cause `LNK1168`.

## Validation

Use the smallest relevant checks. Complete the validation matrix documented
in `docs/development.md` for compiler, renderer, loader, shader, animation, or
PAL milestones.

## Workflow

- Do not edit generated files as the source of truth.
- Use `npm run scene -- process <source.ts>` for an unregistered scene.
- Add a registry entry only for curated thresholds, custom references,
  environment flags, or attribution capabilities.
- Curated scene inputs, thresholds, and goldens are evidence. Do not alter
  them to improve MAD. New references require an intentional pinned-scene
  integration or explicit recapture.
- Add tests when extending compiler or lowering behavior.
- Keep lowerers focused; do not rebuild a monolithic compiler class.
- Preserve provenance for generated behavior.
- Record every intentional semantic adaptation in generated `fidelity.json`.
- Keep shader formulas tied to upstream markers in
  `renderer-fidelity.json`; do not tune backend shaders against a golden.
- Avoid unrelated cleanup.
- There is no hosted CI. Complete the documented local validation matrix
  before committing or pushing.
- Batch validated milestones and push intentionally.
