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

`data-types.ts` defines storage; `data-lowering.ts` handles typed sinks.
Data-typed functions use `native-functions.ts`, including supported recursion;
handle-dependent helpers inline through `user-functions.ts`. Dedicated modules
own classes, module initialization, closures and collections. A general typed
user-code IR/escape graph remains unfinished.

Reuse `LoweringContext`, `lowerPinnedFunction`, numeric lowering and the
shared UBO writer. Custom WGSL uses typed IR/parser or strict reflected-source
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
follow each backend's in-flight ownership rules.

### Worker service design

AOT entry factories create independent module state. Each realm owns tasks,
microtasks, timers, promises and JS identities. Computation workers need no GPU.
Typed sender/receiver codecs preserve admitted aliases/cycles and ordered messages.

The OS thread owns window/layout/presentation. Only owned messages, document
snapshots, dimensions and fenced image leases cross threads; engine records and
JS references do not. Source callbacks run on their realm. Canvas transfer
validates before detachment and preserves exclusive context ownership.

Display notifications coalesce per busy realm; they do not accumulate catch-up
frames. Surface publication does not own worker time or message delivery.
`close` finishes the current callback/microtasks; `terminate` wakes waits and
uses compiled cancellation points. Arbitrary native calls are not preemptible.

The service does not interpret application message names. First rendered frame,
application readiness and OS presentation are distinct events. Worker-free paths
omit worker scheduling/locks. [Features](features.md#program-compilation) owns
admission, [backends](backends.md#offscreen-surfaces) owns image transport and
[TODO](../TODO.md#worker-and-platform) owns expansion.

## Renderer

Generated tables and writers determine layouts, uniforms and fixed-function
state. GPU objects stay in their backend; shared transport contains no foreign
API handles. The OS window survives renderer rebuilds. Live topology/uploads
must preserve in-flight resources; synchronization is specific to the affected
path, not a universal GPU-idle rule. See [backends](backends.md).
