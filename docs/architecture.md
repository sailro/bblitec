# Architecture

## Pipeline

```text
scene TypeScript
    -> AST validation and browser erasure
    -> reached features and materialized assets
    -> pinned Babylon Lite source reconstruction
    -> dedicated lowerers
    -> generated C++20, shaders, manifests, provenance
    -> typed runtime + PAL
    -> SDL3 + (SDL_GPU | Dawn)
```

`bblitec` is a compiler, not an interpreter. Unsupported syntax or Babylon APIs
produce source-located errors.

The entry frontend is built as a TypeScript `Program` with a `TypeChecker`.
Babylon intrinsics are identified by resolved import symbols, then dispatched
through focused intrinsic modules. Generated behavior must never depend on
scene names or regular-expression matching of entry-source text.

The repository pins one reviewed Babylon Lite package and source commit, in
`upstream/babylon-lite.json`. Original TypeScript is recovered from published
source maps. Lowerers assert expected upstream symbols, constants, and
formulas before emitting code.

## Ownership

| Layer | Owns |
| --- | --- |
| Entry compiler | AST validation, feature selection, assets, generated main/CMake manifest |
| Upstream lowerers | Babylon semantics, typed records, render plans, uniforms, shader variants |
| Native runtime | handles, engine-owned records, immediate AOT TypeScript/Web primitives |
| PAL | files, paths, environment, clocks, SDL window/input, GPU resources and commands |

Babylon behavior must not migrate into PAL. SDL and operating-system mechanics
must not migrate into generated code.

Primary source ownership:

| Source | Responsibility |
| --- | --- |
| `src/cli.ts` | the `bblitec` entry: one scene compile end to end — frontend, asset materialization, composition, emitters, generated tree |
| `src/compose-pipeline.ts` | pinned variant composition between settled assets and emitter options: scene arms, PBR/Standard variant tables, mesh-feature tables |
| `src/babylon-asset-features.ts` | the `.babylon` asset scans generation keys on: light slots, texture selections, per-light mesh lists |
| `src/feature-activation.ts` | the per-scene `upstream/feature-activation.json` activation inventory |
| `src/compiler.ts` | entry-scene AST lowering, features, assets, generated main/CMake |
| `src/compiler/program.ts` | in-memory TypeScript `Program`/`TypeChecker` frontend |
| `src/compiler/symbols.ts` | resolved Babylon import symbols and aliases |
| `src/compiler/static-evaluator.ts` | typed static scalar/vector/color expression evaluation |
| `src/compiler/expressions.ts` | the value switch and call dispatch every expression position goes through |
| `src/compiler/browser-erasure.ts` | browser-only expressions, their compile-time values (the reference pose's query string included), erased instrumentation |
| `native/include/bblite/pal_ui.hpp` | browser-neutral retained UI and bounded Canvas2D IR operations, plus the opaque PAL projection seam |
| `native/src/pal_ui_rml.cpp` | incremental RmlUi document projection, Canvas path tessellation, SDL input, CSS adaptations, and backend-neutral draw-frame recording |
| `native/src/pal_sdl_gpu.cpp`, `native/src/pal_dawn.cpp` | consume recorded UI frames through renderer-owned texture caches, transparent multisample layers, resolve, and final composition |
| `ui/*.json` | audited static host-page chrome projected beside immutable scene-created UI |
| `native/src/pal_system_fonts.cpp` | retained-UI font resolution through the host's own service — DirectWrite, CoreText or fontconfig — behind `pal_system_fonts.hpp` |
| `src/compiler/data-types.ts` | plain-data type mapping (structs, enums, optionals, arrays, tables, and borrowed platform-event fields) and generated definition emission, including the `json_write` codecs emitted for exactly the records `JSON.stringify` reaches |
| `src/compiler/json-bridge.ts` | `JSON.stringify`/`JSON.parse` and the surface a parsed document is interrogated with: the dynamic value's reads, `Array.isArray`, `typeof`, and the strict comparison |
| `src/compiler/web-storage.ts` | the three reached `localStorage` methods, recognised by the DOM global they read rather than by name |
| `src/compiler/browser-file.ts` | the default-global `Blob`/`URL` slice and its opaque values: ordered string/byte parts, object-URL lifetime, one-file list indexing, `File.text()`, and static accept validation |
| `src/compiler/data-lowering.ts` | data paths, typed literals/sinks, container methods, runtime `Math`, aliasing contracts, destructuring |
| `src/compiler/data-methods.ts` | the shared read/mutate/store classification for plain-data methods |
| `src/compiler/module-initializers.ts` | reachability and dependency planning for observable imported-module state |
| `src/compiler/native-functions.ts` | once-emitted real C++ functions for fully data-typed user functions |
| `src/compiler/user-functions.ts` | inline lowering for handle-touching local functions, calls, parameters, and returns |
| `src/compiler/statements.ts` | statement dispatch, conditions, expression statements, and method calls |
| `src/compiler/classes.ts` | reached local class identity, fields, constructors, inlined methods and getters, and the shared-instance form a native data position demands: the `Ref<XData>` allocation, the hoisting proof, and the hydration a stored receiver inlines through |
| `src/compiler/handle-collections.ts` | the one value kind for a generation-known collection of engine handles, and every entry-compiler operation over one: iteration frames, pushes, the runtime find, the imported-walk proofs |
| `src/compiler/sprite-atlas-record.ts` | typed data-record projection into the native sprite-atlas handle model |
| `src/compiler/promises.ts` | immediate AOT `Promise<T>` lowering |
| `src/compiler/assignments.ts` | typed property-assignment validation and lowering |
| `src/compiler/properties.ts` | the declared property reads: which native expression names a handle's property, and which properties are refused |
| `src/compiler/property-animation.ts` | compile-time clip/track/key lowering and group options |
| `src/pinned-mesh-defaults.ts` | a pinned factory's own defaults: the `??` a builder resolves an option through, and `createTransformNode`'s parameter initializers |
| `src/pinned-polyhedra.ts` | the pin's polyhedron table, executed: the preset a scene selects reaches the emitted record alone |
| `src/pinned-address-modes.ts` | the pin's WebGPU address-mode and filter spellings as native enumerators, shared by every sampler-reading loader — an unlisted mode fails generation by name |
| `src/compiler/shader-material.ts` | shader-material variant matching by IR identity and scene-local variant registration |
| `src/compiler/assets.ts` | asset registration from scene URLs to packaged local files |
| `src/executed-module-assets.ts` | assets a scene module produces rather than fetches — a drawn canvas2D atlas, a computed pixel buffer — run in headless Chromium and baked |
| `src/compiler/browser-texture-function.ts` | the structural gate over a canvas-owning scene function whose textures are produced rather than fetched, its bounded Chromium execution against a stub that records only `createTexture2DFromPixels`/`loadTexture2D`, and the packaged RGBA or PNG blob each one becomes |
| `src/compiler/adaptations.ts` | the reached-adaptation manifest entries generation records |
| `src/compiler/option-helpers.ts` | the shared option-object validation contracts |
| `src/compiler/intrinsics/*` | focused resolved-symbol engine, scene, asset, animation, camera, light, mesh, material, and sprite intrinsic lowerers |
| `src/compiler/types.ts` | compiler public result types and internal typed values/features |
| `src/upstream-source.ts` | pinned source-map reconstruction, handed out as the pin's own package build leaves it |
| `src/pinned-wgsl-build.ts` | the pin's tagged-WGSL build transform, executed from its pinned script so a shader folded from a builder's AST is the package's text, and the `packagedWgsl` tag that spells a text marker from source through the same step |
| `src/upstream-graph.ts` | conservative reachable-module analysis — test-only until scene 144's bloom observation seam consumes it |
| `src/upstream-lower.ts` | lowerer orchestration, provenance, generated capabilities |
| `src/pinned-shader-composer.ts` | runs the pin's `composeShader`, lifts named declarations out of a composition verbatim, imports a pinned module with chosen imports observed |
| `src/lowering/pinned-shader-defines.ts` | the `defines` half of the pin's ShaderMaterial prelude, evaluated from `buildShaderPrelude` |
| `src/pinned-post-process.ts` | runs a post-process factory and `getShaderModule` so a pass deploys the browser's module; runs a composite's factory for the chain it builds |
| `src/post-process-effects.ts` | per effect: which options reach the composed text, which scalars its writer reads, which textures bind after the source |
| `src/pinned-pbr-variants.ts` | registers the PBR extensions in the pin's order and composes a variant |
| `src/pinned-clustered-lights.ts` | the clustered light field's two PBR extensions, lifted from the module that registers them |
| `src/lowering/clustered-light-lowerer.ts` | the field's arithmetic, folded from its own bodies: the sizing constants, the five scalar helpers, the sphere-to-tile cull and the per-light assignment |
| `src/lowering/clustered-light-runtime.ts` | the field's behaviour around them: the container's sizing, the per-frame re-bin against the frame's own two matrices, and the scene's four entry points |
| `src/compiler/intrinsics/clustered-light.ts` | which of those entry points a scene reached, and the one compile-time fact among them — whether the container ever held a spot |
| `src/pinned-node-material.ts` | runs the pin's node-material compiler over an NME graph against a recording device, refusing every arm outside the reached slice |
| `src/pinned-node-particle.ts` | runs the pin's node-particle parser, builder and CPU simulation in the browser and returns the frozen particle state |
| `src/lowering/node-particle-lowerer.ts` | the folded half: the billboard and pure-2D bridges and their three blend mappings, from their own declarations over the baked state |
| `src/pinned-splat-fragments.ts` | the splat shader plugins a `loadSplat` names, and `applyGsFragments` run over them |
| `src/lowering/linear-depth-lowerer.ts` | `createLinearDepthMaterial`, folded from the factory that builds it — stages, declarations and fixed-function state |
| `src/lowering/compressed-texture-lowerer.ts` | the KTX1 container: the pin's parser lowered to C++, its format table, and the suffix selection and URL rewrite generation folds |
| `src/basis-transcode.ts` | the pinned Basis and KTX2 loaders run in headless Chromium, each packaged as a KTX1 container |
| `src/lowering/vat-lowerer.ts` | the baked vertex-animation subsystem from `vat/vat-baker.ts`: the bake loop over each clip's frames, the 32-byte settings block `play`/`update` write, the per-instance params expansion, and the deterministic frozen pose a measured seek asks for |
| `src/compiler/intrinsics/vat.ts` | which VAT calls a scene reached — `bakeVat`/`attachVat` are the pin's own opt-in — and the three writers a `VatHandle` carries |
| `src/lowering/sprite-lowerer.ts` | the sprite families' emitted runtime: the pure-2D and depth-hosted layers, the renderer's own per-frame hook list, and the optional renderer-native Y-sort module gated on `sprite:2d-y-sort` — whose draw key and serial tie-break are read off the pin's `keyAt`/`comesBefore` rather than spelled here |
| `src/lowering/sprite-animation-lowerer.ts` | the sprite frame stepper and its delay normalisation, lowered from their own pinned declarations, plus the tagged target the two families share |
| `src/lowering/pinned-grid-atlas.ts` | `createGridSpriteAtlas`, emitted once for the two loaders that partition a texture into frames |
| `src/pinned-picking-shaders.ts` | the three modules a GPU pick draws through -- mesh, cloud and the detailed pipeline -- composed by running the pin's own builders |
| `src/lowering/picking-lowerer.ts` | the picker's bookkeeping; every answer belongs to the backend that owns the buffers |
| `src/lowering/gizmo-lowerer.ts` | the gizmo family from `src/gizmo/*`: the utility layer, the camera and light displays, the four editing widgets, the three composites, the three per-frame follows the pin writes for them, and the assertion that the pointer-drag dispatcher map is inert |
| `src/lowering/physics-lowerer.ts` | the rigid-body family from `havok.ts`, the trigger volumes from `havok-trigger.ts` and the multi-region simulation from `havok-floating-origin.ts`: the step gate, the four frame phases, the aggregate ordering, `_buildShapeParams`' shape sizing, the primitive-shape factory both shape paths fork on, the mesh accumulator the convex-hull and triangle-soup arms share, and the region lookup, placement, migration and reclaim a floating-origin world steps through instead |
| `src/compiler/intrinsics/physics.ts` | which physics calls a scene reached, and the erased solver module its `await HavokPhysics(...)` produced |
| `src/lowering/audio-lowerer.ts` | the drift gate on the audio engine's folded output graph: every statement `bus.ts` and `createAudioEngineAsync` declare, asserted |
| `src/compiler/intrinsics/audio.ts` | the Babylon half of the audio surface: the engine lifecycle reached, and every sound/bus/spatial entry point that refuses by name |
| `src/compiler/audio-surface.ts` | the browser half: Web Audio method calls and property writes on the context the engine hands back |
| `src/lowering/shadow-lowerer.ts` | the shadow family: light-space basis, spot/directional volume, parented caster worlds and live `boundMin`/`boundMax` overrides, 4x4 multiply, caster bias, the generator's GPU contracts, and the depth-only render task `ensurePcfShadowTaskState` builds |
| `src/compiler/intrinsics/shadow.ts` | which shadow surface a scene reached: the generator factory, its caster-mesh task input, the registration installing the shadow task |
| `src/pinned-shadow-slots.ts` | which lights a receiving mesh samples and with which filter: the pin's `ShadowLightSlot` rows both receiver families share |
| `src/pinned-esm-shadow.ts` | the ESM generator's GPU resources, read by running the pinned factory against a recording device — its four textures, the two-pass blur and the kernel-folded tap table |
| `src/lowering/line-lowerer.ts` | the line family: the polyline flatten as C++, and the `ShaderMaterial` `createLineMaterial` composes |
| `src/compiler/line-material.ts` | which line-material permutation a call settled, registered through the one shader-variant registrar |
| `src/compiler/deterministic-random.ts` | the `Math.random` a scene installs as its simulation seed: recorded for the bake, refused where lowered code would also answer it |
| `src/compiler/particle-buffer.ts` | a particle buffer as generation-time state: column writes and live-count guards move to the bake driver and emit nothing |
| `src/pinned-tone-mapping.ts` | the tone-mapping record a scene selects, read from the pinned module that owns it -- the curve is a value upstream, not a flag |
| `src/data-url.ts` | a `data:` asset URL, whose bytes are the source text rather than a location to fetch |
| `src/lowering/effect-lowerer.ts` | the fullscreen-effect family: the pin's own vertex stage lifted, its pass state asserted, and the two records a scene fills |
| `src/lowering/render-target-lowerer.ts` | renderer-independent render-target allocation, including the pinned colour/depth texture-view fork |
| `src/lowering/frame-graph-context-lowerer.ts` | scene-less task ownership, update callbacks, and engine registration from the pin's `FrameGraphContext` |
| `src/pinned-effect-cpp.ts` | the C++ transcript of one `EffectWrapper`: which stages it draws and what its declared bind group holds |
| `src/pinned-node-material-cpp.ts` | the C++ transcript of that run: node variant table, vertex inputs, folded uniform bytes, the pin's mesh block mirrored |
| `src/compiler/node-material.ts` | which graph a `parseNodeMaterialFromSnippet` call reached: a static JSON literal read as data, or a module generation executes |
| `src/pinned-standard-variants.ts` | the Standard sibling: derives the pin's own feature words and composes the Standard colour and geometry variants |
| `src/pinned-material-input.ts` | maps a glTF material to the shape `_computePbrMaterialFeatures` reads, by executing the loader's own extension builders against a recording stub |
| `src/pinned-material-arms.ts` | composes every material a scene loads and refuses a fragment missing an arm one of them reaches |
| `src/pinned-material-plugins.ts` | material plugins composed through the pin's own `pbrPluginExt`/`stdPluginExt` bridges, behind the same `enableMaterialPlugins` opt-in; also reads the composed sampler binding pairs back off the Standard bridge for the generated table |
| `src/compiler/material-plugin.ts` | the scene's own `MaterialPlugin` folded to plain data: its name, its custom code per injection point, its sampler declarations, and the ordered textures its `bindTextures`/`getActiveTextures` pair fills them with |
| `src/pinned-scene-arms.ts` | the scene half of composition: light modes, tone mapping, fog bits |
| `src/pinned-light-mode.ts` | the pin's light-arm rule — `rebuildSingle`'s none/single/multi resolution — stated once for the runtime's variant key and generation's composed set |
| `src/pinned-mesh-features.ts` | the pin's mesh feature bits, imported rather than restated |
| `src/pinned-pbr-variant-cpp.ts` | C++ mirrors of each variant's UBO layout with offsets cross-checked against the composer, plus the variant-selector and texture-slot tables |
| `src/pinned-pbr-variant-output.ts` | writes the composed variant stages into the generated tree verbatim |
| `src/lowering/pinned-trs.ts` | a record's local world matrix from `eulerToQuat` and `mat4ComposeInto` — one home for every emission that needs it |
| `src/lowering/renderer-lowerer.ts` (camera viewport) | the two readers of `camera.viewport`, lowered whole on every plan: `getEffectiveAspectRatio` (every projection is built through it) and `resolveCameraViewport` with its own `clamp01` (the rectangle each backend's scene pass sets) |
| `src/lowering/pinned-normalize-vec3.ts` | the pin's `normalizeVec3` lowered whole, its `1e-10` epsilon included, for the detailed pick's normal and ray |
| `src/lowering/pinned-ubo-writer-lowerer.ts` | lowers the pin's material/extension UBO writers from their own ASTs |
| `src/lowering/post-process-lowerer.ts` | the pass's contracts (internal target, viewport, bind-group order, blend table) and each effect's `writeUniforms`, from the pin's AST |
| `src/lowering/context.ts` | source-located AST declarations, expression contracts, and diagnostics |
| `src/lowering/*-lowerer.ts` | focused Babylon API and formula lowering |
| `src/lowering/gltf/*` | the generated glTF loader by focused module: assembly over the C++ template, plus cameras, punctual lights, IBL, accessor normalization, animation interpolation, sampler mapping, bone control, and the material/extension/image-processing defaults — each from its own pinned declarations |
| `src/lowering/factory/*` | the factory families scenes call directly: the grown-array mesh builders, `createTube`'s pinned chain, and the material factories with their no-colour/ESM caster views |
| `src/lowering/templates/` | the generated `.babylon`/glTF loader C++ templates |
| `corpus/babylon-lite/` | byte-identical registered scene inputs from the pinned source commit |
| `upstream/babylon-lite-corpus.json` | immutable scene, support-module, and application paths with SHA-256 evidence |
| `native/include/bblite/` | typed runtime records, handles, PAL contracts |
| `native/src/pal.cpp` | filesystem, paths, environment, timing, host engine |
| `native/src/pal_storage.cpp` | Web Storage's platform half: one file per key under the host's own preference directory (`SDL_GetPrefPath`), injectively encoded names, staged writes. Its own translation unit, so an executable that never stores anything carries none of it |
| `native/include/bblite/js_json.hpp` | the generic JSON bridge: the ordered writer `JSON.stringify` emits through, the dynamic value `JSON.parse` answers, and the parser behind it |
| `native/include/bblite/js_storage.hpp` | the three reached `localStorage` methods as JavaScript shapes over the PAL store — nullable read, throwing write and remove |
| `native/include/bblite/js_file.hpp` | bounded Blob bytes, per-engine generation-checked object URLs, reference-owned and aggregate-bounded File/FileList snapshots, and the browser default actions over PAL dialogs; it exposes no path to scene code |
| `native/src/pal_file.cpp`, `native/src/pal_file_io.hpp` | feature-selected SDL3 save/open dialogs, bounded immutable selected-file snapshots, UTF-safe paths, and randomized exclusive same-directory atomic replacement shared with Web Storage and the legacy voxel picker |
| `native/src/pal_sdl.cpp` | image decode, and the engine entry point that dispatches to a GPU backend |
| `native/src/pal_window.hpp` | engine-run SDL window ownership across renderer rebuilds; final window/SDL cleanup independent of scene GPU resources |
| `native/include/bblite/pal_physics.hpp` | the rigid-body solver contract: the `HP_*` surface the pinned physics layer calls on the module it is handed, including the world create/release, body add/remove, speed-limit and velocity-write entry points the multi-region floating origin reaches |
| `native/src/pal_physics_bullet.cpp` | that surface over Bullet: Havok's measured stepping model, ordering repairs, convex mass frames, static-only triangle-mesh colliders, Havok body defaults, contact convergence and opt-in CPU counters ([fidelity](fidelity.md#physics-contract)) |
| `native/include/bblite/pal_navigation.hpp` | the navigation contract: the Recast/Detour surface the pinned wrapper calls on the module it loads |
| `native/include/bblite/pal_audio.hpp` | the Web Audio contract: the browser surface the pinned audio module calls, which is the seam the pin itself draws |
| `native/src/pal_audio_labsound.cpp` | that surface over LabSound, a fork of WebKit's own WebAudio ([fidelity](fidelity.md#audio-contract)) |
| `native/src/pal_audio_sdl_device.hpp` | SDL3 behind LabSound's `lab::AudioDevice`, so the platform stream stays SDL like every other service here |
| `native/src/pal_navigation_recast.cpp` | that surface over the wrapper's pinned recastnavigation commit, replaying `generateSoloNavMesh` and `generateTileCache`, the Detour query, the tile cache's obstacles and the crowd |
| `native/vcpkg-overlay-ports/recastnavigation/tile-cache/` | the two RecastDemo files `generateTileCache` reaches for, built from the pinned commit into a library of their own rather than transcribed |
| `native/src/pal_sdl_gpu.cpp` | SDL_GPU resources, uploads, pipelines, readback, submission |
| `native/src/pal_sdl_gpu_shared.hpp` | SDL_GPU-only mechanics: window/device/swapchain bring-up, shader load, buffer/texture upload, sampler, PNG readback |
| `native/src/pal_sdl_gpu_clustered.hpp` | the clustered field's three SDL_GPU data textures and their shared sampler, uploaded at the extents the container was sized to |
| `native/src/pal_sdl_gpu_sprite.cpp` | the pure-2D sprite pass on SDL_GPU — its own translation unit, since a sprite-only scene generates no camera or render-plan headers |
| `native/src/pal_sdl_gpu_effect.cpp` | the fullscreen-effect frame driver on SDL_GPU, a separate translation unit for the same reason |
| `native/src/pal_dawn_effect.cpp` | the same driver on Dawn |
| `native/src/pal_sdl_gpu_frame_graph.cpp` | the scene-less ordered-task driver on SDL_GPU; task-family guards omit unreached effect or post-process machinery |
| `native/src/pal_dawn_frame_graph.cpp` | the same scene-less task driver on Dawn |
| `native/src/pal_sdl_gpu_effect.hpp` | the SDL_GPU effect pass mechanics both its `.cpp` driver and the scene renderer's frame-graph task draw through |
| `native/src/pal_dawn_effect.hpp` | the Dawn effect pass mechanics, likewise shared by its driver and the frame graph |
| `native/src/pal_dawn_shared.hpp` | Dawn-only device, surface and swapchain bring-up, WGSL module loading, and the surface capture every driver screenshots through |
| `native/src/pal_dawn_clustered.hpp` | the same three data textures on Dawn, plus the params buffer its uniform block binds |
| `native/src/pal_dawn_sprite.cpp` | the same sprite pass on Dawn |
| `native/src/pal_dawn.cpp` | Dawn (WebGPU) resources, uploads, pipelines, readback, submission |
| `native/src/pal_gpu_shared.hpp` | vertex packing, RGBD decode, and deformation uniforms shared byte-identically by both GPU backends |
| `native/src/pal_render_capture.hpp` | the `BBLITE_RENDER_CAPTURE` writer both backends share, `pinnedMaterialBlocks`/`pinnedMeshBlocks` included |
| `native/src/pal_camera_controls.hpp` | SDL ArcRotate pointer/wheel and Free-camera key translation into the generated camera inertia math |
| `native/src/pal_platform_events.hpp` | DOM-compatible application events shared by every SDL-backed frame loop |
| `native/src/pal_runtime_trace.hpp` | opt-in, source-independent input/camera/dynamic-topology diagnostics shared by the native frame loops |
| `native/src/pal_sdl_gpu_sprite.hpp` | the SDL_GPU sprite pass mechanics its `.cpp` driver draws through |
| `native/src/pal_dawn_sprite.hpp` | the Dawn sprite pass mechanics its `.cpp` driver draws through |
| `native/src/pal_sprite_ui_sdl.hpp`, `native/src/pal_sprite_ui_dawn.hpp` | the recorded RmlUi frame blended directly into the standalone sprite driver's single-sample target, per backend |
| `native/src/pal_sdl_gpu_billboard.hpp`, `native/src/pal_dawn_billboard.hpp` | the world-space billboard pass each backend composes into the scene's own render pass, after the transparent meshes and against the scene depth |
| `native/src/pal_sdl_gpu_picking.hpp`, `native/src/pal_dawn_picking.hpp` | GPU picking per backend: the pin's one-pixel sheared-VP candidate render, the id/depth attachments and their readback, plus the detailed pass's third `rgba32uint` attachment |
| `native/src/pal_sdl_gpu_splat.hpp`, `native/src/pal_dawn_splat.hpp` | the Gaussian-splat pass per backend — the cloud's own pipeline, sort resources and draw, composed into a frame another renderer owns |

`generated\` is disposable and never the source of a fix.

## Compiler architecture

The entry compiler separates semantic analysis from Babylon-specific lowering
and native emission:

```text
ts.Program + TypeChecker
    -> reachable local module/function IR
    -> entry AST and static expression evaluation
    -> resolved Babylon intrinsic registry
    -> typed property-assignment contracts
    -> feature/asset/provenance collection
    -> C++20 and shader emission
```

Intrinsic identity comes from resolved TypeScript import symbols, not local
identifier spelling. Static values, assignments, and intrinsic families are
lowered by focused modules while `compiler.ts` owns compilation state and
output orchestration.

Named local imports and re-exports resolve through the same `ts.Program`.
Reached non-generic function declarations are type-checked at call sites.
Functions whose parameters and return type map entirely into the plain-data
model (numbers, booleans, interface structs, nullable objects, arrays,
readonly views, string-literal-union enums) are emitted once as real C++
functions with native early returns; object parameters pass by native
reference, matching JavaScript object aliasing. All other reached functions
are inlined per call site with isolated symbol scopes, default parameters,
and one final return. Recursive, generator, rest-parameter, and generic
functions are separated by capability: mutually recursive plain-data groups
lower to forward-declared native callbacks, while generators, rest parameters,
generics, and recursion carrying engine resources fail explicitly. Explicit
blocks and `if`/`else` branches own
nested symbol scopes and unique native names, so legal TypeScript shadowing
does not leak or collide.

An inlined call emits its body where the call sits and splices its returned
expression at the use site, so the two are separated by whatever the caller
emits between them. A call that both writes state outliving the frame — a
captured binding, or one reached through a by-reference parameter — *and*
returns an expression reading it therefore binds that value to a native local
first: `set(rnd(), rnd(), rnd())` must read three states, not the last one
three times. A return over the function's own locals needs no such snapshot,
because the inline frame gives each call its own storage for them.

The plain-data model keeps JavaScript container identity where it is observable:
arrays, maps, sets, recursive records, explicitly typed mutable objects, and
borrowed typed-array views retain shared or referenced native storage. Stored
plain-data function fields close over values, and retain the live engine by
reference only when their emitted body reaches it; composite function
parameters use the same
read-only/mutable reference policy at every lowering path. Locals that cannot
safely retain an alias reject writes, sparse `new Array` slots zero-initialize,
and `Math.random`
lowers to the pinned mulberry32 sequence with the browser capture harness
installing the identical generator. Every such divergence is recorded in the
generated `fidelity.json`.

Upstream semantic contracts use parsed declarations and expressions from the
pinned reconstructed source. Entry behavior must not depend on scene names or
source-text matching. Mechanical refactors preserve compiler-owned generated
artifacts byte-for-byte; unfinished compiler and shader-IR coverage belongs in
`TODO.md`.

Static custom WGSL is tokenized and lowered to `ShaderIrProgram`; a reached
program either matches a predeclared variant by IR identity or registers the
scene's own WGSL as a scene-local variant. Formatting and comments are not
shader identity; reach order is the generated variant table's index order,
and uniform setters resolve their offsets from the reached program's
reflected layout.

## Upstream upgrades

The compiler supports one reviewed Babylon Lite pin at a time. It does not
carry version branches or a plugin layer for hypothetical releases.
`upstream/babylon-lite.json` is the provenance source of truth; the package
manifest and lock file must select the same published version.

An upstream change is expected to fail at semantic seams:

- missing or moved public exports fail symbol resolution
- changed defaults and formulas fail co-located AST contracts
- changed entry APIs fail typed intrinsic or assignment lowering
- changed generated behavior fails compiler-output and parity gates

This keeps a version migration explicit without spreading version checks
through the compiler. Module paths and symbol contracts stay local to the
lowerer that owns the behavior. Curated source URLs, documentation, formulas,
and references remain intentionally reviewable evidence rather than being
silently rewritten from the pin.

## Scene orchestration

`src/scene-registry.ts` defines curated source/output/build paths, references,
thresholds, environment overrides, and optional attribution. The same workflow
also accepts unregistered repository-local TypeScript and derives defaults.

`src/scene-command.ts` provides compile, build, process, parity, compose, and
validate operations, plus the diagnostic commands (geometry, capture,
uniforms, diff, diagnose, stability, probe-variants, measure, neutrality,
neutrality-generated) the debugging ladder is built from.
`src/parity-scene.ts` is the common comparison runner. Generated output is
scene-local under `generated\<scene>`.

## Generated behavior

[features](features.md) is the catalogue of what the generated slice covers,
family by family, and which half of the pipeline each family falls in.

Each scene records:

- `manifest.json`: features, sources, assets, adaptations
- `fidelity.json`: intentional semantic adaptations
- `upstream/provenance.json`: upstream modules and symbols
- `upstream/renderer-fidelity.json`: shader contracts and invariants
- `upstream/feature-activation.json`: every activation unit — runtime
  features, capability defines, codecs, emit options, composed variants,
  refusals — with its concrete reason and pinned mirror
- `upstream/shaders/shader-material-reflection.json`: reached custom shader
  entry points, attributes, varyings, uniform layouts, bindings, and sizes
- `upstream/shaders/*.wgsl`: reached custom material source before IR lowering
- `upstream/shaders/*.native.wgsl`: SDL binding/location/depth specialization
- `upstream/shaders/variant-*.native.wgsl`: the pin's own composed PBR
  (`variant-`) and Standard (`variant-std-`) stages, verbatim
- `upstream/shaders/postprocess-*.native.wgsl`: the composed post-process
  modules, deployed once per module under the fragment stem, with the
  vertex stem declared beside it for the per-stem offline compiles.
  Indexed by the module rather than
  by the pass: two passes whose composed text is identical -- a blur pair
  differing only in its `direction` uniform -- share one
- `upstream/shaders/*.slots`: per stage, the register each block kept after
  compaction — the only authority on SDL_GPU slot order
  ([backends](backends.md#dawn-backend-architecture-nativesrcpal_dawncpp))
- `upstream/shaders/*.tint-reflection.txt`: Tint binding reflection check
- `upstream/shaders/shader-compiler.json`: selected offline target and
  participating compiler hashes
- `upstream/shaders/composition.json`: reached WGSL modules and content hashes

## Runtime and memory

Engine-owned data uses contiguous vectors and typed handles. The native
TypeScript subset provides typed arrays, `DataView`, `TextDecoder`, typed JSON,
and immediate AOT `Promise<T>`.

The supported subset does not need tracing GC: locals use C++ lifetimes,
stored function fields use native closure ownership, and engine records live
in arenas. A collector remains optional future work for cyclic objects or
other genuinely dynamic JavaScript graphs.

A plain-data object a scene declares is shared by identity through
`bbl::js::Ref<T>`, a reference count without atomics: compiled scene logic
runs on the one frame thread, and neither the audio device nor the physics
solver ever holds a scene record, so the interlocked increment a
`std::shared_ptr` copy performs would pay for a race that cannot happen. A
`Map` or `Set` of such objects looks a value up by that same reference, and a
lookup answers with a reference into the map's own slot so an optional chain
that reads one field copies nothing. `map.get(key)?.delete(value)` first copies
the retrieved Set wrapper into owned optional storage, preserving its shared
Set identity even when evaluating `value` erases, clears, or replaces the map
slot, and mutates it only when the lookup was present.

A synchronous platform callback may lend its `MouseEvent`, `KeyboardEvent`, or
base `Event` view to a plain-data payload. The field is a non-null, non-owning
`Borrowed` wrapper and an event-bearing payload record is reference-backed, so
handler writes to another payload field remain visible to the dispatch loop.
The compiler recursively rejects an actual borrowed value at every retained
container, class field, closure, listener, or timer boundary; a callback
signature that merely accepts the payload remains storable.

The two other shapes JavaScript strings
and arrays take at run time are built the same way: a concatenation or
template literal fills one buffer (`bbl::js::concat`, numbers spelled
straight into it), and an array literal that then grows starts at a small
fixed capacity rather than paying an allocation per push.

## Animation and deformation

Property animation and glTF animation share deterministic scene-level seeking
but have separate generated runtimes:

- property clips/groups bind a dotted path against a mesh or a camera: one
  of the record lanes this port holds (`position`, `scaling`,
  `rotationQuaternion`, an ArcRotate camera's `alpha`), or one component of
  a lane wide enough to have components
- glTF loading evaluates node hierarchies, animation channels, skins, inverse
  bind matrices, and morph weights from materialized asset metadata
- `EXT_mesh_gpu_instancing` keeps extension T/R/S matrices local and composes
  the node world matrix in the generated vertex stage
- morph deltas are applied before skinning
- authored normals/tangents deform in the vertex shader
- primitives without source normals are deindexed, and their face normals are
  recomputed after deformation while positions stay GPU-skinned — the one
  deformation quantity a shader cannot produce from a per-vertex input, since
  a face normal is a property of the triangle

Asset specialization enables the deformation vertex variant when a
materialized glTF contains animation; direct `createMorphTargets` reachability
enables the same variant for generated meshes. Other static scenes retain the
compact 96-byte/8-attribute vertex layout and one vertex uniform block. Reached
deformation scenes use the 200-byte/16-attribute layout and a second vertex
uniform block containing up to 64 matrices and two morph targets; when the
scene also composes pinned PBR variants the layout appends an integer
joint-index lane for the pin's own skinned stage (216 bytes) beside the
transcribed float pair. Assets with morph targets enable Babylon Lite's
uncapped storage-buffer morph path — the pin's one morph mechanism, which
the composed variants read: a flat 6-float delta buffer and a
16-byte-header weights buffer bound as vertex storage, evaluated with the
pinned accumulation loop before skinning; the two-slot vertex-attribute
morph lanes remain for direct generated-mesh morph attachment.

How large a skin can be follows the transport that carries its palette. A
scene composing the pin's own skeleton variants reads the palette from the
pin's per-bone `rgba32float` texture, which is sized from the bone count and
caps nothing; the 64-matrix uniform array is the transcribed vertex stage's
transport, so a scene without a composed skeleton variant is bounded by it.
Deformation runs on the GPU or not at all: a larger skin there is refused at
generation, naming the joint count and the transport, and the generated
loader keeps the same check as the `BBLITE_ASSET_DIR` defense. Upstream has
no CPU skinning path to mirror, so one composed only for this case would be
measured by nothing.

Two generated lists decide what a scene compiles: `BBLITE_RUNTIME_FEATURES`
in `features.cmake` from the scene's own TypeScript, and
`render_capabilities.hpp` from the materialized assets. Which list answers
which question — including the two deliberate asset-joined light and IBL
exceptions — is in
[features](features.md#feature-and-capability-selection).

Generated `render_capabilities.hpp`, shader reflection, and native layout
declarations must stay synchronized. Declaring fewer SDL vertex attributes
than a shader's input count fails D3D12 pipeline creation; GridMaterial also
reserves location 7 for its local normal, so deformation inputs occupy
locations 8-15.

## Renderer

Two peer GPU backends render the same generated plans; SDL_GPU is the
runtime default and `BBLITE_GPU_BACKEND=dawn` selects the Dawn
(WebGPU) backend, which renders through the browser reference's own
compiler and rasterization stack (see [backends](backends.md) for the
architecture and comparison). The SDL_GPU offline shader targets:

| Platform | Backend | Artifact |
| --- | --- | --- |
| Windows | Direct3D 12 | Tint HLSL → DXC DXIL |
| Linux / Android | Vulkan | Tint HLSL → DXC SPIR-V (temporary) |
| macOS / iOS | Metal | Tint MSL |

`scene -- process` defaults to the current host's row and accepts
`--shader d3d12|vulkan|metal|all`; `all` is an explicit portability sweep,
not the development default.

The Dawn backend needs none of these — it compiles the same WGSL
in-process ([features](features.md#stage-2-compiling-wgsl-for-the-device)).

Important contracts:

- base-color/emissive textures are sRGB; normal/ORM textures are linear,
  including a scene-code `loadTexture2D` attached to PBR's ORM slot with its
  sampler and upload flip preserved
- `.env` RGBD cubemap faces upload Y-flipped — pinned behavior, not an SDL
  adaptation ([backends](backends.md#ported-pinned-contracts))
- compiled HDR cubemaps are linear RGBA16F with mip-major, face-major layout
- DDS skyboxes are RGBA16F with face-major, mip-minor layout
- alpha mode, cutoff, blending, culling, and coverage are material-driven
- requested environment grounds render by default and keep Babylon Lite's
  world-origin fade center ([fidelity](fidelity.md#shader-contract))
- PBR material-extension texture pairs append after the base and
  transmission bindings per the generated `material_texture_slots.hpp`
  table, selected only by the `render_capabilities.hpp` defines for the
  reached glTF extensions; extension uniform data lives in each composed
  variant's own material block, written by the pin's lowered UBO writers
- PAL executes generated draw-command indices and pipeline keys rather than
  rescanning every mesh once per pipeline
- frame-graph viewport copies keep the pinned double-precision
  floor-and-scissor viewport contract ([fidelity](fidelity.md#attribution))
- transmission preserves the multisample color and depth attachments around
  the scene-color grab ([fidelity](fidelity.md#shader-contract) carries the
  pass shape)
- screenshot capture uses a readable target, then blits to the swapchain
- capture is deferred one frame when scene topology changes so D3D12 upload
  and readback commands do not share an invalid command list; the frame loop
  extends past `BBLITE_MAX_FRAMES` by a bounded grace period until every
  requested capture lands, so deferral cannot silently skip a screenshot,
  and for as long as the program's own start-up continuations are still
  draining (capped), plus the same grace counted from the frame they resolve
  on, since the capture check precedes the frame's drain — so a scene that
  awaits several frame boundaries before its state is final is captured
  after them, as the browser harness's ready marker captures it; the parity
  runner deletes the previous screenshot
  before a run, so a capture that never lands is a missing file, never a
  stale measurement
- native builds place reached assets and snapshotted shaders beside the
  executable to avoid absolute paths and cross-scene drift

**bblitec requires a GPU.** There is no software renderer to degrade into: a
backend that cannot bring a device up throws, and `run_engine` propagates it
rather than routing around it. A build with no compiled backend that can draw
the scene says so by name.

## Repository invariants

- Curated Babylon Lite scene sources are byte-identical, hash-checked evidence
  under `corpus/babylon-lite/`; never edit, flatten, normalize, or replace
  them. Committed references are likewise evidence, not tuning knobs.
- MAD is diagnostic. A lower score does not justify scene-name, geometry,
  position, or reference-image heuristics.
- glTF material behavior is metadata-driven (`OPAQUE`, `MASK`, `BLEND`,
  cutoff, double-sided state).
- Every generated behavior retains upstream provenance; every intentional
  semantic adaptation belongs in generated `fidelity.json`.
- An upstream package/commit update is a separate reviewed migration:
  regenerate all outputs, review changed formulas/constants, rebuild, and run
  the complete parity/diagnostic matrix.

## Backend rationale

The project keeps two complete GPU backends on purpose: two stacks
that must agree pixel-for-pixel are a differential diagnostic that
separates CPU-side causes from GPU-side ones immediately.
[Backends](backends.md) carries the rationale, the full comparison,
build recipes, and the ported pinned contracts.

All native GPU shaders originate as WGSL and compile through Tint, with
bblitec owning composition, SDL specialization, reflection checks, and
fixed-function state. The SDL_GPU offline paths — including why DXC stays
mandatory and why Vulkan temporarily recompiles Tint HLSL through it — are
tabulated in
[features](features.md#stage-2-compiling-wgsl-for-the-device). Remaining work
is tracked only in [TODO](../TODO.md).
