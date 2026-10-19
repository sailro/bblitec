# Native render backends

Both backends consume the same generated plans, layouts and uniform writers.

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
| GPU timestamps          | D3D12; other drivers report unsupported | Enabled when the device supports timestamp-query |

- Runtime prefers SDL_GPU when compiled, else Dawn. Invalid or uncompiled requests fail; GPU initialization and
  recovery failures never fall back to the other backend.
- Interactive desktop runs use SDL main callbacks (iterating during Win32 move/resize); capture, benchmark and mobile
  runs iterate explicitly.

## Code layout

| File | Owns |
| --- | --- |
| `pal_frame_conductor.hpp` | Frame phases for scene, sprite, effect and frame-graph drivers |
| `pal_gpu_dispatch.hpp` | Per-backend entry points and Window presenter |
| `pal_frame_session.hpp` (`RendererRun`) | Standalone input, clock, capture and benchmark phases |
| `pal_gpu_frame.*`, `pal_gpu_images.*` | Scene-invariant run options, clocks, capture gates, texel packing, readback |
| `pal_gpu_*.hpp` + `pal_gpu_shared.cpp` | Scene-shaped shared concerns, compiled once per build |
| `pal_<backend>.cpp`, `pal_<backend>_scene.hpp` | Scene driver and state, `<backend>` = `sdl_gpu` or `dawn` |
| `pal_<backend>_scene_<family>.cpp` | meshes, variants, shadows, textures, targets, post_process, picking; built as one unit via `pal_<backend>_scene_all.cpp` |
| `pal_scene_synchronize.hpp` | Scene frame synchronization order, instantiated per backend |
| `pal_pass_camera.hpp` | Pass camera and clear colour (`cfg.cam ?? scene.camera`); camera-less passes keep the last scene block |
| `pal_window.hpp` | OS window; survives renderer rebuilds |

Renderable clocks (sprite hooks, sprite/billboard FX) step by engine delta, not `fixedDeltaMs`. GPU completion posts
native events to the owning realm; promise reactions stay on the realm thread.

## Compiled binding contract

- bblite-tint (`tools/tint-sdl`) drives the pinned Tint's HLSL/MSL/SPIR-V writers with SDL's slots and writes the
  `.slots` sidecar from the same assignment. DXC compiles HLSL with Dawn's default-pipeline arguments (IEEE strict).
- A `.slots` sidecar starts with `@entry <entry point>` and lists `@binding <group> <binding> <name> <resource>` for
  every declared binding: stage visibility, kind, slot order, uniform size. Uniform blocks exceeding SDL's size or slot
  limits may use read-only storage without changing their layout.
- Dawn layouts: sprite, billboard, picking, splat, post-process, ID-diagnostic and UI groups from `.slots` lines; the
  per-pass scene group from the pin's `getSceneBindGroupLayout`; composed material/effect/text/screen-space/compute
  layouts from generated descriptor tables; single-pipeline runtime modules from Dawn reflection.
- Sprite and billboard programs deploy the pin's modules whole per reached permutation; billboards bind the scene block
  at group 0 on both backends.
- SDL integer texture loads use storage-texture slots. Vulkan binds a sampled texture and its sampler as one combined
  image sampler.
- Shader-material stages use matching D3D12 signature order: position first when the fragment declares it, otherwise
  locations first. Other native interstage structs put position first through the Tint patch.
- SPIR-V 1.3; SDL_GPU requests Vulkan 1.1. Vertex inputs are compacted; the sidecar maps attributes to locations.
- Metal: `main0`, flattened bindings, buffer lengths at index 30.
- Dawn pipeline keys: format, samples, depth, blend, cull, topology, compare. Reached layouts set device limits.
- Android prefers Vulkan 1.3 helper-invocation discard; older devices use the 1.1 path.
- SDL stores the 64 KiB local-probe block in a buffer.

## Platform details

- Dawn on iOS Simulator disables texture swizzling.
- Android Dawn uses SDL's native window with a BGRA8/RGBA8 surface; resume replaces the surface and keeps device
  resources; surface loss is reported at the next acquisition (patched).
- Unavailable immediate presentation falls back to FIFO with a diagnostic.
- SDL Metal builds mips with per-level linear blits.
- Colour-less targets expose an R32 copy `(depth, 0, 0, 1)` to colour-texture consumers; shader depth slots bind the depth attachment.
- Standalone sprite/text UNORM clears round to the nearest byte.
- Linux Canvas2D texture bakes use the reference capture's Vulkan rasterizer.
- Transmission uses the pin's grab modules; cube mips build one face at a time over 2D levels.

## WebGPU subset devices

`gpu.hpp` is the WebGPU subset the pin's compute, indirect and mapping calls lower to.

- `DawnWebGpuDevice` maps it one to one.
- `SdlWebGpuDevice` emulates it: runtime WGSL resolves to stages compiled at generation as
  `wgsl-<text digest>.<entry>.<stage>` (`src/wgsl-artifacts.ts`); uniform buffers are CPU bytes pushed at encode;
  encoders record and encode at submission; each dispatch is its own compute pass; indirect dispatch reads a copy of its
  arguments; queue writes stage in one upload ring; `MAP_READ` buffers map after a fence; sizes are 32-bit.
- SDL_GPU scene frames stage source-device storage-buffer writes in the frame's upload batch; every command
  buffer the thread submits submits them first. Writes outside a frame or on another thread submit at once.
- Device limits are WebGPU defaults raised by the engine's `requiredLimits`.
- `engine:webgpu-device` binds the device at `createEngine` with an empty scene layout; a renderable shader reading
  group 0 fails.
- `renderer:external-renderables` (`gpu_renderable.hpp`, `pal_external_renderables.hpp`, contract in
  `src/lowering/external-renderable-contract.ts`) draws lowered renderables in the transparent bucket, sorted by the
  pin's `compareTransparentBindings`. External renderables beside text, splats or depth-hosted sprites, in render
  tasks, or opaque refuse.
- Text keeps its own protocol (`TextScenePass`) and devices.

## Temporal post-process transport

Each TAA source task owns scratch, uniforms and history; hooks run once in source order. Dawn keeps the final source
buffer; SDL delays draw encoding until final writes exist. Resize recreates targets with source reset rules.

## Workers and offscreen surfaces

| Owner | State |
| --- | --- |
| Realm | Module bindings, JS identities, tasks, microtasks, timers, promises, callbacks |
| OS thread | Window, layout, presentation |
| Window host | Shared physical device and queue |
| Producer | Engine, scene, encoders, resources, image publication |

- Only typed messages, document snapshots, dimensions and fenced image leases cross threads.
- `close` finishes the active callback and microtasks; `terminate` stops at compiled cancellation points only.
- Window pacing: compositor-clock heartbeat on Windows (mailbox, FIFO fallback), presentation completion elsewhere.
  A three-image mailbox keeps the latest frame; captures use readback.
- Native jobs (`pal_native_job.hpp`) settle on the realm in start order, one task each, on the shared bounded workers
  (`pal_native_workers.hpp`); native work never waits on native work. Jobs: `loadTexture2D` decode, `loadGltf`
  reads/parsing/decoding, IBL BRDF reads, packaged `fetch` reads, audio device opens and decodes.
- Window scene preparation (texture uploads, environment, background, pipeline compilation) runs on native workers;
  Dawn needs implicit device synchronization. Geometry-output pipelines and worker-free builds prepare on the renderer thread.
- A device loss restarts the producer's renderer on the shared device, which it never destroys.
- Readiness requires the first complete published canvas frame. SDL_image calls are serialized across jobs and UI.
