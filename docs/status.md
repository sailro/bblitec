# Current status

`bblitec` is a real compiler for a deliberately constrained reachable subset
of Babylon Lite. It is not yet a universal TypeScript or Babylon runtime.
The supported feature set, split into what is decided at compile time and what
lives at run time, is in [features](features.md).

## Curated parity scenes

Thresholds live in `src/scene-registry.ts`; run one scene with
`npm run scene -- parity scene<ID>` or all registered parity scenes with
`npm run scenes:parity`.

Both native GPU backends are measured against the same goldens; the
Dawn backend renders through the browser reference's own compiler and
rasterization stack (see [backends](backends.md)). Each backend column is full-image / foreground MAD. Severity:
$\color{#1a7f37}{\textsf{green below 0.500}}$,
$\color{#9a6700}{\textsf{yellow from 0.500 to below 1.000}}$, and
$\color{#cf222e}{\textsf{red above 1.000}}$.
A value in the green band prints plain; colour marks only the values
that need attention. (GitHub stops rendering math expressions after a
few hundred per page, so a table this size cannot colour its default
state — the tail rows were failing to render.)

A scene that does not reach zero carries a recorded adaptation: every
generated scene writes a `fidelity.json` giving the source and native
semantics side by side, with its risk and validation.

**One row measures something else.** Scene 40 links a different rigid-body
solver than the golden ran, so its number is the distance between two solvers
at a moving pose, not the distance between this port and Babylon Lite, and no
threshold on it can be driven to zero
([fidelity](fidelity.md#physics-contract)).

| Scene | Preview | SDL_GPU | Dawn | Coverage |
| ---: | :---: | ---: | ---: | --- |
| 1 | <img src="images/scenes/scene1.png" alt="Scene 1 BoomBox rendering" width="160"> | 0.001 / 0.007 | 0.001 / 0.007 | BoomBox glTF, IBL environment, generated PBR diagnostics |
| 2 | <img src="images/scenes/scene2.png" alt="Scene 2 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | directional diffuse/specular on a generated Standard sphere |
| 3 | <img src="images/scenes/scene3.png" alt="Scene 3 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | exponential `setFog`, `loadSkybox` six-face image skybox |
| 5 | <img src="images/scenes/scene5.png" alt="Scene 5 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | GPU morph targets plus recursive GPU skeleton skinning |
| 6 | <img src="images/scenes/scene6.png" alt="Scene 6 rendering" width="160"> | 0.001 / 0.013 | 0.001 / 0.013 | specular-glossiness sphere, solid textures, ground, DDS skybox |
| 7 | <img src="images/scenes/scene7.png" alt="Scene 7 ChibiRex rendering" width="160"> | 0.001 / 0.010 | 0.001 / 0.010 | ChibiRex glTF, LINEAR transform tracks, IBL, ground, the pinned solid-colour skybox |
| 8 | <img src="images/scenes/scene8.png" alt="Scene 8 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | 1024-sample HDR GGX, cubemap skybox, glass alpha |
| 9 | <img src="images/scenes/scene9.png" alt="Scene 9 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Sponza `.babylon`: 24 Standard materials over six texture slots, cotangent-frame normal maps, three point lights with per-mesh light lists |
| 10 | <img src="images/scenes/scene10.png" alt="Scene 10 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | generated sphere, no-IBL PBR, geometric normals |
| 12 | <img src="images/scenes/scene12.png" alt="Scene 12 rendering" width="160"> | 0.000 / 0.003 | 0.000 / 0.003 | three cloned skinned shader-ball rows comparing metallic-reflectance, reflectance-colour, and combined alpha-only metallic maps under rotated IBL, frozen by the pin's `?seekTime=0.5` query |
| 13 | <img src="images/scenes/scene13.png" alt="Scene 13 rendering" width="160"> | 0.001 / 0.006 | 0.001 / 0.006 | material grid, ground, explicit occlusion |
| 14 | <img src="images/scenes/scene14.png" alt="Scene 14 rendering" width="160"> | 0.012 / 0.006 | 0.012 / 0.006 | Flight Helmet glTF, default framing, IBL, ground, DDS skybox |
| 15 | <img src="images/scenes/scene15.png" alt="Scene 15 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | two scene-code spot lights over a Standard ground, cone cosine and exponent falloff |
| 19 | <img src="images/scenes/scene19.png" alt="Scene 19 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | DDS cubemap environment compiled to harmonics and mip chain, scene-code clearcoat over IBL with the coat's base-F0 remap |
| 21 | <img src="images/scenes/scene21.png" alt="Scene 21 rendering" width="160"> | 0.330 / 0.330 | 0.330 / 0.330 | scene-code sheen under the pinned legacy model, `.env` cubemap reused as its own skybox, destructured parallel loads |
| 23 | <img src="images/scenes/scene23.png" alt="Scene 23 rendering" width="160"> | 0.002 / 0.017 | 0.002 / 0.017 | scene-code PBR anisotropy over an `.env` environment, frozen at the query pose its pinned spec serves |
| 24 | <img src="images/scenes/scene24.png" alt="Scene 24 rendering" width="160"> | 0.004 / 0.004 | 0.000 / 0.000 | Hill Valley `.babylon` geometry, textures, baked lighting; the file camera reads at the pin's JavaScript-number width |
| 25 | <img src="images/scenes/scene25.png" alt="Scene 25 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | a BC2 KTX container parsed at load by the pin's own parser and uploaded as the blocks it carries, over a tiled `uvScale` on a scene-code Standard material. Generation resolves which suffix to fetch, because the pin picks it from the device's compressed-format features |
| 26 | <img src="images/scenes/scene26.png" alt="Scene 26 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | scene-code PBR translucency with a thickness map and specular AA, an orbiting point light frozen by the pin's `?seekTime=3` query, and mesh-bound overrides participating in default-camera framing |
| 27 | <img src="images/scenes/scene27.png" alt="Scene 27 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | `KHR_materials_variants` with a statically selected variant, `KHR_materials_specular` and IOR on both candidate materials |
| 28 | <img src="images/scenes/scene28.png" alt="Scene 28 rendering" width="160"> | 0.001 / 0.007 | 0.001 / 0.007 | `KHR_materials_clearcoat` intensity, roughness, coat normals |
| 29 | <img src="images/scenes/scene29.png" alt="Scene 29 rendering" width="160"> | 0.000 / 0.008 | 0.000 / 0.008 | `KHR_materials_sheen` with `KHR_texture_transform` scaling |
| 30 | <img src="images/scenes/scene30.png" alt="Scene 30 rendering" width="160"> | 0.007 / 0.010 | 0.003 / 0.005 | Draco-compressed geometry decoded at generation time, transmission and volume with a UV-offset transform |
| 31 | <img src="images/scenes/scene31.png" alt="Scene 31 rendering" width="160"> | 0.000 / 0.003 | 0.000 / 0.003 | `KHR_materials_emissive_strength`, factor-only emissive |
| 32 | <img src="images/scenes/scene32.png" alt="Scene 32 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | `KHR_materials_unlit` |
| 33 | <img src="images/scenes/scene33.png" alt="Scene 33 rendering" width="160"> | 0.000 / 0.009 | 0.000 / 0.006 | `KHR_lights_punctual` falloff across opaque, transmission, BLEND |
| 34 | <img src="images/scenes/scene34.png" alt="Scene 34 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | `KHR_node_visibility` subtree cascade, `KHR_animation_pointer` visibility target |
| 35 | <img src="images/scenes/scene35.png" alt="Scene 35 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | `EXT_mesh_gpu_instancing`, default framing, camera-target destructuring |
| 36 | <img src="images/scenes/scene36.png" alt="Scene 36 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | a Basis Universal texture transcoded to BC7 by the pin's own loader at generation and packaged as KTX1, bound as both the diffuse and the emissive slot of one Standard material; its texture-object `invertY` is what flips the material's UV block |
| 37 | <img src="images/scenes/scene37.png" alt="Scene 37 rendering" width="160"> | 0.001 / 0.006 | 0.001 / 0.006 | `EXT_texture_webp` images, per-slot texture transforms, `KHR_materials_sheen` with `KHR_materials_specular`, occlusion UV set chosen per material |
| 39 | <img src="images/scenes/scene39.png" alt="Scene 39 rendering" width="160"> | 0.000 / 0.001 | 0.000 / 0.001 | `KHR_animation_pointer` driving node rotation and `KHR_texture_transform` offset and scale across two scrolling water surfaces |
| 40 | <img src="images/scenes/scene40.png" alt="Scene 40 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.332}} / \color{#9a6700}{\textsf{0.777}}$ | $\color{#1a7f37}{\textsf{0.332}} / \color{#9a6700}{\textsf{0.777}}$ | **Not a fidelity number.** Havok sphere drop, frozen at the pin's own `?captureFrame=120`. The port links Bullet where the golden ran Havok, so this row measures the distance between two solvers at a moving pose, and its threshold is a regression gate on this port's own solver — [fidelity](fidelity.md#physics-contract) carries the decomposition |
| 50 | <img src="images/scenes/scene50.png" alt="Scene 50 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | 250 pure-2D sprites over a compile-time-drawn canvas2D atlas: grid frames, per-sprite tint, rotation and flip, straight-alpha blending through a SpriteRenderer with no scene |
| 54 | <img src="images/scenes/scene54.png" alt="Scene 54 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | camera-facing world-space billboards drawn inside the scene pass, depth-tested against Standard-material boxes, with per-sprite pivot and flip |
| 55 | <img src="images/scenes/scene55.png" alt="Scene 55 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | three overlapping billboards under a free camera and no meshes: the back-to-front sort is the whole image, since a transparent billboard writes no depth |
| 56 | <img src="images/scenes/scene56.png" alt="Scene 56 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | axis-locked billboards: the quad rotates only around the system's lock axis, normalised where the pin normalises it, with the basis reading that axis out of the system block |
| 57 | <img src="images/scenes/scene57.png" alt="Scene 57 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | `billboardBlendCutout` under `setAlphaToCoverage`: replacement colour with depth writes, drawn among the opaque meshes rather than after them, so the GPU resolves overlap and no sort runs |
| 60 | <img src="images/scenes/scene60.png" alt="Scene 60 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the smallest Babylon NME graph, compiled by the pin's own emitter at generation: a uniform colour block into the fragment output over the canonical world-view-projection vertex path |
| 61 | <img src="images/scenes/scene61.png" alt="Scene 61 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | a node graph carrying the transformed world normal to the fragment as colour, so the emitted stages share a varying |
| 62 | <img src="images/scenes/scene62.png" alt="Scene 62 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | `TextureBlock` sampling the image the scene's `textures` record supplies, at the group-1 pair the pin's own pipeline builder allocated for it |
| 77 | <img src="images/scenes/scene77.png" alt="Scene 77 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the pass-through node blocks — elbow, teleport in and out, debug — which the emitter resolves to their own input |
| 78 | <img src="images/scenes/scene78.png" alt="Scene 78 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the scalar and vector math blocks, over a graph the module assembles at load rather than exports as a literal |
| 79 | <img src="images/scenes/scene79.png" alt="Scene 79 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | conditions, curves, waves, spherical interpolation and the pin's own deterministic random block |
| 80 | <img src="images/scenes/scene80.png" alt="Scene 80 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the colour blocks: converter, desaturate, gradient, posterize and replace-colour |
| 82 | <img src="images/scenes/scene82.png" alt="Scene 82 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the procedural noise blocks — simplex, Voronoi, Worley and cloud — each a helper the emitter installs once at module scope |
| 84 | <img src="images/scenes/scene84.png" alt="Scene 84 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the fragment-coordinate blocks -- screen position, screen-space projection and twirl -- and `FragDepthBlock`, whose written depth is the pin's own convention and so occludes the plane behind it by that convention |
| 85 | <img src="images/scenes/scene85.png" alt="Scene 85 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the matrix blocks: builder, transpose, splitter and determinant, with the vertex position transformed through them |
| 88 | <img src="images/scenes/scene88.png" alt="Scene 88 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | a loop block accumulating colour bands, its body reading and writing the mutable storage variable the emitter routes the loop id to |
| 89 | <img src="images/scenes/scene89.png" alt="Scene 89 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | storage read and write feeding a vec4 back through the graph outside a loop |
| 63 | <img src="images/scenes/scene63.png" alt="Scene 63 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | a node graph shading through the scene's lights: the pin's own lights array at the group-0 slot every composed family shares, walked by the per-mesh selection the graph's mesh block carries |
| 67 | <img src="images/scenes/scene67.png" alt="Scene 67 rendering" width="160"> | 0.000 / 0.002 | 0.000 / 0.002 | the node metallic-roughness block over four lights and an `.env` environment, sampling the specular cube and BRDF LUT the material families already bind |
| 68 | <img src="images/scenes/scene68.png" alt="Scene 68 rendering" width="160"> | 0.000 / 0.004 | 0.000 / 0.004 | the same graph with a clearcoat layer, which changes the composed arithmetic and declares no resource of its own |
| 69 | <img src="images/scenes/scene69.png" alt="Scene 69 rendering" width="160"> | 0.000 / 0.008 | 0.000 / 0.008 | clearcoat and sheen composed together over the node PBR core |
| 70 | <img src="images/scenes/scene70.png" alt="Scene 70 rendering" width="160"> | 0.001 / 0.021 | 0.001 / 0.021 | the anisotropy layer over the node PBR core, with a uv-carrying vertex stage |
| 71 | <img src="images/scenes/scene71.png" alt="Scene 71 rendering" width="160"> | 0.000 / 0.008 | 0.000 / 0.008 | the subsurface layer over the node PBR core |
| 74 | <img src="images/scenes/scene74.png" alt="Scene 74 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | a procedural fullscreen effect drawn straight to the swapchain: an `EffectRenderer` registered on the engine with no scene at all, over the pin's own fullscreen-triangle vertex stage |
| 75 | <img src="images/scenes/scene75.png" alt="Scene 75 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the same effect as a frame-graph task into a render target, its uniform block set once, and that target read back as a Standard diffuse texture |
| 76 | <img src="images/scenes/scene76.png" alt="Scene 76 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | an effect sampling a texture through the descriptor's own texture/sampler pair, bound by `setEffectTexture` |
| 81 | <img src="images/scenes/scene81.png" alt="Scene 81 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the UV and projection blocks -- panner, 2D rotate, tri-planar and bi-planar -- over an atlas carried as a `data:` URL and materialized by decode |
| 87 | <img src="images/scenes/scene87.png" alt="Scene 87 rendering" width="160"> | 0.000 / 0.001 | 0.000 / 0.001 | `IridescenceBlock` and `ImageProcessingBlock` over a graph composed from another module's, with the scene's selected tone-mapping record |
| 92 | <img src="images/scenes/scene92.png" alt="Scene 92 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | a per-layer custom fragment shader: the pin's own composer around the caller's WGSL body, with the `fx` block bound beside the layer's and `setSprite2DShaderParams` tinting every sprite |
| 93 | <img src="images/scenes/scene93.png" alt="Scene 93 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the same custom-shader path with an extra texture: a 256x1 colormap the scene computes, baked at generation and sampled by the caller's WGSL through the binding pair the pin splices in |
| 94 | <img src="images/scenes/scene94.png" alt="Scene 94 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the billboard mirror of scene 92: the custom composer keeps the world-space vertex stage and adds the view distance and world position a custom body may read |
| 95 | <img src="images/scenes/scene95.png" alt="Scene 95 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the billboard mirror of scene 93, where the palette lookup runs in the world-space stage the custom composer brings with it |
| 96 | <img src="images/scenes/scene96.png" alt="Scene 96 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | per-sprite UV scroll: the first `setSprite2DUvOffset` widens the layer's instance layout in place, and a repeat-wrapped tile scrolls by band |
| 97 | <img src="images/scenes/scene97.png" alt="Scene 97 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the opt-in `spriteBlendMultiply` descriptor over a non-black clear, where the sprites darken and tint the background rather than covering it |
| 98 | <img src="images/scenes/scene98.png" alt="Scene 98 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the opt-in `billboardBlendAdditive` descriptor: overlapping billboards stack and brighten instead of occluding, over depth-tested boxes |
| 11 | <img src="images/scenes/scene11.png" alt="Scene 11 rendering" width="160"> | 0.010 / 0.281 | 0.010 / 0.281 | KHR_materials_pbrSpecularGlossiness: the shark's specular/glossiness pair replacing the metallic-roughness workflow, on a skinned swim cycle pinned to one second |
| 110 | <img src="images/scenes/scene110.png" alt="Scene 110 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | render-target colour as a Standard diffuse texture, per-pass material override |
| 116 | <img src="images/scenes/scene116.png" alt="Scene 116 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | no-color material views, depth targets |
| 120 | <img src="images/scenes/scene120.png" alt="Scene 120 rendering" width="160"> | 0.001 / 0.003 | 0.001 / 0.003 | 345,217 Gaussian splats from a `.ply`: the pin's parser executed at generation, its covariance build and back-to-front counting sort folded from their own AST, and its EWA projection extracted from the bundled WGSL |
| 142 | <img src="images/scenes/scene142.png" alt="Scene 142 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | four post-process passes into one target through normalized viewports: black-and-white, red/cyan anaglyph over a second camera's render task, a 128-pixel diagonal blur, and chromatic aberration |
| 143 | <img src="images/scenes/scene143.png" alt="Scene 143 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | a chained post-process graph over Sponza: two separable Gaussian blurs into chromatic aberration, each pass the pin's own composed stage |
| 145 | <img src="images/scenes/scene145.png" alt="Scene 145 rendering" width="160"> | 0.022 / 0.021 | 0.010 / 0.009 | `.babylon`, Standard geometry outputs, default anisotropy |
| 146 | <img src="images/scenes/scene146.png" alt="Scene 146 rendering" width="160"> | 0.003 / 0.003 | 0.003 / 0.003 | FreeCamera Sponza, PBR geometry outputs, 7+4 MRT composition |
| 147 | <img src="images/scenes/scene147.png" alt="Scene 147 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the circle-of-confusion map over PowerPlant: a geometry task's normalized view depth read by the lens model, with the colour pass borrowing that task's depth attachment |
| 148 | <img src="images/scenes/scene148.png" alt="Scene 148 rendering" width="160"> | 0.001 / 0.001 | 0.001 / 0.001 | the depth-of-field composite over PowerPlant: eight passes and seven intermediate targets built by the pin's own factory, over a 4x MSAA render resolved into the source |
| 150 | <img src="images/scenes/scene150.png" alt="Scene 150 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | property `position.x` animation, track-derived frame rate |
| 151 | <img src="images/scenes/scene151.png" alt="Scene 151 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | grouped position, scaling, and quaternion property animation |
| 152 | <img src="images/scenes/scene152.png" alt="Scene 152 rendering" width="160"> | 0.010 / 0.281 | 0.010 / 0.281 | a scene-owned animation manager driving a loaded file's clips beside a camera property clip; the residual is scene 11's skinned shark pose |
| 154 | <img src="images/scenes/scene154.png" alt="Scene 154 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | LINEAR versus STEP property interpolation |
| 155 | <img src="images/scenes/scene155.png" alt="Scene 155 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | two clips over one `position.x` at weights 0.25 and 0.75, resolved by the pin's weighted property mixer instead of last-write-wins |
| 157 | <img src="images/scenes/scene157.png" alt="Scene 157 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Xbot's walk and run blended at half weight each by the pin's weighted skeleton mixer, over a 67-joint skin on the pinned palette texture |
| 158 | <img src="images/scenes/scene158.png" alt="Scene 158 rendering" width="160"> | 0.000 / 0.001 | 0.000 / 0.001 | the additive pose mixer: sad_pose, marked additive at its frame-0 reference, blended over the playing idle clip by the pin's own accumulation — reference⁻¹ × sample applied onto the base pose, then slerped by the weight — with the scene frozen through its own `?seekTime=` branch and both clips paused |
| 159 | <img src="images/scenes/scene159.png" alt="Scene 159 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | scene-local WGSL shader variant, flat-color fragment |
| 160 | <img src="images/scenes/scene160.png" alt="Scene 160 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | shader-material sampler pair bound by `setShaderTexture` |
| 161 | <img src="images/scenes/scene161.png" alt="Scene 161 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | scene-local WGSL variant with typed custom uniforms |
| 162 | <img src="images/scenes/scene162.png" alt="Scene 162 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | shader-material `defines` as the pin's own prelude consts |
| 163 | <img src="images/scenes/scene163.png" alt="Scene 163 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | custom shader blend, alpha test, discard |
| 168 | <img src="images/scenes/scene168.png" alt="Scene 168 rendering" width="160"> | 0.000 / 0.002 | 0.000 / 0.002 | double-sided winding through a clockwise front-face pipeline |
| 176 | <img src="images/scenes/scene176.png" alt="Mosquito in Amber" width="160"> | 0.016 / 0.016 | 0.014 / 0.014 | linear transmission, alpha state, IOR, volume, scene-color copy |
| 177 | <img src="images/scenes/scene177.png" alt="Scene 177 rendering" width="160"> | 0.021 / 0.021 | 0.021 / 0.021 | scene-code `setPbrIridescence` over an `.env` environment, two scene materials under independent setters |
| 178 | <img src="images/scenes/scene178.png" alt="Scene 178 rendering" width="160"> | 0.018 / 0.016 | 0.018 / 0.016 | `KHR_materials_iridescence`, camera-following skybox |
| 210 | <img src="images/scenes/scene210.png" alt="Scene 210 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | `KHR_xmp_json_ld` metadata on a rounded cube |
| 212 | <img src="images/scenes/scene212.png" alt="Scene 212 rendering" width="160"> | 0.014 / 0.016 | 0.010 / 0.011 | `KHR_materials_dispersion` per-RGB refraction, IOR, volume |
| 213 | <img src="images/scenes/scene213.png" alt="Scene 213 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | GridMaterial opaque/transparent families, ordered draw lists |
| 216 | <img src="images/scenes/scene216.png" alt="Scene 216 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | linear `setFog` mixed before tone mapping |
| 240 | <img src="images/scenes/scene240.png" alt="Scene 240 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | deterministic glTF node rotation animation |
| 242 | <img src="images/scenes/scene242.png" alt="Scene 242 rendering" width="160"> | 0.000 / 0.004 | 0.000 / 0.004 | `KHR_animation_pointer` base color, emissive factor and emissive strength on LINEAR samplers |
| 243 | <img src="images/scenes/scene243.png" alt="Scene 243 rendering" width="160"> | 0.000 / 0.005 | 0.000 / 0.005 | MorphStressTest glTF, overlapping clips, storage-buffer morphing, uv2 occlusion |
| 244 | <img src="images/scenes/scene244.png" alt="Scene 244 rendering" width="160"> | 0.001 / 0.011 | 0.001 / 0.011 | `KHR_animation_pointer` texture-transform rotations on two slots of one material that disagree, `KHR_materials_specular`, transmission reached from the asset |
| 245 | <img src="images/scenes/scene245.png" alt="Scene 245 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | recursive skeleton, inverse bind matrices, GPU skinning |
| 246 | <img src="images/scenes/scene246.png" alt="Scene 246 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | deterministic SimpleSkin glTF animation |
| 247 | <img src="images/scenes/scene247.png" alt="Scene 247 rendering" width="160"> | 0.001 / 0.009 | 0.001 / 0.009 | `EXT_mesh_gpu_instancing` T/R/S, one native instanced draw |
| 248 | <img src="images/scenes/scene248.png" alt="Scene 248 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | external glTF and sampler modes |
| 249 | <img src="images/scenes/scene249.png" alt="Scene 249 rendering" width="160"> | 0.000 / 0.004 | 0.000 / 0.004 | vertex-color alpha and mask cutoff |
| 250 | <img src="images/scenes/scene250.png" alt="Scene 250 rendering" width="160"> | 0.004 / 0.004 | 0.003 / 0.003 | VirtualCity through an imported glTF camera: the `_camera` feature's parented FreeCamera on an animated vehicle node, found by name, frozen at `?seekTime=5` |
| 252 | <img src="images/scenes/scene252.png" alt="Scene 252 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | direct single-target morph deformation on a generated Standard sphere |
| 253 | <img src="images/scenes/scene253.png" alt="Scene 253 rendering" width="160"> | 0.001 / 0.002 | 0.001 / 0.002 | `KHR_animation_pointer` across node transforms, punctual lights and material extensions, spot lights, 69 channels |
| 254 | <img src="images/scenes/scene254.png" alt="Scene 254 rendering" width="160"> | 0.001 / 0.003 | 0.001 / 0.003 | signed animation sampler accessors, quaternion slerp |
| 255 | <img src="images/scenes/scene255.png" alt="Scene 255 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | normalized integer skin-weight accessors |
| 256 | <img src="images/scenes/scene256.png" alt="Scene 256 rendering" width="160"> | 0.000 / 0.005 | 0.000 / 0.005 | cotangent-frame normal mapping on a mesh with no TANGENT accessor |
| 257 | <img src="images/scenes/scene257.png" alt="Scene 257 rendering" width="160"> | 0.001 / 0.005 | 0.001 / 0.005 | negative-scale hierarchy, generated normals |
| 258 | <img src="images/scenes/scene258.png" alt="Scene 258 rendering" width="160"> | 0.002 / 0.004 | 0.002 / 0.004 | interleaved glTF vertex buffers |
| 259 | <img src="images/scenes/scene259.png" alt="Scene 259 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | factor-only emissive material with neutral texture fallback |
| 260 | <img src="images/scenes/scene260.png" alt="Scene 260 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | TRIANGLE_STRIP primitive mode with uint32 indices |
| 262 | <img src="images/scenes/scene262.png" alt="Scene 262 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | node-particle graph, frozen simulation baked at generation, camera-facing billboards |
| 263 | <img src="images/scenes/scene263.png" alt="Scene 263 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | node particles with gravity and colour-over-life gradients |
| 264 | <img src="images/scenes/scene264.png" alt="Scene 264 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | node particles from a sphere shape emitter |
| 265 | <img src="images/scenes/scene265.png" alt="Scene 265 rendering" width="160"> | 0.000 / 0.008 | 0.000 / 0.008 | `EXT_lights_image_based` RGBD cubemap, BRDF LUT, SH irradiance, rotation |
| 266 | <img src="images/scenes/scene266.png" alt="Scene 266 rendering" width="160"> | 0.009 / 0.017 | 0.009 / 0.017 | mirrored spheres, source-derived clockwise front face |
| 267 | <img src="images/scenes/scene267.png" alt="Scene 267 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Standard RGBA vertex colors on a raw typed-array quad, unlit and double-sided |
| 268 | <img src="images/scenes/scene268.png" alt="Scene 268 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | opt-in orthographic projection, aspect-derived view volume |
| 273 | <img src="images/scenes/scene273.png" alt="Scene 273 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | post-registration material-family addition |
| 274 | <img src="images/scenes/scene274.png" alt="Scene 274 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | 4x-MSAA alpha-to-coverage |
| 276 | <img src="images/scenes/scene276.png" alt="Scene 276 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | node particles through a 66-cell sprite sheet |
| 277 | <img src="images/scenes/scene277.png" alt="Scene 277 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | node particles under an attractor update |
| 278 | <img src="images/scenes/scene278.png" alt="Scene 278 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | polyline systems on the pin's line-list topology, uniform and per-point colours |
| 279 | <img src="images/scenes/scene279.png" alt="Scene 279 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | a fixed-topology line update drawn through thin instances with per-instance colours |
| 280 | <img src="images/scenes/scene280.png" alt="Scene 280 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | node particles under a flow map, whose build reads the scene camera |
| 281 | <img src="images/scenes/scene281.png" alt="Scene 281 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | node particles under a noise-texture update |
| 283 | <img src="images/scenes/scene283.png" alt="Scene 283 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the exact Multiply particle blend: the pin's own private fragment, which interpolates toward white by source alpha so a transparent texel leaves the warm destination unchanged |
| 284 | <img src="images/scenes/scene284.png" alt="Scene 284 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | MultiplyAdd: that pass followed by a stock Add pass over the same instances, two pipelines and one renderable |
| 301 | <img src="images/scenes/scene301.png" alt="Scene 301 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the pure-2D particle bridge: NPE world XY packed into Sprite2D layers with no scene at all, one Multiply layer beside a Multiply-then-Add pair the renderer's stable order keeps adjacent |
| 282 | <img src="images/scenes/scene282.png" alt="Scene 282 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | the ninth Standard extension: `enableMaterialUvTransform` composing `stdUvTransformExt`, whose per-channel block the pin's own writer fills over a `createTexture2DFromPixels` diffuse texture. One pixel of 921600 lands 4e-6 from a texel boundary under nearest filtering and takes the neighbouring checker row |
| 220 | <img src="images/scenes/scene220.png" alt="Scene 220 rendering" width="160"> | 0.001 / 0.002 | 0.001 / 0.002 | `KHR_mesh_quantization`, resolved by the pinned feature's own `preParse` at generation: the packaged Duck carries tightly-packed floats, and its unnormalized integer UVs are rescaled by the material's `KHR_texture_transform`. The residual is one LSB over the `.env` IBL band |

## Project-owned differential gates

These scenes are authored in `bblitec`, but their browser reference still runs
the same TypeScript against the pinned Babylon Lite package. Their MAD measures
native differential fidelity; it does not represent upstream corpus coverage.

They are scaffolding for contracts no measured corpus scene reaches yet — a
feature combination the corpus does not exercise, or a slice being built up
ahead of the scene that will use it. A gate is deleted once corpus scenes cover
its contract.

| Scene | Preview | SDL_GPU | Dawn | Coverage |
| ---: | :---: | ---: | ---: | --- |
| light-setters | <img src="images/scenes/regression-light-setters.png" alt="Light vector setters rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | a light's position and direction written after creation: a spot moved onto the ground by its two `ObservableVec3` setters, and a directional position that reaches no pixel but has to compile and link |
| compiler-state | <img src="images/scenes/regression-compiler-state.png" alt="Compiler state rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | flat-entry mutable state, pre-registration compound assignment |
| glTF-track-clamp | <img src="images/scenes/regression-track-clamp.png" alt="glTF track clamp rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | track endpoint clamping against a longer global duration |
| animation-groups | <img src="images/scenes/regression-animation-groups.png" alt="glTF animation groups rendering" width="160"> | 0.000 / 0.005 | 0.000 / 0.005 | a named glTF clip selected from scene code: `scene.animationGroups` iteration, a group name compared as a runtime string, and the pinned stop/play over three clips of different lengths |
| shader-frame-graph | <img src="images/scenes/audit-shader-frame-graph.png" alt="Shader frame graph rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | shader materials through a frame-graph render task |
| runtime-sweep | <img src="images/scenes/regression-runtime-sweep.png" alt="Runtime sweep rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | thin-instance pools with flush and count updates, handles inside data retired by `removeFromScene`, file-texture sampler contract (Scene 267 measures typed-array meshes from the corpus) |
| instanced-ground | <img src="images/scenes/regression-instanced-ground.png" alt="Instanced ground rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | `EXT_mesh_gpu_instancing` with the requested environment ground |
| morph-ground | <img src="images/scenes/regression-morph-ground.png" alt="Morph storage ground rendering" width="160"> | 0.000 / 0.001 | 0.000 / 0.001 | storage-buffer morphing with the requested environment ground |
