# Unfinished work

Internal work, qualification, performance and refusal defects. Capability gaps are the Limits in
[features](docs/features.md) and [UI](docs/ui.md); [audit](audit.md) tracks audit findings;
[status](docs/status.md) owns measurements.

## Compiler

- [ ] Canvas sizes folded at generation fix render-target sizes and particle initialization to `--width`/`--height` (`staticCanvasSize` in `compiler.ts`; `option-helpers.ts`); read the running canvas or refuse where it can differ.
- [ ] Resolve a dictionary's map owner once for reads and writes (`equalityComparison` and `dictionaryEntryTarget` in `data-lowering.ts`).
- [ ] One mapper path for `Array.from` iterable and `{ length }` sources (`compileArrayFromMapped` and `compileArrayFrom` in `data-lowering.ts`).
- [ ] Lower `devicePixelRatio` in one place (`browser-erasure.ts`, `expressions.ts`, `canvas.ts`) and fold a nested browser-operand chain once per node.
- [ ] Parse a runtime deployment query bag once per realm instead of once per emitting function (`deploymentSearchParamsValue` in `search-params.ts`).
- [ ] Refuse two packaged sources that map to one output name (`hash` and the output name in `compiler/assets.ts`).

## UI

- [ ] Match live style rules through RmlUi instead of `UiSelectorMatcher` (`ui_selector_match.hpp`; `pal_ui_rml.cpp`), keeping authored-tree queries, generated nodes and input state; measure `Element::Matches` reparsing before caching it.
- [ ] Replace the private `--bbl-crosshair` bridge and its fixed 22 px bar markup (`ui-projection.ts`; `pal_ui_rml.cpp`) with general layered-background projection.

## Platform and runtime

- [ ] Adopt SDL's main-callback loop for interactive builds so the Win32 move/resize modal loop no longer stalls iteration (`pal_platform_events.hpp`).
- [ ] One file-type descriptor table for `<input accept>` validation and native dialog filters (`browser-file.ts`, `js_file.hpp`, `js_voxel_file.hpp`).
- [ ] Shared bounded I/O returning absent/error/value (`pal_storage.cpp`, `pal_file_io.hpp`, `pal_ui_form.hpp`, `pal.cpp`).
- [ ] Parse ordered `JsonValue` directly, without intermediate JSON conversion (`js_json.hpp`).
- [ ] Reclaim retired shadow-generator records and map targets without compacting handles (`rebuild_scene_renderables` in `scene-lowerer.ts`).

## Qualification

- [ ] Android: full registry through `android:sweep` on an emulator and a physical device; fix the emulator rendering corruption of `offscreen`.
- [ ] iOS: qualify device bundles on hardware; extend lifecycle/interaction smoke coverage (`tools/ios-smoke.mjs`).
- [ ] Linux/Vulkan: every registered scene within its thresholds against same-host browser references, including scene75 and scene187.
- [ ] macOS/Metal: every registered scene within its thresholds against same-host browser references, fonts included, on an Apple Silicon host.

## Performance

- [ ] Bring the split backend's cold compile CPU back to the monolith's: the two scene PCHs cost 3.0–4.4 s each and each family unit ~0.1 s fixed, 9–11.5 s per scene above the pre-split monolith (`native/CMakeLists.txt`, `native/native-header-cache.cmake`).
- [ ] `minecraft`: worst frame of a chunk-crossing sprint replay at most 16.7 ms (`BBLITE_FPS_PROFILE` maximum interval), with meshing, lighting, water settling and allocation attributed separately (`BBLITE_CPU_PROFILE`).
- [ ] `scene290`: at least 100 FPS uncapped through impact and settling (`BBLITE_BENCHMARK_FRAMES=0`, `BBLITE_FPS_PROFILE`); Bullet stepping is the bottleneck (`pal_physics_bullet.cpp`).

## Dependencies

- [ ] Drop `sdl-multisample-read.patch` at the first SDL release after 3.4.16 (libsdl-org/SDL#15838 merged), and `png-grey-ramp-last-index.patch` once an SDL_image release builds the ramp over the last index; `d3d12-multisample-lines.patch` needs a new upstream proposal (libsdl-org/SDL#16183 closed unmerged). `native/patches/manifest.json` records each patch's upstream state.
