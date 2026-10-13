# Features

Admitted source surface and its limits. Anything else refuses at generation or throws at an explicit
runtime check. There is no JavaScript interpreter or dynamic module loader.

## Deferred capabilities

`--deferred-capabilities runtime-throw` (`CompileOptions.deferredCapabilities`) compiles registered missing APIs
as typed throwing/rejecting boundaries, listed in `manifest.deferredCapabilities`. Registered: Babylon sound
buffers, buses, spatial/stereo/analyzer and master volume, media streams/recording/streamed audio, script elements,
`prompt`, application-realm device recovery, and the [UI](ui.md) items
marked deferred. Unregistered APIs still refuse.

## Language

| Area | Admitted | Refuses |
| --- | --- | --- |
| Modules | Named/namespace imports, re-exports, local TS/JS, `?raw`, `namespace` bodies, literal `import()`, ordered initialization | Runtime-selected modules, top-level await, `var`, writes through `N.member`, namespace/enum objects as values, dependencies on the entry |
| Control flow | All statements, labels, switch fallthrough, try/catch/finally (also suspending) | Cleanup across `startEngine`; labeled jumps out of statically unrolled loops |
| Functions | Generics, defaults, rest, destructuring, recursion, `call`/`apply`/`bind`, function objects with properties, extra arguments ignored | Unresolved type arguments, stored generic `this`, Arguments mutation, narrowing a stored function's signature, unions with several function arms, extracted methods without receiver |
| Classes | Fields, accessors, private names, generics, local inheritance (`super`, abstract, `instanceof`), Error subclasses, static fields/blocks, generator methods, `#x in v` | Non-local bases, static accessors, private names redeclared in subclasses, inherited static writes through a subclass, generic or mixed-type fields in a stored hierarchy |
| Closures | Shared mutable cells, TDZ, recursive groups | Captures without owned representation; borrowed input events escaping dispatch |
| Data | Records, tagged/structural unions, arrays, tuples, dictionaries, Map/Set, JSON documents, record accessors, `{}` identity tokens, phantom brands | Record conversions no single layout can hold; mutation through erased native views; identity comparison of unnamed literals |
| Async | Promises, async functions, `all`/`allSettled`/`race`/`any` over tuples and sync iterables | Custom thenables, async iterables in combinators, MessageChannel, runtime-sized resource construction |
| Generators | Sync/async, `for...of`, `for await`, `yield*` over generators/iterators/arrays | `next(value)`, `throw`, return payloads, yield in finally, `yield*` from async generators |
| Workers | Module workers, structured clone and `structuredClone` (records incl. own accessors, Date, Map, Set, buffers, typed arrays, cycles), OffscreenCanvas transfer | Classic scripts; clones of class instances, prototype accessors, Errors, promises, platform objects; functions in messages (`structuredClone` throws DataCloneError); `structuredClone` transfer lists; listener options except `once` |

Rules:

- Operands that touch the same state evaluate left to right; the compiler pins them into temporaries.
- Loose equality across types refuses. Telling `null` from `undefined` needs tagged storage; otherwise strict comparison refuses.
- Generation-known positions fold through `const` literals, settled conditionals, spreads and parameterless literal-returning
  functions. A fold reaching the host, clock, `Math.random`, locale or a written constant refuses.
- Sparse array growth, named array properties and a `const` alias of an array field used after it resizes refuse.
- Static expansion: 4,096 iterations / 1 MiB; composition tables: 65,536 records.
- `import.meta.env`: `MODE="production"`, `PROD=true`, `DEV=false`, `SSR=false`, `BASE_URL` from deployment; custom
  strings via `--env NAME=value` or `CompileOptions.environment`. No dotenv or host variables.
- Without a realm, timers and microtasks need no engine; RAF needs a Window repaint source.

## Standard library

| Area | Admitted | Refuses |
| --- | --- | --- |
| Numbers | Math, Number predicates/coercions, `**`, BigInt (incl. `asIntN`/`asUintN`) | BigInt mixed with Number, BigInt JSON/clone/`toLocaleString` |
| Arrays/tuples | ES2023 methods incl. `toSorted`/`with`/`flat`/`flatMap`, typed `Array.from` | Callback `thisArg`; callbacks removing unvisited elements (runtime) |
| Map/Set/WeakMap | Full API, live cursors; WeakMap with record, callback or DOM keys | `Set<object>` of Promises; other WeakMap key kinds |
| Iterators | Arrays, Map/Set cursors, class generator `[Symbol.iterator]` | Other `[Symbol.iterator]` implementations |
| Strings | UTF-16 API, URI encode/decode, `btoa`/`atob`, tagged templates, `String.raw` | Method tags |
| RegExp | `g`/`i`/`u`, replacement callbacks, captured `split`; unmatched captures are `undefined`; literal non-`g` `test`/`exec` fold at generation | `replaceAll` with string replacement; under `u`: lookbehind, named groups, `i` with backreferences/word boundaries |
| Unicode/Intl | normalize, `localeCompare`, locale casing, Collator, NumberFormat (decimal/percent), PluralRules, ListFormat, Date `toLocale*String` | DateTimeFormat options/formatting, `resolvedOptions`, `formatToParts`, currency/unit, `dateStyle`/`timeStyle` |
| Encoding | UTF-8 `TextDecoder` (`fatal`, `ignoreBOM`, `stream`), `TextEncoder.encode` | Other encodings, `encodeInto` |
| Objects | keys/values/entries/assign/fromEntries/hasOwn/is/`create(null)`, literal-descriptor `defineProperty`, spread, rest, `delete`, `in`, `for...in` | Class accessor installation, non-literal rest keys, dynamic class membership |
| JSON | parse (reviver), stringify | Replacers, cycles, Map/Set values |
| Date | ISO parsing, getters, `setTime`, `Date.UTC` | Field setters, legacy formats |
| URL | `URL`, `URLSearchParams` (get/has/set), `AbortController`, `DOMException` | IDNA hosts (TypeError), `append`/`delete`/`sort`, `AbortSignal.timeout`/`any` |
| Binary | ArrayBuffer, SharedArrayBuffer, Atomics, DataView, all typed arrays incl. BigInt64 | `from` over buffers/numbers/strings, element writes through a union, `Atomics.wait` |
| Reflection | Finite record Proxy get/set traps, `Reflect.get`, Symbols | Other traps, FinalizationRegistry |

## Assets and I/O

- Reached URLs and base64 data become packaged assets. `--public-dir` maps deployment-relative assets,
  `--public-url` serves unmapped root-relative ones, `--site-url` sets the base (default `http://localhost/`);
  registry scenes use the pinned `lab/public`. Dynamic URLs and percent-encoded bodies refuse.
- `fetch` (application realm): absolute HTTP(S), method, string headers, body, static cache mode, `signal`; streamed
  `body` reader. Known asset fetches use packaged responses. Request objects, teeing and Headers iteration refuse.
- Byte streams (application realm): response bodies and `blob.stream()` pipe through `CompressionStream` or
  `DecompressionStream` (gzip, deflate, deflate-raw; zlib linked only where constructed); `new Response(stream)` reads
  them. Pipe options, `pipeTo`, other transforms, writable sides, Response init and non-stream Response bodies refuse.
- `createImageBitmap(blob, options)`: static options through `pal::image_bitmap_options`; WebP via libwebp. Resize/crop
  refuse; orientation metadata is not applied.
- `setDracoBaseUrl`/`setKtx2DecoderUrl` must be generation-known and precede compressed loads. KTX1 selects a
  device-supported BC/ASTC candidate.
- `loadGaussianSplatStream` runs the lowered pinned streaming library on the WebGPU-subset device; options are the pin's
  numeric budgets and `signal`. `splatsData`/`updateData` admit equal-count replacement.
- Environments: HDR (pinned GGX prefilter), DDS, `.env`, baked BRDF LUT, static local probes, procedural sky. Live probe
  rebuilding refuses.
- Closed Chromium producers bake canvas pixels/atlases; CSG2 bakes unchanged identity-transform boxes/spheres.
- Node particles: frozen/baked sets, Sprite2D sheets, native pure-2D graphs, emitter providers. Mixed frozen/native sets,
  dynamic emission shapes and post-registration texture/blend changes refuse.

## Engine and frame loop

- One engine per entry setup. Rebinding an engine alias refuses.
- `msaaSamples`: 1 for numeric 1, else 4; other constants refuse.
- Native loops own extent refresh; `resizeEngine` only applies `maxDevicePixelRatio` writes.
- `enableAsyncShaderPipelineCompilation` adds nothing: scene preparation compiles pipelines before the first frame.
- `maxDevicePixelRatio` writes (application realm) size a DOM canvas backing store at `resizeEngine` and the next frame
  head; the window composites it scaled. The `createEngine` option keeps the platform rules below.
- Device recovery rebuilds GPU resources from CPU owners; GPU-only storage buffers lose contents. Only the scene
  strategy recovers; a loss with sprite, text, effect or frame-graph contexts refuses with the pin's message.
- GPU task timing refuses TAA, screen-space and pass-less copy tasks, and on SDL_GPU colour/post-process tasks in TAA builds.
- `setGpuTimingEnabled` times each frame's commands on the task-timing device (application realm).
- Compute: generation-known WGSL, f32/u32/i32 writers (no f16), uniform/storage buffers, textures and samplers. Six-layer
  storage views with cube sampling need Dawn or patched SDL D3D12/Vulkan/Metal.

## Cameras and input

- ArcRotate/Free cameras, orthographic projection, viewports and SDL controls are live; `attachControl` variants keep
  independent attachments.
- Window realms: keys reach camera controls after a primary press on the canvas gives it focus.
- Parented/geospatial cameras, high-precision matrices and floating origin refuse public matrix caches; later
  orthographic plane writes refuse.

## Platforms

Backends per platform: [backends](backends.md#backend-comparison). Commands: [Android](development.md#android),
[iOS](development.md#ios).

- Android: ARM64/x86_64 APKs, API 28+ (retained UI 29+), landscape immersive fullscreen, Back exits. Multiple native
  windows unsupported. `maxDevicePixelRatio` caps the render buffer.
- iOS: 16+, SDL UIKit. Landscape fullscreen at native density or `maxDevicePixelRatio=1`; other caps refuse. Device
  bundles are unsigned and unqualified; no signing or App Store flow.

## Loading

| Format | Limits |
| --- | --- |
| glTF | Contiguous FLOAT MAT4 inverse binds; contiguous animation accessors; fixed light capacity; raw bytes self-contained; orthographic cameras and distinct-image ORM refuse |
| `.babylon` | Parented meshes/nodes, Standard materials, point lights, cameras; no `maxMeshes` |
| Closed collectors | No rest/default parameters, early break, instanced/splat producers |

`enableGltfCameras` and `enableGltfCpuTangents` must precede loading. `updateTexture2DFromPixels` and
`queue.writeTexture` write `createTexture2DFromPixels` textures; other sources, fractional or out-of-bounds regions, and
texels a sprite atlas copied throw. Other runtime texture uploads and 3D textures are unsupported.

## Meshes and hierarchy

- Reached builders, data factories, lines, CSG and thin instances with admitted options.
- `updateMeshGeometry`/`updateMeshGeometryCapacity`: owned, unshared, packed Float32/Uint32 geometry; imported geometry
  updates refuse. Device recovery re-uploads CPU arrays and drops GPU-only writes.
- Thin-instance pools with compute tasks, geometry-output tasks or device recovery refuse.
- Meshes parent to meshes or transform nodes; transform nodes only to transform nodes. Scene writes to imported nodes load
  the pin's glTF node hierarchy; animated/morphed assets, punctual lights and cameras then refuse.
- A mesh removed from its last scene or passed to `disposeMeshGpu` retires
  ([fidelity](fidelity.md#semantic-contract)); re-adding or cloning it refuses. `disposeMeshGpu` of a mesh a scene or
  live render task still lists refuses.

## Materials

- Standard, PBR (clearcoat, sheen, iridescence, anisotropy, transmission), Grid, shader and node materials.
- Rebuild/replacement after binding refuses; direct factor-array writes do not bump UBO versions, except Standard
  `diffuseColor` after `enableMaterialTracking` (re-read each frame).
- Shader materials: 2D/array samplers, storage buffers, `get/setShaderUniform` by runtime name,
  `enableShaderUniformRangeUpdates`. Template text and plugin `getCustomCode` functions run at generation; reaching
  host/engine APIs, `this`, module `let`, clock or random refuses. Alpha-to-coverage only on shader materials.
- External video textures come from a closed zero-parameter producer before engine start.
- Node materials: closed NME graphs; scalar inputs writable live; vector writes and topology changes refuse. Geometry MRTs
  need static packed FLOAT attributes.
- Material plugins: explicit enablement; dynamic shader signatures refuse.

## Animation and deformation

- glTF LINEAR/STEP/CUBICSPLINE, TRS, skins, morphs, material/light/visibility pointers, masks, weighted/additive mixing.
- Property tracks: numeric leaves, linear/step; easing callbacks refuse. Autonomous managers cannot share a program with
  a persistent application RAF loop.
- GPU skinning, storage morphs, VAT, thin instances. Direct morphs: one pre-start attachment per mesh.
- `computeDeformedPositionToRef`: morph then four-joint skinning of one retained CPU vertex, at the pin's float stores.
- `setVatTime` writes the VAT clock lane until the handle's next `play`/`update`. `setVatInstanceStorage` validates and
  stores the buffer; only VAT picking reads it, and that is not lowered.

## Sprites, picking, flow graphs, gizmos

- Sprite2D, billboards, atlases, Y-sort. Mixed transparent draws tied in depth/order or without a camera refuse.
  Capacities ≤ 4,294,967,295; buffers 32-bit sized.
- Picking: `createPickingRay` needs no GPU picker; detailed picks skip thin instances, billboards and splats.
  Filter/ignore predicates refuse.
- KHR_interactivity blocks: SceneReadyEvent, OnSelect, Sequence, Get/SetVariable, Get/SetProperty, arithmetic, Abs,
  Floor, LessThan, Clamp, Combine/ExtractVector2. Others refuse.
- Gizmos: display, bounding boxes, rotation editing; no bounding-box/scale drags.

## Physics

Bullet: bodies, shapes, aggregates, masks, triggers, raycasts, floating origin, character control, thin-instance bodies.
Constraints: ball/socket, distance, hinge, prismatic, lock, slider, six-DOF with inline limits. Springs, motors,
inertia orientation, thin physics with floating origin and triangle children in containers refuse.
Heightfields need square ground grids. Contract: [physics](fidelity.md#physics-contract).

## Audio

LabSound/SDL3: no-options AudioContext, reached nodes, AudioParam scheduling (value curves included), decoding, ended
listeners, `disconnect(destination[, output[, input]])`. A buffer source loops its whole buffer only: a
`loopStart`/`loopEnd` region inside it, or a loop started with a duration, throws at `start`. Event payloads,
ended-listener `signal`, context options, statechange, output selection, media streams and recording refuse or are
absent. `createAudioEngineAsync` adopts `audioContext`; its other options refuse.

Static sounds (`createSoundAsync`, `playSound`, `stopSound`, `setSoundVolume`, `disposeSound`) run the pin's lowered
family in an application realm. Sources: a URL selecting packaged audio (a runtime URL needs inferable candidates), an
`ArrayBuffer` or an `AudioBuffer`; URL lists, sound buffers and `outBus` refuse. A looped sound started while its
context is not running throws (no statechange).

## Shadows and navigation

- PCF spot/directional, ESM directional, CSM. Thin-instance contracts refuse.
- Recast/Detour solo and obstacle tile-cache builds, crowds, obstacles. Tiled builds without obstacles and off-mesh
  connections in tile caches refuse.

## Frame graph and post-process

- Ordered targets/tasks, MRTs, blits, MSAA resolve; `addTaskAfter` only during initial setup; `removeMeshFromTask`.
- `buildFrameGraphTask(getFrameGraph(scene), task)` records a render or effect render task added to a live scene, which
  refuses to execute until then; the private `FrameGraph._tasks` list refuses (its native indices differ), so a live task
  cannot be removed.
- Render and effect render task `dispose()` releases owned targets (not the swapchain's); executing a disposed task refuses.
- `disposeRenderTargetTexture`: a later executed task or material using the target refuses; material plugin textures
  keep the image they bound. `disposeEffectWrapper`: a registered EffectRenderer drawing a wrapper with a uniform
  binding refuses.
- TAA: one scene, explicit Standard color tasks, engine-format color, depth24plus-stencil8, single-sample inputs.
- Contact shadows, one-bounce GI, EffectWrapper/EffectRenderer with bounded layouts; custom vertices refuse.
- Image processing: exposure, contrast, toneMapping, toneMappingEnabled.

## Text

Font parsing/shaping/packing at generation; live layout over the packaged repertoire. `updateTextData`
(reset/addRun/removeRun/replaceRun), `updateDefaultTextData`, `setFontWeightOffset` are live. Renderable text needs one
text-only default scene with a static FreeCamera or supported ArcRotate. User glyph storages refuse.
