# Architecture

## Pipeline

```text
TypeScript + reached modules → typed lowering + asset/shader composition
→ C++20 + WGSL + assets + provenance → SDL3 + SDL_GPU/Dawn
```

The source pin is [upstream/babylon-lite.json](../upstream/babylon-lite.json).
`upstream-source.ts` reads package source maps; `pinned-wgsl-build.ts` applies the shader transform.

## Ownership

| Layer | Source | Responsibility |
| --- | --- | --- |
| Entry compiler | `src/compiler.ts`, `src/compiler/` | TypeScript semantics, reach, storage, entry emission |
| Pipeline | `cli.ts`, `compose-pipeline.ts`, `upstream-lower.ts` | Composition, assets, output |
| Pinned execution | `pinned-*.ts`, `executed-module-assets.ts` | Source producers and recording adapters |
| Lowerers | `src/lowering/` | Pinned AST translation |
| Runtime | `native/include/bblite/` | Handles, JS identities, scene state, scheduling |
| Shared PAL | `native/src/pal*.hpp` | Platform services and transport |
| GPU PALs | `pal_sdl_gpu*`, `pal_dawn*` | Resources, bindings, encoding, presentation |
| Subsystem PALs | UI, audio, physics, navigation | Library adaptation |

Babylon behavior comes from pinned source; PAL owns platform adaptation.
Semantic substitutions are listed in [fidelity](fidelity.md).

## Compiler architecture

| Module | Responsibility |
| --- | --- |
| `program.ts`, `symbols.ts`, `type-facts.ts` | TypeScript program, declaration origin and symbol resolution, nullable-union members |
| Expressions, statements, assignments, `intrinsics/` | Source lowering |
| `declarations.ts` | Variable declarations and binding patterns |
| `properties.ts` | Property rules and property access |
| `data-types.ts`, `data-lowering.ts`, `values/` | Storage types, typed sinks, value metadata |
| `native-functions.ts`, `user-functions.ts`, `classes.ts` | Native functions, specialization, classes |
| `class-members.ts` | Class member tables, inheritance chains and the program's class hierarchies |
| `module-initializers.ts` | Ordered initialization and shared mutable bindings |
| `scene-manifest.ts`, `scene-materials.ts` | Scene composition records and their `manifest.json` projection |
| `emission-transaction.ts` | Rollback on declined or failed lowering |
| `binding-scopes.ts` | Lexical scopes, name bindings and capture refusals; pinned temporaries and materialized records |
| `conditions.ts`, `comparisons.ts` | Condition truth tests, comparison operators and settled folds |
| `browser-erasure.ts` | Browser-only predicates, deployment folds and erased-expression records |
| `analysis-walk.ts`, `lowering-services.ts` | Shared traversal and compiler interface |
| `ui-projection.ts`, `platform-calls.ts` | Retained UI and platform calls |

Dynamic storage demands replay emission against the same parsed program. Earlier aliases and
initializers use the selected representation. Equivalent definitions share code; invocations retain
distinct captures and resource identities. Pinned functions use `lowerPinnedFunction`; selected bodies
use `lowerPinnedBody`. WGSL uses typed IR or explicit reflected-source contracts.

Namespace-scope application functions and constant tables compile in one C++ translation unit per owning source,
listed in `manifest.json` as `sourceUnits`. `main.cpp` owns entry execution; worker entries have
separate units and namespaces. Shared types and declarations live in `sources/application.hpp`
(one header per realm); template bodies appear only in units that use them. Paths mirror source folders
from their common directory; worker realms live under `sources/workers/<module>/`. Single-source programs retain one file.
Folded imports emit no unit; specialized inline bodies remain with their caller. Module initialization
and shared bindings retain their ordered entry execution.

Ordinary loops remain native loops, including small constant ranges. Static expansion is reserved for
composition that needs distinct generation-time values or frame-yield continuations. Shared functions,
callbacks and coroutines retain separate invocation state. A body is emitted once when every effect it
reaches has a native representation (`canShareFunctionBody`); otherwise each call specializes it. Concrete
capture types place those bodies in their owning source unit; unresolved capture types use templates.

Fresh native temporaries transfer into source locals; immutable bindings can borrow stable owners.
Rebound parameters own their binding while object and container mutations preserve shared identity.
Escaping callbacks capture copyable handles by value, including handles borrowed by local aliases or parameters.

## Scene orchestration

`scene-command.ts` resolves registry IDs and paths. The registry owns poses, thresholds and diagnostics.
Executables start with authored live defaults; parity and checks apply the registered query to the same
executable.
Scene, sprite, effect and frame-graph drivers run registered contexts in order. Default task graphs
belong to scene identity. Property and glTF animation retain separate playback contracts.

## Runtime and memory

- Handles reach engine records only through `bbl::handle_at`, which checks the table bound and, for meshes,
  the slot generation; resolve them again after storage growth.
- RAII owns locals. Shared containers and `bbl::js::Ref<T>` preserve JS identity.
- Computed method receivers retain their selected owner through callbacks and cycle collection.
- Closures retain referenced cells; suspended calls own their live locals.
- Records, callbacks and containers whose elements can own a traced edge participate in cycle collection at
  frame boundaries and teardown; other container storage is released by reference counting alone. Only
  complete payloads enter the registry; they detach before destruction.
- Managed statics and GC registries are realm-local; teardown clears payloads before releasing registry storage.
- Non-atomic JS references stay on their owning realm. Borrowed events last one dispatch.
- Physics, navigation and audio owners are independent of renderer lifetime.
- GPU resources remain alive through their in-flight submissions.
- Destructors and noexcept release paths report a broken invariant through `bblite/teardown.hpp`, then
  terminate.

## Renderer

Generated tables own layouts, uniforms and fixed-function state. `pal_frame_conductor.hpp` shares frame
phases; GPU objects and acquisition order remain backend-specific. The OS window survives renderer
rebuilds. See [backends](backends.md), including [worker ownership](backends.md#workers-and-offscreen-surfaces).
