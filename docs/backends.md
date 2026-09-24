# Native render backends

Both backends consume generated plans, state, layouts and uniform writers.

## Backend comparison

| Boundary                | SDL_GPU                                 | Dawn                                             |
| ----------------------- | --------------------------------------- | ------------------------------------------------ |
| Shader input            | Offline Tint/target binaries            | WGSL                                             |
| Binding authority       | Compiled `.slots` sidecars              | `.slots` layout lines and generated layouts      |
| Uniform transport       | Push/uniform/storage API                | Queue writes and retained bind groups            |
| Windows / Linux / macOS | D3D12 / Vulkan / Metal                  | D3D12 / Vulkan / Metal                           |
| Android                 | Vulkan                                  | Vulkan                                           |
| iOS Simulator           | Unsupported by pinned SDL               | Metal                                            |
| iOS device              | Metal, unqualified                      | Metal, unqualified                               |
| Lifetime                | SDL objects and fences                  | WebGPU objects and submission retention          |
| GPU task timestamps     | D3D12; other drivers report unsupported | Enabled when the device supports timestamp-query |

Runtime selection prefers SDL_GPU when compiled, otherwise Dawn. Explicit invalid or uncompiled
backend requests fail.

## Shared frame conductor

`pal_frame_conductor.hpp` coordinates scene, sprite, effect and frame-graph drivers. `pal_gpu_dispatch.hpp`
holds each compiled backend's entry points and Window presenter; `RendererRun` (`pal_frame_session.hpp`)
shares the standalone hosts' input, clock, capture and benchmark phases.
`pal_gpu_shared.hpp` owns clocks, capture gates, callbacks and upload records.
`pal_scene_synchronize.hpp` owns a scene frame's synchronization order, which both scene backends
instantiate with their own GPU operations. `pal_pass_camera.hpp` resolves every pass's camera and clear
colour through the lowered `cfg.cam ?? scene.camera` and `cfg.clrColor ?? sc.clearColor`: a layer renders
through its own camera, every render and geometry task pass applies its camera's viewport, and a
camera-less pass keeps the scene block and view-projection it last wrote (its view, projection and eye are zero). Renderable clocks
(sprite-renderer hooks, sprite and billboard FX) step by the engine's delta, not a scene's `fixedDeltaMs`.
Canvas metrics update before callbacks; RAF retains its registration phase and timers drain at frame boundaries.
`pal_window.hpp` owns the OS window independently of renderer rebuilds.

GPU completion posts native events to the owning realm. Dawn waits for mapping/submission futures
on a worker thread; SDL waits for submission fences. Promise reactions stay on the realm thread.

## Compiled binding contract

- bblite-tint (`tools/tint-sdl`) drives the pinned Tint's HLSL, MSL and SPIR-V writers with SDL's
  slots as their binding options and writes the `.slots` sidecar from the same assignment; DXC
  compiles the HLSL to DXIL. Slots cover the resources the lowered entry point reaches.
  Sidecars specify stage visibility, resource kind, slot order and uniform size. Large uniform
  blocks may use read-only storage.
- Each render stage's `.slots` sidecar opens with `@entry <entry point>` and ends with
  `@binding <group> <binding> <name> <resource>` lines Tint reflects from every binding its
  module declares (the module Dawn compiles, before any SDL uniform adaptation). Dawn lays
  sprite, billboard, picking, splat, post-process, ID-diagnostic and retained-UI groups out
  from them, adding only the site's binding model: dynamic offsets and formats that do not
  filter. Sprite and billboard groups bind each resource by the name the pin's module declares.
  The per-pass scene group follows the pin's `getSceneBindGroupLayout`, recorded at generation.
  Composed material, effect, text, screen-space and compute layouts come from generated pin
  descriptor tables; single-pipeline runtime modules use Dawn's reflected layout.
- Sprite and billboard programs are the pin's own modules, deployed whole per reached
  permutation; SDL binds their blocks at the slots each stage's sidecar names, and billboards
  bind the pin's per-pass scene block at group 0 on both backends.
- SDL integer texture loads occupy storage-texture slots. Vulkan binds a sampled texture and its
  sampler as one combined image sampler, which Tint's image and sampler both address at the
  texture's binding; integer and multisampled loads are sampled images after them.
- A native module's interstage structures place the position first (a maintained Tint patch), so
  its separately compiled D3D12 stages link when a fragment reads a prefix of the vertex outputs;
  pinned stages keep Tint's order, whose fragments that omit the position read a prefix of it.
- SPIR-V is version 1.3 and preserves varying locations; SDL_GPU devices request Vulkan 1.1.
  Vertex-buffer inputs compact with their pipeline attributes to fit mobile limits.
- Tint's SPIR-V keeps floating-point-dependent branches; the Vulkan driver optimizes the arithmetic.
- Metal uses `main0`, flattened sidecar bindings and buffer lengths at reserved index 30 for robust access.
- Dawn pipeline keys include format, samples, depth, blend, cull, topology and compare. Reached layouts
  determine device limits. Vulkan teardown releases the presentation surface before the device.
- Material pipelines use each task's sample count. Shared uploads retain per-binding sampler/UV state;
  image identity includes bytes and upload flags. Last-owner release retires cached images.
- Android prefers Vulkan 1.3 helper-invocation discard to preserve masked edges under MSAA;
  older devices retain the Vulkan 1.1 shader path.
- Local probe sets own their cube arrays and uniform data. SDL stores the 64 KiB probe block in a buffer.
- Node geometry retains original attribute/index streams and separate per-view uniforms.

SDL and Dawn carry maintained patches; [`native/patches/manifest.json`](../native/patches/manifest.json)
lists each with the builds that apply it, its purpose and upstream state.
Dawn disables texture swizzling on iOS Simulator and uses its non-swizzle depth/stencil path.
Dawn uses SDL's Android native window and selects a supported BGRA8/RGBA8 surface format;
worker images retain that format. Resume replaces the presentation surface when SDL's native
window changes, retaining device resources. Unavailable immediate presentation uses FIFO with a diagnostic.
The Android Dawn patch reports Vulkan presentation surface loss at the next acquisition without
losing the device; repeated acquisition loss and other GPU errors still fail.

SDL Metal generates mips with per-level linear blits, preserving sRGB decode/filter/encode.
Color-less depth sampled by material slots uses an R32 copy with `(depth, 0, 0, 1)` semantics.
Standalone sprite/text UNORM clears round to the nearest byte; floating-point and sRGB targets are unchanged.
Linux Canvas2D texture bakes use the reference capture's Vulkan rasterizer; Windows/macOS bake flags are unchanged.

## Temporal post-process transport

Each TAA source task owns scratch, uniforms and history. Hooks run once in source order.
Dawn retains the final source buffer; SDL delays draw encoding until final writes are available.
Encoding does not rerun callbacks. Resize recreates targets and applies source reset rules.
Stopped presentation scales the retained image without advancing history.

## Workers and offscreen surfaces

| Owner       | State                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Realm       | Module bindings, JS identities, tasks, microtasks, timers, promises, callbacks |
| OS thread   | Window, layout, presentation                                                   |
| Window host | Shared physical device and queue                                               |
| Producer    | Engine, scene, encoders, resources, image publication                          |

Typed messages, document snapshots, dimensions and fenced image leases cross threads; JS references
and engine records do not. Canvas transfer validates before detachment.

`close` completes the active callback and microtasks. `terminate` wakes waits and uses compiled
cancellation points; arbitrary native calls are not preemptible. RAF notifications coalesce per realm.
Computation workers need no GPU; worker-free builds omit worker scheduling.

Window engines use the supplied RAF timestamp. Windows hosts with the compositor clock API pace
repaint from its heartbeat and prefer supported mailbox presentation, with FIFO fallback. Other hosts
use presentation completion. Input callbacks, native defaults and the events those defaults post (click,
input, change, toggle) finish before the next input event and before repaint. The host services
input and layout while awaiting RAF callback submissions, bounded by the next heartbeat, then selects
the latest canvas frames. Completion receipts contain weak native inbox references, never JS values.

`platform:window` selects the host and presenters. A three-image mailbox retains the latest frame;
consumer fences prevent overwriting sampled images. Normal presentation uses GPU textures; captures
use readback. SDL submits on the acquiring thread; Dawn synchronizes the shared device.

The first document snapshot follows initialization microtasks. Image decode readiness and source
callbacks remain on the application realm.

## Retained UI

Canvases keep their retained CSS rectangles; host canvases without a projected rectangle share equal
horizontal panes. RmlUi supplies geometry, textures, scissors,
transforms and effects; the backends own uploads, layers and premultiplied composition. See [UI](ui.md).

## Render-target boundaries

Attachments and pipelines must agree on formats, samples and depth state. Single-sample resolves are
copies; target changes invalidate dependent state. Transmission capture uses resolved color on SDL
and multisamples on Dawn. GPU initialization/recovery failures are errors, not backend fallback.
