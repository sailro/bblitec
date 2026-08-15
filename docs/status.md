# Current status

`bblitec` is a real compiler for a deliberately constrained reachable subset
of Babylon Lite. It is not yet a universal TypeScript or Babylon runtime.

## Supported vertical slice

| Area | Current support |
| --- | --- |
| TypeScript modules/functions | classes and factory records as compile-time instances: fields become locals, methods and single-return getters inline at their call sites, and a record carries the scope it closed over. Local imports and re-exports, module constants, typed non-generic functions with defaults, lexical scopes, if/else, for/while, switch, for-of. Fully data-typed functions emit as real C++ functions; handle-touching helpers inline. Recursion, inheritance, accessors, statics and value-returning methods are rejected |
| Plain-data model | interface structs, `T \| null` optionals, dynamic arrays, `Float32Array`/`Uint32Array`, string-literal enum tags, `Record<Union, T>` indexed by tag, readonly numeric tables, tuples, destructuring, object spread, `indexOf`, and constant arrays materialized on demand. Resource handles are storable inside data, so a mesh held in a struct drives its transforms and scene membership like a local. Const locals bind container elements as aliases; function-valued parameters inline. `Math` and the pinned seeded `Math.random` |
| Engine/scene | creation, registration, fixed delta, before-render callbacks, runtime material-family append, `removeFromScene` with render-plan rematching, `setFog` linear/exp/exp2 |
| Cameras | ArcRotate, FreeCamera, default framing, native controls, target assignment and reads, per-frame clamping of the reached properties, and the `enableOrthographicCamera` opt-in with its aspect-derived view volume |
| Lights | directional, hemispheric, point and spot with diffuse/specular colors; one Standard slot per light a scene declares, each mesh lit by the set its assets name; spot cones shade under the pinned cosine-and-exponent falloff on Standard surfaces and the physical falloff in the PBR extra-light slots; two PBR analytic lights, either kind in either slot |
| Geometry | box, sphere, subdivided ground, plane, torus; `createMeshFromData` typed-array meshes; fixed-capacity thin-instance pools with per-frame flush and count updates; indexed glTF/GLB and `.babylon`; glTF triangle-list and triangle-strip primitive modes; `KHR_node_visibility` with its subtree cascade; generated and flat normals; negative transforms |
| Assets | external glTF packaging, embedded PNG/JPEG, `.env`, compile-time RGBE HDR/GGX cubemaps, prefiltered DDS cubemap environments, glTF image-based lights, DDS, `loadSkybox` cubemaps, `loadTexture2D` file textures, `.babylon` textures |
| Materials | Standard, PBR, GridMaterial, Standard cotangent-frame normal maps, PBR vertex colors and the Standard RGB ones behind `enableStandardVertexColors`; the opt-in setters `setPbrUnlit`, `setPbrSkybox` and `setPbrEmissive`; scene-local shader variants compiled from the entry file's own WGSL, with typed uniforms resolved to reflected offsets |
| Material state | alpha mask/blend/coverage, reflectance, emissive strength, lighting intensities, double-sided, normal scale, shared texture scaling, transmission, IOR, volume, dispersion, clearcoat, sheen, iridescence |
| Animation | deterministic seeking; property-animation groups over position/scaling/quaternion with LINEAR/STEP tracks; glTF LINEAR/CUBICSPLINE transforms and LINEAR morph weights; `KHR_animation_pointer` node-visibility targets on STEP samplers |
| Deformation | recursive skeleton hierarchies, inverse bind matrices, four-weight GPU skinning, GPU position/normal/tangent morph targets, direct single-target morph attachment on generated meshes, uncapped storage-buffer morphing, static GPU instancing, post-deformation flat normals |
| Sprites | pure-2D `depth: "none"` layers over a grid atlas, drawn by their own `SpriteRenderer` rendering context with no scene: per-sprite position, size, frame, tint, rotation and flip on the straight-alpha blend. The atlas is executed at compile time when scene code draws it with canvas2D |
| Frame graph | render targets/tasks, material overrides, depth-only passes, 7+4 geometry MRTs, blits, MSAA resolve |
| Runtime | typed handles/records, immediate AOT promises, typed JSON/binary views, tree-shaken GPU deformation and cyclic flat-normal uploads |
| Shaders | WGSL through pinned Tint; DXIL/SPIR-V via normalized Tint HLSL and DXC; MSL via Tint; Dawn consumes the WGSL directly |
| Native renderer | ordered draw lists over two peer GPU backends (SDL_GPU and Dawn/WebGPU), linear RGBA16F transmission with per-sample image processing on Dawn, deterministic SDL_Renderer fallback |

Generated behavior is tied to `@babylonjs/lite@1.20.0` at commit
`95ed3029cc43e479ec924741aea4024e9bf33527`.

## Scene 1 (BoomBox) baseline

Development Windows machine, D3D12, 1280x720; frame times are
same-session paired runs (`BBLITE_BENCHMARK_FRAMES=2000`, 30 warmup
frames, immediate present, frame CPU time from acquire through
submit and present):

| Renderer | Full MAD | Foreground MAD | Frame time |
| --- | ---: | ---: | ---: |
| SDL_GPU, 4x MSAA | $\color{#1a7f37}{\textsf{0.001}}$ | $\color{#1a7f37}{\textsf{0.015}}$ | 0.192 ms average, 0.155 ms median |
| Dawn, 4x MSAA | $\color{#1a7f37}{\textsf{0.001}}$ | $\color{#1a7f37}{\textsf{0.015}}$ | 0.229 ms average, 0.179 ms median |

Against the pinned Babylon Lite output, Scene 1 rendering is effectively exact
on both backends. Dawn's higher CPU frame time is its always-on validation and
robustness (the browser reference runs with both) plus per-draw uniform-buffer
writes where SDL_GPU uses push constants; see
[backends](backends.md) for the full comparison. Regression ceilings are
`0.01` full and `0.03` foreground MAD.

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

A scene that does not reach zero carries a recorded adaptation: every
generated scene writes a `fidelity.json` giving the source and native
semantics side by side, with its risk and validation.

| Scene | Preview | SDL_GPU | Dawn | Coverage |
| ---: | :---: | ---: | ---: | --- |
| 1 | <img src="images/scenes/scene1.png" alt="Scene 1 BoomBox rendering" width="160"> | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.015}}$ | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.015}}$ | BoomBox glTF, IBL environment, generated PBR diagnostics |
| 2 | <img src="images/scenes/scene2.png" alt="Scene 2 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | directional diffuse/specular on a generated Standard sphere |
| 3 | <img src="images/scenes/scene3.png" alt="Scene 3 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | exponential `setFog`, `loadSkybox` six-face image skybox |
| 5 | <img src="images/scenes/scene5.png" alt="Scene 5 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.020}}$ | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.020}}$ | GPU morph targets plus recursive GPU skeleton skinning |
| 6 | <img src="images/scenes/scene6.png" alt="Scene 6 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.283}} / \color{#1a7f37}{\textsf{0.015}}$ | $\color{#1a7f37}{\textsf{0.283}} / \color{#1a7f37}{\textsf{0.014}}$ | specular-glossiness sphere, solid textures, ground, DDS skybox |
| 7 | <img src="images/scenes/scene7.png" alt="Scene 7 ChibiRex rendering" width="160"> | $\color{#1a7f37}{\textsf{0.247}} / \color{#1a7f37}{\textsf{0.273}}$ | $\color{#1a7f37}{\textsf{0.247}} / \color{#1a7f37}{\textsf{0.273}}$ | ChibiRex glTF, LINEAR transform tracks, IBL, ground |
| 8 | <img src="images/scenes/scene8.png" alt="Scene 8 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.129}} / \color{#1a7f37}{\textsf{0.134}}$ | $\color{#1a7f37}{\textsf{0.129}} / \color{#1a7f37}{\textsf{0.134}}$ | 1024-sample HDR GGX, cubemap skybox, glass alpha |
| 9 | <img src="images/scenes/scene9.png" alt="Scene 9 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.330}} / \color{#1a7f37}{\textsf{0.330}}$ | $\color{#1a7f37}{\textsf{0.330}} / \color{#1a7f37}{\textsf{0.330}}$ | Sponza `.babylon`: 24 Standard materials over six texture slots, cotangent-frame normal maps, three point lights with per-mesh light lists |
| 10 | <img src="images/scenes/scene10.png" alt="Scene 10 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | generated sphere, no-IBL PBR, geometric normals |
| 13 | <img src="images/scenes/scene13.png" alt="Scene 13 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.014}}$ | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.014}}$ | material grid, ground, explicit occlusion |
| 14 | <img src="images/scenes/scene14.png" alt="Scene 14 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.290}} / \color{#1a7f37}{\textsf{0.051}}$ | $\color{#1a7f37}{\textsf{0.289}} / \color{#1a7f37}{\textsf{0.049}}$ | Flight Helmet glTF, default framing, IBL, ground, DDS skybox |
| 15 | <img src="images/scenes/scene15.png" alt="Scene 15 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | two scene-code spot lights over a Standard ground, cone cosine and exponent falloff |
| 19 | <img src="images/scenes/scene19.png" alt="Scene 19 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.096}} / \color{#1a7f37}{\textsf{0.430}}$ | $\color{#1a7f37}{\textsf{0.096}} / \color{#1a7f37}{\textsf{0.430}}$ | DDS cubemap environment compiled to harmonics and mip chain, scene-code clearcoat over IBL. The region figure is one-step rounding on the coat: every sphere pixel is within one channel step, and the environment beneath it is exact |
| 21 | <img src="images/scenes/scene21.png" alt="Scene 21 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.332}} / \color{#1a7f37}{\textsf{0.332}}$ | $\color{#1a7f37}{\textsf{0.332}} / \color{#1a7f37}{\textsf{0.332}}$ | scene-code sheen under the pinned legacy model, `.env` cubemap reused as its own skybox, destructured parallel loads |
| 39 | <img src="images/scenes/scene39.png" alt="Scene 39 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.002}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.002}}$ | `KHR_animation_pointer` driving node rotation and `KHR_texture_transform` offset and scale across two scrolling water surfaces |
| 50 | <img src="images/scenes/scene50.png" alt="Scene 50 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | 250 pure-2D sprites over a compile-time-drawn canvas2D atlas: grid frames, per-sprite tint, rotation and flip, straight-alpha blending through a SpriteRenderer with no scene. The two backends are byte-identical to each other and to the golden |
| 24 | <img src="images/scenes/scene24.png" alt="Scene 24 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.021}} / \color{#1a7f37}{\textsf{0.022}}$ | $\color{#1a7f37}{\textsf{0.015}} / \color{#1a7f37}{\textsf{0.016}}$ | Hill Valley `.babylon` geometry, textures, baked lighting |
| 28 | <img src="images/scenes/scene28.png" alt="Scene 28 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.016}}$ | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.016}}$ | `KHR_materials_clearcoat` intensity, roughness, coat normals |
| 29 | <img src="images/scenes/scene29.png" alt="Scene 29 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.009}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.009}}$ | `KHR_materials_sheen` with `KHR_texture_transform` scaling |
| 30 | <img src="images/scenes/scene30.png" alt="Scene 30 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.160}} / \color{#1a7f37}{\textsf{0.192}}$ | $\color{#1a7f37}{\textsf{0.046}} / \color{#1a7f37}{\textsf{0.062}}$ | Draco-compressed geometry decoded at generation time, transmission and volume with a UV-offset transform |
| 31 | <img src="images/scenes/scene31.png" alt="Scene 31 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.002}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.003}}$ | `KHR_materials_emissive_strength`, factor-only emissive |
| 32 | <img src="images/scenes/scene32.png" alt="Scene 32 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | `KHR_materials_unlit` |
| 33 | <img src="images/scenes/scene33.png" alt="Scene 33 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.061}} / \color{#cf222e}{\textsf{1.457}}$ | $\color{#1a7f37}{\textsf{0.005}} / \color{#1a7f37}{\textsf{0.123}}$ | `KHR_lights_punctual` falloff across opaque, transmission, BLEND |
| 34 | <img src="images/scenes/scene34.png" alt="Scene 34 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | `KHR_node_visibility` subtree cascade, `KHR_animation_pointer` visibility target |
| 35 | <img src="images/scenes/scene35.png" alt="Scene 35 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | `EXT_mesh_gpu_instancing`, default framing, camera-target destructuring |
| 37 | <img src="images/scenes/scene37.png" alt="Scene 37 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.009}}$ | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.006}}$ | `EXT_texture_webp` images, per-slot texture transforms, `KHR_materials_sheen` with `KHR_materials_specular`, occlusion UV set chosen per material |
| 116 | <img src="images/scenes/scene116.png" alt="Scene 116 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | no-color material views, depth targets |
| 145 | <img src="images/scenes/scene145.png" alt="Scene 145 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.022}} / \color{#1a7f37}{\textsf{0.022}}$ | $\color{#1a7f37}{\textsf{0.008}} / \color{#1a7f37}{\textsf{0.008}}$ | `.babylon`, Standard geometry outputs, default anisotropy |
| 146 | <img src="images/scenes/scene146.png" alt="Scene 146 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.021}} / \color{#1a7f37}{\textsf{0.018}}$ | $\color{#1a7f37}{\textsf{0.021}} / \color{#1a7f37}{\textsf{0.018}}$ | FreeCamera Sponza, PBR geometry outputs, 7+4 MRT composition |
| 150 | <img src="images/scenes/scene150.png" alt="Scene 150 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | property `position.x` animation, track-derived frame rate |
| 151 | <img src="images/scenes/scene151.png" alt="Scene 151 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | grouped position, scaling, and quaternion property animation |
| 154 | <img src="images/scenes/scene154.png" alt="Scene 154 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | LINEAR versus STEP property interpolation |
| 159 | <img src="images/scenes/scene159.png" alt="Scene 159 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | scene-local WGSL shader variant, flat-color fragment |
| 161 | <img src="images/scenes/scene161.png" alt="Scene 161 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | scene-local WGSL variant with typed custom uniforms |
| 163 | <img src="images/scenes/scene163.png" alt="Scene 163 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | custom shader blend, alpha test, discard |
| 168 | <img src="images/scenes/scene168.png" alt="Scene 168 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.002}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.002}}$ | double-sided winding through a clockwise front-face pipeline |
| 176 | <img src="images/scenes/scene176.png" alt="Mosquito in Amber" width="160"> | $\color{#1a7f37}{\textsf{0.064}} / \color{#1a7f37}{\textsf{0.064}}$ | $\color{#1a7f37}{\textsf{0.039}} / \color{#1a7f37}{\textsf{0.039}}$ | linear transmission, alpha state, IOR, volume, scene-color copy |
| 178 | <img src="images/scenes/scene178.png" alt="Scene 178 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.018}} / \color{#1a7f37}{\textsf{0.016}}$ | $\color{#1a7f37}{\textsf{0.018}} / \color{#1a7f37}{\textsf{0.016}}$ | `KHR_materials_iridescence`, camera-following skybox |
| 210 | <img src="images/scenes/scene210.png" alt="Scene 210 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | `KHR_xmp_json_ld` metadata on a rounded cube |
| 212 | <img src="images/scenes/scene212.png" alt="Scene 212 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.172}} / \color{#1a7f37}{\textsf{0.182}}$ | $\color{#1a7f37}{\textsf{0.022}} / \color{#1a7f37}{\textsf{0.024}}$ | `KHR_materials_dispersion` per-RGB refraction, IOR, volume |
| 213 | <img src="images/scenes/scene213.png" alt="Scene 213 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.001}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.001}}$ | GridMaterial opaque/transparent families, ordered draw lists |
| 216 | <img src="images/scenes/scene216.png" alt="Scene 216 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | linear `setFog` mixed before tone mapping |
| 240 | <img src="images/scenes/scene240.png" alt="Scene 240 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | deterministic glTF node rotation animation |
| 242 | <img src="images/scenes/scene242.png" alt="Scene 242 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.003}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.004}}$ | `KHR_animation_pointer` base color, emissive factor and emissive strength on LINEAR samplers |
| 243 | <img src="images/scenes/scene243.png" alt="Scene 243 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.005}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.005}}$ | MorphStressTest glTF, overlapping clips, storage-buffer morphing, uv2 occlusion |
| 244 | <img src="images/scenes/scene244.png" alt="Scene 244 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.005}} / \color{#1a7f37}{\textsf{0.057}}$ | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.011}}$ | `KHR_animation_pointer` texture-transform rotations on two slots of one material that disagree, `KHR_materials_specular`, transmission reached from the asset |
| 245 | <img src="images/scenes/scene245.png" alt="Scene 245 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.001}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.001}}$ | recursive skeleton, inverse bind matrices, GPU skinning |
| 246 | <img src="images/scenes/scene246.png" alt="Scene 246 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | deterministic SimpleSkin glTF animation |
| 247 | <img src="images/scenes/scene247.png" alt="Scene 247 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.014}}$ | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.014}}$ | `EXT_mesh_gpu_instancing` T/R/S, one native instanced draw |
| 248 | <img src="images/scenes/scene248.png" alt="Scene 248 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | external glTF and sampler modes |
| 249 | <img src="images/scenes/scene249.png" alt="Scene 249 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.004}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.004}}$ | vertex-color alpha and mask cutoff |
| 252 | <img src="images/scenes/scene252.png" alt="Scene 252 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | direct single-target morph deformation on a generated Standard sphere |
| 253 | <img src="images/scenes/scene253.png" alt="Scene 253 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.128}} / \color{#cf222e}{\textsf{1.936}}$ | $\color{#1a7f37}{\textsf{0.086}} / \color{#cf222e}{\textsf{1.328}}$ | `KHR_animation_pointer` across node transforms, punctual lights and material extensions, spot lights, 69 channels. The region figure carries a known defect, not a floor: the iridescence sphere, the one material whose metallic factor is animated, retains a structured interior difference |
| 254 | <img src="images/scenes/scene254.png" alt="Scene 254 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.004}}$ | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.003}}$ | signed animation sampler accessors, quaternion slerp |
| 255 | <img src="images/scenes/scene255.png" alt="Scene 255 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | normalized integer skin-weight accessors |
| 256 | <img src="images/scenes/scene256.png" alt="Scene 256 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.008}} / \color{#1a7f37}{\textsf{0.077}}$ | $\color{#1a7f37}{\textsf{0.008}} / \color{#1a7f37}{\textsf{0.077}}$ | cotangent-frame normal mapping on a mesh with no TANGENT accessor |
| 257 | <img src="images/scenes/scene257.png" alt="Scene 257 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.006}}$ | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.005}}$ | negative-scale hierarchy, generated normals |
| 258 | <img src="images/scenes/scene258.png" alt="Scene 258 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.002}} / \color{#1a7f37}{\textsf{0.005}}$ | $\color{#1a7f37}{\textsf{0.002}} / \color{#1a7f37}{\textsf{0.004}}$ | interleaved glTF vertex buffers |
| 259 | <img src="images/scenes/scene259.png" alt="Scene 259 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | factor-only emissive material with neutral texture fallback |
| 260 | <img src="images/scenes/scene260.png" alt="Scene 260 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | TRIANGLE_STRIP primitive mode with uint32 indices |
| 265 | <img src="images/scenes/scene265.png" alt="Scene 265 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.016}}$ | $\color{#1a7f37}{\textsf{0.001}} / \color{#1a7f37}{\textsf{0.016}}$ | `EXT_lights_image_based` RGBD cubemap, BRDF LUT, SH irradiance, rotation |
| 266 | <img src="images/scenes/scene266.png" alt="Scene 266 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.021}} / \color{#1a7f37}{\textsf{0.038}}$ | $\color{#1a7f37}{\textsf{0.021}} / \color{#1a7f37}{\textsf{0.038}}$ | mirrored spheres, source-derived clockwise front face |
| 267 | <img src="images/scenes/scene267.png" alt="Scene 267 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | Standard RGBA vertex colors on a raw typed-array quad, unlit and double-sided |
| 268 | <img src="images/scenes/scene268.png" alt="Scene 268 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | opt-in orthographic projection, aspect-derived view volume |
| 273 | <img src="images/scenes/scene273.png" alt="Scene 273 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | post-registration material-family addition |
| 274 | <img src="images/scenes/scene274.png" alt="Scene 274 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | 4x-MSAA alpha-to-coverage |
## Project-owned differential gates

These scenes are authored in `bblitec`, but their browser reference still runs
the same TypeScript against the pinned Babylon Lite package. Their MAD measures
native differential fidelity; it does not represent upstream corpus coverage.

They are scaffolding for contracts no measured corpus scene reaches yet — a
feature combination the corpus does not exercise, or a slice being built up
ahead of the scene that will use it. A gate is deleted once corpus scenes cover
its contract.

| Scene | Preview | SDL_GPU | Dawn | Coverage |
| --- | :---: | ---: | ---: | --- |
| compiler-state | <img src="images/scenes/regression-compiler-state.png" alt="Compiler state rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | flat-entry mutable state, pre-registration compound assignment |
| glTF-track-clamp | <img src="images/scenes/regression-track-clamp.png" alt="glTF track clamp rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | track endpoint clamping against a longer global duration |
| shader-frame-graph | <img src="images/scenes/audit-shader-frame-graph.png" alt="Shader frame graph rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.000}}$ | shader materials through a frame-graph render task |
| runtime-sweep | <img src="images/scenes/regression-runtime-sweep.png" alt="Runtime sweep rendering" width="160"> | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.001}}$ | $\color{#1a7f37}{\textsf{0.000}} / \color{#1a7f37}{\textsf{0.001}}$ | thin-instance pools with flush and count updates, handles inside data retired by `removeFromScene`, file-texture sampler contract (Scene 267 measures typed-array meshes from the corpus) |
| instanced-ground | <img src="images/scenes/regression-instanced-ground.png" alt="Instanced ground rendering" width="160"> | $\color{#1a7f37}{\textsf{0.136}} / \color{#1a7f37}{\textsf{0.089}}$ | $\color{#1a7f37}{\textsf{0.136}} / \color{#1a7f37}{\textsf{0.089}}$ | `EXT_mesh_gpu_instancing` with the requested environment ground |
| morph-ground | <img src="images/scenes/regression-morph-ground.png" alt="Morph storage ground rendering" width="160"> | $\color{#1a7f37}{\textsf{0.150}} / \color{#1a7f37}{\textsf{0.190}}$ | $\color{#1a7f37}{\textsf{0.150}} / \color{#1a7f37}{\textsf{0.190}}$ | storage-buffer morphing with the requested environment ground |

## Diagnostics

Scene 1 parity can emit:

- draw and triangle-cluster IDs
- world normal, reflectivity, irradiance, IBL
- normalized depth, albedo, and direct light
- raw base color and pre-tone HDR (`RGBA16F` raw plus PNG preview)
- background, edge, interior, channel-bias, hotspot, and material attribution

Normalized depth is bit-exact against the Babylon Lite WebGPU oracle. See
[fidelity.md](fidelity.md) for artifact semantics.

Current Scene 1 foreground diagnostic MAD: world normal `0.011`, albedo
`0.000`, reflectivity `0.000`, irradiance `0.040`, normalized depth `0.000`.

Requested environment grounds and DDS/HDR skyboxes render by default. They can
be disabled independently with `BBLITE_GROUND=0` and `BBLITE_BACKGROUND=0`.

## Shader pipeline

All native GPU shader families originate as WGSL and use pinned Tint. No HLSL
or MSL source templates remain under `src/`.

| Target | Offline path |
| --- | --- |
| D3D12 | WGSL → Tint HLSL → normalized registers/signatures → DXC DXIL |
| Vulkan | WGSL → Tint HLSL → normalization → DXC SPIR-V |
| Metal | WGSL → Tint MSL |

Tint Inspector bindings are checked against generated WGSL. DXIL/SPIR-V
artifacts are content-addressed and reused across scenes. Direct Tint SPIR-V is
deferred until its resource bindings are remapped to SDL_GPU conventions. The
Dawn backend bypasses this table entirely: it hands the generated WGSL to its
in-process pinned Tint at startup, with no offline artifacts or shader cache.

## Current boundaries

- one statically analyzable entry file and one engine
- selected TypeScript expressions, assignments, callbacks, and intrinsics
- the plain-data model is value-semantic apart from const locals bound to a
  container element or member, which bind a native reference so writes reach
  the container (a mutable local stays a copy that rejects writes, and using a
  reference after its container is resized is a compile error), object parameters pass by native reference,
  `new Array` elements zero-initialize, and `Math.random` is the pinned
  seeded sequence (each recorded in generated `fidelity.json`)
- no arbitrary object graphs, runtime object identity, or runtime module
  loading; a class instance is a compile-time record of field bindings and
  cannot be stored in data or selected at runtime, and a field holding a
  resource is wired once rather than reassigned; a record's methods and
  getters close over the scope that built them, but the record itself is
  still compile-time and cannot be stored in data or chosen between at
  runtime; recursion stays rejected
- no physics, audio, or networking
- property animation covers LINEAR/STEP scalar/vector tracks, quaternion
  slerp, group ranges/looping/speed, and deterministic seeking for reached
  mesh `position`, `position.x`, `scaling`, and `rotationQuaternion` paths
- glTF animation covers LINEAR/CUBICSPLINE rotation, translation, and scale
  plus LINEAR morph weights; morphing and skinning are vertex-shader
  evaluated.
  Meshes above two morph targets use Babylon's pinned uncapped
  storage-buffer morph path; CPU fallback remains for skins beyond 64
  joints and CPU face-normal recomputation for primitives without source
  normals
- glTF STEP channels, multiple-clip controls, broader property targets,
  and Standard scenes beyond two simultaneous lights remain unsupported
- a spot light created in scene code carries its colors and intensity; its
  `angle`, `exponent`, and `range` setters, a spot in the first PBR analytic
  slot, and a spot composed with Standard geometry outputs all fail
  explicitly
- direct `createMorphTargets` covers one target attached to one mesh; broader
  target sets and reusable target objects remain unsupported
- scene fog is ported for PBR, Standard, and image-skybox surfaces; fog
  composed with Grid, custom-shader, environment-ground/DDS-skybox
  background, transmission, geometry-output, or diagnostic surfaces
  fails explicitly until those fog fragments are ported
- PBR material extensions cover clearcoat, sheen, iridescence, and dispersion
  with one shared UV transform; specular and anisotropy, per-slot texture
  transforms, and layered composition combined with punctual multi-light
  remain unsupported
- reached custom shader variants compile from the scene's own WGSL
  sources through the typed shader IR (parse, validate, reflect,
  re-emit) with pinned Tint HLSL/MSL emission plus DXC DXIL/SPIR-V
  compilation; the supported WGSL subset and the worldViewProjection
  system uniform bound the surface — arbitrary system-uniform sets and
  matrix-valued custom uniforms remain unsupported
- GridMaterial, frame-graph blit/depth, and attribution utilities use
  generated WGSL through Tint
- ground and cubemap-skybox fragments use generated WGSL through Tint
- PBR and Standard material, diagnostic, and geometry variants use WGSL through
  Tint; no HLSL/MSL source templates remain
- D3D12 is validated locally; Vulkan and Metal artifacts are generated but
  still require real-device validation

Unfinished priorities are maintained only in [TODO](../TODO.md).
