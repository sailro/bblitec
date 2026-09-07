# Fidelity strategy

The reference is the original scene running against pinned Babylon Lite.
Compiler semantics, GPU behavior and substituted libraries are separate sources
of differences. A low image error or agreement between the native backends
does not prove the absence of shared defects.

## Semantic contract

| Generated artifact | Purpose |
| --- | --- |
| `manifest.json` | Reached features, source graph, assets and adaptations |
| `fidelity.json` | Intentional source/native semantic differences, risk and validation |
| `upstream/provenance.json` | Pinned modules and symbols |
| `upstream/feature-activation.json` | Activation reasons, source origins and consumers |
| `upstream/renderer-fidelity.json` | Renderer invariants, formats and shader contracts |
| `upstream/shaders/composition.json` | Composed modules deployed |
| `upstream/shaders/shader-material-reflection.json` | Custom shader interfaces and layout |
| `*.native.wgsl`, `*.slots`, Tint reflection | Deployed shader text and compiled binding evidence |
| `upstream/shaders/shader-compiler.json` | Offline target and compiler identity |

Preserve original corpus/golden sources and hashes. Resolve uncertainty from
pinned loaders, factories and composers before interpreting the file format or
image. Record an intentional divergence; do not label an unexplained residual
an adaptation or precision floor.

The supported API surface is in [features](features.md). Important adaptation
families include:

| Boundary | Difference |
| --- | --- |
| AOT/browser | Assets materialize during compilation; ordinary AOT asset awaits settle immediately; worker builds use owner-loop promises and continuations; reference queries fold; bounded browser instrumentation erases |
| Workers/Window | AOT module factories, typed clone codecs and native task loops replace browser execution; retained layout is snapshotted, ResizeObserver delivery polls at 16 ms, and independent GPU canvases share a host device |
| Executed producers | Chromium produces atlas pixels, fragile computed buffers, prefiltered assets and frozen particles; output can depend on the compiling browser |
| Frame time | The fixed-step clock, the sprite renderer's per-frame hook and the sprite-layer and billboard effect clocks carry the browser's double delta; scene and frame-graph callbacks receive the engine API's float |
| Plain-data model | Native storage/aliasing, checked access and sparse initialization differ from unrestricted JavaScript |
| Skinning | A loaded eight-influence skin retains four influences |
| GPU culling | Reached thin-instance culling can use the pin's all-active-instance fallback without its compute/indirect optimization |
| JSON | Reached typed codecs and bounded dynamic parsing replace general JavaScript serialization; cyclic stringify is rejected |
| Storage | localStorage uses the host preference directory rather than browser-origin storage |
| Files | Native object-URL tokens and synchronized picker completion replace browser asynchronous dialogs |
| UI | RmlUi/FreeType and retained Canvas2D replace browser layout/rasterization |
| Physics/audio | Bullet and LabSound replace Havok and the browser audio engine |

A pinned computation executed unchanged over the same inputs is not
automatically a semantic divergence. Conversely, shape assertions around a
handwritten translation do not make it an AST-derived implementation.

Provider-backed node particles execute source callbacks and supported pinned
evaluators natively, including authored pre-frame steps. Provider validation,
matrix copying, setup and frame updates are lowered from the pin; billboard
registration order and synchronization are asserted adapters over the existing
billboard storage. Native/pinned fixtures compare all local particle columns
and random draw counts through 180 frames, including deaths and swap-removal.
Frozen particle bakes retain their existing Chromium execution path. Mixed
native/frozen sets refuse because splitting their shared random stream between
generation and runtime would change its ordering.

Autonomous property-animation managers lower clock arithmetic and lifecycle
state writes from the pinned manager. The PAL supplies ordered, cancellable
frame requests; notification captures retain their source-owned data. The
native presentation loop also hosts a reached primary Canvas2D surface when
the source creates no engine. Persistent application RAF loops currently refuse
composition with autonomous managers because their optimized registration does
not retain each source requeue. Canvas2D rectangle coverage uses analytic
backing-pixel coverage through the existing retained UI mesh, so browser raster
quantization remains an explicit UI adaptation. Semantic fixtures compare the
pinned and native manager lifecycle; image gates validate both native backends.

## Shader contract

### Where a shader comes from

| Family | Origin |
| --- | --- |
| PBR and Standard colour/geometry | Pinned composer and extension registry |
| Node materials | Pinned graph compiler and block emitters |
| Material/splat plugins | Scene declarations folded, then pin's own splicer/bridges |
| Sprites, splats, effects, post-processes | Pinned literals/builders/composers, with declared specialization |
| Specialized shared vertex | Pinned PBR template and shared deformation/instance fragments, projected through typed shader IR |

Do not introduce additional shader transcriptions or use a fallback shader when
composition fails. Bindings, vertex interfaces and uniform layouts must match
the actual deployed module. Detailed transport is owned by
[backends](backends.md).

The shared diagnostic/depth/background vertex stage keeps its pre-baked world
and fixed PAL binding layout. When deformation is enabled, it uses four bone
influences in a 64-matrix uniform palette and either two-target attributes or
the pinned storage-morph payload. Its attribute path retains tangent deltas and
a pre-morph bitangent. `shared-material-vertex-transport` records these
adaptations; ordinary colour materials retain their own pinned composers.

### Numeric width

Preserve JavaScript-number precision through an expression and narrow where
upstream stores into a float32/half destination. Camera scalars, local TRS
calculations and procedural builder expressions are sensitive to early
rounding. Static tuple/record values must be rendered at each sink's requested
width; runtime values still need a more explicit width representation.

Use the runtime's JavaScript `round_js` rule for `Math.round`.
`hypot_js` uses the recorded sum-of-squares approximation. RGBD decode
results are half-float texture data because that is the pin's storage format.
High-precision camera/node support does not imply every native matrix is F64.

Numeric ArrayBuffer views retain shared byte storage and copy each scalar with
`memcpy`, avoiding typed references into a byte allocation. Stores apply the
existing JavaScript integer conversions or float narrowing; compound writes
retain the evaluated owner and prior value before the right operand runs.
Prefix updates return the numeric result before destination narrowing.
Owned vector storage remains available to existing native consumers, while
numeric buffer views explicitly refuse contiguous typed access and methods
that have not been adapted. Native/JavaScript fixtures observe overlapping
views, escaped backing storage, replacement, argument order and ToIndex bounds.

The CPU vertex bake projects the pin's WGSL normal/tangent normalization through
typed shader IR with float32 intermediates and division. It retains its strict
length-above-`1e-6` gate (zero otherwise) after the baked world transform.
`guarded-cpu-vertex-normalization` records this adaptation; substituting the
JavaScript tuple/object normalizers would change precision, epsilon and the
degenerate result.

### The reference pose

Reference query, frame and seek time belong in the scene registry and are used
by generation and both capture paths. Deterministic RAF, timer and CSS-animation
time must agree. A frozen scene keeps presenting its final state while capture
is pending. Diagnose a timer/frame mismatch from event traces before changing
the scene or its threshold.

Independent-engine captures declare their count and zero-based frame in the
registry. The browser adapter delegates to the pinned `startEngine`, supplies
60 Hz frame timestamps and cancels the next draw after the requested frame.
It waits for GPU completion and subsequent rendering opportunities so a
transferred canvas's final image reaches its placeholder. Native renderers
retain their final GPU images at the same per-engine frame; the Window captures
only when every canvas has reached it. This pins render deltas and frame counts,
not arbitrary inter-realm message/timer schedules. Full-page references use the
unchanged upstream HTML, with only the bundled module URL redirected to the
normal TypeScript transpile. Capture adapter and host-page hashes accompany
the application's source and golden hashes in the corpus manifest.

Canvas-only captures of these pages retain all canvas rectangles at their
original positions over black, excluding page chrome. Per-draw instrumented
capture does not yet aggregate independent realms and refuses explicitly.

### Depth

The main scene follows the pinned reverse-Z projection, clear and compare.
Shadow targets are the explicit standard-Z exception. Read compare, clear and
bias state from the pin; neither backend should hardcode a competing convention.
An unsupported material-specific compare must refuse.

### Shadows

A caster uses the biased light matrix; the receiver samples through the
unbiased one. Shadow maps/receiver bindings follow each generator's actual
type, light index and reflected byte layout. CSM uses one depth array with
per-layer caster passes, preserving one resource owner.

Material receive state is a composition choice; imported/runtime mesh
collections retain supported alternatives and select through live records.
The source setter still accepts a bounded static value. Node graphs have their
own reflected receiver and no-colour/ESM caster paths.

Morph-bound providers must affect both fitted bounds and the refresh version.
A scene that reaches a provider may still fail to observe its effect, so use
a focused changed-bound control when validating that mechanism.

CSM fitting, caster bias and receiver packing are lowered from the pinned ASTs.
Number-array values retain JavaScript-number precision; Float32Array stores
narrow at their original boundary. Native cache/resource carriers remain
structural adapters. Unsupported thin-instance caster cases must not be
presented as precision differences; broader carrier and gating work remains
in [TODO](../TODO.md).

### Background and environment

DDS, environment-cube, solid and image skyboxes have different pinned shader,
culling, rotation and noise arms. Dither depends on interpolated world position;
moving a transform from a shader uniform into CPU-baked vertices can change it
without visibly moving the geometry.

Environment sizing resolves against the live scene bounds and camera options.
Preserve object-local bounds and world transforms through the loader; a tight
box around already-baked vertices is not generally the same input.

HDR preserves mip zero and runs the pinned GGX prefilter for higher mips.
DDS preserves its stored chain and projects harmonics from the pin.
RGBD environment uploads retain their required orientation; BRDF LUT uploads
have their separate orientation. Do not infer one from the other.

### glTF material inputs

Loader metadata chooses material shape, textures and activation. In particular:

- Extension presence, explicit factory registration and enabled/factor state
  are different questions.
- Texture-less factors can be baked into quantized texels; animated pointer
  targets can require white fallback texels plus live uniform fields instead.
- Each slot owns its encoding, sampler, UV set and transform. A family-wide
  default cannot replace texture-object state.
- glTF clearcoat and source-created clearcoat differ in the pin's F0-remap arm.
- IOR/reflectance, occlusion ownership and animation-pointer registration must
  come from the loader's actual builder rules.

Use the pinned material-input mapper and composer coverage checks instead of
recreating those predicates in multiple loaders/variant passes.
Anisotropy and diffuse-transmission option objects are packaged from that
mapper's ordered extension merge. Native hydration owns texture resources and
live transforms; it does not repeat the extension equations or merge policy.
Occlusion pointers use the loader's independent occlusion transform when one
exists, including a split UV0 transform that shares the ORM image. The pin
does not resolve metallic-roughness texture pointers, so those transforms
remain at their load-time values.

### Deformation and instancing

Vertex packing, mesh world, skin palette, local-position and instance-parent
matrices form one contract. The glTF family mirrors coordinates; Standard
does not inherit that convention. A changed skin/picking result must be
compared at the buffer/palette level before blaming the fragment shader.

The native Euler and quaternion lanes are not the pin's single proxy-backed
rotation representation. Mixed writes and wider clone/morph sharing require
additional lowering. Four-influence skinning is an explicit adaptation.

### Textures and compressed textures

Mips, sRGB decode, factor texels, sampler modes and upload orientation follow
the pinned texture/loader path. KTX/Basis data uploads its own block payload and
mip chain; it must not be decoded and regenerated opportunistically.

A texture object's `invertY` can be a UV-transform decision rather than a row
flip. This matters for compressed textures and sampled render targets. Use the
correct colour/depth texture-view branch and sampler.

### Gaussian splats

The pinned loader builds row buffers and optional harmonics. Plugin order and
shader specialization come from the pin. Sort state, world transform and GPU
picking must refer to the same rendered cloud. Transform baking and live row
updates retain the pin's data layout and buffer identity. The loader retains
rows when baking, `splatsData` or `updateData` is reached; a successful update
publishes new geometry and a version for draw/picking refresh. Existing aliases
retain replaced row buffers. Native buffers without a retained owner refuse
at the update boundary; copying their wrappers cannot extend the source lifetime.
Both PALs refresh the existing four data textures
before the next draw or pick. An immediate pick keeps the preceding order;
the next frame applies the pin's depth-transform sort gate to the new centres.
The native sort remains synchronous on the render thread, as recorded in the
generated `splat-synchronous-sort` adaptation. Multiple plugin sets and some
contributor combinations remain unfinished.

`test/fixtures/splat-update-picking.ts` observes an actual cloud hit, moves all
rows away and immediately picks again, then restores the rows and immediately
requires the cloud hit. Run it with `npm run scene -- parity
test/fixtures/splat-update-picking.ts --differential --gpu-debug` after processing
the fixture. Its runtime assertions verify update-to-pick ordering on both PALs.

### Animation and hierarchy

Property and glTF tracks keep separate interpolation/target support.
Visibility has the pin's mutation and render-list refresh semantics; filtering
only at initial registration can lose later-visible meshes, while filtering at
every draw can bypass the pin's invalidation boundary.

Loaded materials/meshes retain their own animation-pointer targets. Imported
root cloning and parent transforms must preserve post-deformation ownership,
rather than applying an outer transform in whichever stage is convenient.

### Frame graph and post-process passes

A pipeline matches its output target's format, depth presence and sample count.
A borrowed depth attachment keeps the pin's load operation. Each colour task
owns its camera/aspect-derived scene block. Partial swapchain copies preserve
preceding content; their capture cannot be replaced by their source texture
alone.

The compiler-created default colour task preserves scene stage order;
application tasks follow explicit lists. Post-process modules come from the
pin and uniform writers from their ASTs. Composite ownership must follow the
actual task/output graph; assuming the final pass is always the public output
is insufficient for temporal effects.

A screen-space effect invalidates its temporal history on the pin's reset
events: first allocation, owned-target reallocation, a source or depth
texture identity change, a reset version change, the disabled-to-enabled
transition and a singular view-projection inverse; camera motion keeps
history. Native texture identity is the
backend's allocation of a target's textures, so a frame-graph rebuild that
recreates unchanged-size targets invalidates history where the browser's
retained textures would not. Owned targets round their scaled extents by the
pin's own rule, distinct from a composite intermediate's floor. SDL_GPU
reconstructs depth from its device-preferred sampled depth format; Dawn keeps
the browser's `depth24plus-stencil8`. The producer and resolve passes clear
their targets before the fullscreen draw as the pin's recorded `loadOp` does,
although the draw covers every texel; SDL_GPU could discard them instead, a
departure from the recorded pass this port does not take.

## Picking contract

Basic and detailed picking use the pin's pipeline modules and identify the
actual mesh/cloud/billboard rather than its name. Sampled depth reconstructs a
world-space point. Detailed barycentrics/normal lookup must use the geometry
space the pin expects, including skinned versus CPU-baked transforms.

Picking results use a shared native carrier so aliases and data transport
preserve JavaScript result identity and barycentric precision. GPU readback
binds the carrier to its originating engine before the existing pinned
continuation runs. Mesh-name and normal queries check that engine's wrapper
lifetime; use after destruction or relocation explicitly throws. Full
post-engine mesh retention remains outside this adaptation.

Regular deformation picking executes the pin's projection factory for the
skeleton/morph combinations present in the composed mesh rows. Basic and
detailed passes bind each projection's own palette/storage layout. Pending
weight writes and current bone poses upload before the pick is encoded, so
a write followed by a pick observes the new pose without an intervening frame. Their
world matrix uses the same shared transport choice as visible draws: authored
local deformation precedes the mesh's live world; loaded skin palettes already
carry that world. Detailed rest-normal lookup retains the node world separately
and leaves the undeformed local varying in the pin's expected geometry space.

Detailed picking requires the device's primitive-index capability; native
throws where the pin's feature probe can leave it unavailable. Four-influence
regular deformation does not imply eight-influence, thin-instance or VAT
coverage. A deformed thin-instance candidate explicitly refuses. The pin's VAT
projection refusal remains intact. Readback and subsequent continuations must
occur after the render work that produced their buffers.

## Physics contract

BBL uses variable frame deltas by default, with a 100 ms ceiling. With both
`scene.fixedDeltaMs` and the world timestep at `0`, physics follows elapsed frame
time, as described in the pinned [physics documentation](https://github.com/BabylonJS/Babylon-Lite/blob/64710b56f9dfe175d919c635812f84c8872d467c/docs/lite/architecture/42-physics.md#timestep--delta-time-propagation).
This keeps simulation speed consistent at ordinary frame rates; different step
sizes can still produce different collision trajectories.

Explicit scene/world fixed overrides advance once per rendered frame; they do
not create a fixed-frequency scheduler. The unchanged Break Meshes demo overrides
its world step to 12.5 ms, so it advances 0.75 simulated seconds per wall second
at 60 fps and 3 at 240 fps. Browser and native must preserve those same authored
settings. A comparison against an edited browser demo cannot establish upstream
fidelity.

The pinned [headless documentation](https://github.com/BabylonJS/Babylon-Lite/blob/64710b56f9dfe175d919c635812f84c8872d467c/docs/lite/05-headless-null-engine.md#fixed-timestep--determinism)
recommends accumulating elapsed time and consuming it in fixed steps for
reproducible simulation. The application supplies that scheduling through
`stepScene`; the normal rendered physics loop has no automatic accumulator.
The documented headless prototype also lacks mesh/convex-hull collider support,
so it cannot directly replace the rendered Break Meshes simulation.

The Babylon-facing physics layer is generated; the solver is Bullet, while
the browser uses Havok. This substitution cannot establish identical
trajectories by construction. Backend equality localizes a difference below
shared rendering, but does not distinguish loader, generated physics and
Bullet behavior on its own.

The PAL contains measured solver adaptations: fixed substeps, speculative
contacts, delayed/reconstructed rebound, damping/speed translation and
contact-rest stabilization. The rebound rule is fitted from reference drops;
it is not a transpilation of Havok internals. Retain that distinction in
diagnostics and in any future effort to remove handwritten engine behavior.

Additional library-boundary contracts are:

- Body add/re-add and transform application preserve the pin's configuration
  order despite Bullet's add-time state.
- Degenerate boxes expand below Bullet's margin and offset their centre. The
  chosen positive-face preservation is a known thin-ceiling limitation.
- Convex hulls preserve centre of mass, inertia and principal-axis frame.
- An authored centre of mass moves the body frame Bullet integrates and
  offsets the collider by the same transform through a per-body compound
  child, since Bullet centres a shape on the body origin while Havok carries
  the centre as a separate body-local point.
- Triangle-mesh backing storage outlives Bullet's shape; dynamic concave mesh
  bodies refuse.
- Shape trigger flags propagate to body collision flags; overlap-set changes
  generate enter/exit events.
- Friction/restitution combine modes and static/dynamic-friction limitations
  remain explicit.
- Floating-origin regions are separate solver worlds; bodies in different
  regions do not collide.

Validate solver-independent rest/shape properties separately from motion.
Use per-step position/velocity traces for flight, landing, rebound and sleep;
compare against the pinned Havok sequence at the same step. Keep an observing
fixture for a mechanism that a registered scene merely reaches. No tuning of
source scenes or thresholds substitutes for this evidence. Residual classes
and unfinished physics capabilities are tracked in TODO; published pixels
belong in status.

## Audio contract

The platform seam is Web Audio: the pinned engine creates its graph over an
AudioContext, and LabSound implements reached nodes/parameters behind
`pal_audio.hpp`. Runtime audio must remain renderer-independent and
feature-selected.

Graph topology and scheduling are not proof of matching PCM. The offline
`BBLITE_AUDIO_CAPTURE` path allows waveform comparison; a durable browser
versus native PCM gate remains unfinished. Master-volume changes require the
pin's ramp component rather than an un-ramped gain assignment.

## What is measured: the full page

Parity includes the scene canvas and reached retained UI. UI layout/font
differences can dominate composite MAD, so scenes declaring canvas thresholds
also gate the canvas-only attribution pair. A canvas-only result does not
replace the full-page result. [UI](ui.md) owns its supported and degraded
browser behavior.

## Parity reports

Reports carry backend identity, full/foreground MAD, exact and bounded-byte
ratios, per-channel bias and spatial attribution. These are evidence for
localization, not automatic diagnoses. Shared CPU/shader inputs can produce
matching defects on both backends.

[Debugging](debugging.md) owns commands, capture formats and the diagnostic
ladder. [Status](status.md) owns published measurements;
[development](development.md) owns validation and freshness requirements.
