# Fidelity

The reference is the full browser page running the pinned Babylon Lite package.
This page lists source/native contracts and substitutions. [Features](features.md) owns admission.

## Semantic contract

| Artifact | Records |
| --- | --- |
| `manifest.json` | Reached graph, features, assets |
| `fidelity.json` | Adaptations and risks |
| `upstream/provenance.json` | Pinned modules/symbols |
| `upstream/feature-activation.json` | Reach sites and consumers |
| `upstream/renderer-fidelity.json` | Renderer formats/invariants |
| `upstream/shaders/composition.json` | Composed modules |
| Reflection, native WGSL, `.slots` | Actual shader interfaces/bindings |
| `upstream/shaders/shader-compiler.json` | Compiler/target identity |

| Boundary | Native behavior |
| --- | --- |
| Assets/producers | Generation-time loading, query folding and Chromium bakes |
| Workers/Window | AOT factories, typed cloning, realm loops, layout snapshots; 16 ms ResizeObserver polling |
| Data | Typed storage, checked access, bounded sparse/JSON representation |
| Strings/ICU | UTF-16 semantics over WTF-8 storage; host normalization/collation data |
| Error | Message retained; name is Error, cause dropped, stack undefined |
| Weak collections | Keys retained strongly |
| Object immutability | freeze/seal/preventExtensions return the original value without enforcing immutability |
| Storage/files | Host preferences, native URL tokens, synchronized picker completion |
| HTTP | WinHTTP/libcurl; system TLS, no cookie jar/CORS; buffered 32 MiB request/response cap |
| HTTP timeout | Windows: 5 s without progress; libcurl: 5 s connect/30 s request |
| HTTP teardown | Realm close cancels requests and joins transport threads |
| Environment | Native platform/language/CPU data; onLine=true, secure Window context; no client hints/device-memory estimate |
| Graphics guards | Async Window/worker realms expose existing host graphics identity; computation-only realms may lack it |
| Device recovery | Ordinary engine reconstruction retains CPU owners; shared worker/window recovery refuses |
| UI | RmlUi and retained Canvas2D; [compatibility limits](ui.md) |
| Camera touch | One finger uses pointer rotation; two-finger span changes feed the existing wheel zoom accumulator |
| Canvas touch | Primary contacts also drive mouse hooks; pinches on canvases with wheel listeners cancel dragging and emit wheel deltas |
| Skinning | Eight loaded influences reduced to four |
| Thin-instance culling | Admitted paths may use the pin's all-active fallback |
| Splats | Synchronous render-thread sorting |
| Physics/audio | Bullet/LabSound replace Havok/browser audio |

Live dataset readback and recovery hooks remain represented; write-only instrumentation can erase.
Native drawCallCount includes transport draws. Native loops own canvas extent refresh;
ResizeObserver installation/cancellation does not change that policy.

Uncaught ordinary callback exceptions reach the entry handler and exit with status 1. Realm tasks use
the installed handler or rethrow. Local catches remain active. This differs from browser event-loop continuation.

## Shader contract

PBR/Standard, nodes, plugins, sprites and effects use their pinned composers/builders. Composition
failure cannot select a substitute shader. Assertions around a transcription do not prove equivalence.

Shared vertex transport uses baked worlds, fixed PAL bindings, four influences and a 64-matrix palette.
Lifted skybox fog uses interpolated world position; HDR positionUVW is world position minus background
center. SDL single-sample image processing samples texel centers. Single-sample transmission replaces
MSAA averaging with mip-zero loads while retaining the source bilinear filter.

### Numeric width

JavaScript numbers remain double until source Float32 stores. Matrix order, layout and rounding are
part of the contract. Signed-zero byte differences can remain despite numeric equality. GLTF light
scalars/colors use float storage, clamping oversized ranges; spot-angle math remains double until its
uniform store. Imported cameras retain double fields and source Float32 matrices.

### The reference pose

Comparisons require matching source/module hashes, query, time/frame, canvas size and UI.
Deterministic capture clocks do not alter authored timing contracts.

### Depth

Main and shadow passes retain their own depth conventions. SDL may use depth-only formats in place
of depth24plus-stencil8. Stencil, winding, compare/write and readback need matching contracts.
Color-less sampled depth uses R32 copies on Dawn and SDL Metal to preserve red-only material reads.

### Shadows

Caster bounds, filters, pass state and sampled-depth meaning follow the pin. Shader equality alone
does not establish matching CSM bounds, instance coverage or sampler bindings.

### Background and environment

Cube orientation, mips, encoding, samplers and pass order follow the reached source. GLTF IBL retains
Float32 harmonics, RGBD decoding and the 256-square RGBA16F BRDF bake. Local probes execute source
validation/grid/UBO/copy planning; SDL stores large probe uniforms in a buffer.

### glTF material inputs

Pinned extension handlers select factors, textures, UVs, transforms and ORM merging. Feature callbacks
retain source order and fresh attachment identities. Deferred publication retains resource owners and
captured-material guards. Public texture identity is distinct from render fallback identity.
Metallic-roughness texture-transform animation targets are not resolved by the pin.

### Deformation and instancing

World, palette, vertex and instance-parent spaces must agree. GLTF mirroring is producer-specific.
Native Euler/quaternion storage differs from the pin's rotation proxy; mixed writes/sharing are bounded.

### Textures and compressed textures

Mips, encoding, orientation and samplers follow their source producer. invertY may use UV transforms.
Linux Canvas asset bakes use the reference capture's Chromium renderer settings.
SDL Metal generates mip levels with filtered blits to preserve linear-space sRGB filtering.
SDL Metal standalone sprite/text clears use the nearest linear 8-bit UNORM value to avoid fast-clear truncation.
Configured KTX2/Draco JS/WASM runs during packaging; resulting pixels/geometry enter native output.
Decoder bytes key caches and local decoder files participate in input tracking.

### Gaussian splats

Draw/sort/picking share cloud identity. Updates preserve old buffer aliases and refresh textures before
same-turn draws/picks. Borrowed buffers without an owner refuse.

### Animation and hierarchy

Pinned parsing/target resolution controls acceptance and source write order, masks and weighted/additive
mixing. Native adapters retain source Float32 stores and shared deformation resources. Material pointer
writers retain double arrays and captured owners; replacing a wrapper does not retarget an old writer.
CPU-only VAT seeks do not upload temporary poses. Property and glTF tracks remain separate.

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
| Solver | Bullet; identical Havok trajectories are not guaranteed |
| Constraints | Source hinge frames; Bullet six-axis rows for other admitted constraints |
| Radial correction | `0.4 * initialSignedViolation - predictedSignedViolation`, scaled for short steps |
| Contacts/rebound | Fitted substeps, speculative contacts, rebound, damping and rest stabilization |
| Deep overlap | Approximately 5% recovery per 60 Hz frame, capped at 1 m/s |
| Prestep | TELEPORT keeps zero kinematic velocity; ACTION uses immediate swept pose instead of Havok's deferred target |
| Timing | Variable frame delta capped at 100 ms; explicit fixed steps once per rendered frame, including initial zero engine delta |
| Triangle meshes | Static BVH; dynamic GImpact with approximate inertia |
| Heightfields | Static triangle BVH with measured source grid orientation/diagonal; rectangular grids refuse |
| Containers | Source relative transforms; Bullet convex children/inertia; mixed child material/filter/trigger state refuses |
| Floating origin | Separate worlds; no cross-region collisions |
| Queries | GJK/EPA and convex sweep; measured cylinder/box margins and closest-feature tie selection |
| Character contacts | Body sets can agree while contact order, instants and points differ |

Cylinder margin is `min(0.015, 0.1 * minimumHalfExtent)`; box margin is 0.015 capped by its smallest
half-extent. Shape storage outlives native shapes. Zero/degenerate shapes and unsupported ownership
combinations refuse. Per-step traces and rest/shape checks measure different properties.

## Text contract

Static shaping/atlas packing runs at generation. Live text uses HarfBuzz and pinned layout/packing over
the packaged repertoire. TextData retains identity; shared data owns group caches and captured styles.
Disposal releases GPU leases while CPU data follows source lifetime. Deferred registration publishes
only after successful construction. Arbitrary async builders refuse. Both backends use Slug WGSL.

## Audio contract

LabSound starts playback without a browser autoplay gate. Lifecycle promises settle after device
transitions. Decode reads on the realm thread, rejects invalid bytes and retains attached ArrayBuffers.
Output-device selection and browser recording streams are unavailable. Topology/scheduling agreement
does not establish PCM fidelity; closed-context graph operations remain bounded.

## What is measured: the full page

Parity includes canvas and reached UI. Canvas-only thresholds are additional gates, not replacements.
[Status](status.md) owns values; [debugging](debugging.md) owns commands and observation limits.

## Parity reports

Reports contain backend/build identity, full/foreground MAD, byte ratios, bias and spatial attribution.
They locate residuals; they do not establish their cause or an acceptable precision floor.
