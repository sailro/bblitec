# Native render backends

bblitec ships two peer GPU render backends over one semantic core:

| Backend | Stack | Role |
| --- | --- | --- |
| **Dawn** | WGSL → Dawn (Chrome's WebGPU) → D3D12, DXC | Reference-identical rendering: the same compiler and rasterization stack that produced the browser goldens |
| **SDL_GPU** | WGSL → pinned Tint → normalized HLSL → DXC → D3D12/Vulkan/Metal | Independent implementation over offline-compiled shaders |

Both consume the same generated render plans, uniforms, and vertex
packing (`native/src/pal_gpu_shared.hpp`), differ only at the GPU API
layer, and are measured against the same goldens — a scene is
integrated only when it passes on both, and [status](status.md)
publishes the two MAD columns. `BBLITE_GPU_BACKEND=dawn` selects Dawn
at runtime; SDL_GPU is the default. There is no third option: bblitec
requires a GPU, and a backend that cannot bring a device up throws
rather than degrading into something else.

Keeping both is the differential diagnostic: when a scene diverges from its
golden, agreement between the backends to one LSB puts the cause on the CPU
side (inputs, loaders, uniforms) and disagreement puts it on the GPU side
(state, compilation, rasterization). That is how a residual is attributed.

## Building and running

The full development bootstrap builds Dawn and Tint from the same pinned
commit (`upstream/tint.json`, one provenance for both):

```powershell
npm run dev:setup
npm run doctor
```

`pwsh -File tools\build-dawn.ps1` builds only the development Dawn artifact.
`tools/build-dawn-min.ps1` builds the separate static FXC-only shipping
artifact and is not used by development scene commands.

- Source checkout shared with Tint at `.cache/tint/dawn`, build tree
  `.cache/tint/build-dawn`. **Wipe the build tree when changing CMake
  options** — stale trees no-op silently.
- Configuration: monolithic `webgpu_dawn` shared library, D3D12
  backend, `DAWN_USE_BUILT_DXC=ON`, targets `webgpu_dawn` **and**
  `dxcompiler`, and `copy_dxil_dll`, installed to `artifacts/tools/dawn`.
- Deployment: `webgpu_dawn.dll`, Dawn's built `dxcompiler.dll`, and the
  Windows SDK `dxil.dll` selected by Dawn must sit beside the executable.
  Dawn loads the validator before the compiler and resolves both
  module-relative with hardened LoadLibraryEx flags, exactly as Chrome
  deploys them. The native CMake `POST_BUILD` step copies all three DLLs.
  FXC (`d3dcompiler_47.dll`) is not deployed: it is reached only when
  Dawn force-disables `use_dxc` on adapters below shader model 6, and
  the PAL preloads it from the executable directory or System32 (Dawn's
  own bare-name LoadLibraryEx fallback cannot reach System32 because
  `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` is invalid for relative names).
  An SDK copy placed beside the executable still takes priority.

The compiled backend set is the CMake `BBLITE_BACKEND` selection:
`SDL_GPU`, `DAWN`, or `BOTH`. Windows development scene commands default to
`BOTH` and require the installed pinned Dawn library; Linux and macOS default
to `SDL_GPU`. Set the `BBLITE_BACKEND` environment variable or pass `--backend`
to override (a single-backend
shape compiles the other backend out, `run_engine` defaults to the
compiled backend, and requesting an absent backend fails explicitly).
In `BOTH` builds, select at runtime:

```powershell
$env:BBLITE_GPU_BACKEND = "dawn"
npm run scene -- parity scene1
```

The parity harness forwards the environment and labels the report
with the active backend. `pal::run_engine` dispatches on
`BBLITE_GPU_BACKEND` and throws explicitly when a build lacks the
requested backend. One binary carries both backends, and one command
measures both — `scenes:parity` is `parity all --differential`, which
runs each backend in its own child process and adds the direct
backend-versus-backend diff:

```powershell
npm run scenes:parity
```

`scene -- parity <id> --differential` runs both backends and adds the
direct backend-versus-backend diff to `report-differential.json` —
the decisive diagnostic in one command. Scenes where Dawn is
structurally closer to the golden (the browser-compiler identity, the
multisampled scene-colour grab on transmission scenes) carry tighter
`dawnThresholds` in the registry so Dawn regressions cannot hide
under SDL_GPU-sized ceilings.

Parity artifacts are backend-suffixed (`report-gpu.json` /
`diff-map-gpu.png` for SDL_GPU, `-dawn` for Dawn), so both backends'
reports, diff maps, and hotspots coexist per scene. **Measure only
against a freshly processed build**: Dawn reads `*.native.wgsl` from
the build snapshot while SDL_GPU reads offline DXIL, so a snapshot that
mixes generations skews only the Dawn side and reads as a Dawn-only
residual.

## Retained UI

RmlUi projects the supported DOM/CSS and Canvas2D surface into one
backend-neutral draw frame. SDL_GPU and Dawn each own the corresponding
texture cache, upload path, multisample UI layer, resolve, and
premultiplied-alpha composition. Scene, frame-graph, sprite-only, and
standalone-effect loops use the same recorded frame.

Canonical screenshots include the UI layer. `BBLITE_CAPTURE_UI=0` copies the
scene before UI composition for canvas-only attribution while leaving the
presented interactive frame unchanged. The [native page UI](ui.md) page
defines the supported browser surface and layout adaptations.

The scene 1 attribution captures (draw-id buffer and triangle-cluster
buffer) render on either backend under the same environment switch;
their filenames carry the backend token like every other artifact. Dawn draws them through the shared
superset mesh bind-group layout with dedicated diagnostic pipelines
and requests the primitive-index device feature for the cluster
shader's `enable primitive_index`. Measured cross-backend agreement:
both buffers byte-identical.

## Backend comparison

Both backends render every expressible scene within its gate; the
differences that remain are structural.

**Parity.** The two backends sit within a rounding step of each other
on every measured scene: scene 259 is bit-exact on Dawn because the
browser's own compiler eliminates SDL_GPU's DXC-versus-browser
rounding; the transmission scenes keep a small Dawn edge (scene 33
foreground 0.010 versus 0.007) from the scene-colour grab, where
SDL_GPU copies the resolved opaque colour and the pin reads the
multisampled attachment; and HillValley and the Standard geometry MRTs
land closest on Dawn. Image processing is not part of that gap — the
vendored SDL patch lets SDL_GPU run the pinned per-sample pass — and
neither is line rasterization, which the overlay port's `MultisampleEnable`
fix closed ([measured contracts](#measured-contracts)).

**Performance.** Scene 1 (BoomBox), Release, 1280x720, 2000 frames
after adaptive warmup (min(120, max(10, frames/10))), immediate present, same session
(`BBLITE_BENCHMARK_FRAMES=2000`; frame CPU time across the whole loop
body — scene callbacks and uploads, surface acquire, submit and
present):

| Backend | Average | Median |
| --- | ---: | ---: |
| SDL_GPU | 0.127 ms | 0.085 ms |
| Dawn | 0.208 ms | 0.141 ms |

Dawn's ~60% higher CPU cost at this sub-millisecond scale comes from always-on
validation and robustness — which must stay on, since the browser reference
runs with both — and from uniform-buffer writes where SDL_GPU uses push
constants (per frame for mesh state, per draw for material blocks). Neither is
near a frame-budget concern for the corpus.

**Portability.** Dawn targets D3D12, Vulkan and Metal; bblitec's integration
is Windows-only by configuration, not architecture — one
`WGPUSurfaceSourceWindowsHWND` branch, one `backendType = D3D12` adapter
selection, the DXC DLL deployment, and the per-OS library build. Its shader
story needs **zero per-platform work**: generated WGSL feeds Dawn directly and
Dawn's internal Tint emits HLSL, SPIR-V or MSL. SDL_GPU inverts that — a
portable API layer, but each target needs the offline shader pipeline (DXIL
on Windows; SPIR-V recompiles normalized Tint HLSL through DXC as a stopgap;
MSL untested). Neither backend is validated off Windows, and the goldens are
Chrome on D3D12, so structural bit-parity on Vulkan or Metal would need
same-platform references. `scene -- process` defaults to D3D12 on Windows,
Metal on macOS, Vulkan elsewhere; `--shader all` is reserved for an explicit
portability sweep.

**Validation strictness.** WebGPU validates what D3D12 through
SDL_GPU tolerates: a depth-stencil pipeline drawing into a depth-less
pass runs on SDL_GPU and is rejected by Dawn, which is why the
shader-frame-graph gate carries an explicit depth-less pipeline
variant. Strictness costs integration effort (superset pipeline
layouts, device-limit requests derived from task records, per-variant
attachment states) and pays it back as an always-on conformance check.

**Startup model.** SDL_GPU loads the host-selected content-addressed offline
artifact — no compilation at startup, but processing must run the selected
shader toolchain and cache machinery. Dawn compiles WGSL at startup through the in-process
Tint+DXC — no offline step, no cache, no register normalization, at
the cost of first-frame compile time.

## Shared frame conductor

Everything that decides *what* a measured run does is written once in
`native/src/pal_gpu_shared.hpp` and consumed by both backends: `FrameOptions`
parses the runtime flag matrix, `CaptureGate` decides when the run may stop
(including the bounded grace period a deferred capture needs), `FrameClock`
produces the real, scene-fixed, or measured-run-overridden delta that scene
callbacks advance by, and `report_benchmark` prints the
comparison numbers. A backend that does not implement a flag refuses it rather
than rendering something else, because a silent no-op reads as a backend delta
and the differential would attribute it to the GPU stack.

The conductor also owns application `requestAnimationFrame` callbacks. It
preserves their registration phase around the engine render: pre-start
callbacks run before rendering-context updates, while callbacks registered
after awaited `startEngine` run after submission and update the following
frame. The first engine frame reports zero even under a fixed capture delta,
matching `startEngine`'s contract; the same fixed clock supplies their
`performance.now()` timestamp as a double-precision `DOMHighResTimeStamp`.
Keeping that value double end to end is observable in long-running interactive
sessions: narrowing an absolute monotonic millisecond clock to float produces
repeated timestamps and intermittent jumps. Recurring `setInterval` callbacks
also live on this conductor. They drain after post-render RAF and zero-delay
timeouts, run at most once per frame when due, retain their period-relative
next deadline after a late frame, and are removed by `clearInterval` without a
timer thread or a second platform loop.

The shared SDL event bridge also keeps the application-facing canvas extent
current. Resize and drawable-pixel events query backing-store pixels before
the next application callback, so a per-frame `canvas.width`/`canvas.height`
read sees the same size the SDL_GPU swapchain acquires. The scene-less Dawn
sprite driver reconfigures its WebGPU surface at that boundary and rebuilds
its layer projection against the new extent; maximize and restore therefore
resize content rather than exposing an unchanged frame surrounded by black.

The vertex, deformation, texture and diagnostic payloads live there too:
vertex packing, morph deltas and weights, image decode with the pinned
`invertY` flip, RGBD decode, half-float conversion both ways, cluster
numbering, and the alpha packing the diagnostic shaders read. Pipeline
construction, bind groups, pass encoding and swapchain handling stay per
backend — those API sequences are the mutually validating surface.

Nothing else crosses between the backends. Each owns its device mechanics in a
header only its own translation units include —
`pal_sdl_gpu_shared.hpp` (shader loading, buffer and texture upload, sampler
construction, PNG readback) and `pal_dawn_shared.hpp` (instance, surface,
adapter, device, swapchain bring-up, WGSL module loading). Each exists
because its backend carries two renderers, not because the backends have
anything in common: a scene that registers a `SpriteRenderer` and no
`SceneContext` generates no camera math and no render plan, so it cannot
compile the scene renderer's translation unit at all and draws from
`pal_sdl_gpu_sprite.cpp` or `pal_dawn_sprite.cpp` instead.
That split is upstream's own — a `SpriteRenderer` is its own `RenderingContext`
on the engine rather than part of a scene.
It can still coexist with one: the shared conductor walks rendering contexts
in registration order, so a renderer registered after a `SceneContext` opens
its single-sample load pass over the scene result and draws a pure-2D HUD
without joining the scene depth attachment. Both backends preserve the load
operation and ordering; the layer remains owned by the standalone sprite
pass.
Its projection is still derived from the canvas extent when its colour
attachment is an offscreen render texture. Both scene-owned and scene-less
backend loops pass the canvas width and height into sprite upload; the target
controls the attachment and viewport, not the coordinate system.

Depth-hosted Sprite2D layers are the deliberate other arm of that split.
They are attached to a `SceneContext`, so each backend builds their sprite
pipeline against the scene target's colour format, depth format, and sample
count, uploads them with the other contexts, and records depth-writing layers
inside the opaque stage. The separate `SceneSpritePass` /
`DawnSceneSpritePass` helpers keep that attachment-specific state out of the
standalone SpriteRenderer pass while reusing the same per-layer buffers,
textures, uniforms, and draw encoding.

The fullscreen-effect path takes the same shape and for the same reason: an
`EffectRenderer` is a rendering context on the engine, so its two halves live
in `pal_sdl_gpu_effect.hpp` / `pal_dawn_effect.hpp` and are drawn both by the
scene-less driver beside them and by the scene renderer's frame-graph effect
task. The pipeline is built against the *output target's* format and sample
count, which is what the pin's own `targetSignatureKey` cache is keyed by, so
one wrapper drawn into two targets builds two passes. The two backends resolve
its bind group differently for the standing reason: SDL_GPU binds by the
`.slots` sidecar and Dawn by the descriptor's own binding numbers — the
sidecar contract is [below](#dawn-backend-architecture-nativesrcpal_dawncpp).

The scene-less frame graph is a third rendering-context driver, split into
`pal_sdl_gpu_frame_graph.cpp` and `pal_dawn_frame_graph.cpp`. It owns ordered
render-target effect and post-process tasks without linking either scene
renderer. Render-target resources are generated once and shared with
scene-owned graphs; preprocessor guards remove an unreached task family from
the driver, including its generated headers, pipelines, samplers, and state.

Deleting a backend stays a matter of dropping its files. `BBLITE_BACKEND`
removes every translation unit belonging to the backend it turns off,
including its sprite, effect, and scene-less frame-graph passes, and each entry point compiles to a
stub that returns false, so the other backend keeps rendering every feature
the scene reached.

## Measured contracts

Regression guards, each measured rather than assumed:

- **Shader compiler identity is the parity linchpin.** Dawn
  hard-forces `use_dxc` off unless the library is compiled with
  `DAWN_USE_BUILT_DXC` (`PhysicalDeviceD3D12.cpp` ForceSet), and the
  `dxcompiler` CMake target must be built separately and its DLL
  deployed beside `webgpu_dawn.dll`. FXC in place of DXC carries a
  systemic -1 LSB on lit surfaces (scenes 259/248) plus larger filter
  and discard deltas (248/249); DXC carries none of it.
- **A multisampled target needs D3D12's `MultisampleEnable`, and only Dawn
  set it.** Dawn derives it from the pipeline's sample count; SDL's D3D12 backend
  hardcoded `FALSE`. On lines, SDL_GPU at 4x was pixel-identical to SDL_GPU at
  one sample and to Dawn at one sample, isolating the flag from the scene, the
  shaders and the uniforms. The vendored overlay port carries the one-line fix
  beside libsdl-org/SDL#15838; scenes 278 and 279 measure 0.000 on both
  backends with it.
  **It reaches more than lines here, which the flag's own documentation says
  it should not.** Microsoft's `D3D12_RASTERIZER_DESC` page states that above
  feature level 10.1 the setting "has no effect on points and triangles with
  regard to MSAA and impacts only the selection of the line-rendering
  algorithm" — then recommends setting it `TRUE` on MSAA targets anyway. Two
  line-free scenes, A/B against a rebuild of SDL with the patch dropped: scene
  8 is 0.000/0.000 with it and 0.001/0.001 without, scene 14 is 0.012/0.006
  with it and 0.013/0.009 without. This port therefore takes the flag as
  affecting triangle edges too on the measured device (RTX 4090, driver
  32.0.16.1088) and reports the pair upstream.
- **The `.env` RGBD cubemap Y-flip is pinned behavior**, not an SDL
  adaptation: upstream `uploadCubemapRGBD` documents "BJS uploads
  cubemap faces with invertY=true"; uploading unflipped costs scene 1
  0.89 MAD.
- The registry `backgroundColor` values are region-keying colors, not
  exact clear values (scene 2's actual background is 76, not 77).
- **Scene 243's baked-AO occlusion is the dedicated uv2 texture
  pair** — an `occlusionTexture` on TEXCOORD_1 without a
  metallic-roughness image binds through its own pair sampled at uv2,
  canonical in [fidelity](fidelity.md). The instrumented differential
  capture that establishes it ships as `scene -- capture` (see
  [development](development.md#instrumented-browser-capture)). The same
  captures measure the native baked-vertex-mirror adaptation as identical
  to the browser's world-matrix mirror to ~1e-5 px, which is why it
  stands.
- **Scene 247 is three shading contracts, none of them instancing
  arithmetic**: texture-less PBR factors shade quantized through the
  pinned factor-texture bake (base color as sRGB bytes whose hardware
  decode is the reference), TRS and world matrices compose in
  JavaScript doubles rounded once at the float32 store (all 1899
  captured thin-instance matrices are bit-identical), and environment
  horizon occlusion composes only for normal-mapped materials. Each
  contract is canonical in [fidelity](fidelity.md).
- **A depth texture and a comparison sampler declare untemplated in HLSL,
  and the slots sidecar has to see them.** Tint emits a `texture_depth_2d`
  as a bare `Texture2D` and its comparison sampler as
  `SamplerComparisonState`, neither of which the sidecar's declaration
  match originally accepted — so both were silently dropped from the
  receiver's `.slots`, and the storage rebase counted one texture short as
  well. Scene 18 is the first stage in the tree to declare either;
  every other generated stage uses the templated forms, so the widened
  match adds rows and moves none.
- **Scene 33's backend delta is the scene-colour grab.** SDL_GPU runs
  the pinned per-sample image-processing fragment at 4x through the
  vendored SDL patch, leaving the foreground step (0.010 versus 0.007) to the
  grab alone. A single-sample run separates the two: the per-sample-versus-
  resolved distinction disappears there, so a delta that collapses is the
  image-processing pass. Scene 1's delta is 0.000/0.001 at *both* sample
  counts, so what remains there is not multisampling.
- **The single-sample diagnostic reaches the frame-graph scenes too.**
  At one sample a resolve step becomes a copy on both backends
  (scenes 116, 145 and 146): with nothing to average, the resolve of a
  single-sample source is the source.

## Dawn backend architecture (`native/src/pal_dawn.cpp`)

Every semantic layer is shared with SDL_GPU: `upstream::build_render_plan`,
`build_view_projection`, `build_pbr_uniforms`,
`build_background_plan/uniforms`, `build_skybox_plan/uniforms`,
`sort_transparent_draws`, the generated
`upstream::inverse_image_processed_channel` (the pin's linear-frame clear-colour
inverse, translated whole from its declaration), and the vertex packing and
decode helpers in `native/src/pal_gpu_shared.hpp` (`GpuVertex`,
`transformed_vertices`, `decode_rgbd`, `float_to_half`,
`build_deformation_uniforms`). Only the GPU API layer differs.

- **Shaders**: `*.native.wgsl` goes from the snapshot shader directory to
  `wgpuDeviceCreateShaderModule` unchanged — no DXC, no register
  normalization, no shader cache. The `@group` scheme maps natively: 0 = vertex
  storage buffers (morph), 1 = vertex uniform (`viewProjection`), 2 =
  texture/sampler pairs at bindings `2n`/`2n+1` in SDL slot order, 3 = fragment
  uniform.
- **Pipelines**: lazy per `upstream::RenderPipelineKind`, keyed also by sample
  count and depth presence for render-task targets. Mesh pipelines outside the
  composed variants (grid, custom shader variants, diagnostics, depth-only)
  share one explicit superset layout — WebGPU permits bindings a shader ignores
  — so their bind groups stay interchangeable; composed variants build a layout
  per variant. Transparent blend is colour SrcAlpha/OneMinusSrcAlpha, alpha
  One/OneMinusSrcAlpha, depth writes off (opaque: on). The compare is the pin's
  `REVERSE_DEPTH_COMPARE`, lowered once into `upstream::pinned_depth_compare`.
  Anything unimplemented throws.
- **Uniforms**: WebGPU has no push constants, so every block SDL_GPU pushes
  arrives through `wgpuQueueWriteBuffer`. The two per-mesh vertex blocks
  (deformation, instance parent world) are rewritten once per frame by a
  mesh-sync pass over the plan's items — the SDL loop's walk and skip logic —
  and per-draw mesh and material blocks are written with their draws, each
  owning buffers sized to its blocks. A Standard draw keys blocks and bind
  group by *material*, not mesh: a per-pass material override
  (`addMesh(mesh, { material })`) reuses the mesh's item, so both draws arrive
  as one mesh, and since every queue write lands before submission a per-mesh
  buffer would let the override poison the main pass. SDL_GPU pushes per draw
  and needs no key. Scene 110 measures both. PBR and node families key by mesh;
  no reached scene overrides one in a colour pass.
- **Deformation, instancing, storage morph**: the shared `GpuVertex`
  deformation layout (16 attributes / 200 bytes; composed variants append an
  integer joint-index lane, 216) feeds locations 8-15, with
  `build_deformation_uniforms` writing a per-mesh uniform at group 1 binding 1
  each frame. Instancing adds the per-instance matrix-column vertex buffer
  (slot 1, locations 16-19), which needs `maxVertexAttributes` raised to 20 at
  device creation since the SDL-specialized layout exceeds WebGPU's default 16,
  plus the parent-world uniform at the next group-1 binding. Storage morphing
  binds the flat 6-float delta buffer and 16-byte-header weights buffer at
  group 0 bindings 0/1 with 4- and 16-byte zero fallbacks; weights rewrite in
  place when `morph_weights_version` changes. Generation validates pinned node
  variants' reflected morph names at their allocated slots; SDL resolves its
  sidecar names while Dawn consumes the emitted numeric slots. Both therefore
  attach those same per-mesh buffers (or zero fallbacks) even when compacted
  node bindings do not occupy the PBR path's numeric slots.
- **Pinned material variants**: both backends execute Babylon's composed stages
  for every PBR and Standard draw (`variant-*.native.wgsl`,
  `variant-std-*.native.wgsl`, entered at `main`, text unchanged). Selection is
  shared in `pal_gpu_shared.hpp`: `pinned_variant_for_draw` keys a PBR draw per
  renderable, light mode, tone flag and geometry task;
  `standard_variant_for_draw` keys a Standard draw on the pin's feature word
  (the generated `standard_material_features`), the per-renderable mesh bits and
  the geometry task — light count and per-mesh light lists are UBO data the
  fragments loop over, not composition keys. A draw resolving no variant is an
  error naming its mesh and material; the transcribed material pipelines are
  deleted.

  The pin's scheme is group 0 = scene and lights, group 1 = mesh block,
  material block, then that variant's densely numbered textures. One index
  names a different texture in two variants, so Dawn builds a bind-group layout
  per variant from the generated binding table, and SDL_GPU takes its
  addressing from `Remap-PinnedVariantRegisters` in
  `tools/compile-shaders.ps1`, which moves each register class into the SDL
  spaces and publishes a `.slots` sidecar.

  Every compiled stage has a sidecar, not only the pinned variants: this
  repository's own specialized stages go through a normalizer that publishes
  the same file, because a stage's contents depend on scene code the moment
  the caller's WGSL decides which declarations survive — a custom sprite
  fragment declares both a layer block and an `fx` block, and a shader
  material's stages are the same case. SDL_GPU resolves each surviving register
  back to the slot `setShaderTexture` stored; Dawn compiles the deployed WGSL
  and takes the declared order. A stage whose emitted HLSL exceeds SDL_GPU's
  four uniform buffers — a composed geometry fragment of either family spends
  all four on scene, lights, mesh and mat before the tasks' `gp` block, which a
  second light reaches — is recompiled with `gp` demoted to a read-only storage
  buffer (an `r` row; the SDL PAL binds the task's params buffer against it and
  declares it in the root signature, or D3D12 refuses the pipeline for an
  unbound SRV range), while Dawn keeps the pin's uniform declaration.

  The PAL binds by the sidecar, never by the WGSL. A stage may declare a block
  it never reads — the unlit fragment declares its mesh block for `mli()`, and
  a custom sprite body owning its alpha reads neither block it is offered — and
  Tint strips it, so the source over-counts; the compaction that follows is
  dense, so a dropped block takes its slot and everything behind it shifts. The
  assigning pass is the only authority, which is why the Tint reflection
  cross-check asserts that every binding Tint kept was declared, and not the
  reverse.

  Vertex convention, the glTF family's X-mirror: an unskinned pinned draw reads
  the unmirrored buffer with `diag(-1,1,1,1)` in the mesh block; a skinned draw
  reads the mirrored buffer with the identity, because the palette is the
  mirror-conjugated `jointWorld * IBM` and either other pairing mirrors twice.
  A thin-instanced or LOCAL_POSITION draw takes the real node world
  (`pinned_draw_world` carries the chain), the instance stream holding matrix
  bytes paired with that convention and the LOCAL_POSITION arm binding the
  vertex's raw local lanes. The Standard family carries no mirror: identity
  world, the thin-instance arm the pin's `mesh.world * instanceWorld` with the
  recorded parent TRS, the LOCAL_POSITION geometry arm the recorded node world
  over raw local lanes.
- **Shadows**: the caster pass is a depth-only render task over the generator's
  `depth32float` map, rendered from the light's biased view-projection through
  the composed no-colour variants at standard-Z (`less-equal`, cleared to 1)
  and one sample. A receiving draw binds the pin's group 2 — map, comparison
  sampler, receiver block — built once per frame graph and shared across
  receivers, the cache `rebuildSingle` keys by layout. Dawn builds that layout
  from the generator count (three bindings per light, in `scene.lights` order)
  rather than by reflection, since `createShadowFragment` fixes the shape;
  SDL_GPU binds it from the sidecar, where the receiver block is an `r` row
  because the demotion moved it past the four-uniform cap.
- **Frame graph**: tasks replace the main pass exactly as the SDL task loop
  does. Colour render tasks draw their `build_render_task_draw_lists` lists
  into render targets with pipelines selected by sample count and depth
  presence. A compiler-owned default colour task also replays the scene
  renderer's skybox order before those lists and ground after them; an
  application-created task remains list-only. Depth-only tasks draw the explicit no-colour meshes with depth
  writes on; geometry tasks bind one MRT per attachment
  (`geometry_clear_color` clears, optional output target last, resolve on
  multisample), Standard and PBR draws going through their pin-composed MRT
  variants under the same convention and frame matrix as everything else — the
  `gp` block per task, demoted to a fragment storage buffer on SDL_GPU, and
  stored rather than discarded when a later task borrows the depth. Copy tasks
  either resolve in an empty pass or run the generated fullscreen blit with the
  integer `resolve_copy_viewport` viewport and scissor; a swapchain copy
  records its source as the capture texture. Sampled depth attachments copy
  into an r32float texture after their task (float32-filterable is requested as
  the pinned engine requests it) so standard emissive slots read them exactly
  like SDL's D3D12 depth SRVs — r = depth, g/b = 0, a = 1 — through the nearest
  sampler. Device limits derive from the task records at creation:
  `maxColorAttachmentBytesPerSample` from the WebGPU render-target byte costs
  (the entry's `requiredLimits` option is compile-time erased),
  `maxVertexAttributes` 20 under instancing.
- **Transmission**: the frame renders in linear rgba16float 4x MSAA with the
  inverse-image-processed clear, keeping the multisampled texture. At the first
  transmissive draw the pass breaks exactly as the pinned render task breaks:
  the scene colour grabs from the multisampled attachment through the pinned
  sample-averaging manual bilinear blit into the 1024x1024 rgba16float
  refraction texture (full chain minus the fixed 4-mip LOD bias,
  blit-generated mips), then the pass resumes loading colour and depth. The
  scene-colour slot binds that texture through the pinned repeat trilinear
  anisotropic-4 sampler. The final pass applies exposure, optional tonemap,
  gamma and contrast per MSAA sample and averages — the pin's own
  image-processing stages, deployed as `image-processing-samples.*.native.wgsl`.
- **Frame**: 4x MSAA colour (surface format) resolving into the surface
  texture, `depth24plus-stencil8` (the browser's format, not SDL's D32),
  stage-driven draw order (skybox, opaque, transparent, ground). The surface is
  configured `RenderAttachment | CopySrc`; capture copies the resolved surface
  texture into a mapped buffer (256-aligned rows) and saves via SDL_image. The
  loop honours `BBLITE_MAX_FRAMES`, `BBLITE_SCREENSHOT(_FRAME)`,
  `BBLITE_TEST_PASS`, `BBLITE_ANIMATION_SEEK_SECONDS`,
  `BBLITE_BENCHMARK_FRAMES` and the capture grace period. Runtime mesh appends
  wait for submitted work, rebuild the mesh set from a fresh render plan, and
  defer capture one frame like the SDL backend.
- **Device**: futures API with `TimedWaitAny`; the `use_dxc` adapter toggle is
  chained to the adapter request; validation and robustness stay at defaults
  (the browser has both on); uncaptured device errors are captured and thrown
  at frame end.

## Ported pinned contracts

Each is derived from the pinned tree and is the authority if a
regression appears:

- **Mip generation** (`src/texture/generate-mipmaps.ts`): WebGPU has no
  built-in mipmaps; the browser blits mip N-1 → N with a fullscreen
  triangle and a bilinear clamp sampler. The blit stages are lifted
  from the pin's own `BLIT_SHADER` literal at generation and deploy as
  `mip-blit.*.native.wgsl` beside every other module — the transmission
  grab and per-sample image-processing stages ship the same way, lifted
  from the pin's literals rather than living as C++ strings. Every
  material texture gets the full chain
  `1 + floor(log2(max(w,h)))`; sRGB correctness comes from the texture
  format (`rgba8unorm-srgb` for base color/emissive on PBR).
- **Compressed textures** (`ktx-loader.ts` uploadCompressed): a KTX or
  transcoded Basis slot uploads the container's own blocks and its own mip
  chain — no decode, no blit-generated chain, and no sRGB choice, because
  the format the file states is the view. Both backends translate the pin's
  own WebGPU format name and copy each level at the block-padded extent the
  pin computes (`ceil(w / blockW) * blockW`), which is what a tail mip
  smaller than one block needs. Dawn additionally requests
  `texture-compression-bc` at device creation, beside float32-filterable and
  primitive-index, mirroring the pinned engine's own opportunistic feature
  list. Because that request is opportunistic, an adapter reporting no block
  compression reaches the upload, so each backend refuses it there by name —
  Dawn on the adapter feature, SDL_GPU through
  `SDL_GPUTextureSupportsFormat`.
- **glTF samplers** (`gltf-sampler-desc.ts`): wrap 33071→clamp,
  33648→mirror, else repeat; min/mip filters from the combined enum;
  non-mipmap min filters mean "sample mip 0 only" → `lodMaxClamp 0`;
  anisotropy 4 only when mag/min/mip are all linear and not noMip;
  addressing W and `lodMaxClamp` otherwise stay at WebGPU defaults.
- **Texture slots** (six pairs, group 2): base color,
  specular/metallic-roughness, opacity/normal, ambient/emissive,
  reflection-or-environment cube, standard-emissive-or-BRDF. Fallbacks:
  white (base/mr), white or flat-normal 128/128/255 (slot 2),
  white or black-by-emissive-factor (slot 3), black cube, black or
  zero-rgba16f LUT. The BRDF LUT samples through a clamp sampler; the
  environment cube through a repeat trilinear sampler (the pinned
  `getTrilinearSampler` is clamp-addressed, but cube sampling ignores
  addressing on D3D12 and the repeat binding is SDL-validated).
  When `BBLITE_RENDERER_TRANSMISSION` is compiled, the scene-color/
  transmission/thickness trio follows (the scene-color pair binds the
  grab texture when transmission runs and the base color as an inert
  stand-in otherwise); reached material-extension pairs append next in
  the generated `material_texture_slots.hpp` row order — the one copy
  of each slot's record field, sRGB rule, fallback texel and pinned
  binding names, translated by both backends (clearcoat/roughness
  white, coat normal 128/128/255, sheen color sRGB white, sheen
  roughness white, iridescence pairs sRGB white, dedicated uv2
  occlusion linear white). The Standard bump and 2D reflection pairs
  append last, reached only through the composed Standard variants'
  generated slot indices.
- **`.babylon` reflection cubes** (pinned `loadCubeTexture`): rgba8unorm
  faces with the full blit-generated mip chain rendered one face at a
  time; standard materials resolve `material.reflection_cube` into
  `engine.reflection_cubes` with the black-cube fallback retained.
- **Environment cube**: rgba16f with pre-baked mips.
  `specular_rgba16f` faces upload raw and unflipped; RGBD faces decode
  `pow(rgb, 2.2) / max(a, 1/255)` to half floats and upload
  **Y-flipped** (pinned `uploadCubemapRGBD`). Fallback face
  {0.15, 0.16, 0.2, 1}.
- **BRDF LUT**: rgba16f raw when compiled, otherwise RGBD-decoded from
  the PNG with `flipY: false`.
- **DDS skybox**: rgba16f payload at `skybox_data_offset`, face-major
  mip-minor, no flips; cube of 8 vertices/36 indices from
  `build_skybox_plan`; cull back (the pinned
  `createDefaultPipelineDescriptor` default the background skyboxes take, as
  against the `"none"` the image skybox asks for), blend off, depth writes off; the
  environment-cubemap arm uses `build_skybox_view_projection`, while the DDS
  arm takes the pinned dedicated vertex stage with the local cube, scene
  view-projection, and root-position world matrix kept as separate shader
  inputs so its world-position dither seed retains the pin's interpolation;
  `SkyboxUniforms` from `build_skybox_uniforms(environment,
  transmission_enabled)`.
- **Ground**: quad from `build_background_plan`, `pbr.vert` +
  `background-ground.frag`, blend One/OneMinusSrcAlpha on both
  channels, depth writes off, clamp sampler with `lodMaxClamp 0`,
  linear ground texture with mips, `BackgroundUniforms` per frame,
  drawn in the `ground` stage (last).
