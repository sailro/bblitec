# Architecture

## Pipeline

```text
entry TypeScript + local modules
  -> ts.Program / TypeChecker / resolved imports
  -> static evaluation, browser adaptation, typed values and reached APIs
  -> asset materialization + pinned loader/composer execution
  -> dedicated AST lowerers + generated runtime adapters
  -> C++20, WGSL, assets, feature manifests and provenance
  -> native build -> SDL3 + SDL_GPU or Dawn
```

The compiler supports one pin, recorded in `upstream/babylon-lite.json`.
`upstream-source.ts` reconstructs TypeScript from package source maps;
`pinned-wgsl-build.ts` applies the pin's package shader transform. Read the
pinned source when its architecture docs disagree. Upgrade commands belong
in [development](development.md).

## Ownership

| Layer | Responsibility | Main source |
| --- | --- | --- |
| Entry compiler | User-code semantics, static values, feature/asset collection and main emission | `src/compiler.ts`, `src/compiler/` |
| Pipeline | Materialization, composition and emitted artifacts | `src/cli.ts`, `src/compose-pipeline.ts`, `src/upstream-lower.ts` |
| Pinned execution | Execute actual loaders, composers or asset producers with explicit recording seams | `src/pinned-*.ts`, `src/executed-module-assets.ts` |
| Lowerers | Translate supported pinned ASTs; assert contracts for structural adapters | `src/lowering/`, especially `context.ts` and `pinned-function-lowerer.ts` |
| Native data model | Typed handles, scene records, TypeScript values and scheduling | `native/include/bblite/` |
| Shared PAL | SDL window/input/files, frame orchestration and shared upload representation | `native/src/pal.cpp`, `pal_window.hpp`, `pal_gpu_shared.hpp` |
| GPU PALs | Device objects, pipelines, bindings, uploads, pass encoding and presentation | `native/src/pal_sdl_gpu*`, `native/src/pal_dawn*` |
| Other PALs | Third-party/platform adaptation | `native/src/pal_ui_rml.cpp`, audio, physics and navigation PALs |

The ownership rule is to generate Babylon behavior and handwrite only the
platform/library boundary. The current tree still contains structural
transcriptions and substitutions; [fidelity](fidelity.md) states their
guarantees and [audit](../audit.md) tracks the rechecked exceptions. Emitting a
C++ string from TypeScript does not itself prove it was transpiled.

`generated/` is disposable. Fidelity lists source-to-native artifacts,
including feature activation and shader provenance. This page groups ownership
by concept instead of maintaining a duplicate file inventory.

## Compiler architecture

`compiler/program.ts` owns the TypeScript program. `symbols.ts` resolves
import aliases to pinned intrinsics. `expressions.ts`, `statements.ts`,
`assignments.ts` and `properties.ts` dispatch user-code constructs;
`static-evaluator.ts` and static-resolution helpers fold known values.
`compiler/intrinsics/` contains focused API families.

`data-types.ts` maps native data shapes and emits definitions.
`data-lowering.ts` handles typed sinks and container operations. Fully
data-typed functions use `native-functions.ts` and can be emitted once,
including supported recursive call groups. Handle-dependent functions use
`user-functions.ts` and inline in isolated symbol scopes. Classes, module
initialization, closure storage and handle collections have dedicated modules.
The compiler has typed values and several local IRs; a complete typed
user-code IR and general escape graph remain unfinished.

Use `LoweringContext` for pinned declarations, expressions, diagnostics and
statement inventories. Reuse `lowerPinnedFunction` for supported bodies and
the shared UBO writer lowerer for buffer writes. Contract assertions detect
the shapes they inspect; they do not prove an entire restated body equivalent.

Static custom WGSL uses the tokenizer/parser and `ShaderIrProgram` where the
supported grammar applies. Reflected strict-source paths remain for grammar
outside that subset. Formatting is not shader identity. A new shader construct
should extend the existing parser/reflection boundary before adding text
rewrites.

## Scene orchestration

`src/scene-command.ts` dispatches commands through the shared scene resolver.
The registry holds curated reference pose, thresholds and diagnostics;
unregistered repository-local TypeScript paths derive defaults. Build identity
ties native binaries and deployed shader snapshots to generated inputs.
Canonical commands and diagnostic artifacts are in
[development](development.md) and [debugging](debugging.md).

## Generated behavior

- Procedural builders, cameras, transforms, render-plan decisions and uniform
  writers are generated through feature lowerers.
- glTF packaging runs pinned compression/normalization hooks before native
  loading. The generated loader retains live scene construction, transforms,
  animation and upload inputs.
- Material composers execute the pin's PBR, Standard and node machinery.
  Generated binding/layout tables connect their stages to both PALs.
- UI analysis emits retained operations; RmlUi handles live layout and emits
  backend-neutral draw frames. Host-page companions are reviewed input data.
- Physics and audio preserve a generated Babylon-facing layer over substituted
  third-party engines. Navigation uses the pinned native Recast/Detour source.

The detailed feature surface and activation paths belong in
[features](features.md); adaptations belong in [fidelity](fidelity.md).

## Runtime and memory

Engine records generally use indexed storage and typed handles. Local C++
values use RAII; shared JavaScript identities use `bbl::js::Ref<T>` and shared
container storage. The non-atomic reference count assumes scene code executes
on the frame thread. GPU objects are backend-owned and released through their
API's deferred-lifetime rules.

Managed records, containers and explicit callback environments expose owning
edges to cycle collection at frame boundaries and generated-scope teardown.
Acyclic identities still release immediately. Native opaque owners remain
conservative roots; this does not establish lifetime safety for arbitrary
unsupported extensions. Avoid raw references into growing engine vectors;
retain handles and resolve them after operations that may append. Structural
container mutation must preserve or explicitly reject an outstanding alias.

Physics worlds, navigation plugins/crowds and audio sessions own their native
resources independently. Closing one owner preserves other live owners. Audio
handles and PCM views can retain their data after graph retirement; closing a
session stops its devices and releases its context graph.

`Borrowed` platform-event payloads are valid during one dispatch. The compiler
rejects retaining an actual borrowed event through containers, fields,
closures, listeners or timers. Owned scalar copies can escape. Timers and RAF
callbacks run through the shared frame conductor; retained closures must not
capture expired stack state or own themselves indefinitely.

The checked array/DataView/string surface and file-size caps define supported
runtime bounds. A checked failure is an explicit adaptation where JavaScript
would yield `undefined`; see fidelity.

## Animation and deformation

Property animation and glTF animation have separate generated runtimes and
share scene-level deterministic seeking. glTF loaders preserve local data for
animated nodes, skin/morph inputs and independently stored world bounds for
framing. Both renderers consume the shared deformation/instance representation;
the pin's shader composition selects corresponding mesh-feature arms.
Support and limitations are listed once in features.

## Renderer

Both backends consume generated render plans and uniform data. The shared
frame conductor owns runtime options, clocks, capture gates, callback ordering
and SDL input. Backend-specific code owns resource creation and command
encoding; [backends](backends.md) defines that seam and its removal contract.

Rendering contexts run in registration order: scenes, SpriteRenderers,
EffectRenderers and scene-less frame graphs have dedicated drivers. Their
feature gates must remove unused translation units and generated headers.
The window outlives a renderer rebuild, preserving size, focus and identity.

Live topology and buffer updates must be safe for in-flight work. Some rebuild
paths synchronize; dynamic uploads need not globally idle the GPU. Capture
deferral is governed by the bounded shared capture gate. Do not infer one
universal synchronization policy from one backend path.

## Repository invariants

Preserve pinned evidence, typed lowering, deterministic output, source
provenance, backend symmetry and explicit refusal boundaries. Validate changed
behavior through compiler tests and relevant native/parity checks. Re-audit
existing mechanisms when required; historical reviews are not exemptions.

## Backend rationale

SDL_GPU provides offline shader builds and a small native deployment. Dawn
provides a separate WebGPU implementation with a compiler stack closely
related to the browser reference. Their differential helps localize defects;
agreement alone cannot rule out a bug shared by both paths.
