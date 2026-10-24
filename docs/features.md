# Features

Admitted source surface and its limits. Anything else refuses at generation or throws at an explicit
runtime check. There is no JavaScript interpreter or dynamic module loader.

## Deferred capabilities

`--deferred-capabilities runtime-throw` (`CompileOptions.deferredCapabilities`) compiles registered missing APIs
as typed throwing/rejecting boundaries, listed in `manifest.deferredCapabilities`. Registered: Babylon microphone
sources, the unmute UI and the visualizer, `prompt`, and the [UI](ui.md) items
marked deferred. Unregistered APIs still refuse.

## Language

Throws retain Error identity and string values through catches, rethrows and promise reactions.
Other thrown values are unsupported.

| Area         | Admitted                                                                                                                                                              | Refuses                                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modules      | Named/namespace imports, re-exports, local TS/JS, `?raw`, `namespace` bodies, literal `import()`, ordered initialization                                              | Runtime-selected modules, top-level await, `var` in lazily imported modules, writes through `N.member`, namespace/enum objects as values, dependencies on the entry                                                                    |
| Control flow | All statements, labels, switch fallthrough, try/catch/finally (also suspending), function-scoped `var`, for-in/of into existing targets and assignment patterns       | Cleanup across `startEngine`; labeled jumps out of statically unrolled loops; a `var` read while it may be undefined and its type excludes undefined; a `var` redeclaring a parameter                                                  |
| Functions    | Generics, defaults, rest, destructuring, recursion, `call`/`apply`/`bind`, function objects with properties, extra arguments ignored                                  | Unresolved type arguments, stored generic `this`, Arguments mutation, narrowing a stored function's signature, unions with several function arms, extracted methods without receiver                                                   |
| Classes      | Fields, accessors, private names, generics, local inheritance (`super`, abstract, `instanceof`), Error subclasses, static fields/blocks, generator methods, `#x in v` | Non-local bases, static accessors, private names redeclared in subclasses, inherited static writes through a subclass, generic or mixed-type fields in a stored hierarchy                                                              |
| Closures     | Shared mutable cells, TDZ, recursive groups                                                                                                                           | Captures without owned representation; borrowed input events escaping dispatch                                                                                                                                                         |
| Data         | Records, tagged/structural unions, arrays, tuples, dictionaries, Map/Set, JSON documents, record accessors, `{}` identity tokens, phantom brands                      | Record conversions no single layout can hold; mutation through erased native views; identity comparison of unnamed literals                                                                                                            |
| Async        | Promises, async functions, `all`/`allSettled`/`race`/`any` over tuples and sync iterables                                                                             | Custom thenables, async iterables in combinators, MessageChannel, runtime-sized resource construction                                                                                                                                  |
| Generators   | Sync/async, `for...of`, `for await`, `yield*` over generators/iterators/arrays                                                                                        | `next(value)`, `throw`, return payloads, yield in finally, `yield*` from async generators                                                                                                                                              |
| Workers      | Module workers, structured clone and `structuredClone` (records incl. own accessors, Date, Map, Set, buffers, typed arrays, cycles), OffscreenCanvas transfer         | Classic scripts; clones of class instances, prototype accessors, Errors, promises, platform objects; functions in messages (`structuredClone` throws DataCloneError); `structuredClone` transfer lists; listener options except `once` |

Rules:

- Operands that touch the same state evaluate left to right; the compiler pins them into temporaries.
- RGB and vector tuple inputs accept conditional expressions; only the selected arm evaluates.
- Loose equality across types refuses. Telling `null` from `undefined` needs tagged storage; otherwise strict comparison refuses.
- Generation-known positions fold through `const` literals, settled conditionals, spreads, parameterless literal-returning
  functions, closed `const` function literals, direct literal-returning helpers with known readonly scalar arguments,
  module `const`s run at generation, and an inlined call's argument for a parameter its body never rebinds.
  A fold reaching the host, clock, `Math.random`
  or locale refuses; written constants require the
  initialization snapshot proof below.
- Scalar facts survive readonly return fields; string, number and boolean facts survive locals with no reachable writes.
  Local text retains known values across direct ordered assignments outside runtime control flow; readonly closures
  created after the last assignment can capture the final value. Loop writes and earlier captures remain runtime values.
  Nullable scalar helpers retain known branch results and their evaluated effects.
  A named record's number field folds while no write in the program can replace it. Forwarded option
  records project complete current fields from their native owner. Single-expression helpers returning
  fresh primitive records retain call-time field facts when the expression writes no storage. Primitive module constants
  can snapshot an earlier fresh scalar record in the same module across only pure initializers and inert declarations.
- Fresh literal option records, including nested literals, retain captured scalar facts across `await` when analysis rules
  out writes, parent replacement and untracked aliases.
  Shared native factories whose normal exits construct records and unreassigned constructed-object locals preserve known presence.
- Static composition can spread unchanged literal array fields of stored records and generation-selected fresh array branches.
  Their lengths remain known when whole-program mutation analysis rules out array writes; identity comparisons are allowed.
- `unknown[]` fields require finite source element layouts; object/class initializers and declaration-matched aliases contribute.
- Reached `Iterable<T>` parameters specialize to concrete collection storage, preserving iterator cursor identity.
- A module `let` assigned only by unreachable functions keeps its initializer. Strict comparisons fold through `const`
  aliases, absent `??` lefts and generation-known booleans.
- Literals handed to functions keep their facts unless a callee's write reaches a member they hold. Static descriptor
  lists re-read a local `const` initializer whose names no visible write reaches.
- A refusing local call whose arguments select by pure runtime tests compiles once per outcome (at most four tests) and
  merges the results into native storage.
- Recursive groups evaluate a caller-independent default once at the root; other defaults refuse. A function a call
  passes counts as a call the callee may make: directly, as a literal in a record or array, or as a named async
  function there.
- Sparse array growth, named array properties and a `const` alias of an array field used after it resizes refuse; a length
  write grows an array of non-nullable objects with default slots.
- Static expansion: 4,096 iterations / 1 MiB; composition tables: 65,536 records.
- `import.meta.env`: `MODE="production"`, `PROD=true`, `DEV=false`, `SSR=false`, `BASE_URL` from deployment; custom
  strings via `--env NAME=value` or `CompileOptions.environment`. No dotenv or host variables.
- Without a realm, timers and microtasks need no engine; RAF needs a Window repaint source.

## Standard library

| Area            | Admitted                                                                                                                                       | Refuses                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Numbers         | Math, Number predicates/coercions, `**`, BigInt (incl. `asIntN`/`asUintN`)                                                                     | BigInt mixed with Number, BigInt JSON/clone/`toLocaleString`                                                       |
| Arrays/tuples   | ES2023 methods incl. `toSorted`/`with`/`flat`/`flatMap`, typed `Array.from`                                                                    | Callback `thisArg`; callbacks removing unvisited elements (runtime)                                                |
| Map/Set/WeakMap | Full API, live cursors; WeakMap with record, callback or DOM keys                                                                              | `Set<object>` of Promises; other WeakMap key kinds                                                                 |
| Iterators       | Arrays, Map/Set cursors, class generator `[Symbol.iterator]`                                                                                   | Other `[Symbol.iterator]` implementations                                                                          |
| Strings         | UTF-16 API, URI encode/decode, `btoa`/`atob`, tagged templates, `String.raw`                                                                   | Method tags                                                                                                        |
| RegExp          | `g`/`i`/`u`, replacement callbacks, captured `split`; unmatched captures are `undefined`; literal non-`g` `test`/`exec` fold at generation     | `replaceAll` with string replacement; under `u`: lookbehind, named groups, `i` with backreferences/word boundaries |
| Unicode/Intl    | normalize, `localeCompare`, locale casing, Collator, NumberFormat (decimal/percent), PluralRules, ListFormat, Date `toLocale*String`           | DateTimeFormat options/formatting, `resolvedOptions`, `formatToParts`, currency/unit, `dateStyle`/`timeStyle`      |
| Encoding        | UTF-8 `TextDecoder` (`fatal`, `ignoreBOM`, `stream`), `TextEncoder.encode`                                                                     | Other encodings, `encodeInto`                                                                                      |
| Objects         | keys/values/entries/assign/fromEntries/hasOwn/is/`create(null)`, literal-descriptor `defineProperty`, spread, rest, `delete`, `in`, `for...in` | Class accessor installation, non-literal rest keys, dynamic class membership                                       |
| JSON            | parse (reviver), stringify                                                                                                                     | Replacers, cycles, Map/Set values                                                                                  |
| Date            | ISO parsing, getters, `setTime`, `Date.UTC`                                                                                                    | Field setters, legacy formats                                                                                      |
| URL             | `URL`, `URLSearchParams` (get/has/set), `AbortController`, `DOMException`                                                                      | IDNA hosts (TypeError), `append`/`delete`/`sort`, `AbortSignal.timeout`/`any`                                      |
| Binary          | ArrayBuffer, SharedArrayBuffer, Atomics, DataView, all typed arrays incl. BigInt64                                                             | `from` over buffers/numbers/strings, element writes through a union, `Atomics.wait`                                |
| Reflection      | Finite record Proxy get/set traps, `Reflect.get`, Symbols                                                                                      | Other traps, FinalizationRegistry                                                                                  |

- Numeric typed-array and numeric-view indexed `??` reads preserve missing-slot presence and lazy fallbacks.
- Typed-array iteration retains its buffer owner and yields numbers read when each element is visited.
- Array `slice` on parsed documents and native array views copies outer slots and preserves nested identities.

## Assets and I/O

- Reached URLs and base64 data become packaged assets. `--public-dir` maps deployment-relative assets,
  `--public-url` serves unmapped root-relative ones, `--site-url` sets the base (default `http://localhost/`);
  registry scenes use the pinned `lab/public`. Runtime asset URLs require a finite inferred local candidate set;
  unknown keys and percent-encoded bodies refuse. Inference follows closed local Map registries, member and `push`
  writes and array callback parameters.
- `fetch` (application realm): absolute HTTP(S), method, string headers, body, static cache mode, `signal`; streamed
  `body` reader. Known asset fetches use packaged responses. Request objects, teeing and Headers iteration refuse.
- Byte streams (application realm): response bodies and `blob.stream()` pipe through `CompressionStream` or
  `DecompressionStream` (gzip, deflate, deflate-raw; zlib linked only where constructed); `new Response(stream)` reads
  them. Pipe options, `pipeTo`, other transforms, writable sides, Response init and non-stream Response bodies refuse.
- `createImageBitmap(blob, options)`: static options through `pal::image_bitmap_options`; WebP via libwebp. Resize/crop
  refuse; orientation metadata is not applied.
- `setDracoBaseUrl`/`setKtx2DecoderUrl` must be generation-known and precede compressed loads. KTX1 selects a
  device-supported BC/ASTC candidate.
  `loadKtx2Texture2D` packages the pinned decoder's compressed mip chain for a known URL; each load selects its
  linear/sRGB format. Unsupported native formats refuse.
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
- Native loops own extent refresh; `resizeEngine` runs the pin's `resizeSurface` on an application realm's DOM canvas.
- `enableAsyncShaderPipelineCompilation` adds nothing: scene preparation compiles pipelines before the first frame.
- An application realm's DOM canvas backing store is sized only by the pin's `resizeSurface` (client box, device
  pixel ratio or a getter the program defines for it on the global object, `maxDevicePixelRatio` option or write) at
  `createEngine`, `resizeEngine` and each frame head, on every
  platform; windows keep native density and composite it scaled. Without a realm the window is the only surface: a
  static cap of 1 or more applies as below (desktop keeps devicePixelRatio 1); any other cap selects a realm.
- Device recovery rebuilds GPU resources from CPU owners; GPU-only storage buffers lose contents. Only the scene
  strategy recovers; a loss with sprite, text, effect or frame-graph contexts refuses with the pin's message.
- Recovery registers before `startEngine` in the entry, anywhere in an application realm.
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
  windows unsupported. Without a realm, a static `maxDevicePixelRatio` caps the render buffer.
- iOS: 16+, SDL UIKit. Landscape fullscreen at native density or, without a realm, `maxDevicePixelRatio=1`; other
  caps refuse. Device bundles are unsigned and unqualified; no signing or App Store flow.

## Loading

| Format            | Limits                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| glTF              | Contiguous FLOAT MAT4 inverse binds; contiguous animation accessors; fixed light capacity; raw bytes self-contained; orthographic cameras and distinct-image ORM refuse |
| `.babylon`        | Parented meshes/nodes, Standard materials, point lights, cameras; no `maxMeshes`                                                                                        |
| Closed collectors | No rest/default parameters, early break, instanced/splat producers                                                                                                      |

`enableGltfCameras` and `enableGltfCpuTangents` must precede loading. `updateTexture2DFromPixels` and
`queue.writeTexture` write `createTexture2DFromPixels` textures; other sources, fractional or out-of-bounds regions, and
texels a sprite atlas copied throw. Other runtime texture uploads and 3D textures are unsupported.

`loadGltf` with a runtime URL, in runtime control flow or repeated out of order profiles its documents: each composes
once and its containers announce their rows by path. A runtime URL skips documents missing a buffer or image.
`loadTexture2D` address modes may be runtime members of a string-literal union. A clone of a glTF root held as a
`SceneNode` (an async result field) checks at run time that it is an imported root for `createHierarchyInstancePool`.

`KHR_texture_basisu` images package from external URIs or embedded buffer views. Loaded albedo reads retain
the pinned extension's texture identities; material extensions run as the pin's own features. Separate-image ORM
composition and source albedo reads with `KHR_texture_transform` refuse.

## Meshes and hierarchy

- Data mesh creation and replacement accept numeric buffer views; retained CPU streams preserve their aliases.
- Position, normal, colour, tangent and UV attribute uploads accept runtime mesh loops; they update GPU buffers only.
- Reached builders, data factories, lines, CSG and thin instances with admitted options.
- `updateMeshGeometry`/`updateMeshGeometryCapacity`: owned, unshared, packed Float32/Uint32 geometry; imported geometry
  updates refuse. Device recovery re-uploads CPU arrays and drops GPU-only writes.
- Thin-instance pools with compute tasks or geometry-output tasks refuse. Device recovery fails explicitly when thin-instance GPU buffers remain owned; recovery registration is admitted.
- Mesh `parent` also accepts an `IWorldMatrixProvider` record, polled each frame; `mesh.skeleton`/`morphTargets`
  presence reads loader facts; `container.entities` is a node list (a runtime document checks its sole root).
- Meshes parent to meshes or transform nodes; transform nodes only to transform nodes. Scene writes to imported nodes load
  the pin's glTF node hierarchy; animated/morphed assets, punctual lights and cameras then refuse.
- Transform-node `worldMatrix` retains the pin's local/world buffer identity and lazy subtree invalidation,
  including reads through stored `SceneNode` handles.
- A mesh removed from its last scene or passed to `disposeMeshGpu` retires
  ([fidelity](fidelity.md#semantic-contract)); re-adding or cloning it refuses. `disposeMeshGpu` of a mesh a scene or
  live render task still lists refuses.

## Materials

- Light position/direction component assignments and `.set(...)` preserve the selected light.
  `_bumpLightVersion` is a callable property and invalidates shadow refresh gates.
- Clustered point/spot lights and containers can be stored in application records and arrays. Light scalar fields and
  retained position/diffuse/direction tuples are mutable; `markClusteredLightContainerDirty` publishes edits.
  Populate lights and scene meshes before attaching the container; capacity and point/spot layout stay fixed.
- Standard, PBR (clearcoat, sheen, iridescence, anisotropy, transmission), Grid, shader and node materials.
  PBR field writes accept a material narrowed by `isPbrMaterial`; `baseColorTexture` replacement takes a loaded, solid
  or stored file texture before scene registration.
  `createPbrMaterial()` accepts omitted options and uses the pinned texture/factor defaults.
- Rebuild/replacement after binding refuses; direct factor-array writes do not bump UBO versions, except Standard
  `diffuseColor` after `enableMaterialTracking` (re-read each frame).
- Shader materials: up to 16 vertex/fragment 2D/array sampler pairs, storage buffers, `get/setShaderUniform` by runtime name,
  `enableShaderUniformRangeUpdates`. Runtime resource replacements refresh shared GPU bindings;
  render-target colour and sampled depth textures rebind per draw. Template text and plugin `getCustomCode`
  functions run at generation with scalar or fresh literal-data arguments; reaching host/engine APIs, `this`, module
  `let`, clock or random refuses. Retained objects stay native.
  `depthBias`, `depthBiasSlopeScale` and `depthOnlyFragment` control pipeline depth behaviour. WGSL `@interpolate`
  and static `blend` overrides are supported (`add`; `zero`, `one`, `src-alpha`, `one-minus-src-alpha`, `dst`, `dst-alpha`).
  Conditional option spreads select up to 64 static variants; effectful predicates or conflicts with earlier evaluations refuse.
  Generation-selected nullish uniform, sampler, external-texture, storage-buffer and define declarations use the pinned
  empty defaults, including absent retained fields and getters.
  `createShaderNoColorMaterialView` shares source uniforms and resource bindings. Depth-only render tasks use each
  material's pipeline, including custom vertex transforms and `depthOnlyFragment` discards.
  `screenSize` uses the current pass dimensions. Static descriptor arrays may use closed ECMAScript calls and callbacks.
  Reads of `scene.view`, `scene.viewProjection` and `scene.vEyePosition` are supported. Fragment entry points may
  return no value; vertex entry points may return `@builtin(position) vec4<f32>` directly.
  Shader interface structs admit signed/unsigned 32-bit scalar and vector fields, including flat integer varyings.
  Instance inputs follow mesh buffers and `useThinInstanceColors`. Incompatible layouts refuse at generation;
  unknown material selections require a recorded shader/mesh association and validate the compiled lanes before drawing.
  Unused scene-local shader materials retain their IDs and resource slots without compiling stages; task overrides
  participate in mesh-layout discovery and retain their own texture bindings, including runtime replacements.
  `needAlphaBlending` reads the shader factory's flag; other material families yield `undefined`.
  Alpha-to-coverage only on shader materials. Storage uploads preserve typed-array, DataView and ArrayBufferView byte ranges.
  `_shadowCasterMaterial` reads preserve the optional caster handle; writes bind an alternate shader caster during
  unconditional setup before scene registration. PCF/CSM creates cached shader no-color views and follows caster
  override chains; shader ESM views are unsupported.
- External video textures come from a closed zero-parameter producer before engine start.
- Node materials: closed NME graphs; scalar inputs writable live; vector writes and topology changes refuse. Geometry MRTs
  need static packed FLOAT attributes.
- Material plugins: explicit enablement and constant priorities; priority mutation and dynamic shader signatures refuse.

## Animation and deformation

- glTF LINEAR/STEP/CUBICSPLINE, TRS, skins, morphs, material/light/visibility pointers, masks, weighted/additive mixing.
- Property tracks: numeric leaves, linear/step; easing callbacks refuse. Autonomous managers cannot share a program with
  a persistent application RAF loop.
- GPU skinning, storage morphs, VAT, thin instances. Direct morphs: one pre-start attachment per mesh.
- `computeDeformedPositionToRef`: morph then four-joint skinning of one retained CPU vertex, at the pin's float stores.
- `setVatTime` writes the VAT clock lane until the handle's next `play`/`update`. `setVatInstanceStorage` validates and
  stores the buffer the thin VAT pick reads.

## Sprites, picking, flow graphs, gizmos

- Sprite2D, billboards, atlases, Y-sort. Mixed transparent draws tied in depth/order or without a camera refuse.
  Capacities ≤ 4,294,967,295; buffers 32-bit sized.
- Picking: `createPickingRay` needs no GPU picker; detailed picks skip thin instances, billboards and splats.
  Filter/ignore predicates refuse. VAT meshes pick through their baked pose; a detailed VAT pick refuses. A stored or
  awaited result's `pickedMesh` becomes a Mesh of the entry's engine after a run-time check that it picked there.
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
listeners, `disconnect(destination[, output[, input]])`, equal-power `PannerNode` and the context `listener` (`"HRTF"`
refuses: no HRTF data is packaged). A buffer source loops its whole buffer only: a `loopStart`/`loopEnd` region inside
it, or a loop started with a duration, throws at `start`. Event payloads, context options, statechange and output
selection refuse or are absent; so does any other node, parameter or context property write.
`createAudioEngineAsync`, `setMasterVolume` and `getMasterVolume` run the pin's lowered engine (`volume`,
`parameterRampDuration`, an adopted `audioContext`); the resume options refuse (no click or statechange hook).

Media streams: `MediaStream`/`MediaStreamTrack` objects (track sets, `addTrack`/`removeTrack`, `clone`, `stop`,
`enabled`, `readyState`), `canvas.captureStream(fps)` (one live video track), `createMediaStreamDestination()` (a sink
rendering its input into its stream's audio track every quantum) and `createMediaStreamSource(stream)` (the first
audio track by id, from any context at the same sample rate; InvalidStateError without one).
`MediaRecorder.isTypeSupported` is false and `new MediaRecorder` throws NotSupportedError
([no encoders](fidelity.md#semantic-contract)).

An audio URL (a static sound or media element source) selects packaged audio; a runtime URL needs inferable candidates.

Static sounds (`createSoundAsync`, `playSound`, `stopSound`, `setSoundVolume`, `disposeSound`) run the pin's lowered
family in an application realm. Sources: an audio URL, an array literal of them, an `ArrayBuffer`, an `AudioBuffer` or a
sound buffer (`createSoundBufferAsync`, over the same sources). A looped sound started while its context is not running
throws (no statechange). Sound sources (`createSoundSourceAsync` with its options, `setSoundSourceVolume`,
`disposeSoundSource`) route a caller-built node through the same sub-graph, in any realm. Streaming sounds
(`createStreamingSoundAsync` and the streaming-sound functions) play a media element per instance: an audio URL, an
array literal of them (source children, tried in order) or an Audio element. Buses (`createAudioBusAsync`,
`setBusVolume`, `disposeAudioBus`, the `outBus` option) run the pin's mixer. `enableSpatial`, `setSpatialPosition` and
`setSpatialListenerPosition` add the pin's panner sub-node and listener; the `position`, orientation and attachment
options refuse. `enableStereo` and `setStereoPan` add its stereo panner sub-node, `enableAnalyzer` and the `get*Data`
readouts its analyser tap. Sub-node hosts are static sounds.
`createAudioEngineMediaStream` taps the engine's master output into a stream destination's stream.

Media elements (application realm): `new Audio(url)` with an audio URL, `play`/`pause`/`load`, `removeAttribute("src")`,
`loop`, `preload`, `currentTime` (seek), `duration`, `paused`, `ended`, and `timeupdate`/`ended`/`play`/`pause`/
`canplaythrough`/`error` listeners without payloads.
An unrouted element plays to the default output; `createMediaElementSource` routes it once (again:
InvalidStateError), moving its playback into the graph. Other members and attributes refuse.

## Shadows and navigation

- PCF spot/directional, ESM directional, CSM. Thin-instance contracts refuse.
- Shadow generators and caster lists can be prepared without scene scheduling; `registerSceneWithShadowSupport`
  activates shadow passes. Registered empty caster lists clear the shadow map.
- `enableCsmStaticCache` (awaited, before registration): static casters render into a cache texture, copied per layer
  into the map before dynamic casters draw; refit gate and per-frame cascade budget as pinned.
- Recast/Detour solo and obstacle tile-cache builds, crowds, obstacles. Tiled builds without obstacles and off-mesh
  connections in tile caches refuse.

## Frame graph and post-process

- Ordered targets/tasks, MRTs, blits, MSAA resolve; `addTaskAfter` only during initial setup; `removeMeshFromTask`.
- Render targets accept explicit pinned-default `depthCompare` and `depthClearValue`; other values refuse.
  Explicit `depthCompare` overrides ShaderMaterial depth state. `scene.surface` reads require a known primary-surface scene.
- `buildFrameGraphTask(getFrameGraph(scene), task)` records a render or effect render task added to a live scene, which
  refuses to execute until then; the private `FrameGraph._tasks` list refuses (its native indices differ), so a live task
  cannot be removed.
- Render and effect render task `dispose()` releases owned targets (not the swapchain's); executing a disposed task refuses.
  An effect task's `record`/`dispose` can be read, bound and replaced; the frame graph calls the replacements.
- `disposeRenderTargetTexture`: a later executed task or material using the target refuses; material plugin textures
  keep the image they bound. `disposeEffectWrapper`: a registered EffectRenderer drawing a wrapper with a uniform
  binding refuses.
- TAA: one scene, explicit Standard color tasks, engine-format color, depth24plus-stencil8, single-sample inputs.
- `enableRenderTaskTransmission` with `linear: false` on a single-sample, non-swapchain render task: the pass breaks
  before transmissive transparent draws (`copyCount`) to grab colour, and with `grabDepth` depth (set before recording);
  `grab.texture`/`depthTexture` read live for `setShaderTexture`. The linear arm and multisampled targets refuse.
- Contact shadows, one-bounce GI, EffectWrapper/EffectRenderer with bounded layouts; custom vertices refuse.
  Effect textures come from solid/pixel factories or render targets, with 2D float or depth layouts;
  scene frame graphs sample depth through `textureLoad`. Effect samplers use the `filtering` binding type.
- `setEffectTexture` takes solid, pixel or render-target textures by binding name or number, including cached pixel
  textures and live changes between these kinds. Pixel bindings preserve sampler/sRGB settings, replacement identities
  and live region writes. Render targets bind in frame-graph effect tasks only.
- Image processing: exposure, contrast, toneMapping, toneMappingEnabled.

## Text

Font parsing/shaping/packing at generation; live layout over the packaged repertoire. `updateTextData`
(reset/addRun/removeRun/replaceRun), `updateDefaultTextData`, `setFontWeightOffset` are live. Renderable text needs one
text-only default scene with a static FreeCamera or supported ArcRotate. User glyph storages refuse.
