# Native render backends

Both backends consume the generated scene state, render plans, uniform writers
and shared upload representation. Each is measured against the same browser
golden. A scene is integrated only after both meet its gates.

| Backend | Shader path | Native responsibility |
| --- | --- | --- |
| SDL_GPU | Offline Tint, binding normalization and target compilation | SDL GPU device/resources/commands |
| Dawn | Deployed WGSL compiled by Dawn | WebGPU device/resources/commands |

Dawn shares a compiler/API lineage with the browser reference; that does not
guarantee identical versions, device choices or rendering. Cross-backend
agreement helps localize differences but cannot exclude shared defects.

## Building and running

CMake `BBLITE_BACKEND` selects `SDL_GPU`, `DAWN` or `BOTH`.
`BBLITE_GPU_BACKEND` selects a compiled backend at runtime; unavailable
selections fail. Both require a GPU.

Use [development](development.md) for setup, scene commands, toolchain pins,
DLL deployment, shipping artifacts and platform defaults. Generation and
deployed shader snapshots must match the measured native build.

## Backend comparison

| Property | SDL_GPU | Dawn |
| --- | --- | --- |
| Startup shader work | Loads offline binaries | Compiles WGSL |
| Binding authority | Compiled `.slots` sidecar | Deployed WGSL/generated binding descriptors |
| Uniform updates | SDL push/uniform and storage binding API | Queue writes and bind groups |
| Validation | SDL/backend validation | WebGPU validation and robustness |
| Native platform status | Windows D3D12 validated; Vulkan/Metal gaps | Windows surface integration |
| Shipping shape | Trimmed static platform/codec dependencies | Separate static Dawn artifact/toolchain |

A performance claim needs a current build, adapter, dimensions, warmup and
frame-count report. Do not carry historical single-scene timings as a general
backend ranking.

## Offscreen surfaces

`platform:window` selects `BBLITE_OFFSCREEN_SURFACES`. A thread-bound
`OffscreenRun` redirects the scene renderer to a native `OffscreenSurface`.
The normal build compiles these branches out; it adds no mailbox, lock,
texture copy or thread to existing applications.

The host owns one device/queue and the OS window. Each producer owns its
engine, scene, command encoders and renderer resources. A bounded pool of
three GPU images per producer supplies a latest-frame mailbox. The presenter
retains each image until its consumer fence completes, so producers cannot
overwrite a texture being sampled. Presentation samples these textures on
the GPU; diagnostic screenshots alone use readback. Worker applications receive
display-paced animation notifications on each realm's event loop. Busy realms
coalesce notifications while other realms continue. `OffscreenRun` owns the
endpoint and publication; the realm scheduler owns animation timing.

SDL configures shared device presentation settings once, before launching
producers. Submissions stay on the thread that acquired their command buffer
and use the device's ordered queue. See
[SDL submission rules](https://wiki.libsdl.org/SDL3/SDL_SubmitGPUCommandBuffer).
Dawn requests `ImplicitDeviceSynchronization` only for the shared host device;
its API synchronization is required for this native sharing arrangement.
Encoders remain private to their producer. See
[Dawn threading feature](https://dawn.googlesource.com/dawn/+/refs/heads/main/docs/dawn/features/implicit_device_synchronization.md).

Worker applications select the surface capability through `platform:window`.
Their OS host composes canvas textures inside the retained document; source
DOM callbacks run in the application realm. Dawn retires consumer fences again
after presentation so completed leases are released before the next repaint
notification. Keeping leases across that wait can unnecessarily exhaust the
producer pool even when the GPU has finished.

The native surface unit fixture checks ownership and bounded leases. The
registered Offscreen application checks real Worker messaging, retained UI and
both GPU backends. Two renderers and composition have their own GPU cost;
preserving the default path does not establish a general performance claim.

## Shared frame conductor

`native/src/pal_gpu_shared.hpp` owns backend-neutral frame options, clock,
capture gates, callback scheduling, benchmarks and shared upload/diagnostic
representations. `pal_window.hpp` owns the window outside renderer rebuilds,
so scene replacement preserves size, focus and identity.

RAF callbacks retain their registration phase relative to engine rendering;
timers drain on frame boundaries. The first engine frame reports the pin's
zero delta. Canvas extents update from drawable pixels before application
callbacks. Runtime flags that a driver cannot implement must refuse.

Rendering contexts are ordered registrations. Dedicated scene, SpriteRenderer,
EffectRenderer and scene-less frame-graph translation units prevent a simple
driver from pulling in the full scene renderer. Depth-hosted Sprite2D layers
are part of a scene pass; standalone layers own their separate target/load
contract.

Per-backend helpers live in `pal_sdl_gpu_shared.hpp` and
`pal_dawn_shared.hpp`. Keep SDL_GPU types out of Dawn/shared contracts and
WebGPU types out of SDL/shared contracts. Shared data structures can own
geometry, texture payload and recorded UI commands; GPU handles, bind groups,
pipelines and pass encoders remain backend-specific.

Disabling a backend must remove all its translation units/dependencies while
the other backend's entry points remain usable. Source deletion is a stronger
claim than selecting it off: shared build scripts/stubs may still name disabled
files. Test standalone configurations rather than infer removability from
header hygiene alone.

## Temporal post-process transport

Within the [admitted TAA surface](features.md#post-process-passes), source
render tasks own persistent clean and uploaded scene-uniform bytes. A task
retains its original scene identity; two tasks drawing the same mesh still
use separate source blocks. Shared generated writers own cache decisions,
packing, execute/reset order and jitter. The [fidelity contract](fidelity.md#frame-graph-and-post-process-passes)
explains why late writes must affect earlier draws in the same submission.

Dawn gives each source task a persistent uniform buffer and frame bind group.
Queue writes update that buffer before the command buffer is submitted;
per-mesh material groups do not replace the task's scene binding. When GPU
resources are recreated, the replacement buffer starts from the task's
retained uploaded bytes.

SDL_GPU first resolves resources and runs the logical task hooks, retaining
draw packets until those hooks finish successfully. Ordinary uniform blocks
are snapshots; scene slots retain the source task's uploaded storage. Encoding
then pushes its final bytes through the compiled stage slots. Post-process
uniforms likewise resolve by task and child identity after logical execution.
Encoding does not replay callbacks or advance TAA a second time. With no
source camera, uniform bytes and transparent-list order remain unchanged,
and no camera viewport is applied.

Live target resize recreates GPU resources and applies the pinned TAA record
reset after successful recording, while retaining source CPU cache/storage.
After `stopEngine`, presentation reuses the final image without executing
history or jitter again. SDL retains the completed presentation texture;
Dawn copies the completed surface into an owned texture. A stopped resize
scales that retained image rather than rendering another temporal frame.

## Retained UI

RmlUi emits backend-neutral geometry, textures, scissors, transforms and blur
stages. Each renderer owns upload/caches, the transparent multisample layer,
resolve and premultiplied composition. Shared CSS/DOM/Canvas2D behavior is
documented in [UI](ui.md).

The scene and sprite drivers integrate UI. Scene-less effect/frame-graph
drivers currently reject retained UI at generation. They must not be listed as
UI-capable merely because their frame conductor is shared.

## Dawn backend architecture (`native/src/pal_dawn.cpp`)

Dawn loads deployed `*.native.wgsl` unchanged. Specialized mesh stages and
pin-composed materials have different binding schemes; generated layout tables
are authoritative for each family.

- Composed PBR/Standard variants preserve the pin's scene/light, mesh/material
  and densely numbered texture bindings. Layouts are per variant.
- Pipelines key all relevant target state, including sample count and depth
  presence. Blend, cull, topology and compare come from generated contracts.
- Queue writes precede submission. Uniform-buffer ownership must distinguish
  draws that use different material overrides; reusing one per-mesh block can
  make an override affect another draw.
- Deformation/instance buffers use the shared packed vertex layout. Device
  limits are requested from reached layouts, not assumed from WebGPU defaults.
- Shadows use reflected resource kinds and light slots. A mixed-filter scene
  can require ordinary/comparison samplers and 2D/depth-array textures together.
- Runtime appends and buffer growth must respect in-flight ownership. Submitted
  WebGPU commands retain resources; explicit synchronization belongs only at
  paths whose resource/state transition requires it.
- Device errors are collected and surfaced, never silently replaced by another
  renderer.

## Compiled binding contract

SDL_GPU binds what the compiler retained, not every declaration present in
source WGSL. Tint can remove unused buffers and compact subsequent slots.
Every compiled stage publishes a sidecar; custom sprites/materials follow the
same rule as pinned variants.

The shader pipeline normalizes texture/sampler registers into SDL's spaces.
Uniform blocks exceeding SDL_GPU's stage limit can be demoted to read-only
storage bindings in SDL-facing artifacts; Dawn retains the original uniform
declaration. Both bind the same bytes through their respective reflected rows.

Changes must check stage visibility, resource kind, slot order, uniform size,
depth-array views, instance attributes and target state. A matching resource
count is insufficient when names/types differ.

## Measured contracts

Canonical parity values live only in [status](status.md). These mechanisms
explain established comparison boundaries:

- Transmission preserves the pinned linear frame and image-processing pass.
  The scene-colour grab differs where SDL consumes resolved colour and Dawn
  reads multisamples. Isolate the grab from image processing when diagnosing it.
- Single-sample resolve tasks reduce to copies. Target/sample changes must
  update all pipeline and attachment descriptors.
- D3D12 line rasterization depends on the multisample enable state.
  The maintained SDL overlay patches support the reached multisample-storage
  and line paths. Patch inventory and retirement tasks belong in TODO.
- Main colour and shadow depth conventions differ explicitly; culling,
  winding and sampled depth contracts are independent of that compare.
- Capture freshness matters equally for WGSL-loading Dawn and binary-loading
  SDL_GPU. Their different inputs can make one stale snapshot appear as a
  backend-only defect.

## Ported pinned contracts

The generated tables/writers own texture encoding, samplers, fallbacks,
extension slots, material plugin textures, cube orientation, mip policy,
background geometry and fixed-function state. Both PALs consume those
decisions. Their precise source/native semantics belong in
[fidelity](fidelity.md); feature support belongs in [features](features.md).
