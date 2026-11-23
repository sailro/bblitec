# Features

Admitted source surface and its limits. Anything else refuses at generation or throws at an explicit
runtime check. There is no JavaScript interpreter or dynamic module loader.

## Deferred capabilities

`--deferred-capabilities runtime-throw` (`CompileOptions.deferredCapabilities`) compiles registered missing APIs
as typed throwing/rejecting boundaries, listed in `manifest.deferredCapabilities`. Registered: Babylon microphone
sources, the unmute UI and the visualizer, `prompt`, and the [UI](ui.md) items
marked deferred. Unregistered APIs still refuse. Registry scenes opt in with `deferredCapabilities`.

## Language

Throws retain Error identity and string values through catches, rethrows and promise reactions.
Other thrown values are unsupported.

| Area         | Admitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Refuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modules      | Named/namespace imports, re-exports, local TS/JS, `?raw`, JSON files, `namespace` bodies, literal `import()`, ordered initialization                                                                                                                                                                                                                                                                                                                                                                                                                                        | Runtime-selected modules, top-level await in lazy modules, a read `var` in lazily imported modules, writes through `N.member`, namespace/enum objects as values, dependencies on the entry                                                                                                                                                                                                                                                                                                                                                                  |
| Control flow | All statements, labels, switch fallthrough, try/catch/finally (also suspending), function-scoped `var`, for-in/of into existing targets and assignment patterns                                                                                                                                                                                                                                                                                                                                                                                                             | Cleanup across `startEngine`; labeled jumps out of statically unrolled loops; a `var` read while it may be undefined and its type excludes undefined; a `var` redeclaring a parameter                                                                                                                                                                                                                                                                                                                                                                       |
| Functions    | Generics, defaults, rest, destructuring, recursion, `call`/`apply`/`bind`, function objects with properties, signature-selected function arms in data unions, extra arguments evaluated and ignored, console methods as values (output erased, as at a call)                                                                                                                                                                                                                                                                                                                | Unresolved type arguments, stored generic `this`, Arguments mutation, narrowing a stored function's signature, function unions without matching parameter/result storage, class method values (`c.m`, `c.m.bind(c)`), binding dynamic `this`                                                                                                                                                                                                                                                                                                                |
| Classes      | Fields, accessors, private names, generics, local inheritance (`super`, abstract, `instanceof`), Error subclasses, static fields/blocks, generator methods, `#x in v`                                                                                                                                                                                                                                                                                                                                                                                                       | Non-local bases, static accessors, private names redeclared in subclasses, inherited static writes through a subclass, generic or mixed-type fields in a stored hierarchy, an observable copy in a record type of two classes' instances, or of one and a record                                                                                                                                                                                                                                                                                            |
| Closures     | Shared mutable cells, TDZ, recursive groups                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Captures without owned representation; borrowed input events escaping dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Data         | Records, tagged/structural unions, arrays, tuples, dictionaries, Map/Set, JSON documents, record accessors, `{}` identity tokens, phantom brands                                                                                                                                                                                                                                                                                                                                                                                                                            | Record conversions no single layout can hold; mutation through erased native views; identity comparison of unnamed literals                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Async        | Promises, async functions, `all`/`allSettled`/`race`/`any` over tuples and sync iterables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Custom thenables, async iterables in combinators, runtime-sized resource construction                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Generators   | Sync/async, `for...of`, `for await`, `yield*` over generators/iterators/arrays                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `next(value)`, `throw`, return payloads, yield in finally, `yield*` from async generators                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Workers      | Module workers, structured clone and `structuredClone` (records incl. own accessors, Date, Map, Set, buffers, typed arrays, documents and `unknown` positions, cycles), OffscreenCanvas, MessagePort and ArrayBuffer transfer (detaching the buffer and its views); run-time `Transferable[]` lists; unions whose members clone to different kinds; MessageChannel ports across realms (`postMessage`, `onmessage`/`onmessageerror`, listeners, `start`, `close`); Worker `onmessage`/`onerror`/`onmessageerror`; `in` on a Worker or MessagePort (its interface's members) | Classic scripts; clones of class instances, prototype accessors, Errors, promises, platform objects; functions in messages (`structuredClone` throws DataCloneError); `structuredClone` transfer lists; an absent run-time transfer list; re-transferring a detached ArrayBuffer (sends it empty); reads of `onmessage`; listener options except `once`. `messageerror` never fires: a message decodes at its typed read. An ErrorEvent's `lineno`/`colno` read 0. A document received with a Map, Set, Date, ArrayBuffer or DataView throws DataCloneError |

Rules:

- Operands that touch the same state evaluate left to right; the compiler pins them into temporaries.
- RGB and vector tuple inputs accept conditional expressions; only the selected arm evaluates.
- Loose equality across types refuses. Telling `null` from `undefined` needs tagged storage; otherwise strict comparison refuses.
  An array keeps the tag per element, and a map built from `[key, record]` pairs reads the record lane checked.
  A conditional of an `undefined` arm and a `null` arm that no typed storage holds is a dynamic value.
- A binding TypeScript types `any` (`var observer = null`) is stored as the type assigned to it, nullable as its
  initializer; member calls through it, and through its properties (`c.signal`), dispatch on that stored type and
  throw when it is absent.
- A hoisted `var` a function may read before its assignment is stored undefined until assigned: absence tests,
  `typeof` and timer cancellation read the undefined, any other read throws while unassigned. A function its own
  initializer hands to a scheduler, an observer or a promise reaction (`var poll = setInterval(f)`) reads it assigned.
- A short circuit TypeScript types `any` holds the storage both operands lower to.
- A Babylon Lite call completes with `undefined` where its pinned body does, as a source function's must.
- An unread `await` (`await x;`, `void await x`, a comma's left) of a non-thenable takes its turn and drops the value.
- A stored class field that some constructions bind to one value and others leave absent keeps a presence slot.
  One that constructions bind to different instances of a local class stores that class.
- A class instance built before anything stored one replays with its class shared from that construction; a field
  holding a stored class is a slot. A record type (an interface, `Pick<C, K>`) storing one class's instances where the
  program can observe a copy is stored as those instances.
  A stored record method nothing can read is stored empty when its body refuses.
- Generation-known positions fold through `const` literals, settled conditionals, spreads, parameterless literal-returning
  functions, closed `const` function literals, direct literal-returning helpers with known readonly scalar arguments,
  module `const`s run at generation, and an inlined call's argument for a parameter its body never rebinds.
  Required text also reads a field of the record a module helper call returns, in place or through a local `const`
  nothing writes through whose call arguments read the same later.
  A fold reaching the host, clock, `Math.random`
  or locale refuses; written constants require the
  initialization snapshot proof below.
- Scalar facts survive readonly return fields, and the fields of a returned array's records that no write in the program
  replaces; string, number and boolean facts survive locals with no reachable writes.
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
- A field typed `unknown` that an assertion reads (through an access or a `const` destructuring) or a write fills with one
  native handle kind stores that handle, absent when a write stores none; a function typed to return `unknown` whose
  returns are one handle kind, `undefined` or such fields returns that handle.
- A record type reaching `unknown` members where several writes meet (a rebound binding, a function's result or
  parameter) stores those members as documents.
- A generic record instantiated at a type and stored as its `unknown` instantiation where a copy is observable shares
  one layout with it: records the one holds where the other holds a dynamic value (fields, function fields' parameters
  and results) are documents; a method one stores as a generic function's table is that table in both, a stored
  function filling each of its signatures.
- A record binding whose member is written by a run-time key or replaced takes native storage; its fields typed
  `Record<string, unknown>` are documents.
- A record type a parsed document is stored as is a document, with every record type the program reads out of it
  (members, array elements, dictionary values) and every record type whose values it hands where one of these is
  declared.
- A record type annotated on a dictionary (`const h: Partial<Record<K, T>> = Object.fromEntries(...)`) whose optional
  keys the program reads as own (`Object.keys`/`values`, `in`) is a document: absent keys and key order are the
  dictionary's.
- A record type holding an engine object (in a field, an array, a dictionary or a held record) has no document form: a
  document holds its values by reference, and a member read or stored as it is that record.
- A stored binding whose literal spells plain JSON that no layout holds (empty arrays, elements of mixed shapes: a
  JSON import of saved data) is a document.
- Reached `Iterable<T>` parameters specialize to concrete collection storage, preserving iterator cursor identity.
- Callable records retain optional properties when selected beside plain functions. Mixed tuple arrays read absent
  properties on plain functions as `undefined`; reading properties after erasure into bare function storage refuses.
- A module `let` assigned only by unreachable functions keeps its initializer. Strict comparisons fold through `const`
  aliases, absent `??` lefts and generation-known booleans.
- Literals handed to functions keep their facts unless a callee's write reaches a member they hold. Static descriptor
  lists re-read a local `const` initializer whose names no visible write reaches. A parameter that took its own object
  reads the lists its literal argument gave it until its function first writes, keeps or captures the object.
- A refusing local call whose arguments select by pure runtime tests, in the call or as boolean or optional members
  (two levels deep) of a record an argument names, compiles once per outcome and merges the results into native
  storage; a discarded call merges none. At most four tests split, of at most eight read; past either, the refusal
  names them. A shader material so merged resolves uniform, texture and storage-buffer names against its own variant
  at run time. An object argument that can only be one of a few module constants (through `??`, `?:` and members
  every store sets to one) splits per constant, tested on the first string members that differ; a split left with no
  run-time test compiles the call once.
- A `const` selecting between plain arms with no common native storage (`c ? { surface: engine, scale } : engine`) is
  evaluated at each read in its function: a render target size keeps each arm's sizing, and a local call handed it,
  directly or as a record member, compiles once per outcome of its condition. Read again or in a loop, it refuses where
  a read writes, compares, calls into or keeps its object.
- Recursive groups evaluate a caller-independent default once at the root; other defaults refuse. A function a call
  passes counts as a call the callee may make: directly, as a literal in a record or array, or as a named async
  function there.
- Sparse array growth, named array properties and a `const` alias of an array field used after it resizes refuse; a length
  write grows an array of non-nullable objects with default slots.
- An intersection of the pin's types of one engine object (`ShaderMaterial & MaterialView`) stores that object's handle.
  A list with no native element type (`any[]`) refuses a handle a callback creates and pushes.
- Static expansion: 4,096 iterations / 1 MiB; composition tables: 65,536 records. A setup `for` loop unrolled only
  because it reaches pinned calls, whose passes need no specialization, loop control or frame yield, runs natively past
  that allowance.
- `import.meta.env`: `MODE="production"`, `PROD=true`, `DEV=false`, `SSR=false`, `BASE_URL` from deployment; custom
  strings via `--env NAME=value` or `CompileOptions.environment`. No dotenv or host variables.
- Without a realm, timers and microtasks need no engine; RAF needs a Window repaint source.
- A lazily imported module's `let` without an initializer holds undefined. A binding of such a module that no
  evaluated module, effectful statement or kept declaration names, and whose initializer has no effect, is never
  evaluated (a bundler's tree shaking). A reflective read of a namespace (spread, `for...in`, `Object.*`,
  `JSON.stringify`, a run-time string key) keeps its module's bindings; one of an `any` value keeps every module's.
- A module namespace in a record slot calls its exports after a presence check; `(await import(x)).f()` calls the
  settled namespace's.
- `for...in` over a number-keyed dictionary yields names in property order; reading it by such a name finds the
  number the name spells. A parsed document's binding takes `++`/`--` as its number.
- A write to a represented Error's property that no reached source reads back evaluates its value and stores nothing.
- A tuple parameter the function writes through (`out[0] = x`, or a callee that does) is its argument's storage.

## Standard library

| Area            | Admitted                                                                                                                                       | Refuses                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Numbers         | Math, Number predicates/coercions, `**`, BigInt (incl. `asIntN`/`asUintN`)                                                                     | BigInt mixed with Number, BigInt JSON/clone/`toLocaleString`                                                       |
| Arrays/tuples   | ES2023 methods incl. `toSorted`/`with`/`flat`/`flatMap`, typed `Array.from`                                                                    | Callback `thisArg`; callbacks removing unvisited elements (runtime)                                                |
| Map/Set/WeakMap | Full API, live cursors, copies of `scene.meshes`; WeakMap with record, callback, mesh or DOM keys                                              | `Set<object>` of Promises; other WeakMap key kinds                                                                 |
| Iterators       | Arrays, Map/Set cursors, class generator `[Symbol.iterator]`                                                                                   | Other `[Symbol.iterator]` implementations                                                                          |
| Strings         | UTF-16 API, URI encode/decode, `btoa`/`atob`, tagged templates, `String.raw`                                                                   | Method tags                                                                                                        |
| RegExp          | `g`/`i`/`u`, replacement callbacks, captured `split`; unmatched captures are `undefined`; literal non-`g` `test`/`exec` fold at generation     | `replaceAll` with string replacement; under `u`: lookbehind, named groups, `i` with backreferences/word boundaries |
| Unicode/Intl    | normalize, `localeCompare`, locale casing, Collator, NumberFormat (decimal/percent), PluralRules, ListFormat, Date `toLocale*String`           | DateTimeFormat options/formatting, `resolvedOptions`, `formatToParts`, currency/unit, `dateStyle`/`timeStyle`      |
| Encoding        | UTF-8 `TextDecoder` (`fatal`, `ignoreBOM`, `stream`), `TextEncoder.encode`                                                                     | Other encodings, `encodeInto`                                                                                      |
| Objects         | keys/values/entries/assign/fromEntries/hasOwn/is/`create(null)`, literal-descriptor `defineProperty`, spread, rest, `delete`, `in`, `for...in` | Class accessor installation, non-literal rest keys, dynamic class membership                                       |
| JSON            | parse (reviver), stringify                                                                                                                     | Replacers, cycles, Map/Set values                                                                                  |
| Date            | ISO parsing, getters, `setTime`, `Date.UTC`, UTC and local field setters, `new Date(y, m, ...)`                                                | Legacy formats                                                                                                     |
| Functions       | `call`, `apply`, `Reflect.apply` (listed or array-literal arguments), `bind` with a receiver and bound arguments, tuple rest parameters        | `bind` of `unknown`/generic signatures, stored optional tuple rests, library prototype methods on other receivers  |
| URL             | `URL`, `URLSearchParams` (string or record initializer; get/has/set/delete), `AbortController`, `DOMException`                                 | IDNA hosts (TypeError), `append`/`sort`, `AbortSignal.timeout`/`any`                                               |
| Binary          | ArrayBuffer, SharedArrayBuffer, Atomics, DataView, all typed arrays incl. BigInt64, `crypto.getRandomValues` (integer arrays)                  | `from` over buffers/numbers/strings, element writes through a union, `Atomics.wait`                                |
| Reflection      | Finite record Proxy get/set traps, `Reflect.get`, Symbols                                                                                      | Other traps, FinalizationRegistry                                                                                  |

- Numeric typed-array and numeric-view indexed `??` reads preserve missing-slot presence and lazy fallbacks.
- Typed-array iteration retains its buffer owner and yields numbers read when each element is visited.
- Array `slice` on parsed documents and native array views copies outer slots and preserves nested identities.
- `Object.getPrototypeOf` answers for records, dictionaries, arrays, strings, numbers, booleans and documents (by
  run-time kind; TypeError on null/undefined), compared with `Object`/`Array`/`String`/`Number`/`Boolean.prototype` or
  `null`; a class instance compares with `C.prototype` only. It refuses in a program that calls `Object.create`,
  `setPrototypeOf` or names `__proto__`.

## Assets and I/O

- Reached URLs and base64 data become packaged assets. `--public-dir` maps deployment-relative assets,
  `--public-url` serves unmapped root-relative ones, `--site-url` sets the base (default `http://localhost/`);
  registry scenes use the pinned `lab/public`. Runtime asset URLs require a finite inferred candidate set: local
  files, or absolute HTTP(S) URLs packaged as their literals are; unknown keys and percent-encoded bodies refuse.
  Inference follows closed local Map registries (`set` calls or constructor entries), member and `push` writes, array
  callback parameters, awaited values, `Promise.all`, the methods of a record a call built and a dynamic import's
  exports. The JSON of a packaged response reads as the document the package holds; a call handed that document
  (a merge over defaults) is run at generation for the strings its result holds. A document member of a number or
  boolean type that every run reads alike (the defaults a failing load returns included) reads as that constant,
  where every source holds a value of that kind and no write in the program replaces a member on the way once its
  record is built.
- `fetch` (application realm): absolute HTTP(S), method, string headers, body, static cache mode, `keepalive`, `signal`; streamed
  `body` reader. Known asset fetches use packaged responses. A `typeof fetch` wrapper forwards its runtime `RequestInit`
  (signal, headers). Request objects, teeing and Headers iteration refuse.
- Byte streams (application realm): response bodies and `blob.stream()` pipe through `CompressionStream` or
  `DecompressionStream` (gzip, deflate, deflate-raw; zlib linked only where constructed); `new ReadableStream({ pull,
cancel })` is a program source; `new Response(stream, { status, statusText, headers })` reads them. Pipe options,
  `pipeTo`, other transforms, writable sides, start/strategy sources and non-stream Response bodies refuse.
- Web Storage: getItem/setItem/removeItem. `localStorage` lives in the host preference directory; `sessionStorage` in
  process memory (kept across realm recreation, never on disk, no quota) and is absent in worker realms.
- IndexedDB (application realm): `open` with `upgradeneeded`, `createObjectStore(name)`, readonly/readwrite
  transactions, get/put(value, key)/delete, `openCursor()`/`continue()`, `objectStoreNames`, `close`, request and
  transaction `on*` handlers (no event argument). One SQLite file per database beside `localStorage`; values read back
  as dynamic values (records, arrays, primitives, Blobs); keys are numbers and strings. Key paths, generators, indexes,
  key ranges, cursor directions, `versionchange`/`blocked` events and event listeners refuse.
- `createImageBitmap(blob, options)`: static options through `pal::image_bitmap_options`; WebP via libwebp. Resize/crop
  refuse; orientation metadata is not applied.
- `createImageBitmap(new ImageData(rgba, w, h)[, sx, sy, sw, sh][, options])` (application realm): the crop over
  transparent black, resized (`pixelated` nearest, other qualities bilinear) and `flipY`-flipped from the bytes at the
  call; it resolves in a later task.
- `OffscreenCanvas.getContext("2d")`, null under a WebGPU context: `drawImage` of an ImageBitmap only. `convertToBlob`
  (`type`, `quality`) encodes its pixels on the native workers as `toDataURL` does ([UI](ui.md#canvas2d)). Other
  members and context attributes refuse.
- `setDracoBaseUrl`/`setKtx2DecoderUrl` must be generation-known and precede compressed loads; their arguments may
  be the spread tuple of a closed call, which runs at generation. KTX1 selects a
  device-supported BC/ASTC candidate.
  `loadKtx2Texture2D` packages the pinned decoder's compressed mip chain for a known URL; each load selects its
  linear/sRGB format. Unsupported native formats refuse.
  An object URL (`URL.createObjectURL(blob)`) as the URL: `loadTexture2D` decodes the URL's bytes; `loadKtx2Texture2D`
  selects, by the bytes' content, the chain packaged from the same KTX2 image in a file the program fetches as bytes
  (the whole file or a member of a zip archive), and rejects other bytes. A realm settles both as promises.
- `loadGaussianSplatStream` runs the lowered pinned streaming library on the WebGPU-subset device; options are the pin's
  numeric budgets and `signal`. `enableGaussianPointSplatting` and `disableGaussianPointSplatting` use the pinned
  point renderer for streams. `splatsData`/`updateData` admit equal-count replacement.
- MeshLoD (`loadMeshLoD`, instances, scene, setters, diagnostics) runs the lowered pinned library on the WebGPU-subset
  device: packaged `.mlod` sources (or absolute HTTP(S) URLs) read by range, meshopt pages, GPU selection, the pin's PBR
  over `PbrMaterialProps`.
  Options include `request.fetch` (`typeof fetch`). In-memory sources refuse.
- Environments: HDR (pinned GGX prefilter), DDS, `.env`, baked BRDF LUT, static local probes, procedural sky. Live probe
  rebuilding refuses.
- Closed Chromium producers bake canvas pixels/atlases; CSG2 bakes unchanged identity-transform boxes/spheres.
- Node particles: frozen/baked sets, Sprite2D sheets, native pure-2D graphs, emitter providers. Mixed frozen/native sets,
  dynamic emission shapes and post-registration texture/blend changes refuse.

## Engine and frame loop

- One engine per entry setup. Rebinding an engine alias refuses.
- `createSurface` takes a retained canvas, or an element whose tag only run time knows (a Window document's lookup):
  that selects the Window realm, which throws unless the element is a canvas.
- `msaaSamples`: 1 for numeric 1, else 4; other constants refuse.
- Native loops own extent refresh; `resizeEngine` runs the pin's `resizeSurface` on an application realm's DOM canvas.
- `enableAsyncShaderPipelineCompilation` adds nothing: scene preparation compiles pipelines before the first frame.
- `enableShaderMaterialPipelineSharing` and `enableKtx2WorkerDecoding` add nothing: frames and uploads are unchanged.
- `prepareShaderMaterialPipelineForTask` resolves for a render task's ShaderMaterial and rejects for another task or
  material; native pipelines are built when a draw first binds them.
- An application realm's DOM canvas backing store is sized only by the pin's `resizeSurface` (client box, device
  pixel ratio or a getter the program defines for it on the global object, `maxDevicePixelRatio` option or write) at
  `createEngine`, `resizeEngine` and each frame head, on every
  platform; windows keep native density and composite it scaled. Without a realm the window is the only surface: a
  static cap of 1 or more applies as below (desktop keeps devicePixelRatio 1); any other cap selects a realm.
- A Window realm's global: `Object.defineProperty` getters redefine its host accessor `devicePixelRatio`; a `fetch`
  replacement is erased loading instrumentation. Writing or defining another host property refuses.
- A global-object member only the program's types declare is the Window realm's state where program code may write it
  (outside a branch the generation-time browser state rules out); otherwise no host page installs it and it reads absent.
  A write may reach the global object through it, a value of a type it is declared or given as, or a variable it is
  given to; through an open type (`unknown`, `object`, an index signature) only once such a value is given as one.
  Deletions write nothing.
- Device recovery rebuilds GPU resources from CPU owners; GPU-only storage buffers lose contents. Only the scene
  strategy recovers; a loss with sprite, text, effect or frame-graph contexts refuses with the pin's message.
- Recovery registers before `startEngine` in the entry, anywhere in an application realm.
- `startEngine` inside a block (a catch clause, a branch, the entry promise's rejection handler) selects a realm.
- `engine._renderFn` (the pin's frame function) can be wrapped; a wrapper that never calls it ends the native run.
- After `stopEngine` no frame renders: the canvas keeps its last image, which a pending capture reads.
- GPU task timing refuses TAA, screen-space and pass-less copy tasks, and on SDL_GPU colour/post-process tasks in frames
  holding a TAA task.
- `setGpuTimingEnabled` times each frame's commands on the task-timing device (application realm).
- `captureScreenshot(engine)` (application realm, scene renderer): the next frame copies its presented image before
  native UI, and every request it serves resolves with one opaque RGBA8 `Screenshot`. An auxiliary surface refuses.
- Compute: generation-known WGSL, f32/u32/i32 writers (no f16), uniform/storage buffers, textures and samplers. Six-layer
  storage views with cube sampling need Dawn or patched SDL D3D12/Vulkan/Metal.
- Right-handed programs (`babylon-lite-rh`) build the pin's right-handed variant: lowered sources read its folded
  bodies, including each family's pipeline front face.

## Cameras and input

- ArcRotate/Free cameras, orthographic projection, viewports and SDL controls are live; `attachControl` variants keep
  independent attachments.
- ArcRotate limits read back as `setCameraLimits` wrote them, `undefined` until set.
- `shouldHandlePointerDown` takes the press's PointerEvent (mouse or touch), as the DOM path spells one.
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
texels a sprite atlas copied throw. Other runtime texture uploads are unsupported.

`loadGltf(engine, await response.arrayBuffer())` loads the one packaged file the fetch serves (GLB or `data:` URIs), in
an application realm too; bytes held in a binding refuse. `decodeAudioData` of such a read links that file's decoder
alone.

A function returning `loadGltf(engine, new Blob(...))` over closed data (typed arrays, `JSON.stringify`, `btoa`), its
engine read nowhere else, runs at generation; its call loads the document it built, packaged.

`loadGltf` with a runtime URL, in runtime control flow or repeated out of order profiles its documents: each composes
once and its containers announce their rows by path. A runtime URL skips documents missing a buffer or image.
`loadTexture2D` address modes may be runtime members of a string-literal union. `getOrCreateSampler` keys samplers
as the pool does (no comparison, LOD floor or W mode); a render target texture's `sampler` write binds in shader
materials. A clone of a glTF root held as a `SceneNode` (an async result field) checks at run time that it is an
imported root for `createHierarchyInstancePool`.

`KHR_texture_basisu` images package from external URIs or embedded buffer views. Loaded albedo reads retain
the pinned extension's texture identities; material extensions run as the pin's own features. Separate-image ORM
composition and source albedo reads with `KHR_texture_transform` refuse.

## Meshes and hierarchy

- Data mesh creation and replacement accept numeric buffer views; retained CPU streams preserve their aliases.
- Position, normal, colour, tangent and UV attribute uploads accept runtime mesh loops; they update GPU buffers only.
- Reached builders, data factories, lines, CSG and thin instances with admitted options. `createLines` and
  `createLineSystem` take static or run-time `Vec3` points (colours need static rows) and construct at run time.
- `updateMeshGeometry`/`updateMeshGeometryCapacity`: owned, unshared, packed Float32/Uint32 geometry; imported geometry
  updates refuse. Device recovery re-uploads CPU arrays and drops GPU-only writes.
- Thin-instance pools with compute tasks or geometry-output tasks refuse. Device recovery fails explicitly when thin-instance GPU buffers remain owned; recovery registration is admitted.
- Mesh `parent` also accepts an `IWorldMatrixProvider` record, polled each frame; `mesh.skeleton`/`morphTargets`
  presence reads loader facts; `container.entities` is a node list (a runtime document checks its sole root).
- Meshes parent to meshes or transform nodes; transform nodes only to transform nodes. Scene writes to imported nodes load
  the pin's glTF node hierarchy; animated/morphed assets, punctual lights and cameras then refuse.
- Transform-node `worldMatrix` retains the pin's local/world buffer identity and lazy subtree invalidation,
  including reads through stored `SceneNode` handles.
- `setMeshOpacity`/`getMeshOpacity` on Standard and PBR meshes: below 1 the mesh draws in the transparent pass under
  the pin's per-binding alpha policy; at 0 its colour draws skip and its shadows still cast. A crossing of 1 rebuilds
  the render plan; an explicit task keeps the binding it resolved unless `enableRenderTaskMeshRefresh` follows the
  mesh (no override). Node/shader materials below 1 throw the pin's errors; a MeshLoD or other target refuses.
- A mesh removed from its last scene or passed to `disposeMeshGpu` retires
  ([fidelity](fidelity.md#semantic-contract)); re-adding or cloning it refuses. `disposeMeshGpu` of a mesh a scene or
  live render task still lists refuses.

## Materials

- Light position/direction component assignments and `.set(...)` preserve the selected light.
  `_bumpLightVersion` is a callable property and invalidates shadow refresh gates.
- Clustered point/spot lights and containers can be stored in application records and arrays. Light scalar fields and
  retained position/diffuse/direction tuples are mutable; `markClusteredLightContainerDirty` publishes edits.
  Populate lights and scene meshes before attaching the container; capacity and point/spot layout stay fixed.
- Rectangular area lights (`createRectAreaLight`, `enableRectAreaLights`) with solid emission light PBR and Standard
  receivers; Standard `roughness` feeds the LTC lookup. An unprocessed `emissionTexture`, area shadows, Node lighting
  in an area scene, and a layered PBR BRDF under a reaching area light refuse at run time with the pin's messages.
- Textured area emission: `processAreaLightTexture` over a `loadTexture2D` texture with generation-known source and
  options runs the pin's processing at generation. Each scene draws under its own area lighting (none, solid or
  textured), and its emission snapshot follows image and light changes.
- A light's `parent` may be a mesh, transform node or imported root, a mesh's `parent` may be a light, and
  `light.rotationQuaternion.set` composes with its transform.
- Standard, PBR (clearcoat, sheen, iridescence, anisotropy, transmission), Grid, shader and node materials.
  PBR field writes accept a material narrowed by `isPbrMaterial`; `baseColorTexture` replacement takes a loaded, solid
  or stored file texture before scene registration, or after `startEngine` (and in callbacks), where it binds at the
  next `rebuildMaterial`; so does `normalTexture` on a material created with one.
  Parallax occlusion (`setPbrParallaxOcclusion`, `setStandardParallaxOcclusion`): the pin's validation and uniform
  writer over an RGBA8 loaded or pixels height texture (other sources throw); props and textures set later take effect
  at `rebuildMaterial` (PBR scalars also at `markMaterialUboDirty`). `setStandardBumpTexture` takes any stored texture
  or null.
  Bent normals: `enableBentNormals()` is an unconditional call before scene registration; `bentNormalTexture` writes
  on loaded or created PBR materials precede registration and refuse without it.
  `createPbrMaterial()` accepts omitted options and uses the pinned texture/factor defaults; `baseColorTexture` may
  be a pixels texture. `setPbrAlphaCutoff` takes a static cutoff on a created material before registration and refuses
  on an `alphaBlend` one.
- `rebuildMaterial` of a registered scene rebuilds, at the next frame, every mesh row drawing the material (its views
  unless `rebuildViews: false`); its completion is a promise where a PBR mesh rebuilds. `rebuildFrameGraph` outside
  setup refuses. Other replacement after binding refuses; direct factor-array writes do not bump UBO versions, except
  Standard `diffuseColor` after `enableMaterialTracking` (re-read each frame).
- Shader materials: up to 16 vertex/fragment 2D/array sampler pairs, storage buffers, `get/setShaderUniform` by runtime name,
  `enableShaderUniformRangeUpdates`. Runtime resource replacements refresh shared GPU bindings;
  render-target colour and sampled depth textures rebind per draw. Template text and plugin `getCustomCode`
  functions run at generation with scalar or fresh literal-data arguments; reaching host/engine APIs, `this`, module
  `let`, clock or random refuses. Retained objects stay native. A stage text builder's own `toFixed(n >= 1)` or
  `toExponential` call on a run-time number of a number, tuple or record argument reads a material uniform holding
  the number its text denotes, where WGSL reads an f32 value in a function body or as a module-scope
  `const NAME: f32 = <number>;`; other positions, other reads of such a number and integer spellings refuse. A stage
  that is a function literal's call reads its known formatted numbers from uniforms too when its whole text lifts.
  `attributes` and `samplers` lists may be a local list built by pushes generation settles, or a closed call (a module
  list mapped to names) run at generation. A list may
  spread a call to a local function that only returns an array literal: run-time arguments are read once and its
  entries' run-time defaults read the callee's parameters.
  `depthBias`, `depthBiasSlopeScale` and `depthOnlyFragment` control pipeline depth behaviour. WGSL `@interpolate`
  and static `blend` overrides are supported (`add`; `zero`, `one`, `src-alpha`, `one-minus-src-alpha`, `dst`, `dst-alpha`).
  Conditional option spreads select up to 64 static variants; effectful predicates or conflicts with earlier evaluations refuse.
  Options spreading `recipe.options`, where `recipe` is a `const` read of a `const` material-keyed `Map`/`WeakMap`
  every store of which holds the options its key was created from (same binding, never reassigned), compile once
  per stored source variant; the material takes the variant derived from its source's at run time, a loop's element
  key included. A store compiled
  after the derivation, a record the program may write, options lifting run-time numbers, transmissive options or
  options whose evaluation has effects refuse. Such options and a view's redefinitions are evaluated at generation:
  a `throw` they may reach and a `toFixed`, `toPrecision` or `toExponential` call are no effect, and one that throws
  there refuses.
  Generation-selected nullish uniform, sampler, external-texture, storage-buffer and define declarations use the pinned
  empty defaults, including absent retained fields and getters.
  `uniformDecls`, `samplerDecls` and `storageBufferDecls` of a run-time material take `.some(arrow)` and `for...of`
  whose entry is read only through `name`; its `attributes` take `.includes(name)`, `.some(arrow)` and `for...of`
  over the names. Other reads of `vertexSource`, `fragmentSource` and the three lists are the plain data the pinned
  `createShaderMaterial` builds from the options of the material's generation-known variants, when every variant
  agrees; otherwise they refuse. A uniform `defaultValue` the run time decides, a number or a fresh array of numbers,
  reads the numbers the material's creation was given. A shared array the program may write passes on with its
  declarations (bound, spread, returned, given to a program function, defined on a view); its `typeof`, truthiness and
  presence fold, and any other read refuses there, a `createShaderMaterial` given it included.
  `_uniformValues`, `_textureSlots` and `_storageBufferSlots` of a generation-known variant are read through `get`,
  `has`, `size`, iteration or a `new Map` copy, as Maps from names to records of `decl` and `value` (`Float32Array`)
  or `current` (`Texture2D | null`, `StorageBuffer | null`); other reads and other record shapes refuse.
  A local function call that refuses with a ShaderMaterial argument of run-time variant compiles once per variant
  the program's `createShaderMaterial` calls create, later ones included, and takes at run time the arm its
  argument's variant selects through a generated table; a variant outside the table throws. Compiled before any
  creation, it takes the arms of the later ones; where the program creates none, it refuses.
  A module-private `const Map`/`WeakMap` keyed by ShaderMaterial can supply generation-known entries per variant.
  Every reference must call `get`, `has` or `set`; each material has one store at its creation site before escaping,
  directly or through a helper whose calls are all direct. Registration conditions and stored data must be known
  for the variant, with no later writes or observed identity of the stored data. Variants without a store read
  `undefined`; different entries for creations of one variant, escaping maps, late or repeated stores and deletion refuse.
  A typed uniform declaration of a system matrix (`mat4x4<f32>`, no default) is that system uniform.
  `createShaderNoColorMaterialView` shares source uniforms and resource bindings; it and `createStandardNoColorMaterialView`
  may run in a loop of run-time passes. `createMaterialView(source, { features: 0 })` over a ShaderMaterial shares
  them too, each slot by name, and its draws follow its source's writes. Uniform, texture and storage-buffer setters
  on a view write the slot of that name and move the view's own versions, which its draws also follow;
  `setShaderExternalTexture` binds the source's slot, and `enableShaderUniformRangeUpdates` over a view refuses.
  On such a view, effect-free `Object.defineProperty`/`defineProperties` data descriptors after its `const`
  declaration, in its block or that block's `if` branches and before any other use of the view on their path, redefine
  its sources, `attributes`, declaration lists and pipeline state; the view draws a program compiled per source variant and
  branch, selected at run time. Synchronous helpers without explicit returns may make these definitions through one
  unreassigned parameter used only for definitions. To rule out intervening uses, the compiler follows fixed positional
  arguments through helpers called only directly. Subsequent caller definitions see the resulting programs.
  A `defineProperties` map may open with a spread of `test ? { descriptors } : {}` (either arm empty): both definition
  sets compile, and the one the test selects applies at run time; other spreads refuse.
  Native revision descriptors (`_uniformVersion`, `_resourceVersion`, `_uboVersion`) follow their source's revision in
  one of two factory shapes. Additive: a private zero-initialized offset that the getter adds to the source revision
  (or `Math.max` of the source's UBO and uniform revisions) and the setter sets to its value minus that revision.
  Counting: private last-read numbers per reader (the source revision, optionally the source's uniform revision for
  `_uboVersion` or a constant), the last assignment and a count; the getter counts a read unlike the last, the setter
  an assignment unlike the last. The program's own reads and writes of these properties refuse. These descriptors
  and pre-use cache resets emit nothing: `_shaderDevice`/`_shaderBindings`
  require `undefined`, `_shaderCustomUbo`/`_shaderCustomSpec`/`_shaderCustomData` require `null`, and
  `_shaderCustomVersion` requires `-1`. Other revision descriptors and cache-reset values refuse.
  A source of run-time variant may be any variant the program creates, as such a call's
  argument may. A view's program takes no uniform defaults; a run-time default a redefinition gives refuses where the
  view's field reads it. A definition giving the view such maps makes them its slots: a record read from its source
  aliases that slot, any other is the view's own, and a declared uniform the map lacks packs as zero. Redefinitions
  declaring other uniforms, samplers or storage buffers than the source without the maps holding them, other fields,
  other run-time values, or a source of a variant the program never creates refuse; a run-time value read from an entry
  of a ShaderMaterial-keyed map refuses naming that `get`. So do a given map lacking a
  declared sampler or storage buffer and a record read from another material, at run time.
  Depth-only render tasks use each
  material's pipeline, including custom vertex transforms and `depthOnlyFragment` discards.
  `releaseMaterialViewGpu` drops a shader view's own packed custom uniforms; a later draw repacks them.
  `screenSize` uses the current pass dimensions. Static descriptor arrays may use closed ECMAScript calls and callbacks.
  Reads of `scene.view`, `scene.viewProjection` and `scene.vEyePosition` are supported. Fragment entry points may
  return no value; vertex entry points may return `@builtin(position) vec4<f32>` directly.
  Shader interface structs admit signed/unsigned 32-bit scalar and vector fields, including flat integer varyings.
  Instance inputs follow mesh buffers and `useThinInstanceColors`. Incompatible layouts refuse at generation;
  unknown material selections require a recorded shader/mesh association and validate the compiled lanes before drawing.
  Unused scene-local shader materials retain their IDs and resource slots without compiling stages; task overrides
  participate in mesh-layout discovery and retain their own texture bindings, including runtime replacements.
  `needAlphaBlending` and `depthWrite` read the shader factory's flags; other material families yield `undefined`.
  Alpha-to-coverage on Standard, PBR and shader materials; NodeMaterial refuses. Storage uploads preserve typed-array, DataView and ArrayBufferView byte ranges.
  `_shadowCasterMaterial` reads preserve the optional caster handle; writes bind an alternate shader caster as
  `setShadowCasterMaterial` does, and the next frame's caster refresh follows them. PCF/CSM creates cached shader
  no-color views and follows caster override chains; shader ESM views are unsupported.
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
- `createVatBakeResult(s)` uploads prepared VAT payloads with the pin's checks. Bakes are storable handles; their counts,
  clips and bone captures read natively. `texture` is not lowered.

## Sprites, picking, flow graphs, gizmos

- Sprite2D, billboards, atlases, Y-sort. Mixed transparent draws tied in depth/order or without a camera refuse.
  Capacities ≤ 4,294,967,295; buffers 32-bit sized.
- `addBillboardSystemToScene`, `addDepthHostedSpriteLayerToScene` and `addTextRenderableToScene` add a member
  once per scene; it draws after the next scene build. Collection removal, snapshots and subscriptions are unsupported.
- Picking: `createPickingRay` needs no GPU picker; detailed picks skip thin instances, billboards and splats.
  A `pickAsync` filter is the scene's predicate per mesh; `ignore` skips a mesh or its thin instances. A `discard`
  rule's key, WGSL and storage layout fold at generation (literals, constants, conditional arms, or a model run of
  the call building it with engine values opaque) into the pin's pick shaders; each storage `data` runs per mesh
  and pick, null drawing that mesh unruled; the pick refuses a rule other than the one its key composed. A
  `worldAdjustWgsl`, `vertexData` or vertex-visible storage draws every candidate through the advanced pipeline;
  `vertexData: "uv2"` and a rule over a deforming or VAT mesh refuse. VAT meshes pick through their baked pose; a
  detailed VAT pick refuses. A result's `thinInstanceIndex`, `faceId` and `distance` are the resolved hit's; a stored
  or awaited result's `pickedMesh` becomes a Mesh of the entry's engine after a run-time check that it picked there.
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

- PCF spot/directional, ESM directional, CSM. Directional fits use the world bounds of active thin instances; empty or
  fully parked pools contribute no bounds.
- Shadow generators and caster lists can be prepared without scene scheduling; `registerSceneWithShadowSupport`
  activates shadow passes. Registered empty caster lists clear the shadow map.
- `generator._config._forceRefreshEveryFrame` reads and writes the flag the render gate tests each frame.
- `enableCsmStaticCache` (awaited, before registration): static casters render into a cache texture, copied per layer
  into the map before dynamic casters draw; refit gate, per-frame cascade budget and coverage refit
  (`cascadeCoveragePadding`) as pinned.
- Recast/Detour solo and obstacle tile-cache builds, crowds, obstacles. Tiled builds without obstacles and off-mesh
  connections in tile caches refuse.
- Navcat runs as program code: the pin's `navcat*.ts` modules and the vendored navcat/mathcat TypeScript compile
  with the program ([architecture](architecture.md#lowering-invariants)).

## Frame graph and post-process

- Ordered targets/tasks, MRTs, blits, MSAA resolve; `addTaskAfter` only during initial setup; `removeMeshFromTask`.
- `RenderTask.enabled` is the task's own execute gate beside `executionEnabled`; a base `Task` is storable data, and a
  task name takes another task. A render task's `rst` held as optional data is absent when unset; other target options
  refuse it.
- A scene-less `FrameGraphContext` refuses in an application realm: the engine holds it by address.
- Overlay scenes (`createOverlayScene`, `createUtilityLayer`) load the supplied `rt`, resolve into the optional `rst`,
  and clear their own depth after their base's frame graph. A render task publishes both targets through `config`;
  the scene's default producer is `scene.defaultRenderTask`. A base on an auxiliary surface, TAA and `moveRenderingContext` refuse.
- Render targets accept explicit pinned-default `depthCompare` and `depthClearValue`; other values refuse.
  Explicit `depthCompare` overrides ShaderMaterial depth state. `scene.surface` reads require a known primary-surface scene.
- `size: { canvas: standIn }` accepts pure width/height getters over the engine canvas's corresponding backing extent
  and numeric literals (`+`, `-`, `*`, `/`, `||`, `&&`, `Math.max/min/floor/ceil/trunc/abs`). Each build resolves the current
  extents, including resize rebuilds; other stand-ins refuse. Resolved dimensions must be positive uint32 integers.
- `buildFrameGraphTask(getFrameGraph(scene), task)` records a render or effect render task added to a live scene, which
  refuses to execute until then, an SSAO task (settings and working resolution) or a copy task (its source resolves at
  every execute). `removeTask` unlists every registration of a task, which keeps its passes and resources. The private
  `FrameGraph._tasks` list refuses (its native indices differ), except a `const` view whose `indexOf(task)` position
  is only tested `>= 0` and spliced out at once (`splice(i, 1)`), which removes that registration.
- A render target's private `_width`/`_height`, read through a cast, is the swapchain target's canvas backing store as
  it is when read; another target's refuses when read. Its `_colorView`, read through a cast, is tested only for
  presence: set for the swapchain, an eager target, and a target the frame graph's registration or
  `buildFrameGraphTask` built (render, effect, copy, geometry and post-process task outputs), until it is disposed.
  Its `_colorTexture` is that colour texture's identity: null while `_colorView` is, fixed for a fixed eager target,
  and new at each build of another, including each registered scene's rebuild when the canvas's pixels change. The
  swapchain's and a surface render-target texture's refuse when read.
- A render target's `samples` may be decided at run time (1 or 4). An option written `undefined` is that option unset.
- A `RenderTargetTextureResult` is storable data and a parameter type (`<T extends RenderTargetTextureResult>`).
  Engine resources joined by `??` keep the engine each operand names.
- A copy task's `ownsTargetTexture: true` takes a surface-sized target (rebuilt at each resize); a fixed one refuses
  at run time.
- Render and effect render task `dispose()` releases owned targets (not the swapchain's); executing a disposed task refuses.
  Effect task `record`/`dispose` replacements require a synchronous zero-argument arrow calling a preceding
  `const original = task.record.bind(task)` (or `dispose`) on the same receiver; `try/finally` is supported.
  Base `Task` storage checks the effect-task kind at runtime. Recording runs on graph build and canvas resize,
  not on each execute; scene disposal calls the current dispose wrapper. Other method writes refuse.
- An effect render task's `scissor` takes a run-time `NormalizedViewport` or null; the native task copies its lanes. A
  fresh object (a literal, or a call returning only literals or null) in a statement that only stores it always stores;
  any other value refuses where the program writes a lane of a record that type could hold.
- `disposeRenderTargetTexture`: a later executed task or material using the target refuses; material plugin textures
  keep the image they bound. `disposeEffectWrapper`: a registered EffectRenderer drawing a wrapper with a uniform
  binding refuses.
- TAA: one scene, explicit Standard color tasks, engine-format color, depth24plus-stencil8, single-sample inputs, created
  before its scene registers (after frames ran, too). These hold for frames whose frame graphs hold a TAA task; any
  other frame of a program reaching TAA encodes every task kind as one without it.
- `enableGeometryVelocity(task, { previousDepth })`, unconditional before scene registration: the task's PBR views write
  material-point velocity (previous world, bones and morph weights; previous view depth in Z), and every Standard
  LINEAR_VELOCITY view of the program writes its previous world, bones and morph weights with the same output. A
  transform write that leaves the packed world unchanged moves nothing.
- Without it, a LINEAR_VELOCITY task's preload (at registration, or when a material family first reaches the task)
  loads the previous bones and morph weights for Standard views once its scene lists a skinned or morphed mesh; a
  Standard view of a deformed mesh built before that refuses, as the pin does.
- `createDepthResolveTask` writes sample 0 of a multisampled target's depth into a single-sample target's depth
  through the pinned module, refusing as the pin's build does. A source the multisample gate draws single-sampled, and
  a target with stencil or more than one layer, refuse.
- `enableRenderTaskTransmission` with `linear: false` on a non-swapchain render task: the pass breaks before
  transmissive transparent draws (`copyCount`) to grab colour from `rt`. With `grabDepth`, it snapshots the attached
  depth (`depth ?? rt`, including geometry and overlay depth; null without depth). Multisampled grabs average colour
  and take depth sample 0. Enable depth or multisample grabs before recording; `grab.texture` and `depthTexture` read
  live for `setShaderTexture`. The per-task linear arm refuses. Automatic scene transmission cannot retarget shared colour.
- Contact shadows, one-bounce GI, screen-space ambient occlusion
  (`createScreenSpaceAmbientOcclusionPostProcessTask`), EffectWrapper/EffectRenderer with bounded layouts and an
  add-equation blend state over `zero`, `one`, `src-alpha`, `one-minus-src-alpha`, `dst` and `dst-alpha`; custom
  vertices refuse. A fragment held in an unwritten `const` helper result may select finite variants from boolean
  or string-literal-union inputs when those inputs re-read unchanged at the wrapper; unbounded text refuses.
  Effect textures come from solid/pixel factories or render targets, with 2D float or depth layouts;
  scene frame graphs sample depth through `textureLoad`. Effect samplers use the `filtering` binding type, or
  `comparison` over a `viewDimension: "2d-array"` depth layout, which takes only `getCsmReceiverTexture` and samples
  its comparison sampler in a scene frame graph's effect task.
  `viewDimension: "3d"` float layouts take `createTexture3DFromPixels` textures, which bind nowhere else.
- `createSsaoTask` (XeGTAO): perspective and orthographic cameras, every quality, view normals from a geometry task or reconstructed from depth, temporal
  reconstruction with a geometry `velocityTexture` (and `velocityHasPreviousDepth`), `resetSsaoTemporal`,
  `enableSsaoHalfResolution`, `enableSsaoMotionPruning`, live `enabled`/`radius`/`intensity`/`historySamples`.
  Live `quality`, `normalTexture` (one attachment, or none), `temporal.enabled` and pruning `enabled` writes, and a
  normal input chosen at run time, compose every mode they select. `enablePbrSsao` feeds diffuse IBL in the task camera's
  PBR color passes; alpha-tested materials keep their discard in non-color passes. A setting written by a computed key needs a string-literal-typed key.
- `setEffectTexture` takes solid, pixel or render-target textures by binding name or number, including cached pixel
  textures and live changes between these kinds. Pixel bindings preserve sampler/sRGB settings, replacement identities
  and live region writes. Render targets bind in frame-graph effect tasks only, through the bound texture's `sampler`.
  A `Texture2D` record `{ get view() { return rt._colorView; }, sampler, _sampleType: "float" }` (optionally a
  `texture` getter over the same target) binds, stores and selects as that single-sample colour target through its
  own sampler; stored, it reads back its `sampler`. Conditional texture arms prepare and convert only the selected
  value, including getter-backed records returned by helpers.
- Image processing: exposure, contrast, toneMapping, toneMappingEnabled.

## Text

Font parsing/shaping/packing at generation; live layout over the packaged repertoire. `updateTextData`
(reset/addRun/removeRun/replaceRun), `updateDefaultTextData`, `setFontWeightOffset` are live. Renderable text needs one
text-only default scene with a static FreeCamera or supported ArcRotate. User glyph storages refuse.
