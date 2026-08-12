# Native render backends

bblitec ships two peer GPU render backends over one semantic core:

| Backend | Stack | Role |
| --- | --- | --- |
| **Dawn** | WGSL → Dawn (Chrome's WebGPU) → D3D12, DXC | Reference-identical rendering: the same compiler and rasterization stack that produced the browser goldens |
| **SDL_GPU** | WGSL → pinned Tint → normalized HLSL → DXC → D3D12/Vulkan/Metal | Independent implementation over offline-compiled shaders |

Both consume the same generated render plans, uniforms, and vertex
packing (`native/src/pal_gpu_shared.hpp`), differ only at the GPU API
layer, and are measured against the same goldens. Every scene either
backend can express passes on both, with Dawn equal to or better than
SDL_GPU everywhere (see the two MAD columns in [status](status.md)).
`BBLITE_GPU_BACKEND=dawn` selects Dawn at runtime; SDL_GPU is the
default. The SDL_Renderer CPU fallback is unrelated to either.

Keeping both is deliberate: two independent compiler and API stacks
that must agree pixel-for-pixel are a differential diagnostic no
single backend provides. When a scene diverges from the golden,
diffing the backends against each other isolates the cause
immediately — agreement to one LSB puts the divergence on the CPU
side (inputs, loaders, uniforms), disagreement puts it on the GPU
side (state, compilation, rasterization). Every residual attribution
in the migration was settled this way.

## Building and running

The Dawn library builds once from the same pinned commit as the Tint
shader compiler (`upstream/tint.json`, one provenance for both):

```powershell
pwsh -File tools\build-dawn.ps1
```

- Source checkout shared with Tint at `.cache/tint/dawn`, build tree
  `.cache/tint/build-dawn`. **Wipe the build tree when changing CMake
  options** — stale trees no-op silently.
- Configuration: monolithic `webgpu_dawn` shared library, D3D12
  backend, `DAWN_USE_BUILT_DXC=ON`, targets `webgpu_dawn` **and**
  `dxcompiler`, installed to `artifacts/tools/dawn`.
- Deployment: `webgpu_dawn.dll`, Dawn's built `dxcompiler.dll`,
  `dxil.dll`, and the SDK `d3dcompiler_47.dll` (FXC fallback) must sit
  beside the executable; Dawn resolves them module-relative with
  hardened LoadLibraryEx flags, exactly as Chrome deploys them. The
  native CMake `POST_BUILD` step copies all four.

The compiled backend set is the CMake `BBLITE_BACKEND` selection:
`SDL_GPU`, `DAWN`, or `BOTH`. `scene-command` passes `BOTH` whenever
the installed Dawn library exists and `SDL_GPU` otherwise; set the
`BBLITE_BACKEND` environment variable to override (a single-backend
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
requested backend. One binary carries both backends, so the full
matrix runs on both with two invocations of the same command — with
current builds the complete dual sweep takes about three minutes:

```powershell
npm run scenes:parity
$env:BBLITE_GPU_BACKEND = "dawn"; npm run scenes:parity
```

Parity artifacts are backend-suffixed (`report-gpu.json` /
`diff-map-gpu.png` for SDL_GPU, `-dawn` for Dawn, `-cpu` for the
SDL_Renderer fallback), so both backends' reports, diff maps, and
hotspots coexist per scene. **Measure only against a freshly processed
build**: Dawn reads `*.native.wgsl` from the build snapshot while
SDL_GPU reads offline DXIL, so a snapshot that mixes generations
skews only the Dawn side (this masqueraded as scene 248/249
"residuals" until reprocessing removed them).

## Honest comparison

Both backends render every expressible scene within its gate; the
differences that remain are structural.

**Parity.** Dawn is equal to or better than SDL_GPU on all 50
measured scenes. Where it wins, the wins are structural: scene 259 is
bit-exact on Dawn because the browser's own compiler eliminates
SDL_GPU's DXC-versus-browser rounding; the transmission family drops
an order of magnitude (scene 33 foreground 1.457 → 0.123, the
IOR/volume/scene-color gates from 0.130-0.166 to 0.002-0.005)
because Dawn expresses the pinned per-sample image processing and
multisampled scene-color grab that SDL_GPU's resolve-then-process
adaptation cannot; HillValley and the Standard geometry MRTs also
land measurably closer.

**Performance.** Scene 1 (BoomBox), Release, 1280x720, 2000 frames
after 30 warmup, immediate present, same session
(`BBLITE_BENCHMARK_FRAMES=2000`; frame CPU time from surface acquire
through submit and present):

| Backend | Average | Median |
| --- | ---: | ---: |
| SDL_GPU | 0.192 ms | 0.155 ms |
| Dawn | 0.229 ms | 0.179 ms |

Dawn's ~15-20% higher CPU cost at this (sub-millisecond) scale comes
from always-on validation and robustness — which must stay on, since
the browser reference runs with both — and per-draw uniform-buffer
writes where SDL_GPU uses push constants. Neither backend is close to
being a frame-budget concern for the corpus.

**Portability.** Dawn the library targets D3D12, Vulkan, and Metal;
bblitec's integration is Windows-only today by configuration, not
architecture — the platform-specific surface is one
`WGPUSurfaceSourceWindowsHWND` branch, one `backendType = D3D12`
adapter selection, the DXC DLL deployment, and the per-OS library
build. Its shader story needs **zero per-platform
work**: the generated WGSL feeds Dawn directly and Dawn's internal
Tint emits HLSL, SPIR-V, or MSL itself. SDL_GPU inverts that: the
API layer is portable, but each target needs the offline shader
pipeline (DXIL today; SPIR-V still recompiles normalized Tint HLSL
through DXC as a stopgap; MSL untested). Neither backend has ever
executed on a non-Windows machine, and the goldens are Chrome on
D3D12 — Dawn on Vulkan/Metal shares the front-end but not the
backend codegen, so structural bit-parity there would need
same-platform references.

**Validation strictness.** WebGPU validates what D3D12 through
SDL_GPU tolerates. The shader-frame-graph audit drew with
depth-stencil pipelines into a depth-less pass for as long as the
SDL_GPU backend existed; Dawn rejected it and forced the explicit
depth-less pipeline variant. Strictness costs integration effort
(superset pipeline layouts, device-limit requests derived from task
records, per-variant attachment states) and pays it back as an
always-on conformance check.

**Startup model.** SDL_GPU loads content-addressed offline DXIL — no
compilation at startup, but generation must run DXC and the shader
cache machinery. Dawn compiles WGSL at startup through the in-process
Tint+DXC — no offline step, no cache, no register normalization, at
the cost of first-frame compile time.

## Empirical findings

Regression guards from the migration; each was measured, not assumed:

- **Shader compiler identity is the parity linchpin.** Dawn
  hard-forces `use_dxc` off unless the library is compiled with
  `DAWN_USE_BUILT_DXC` (`PhysicalDeviceD3D12.cpp` ForceSet), and the
  `dxcompiler` CMake target must be built separately and its DLL
  deployed beside `webgpu_dawn.dll`. With FXC instead of DXC, a
  systemic -1 LSB appeared on lit surfaces (scenes 259/248) plus
  larger filter and discard deltas (248/249); with DXC all of it
  vanished.
- **The `.env` RGBD cubemap Y-flip is pinned behavior**, not an SDL
  adaptation: upstream `uploadCubemapRGBD` documents "BJS uploads
  cubemap faces with invertY=true". Uploading unflipped cost scene 1
  0.89 MAD; flipping restored 0.001.
- The registry `backgroundColor` values are region-keying colors, not
  exact clear values (scene 2's actual background is 76, not 77).
- **The scene 243 "silhouette floor" was a feature gap, not
  arithmetic.** Five suspects were eliminated by experiment
  (evaluation place, shader codegen, rasterization, input precision,
  pose timing) before instrumented browser captures — hooked
  `createShaderModule`, buffer and texture uploads, and render-bundle
  draws — proved the weights, morph deltas, geometry, and matrices
  bit-identical and localized the entire residual band to the
  platform slab draw. The cause: the slab's baked-AO
  `occlusionTexture` on TEXCOORD_1, which the native material
  pipeline silently dropped (and the native glTF loader never read
  TEXCOORD_1 at all). Porting the pinned dedicated uv2 occlusion pair
  took the scene from 1.043 to 0.052 foreground MAD on both backends,
  and the scene-247 findings below (factor quantization and the
  normal-map horizon-occlusion gate) closed the rest to 0.005.
  The instrumented differential capture is the repeatable lesson —
  it now ships as `scene -- capture` (see
  [development](development.md#instrumented-browser-capture)) — and
  it also proved reverse-Z versus the native forward-Z adaptation and
  the browser's world-matrix mirror versus the native baked-vertex
  mirror produce identical images to ~1e-5 px, so those adaptations
  stay.
- **The scene 247 instancing floor dissolved under the same
  instrumented capture.** Three stacked causes, none of them
  instancing arithmetic: texture-less PBR factors shade quantized in
  the browser (the pinned factor-texture bake, with base color baked
  as sRGB bytes whose hardware decode is the reference — a CPU
  transcription of the decode was measurably off), the browser
  composes TRS and world matrices in JavaScript doubles rounded once
  (native now matches — all 1899 captured thin-instance matrices are
  bit-identical), and environment horizon occlusion is composed only
  for normal-mapped materials (native applied it unconditionally,
  dimming metallic silhouette speculars by one MSAA sample step —
  the dominant term). 0.405 → 0.014 foreground MAD on both backends;
  the old float32-versus-float64 world-composition attribution was
  wrong, and the same contracts took scene 255 from 0.101 to 0.000.

## Dawn backend architecture (`native/src/pal_dawn.cpp`)

The backend reuses every semantic layer the SDL_GPU backend uses:
`upstream::build_render_plan`, `build_view_projection`,
`build_standard_uniforms`, `build_pbr_uniforms`,
`build_background_plan/uniforms`, `build_skybox_plan/uniforms`,
`sort_transparent_draws`, and the shared vertex packing and decode
helpers in `native/src/pal_gpu_shared.hpp` (`GpuVertex`,
`transformed_vertices`, `decode_rgbd`, `float_to_half`,
`build_deformation_uniforms`, `inverse_image_processed_channel` —
extracted from the SDL backend, which was re-verified byte-identical
afterwards). Only the GPU API layer differs:

- **Shaders**: the generated `*.native.wgsl` files are read from the
  snapshot shader directory and handed to
  `wgpuDeviceCreateShaderModule` unchanged — no DXC invocation, no
  register normalization, no shader cache. The WGSL `@group` scheme maps
  natively: group 1 = vertex uniform (`viewProjection`), group 2 =
  texture/sampler pairs at bindings `2n`/`2n+1` in the SDL slot order,
  group 3 = fragment uniform, group 0 = vertex storage buffers (morph).
- **Pipelines**: created lazily per `upstream::RenderPipelineKind`,
  additionally keyed by sample count and depth presence for
  render-task targets. Every mesh pipeline (main, task, geometry)
  shares one explicit superset pipeline layout — WebGPU permits
  layout bindings a shader ignores — so mesh bind groups stay
  interchangeable across shader variants. Blend for transparent:
  color SrcAlpha/OneMinusSrcAlpha, alpha One/OneMinusSrcAlpha, depth
  LESS_EQUAL with writes off (opaque: LESS with writes on). Anything
  unimplemented throws — explicit failure, never approximation.
- **Uniforms**: WebGPU has no push constants; each draw owns a uniform
  buffer sized to its family's uniform struct, written per frame with
  `wgpuQueueWriteBuffer` before submission.
- **Deformation/instancing/storage morph**: the shared 200-byte
  16-attribute `GpuVertex` layout feeds locations 8-15; the shared
  `build_deformation_uniforms` writes a per-mesh uniform at group 1
  binding 1 each frame. Instancing adds the per-instance
  matrix-column vertex buffer (slot 1, locations 16-19, which needs
  `maxVertexAttributes` raised to 20 at device creation — the
  SDL-specialized layout exceeds the WebGPU default of 16) plus the
  parent-world uniform at the next group-1 binding. Storage morphing
  binds the flat 6-float delta buffer and 16-byte-header weights
  buffer at group 0 bindings 0/1 with 4-byte/16-byte zero fallbacks;
  weights rewrite in place when `morph_weights_version` changes.
- **Frame graph**: tasks replace the main pass exactly like the SDL
  task loop. Color render tasks draw their
  `build_render_task_draw_lists` lists into render targets with
  pipelines selected by sample count and depth presence; depth-only
  tasks draw the explicit no-color meshes through GREATER-compare
  pipelines with the reverse-depth matrix and depth cleared to zero;
  geometry tasks bind one MRT per attachment (`geometry_clear_color`
  clears, optional output target last, resolve on multisample) with
  the per-task `pbr-geometry-N.frag`/`standard-geometry-N.frag`
  modules; copy tasks either resolve in an empty pass or run the
  generated fullscreen blit with the integer `resolve_copy_viewport`
  viewport+scissor, and a swapchain copy records its source as the
  capture texture. Sampled depth attachments copy into an r32float
  texture after their task (float32-filterable is requested like the
  pinned engine) so standard emissive slots read them exactly like
  SDL's D3D12 depth SRVs (r = depth, g/b = 0, a = 1), through the
  nearest sampler. Device limits are derived from the task records at
  creation: `maxColorAttachmentBytesPerSample` from the WebGPU
  render-target byte costs (the entry's `requiredLimits` option is
  compile-time erased), `maxVertexAttributes` 20 under instancing.
- **Transmission**: the frame renders in linear rgba16float 4x MSAA
  with the inverse-image-processed clear, keeping the multisampled
  texture. At the first transmissive draw the pass breaks exactly like
  the pinned render task: the scene color grabs straight from the
  multisampled attachment through the pinned sample-averaging manual
  bilinear blit into the 1024x1024 rgba16float refraction texture
  (full chain minus the fixed 4-mip LOD bias, blit-generated mips),
  then the pass resumes loading color and depth. The scene-color slot
  binds that texture through the pinned repeat trilinear anisotropic-4
  sampler. The final pass applies exposure, optional tonemap, gamma,
  and contrast per MSAA sample and averages — the pinned
  image-processing task transcribed verbatim.
- **Frame**: 4x MSAA color (surface format) resolving into the surface
  texture, `depth24plus-stencil8` (the browser's format — not the SDL
  backend's D32), stage-driven draw order (skybox → opaque →
  transparent → ground). The surface is configured
  `RenderAttachment | CopySrc`; capture copies the resolved surface
  texture into a mapped buffer (256-aligned rows) and saves via
  SDL_image. The frame loop honors `BBLITE_MAX_FRAMES`,
  `BBLITE_SCREENSHOT(_FRAME)`, `BBLITE_TEST_PASS`,
  `BBLITE_ANIMATION_SEEK_SECONDS`, `BBLITE_BENCHMARK_FRAMES`, and the
  capture grace period. Runtime mesh appends wait for submitted work,
  rebuild the mesh set from a fresh render plan, and defer capture one
  frame like the SDL backend.
- **Device**: futures API with `TimedWaitAny`; the `use_dxc` adapter
  toggle is chained to the adapter request; validation and robustness
  stay at defaults (the browser has both on); uncaptured device errors
  are captured and thrown at frame end.

## Ported pinned contracts

These were re-derived from the pinned tree during the port; each is
the authority if a regression appears:

- **Mip generation** (`src/texture/generate-mipmaps.ts`): WebGPU has no
  built-in mipmaps; the browser blits mip N-1 → N with a fullscreen
  triangle and a bilinear clamp sampler. `pal_dawn.cpp` embeds that
  WGSL verbatim. Every material texture gets the full chain
  `1 + floor(log2(max(w,h)))`; sRGB correctness comes from the texture
  format (`rgba8unorm-srgb` for base color/emissive on PBR).
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
  stand-in otherwise); reached material-extension pairs append last in
  `append_material_extension_bindings` order with SDL's sRGB flags and
  fallbacks (clearcoat/roughness white, coat normal 128/128/255, sheen
  color sRGB white, sheen roughness white, iridescence pairs sRGB
  white, dedicated uv2 occlusion linear white). Standard pipelines
  keep six pairs — their fragment never declares the appended
  bindings.
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
  `build_skybox_plan`; cull none, blend off, depth writes off; the
  vertex matrix is `build_skybox_view_projection` when
  `skybox_uses_environment`, else the scene view-projection;
  `SkyboxUniforms` from `build_skybox_uniforms(environment,
  transmission_enabled)`.
- **Ground**: quad from `build_background_plan`, `pbr.vert` +
  `background-ground.frag`, blend One/OneMinusSrcAlpha on both
  channels, depth writes off, clamp sampler with `lodMaxClamp 0`,
  linear ground texture with mips, `BackgroundUniforms` per frame,
  drawn in the `ground` stage (last).
