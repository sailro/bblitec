# Fidelity

The reference is the full browser page running the pinned Babylon Lite package.
This page lists source/native contracts and substitutions. [Features](features.md) owns admission.

## Semantic contract

Artifact paths are relative to `generated/<id>/`.

| Artifact | Records |
| --- | --- |
| `manifest.json` | Reached graph, features (scene reach and asset joins), assets; repository-relative source paths |
| `fidelity.json` | Adaptations and risks |
| `upstream/provenance.json` | Pinned modules/symbols |
| `upstream/feature-activation.json` | Reach sites, asset joins, activation reasons and consumers |
| `upstream/renderer-fidelity.json` | Renderer formats/invariants |
| `upstream/shaders/composition.json` | Composed modules |
| Reflection, native WGSL, `.slots` | Actual shader interfaces/bindings |
| `upstream/shaders/shader-compiler.json` | Compiler/target identity |

| Boundary | Native behavior |
| --- | --- |
| Assets/producers | Generation-time loading, query folding and Chromium bakes |
| Workers/Window | AOT factories, typed cloning, realm loops, layout snapshots; 16 ms ResizeObserver polling |
| Data | Typed storage, checked access, bounded sparse/JSON representation. An assertion to the one record type of a union holding other values (`(x as { name: string }).name`) reads that member; a value holding another member throws there, where JavaScript reads `undefined`. A dynamic (`unknown`) value asserted to a class's type, or to a brand stored as one, is the instance it holds; any other value throws TypeError at the assertion, where JavaScript throws once a private member is read |
| Typed records | Required and optional undefined-only fields retain own-key presence through storage and cloning; JSON omits them. Other optional fields, and conditional spread keys, holding undefined are absent. Keys enumerate in declaration order, an object literal's in its creation order (spreads included). Record types a record is stored as share one layout (the union of their fields, a record union's arms included, each type holding the fields it does not declare absent, `readonly` modifiers aside; a record union whose own layout holds every field keeps it) and one key order (the widest type's, a declared type's on a tie); a record is a copy instead, nested objects shared, only where no write, identity use or enumeration in the program can reach it, or for a synchronous call whose callee only reads it and whose run (callbacks, accessors and field initializers included) writes none of its fields (an array of records too, while the call changes no array that may be the original) |
| Strings/ICU | UTF-16 semantics over WTF-8 storage; host normalization/collation data. Locale case conversion validates and selects only the first requested tag, matching Chromium. Intl formatters and Date locale strings use the host ICU's CLDR; date patterns spell a narrow no-break space as a space, as V8 does |
| Shared memory | A SharedArrayBuffer is one realm's memory: no other agent shares it, Atomics are plain accesses, and cloning one (`structuredClone` included) throws DataCloneError |
| Error | Identity, name, message and represented Error causes retained; AggregateError retains ordered errors. Cause/errors property reads are unadmitted; stack is undefined |
| Weak collections and WeakRef | Erased record/callback/DOM WeakMap keys use weak identity; other keys and WeakRef targets are retained strongly |
| Retired meshes | A mesh that left its last scene keeps its record, with its last pose and bounds, while a mesh is parented under it or a shadow caster array, a physics body or an edit gizmo names it, and then gives its slot to a later mesh; touching it through a kept program reference afterwards throws "Native handle refers to a retired record", where JavaScript reaches the detached object |
| Object immutability | freeze/seal/preventExtensions return the original value without enforcing immutability |
| Storage/files | Host preferences, native URL tokens, synchronized picker completion; FileReader loads inside readAsText |
| Promises outside a realm | An await reads a constructed promise's settlement in place; one still pending ends the awaiting activation without its catch or finally blocks, resuming after the statement that discarded its promise; a later settlement throws, and an entry that awaits one exits with an error |
| File publication | Direct destinations use atomic replacement; iOS stages a complete private snapshot and UIKit/file providers own export publication |
| HTTP | WinHTTP/libcurl; system TLS, no cookie jar/CORS or HTTP cache; buffered 32 MiB request/response cap |
| HTTP timeout | Windows: 5 s without progress; libcurl: 5 s connect/30 s request |
| HTTP teardown | Realm close cancels requests and joins transport threads |
| Inferred packaged URLs | 256 candidates; fixed non-root local directory; uncertain mutations, dynamic queries, traversal and encoded separators refuse |
| Environment | Native platform/language/CPU data; onLine=true, secure Window context; no client hints/device-memory estimate; `performance.timeOrigin` is the epoch time of `performance.now()`'s zero, one per process |
| Graphics guards | Async Window/worker realms expose existing host graphics identity; computation-only realms may lack it |
| GPU adapter information | Requests settle on the requesting realm and describe the already selected host device before engine creation. Dawn copies adapter info; SDL copies description and patched device/vendor IDs, with an empty architecture. Metal exposes Apple vendor identity only for the Apple GPU family; unavailable IDs remain blank. No additional device selection |
| Compute limits | Dawn queries device limits; SDL_GPU has no numeric shader-resource queries and uses 256-byte uniform offsets |
| Engine disposal | A Window engine invalidates its run and releases its GPU lease; the shared native transport remains available to other engines |
| GPU task timing | Pinned frame-graph task snapshots use asynchronous hardware timestamp readback; [backend capability](backends.md#backend-comparison) determines availability. Dawn attaches a task's timestamps to its passes as the source does; SDL_GPU writes them outside passes, at each source pass's boundaries. A pass this port omits, such as thin-instance culling's, is not timed |
| UI | RmlUi and retained Canvas2D; [compatibility limits](ui.md) |
| Pointer offsets | offsetX/offsetY read clientX/clientY: exact for the full-window primary canvas, not target-relative for auxiliary canvases or UI elements |
| Camera touch | One finger uses pointer rotation; two-finger span changes feed the existing wheel zoom accumulator |
| Camera input | Pinned handlers take SDL relative motion as client-pixel deltas and SDL keyboard state as the held KeyboardEvent.code set |
| Canvas touch | Primary contacts also drive mouse hooks; pinches on canvases with wheel listeners cancel dragging and emit wheel deltas |
| Skinning | Eight loaded influences reduced to four, for drawing and skeleton shadow bounds |
| Video external textures | A producer's one video is its frame as Chromium's WebGPU import yields it, baked as RGBA8 and sampled as a 2D texture; a frame or state that moves after the producer returns refuses. Its one method sets the readyState it was measured to leave, and refuses when its body reaches beyond the producer's own objects |
| Thin-instance culling | Admitted paths may use the pin's all-active fallback |
| Splats | Synchronous render-thread sorting; draw/sort/picking share cloud identity |

Drawn atlas pixels depend on the producing browser's Canvas2D rasterizer. Host Chromium is the default;
an explicit [Android atlas bundle](development.md#android) uses the target browser's authored factory output.
Its pin, source closure, producer, device/browser/GPU identity and PNG digest accompany each manifest asset.
Missing or stale bundle entries refuse; other bake families retain their host behavior.

Live dataset readback and recovery hooks remain represented. Canvas metadata helpers erase only
when their complete effects are confined to unobserved metadata and browser instrumentation.
Native drawCallCount includes transport draws.

Uncaught ordinary callback exceptions reach the entry handler and exit with status 1. Realm tasks use
the installed handler or rethrow. Local catches remain active. This differs from browser event-loop continuation.

## Shader contract

PBR/Standard, nodes, plugins, sprites and effects use their pinned composers/builders. Composition
failure cannot select a substitute shader. Assertions around a transcription do not prove equivalence.

Vertex buffers carry each geometry's source lanes, a glTF primitive without NORMAL carrying the smooth
normals the pin generates for it; every family's mesh block carries `mesh.worldMatrix` (eye-relative
under floating origin), with fixed PAL bindings and a 64-matrix palette. A Standard geometry task keeps
each renderable's previous world and writes velocity disabled on its first frame, as the pin does; a
skinned Standard mesh in a LINEAR_VELOCITY task refuses, having no previous bone texture.
SDL single-sample image processing samples texel centers. Single-sample transmission replaces
MSAA averaging with mip-zero loads while retaining the source bilinear filter.
Linux Vulkan surfaces and canvas-emulation resolve targets request storage-capable allocations when
image-format and surface capabilities permit, matching Chromium's canvas MSAA rounding. SDL's private
allocation opt-in preserves its public storage-binding restrictions and authored render-target usage.

### Numeric width

JavaScript numbers remain double until source Float32 stores; a `for` counter that starts at an integer,
steps by an integer and is written and captured nowhere else counts in 64 bits and converts at each read.
Matrix order, layout and rounding are
part of the contract. Signed-zero byte differences can remain despite numeric equality. GLTF light
scalars/colors use float storage, clamping oversized ranges; spot-angle math remains double until its
uniform store. Imported cameras retain double fields and source Float32 matrices. A loaded glTF node's
rotation, scaling and raw `matrix` are stored at float width where the pin holds JavaScript numbers.

### The reference pose

Comparisons require matching source/module hashes, query, time/frame, canvas size and UI.
Deterministic capture clocks do not alter authored timing contracts.

### Depth

Main and shadow passes retain their own depth conventions. SDL may use depth-only formats in place
of depth24plus-stencil8. Stencil, winding, compare/write and readback need matching contracts.

### Shadows

Caster bounds, filters, pass state and sampled-depth meaning follow the pin. Shader equality alone
does not establish matching CSM bounds, instance coverage or sampler bindings.

### Background and environment

Background arms (ground, DDS, .env, solid and image skyboxes) run their pinned factories at generation:
the composed modules deploy whole, and the vertex layouts, rasterizer/depth/blend state, group-1
layout and buffer bindings are what the factory built and drew. Geometry and mesh blocks are the
pinned builders and writers, lowered and run over the scene's double-width sizes and root; the
scene block is the pass's own.
Cube orientation, mips, encoding, samplers and pass order follow the reached source. GLTF IBL retains
Float32 harmonics, RGBD decoding and the 256-square RGBA16F BRDF bake. Local probes execute source
validation/grid/UBO/copy planning. RGBD faces and PNG BRDF LUTs decode through the pinned kernel's
arithmetic on the CPU; its `rgba16float` store rounds toward zero, as the reference device's storage
write does (WGSL leaves the direction to the implementation).

### glTF material inputs

Pinned extension handlers select factors, textures, UVs, transforms and ORM merging. Feature callbacks
retain source order and fresh attachment identities. Deferred publication retains resource owners and
captured-material guards. Public texture identity is distinct from render fallback identity.
Metallic-roughness texture-transform animation targets are not resolved by the pin.

### Deformation and instancing

Vertices, palettes and instance matrices are the pin's; the vertex stage composes them under the mesh
world. GLTF mirroring is producer-specific.
Native Euler/quaternion storage differs from the pin's rotation proxy; mixed writes/sharing are bounded.

### Textures and compressed textures

Mips, encoding, orientation and samplers follow their source producer. invertY may use UV transforms.
Configured KTX2/Draco JS/WASM runs during packaging; resulting pixels/geometry enter native output.
KTX2 transcoding restricts the pinned loader to native BC/ASTC families; a browser with ETC2 can select
different compressed bytes.
Decoder bytes key caches and local decoder files participate in input tracking.

### Animation and hierarchy

Pinned parsing/target resolution controls acceptance and source write order, masks and weighted/additive
mixing. Native adapters retain source Float32 stores and shared deformation resources. Material pointer
writers retain double arrays and captured owners; replacing a wrapper does not retarget an old writer.
CPU-only VAT seeks do not upload temporary poses.

### Frame graph and post-process passes

Tasks own formats, samples, cameras and load/store state. Partial copies preserve prior content.
TAA retains source cache keys, scratch, successful uploads, factor, hook order and failure state.
Late uniform writes affect the same submission; [backends](backends.md#temporal-post-process-transport)
own transport. Camera/object versions follow source writes, including equal-value writes.
Native texture recreation can reset history that the browser retained.

## Picking contract

Picking uses originating resource identities and pinned projection. Readback follows producing draws.
Visible/pick geometry spaces must agree. Missing primitive-index capability throws natively where
browser feature probing can expose absence.

## Flow-graph contract

Pinned block bodies determine arithmetic, dispatch and pointer writes. Native attachment runs inside
addToScene; onStart runs at the first before-render tick. Native selection readback is synchronous and
can dispatch one frame earlier than the browser promise.

## Physics contract

| Boundary | Native substitution |
| --- | --- |
| Debug geometry | Node Havok WASM bakes complete shape descriptors; no poses/trajectories/reference pixels |
| Solver | Bullet with parallel collision detection and constraint batches; identical Havok trajectories and parallel contact order are not guaranteed |
| Constraints | Source hinge frames; Bullet six-axis rows for other admitted constraints |
| Radial correction | `0.4 * initialSignedViolation - predictedSignedViolation`, scaled for short steps |
| Contacts/rebound | Fitted substeps, speculative contacts, rebound, damping and rest stabilization |
| Deep overlap | Approximately 5% recovery per 60 Hz frame, capped at 1 m/s |
| Prestep | TELEPORT keeps zero kinematic velocity; ACTION uses immediate swept pose instead of Havok's deferred target |
| Timing | Variable frame delta capped at 100 ms; explicit fixed steps once per rendered frame, including initial zero engine delta |
| Triangle meshes | Static BVH; dynamic GImpact with approximate inertia |
| Heightfields | Static triangle BVH with measured source grid orientation/diagonal |
| Containers | Source relative transforms; Bullet convex children/inertia |
| Shape materials | Havok defaults and combine priority; container material writes leave leaf materials unchanged, as the pin ignores Havok's unsupported-operation result |
| Floating origin | Separate worlds; no cross-region collisions |
| Queries | GJK/EPA and convex sweep; measured cylinder/box margins and closest-feature tie selection |
| Character contacts | Body sets can agree while contact order, instants and points differ |

Query cylinder margin is `min(0.015, 0.1 * minimumHalfExtent)`; query box margin is 0.015 capped by its smallest
half-extent. Shape storage outlives native shapes. Per-step traces and rest/shape checks measure
different properties.

Positive box extents retain their authored size and center; only zero-thickness axes receive the
ground-plane adaptation. Convex hull support planes are not expanded by Bullet's default margin.
One native controller owns Bullet's scheduler across application realms. Workers run no application
callbacks; contact initialization uses disjoint solver batches, reductions retain chunk order and
contact/friction rows use Bullet's interleaved order in parallel worlds. Split-impulse solving keeps
its convergence limit. Windows clang-cl and MSVC use the same Bullet
SIMD solver-record layout.
Constraints between two immovable bodies retain ownership and collision filtering without solver
rows; a side becoming dynamic activates their rows.

## Text contract

Live text lays out through the pin's lowered `layoutText` over the packaged repertoire, whose outlines are
extracted and packed at generation. text-shaper, which the layout shapes with, is HarfBuzz: font scale,
nominal glyph lookup and the shaping pass (`shapeInto`) are HarfBuzz's. TextData is the pin's record graph (runs, draw groups, style palette, slot
allocator) updated by the pin's lowered bodies; it retains identity, and shared data owns group caches
and captured styles. A text renderable is the pin's own record: its observable transforms, Euler proxy,
world-matrix state, binding and scene attachment are the pin's classes and closures. Buffer, texture,
bind-group and bundle creation, writes and draws are the pin's own calls on a WebGPU-shaped device;
SDL_GPU keeps uniform buffers as CPU copies pushed at each draw. Disposal destroys GPU resources while CPU
data follows source lifetime. Deferred registration publishes only after successful construction; the
native scene queue calls a text builder without the engine and scene arguments, which the pin's builder
does not read. Arbitrary async builders refuse. Both backends use Slug WGSL.

## Audio contract

LabSound starts playback without a browser autoplay gate. Lifecycle promises settle after device
transitions; a realm's `createAudioEngineAsync` opens its playback device in a native job. SDL's
main thread initializes SDL's audio subsystem once for the run, never a worker, and devices never quit
it: a Window host does so as its application realm starts, whose device opens wait for it; otherwise
the first context created on that thread does, and a realm elsewhere refuses before then. Decode
copies the encoded bytes on the realm thread, retaining attached ArrayBuffers, and decodes them in a
native job. Topology/scheduling agreement does not establish PCM fidelity.

## What is measured: the full page

Parity includes canvas and reached UI; canvas-only thresholds are additional gates, not replacements.
Reports contain backend/build identity, full/foreground MAD, byte ratios, bias and spatial attribution;
they locate residuals but establish neither their cause nor an acceptable precision floor.
[Status](status.md) owns values; [debugging](debugging.md) owns commands and observation limits.
