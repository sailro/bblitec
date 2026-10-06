# Features

`bblitec` compiles a bounded TypeScript/Babylon Lite subset. Unsupported forms refuse during generation
or at explicit resource/device checks. Limits here and in [UI](ui.md) (browser projection) are the
capability gaps; [fidelity](fidelity.md) owns semantic substitutions.

## Why anything is compile time

Assets, closed producers and shader composition run during generation. State, input, animation,
uploads and rendering run natively. There is no general JavaScript interpreter or dynamic module loader.

## Feature and capability selection

| Input | Selects |
| --- | --- | --- |
| Reached APIs/properties/globals | Generated code, PAL units, native dependencies |
| Call options and asset loader predicates | Runtime features joined from assets, subfeatures, codecs, material variants |
| Pinned composition | Shader arms, layouts and binding requirements |
| Registry | Source, title, host UI (companion or page), reference query and attribution |
| Build options | Backend, capture, size and PCH configuration |

`generated/<id>/upstream/feature-activation.json` records repository-relative reach sites, asset joins,
the activation plan's reasons and checked consumers. An asset's loader trigger joins the same runtime
feature a scene call reaches before anything reads the feature list; material and shader capabilities,
including the transmission renderer, come from the composed arms. Reaching a factory activates its
module even when one of its options is disabled, except where a literal option opts a parser out, as
`loadBabylon({ loadCamera: false })` does for the camera parser.

### API coverage inventory

The pinned `index.d.ts` supplies [`upstream/babylon-lite-api.json`](../upstream/babylon-lite-api.json):
exports, overloads, methods, fields/accessors, index signatures and reachable types. Fingerprints include
type dependencies. Inherited fields belong to their declaring type; external peer APIs and stripped internals are excluded.

| Evidence | Scope |
| --- | --- | --- |
| Exercised forms | Successful AST lowering across the full test suite and every registered scene/demo, including dynamic test inputs |
| Source translation | Generated pinned bodies, configured bindings/specializations, and dispatched call/method/expression/statement adapters |
| Entry adapters | Registry probes and passing source forms; imported Babylon calls require an entry adapter even when their bodies translate |
| Semantic cases | Scoped native/parity assertions and refusals in [`upstream/api-coverage.json`](../upstream/api-coverage.json) |

Exercise percentages separate signatures, fields/accessors, constants and callbacks (type containers
excluded) and qualify exercised forms only; failed compilations, discarded probes and stale receipts earn
no credit. Unassessed declarations and type-dependent probe fallthrough are unknown; `partial` combines
positive and refusal evidence. The adapter boundary is unclassified, so there is no overall PAL completion
percentage. See [collection commands](development.md#api-coverage) and, for one external entry,
[sizing](development.md#sizing-a-capability-before-implementing-it).

## Program compilation

`--deferred-capabilities runtime-throw` (`CompileOptions.deferredCapabilities`) admits explicitly registered missing APIs with
owned argument/result representations. Their reached sites appear in `manifest.deferredCapabilities`;
runtime calls throw or reject according to each descriptor. Later source still compiles normally.
Registered audio graph operations retain typed failures; engine/source option variants reject only for present options, preserving the existing absent-options adapters.
Registered media stream, recording, streamed-audio and script-element operations throw or reject at their typed boundary. Recorder and BlobEvent values have owned nominal storage; no unavailable producer returns a dummy object.
Session storage access, idle scheduling/cancellation, dynamic surface pixel-ratio reads/writes and application-realm device recovery have typed throwing boundaries. Idle callbacks retain owned signatures; scene-only recovery keeps its supported path.
Byte streams/compression and Intl.ListFormat/PluralRules have typed throwing boundaries; existing buffered response reads and ICU operations remain supported.
Unregistered APIs, unsupported type/ownership forms and dynamic argument spreads still refuse.
The default mode retains strict admission and existing capability-absence guards.
AbortController/AbortSignal use distinct opaque storage with no successful native producer. Their registered constructor, state reads, abort operations and signal-backed listener lifetimes throw when reached; an undefined listener signal uses ordinary native dispatch.

| Area            | Supported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Limits/adaptations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modules         | Named/namespace imports, re-exports, constant aliases, external local TS/JS, JSDoc, `?raw`, ordered initialization and side-effect dependencies; literal dynamic imports retain asynchronous settlement, once-only initialization, namespace identity, live exports, cyclic lexical bindings and cached failures; authored entry calls preserve surrounding startup work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Runtime-selected modules; callable namespace `then` exports; lazy top-level await, namespace/class/enum runtime initialization, `var`, destructured/uninitialized bindings, dependencies on the entry, or bindings without owned storage; unrepresented mutable initializer dependencies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Control flow    | Blocks, conditionals (also as statements), loops, switches (fallthrough, `default` anywhere, `null`/`undefined` labels on optional or document discriminants), break/continue (also labeled), throw and never-returning calls, Error constructors with or without `new`, owned caught Errors, suspending catch/finally with return and loop-exit completion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Arbitrary cleanup across `startEngine`; labeled jumps out of unrolled loops, labeled continue across switch/try and returns out of an inlined function's unrolled loop refuse; absence labels need storage telling `null` from `undefined`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Functions       | Typed/generic functions, defaults, omitted optional or defaulted parameters (stored functions included), rest parameters, destructuring, supported recursion, calls through module `const` aliases of functions and Math members, contextual optional callback results, stored values shared or adapted across sink signatures, owned generic/unknown-parameter methods specialized at reached calls, stored unknown-rest callbacks packed into owned arrays of their reached argument types; stored optional generic methods; a caught error (or a `const` copy of it) passed to a stored `unknown` parameter stays an Error; unmapped rest-function Arguments objects retain length, indexed reads, identity and captures; type parameters narrowed past null inside generic bodies or bound through a discriminated union member or a union's generic instance (`T \| Promise<T>`)                                                                                                                                                                                                                                                                                                                                                          | Unresolved type arguments; unbounded resource specialization; stored generic `this`, new recursive signatures, signature-family conversions and `Function.call/apply/bind`; Arguments mutation, reflection, optional/defaulted parameters and unconstrained argument queues; arguments/results without owned representations; a stored value cannot take a narrower signature; an adapted value is rebuilt at each reach                                                                                                                                                                                                                                                                                                                                                                                             |
| Classes         | Fields, methods, accessors, generics, retained callbacks, receiver-preserving structural views, private names for fields, methods and accessors, rebound class-typed locals (`let c: C \| null = null; c = new C()`); inheritance between local classes: `super(...)`/`super.m()`, abstract and protected members, overrides dispatched through base-typed stored references, `instanceof`; authored subclasses of builtin Errors with owned payloads and catch identity; mutable static fields and static blocks, run where the declaration evaluates; private brand checks (`#x in value`); methods recursing through stored instances; optional method calls (`r?.m()`) as values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Other non-local bases; Error reflection; authored Error payloads in builtin cause or AggregateError storage refuse at construction; generic classes or sibling fields of different types in a stored hierarchy; a private name redeclared in a subclass; writing an inherited static through a subclass; static accessors; an uninitialized `let c: C \| undefined`; unsupported field storage                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Closures        | Shared mutable cells, also for callbacks kept by repository functions, methods or record members; function identity across repeated factory calls, optional calls, escaping recursive groups, named self-scheduling expressions, deferred cycles through owned function bindings, reassigned function locals; stored closures preserve the temporal dead zone of later bindings, including reads through reached functions/callbacks; native callbacks may materialize pure initializers ahead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Captures need owned representations; borrowed input events, and closures reading a binding that holds one, cannot escape dispatch; a stored closure reading a later binding without an owned data type refuses; a native callback initializes it ahead for direct reads and leaves it unbound through a reached function; the callback is registered at the declaring block's level                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Data            | Typed/nullable records with required and optional `undefined` fields, unions selected by literal tags (one or more per arm; a field only some arms declare is own under their tags) or required non-nullable keys, mixed unions (a read every member answers selects the member held), arrays, tuples, dictionaries, Map/Set, JSON; unknown arrays with finite source-written layouts, including owned Arguments queues across concrete callback signatures; checked recursive dynamic callback signatures and retained native class views; stored records with `get`/`set` accessors (literal, whose `this` is the object it creates, or an `implements`ed class's); represented own-key presence of optional fields; an undeclared property reads `undefined` through a type admitting it, and deleting it changes nothing; rebound locals, optional and union slots included, reseat to the assigned record, array, buffer or view; a record stored as another record type (assignment, argument, element, `??`, `?:`) stays one object through one shared layout (`readonly` modifiers aside), or is copied where nothing can tell, as an array of records lent to a callee that only reads it ([fidelity](fidelity.md#semantic-contract)) | A record conversion no shared layout holds refuses where a write, identity use or enumeration could tell its copy apart; an empty `?` property that also admits `null` refuses at run time; type shapes sharing a struct that disagree on a property's presence refuse; reading an undeclared property refuses through a computed receiver or where a record converted into the struct may carry it; accessor records: enumeration, narrowing conversion, worker cloning; stored accessor spreads; dynamic class views with unrepresented fields; required `void` fields without a proven undefined completion; mutation through erased native records/arrays; storage ambiguities; dynamic `typeof` values in inferred string-literal fields; recursive record/function initializers without matching owned layouts |
| Async           | Realm-owned promises, async functions/methods/IIFEs, early returns, loops, retained activations; outside a realm, constructed promises whose resolving functions escape into callbacks; value-promise `catch`, stored or timer/frame-settled constructed promises, suspending callbacks (application realm); `Promise.resolve` takes the expected result type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Custom thenables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Generators      | Lazy synchronous/asynchronous bodies, stored callbacks, shared iterator position, zero-argument `next`/`return`, `for...of`, `for await` over asynchronous iterators, IteratorClose and awaited cleanup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `yield*`, empty/consumed yields, inbound `next` values, `throw`, final return payloads, yields in finally, stored-generator parameter defaults, `for await` over synchronous iterables; retained closures cannot capture opaque generator storage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Workers         | Local module scripts, isolated module state, cloning of records, arrays, numeric tuples, Date, Map, Set, ArrayBuffer, typed arrays and DataView with cycles/aliases (views of one buffer share its copy), timers, errors, close/terminate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Classic/runtime-selected scripts; incompatible rendering products; messages carrying class instances, Errors, mixed unions, dynamic JSON, functions, promises, iterators or platform objects refuse; SharedArrayBuffer/Atomics; listener options other than static `once`; WorkerGlobalScope error listeners and worker-scope rejection dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Worker graphics | OffscreenCanvas transfer, independent scene owners, shared Window presentation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Transfer lists admit OffscreenCanvas only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Opaque native objects refuse retention as structural records without a represented shared identity.

Local JavaScript implementations take precedence over companion declarations. Type-only imports do not
run initializers. `declare` creates no runtime value; bare `typeof` of an absent binding is `"undefined"`.
A module executed at generation may import its relative siblings without an extension.

Generation-known positions (option records, shader lists) read through `const` literals, settled
conditionals and spreads, and parameterless module functions whose body returns a literal. Shader text
and static iterations run a module `const` they cannot fold at generation; a run reaching the host, the
clock, `Math.random`, the host locale or a constant the program writes through refuses.
Dense literal arrays of scalar-field records can supply per-element resource arguments while retaining
native identity. Mutation, escaping aliases and untracked extraction withdraw those generation facts.

`import.meta.env` uses production client constants: `MODE="production"`, `PROD=true`, `DEV=false`,
`SSR=false`. `BASE_URL` follows deployment. Custom string fields use `--env NAME=value` or
`CompileOptions.environment`; absent keys are undefined. Built-ins cannot be overridden; dotenv and host
variables are not loaded implicitly.

Defaults, short-circuit operands and conditional branches evaluate once and lazily. Record-valued `||`
supports nested `&&` guards and keeps the selected record's identity; `a && b` selects represented
values, a left whose present values are all truthy contributing only its absence; branches of different
types select as the conditional's type. A conditional spread (`...(c ? { a } : {})`) adds its keys only
where its arm is taken. An assignment is the value it assigns, its target evaluated once; an engine property target is read back and must not run code. Operands of concatenation, arithmetic,
comparisons, calls, constructions and array/object literals evaluate left to right wherever two of
them touch the same variable or object state and one writes it, including through the functions they
call and `Math.random` draws; a function value the compiler cannot name counts as touching everything.
An engine function or class method is read from the pinned body behind its typing, and one with no
pinned body (an interface method) counts as touching everything. An object or array literal kept past
the statement that builds it holds each member's value as it was built, and an object an engine
function writes through (`normalizeVec3ToRef(v, out)`) keeps native storage. Loose
equality between operands of one primitive type is strict equality; across types it refuses. `=== null`
and `=== undefined` on an absent value answer from what its type admits. A read whose slot may hold
`null` -- a `Map.get`, an optional chain over a nullable field, an array index, `pop()`/`shift()` --
knows whether the slot existed, so a missing slot (`undefined`) and a stored `null` compare and spell
apart. Primitive unions containing both absence values retain distinct tags in dynamic storage;
other values that may be either without a represented tag refuse strict comparison (`== null`, or
`x !== null && x !== undefined` over one plain read, also inside a longer chain, answers either). An enum member reads as its
constant wherever it is written, `Tone["Soft"]` included. Object and array declarations compose nested
bindings, rest and lazy defaults; a parsed document destructures its array elements or string code
points, without rest or defaults.
Destructuring finishes the source before left-to-right target writes. Defaults requiring distinct null/undefined states refuse when storage
cannot distinguish them. `for...of` ranges over constructed collections and admits identifiers, tuple/rest bindings, plain struct fields and,
when unrolled, plain or renamed object bindings; other nested/default/renamed struct bindings refuse.

Dynamic JSON preserves actual fields and object identity through typed locals, arguments (members
included), conditionals and represented record, dictionary, array and tuple returns, including async
returns. Owned document fields, optional-number slots and Record entries support assignment and numeric
updates (an absent value reads NaN, or 0 for `null`); array index writes retain
dense storage. Sparse growth, named array properties and writes through erased native views refuse. Source-backed
record ownership can trigger compiler replay, preserving earlier aliases and initializer counts. Getters
permit statements before a final return, and early returns of a represented result type.
Finite-key record unions share compatible arm storage, including numeric tuple fields of different
lengths. Changing a retained arm's layout refuses generic substitutions, conflicting layouts, field
loss and incompatible mutable field storage.
Self-captured `satisfies` records retain one identity when their checked and initializer layouts agree;
a typed record whose methods name its own binding or read `this` is one shared object; a `this`-reading
literal method whose function value is read from an object that can hold it other than as a member call's
callee (extraction, `call`/`bind`, destructuring, spreads, `Object.assign`/`values`/`entries`) refuses. Stored callback fields retain
function identity and observe replacement through record aliases. Structural views of native services
retain the producer's identity through factories, spreads and captured bindings; mixing authored and
native implementations in one mutable slot refuses. Native function `call`/receiver-only
`bind` preserve target and argument evaluation order; dynamic receiver rebinding and partial `bind` refuse.

| Promise operation | Contract |
| --- | --- | --- |
| `resolve` / constructor | Object identity; synchronous executor; first settlement wins; represented promise adoption |
| `reject` | Owned Error identity |
| `then` / `catch` | Owned captures, queued reactions, compatible result storage, destructured fulfillment parameters; callback throws reject; `catch` and rejection callbacks bind their parameter to the caught Error |
| `finally` | Waits for cleanup; preserves original result unless cleanup throws/rejects |
| `all` | Ordered literal tuples and stored arrays of value promises; first rejection wins |
| `allSettled` | Ordered literal tuples and stored promise arrays, including void; fresh settlement records and original Error identities |
| `race` | Homogeneous represented arrays/tuples; empty input stays pending |

Optional promise values adopt their present payload or settle to absence through `await`, async returns,
`resolve`, reactions and literal `all` tuples. Arbitrary rejection values, heterogeneous race results
and unrepresented aggregation shapes refuse.
`all` excludes literal spreads, other iterables and stored void/value-only arrays. `allSettled` excludes
literal spreads and other iterables. Async collection callbacks start synchronously and retain
suspension; predicate promises are truthy.
Awaited, statically expanded `Promise.all` maps preserve fixed asset-load order; runtime-sized resource construction refuses.
Outside a realm the executor runs in place and an await reads the settlement; one still pending ends the
awaiting activation ([fidelity](fidelity.md#semantic-contract)). Timers/microtasks need no engine. RAF
needs a Window repaint source. Unhandled rejections are reported in a subsequent task after microtasks.
MessageChannel refuses; gzip/base64 JSON decoded through
`DecompressionStream` folds at generation.

### Core TypeScript library

| Area            | Supported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Limits/adaptations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Numbers         | Reached Math operations and every Math constant (also at module scope), non-coercing Number predicates/constants, global `isNaN`/`isFinite`, the predicates and `Boolean` as function values (`every(Number.isFinite)`, `filter(Boolean)`), JS coercions, rounding and `**`/`**=`, numeric callbacks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Native double transcendental functions; deterministic random; bounded rest signatures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Variadic Math   | `min`, `max`, `hypot`, numeric tails and spreads of arrays, tuples, typed arrays, Sets and iterators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Native `hypot` approximation; NaN/signed-zero rules retained for min/max                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Arrays          | Map/filter/find/findLast/reduce/reduceRight (initial value optional)/predicates, type-guard `filter` narrowing string tags, flatMap/flat/concat, `toSorted`/`toReversed`/`with`, typed `Array.from` mapper results, `Array.from` over tuples, typed arrays and strings, Object identity mappers, sorting (any function comparator), callbacks walking the receiver and length read at the call (removed indices skipped), indexed searches with `fromIndex`, fill/copyWithin/splice, joins, pop/shift yielding absent on an empty array, mutating methods on an array literal (`[a, b].pop()`), truncating `length` writes including compound ones; string spreads yield code points; `Boolean` callbacks over optional elements; readonly native/callback parameters, rebound readonly bindings and nullable readonly conditionals retain array ownership and identity | Closed flatten depth; borrowed `ArrayLike` views cannot provide retained array identity, rebinding or identity comparison; no callback `thisArg`; an asserted `pop()!`/`shift()!` of a non-nullable element refuses at run time on an empty array; a `find*`/`map` callback removing an unvisited element refuses at run time; sparse `length` growth refuses at run time; record conversion follows [fidelity](fidelity.md#semantic-contract)                                                                                                                                                                                                                              |
| Tuples          | Shared identity, typed and dynamic lanes, mutations, `fill`/`copyWithin` and observing array methods, shallow rest arrays, destructuring, spreads into arrays, wider tuples and fixed call arguments; a number array asserted as a tuple stays that array; numeric tuples keep identity through readonly-array, `ArrayLike`, number-array union and writable array parameters; a defaulted array parameter is fresh per call; a tuple binding stored as a number array, or passed where a callee may grow it, takes array storage; heterogeneous lanes destructure as their declared types                                                                                                                                                                                                                                                                              | Sparse length growth and ambiguous null/undefined defaults refuse; an asserted array of another length refuses at run time; another tuple (a parameter, a field) stored or passed that way refuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Map/Set         | Ordered construction, queries, mutation, spreads, entries, live `forEach`; stored `ReadonlyMap`/`ReadonlySet` views preserve identity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | An iterator value of a nullable reference type reads as present                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| WeakMap         | Empty construction with erased object or DOM-target keys, get/set/has/delete, owned values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Each erased key must have represented record or DOM identity; other key views and initialized erased-key constructors refuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Iterators       | Direct array/Map/Set iteration; retained Set keys/values/entries cursors, `next`, spreads, `Array.from`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | General authored `Symbol.iterator` objects refuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Strings         | UTF-16 indexing/length, `indexOf`/`lastIndexOf`/`includes`/`startsWith`/`endsWith` with UTF-16 positions, substring/repeat/concat, `String.fromCodePoint`, padding, trimming of JavaScript white space, replacement strings/callbacks, `encodeURI`/`encodeURIComponent` with UTF-16 surrogate validation, `decodeURI`/`decodeURIComponent` throwing URIError on malformed escapes, `+=` on locals, fields and elements; an absent value in concatenation, a template or `String()` spells `undefined` or `null` from its represented tag or type, including scalar reads past an array's end                                                                                                                                                                                                                                                                            | A concatenated operand is built before it is appended; unrepresented mixed absence states refuse in text; a `lastIndexOf`/`endsWith` position that may be `null` or `undefined` needs storage telling them apart                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| RegExp          | Supported `g`/`i` patterns and replacement callbacks with captures/offset/original string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | RegExp `replaceAll` with string replacement refuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Unicode         | NFC/NFD/NFKC/NFKD normalization; `localeCompare` locale/options; `toLocaleLowerCase`/`toLocaleUpperCase` with default, string or string-array locales                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Option getters and non-string locale entries refuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Text encoding   | UTF-8 `TextDecoder` (`fatal`, `ignoreBOM`) decoding an ArrayBuffer or view; `TextEncoder.encode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Other encodings, streaming decode, `encodeInto` and codec properties refuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Objects         | Supported keys/values/entries (as arrays for dictionaries, structs, parsed documents (also typed `object` or `unknown`) and records with conditionally present keys), assign/fromEntries/hasOwn/is (a struct source's `?` fields copy while own), object destructuring of parsed documents, shallow spreads (including nullable dictionaries and structs with `?` properties), object-rest copies of represented records, delete/in (a struct's `?` field also by a key generation knows), `for...in` over the same own keys; dynamic struct membership; fixed-field records read through string-indexed helper parameters; a closed record asserted from an open string record (`as Record<Union, V>`) views its entries; one asserted from `{}` is a dictionary                                                                                                       | Object rest requires literal exclusion keys and a concrete record result. Own keys follow [fidelity](fidelity.md#semantic-contract); fixed-field dictionary reads require one non-nullable field type and preserve aliases; dynamic writes through that view, dynamic class membership and class hasOwn refuse. A struct with `?` properties or a conditional spread enumerates as a fixed key list (Object.assign) only with known own keys, and `for...in` over its keys cannot leave the loop early; Object.assign targets records, object literals and structs, other targets refuse; a closed asserted view's read of an absent entry refuses; enum-keyed views refuse |
| JSON            | Represented parse/stringify, mixed unions of serializable values, actual dynamic fields, index-key order, omission of undefined properties and members; a generation-time pass folds only when its result is a round-trip document, else it lowers as an ordinary call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Replacers, cyclic serialization and Map/Set values refuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Dates           | Current/numeric/copy construction, now/getTime/valueOf/setTime, UTC `toISOString`, UTC and local field getters, `getTimezoneOffset`, `Date.UTC`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Local time is the platform ICU's offset for the host zone, resolved once per thread; no string/calendar constructors, setters or formatting methods                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Intl            | Default DateTimeFormat and resolved time zone; Collator(locales, options) and `compare`, as `localeCompare`; number `toLocaleString(locales, options)`: decimal/percent, digit, grouping and locale-matcher options, `nu` extension                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | No DateTimeFormat locale/options, formatting or broader fields; Collator `resolvedOptions` and a detached `compare` refuse; `Intl.NumberFormat`, currency/unit styles and other number options refuse (a struct's absent option field is checked at run time); CLDR data is the platform ICU's                                                                                                                                                                                                                                                                                                                                                                              |
| URLSearchParams | String constructor, get/has/set/toString, duplicate order, decoding and form encoding; mutation retains object identity and invalidates deployment-query folds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Append/delete/sort, iteration and other constructors refuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Binary data     | ArrayBuffer (`slice`, `isView`), DataView getters/setters, Int8/Uint8/Int16/Uint16/Int32/Uint32/Float32/Float64 arrays: `of`, `constructor` with `new`/`from`/`of`, `from` (optional mapper), construction and `set` over arrays, numeric tuples, typed arrays, number Sets and iterators, narrowed optionals and their unions, an absent view byte offset; methods `at`/`join`/`indexOf`/`includes`/`lastIndexOf`/`some`/`every`/`forEach`/`find`/`findIndex`/`findLast`/`findLastIndex`/`reduce`/`reduceRight`/`sort`/`reverse`, `map`/`filter` keeping the kind; spreads into arrays, `String.fromCharCode` and `Math.max`/`min`; `ArrayBuffer \| ArrayBufferView` unions narrowed by `instanceof`; typed-array unions read `length`/`buffer`/`byteOffset`/`byteLength`/elements of the member held                                                                  | Unrepresented element/storage consumers refuse; `from` over an ArrayBuffer, number or string refuses; `instanceof` a view class over an `ArrayBufferView` member refuses; element writes through a union, a possibly undefined view length, `Uint8ClampedArray`, other `constructor` uses, a callback naming the array parameter, iterators and `toString` refuse                                                                                                                                                                                                                                                                                                           |

Typed-array buffer views retain bytes, offset, length and identity. Constructors check ToIndex,
alignment and bounds; set/slice/subarray/fill/copyWithin preserve overlap rules. Raw contiguous
consumers and some iteration paths refuse views. `ArrayBufferView` retains typed arrays and DataView.
Numeric index-signature writes preserve element conversion and grow ordinary arrays.

Finite record Proxies support literal get/set traps, optional-key deletion and value-only definitions
of existing data properties; Reflect.get preserves represented getter receivers. Empty/class targets,
dynamic-this methods, other traps, descriptor-inspecting traps and definitions requiring new
property attributes refuse. Symbol and FinalizationRegistry values refuse.
Array/object aliases normally retain identity; a `const` alias of an array field refuses use after that field resizes. Stored callbacks can copy plain value-layout records,
including records captured through optional/defaulted parameters; later field replacements may not
propagate between caller and callback. Spreads and object rest copy own scalar fields and share nested objects.
Object enumeration places numeric index keys before insertion-ordered names. Fixed record key
snapshots retain initialized keys; module namespace keys are lexical and values remain live.
String-literal-union searches accept outside strings as misses. `invertMat4` returns nullable fresh
Float32 storage; Float64/high-precision combinations refuse.

## Asset materialization

Reached URLs and base64 data become packaged assets. `--public-dir` maps deployment-relative assets;
`--public-url` serves root-relative assets no public directory holds, and a root-relative asset with
neither refuses; registry scenes compile with the pinned `lab/public` URL. `--site-url` sets the base
(default `http://localhost/`). Other origins use remote loading.
Unsupported dynamic URLs and percent-encoded asset bodies refuse.

### Runtime HTTP

Async `fetch(url, options)` (application realm) uses absolute HTTP(S) URLs with specialized method, string headers, body and
a static cache mode (only-if-cached refuses). Known asset fetches without options or with
only a cache mode use packaged responses. Responses expose ok/status/url/bodyUsed and
text/json/arrayBuffer reads; bodies consume once. HTTP errors fulfill; transport/missing-file errors reject.
Response headers are unavailable; deferred mode gives `Response.headers` and `Headers.get` typed throwing boundaries.
Descriptor arrays and typed helpers retain closed local URL selections; filename patterns package only
matching files in an authored directory. URL expressions run once, and keys outside the package reject.
Request objects, streaming and wider options/methods refuse. Transport limits are in [fidelity](fidelity.md).

### Compressed geometry

Pinned Draco/meshopt decoders run during packaging. Sparse/quantized/compressed inputs become native
accessors. Bootstrap `setDracoBaseUrl` and `setKtx2DecoderUrl` accept generation-known URLs; KTX2 overrides
need fresh nested literals. Configuration is per loading realm and must precede compressed loads.

### Compressed textures

KTX1 packages BC/ASTC candidates in source order and selects a supported format on the rendering device.
Candidates require matching dimensions and sampler rules. Missing assets, unsupported families and
uncompressed fallback refuse. Basis/KTX2 uses the pinned browser transcoder; upload checks device support.

### Gaussian splat row updates

`splatsData` and `updateData(ArrayBuffer)` share owned rows. Equal-count replacement preserves old
aliases and refreshes rendering/picking. Borrowed buffers and writes to the getter-only property refuse.
Multiple fragment sets and broader buffer-view methods remain limited.
Shader fragment descriptors require known keys/strings and source-proven stable ownership;
mutable or escaping descriptors and lists without complete evaluated metadata refuse.

### Environment compilation

HDR uses pinned GGX prefiltering; DDS preserves specular mips; `.env` uploads decoded cubes. The BRDF LUT
is baked. Static box/sphere local environments and blended probe sets support setup before registration.
Retained probe geometry requires source-proven stable ownership through device recovery.
Live probe rebuilding/ORM rebinding refuse; direct intensity remains live.

Procedural sky environments support packaged BRDF textures, GPU cube generation/mips and live
atmosphere updates. Sun color and irradiance use pinned arithmetic; overlapping updates and disposal
cancel stale publication. Custom yield hooks refuse.

### Drawn and computed assets

Closed Chromium producers bake pixels/atlases. Pinned CSG/CSG2 bake geometry; CSG2 requires unchanged,
identity-transform boxes/spheres and known material partitions. Runtime CSG2 control refuses.

### Browser-produced textures

Closed scene functions may own canvases and invoke pinned pixel/texture factories. Unknown calls,
mutable inputs and runtime engine reads refuse. Live UI Canvas2D is separate.

### Node particles

| Path | Contract |
| --- | --- | --- |
| Frozen/baked | Pre-frame stepped/frozen sets without providers; retained numeric buffer reads |
| Sprite2D sheets | Shared Uint16 cells with live writes; replacement and broader bindings refuse |
| Native pure 2D | Supported static emission, Point/Box shapes, position/color, texture, Input/Math/Lerp/Converter and random modes |
| Emitter provider | Owned Float32 matrix callback sampled at wrapping and animation; definite initialization |

Sprite2D warm-ups with zero update speed support runtime startup buffer writes and origins;
subsequent updates run natively. Resuming emission or captured mutable graph state refuses.
Mixed frozen/native sets, unsupported evaluators/hooks, dynamic emission shapes and post-registration
texture/blend changes refuse. Finally across `startEngine` admits plain writes only. Snippets and
flipped textures remain limited.

## Shader pipeline

The reached shader set is closed at generation. See [shader fidelity](fidelity.md#shader-contract)
and [compiled bindings](backends.md#compiled-binding-contract).

## Engine, scene, and frame loop

Scene, sprite, effect and scene-less frame-graph drivers share frame orchestration. Immutable engine
aliases retain identity; multiple engines in one entry and rebinding refuse.
Stored engine contexts retain their owners through records, collections, callbacks and Promises;
borrowed entry contexts check their lifetime. Implicit resource constructors require one unambiguous
scoped engine context. A scene or raw resource handle alone does not supply that context.

Runtime `msaaSamples` selects one sample for numeric 1, four otherwise, evaluated once. Engine reads,
default scene targets and effect/frame-graph targets share this selection. Explicit numeric constants
other than 1/4 refuse. `enableSurfaceResizeObserver` admits engines and auxiliary surfaces; native loops
own extent refresh. `resizeEngine` and `enableShaderMaterialUniformCaching` are native no-ops;
`invalidateRenderBundles` moves the visibility epoch and each scene's renderable version.

Ordinary device recovery retains CPU owners and rebuilds GPU resources. Setup must be unconditional
before startup and observations require one scene. Failure callbacks expose `Error.message`. As
upstream, a failed recovery does not re-arm; a later loss then refuses rather than continuing. Only the
scene strategy registers, so a loss with an active sprite, text, effect or frame-graph context refuses with
the pin's own message. Shared worker/offscreen recovery and engine render-function wrapping are unsupported.
`disposeEngine` preserves retirement, stop, surface and resource cleanup order, including device
teardown after a disposer throws. It is independent of recovery. On Windows, application iteration
stalls during the modal window move/resize loop.
GPU task timing queries and enable requests expose the [native capability result](fidelity.md#semantic-contract).
Timing refuses tasks whose source passes this port does not reproduce: temporal anti-aliasing and
screen-space tasks, copies that may take the source's pass-less fast path, and on SDL_GPU the colour
render and post-process tasks of builds with temporal anti-aliasing.

Same-engine canvases have independent targets, cameras, rectangles and input ownership.

Compute tasks retain identity, writable names/execution gates and replaceable disposers.
Stored functions admit `call` and `apply` over owned argument arrays and tuples, and
`bind(thisArg)` without dynamic `this` rebinding. Map/Set lookup and mutation methods
admit receiver binding with represented partial arguments; other partial binding refuses.
Compute uniform layouts require generation-known field names/types and retain source packing,
validation and distinct object identity. Uniform buffers and task-owned arenas retain padded staging,
aligned slots and disposal. Typed writers admit f32/u32/i32 scalars and numeric vector/matrix arrays;
f16 writers remain outside the admitted surface. Binding declarations and shader descriptors retain
source validation and disposal; WGSL and entry points must be generation-known. Async pipeline
preparation, binding sets, dynamic offsets and ordered task submission run on both backends.
Bindings admit uniform/storage buffers, sampled/storage textures and samplers; optional record
own-property presence refuses. Frame-graph compute tasks may follow system shadows and must precede
user render tasks.
One-shot completion waits for submitted GPU work and preserves rearming/disposal semantics.
Storage readback validates byte ranges, coalesces identical requests and serializes differing ranges.
Compute outputs can feed sampled material slots and storage-backed geometry. Mipmap tasks preserve
source execution gates and command order. Six-layer storage views with cube sampling are qualified
on Dawn and patched SDL D3D12/Vulkan/Metal; other SDL drivers refuse this combination.

## Cameras and input

ArcRotate/Free cameras, framing, orthographic projection, viewports and supported SDL controls are live;
ArcRotate `wheelPrecision`, `angularSensibility` and `panningSensibility` writes reach attached controls.
Orthographic options admit halfHeight and optional left/right/bottom/top planes; later plane writes refuse.
World matrices admit copied typed-array reads and constant indices 0–15. Tracked transforms and
configurable FreeCamera controls retain worldMatrixVersion; mutable matrix aliases refuse.
Control restoration, geospatial input and broader camera combinations remain limited.

## Android

ARM64/x86_64 APKs use SDL_GPU or Dawn on API 28+; retained UI requires API 29+.
RmlUi, LabSound/SDL audio and worker canvases sharing one native window are enabled.
Authored maxDevicePixelRatio caps the render buffer independently of the full-screen view.
Apps use landscape orientation and immersive fullscreen. Reveal navigation with a bottom-edge swipe;
system Back exits the activity. Multi-touch supports simultaneous UI controls and camera gestures.
Multiple native windows remain unsupported.
[Commands](development.md#android).

## iOS

iOS 16+ bundles use SDL UIKit windows/input. Simulator requires Dawn/Metal; device builds support
SDL_GPU/Metal or Dawn. Trimmed ARM64 packages support iPhone and iPad.
Landscape fullscreen supports native density or `maxDevicePixelRatio=1`; intermediate caps refuse.
UIKit file import/export and native color emoji are supported.
Device bundles are unsigned and unqualified on hardware. Signing, device deployment and App Store
distribution are not implemented; Simulator captures do not qualify device behavior.
[Commands](development.md#ios).

## Asset loading and upload

| Format               | Supported                                                                                                                                                             | Limits                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| glTF                 | Meshes/materials, lights, perspective cameras, skins/morphs, animation, reached extensions, compressed/external assets; raw bytes read from a packaged fetch response | Contiguous FLOAT MAT4 inverse binds; complete contiguous animation accessors; fixed light capacity; raw bytes must be self-contained (GLB or `data:` URIs) |
| glTF ORM composition | Source-selected occlusion/metallic-roughness merge                                                                                                                    | Equally sized opaque images; no scaled/alpha/compressed bitmap composition                                                                                 |
| `.babylon`           | Parented meshes/nodes, Standard materials, point lights, cameras, loadCamera/loadTextures                                                                             | maxMeshes unsupported                                                                                                                                      |
| Closed collectors    | Source traversal/order and per-asset metadata                                                                                                                         | Rest/default/optional parameters, partial/repeated hierarchies, early break, instanced/splat producers                                                     |

Pinned loaders determine geometry, transforms, bounds, topology, material scheduling and feature-hook
order. `enableGltfCameras` requires definite setup. Orthographic imports refuse. Attachments preserve
existing scene cameras and fresh callback identities. Native animation retains source-selected owners.
3D texture creation, partial/runtime texture uploads and broader direct KTX2 paths remain limited.

## Geometry and meshes

Reached primitives, data factories, ribbons/extrusions/polyhedra, lines, CSG and thin instances use their
admitted option sets. Box/sphere data is mutable and shared through aliases. Unknown-count mesh/Standard/
PBR/shader factories require compatible profiles. Static expansion is capped at 4,096 iterations/1 MiB;
parameterized composition tables at 65,536 records each. Wider dynamic geometry updates, line
topology/colors/dashes and dynamic draw counts remain limited.
Owned data meshes support geometry resizing and shared-family rebinding; omitted clones retain their
existing geometry. Unshared, tightly packed meshes support GPU-only position and UV range uploads; imported
geometry updates and resizing refuse. Data meshes retain their input CPU array aliases.
Clones share those owners; resizing replaces them for the selected meshes. Device recovery uploads
the retained arrays' current contents and discards GPU-only writes.
`getMeshGeometry` and `getMeshTriangles` return independent CPU stream copies. Authored glTF tangents
are retained when `enableGltfCpuTangents` precedes loading.

## Scene hierarchy

Local/world transforms, visibility, parenting and bounded imported walks/cloning are represented.
Meshes may parent to meshes or transform nodes; transform nodes require transform-node parents.
Parent assignment and child insertion are separate. Synthetic glTF roots expose position, scaling,
Euler/quaternion rotation and copied world matrices. When scene code writes node transforms or looks up
an imported node, a glTF asset loads with the pin's node hierarchy: `__root__` and one transform node per
glTF node (a `matrix` node keeps its raw local, locked against TRS writes until setParent), each
primitive an identity-TRS child of its node; animated or morphed assets and punctual lights or
cameras then refuse. `findNode` over an imported root resolves the pin's DFS to a node or a uniquely named
mesh. Broader imported hierarchy cloning refuses; child-mesh queries remain limited.
Stored `SceneNode` handles retain imported-root and mesh cloning. Their `children` traversal is live,
ordered and preserves mixed mesh/node identity; `"material" in node` distinguishes meshes.
Optional visibility and thin-instance reads retain concrete node state. Removal snapshots children
before recursion and uses the concrete mesh retirement path. `getContainerMeshes` also flattens an
`{ entities: [...] }` literal of retained nodes, walking their live children.
Standalone transform-node cloning and child-list mutation through this view refuse.
Stored asset containers check synthetic-root ownership at runtime; singleton cloned-root containers preserve the clone's identity.
Detached imported leaves share geometry.
Opaque cached lists require visibility invalidation; transparent/transmissive visibility is live.

## Lights

Directional, hemispheric, point and spot lights support reached setters and per-mesh selection.
Intensity and diffuse-color setters retain validation and unchanged-value behavior.

### Clustered lights

PBR clustered containers compose shaders at generation. The container and light factories, the container's
addition and its per-frame refresh are lowered from the pinned bodies; the refresh keys its camera by handle.

## Materials and material state

Standard, PBR, Grid, shader and selected no-color views support reached properties. PBR layers include
clearcoat, sheen, iridescence, anisotropy and transmission. Created PBR materials take loaded base color,
ORM and normal textures. UV/lightmap/vertex-color opt-ins remain explicit;
lightmap binding precedes registration. Runtime texture-producer choices refuse.

Public factors retain array identity/double precision. Reads require one registered scene and represented
producer identity. Rebuilds and replacement after binding refuse; direct array writes do not bump UBO
versions. Public glTF albedo reads exclude material extensions, transforms and BasisU. Textured
environment rotation and wider metallic-reflectance fields remain limited.

Shader materials admit bounded 2D/array samplers, float/depth/comparison sampling, storage buffers and
selected uniform/system matrices; uniform writes take arrays, tuples and typed arrays. Wider descriptors,
pipeline state and live composition profiles refuse. External textures bind a video from a closed
zero-parameter producer before the engine starts and draw after the opaque bundle, as the pin's direct
bucket does; its missing-source, not-ready and unbound checks run at every frame's bind.
A source, template text or plugin `getCustomCode` a scene builds with a function is run at generation
over generation-known arguments; one reaching a host or engine API, a module `let`/`var`, `this`, the
clock, `Math.random`, the host locale or a runtime value refuses. Alpha to coverage reaches shader
materials; Standard and PBR targets refuse.

### Node materials

Closed NME graphs compose once per shape with distinct owners, thin-instance matrix streams and instance IDs. Texture slots
may be assigned before registration; scalar uniform inputs remain writable during rendering. Required missing bindings refuse.
Numeric input reads, vector writes, geometry-view uniform writes, reflective/map mutation and later
producer/topology changes refuse. Public input observations require one scene.

Geometry MRTs admit IRRADIANCE, WORLD_POSITION, LOCAL_POSITION, REFLECTIVITY, VIEW_DEPTH,
NORMALIZED_VIEW_DEPTH, SCREENSPACE_DEPTH, VIEW_NORMAL, WORLD_NORMAL, ALBEDO and LINEAR_VELOCITY.
Imported geometry needs static tightly packed FLOAT attributes; deformation, instancing and imported
transform mutation/cloning refuse. Missing normals and used strided attributes refuse.

### Material plugins

Explicit enablement supports custom code, Standard/PBR texture bridges and retained typed uniform
writers for the admitted scalar/vector/matrix surface. Source callbacks update their scratch storage
and vertex/fragment bindings. Dynamic shader signatures and broader plugin hooks refuse.

## Animation playback

GLTF supports LINEAR/STEP/CUBICSPLINE, TRS, skin/morph and admitted material/light/visibility pointers,
seeks, speed, masks and weighted/additive mixing. Property tracks support numeric leaves and linear/step
interpolation, weighted blending and replacement owners along data-object paths. Property easing
callbacks refuse.

Managers support fixed delta, onUpdate and autonomous RAF start/stop. First variable delta is zero;
autonomous updates notify after evaluation. Autonomous managers cannot share a program with a persistent
application RAF loop.

## Deformation and instancing

GPU skinning, storage morphs, VAT and thin-instance pools are supported. Direct morphs require one
pre-start attachment per mesh; conditional/replacement/thin-instance combinations refuse. Imported clones
share deformation resources. Standard skeletons require enablement. Thin-instance arrays retain aliases;
GPU culling has an [adaptation](fidelity.md#semantic-contract). Broader VAT bakes, VAT storage/time
setters and deformation queries, Standard-material VAT and animated/morphed imported GPU instances
remain limited.
Bone control supports dynamic name lookup, visibility and deferred world poses followed by explicit baking,
including skinned assets without animation clips.

## Sprites

Sprite2D, billboards, atlases, animation, offscreen/depth targets, custom fragments and Y-sort are bounded.
Sprite clear colors retain live numeric channels; accessor channels and owned colors with reference fields refuse.
Transparent billboards and meshes share the pinned distance/order sort; mixed exact depth/order ties
and mixed draws without a camera refuse because native lists lack the source's stable binding order.
Custom cutout billboard order, alpha-to-coverage changes to a cutout system a registered
multisampled scene draws, billboard, depth-hosted layer and text attachment after `disposeScene`,
handle-object APIs, coverage gamma and broader picking combinations refuse.
Broader atlas options remain limited.
UV-scroll attributes require float32 scalar/vector formats.

## Picking

`createPickingRay` retains the pin's reverse-Z unprojection, nullable result and mutable numeric tuples
with Float32 view-projection matrices; it requires no GPU picker.
Basic/detailed picks retain resource identity, pending poses and supported skeleton/morph projection.
Filter/ignore/discard, deformed thin instances, VAT IDs and wider result/contributor combinations refuse.
Detailed picks exclude active thin instances, billboards and splats. PickingInfo retains identity;
engine-dependent name/normal queries throw after engine destruction, while payload reads survive.

## Flow graphs

KHR_interactivity supports SceneReadyEvent, OnSelect, Sequence, Get/SetVariable, Get/SetProperty,
Add/Subtract/Multiply/Divide/Modulo, Abs, Floor, LessThan, Clamp, CombineVector2 and ExtractVector2.
Targets include node visibility/selectability and base-color texture scale/offset. Selection uses a
primary tap within five pixels and GPU picking. Other blocks, accessors, contexts, data cycles and
BABYLON_flow_graph JSON refuse. Runtime/graph lists support length, indexing and nullish fallback.

## Display gizmos

Utility-layer display, bounding boxes and supported rotation editing retain native input and owner
identity. Lazy construction is supported. Camera deferral accepts zero-argument predicates for
shouldHandlePointerDown, isExternalDragActive and isExternalPickPending; wider options refuse.
Bounding-box and scale gizmo drags have no native editing.

## Physics

Bullet provides bodies, primitive/convex/mesh shapes, forces, motion, aggregates, mass, masks,
collisions/triggers, raycasts, floating origin and character control. Constraints admit ball/socket,
distance, hinge, prismatic, lock, slider and six-DOF with inline two-sided limits, retained handles and
idempotent release. Springs/motors and inertia orientation refuse.

Thin-instance physics uses one native body per matrix, carrier transforms, shared property fanout and
instance-indexed ray/character/collision results. Advanced opt-in preserves scaled shapes and per-instance
mass; native instance handles support transform, velocity, impulse and activation controls. Collision
callbacks retain removed bodies through after-step dispatch.
Thin physics with floating origin, body-aware trigger callbacks and retained trigger disposers are unsupported.

Heightfields require square ground-mesh grids/static bodies. Zero/degenerate shapes refuse. Container
construction precedes attachment; direct child transforms and parent-relative placement admit finite nonzero scale. Mixed
child filters/triggers, differing leaf materials and triangle children refuse. Proximity/casts require inline query bags and
convex targets. Viewers need construction-known shape descriptors and a native toolchain; constraint
overlays and observable startup membership refuse.
See [physics substitutions](fidelity.md#physics-contract).

## Audio

Renderer-independent LabSound/SDL3 supports no-options AudioContext, lifecycle promises, reached nodes,
AudioParam scheduling, decoded buffers and channel copying. Aliases retain identity and stopped clocks.
Owned buffers can cross contexts. Invalid decode rejects; channel copies preserve overlap/untouched data.

Babylon async engines and sources retain main-bus routing and source ownership through disposal.
Scheduled sources/oscillators support zero-argument ended listeners with removal/capture/once and
onended replacement/null clearing, including promise callbacks. Context close cancels delivery.
Event payloads, AbortSignal, context options, statechange and broader bus/spatial APIs refuse.
Output selection/media streams/recording are unavailable; capability guards expose absence.
Closed-context graph operations, master ramps and nullable buffers remain limited.

## Shadows

PCF spot/directional, ESM directional and CSM support reached receivers/casters, layers, blur and
morph/skeleton caster bounds. receiveShadows needs a known supported value. PCF `mapSize` may be a
run-time integer; `normalBias` is evaluated and unused, as in the pin. Broader options and
thin-instance contracts refuse.
PCF spot refresh and CSM stabilization/bias remain limited.
Generator enable changes retain resources and update receiver darkness; CSM callbacks retain source order.

## Navigation

Recast/Detour supports solo and obstacle tile-cache builds, debug geometry, bounded queries, crowds,
agents and obstacles. Tiled builds without obstacles, tile-cache builds with off-mesh connections and
unimplemented query/disposal APIs refuse.

## Frame graph

Scene-owned and scene-less graphs support ordered targets/tasks, overrides, depth, MRTs, blits and MSAA
resolve. Default tasks retain source ordering; authored tasks use explicit lists. Task
reordering/removal/disposal and broader resource views/samplers remain limited.
RenderTarget handles retain identity in typed containers and mutable records; SceneContext values
can key those caches. Dynamically retrieved targets lack the attachment proofs required by TAA.

### Post-process passes

Leaf/composite passes support live uniforms, output identity and resize-relative targets.
Bloom weight reads/writes preserve the explicit updateUniforms boundary. TAA needs one scene, explicit
Standard color tasks, engine-format color, depth24plus-stencil8 and single-sample inputs.
Non-Standard draws, implicit/geometry/copy/shadow tasks, clustered lights, transmission, unprepared
renderer/UI contexts and post-registration topology changes refuse. Tracked camera writes retain versions;
untracked/reflective mutation, environment rotation and authored exposure/contrast changes refuse.

### Screen-space effects

Contact shadows and one-bounce GI use single-sample color/depth, temporal resolve and live supported settings.

### Fullscreen effects

EffectWrapper/EffectRenderer, UniformEffectWrapper and tasks admit bounded layouts/uniforms/textures.
Custom vertices, broader textures/descriptors and lifecycle/update APIs refuse.

### Image processing

Exposure/contrast are live outside TAA restrictions. Image-processing writes admit exposure, contrast,
toneMapping and toneMappingEnabled. Tone mapping participates in composition.

## Text

Static font parsing/shaping/packing runs at generation. Text data keeps the pin's runs, draw groups, style
palette and slot allocator: updateTextData reset/addRun/removeRun/replaceRun, updateDefaultTextData with or
without a color and per-run setFontWeightOffset are live. Live text lays out over the font's packaged
repertoire with static layout options; alignment is left/center/right. Runs are retained runs or copies
(`{ ...run, defaultColor, pixelsPerFontUnit }`); literal glyph lists, replacement storages and user glyph
storages (createGlyphStorage, extractGlyphCurves, createTextData) refuse.

Renderable text needs one text-only default scene (or default task graph, on an authored canvas) with a static
FreeCamera or supported ArcRotate controls.
Transforms/opacity are live; membership/order/depth precede attachment. Late attachment, reflective writes,
high-precision matrices and custom tasks refuse. Standalone layers support affine pixel placement,
opacity/gamma/visibility/order; data replacement and mixed renderer families refuse.

## Runtime scene mutation

Supported removal, material append and instance updates refresh plans/resources. Removing a mesh from its
last scene retires it, as the pin does: its geometry is reclaimed and later meshes reuse its record slot once
no mesh is parented under it and no shadow caster array, physics body or edit gizmo names it; re-adding or
cloning it refuses. Shadow
resources remain engine-owned.
