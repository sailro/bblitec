# Unfinished work

Internal work, qualification, performance and refusal defects. Capability gaps are the Limits in
[features](docs/features.md) and [UI](docs/ui.md); [audit](audit.md) tracks audit findings;
[status](docs/status.md) owns measurements.

## Compiler

- [ ] Give opaque engine values and borrowed aliases native capture types, so the remaining shared closure templates move to their owning source units (`closure-captures.ts`, `compiler/source-units.ts:115`).
- [ ] Canvas sizes folded at generation fix render-target sizes and particle initialization to `--width`/`--height` (`staticCanvasSize`, `compiler.ts:13688`; `option-helpers.ts:361`); read the running canvas or refuse where it can differ.
- [ ] Resolve a dictionary's map owner once for reads and writes (`equalityComparison`, `data-lowering.ts:9333`; `dictionaryEntryTarget`, `:7355`).
- [ ] One mapper path for `Array.from` iterable and `{ length }` sources (`compileArrayFromMapped`, `data-lowering.ts:4093`; `compileArrayFrom`, `:4202`).
- [ ] Lower `devicePixelRatio` in one place (`browser-erasure.ts:571`, `:618-626`, `:977-982`; `expressions.ts:600`; `canvas.ts:98`, `:109`) and fold a nested browser-operand chain once per node.
- [ ] Parse a runtime deployment query bag once per realm instead of once per emitting function (`deploymentSearchParamsValue`, `search-params.ts:32`).
- [ ] Refuse two packaged sources that map to one output name (`hash`, `compiler/assets.ts:526`; output name `:327`).

## UI

- [ ] Match live style rules through RmlUi instead of `UiSelectorMatcher` (`ui_selector_match.hpp:11`; `pal_ui_rml.cpp:288`, `:3836`, `:4055`), keeping authored-tree queries, generated nodes and input state; measure `Element::Matches` reparsing before caching it.
- [ ] Replace the private `--bbl-crosshair` bridge and its fixed 22 px bar markup (`ui-projection.ts:2135`; `pal_ui_rml.cpp:2351`, `:4135`) with general layered-background projection.

## Platform and runtime

- [ ] Adopt SDL's main-callback loop for interactive builds so the Win32 move/resize modal loop no longer stalls iteration (`pal_platform_events.hpp:724`).
- [ ] One file-type descriptor table for `<input accept>` validation and native dialog filters (`browser-file.ts:36`, `js_file.hpp`, `js_voxel_file.hpp:25-27`).
- [ ] Shared bounded I/O returning absent/error/value (`pal_storage.cpp`, `pal_file_io.hpp`, `pal_ui_form.hpp`, `pal.cpp`).
- [ ] Parse ordered `JsonValue` directly, without intermediate JSON conversion (`js_json.hpp`).
- [ ] Reclaim retired shadow-generator records and map targets without compacting handles (`rebuild_scene_renderables`, `scene-lowerer.ts:2611-2658`).

## Qualification

- [ ] Android: full registry through `android:sweep` on an emulator and a physical device; fix the emulator rendering corruption of `offscreen`.
- [ ] iOS: qualify device bundles on hardware; extend lifecycle/interaction smoke coverage (`tools/ios-smoke.mjs`).
- [ ] Linux/Vulkan: every registered scene within its thresholds against same-host browser references, including scene75 and scene187.
- [ ] macOS/Metal: every registered scene within its thresholds against same-host browser references, fonts included, on an Apple Silicon host.

## Performance

- [ ] `minecraft`: worst frame of a chunk-crossing sprint replay at most 16.7 ms (`BBLITE_FPS_PROFILE` maximum interval), with meshing, lighting, water settling and allocation attributed separately (`BBLITE_CPU_PROFILE`).
- [ ] `scene290`: at least 100 FPS uncapped through impact and settling (`BBLITE_BENCHMARK_FRAMES=0`, `BBLITE_FPS_PROFILE`); Bullet stepping is the bottleneck (`pal_physics_bullet.cpp`).

## Dependencies

- [ ] Drop `sdl-multisample-read.patch` at the first SDL release after 3.4.16 (libsdl-org/SDL#15838 merged), and `png-grey-ramp-last-index.patch` once an SDL_image release builds the ramp over the last index; `d3d12-multisample-lines.patch` needs a new upstream proposal (libsdl-org/SDL#16183 closed unmerged). `native/patches/manifest.json` records each patch's upstream state.
