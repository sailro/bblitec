# Architecture

```text
TypeScript + reached modules → typed lowering + asset/shader composition
→ C++20 + WGSL + assets + provenance → SDL3 + SDL_GPU/Dawn
```

Assets, closed producers and shader composition run at generation; state, input, animation and rendering run natively.
Source pin: [upstream/babylon-lite.json](../upstream/babylon-lite.json). `upstream-source.ts` reads package source maps,
`pinned-program.ts` type-checks them as one program, `pinned-wgsl-build.ts` applies the shader transform.

## Ownership

| Layer | Source | Responsibility |
| --- | --- | --- |
| Entry compiler | `src/compiler.ts`, `src/compiler/` | TypeScript semantics, reach, storage, entry emission |
| Pipeline | `cli.ts`, `compose-pipeline.ts`, `upstream-lower.ts` | Composition, assets, output |
| Pinned execution | `pinned-*.ts`, `executed-module-assets.ts` | Source producers and recording adapters |
| Lowerers | `src/lowering/` | Pinned AST translation |
| Runtime | `native/include/bblite/` | Handles, JS identities, scene state, scheduling |
| Shared PAL | `native/src/pal*.hpp` | Platform services and transport |
| GPU PALs | `pal_sdl_gpu*`, `pal_dawn*` | [Backends](backends.md) |
| Subsystem PALs | UI, audio, physics, navigation | Library adaptation |

## Activation

| Input | Selects |
| --- | --- |
| Reached APIs, properties, globals | Generated code, PAL units, native dependencies |
| Call options, asset loader predicates | Runtime features, codecs, material variants |
| Pinned composition | Shader arms, layouts, bindings |
| Registry | Source, title, host UI, reference query, attribution |
| Build options | Backend, capture, size, PCH |

Reaching a factory activates its module even when an option disables it; only a literal parser opt-out
(`loadBabylon({ loadCamera: false })`) skips one.

## Generated records

Paths are relative to `generated/<id>/`.

| File | Records |
| --- | --- |
| `manifest.json` | Reached graph, features, assets |
| `fidelity.json` | Adaptations and risks |
| `upstream/provenance.json` | Pinned modules/symbols |
| `upstream/feature-activation.json` | Reach sites, asset joins, activation reasons, consumers |
| `upstream/renderer-fidelity.json` | Renderer formats/invariants |
| `upstream/shaders/composition.json`, `shader-compiler.json` | Composed modules; compiler/target identity |

## Compiler modules (`src/compiler/`)

| Module | Responsibility |
| --- | --- |
| `program.ts`, `symbols.ts`, `type-facts.ts` | Program, declaration origin, symbols, nullable-union members |
| Expressions, statements, assignments, `intrinsics/` | Source lowering |
| `declarations.ts`, `properties.ts` | Declarations and binding patterns; property access |
| `data-types.ts`, `data-lowering.ts`, `values/` | Storage types, typed sinks, value metadata |
| `native-functions.ts`, `user-functions.ts`, `classes.ts`, `class-members.ts` | Functions, specialization, classes and hierarchies |
| `function-storage-flow.ts` | Callback contract connections; refuses dropped arguments a value reads |
| `module-initializers.ts` | Ordered initialization, shared mutable bindings |
| `scene-manifest.ts`, `scene-materials.ts` | Scene records and `manifest.json` |
| `emission-transaction.ts` | Journaled compiler state; commit folds into the parent, failure restores. Unjournaled fields need `@unjournaled` with a reason |
| `binding-scopes.ts` | Scopes, bindings, capture refusals |
| `conditions.ts`, `comparisons.ts` | Truth tests, comparisons, settled folds |
| `browser-erasure.ts`, `dom-lowerings.ts` | Browser-only predicates, deployment folds, erased expressions; the lowered DOM APIs |
| `analysis-walk.ts`, `lowering-services.ts` | Shared traversal and compiler interface |
| `ui-projection.ts`, `platform-calls.ts` | Retained UI, platform calls |
| `callbacks.ts`, `shared-closure-analysis.ts` | Frame/platform/physics callbacks; shared vs rebound captures |
| `engine-lifecycle.ts`, `async-activations.ts` | `startEngine` continuation, frame yields, device recovery; async activations, worker hooks |
| `intrinsic-options.ts`, `asset-registry.ts`, `admissions.ts` | Intrinsic options; assets; deferred capability admissions |
| `native-emission-registry.ts` | Namespace-level definitions, shared bodies, environment structs, static tables |
| `native-statements.ts`, `body-outlining.ts` | Emitted control-flow facts; outlining large bodies |

## Lowering invariants

- Storage demands trigger a discarded discovery pass, repeated to a fixed point, before strict emission. Coverage and
  surveys keep only strict attempts.
- A feature marked `applicationRealm` (`feature-activation.ts`) replays the whole program in the application realm
  from `reachFeature`; explicit `ApplicationRealmRequired` throws remain only for conditional shapes.
- Erasure never drops an API `dom-lowerings.ts` lists, and an erased method call needs a receiver `isBrowserOwner`
  classifies as browser state; any other receiver refuses.
- A site refusal decided after lowering (erased element writes, static class queries) goes through `refuseLoweredSite`:
  a survey records it against the site's statement and continues.
- Namespace member calls (`N.f`) are rewritten only in `compileCall`. Never in the shared `unwrap`: it would silently
  admit writes and rewrite library namespaces (`Intl.*`).
- Pinned functions use `lowerPinnedFunction`, selected bodies `lowerPinnedBody`. Plain-record pinned modules and whole
  libraries (text, splat stream, MeshLoD) use `PinnedRecordModel`; `pinned-record-transport.ts` rebuilds generation-time
  records; shapes live in `record-shapes.ts`. A lowered library is one `LoweredLibrary` (`library-runtime.ts`).
- A closure is a `bbl::js::Callback` over its frame's environment struct (named structs of numbered captures, one per
  shape). Array-method callbacks are native lambdas.
- `unknown` is `JsonValue` (`pinned_json.hpp`). Async functions are C++20 coroutines over `bbl::js::Promise`
  (`pinned_async.hpp`); `finally` is a guard run once per exit.
- Operands the entry compiler's `EvaluationOrder` pins are evaluated into temporaries in source order; an `await` a
  lambda would still hold refuses.
- Bundled packages bind by `package#name` to native records and adapters. Lowered libraries spell web platform objects
  through `src/lowering/web-platform-schema.ts` over `web_platform.hpp`; fetch, image decode, timers and task queue are
  a seam in `pal_web_platform.cpp`. Lowered library runtime: `library_runtime.hpp`. Text pipeline policy: `text_gpu.hpp`.
- A body is shared across distinct generation-time arguments when every reached effect has a native representation
  (`canShareFunctionBody`, `reachesOnlyClosedEffects`); otherwise it specializes inline. Ordinary loops stay native;
  static expansion only for generation-time values or frame yields.

## Emitted units

- Application code compiles per owning source, listed in `manifest.json` `sourceUnits`; sources over
  `unitMaximumWeight` split into `.part<N>.cpp`. `main.cpp` owns entry execution; workers live under
  `sources/workers/<module>/`; `sources/application.hpp` holds includes per realm.
- Bodies over `outlinedBodyMinimumBytes` outline statements into functions taking locals by reference; loops move whole.
- Lowered library modules share declarations in `upstream/include/bblite/upstream/units/`; parts are in `generatedSources`.

## Scene orchestration

`scene-command.ts` resolves registry IDs and paths; `src/scene-registry.ts` owns poses, thresholds and diagnostics.
Executables start with authored live defaults; parity and checks apply the registered query to the same executable.

## Runtime and memory

- Handles reach engine records only through `bbl::handle_at` (bound and mesh generation checked) or `bbl::handle_find`
  (null when missing). Resolve again after storage growth.
- RAII owns locals; shared containers and `bbl::js::Ref<T>` keep JS identity.
- Payloads that can own a traced edge join cycle collection at frame boundaries and teardown; others are reference
  counted. Statics and GC registries are realm-local.
- Non-atomic JS references stay on their realm; borrowed events last one dispatch.
- Physics, navigation and audio owners outlive renderer rebuilds; GPU resources live through in-flight submissions.
- Destructors and noexcept paths report broken invariants through `bblite/teardown.hpp`, then terminate. Exceptions
  escaping an entry are reported through `bblite/uncaught_error.hpp`.
