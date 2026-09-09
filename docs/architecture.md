# Architecture

## Pipeline

```text
TypeScript entry + reached modules
  -> resolved symbols and bounded typed values
  -> asset materialization and pinned composition
  -> AST lowerers and generated adapters
  -> C++20 + WGSL + assets + provenance
  -> SDL3 platform services + SDL_GPU or Dawn
```

The pin is defined by `upstream/babylon-lite.json`.
`upstream-source.ts` reconstructs TypeScript from package source maps;
`pinned-wgsl-build.ts` applies the package shader transform.

## Ownership

| Layer | Owns | Source |
| --- | --- | --- |
| Entry compiler | User-code semantics, typed values, reach and main emission | `src/compiler.ts`, `src/compiler/` |
| Pipeline | Assets, composition and output | `src/cli.ts`, `compose-pipeline.ts`, `upstream-lower.ts` |
| Pinned execution | Actual producers/loaders/composers with recording seams | `src/pinned-*.ts`, `executed-module-assets.ts` |
| Lowerers | Pinned AST translation and structural contracts | `src/lowering/` |
| Runtime data | Handles, JS identities, scene state, scheduling | `native/include/bblite/` |
| Shared PAL | OS services and backend-neutral transport | `native/src/pal*.hpp` |
| GPU PALs | Device resources, bindings, encoding, presentation | `pal_sdl_gpu*`, `pal_dawn*` |
| Subsystem PALs | Library adaptation | UI, audio, physics and navigation PALs |

Generate Babylon semantics; handwrite platform/library adaptation. Structural
transcriptions still need explicit source contracts. A C++ string emitter is
not proof of AST translation. [Fidelity](fidelity.md) owns adaptations and the
generated evidence inventory.

## Compiler architecture

`compiler/program.ts` owns the TypeScript program; `symbols.ts` resolves
intrinsics. Expression/statement/assignment/property modules dispatch constructs.
Static evaluation folds proven values; `intrinsics/` separates API families.
`lowering-services.ts` declares shared compiler operations; each module selects the members it uses.
`ui-projection.ts` owns retained UI, HTML/CSS projection and host companions;
`platform-calls.ts` lowers DOM calls, timers and event registration.

`emission-transaction.ts` commits successful probes and restores compiler state
on decline or exception. Collection journals preserve aliases and iteration
order; AST nodes, checker objects and compile options remain shared inputs.

`analysis-walk.ts` shares traversal boundaries and branch-local state across
mutation, capture, reach and control-flow queries. Binding identity uses symbols.

Closure environments contain referenced native bindings. Deferred entry parts
share invocation-owned storage for locals read after a yield; other locals stay
automatic. Direct recursive groups use automatic callables, while escaping
groups retain traced callback storage.

`data-types.ts` defines storage; `data-lowering.ts` handles typed sinks.
`values/` selects metadata payloads by value kind. `native-functions.ts` emits
data functions; `user-functions.ts` specializes resource helpers by arguments,
receiver and lexical dependencies. Dedicated modules own classes, module
initialization, closures and collections.

Use `lowerPinnedFunction` for whole functions and `lowerPinnedBody` for selected
statement sequences. Storage initializers and specialized guards retain source
contracts; numeric lowering, vector bindings and header framing are shared.
Numeric bodies, UBO writers and glTF interpolation share arithmetic rendering
with explicit literal, remainder and parenthesis policies.
Custom WGSL uses typed IR/parser or strict reflected-source
contracts. Extend those boundaries before adding text recognizers.

## Scene orchestration

`scene-command.ts` resolves IDs/paths through the registry. Registry data owns
poses, thresholds and diagnostics. Generated default task graphs belong to shared
scene identity and materialize once per enabled scene. Dedicated scene/sprite/
effect/frame-graph drivers run contexts in registration order.

Property and glTF animation have separate generated runtimes with shared scene
seeking. Loaders retain local deformation data and required world bounds.
Generated composition selects mesh-feature variants; PALs transport their bytes.

## Runtime and memory

Typed handles index engine records. RAII owns local values; `bbl::js::Ref<T>`
and shared container storage preserve JS identities. Non-atomic JS references
stay on their owning frame/realm thread. Resolve handles again after operations
that can grow backing storage; do not retain invalidated vector references.

Managed records, containers and explicit callback environments expose ownership
edges to cycle collection at frame boundaries and scope teardown. Acyclic values
release immediately. Opaque native owners remain conservative roots. Structural
mutation must preserve or refuse outstanding aliases.

Physics worlds, navigation plugins/crowds and audio sessions own resources
independently. Audio data can outlive retired graph membership. Borrowed events
exist for one dispatch; retained state must copy owned values. GPU lifetimes
follow each backend's in-flight ownership rules. Worker realms and offscreen
surfaces are described in [backends](backends.md#workers-and-offscreen-surfaces).

## Renderer

Generated tables and writers determine layouts, uniforms and fixed-function
state. GPU objects stay in their backend; shared transport contains no foreign
API handles. Scene and standalone renderers share frame orchestration through
`pal_frame_conductor.hpp`; each backend selects its surface-acquisition phase.
The OS window survives renderer rebuilds. Live topology/uploads
must preserve in-flight resources; synchronization is specific to the affected
path, not a universal GPU-idle rule. See [backends](backends.md).
