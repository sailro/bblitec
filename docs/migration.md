# Dawn (WebGPU) backend migration

Branch `claude/dawn-backend` migrates the GPU renderer from SDL_GPU to
Dawn — Chrome's WebGPU implementation, built from the same pinned commit
as the Tint shader compiler. The browser reference captures are produced
by Chrome, i.e. by Dawn on D3D12 compiling WGSL with DXC; rendering
through the identical stack makes parity structural instead of adapted.
SDL_GPU remains the default backend until Dawn parity is a strict
superset. SDL3 itself stays for windowing, input, and image I/O; the
SDL_Renderer CPU fallback is out of scope.

## Verified state

Every scene either backend can express now passes on Dawn at values
equal to or better than SDL_GPU — 43 curated scenes plus all six
project gates (see the Dawn column in [status](status.md)); a
42-scene sequential re-validation preceded the transmission port and
the seven transmission scenes were gated individually after it. The
transmission family is where Dawn structurally surpasses SDL_GPU: the
scene-color grab reads the multisampled attachment directly with the
pinned sample-averaging blit, and the final pass applies image
processing per MSAA sample before averaging (both pinned WGSL
transcribed verbatim), which SDL_GPU's resolve-then-process
adaptation could never express. Scene 33's foreground falls from
1.457 — the dashboard's only red cell — to 0.123, scene 212 from
0.193 to 0.048, scene 176 from 0.064 to 0.039, and the
scene-color/IOR/volume gates drop to 0.005/0.003/0.002 against
SDL_GPU's 0.143/0.130/0.166. Fourteen of them are
bit-exact — 2, 10, 32, 116, 150, 151, 154, 163, 240, 246, 259, 273,
274, and both project gates — with 259 beating SDL_GPU, whose
DXC-vs-browser rounding it eliminates, and 163/273/274 covering the
alpha-card, circular-cutout, alpha-to-coverage, and
runtime-mesh-append paths. The frame graph runs end to end: scene 116
(no-color depth views) is bit-exact, scene 145 (Standard geometry
MRTs) lands at 0.008/0.008 — beating its SDL_GPU 0.022/0.022 — and
scene 146 (PBR geometry MRTs) matches its 0.021/0.018 baseline
exactly. Scene 1 (BoomBox) matches the SDL_GPU
baseline at 0.001/0.015, scene 8 matches exactly at 0.129/0.134 (the
compiled-HDR environment path worked unmodified), the material
extension scenes 28 (clearcoat), 29 (sheen), and 178 (iridescence)
match exactly, GridMaterial scene 213 matches at 0.000/0.001, the
deformation family lands at its SDL_GPU values — 5 (0.001/0.020), 243
(0.046/1.043, the documented deformation-input floor — Dawn
reproduces SDL_GPU within one LSB there, exonerating codegen and
raster), 245
(0.000/0.001), 247 (0.035/0.406), 254 (0.001/0.003, beating 0.004),
255 (0.011/0.101) — scene 249 matches exactly at 0.001/0.024, scenes
24 (HillValley `.babylon` reflection cubes, 0.015/0.016) and 248
(0.001/0.004) beat theirs, and scenes 6, 13, 14, 31, 168, 210, 257,
258, 265, and 266 pass their gates. There is no open Dawn divergence
in the migrated slice; only the frame-graph scenes (116, 145, 146),
the transmission scenes (33, 176, 212), and the four transmission
project gates remain SDL_GPU-only.

Key empirical findings, in case any regress:

- **Shader compiler identity is the parity linchpin.** Dawn hard-forces
  `use_dxc` off unless the library is compiled with
  `DAWN_USE_BUILT_DXC` (`PhysicalDeviceD3D12.cpp` ForceSet), and the
  `dxcompiler` CMake target must be built separately and its DLL
  deployed beside `webgpu_dawn.dll`. With FXC instead of DXC, a
  systemic -1 LSB appeared on lit surfaces (scenes 259/248) plus larger
  filter and discard deltas (248/249); with DXC all of it vanished.
- **The `.env` RGBD cubemap Y-flip is pinned behavior**, not an SDL
  adaptation: upstream `uploadCubemapRGBD` documents "BJS uploads
  cubemap faces with invertY=true". Uploading unflipped cost scene 1
  0.89 MAD; flipping restored 0.001.
- The registry `backgroundColor` values are region-keying colors, not
  exact clear values (scene 2's actual background is 76, not 77).
- **Measure Dawn only against a freshly processed build.** The formerly
  recorded scene 249 "mask-edge residual" (0.012/0.499, max 7) and the
  scene 248 offset (0.003/0.016) were stale shader/build pairings, not
  divergences: Dawn reads `*.native.wgsl` from the build snapshot while
  SDL_GPU reads offline DXIL, so a snapshot that mixes generations skews
  only the Dawn side. After `scene -- process`, both scenes render
  bit-near-identical to SDL_GPU (64 and 0 pixels at delta 1 in direct
  backend comparison). A shader-level bisection confirmed the linear
  shaded color is bit-identical between the backends across the full
  frame, including derivative-driven geometric roughness, environment
  LOD, BRDF LUT, and MSAA resolve.
- The parity harness forwards the environment, so
  `BBLITE_GPU_BACKEND=dawn npm run scene -- parity sceneN` runs and
  labels a Dawn parity report.

## Building and running

```powershell
pwsh -File tools\build-dawn.ps1
```

- Pin: `upstream/tint.json` (one provenance for Tint and Dawn); source
  checkout shared at `.cache/tint/dawn`, build tree
  `.cache/tint/build-dawn`. **Wipe the build tree when changing CMake
  options** — stale trees no-op silently.
- Configuration: monolithic `webgpu_dawn` shared library, D3D12 only,
  `DAWN_USE_BUILT_DXC=ON`, targets `webgpu_dawn` **and** `dxcompiler`,
  installed to `artifacts/tools/dawn`.
- Deployment: `webgpu_dawn.dll`, Dawn's built `dxcompiler.dll`,
  `dxil.dll`, and the SDK `d3dcompiler_47.dll` (FXC fallback) must sit
  beside the executable; Dawn resolves them module-relative with
  hardened LoadLibraryEx flags, exactly as Chrome deploys them. The
  native CMake `POST_BUILD` step copies all four.

Enable per build directory and select at runtime:

```powershell
cmake -S native -B native\build-scene1-release -DBBLITE_DAWN=ON
$env:BBLITE_GPU_BACKEND = "dawn"
```

The cache variable survives scene-command reconfigures, so one manual
configure per build directory suffices; build through
`npm run scene -- build sceneN` afterwards (direct `cmake --build`
lacks the MSVC environment). `BBLITE_GPU_BACKEND=dawn` dispatches in
`pal::run_engine` and throws explicitly when the build lacks Dawn.

## Architecture of `native/src/pal_dawn.cpp`

The backend reuses every semantic layer the SDL_GPU backend uses:
`upstream::build_render_plan`, `build_view_projection`,
`build_standard_uniforms`, `build_pbr_uniforms`,
`build_background_plan/uniforms`, `build_skybox_plan/uniforms`,
`sort_transparent_draws`, and the shared vertex packing and decode
helpers in `native/src/pal_gpu_shared.hpp` (`GpuVertex`,
`transformed_vertices`, `decode_rgbd`, `float_to_half` — extracted from
the SDL backend, which was re-verified byte-identical afterwards). Only
the GPU API layer differs:

- **Shaders**: the generated `*.native.wgsl` files are read from the
  snapshot shader directory and handed to
  `wgpuDeviceCreateShaderModule` unchanged — no DXC invocation, no
  register normalization, no shader cache. The WGSL `@group` scheme maps
  natively: group 1 = vertex uniform (`viewProjection`), group 2 =
  texture/sampler pairs at bindings `2n`/`2n+1` in the SDL slot order,
  group 3 = fragment uniform, group 0 = vertex storage buffers (morph).
- **Pipelines**: created lazily per `upstream::RenderPipelineKind` with
  `layout = auto`; bind groups come from
  `wgpuRenderPipelineGetBindGroupLayout` per (mesh, kind). Implemented
  kinds: standard/pbr opaque back/none (+ pbr clockwise) and
  standard/pbr transparent back/none (+ pbr clockwise). Blend for
  transparent: color SrcAlpha/OneMinusSrcAlpha, alpha
  One/OneMinusSrcAlpha, depth LESS_EQUAL with writes off (opaque: LESS
  with writes on). Anything else throws — unimplemented paths must fail
  explicitly, never approximate.
- **Uniforms**: WebGPU has no push constants; each draw owns a uniform
  buffer sized to its family's uniform struct, written per frame with
  `wgpuQueueWriteBuffer` before submission.
- **Deformation/instancing/storage morph**: the shared 200-byte
  16-attribute `GpuVertex` layout feeds locations 8-15; the shared
  `build_deformation_uniforms` (moved to `pal_gpu_shared.hpp`) writes a
  per-mesh uniform at group 1 binding 1 each frame. Instancing adds the
  per-instance matrix-column vertex buffer (slot 1, locations 16-19,
  which needs `maxVertexAttributes` raised to 20 at device creation —
  the SDL-specialized layout exceeds the WebGPU default of 16) plus the
  parent-world uniform at the next group-1 binding. Storage morphing
  binds the flat 6-float delta buffer and 16-byte-header weights buffer
  at group 0 bindings 0/1 with 4-byte/16-byte zero fallbacks; weights
  rewrite in place when `morph_weights_version` changes.
- **Frame graph**: tasks replace the main pass exactly like the SDL
  task loop. Color render tasks draw their
  `build_render_task_draw_lists` lists into render targets with
  sample-count-selected pipelines; depth-only tasks draw the explicit
  no-color meshes through GREATER-compare pipelines with the
  reverse-depth matrix and depth cleared to zero; geometry tasks bind
  one MRT per attachment (`geometry_clear_color` clears, optional
  output target last, resolve on multisample) with the per-task
  `pbr-geometry-N.frag`/`standard-geometry-N.frag` modules; copy tasks
  either resolve in an empty pass or run the generated fullscreen blit
  with the integer `resolve_copy_viewport` viewport+scissor, and a
  swapchain copy records its source as the capture texture. Every mesh
  pipeline (main, task, geometry) shares one explicit superset
  pipeline layout — WebGPU permits layout bindings a shader ignores —
  so mesh bind groups stay interchangeable across shader variants.
  Sampled depth attachments copy into an r32float texture after their
  task (float32-filterable is requested like the pinned engine) so
  standard emissive slots read them exactly like SDL's D3D12 depth
  SRVs (r = depth, g/b = 0, a = 1), through the nearest sampler.
  Device limits are derived from the task records at creation:
  `maxColorAttachmentBytesPerSample` from the WebGPU render-target
  byte costs (the entry's `requiredLimits` option is compile-time
  erased), `maxVertexAttributes` 20 under instancing.
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
  and contrast **per MSAA sample** and averages — the pinned
  image-processing task transcribed verbatim, which SDL_GPU's
  resolve-then-process adaptation could not express.
- **Frame**: 4x MSAA color (surface format) resolving into the surface
  texture, `depth24plus-stencil8` (the browser's format — not the SDL
  backend's D32), stage-driven draw order (skybox → opaque →
  transparent → ground). The surface is configured
  `RenderAttachment | CopySrc`; capture copies the resolved surface
  texture into a mapped buffer (256-aligned rows) and saves via
  SDL_image. The frame loop honors `BBLITE_MAX_FRAMES`,
  `BBLITE_SCREENSHOT(_FRAME)`, `BBLITE_TEST_PASS`,
  `BBLITE_ANIMATION_SEEK_SECONDS`, and the capture grace period.
- **Device**: futures API with `TimedWaitAny`; the `use_dxc` adapter
  toggle is chained to the adapter request; uncaptured device errors
  are captured and thrown at frame end.

## Ported pinned contracts

These were re-derived from the pinned tree during the port; each is the
authority if a regression appears:

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
  environment cube through the repeat trilinear default sampler.
  When `BBLITE_RENDERER_TRANSMISSION` is compiled, the scene-color/
  transmission/thickness trio follows (the scene-color pair rebinds the
  base color while no grab exists, exactly like SDL with transmission
  disabled at runtime); reached material-extension pairs append last in
  `append_material_extension_bindings` order with SDL's sRGB flags and
  fallbacks (clearcoat/roughness white, coat normal 128/128/255, sheen
  color sRGB white, sheen roughness white, iridescence pairs sRGB
  white). Standard pipelines keep six pairs — their fragment never
  declares the appended bindings.
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
  `SkyboxUniforms` from `build_skybox_uniforms(environment, false)`.
- **Ground**: quad from `build_background_plan`, `pbr.vert` +
  `background-ground.frag`, blend One/OneMinusSrcAlpha on both
  channels, depth writes off, clamp sampler with `lodMaxClamp 0`,
  linear ground texture with mips, `BackgroundUniforms` per frame,
  drawn in the `ground` stage (last).

## Remaining work, in suggested order

1. **Pinned background dither** — re-enable the position-seeded
   dither on Dawn (identical codegen makes it reproducible), which
   should take scenes 6/14 below their SDL floors; requires emitting
   the dithered shader variant at generation time.
2. **Diagnostics/attribution** (scene 1 draw IDs, clusters, PBR
   buffers), then the threshold review and the backend end-state
   decision. The current direction is to keep both backends
   long-term as mutually validating implementations — the direct
   Dawn-versus-SDL_GPU diff has been the decisive diagnostic for
   every residual attribution — with a formalized
   backend-differential comparison mode, rather than retiring
   SDL_GPU; rewrite the backend rationale in
   [architecture](architecture.md) when decided.

Performance has not been measured; Dawn runs with default validation
and robustness (robustness must stay on — the browser has it on).
