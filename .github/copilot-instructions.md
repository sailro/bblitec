# bblitec repository instructions

## Project purpose

`bblitec` is an experimental compiler that lowers a reachable, statically
analyzable subset of `@babylonjs/lite` TypeScript to C++20. The native runtime
uses SDL3 for platform services, and renders through either SDL_GPU or Dawn —
a scene is not integrated until it renders correctly on both.

The goal is not to reimplement Babylon Lite manually. Prefer generated code
derived from the pinned upstream TypeScript. Handwritten C++ belongs only in
the platform abstraction layer (PAL).

## Canonical documentation

Do not duplicate detailed facts in this file:

- `docs/architecture.md`: pipeline, ownership, runtime, renderer, deformation
- `docs/features.md`: supported feature families, compile-time versus run-time, boundaries
- `docs/development.md`: commands, build order, capture metadata, troubleshooting
- `docs/debugging.md`: the diagnostic ladder and the capture tools
- `docs/fidelity.md`: semantic policy, adaptations, diagnostics
- `docs/backends.md`: the two GPU render backends
- `docs/status.md`: measured metrics, parity scenes, diagnostics
- `TODO.md`: unfinished work only

Read the relevant canonical page before changing that area.

## Diagnose by capture, not by inference

**This is the habit that matters most in this repository.** A rendering
difference is answered by a command, not by reasoning about the picture.
The recurring cost here has never been a hard bug — it has been an
afternoon of inference that one command would have ended. If you are
about to explain a rendering difference without having captured
anything, stop and capture.

```powershell
npm run scene -- diff scene33                  # browser vs native, field by field
npm run scene -- parity scene33 --differential # SDL_GPU vs Dawn: CPU side or GPU side
npm run scene -- capture scene33               # the browser's shaders, buffers, draws
npm run scene -- capture scene33 --native      # our uniforms, draw list, scene model
npm run scene -- uniforms scene33 --size 96    # decode one browser buffer as named fields
```

Four rules:

- **The loader is the specification. The file format is not.** When you
  need to know what a glTF property means to Babylon, open the loader
  extension that reads it — never reason from what the property means in
  the glTF spec, and never generalize one extension's rule to its
  neighbours: a declared extension is enabled *with no factor at all*
  (`isEnabled: true` unconditionally, in all four of them); a
  `KHR_texture_transform: {}` patches nothing so composes no transform;
  a `baseColorFactor` with no image behind it is baked into the texel
  and declares no UBO field; `ior !== 1.5` alone turns the reflectance
  layer on; and an *animated* pointer can change a material's shape —
  an animated occlusion strength registers the reflectance extension,
  which then takes occlusion over entirely. None of those are guessable
  and all of them are two minutes of reading.

- **Never call a residual a floor from statistics alone.** A floor claim
  is a claim about a mechanism and needs one: the pinned line that does
  something ours does not. Percentages of matching pixels are not that.
  Look for that line in an *arm* rather than in the arithmetic — upstream
  forks whole blocks on a boolean recording where an object came from
  (`useF0Remap` from the glTF clearcoat loader, `hasAlbedoScaling` from
  the sheen setter, `_cullMode` from a pipeline-descriptor default), and
  an arm we never compose looks exactly like a small systematic bias.
- **Measure the PNG, do not eyeball it.** "The sprites are in the wrong
  place" is a guess; "exactly 7200 px at (640,180)-(719,269)" named the
  bug immediately.
- **Bisect a defect before trusting the name it arrived with.** Toggle the
  suspect off and re-measure; the element whose removal makes the number
  *worse* is not the cause. A background quad filed against the
  environment ground was the DDS skybox, and one `BBLITE_GROUND=0` run
  said so.

`docs/debugging.md` carries the full ladder, how to read a `diff` report,
and the compile-probe method for sizing an unintegrated scene before
writing any code. Read it when starting an integration or chasing a
residual.

## Pinned upstream

- The package and source commit are pinned in `upstream/babylon-lite.json`;
  the README states the current pair. Never restate them elsewhere — a prose
  copy is what goes stale.
- Original TypeScript is reconstructed from published source maps.
- **Read the upstream module doc before sizing a capability.** The pinned
  clone carries Babylon Lite's own architecture docs under
  `docs/lite/architecture/` (also published at
  <https://doc.babylonjs.com/lite/>) — one file per subsystem: sprites,
  shadows, picking, node materials, the frame graph, large-world rendering.
  They state the preconditions, the exact list of quantities a feature
  touches, and often the corpus scene that exercises each one, so reading the
  page first replaces a strip probe and several hours of reading source. The
  large-world page, for instance, names the scene behind every floating-origin
  bake (202/203 lights, 204 thin instances, 205/206 sprites, 207 shadows,
  208 node materials, 209 physics) and states that `createEngine` throws when
  `useFloatingOrigin` is set without `useHighPrecisionMatrix`.
- **In those docs, "Babylon.js" is the legacy library, not our target.** They
  are written for Babylon Lite, and they reason about Babylon.js because that
  is what *Lite* checks itself against. Our reference is Lite alone: the
  golden is the Lite scene run in the browser, so an upstream parity scene
  described as "Lite versus BJS" is not the comparison we make. A feature the
  page calls out of scope because it is *degenerate in Babylon.js* — clip
  planes, clustered point lights, the background-ground fresnel under
  large-world rendering — is a statement about the legacy reference having no
  correct far-from-origin answer to match. It says nothing about what Lite
  renders, and nothing about whether we must match it: if a reached scene puts
  Lite through that path, Lite produces pixels and the golden carries them.
- **The docs orient; the pinned source still decides.** They are versioned
  beside the code but drift from it — the large-world page describes a
  `scene._floatingOriginOffset` mirror and a per-frame
  `updateFloatingOriginOffset` that the pinned `floating-origin.ts` says it
  deleted as "net cost without value". Where the two disagree, lower from the
  source and say so.
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

- A build configures `BBLITE_BACKEND=BOTH` when the pinned Dawn library is
  installed and SDL_GPU otherwise; `BBLITE_GPU_BACKEND=dawn` selects Dawn at
  run time in a dual-backend build.
- **Both backends, or the scene is not integrated.** A scene measured on one
  backend has no independent check on it at all, and making the gap visible
  (a flag, an unmeasured column, a TODO) documents an unfinished job rather
  than making it acceptable.
- Run the scene in the demo window and move the camera before calling an
  integration done. A gate renders the one pose its author chose; orbiting has
  found defects a green matrix passed. When it finds something, turn it into a
  measurement — copy the scene to `examples/`, move its camera there, and
  `parity --recapture-reference` — rather than a screenshot.
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
PAL milestones:

```powershell
npm test
npm run scenes:process
npm run scenes:parity
npm run status:verify
```

`scenes:process` *is* compile, shaders and build — naming the steps separately
runs generation twice.

For a change confined to TypeScript the cheap proof is stronger than the
matrix: compile every scene and digest `generated/`. Byte-identical output plus
an untouched `native/` tree means the build stamps match, which means the
binaries are the same, which means no measurement can have moved. See
`docs/development.md`.

## Workflow

- Do not edit generated files as the source of truth. Hand-instrumented files
  under `generated/` survive a `scene -- build` and are wiped by the next
  `compile` — useful for disposable printf debugging, never for a fix.
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
- **Do not type a shader formula out.** The pinned `composeShader` runs
  under Node, so whole shaders are *composed* rather than transcribed —
  `createPbrComposer` and `composeSceneStandardVariants` ship the pin's
  own per-variant stages for both material families, and packaged
  literals lift through the extraction helpers in
  `src/pinned-shader-composer.ts`. A re-typed formula agrees only until
  upstream changes it. Give it no transcribed fallback either: the
  fallback is the copy that drifts.
- **Fold the pin's builder when the shape is the contract; execute it when
  the value is fragile.** Both are legitimate ports, and which one applies
  is a question about the thing being ported, not a preference. A shader
  builder's *shape* is what must not drift, so it is folded and any change
  refuses generation. A computed asset's *value* is what must not drift,
  and folding cannot promise that: the palette scenes 93 and 95 sample is
  `Math.sin` rounded to a byte, which this compiler has no `Math.round` to
  lower at all, and three of its 768 channel values sit one ulp of `sin`
  from a rounding boundary. So it is executed in the engine the golden runs
  it in and baked, like the drawn atlas, and recorded as an adaptation.
  Executing hides a shape change, so never execute what you can fold.
- **Reach a capability where the pin reaches it.** Upstream keeps optional
  features behind lazily-registered null hooks — `sprite/sprite-fx-hook.ts`
  for custom shaders, `pbr-flags.ts` for the PBR extensions — so the
  always-loaded path names nothing and the *factory call* is the opt-in
  trigger. Mirror that: reach the feature at the same call, and let a
  layer or system without one fall back exactly as the null hook does.
  Do not invent a second detector by scanning options or sniffing text;
  a port that decides reachability differently from the pin will disagree
  with it eventually.
- There is no hosted CI. Complete the documented local validation matrix
  before committing or pushing.
- Batch validated milestones and push intentionally.
