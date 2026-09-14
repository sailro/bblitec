# Native render backends

Both backends consume generated plans, state, layouts and uniform writers.

## Backend comparison

| Boundary | SDL_GPU | Dawn |
| --- | --- | --- |
| Shader input | Offline Tint/target binaries | WGSL |
| Binding authority | Compiled `.slots` sidecars | WGSL and generated layouts |
| Uniform transport | Push/uniform/storage API | Queue writes and retained bind groups |
| Windows / Linux / macOS | D3D12 / Vulkan / Metal | D3D12 / Vulkan / Metal |
| Android | Vulkan | Unsupported |
| Lifetime | SDL objects and fences | WebGPU objects and submission retention |

Backend agreement does not establish browser parity. Measurements live in [status](status.md).

## Shared frame conductor

`pal_frame_conductor.hpp` coordinates scene, sprite, effect and frame-graph drivers.
`pal_gpu_shared.hpp` owns clocks, capture gates, callbacks and upload records.
Canvas metrics update before callbacks; RAF retains its registration phase and timers drain at frame boundaries.
`pal_window.hpp` owns the OS window independently of renderer rebuilds.

## Compiled binding contract

- SDL binds compiled resources after dead declarations are removed. Sidecars specify stage visibility,
  resource kind, slot order and uniform size. Large uniform blocks may use read-only storage.
- SDL integer texture loads occupy storage-texture slots. Vulkan sampled textures use combined
  image/sampler descriptors; integer and multisampled loads use separate images.
- SPIR-V preserves varying locations. Vertex-buffer inputs compact with their pipeline attributes to fit mobile limits.
- Metal uses `main0`, flattened sidecar bindings and buffer lengths at reserved index 30 for robust access.
- Dawn pipeline keys include format, samples, depth, blend, cull, topology and compare. Reached layouts
  determine device limits. Vulkan teardown releases the presentation surface before the device.
- Material pipelines use each task's sample count. Shared uploads retain per-binding sampler/UV state;
  image identity includes bytes and upload flags. Last-owner release retires cached images.
- Android prefers Vulkan 1.3 helper-invocation discard to preserve masked edges under MSAA;
  older devices retain the Vulkan 1.0 shader path.
- Local probe sets own their cube arrays and uniform data. SDL stores the 64 KiB probe block in a buffer.
- Node geometry retains original attribute/index streams and separate per-view uniforms.

Maintained patches cover SDL descriptor-heap rollover, D3D12 multisampled lines/storage reads,
Metal buffer lengths/fence queries and Dawn Metal primitive-index capability.

## Temporal post-process transport

Each TAA source task owns scratch, uniforms and history. Hooks run once in source order.
Dawn retains the final source buffer; SDL delays draw encoding until final writes are available.
Encoding does not rerun callbacks. Resize recreates targets and applies source reset rules.
Stopped presentation scales the retained image without advancing history.

## Workers and offscreen surfaces

| Owner | State |
| --- | --- |
| Realm | Module bindings, JS identities, tasks, microtasks, timers, promises, callbacks |
| OS thread | Window, layout, presentation |
| Window host | Shared physical device and queue |
| Producer | Engine, scene, encoders, resources, image publication |

Typed messages, document snapshots, dimensions and fenced image leases cross threads; JS references
and engine records do not. Canvas transfer validates before detachment. Rendering products must match.

`close` completes the active callback and microtasks. `terminate` wakes waits and uses compiled
cancellation points; arbitrary native calls are not preemptible. RAF notifications coalesce per realm.
Computation workers need no GPU; worker-free builds omit worker scheduling.

`platform:window` selects the host and presenters. A three-image mailbox retains the latest frame;
consumer fences prevent overwriting sampled images. Normal presentation uses GPU textures; captures
use readback. SDL submits on the acquiring thread; Dawn synchronizes the shared device.

The first document snapshot follows initialization microtasks. Image decoding works before engine
construction and keeps readiness on the application realm. Source callbacks remain on that realm.
Shared-device recovery in worker/window applications is unsupported.

## Retained UI

Same-engine canvases use independent targets and retained CSS rectangles. Host canvases without a
projected rectangle share equal horizontal panes. RmlUi supplies geometry, textures, scissors,
transforms and effects; the backends own uploads, layers and premultiplied composition. See [UI](ui.md).

## Render-target boundaries

Attachments and pipelines must agree on formats, samples and depth state. Single-sample resolves are
copies; target changes invalidate dependent state. Transmission capture uses resolved color on SDL
and multisamples on Dawn. GPU initialization/recovery failures are errors, not backend fallback.
