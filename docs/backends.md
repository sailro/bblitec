# Native render backends

Both renderers consume generated plans, layouts, state and uniform writers.
Feature admission belongs in [features](features.md), source/native adaptations
in [fidelity](fidelity.md), and commands in [development](development.md).

## Backend comparison

| Boundary | SDL_GPU | Dawn |
| --- | --- | --- |
| Shaders | Offline Tint/target binaries | Deployed WGSL compiled by Dawn |
| Binding authority | Compiled `.slots` sidecars | WGSL and generated layout tables |
| Uniforms | Push/uniform and storage API | Queue writes and retained bind groups |
| Platform coverage | Windows D3D12; Vulkan/Metal gaps | Windows surface integration |
| Resource ownership | SDL device objects/fences | WebGPU objects/submission retention |

Backend agreement does not exclude a shared input or implementation defect.

## Shared frame conductor

`pal_gpu_shared.hpp` owns frame options, clock/capture gates, callbacks and
shared upload records. `pal_window.hpp` keeps OS window identity outside
renderer rebuilds. Scene, sprite, effect and scene-less frame-graph drivers are
separate translation units. GPU objects and pass encoders stay backend-specific.

RAF preserves registration phase relative to rendering; timers drain at frame
boundaries. Canvas metrics update before callbacks. A disabled backend removes
its translation units and dependencies.

## Compiled binding contract

SDL binds resources retained by the compiled stage, including compacted slots
after dead declarations disappear. Use sidecars for visibility, resource kind,
slot order and uniform size. Large uniform blocks can become read-only storage
in SDL-facing artifacts; Dawn keeps their original declarations and bytes.

Local PBR probes bind the pin's recorded cube array, grid and material fields. Each retained probe set
owns its GPU resources; single local environments override the cube independently per material.
SDL always demotes the 64 KiB probe block to storage to respect its 16 KiB push-uniform limit.

Dawn uses per-variant layouts. Pipeline keys include format, sample count, depth,
blend, cull, topology and compare. Uniform ownership distinguishes draws with
different overrides. Request limits from reached layouts; retain resources
through in-flight use. Surface device errors instead of changing renderers.

Node geometry uses original position/normal/UV/index streams and separate
per-view mesh uniforms. Material/texture bindings come from generated variant
descriptors. Capture instructions and observation limits live in
[debugging](debugging.md#captured-state-and-its-limits).

## Temporal post-process transport

Each TAA source task owns clean scratch, uploaded bytes and cache state.
Generated hooks pack/update/reset once in source order; the final uploaded
bytes must reach that submission, including draws encoded before late writes.

Dawn retains the source-task uniform buffer and bind group. SDL records logical
draw packets, completes task hooks, then pushes the final source bytes during
encoding. Ordinary blocks remain snapshots. Encoding never reruns callbacks.

Resize recreates GPU targets and applies the source reset after successful
recording. Stopped presentation reuses the final image without history/jitter
execution; resizing a stopped output scales that image.

## Workers and offscreen surfaces

AOT entry factories create independent module state. Each realm owns tasks,
microtasks, timers, promises and JS identities; computation workers need no GPU.
Typed sender/receiver codecs preserve admitted aliases/cycles and ordered
messages. The OS thread owns window/layout/presentation. Only owned messages,
document snapshots, dimensions and fenced image leases cross threads; engine
records and JS references do not. Source callbacks run on their realm. Canvas
transfer validates before detachment and preserves exclusive context ownership.
`close` finishes the current callback/microtasks; `terminate` wakes waits and
uses compiled cancellation points. Arbitrary native calls are not preemptible.
The service does not interpret application message names; first rendered frame,
application readiness and OS presentation are distinct events. Worker-free paths
omit worker scheduling/locks.

`platform:window` selects the surface service; ordinary builds omit it. The host
owns a device/queue and OS window. Each producer owns an engine, scene, encoders
and resources. A three-image pool provides a latest-frame mailbox; consumer
fences prevent overwriting sampled images. Normal presentation samples GPU
textures; screenshots use readback.

Display-paced RAF notifications run on each realm loop; busy realms coalesce
notifications independently and do not accumulate catch-up frames.
`OffscreenRun` owns publication while the realm scheduler owns time. SDL submits
on the command buffer's acquiring thread. Dawn enables implicit device
synchronization for the shared host device and keeps producer encoders private.
Retire completed consumer leases before waiting for the next repaint.

The host composites producer canvases inside the retained document; DOM
callbacks run in the application realm. This service does not establish support
for every multi-canvas source shape.

## Retained UI

Same-engine canvas scenes render to independent targets sized from retained canvas rectangles;
presentation applies each page offset once and layout changes recreate affected targets. A
surface canvas the source appended to host chrome outside the projected document has no
rectangle, so it shares the window in equal horizontal panes with the primary scene, in
registration order (antigravity-racer's second player).

RmlUi emits backend-neutral geometry, texture updates, scissors, transforms and
blur stages. Backend caches own uploads, multisample UI targets and premultiplied
composition. Supported drivers and browser compatibility belong in [UI](ui.md).

## Render-target boundaries

- Pipelines and attachments must agree on formats, samples and depth state.
- Single-sample resolves are copies; changed targets invalidate dependent state.
- Transmission scene-color capture uses resolved color on SDL and multisamples
  on Dawn. Separate this difference from image processing when diagnosing.
- D3D12 line/multisample-storage paths require maintained SDL patches.
