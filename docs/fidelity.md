# Fidelity

Where native behavior deviates from the pinned Babylon Lite browser page. Pinned source is the reference;
anything not listed here must match it.

## Semantic contract

| Boundary | Native behavior |
| --- | --- |
| Workers/Window | AOT factories, typed cloning; ResizeObserver polls every 16 ms |
| Union assertions | `(x as A).f` on a union holding another member throws (JS reads `undefined`); `unknown` asserted to a class or brand throws TypeError at the assertion |
| Records | Record types one value is stored as share one layout and key order; copies only where unobservable |
| Strings/ICU | UTF-16 over WTF-8; host ICU/CLDR; locale casing uses the first tag; date patterns spell narrow NBSP as space |
| Math | `Math.random` is deterministic |
| SharedArrayBuffer | One agent: Atomics are plain accesses; cloning throws DataCloneError |
| Error | `stack` is undefined; `cause`/`errors` reads are unadmitted |
| Weak collections | Erased record/callback/DOM keys are weak; other keys and WeakRef targets are strong |
| Retired meshes | Kept while a child, shadow caster array, physics body or gizmo names them; afterwards access throws "Native handle refers to a retired record" |
| Immutability | `freeze`/`seal`/`preventExtensions` are not enforced |
| Promises outside a realm | `await` reads the settlement in place; a pending one ends the activation without catch/finally; a later settlement throws |
| Uncaught callback errors | Reach the entry handler and exit with status 1 (browsers continue) |
| Files | Atomic replacement; iOS publishes through UIKit/file providers; FileReader loads inside `readAsText` |
| HTTP | WinHTTP/libcurl, system TLS, no cookies/CORS/HTTP cache; WinHTTP pool 6 per server; 8 MiB queued per transfer; 32 MiB bound on bodies and text/json/arrayBuffer (not streams) |
| HTTP timeout | Windows: 5 s without progress; libcurl: 5 s connect, then under 1 byte/s for 5 s. Realm close and abort cancel transfers |
| Packaged URL inference | 256 candidates; uncertain mutations, dynamic queries, traversal and encoded separators refuse |
| Environment | `onLine=true`, secure context, no client hints or deviceMemory; one `performance.timeOrigin` per process |
| GPU adapter info | Describes the selected device; SDL leaves architecture empty; Metal reports Apple vendor only for Apple GPUs |
| Compute limits | Dawn queries device limits; SDL_GPU uses 256-byte uniform offsets |
| GPU task timing | Dawn times on passes; SDL_GPU at source pass boundaries; omitted passes are untimed |
| Listener signals | Abort removes only the listener its add created (DOM); Chromium can also remove a same-key re-add until GC |
| Pointer offsets | `offsetX/Y` equal `clientX/Y`: exact only for the full-window primary canvas |
| Touch | One finger rotates; two-finger span feeds wheel zoom; the primary contact drives mouse hooks |
| Pointer capture | Window applications: a capture a pointermove listener sets targets from a later motion packet; pointer lock does not make `setPointerCapture` throw |
| Skinning | Eight influences reduced to four |
| Video textures | One frame from Chromium's WebGPU import, baked RGBA8, sampled as 2D |
| Thin-instance culling | May use the pin's all-active fallback |
| Splats | Synchronous render-thread sorting |
| Canvas atlases | Pixels come from the producing browser's Canvas2D (host Chromium, or an [Android atlas bundle](development.md#android)) |
| Draw counts | `drawCallCount` includes transport draws |

## Numeric width

- Numbers stay double until source Float32 stores. An integer `for` counter written nowhere else counts in 64 bits.
- Matrix order, layout and rounding are part of the contract; signed-zero byte differences can remain.
- glTF light scalars/colors are float (oversized ranges clamp); spot-angle math stays double until the uniform store.
- Imported cameras keep double fields and Float32 matrices; glTF node rotation, scaling and `matrix` store as float.

## Rendering

- Shaders come from pinned composers; a composition failure never selects a substitute.
- glTF primitives without NORMAL use the pin's generated smooth normals. Mesh blocks carry `mesh.worldMatrix`
  (eye-relative under floating origin); palettes hold 64 matrices.
- A skinned Standard mesh in a LINEAR_VELOCITY task refuses.
- SDL single-sample image processing samples texel centers; single-sample transmission uses mip-zero loads.
- Linux Vulkan surfaces and canvas-emulation resolves request storage-capable allocations to match Chromium's MSAA rounding.
- SDL may use depth-only formats instead of depth24plus-stencil8.
- Background arms run their pinned factories at generation. RGBD faces and PNG BRDF LUTs decode on the CPU; the
  `rgba16float` store rounds toward zero.
- Draco/meshopt decoding and KTX2 transcoding run at packaging; KTX2 transcodes only to BC/ASTC (an ETC2 browser can
  pick other bytes).
- Native Euler/quaternion storage differs from the pin's rotation proxy; mixed writes are bounded.
- Replacing a material wrapper does not retarget an old pointer writer. CPU-only VAT seeks upload nothing.
- Native texture recreation can reset TAA history the browser kept.
- Picking throws natively when primitive-index capability is missing.
- Flow-graph selection readback is synchronous and can dispatch one frame earlier than the browser.

## Physics contract

Bullet substitutes for Havok; physics residuals include solver differences.

| Boundary | Native behavior |
| --- | --- |
| Debug geometry | Node Havok WASM bakes shape descriptors at generation |
| Solver | Parallel collision detection and constraint batches; trajectories and contact order differ from Havok |
| Constraints | Source hinge frames; Bullet six-axis rows otherwise; rows between two immovable bodies stay inactive |
| Radial correction | `0.4 * initialSignedViolation - predictedSignedViolation`, scaled for short steps |
| Contacts | Fitted substeps, speculative contacts, rebound, damping, rest stabilization |
| Deep overlap | About 5% recovery per 60 Hz frame, capped at 1 m/s |
| Prestep | TELEPORT keeps zero kinematic velocity; ACTION uses the immediate swept pose |
| Timing | Frame delta capped at 100 ms; fixed steps once per rendered frame; callback milliseconds are float |
| Meshes | Static BVH; dynamic GImpact with approximate inertia; heightfields are static triangle BVHs |
| Containers | Bullet convex children; container material writes leave leaf materials unchanged |
| Boxes/hulls | Zero-thickness axes get the ground-plane adaptation; hulls get no Bullet margin |
| Floating origin | Separate worlds; no cross-region collisions |
| Queries | GJK/EPA, convex sweep; cylinder margin `min(0.015, 0.1 * minHalfExtent)`, box margin 0.015 capped by the smallest half-extent |
| Threads | One controller owns Bullet's scheduler; workers run no callbacks; clang-cl and MSVC share the SIMD solver layout |

## Text contract

Live text uses the pin's lowered `layoutText` and record graph. text-shaper is HarfBuzz
(`text_layout.hpp`). SDL_GPU keeps text uniforms as CPU copies pushed per draw. Both backends use Slug WGSL.
Arbitrary async text builders refuse.

## Audio contract

- LabSound plays without an autoplay gate.
- SDL audio initializes once on the main thread (the Window host at realm start); devices never quit it.
- Topology agreement does not establish PCM fidelity.
