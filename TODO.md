# Unfinished work

Internal work, qualification, performance and refusal defects. Capability gaps are the Limits in
[features](docs/features.md) and [UI](docs/ui.md); [audit](audit.md) tracks audit findings;
[status](docs/status.md) owns measurements.

## UI

- [ ] Match live style rules through RmlUi instead of `UiSelectorMatcher` (`ui_selector_match.hpp`; `pal_ui_rml.cpp`), keeping authored-tree queries, generated nodes and input state; measure `Element::Matches` reparsing before caching it.
- [ ] Replace the private `--bbl-crosshair` bridge and its fixed 22 px bar markup (`ui-projection.ts`; `pal_ui_rml.cpp`) with general layered-background projection.

## Platform and runtime

- [ ] One runtime model for pinned records and application values: `pinned_records.hpp` restates `js::typed_array_set`, `array_pop_or_absent` and `MapGetResult` over `std::optional`/`std::shared_ptr`.
- [ ] Include only the concern header a unit reads instead of the `pal_gpu_shared.hpp` umbrella chain.
- [ ] Compact SPIR-V vertex inputs at build time in `tools/tint-sdl` and delete the runtime registry (`pal_spirv_vertex.hpp`, `pal_sdl_gpu_resources.hpp`).
- [ ] Keep one engine rendering-context list whose entries carry their `_kind`, as the pin does (device recovery's per-registry counts).
- [ ] Serve every pinned GPU writer through one WebGPU-shaped device, not a text-only one (`text_gpu.hpp`).
- [ ] Adopt SDL's main-callback loop for interactive builds so the Win32 move/resize modal loop no longer stalls iteration (`pal_platform_events.hpp`).
- [ ] Reclaim retired shadow-generator records and map targets without compacting handles (`rebuild_scene_renderables` in `scene-lowerer.ts`).

## Qualification

- [ ] One captured-spawn variant beside `runChecked` for `package-demo.ts`, `package-output.ts`, `shipping-profile.ts` and `patch-inventory.ts`.
- [ ] Move the scene180 uniform plugin onto `webgpu-recorder.init.js` and share one `observedState` helper in `checks/plugins/support.mjs`.
- [ ] Read `test/native-fixture.ts` unit lists from the `pal_*_scene_all.cpp` includes and share one camera test fixture.
- [ ] Give sliced PAL code standalone concern headers that harness fixtures include (`pinned-velocity-history` and the other `cppFunction` slices).
- [ ] Prune `artifacts/native-cache` `headers/`, `sources/` and `pch/` by age in `clean`.
- [ ] Compile each backend family file on its own in native lint (`src/code-quality.ts`): they build only inside `pal_{sdl_gpu,dawn}_scene_all.cpp`, so a missing include is hidden by the files before it.
- [ ] Replace ts-prune in `lint:exports` with a checker-based scan: it misses exports reached through inferred types and `typeof import()`, and misnames `as const satisfies` exports.
- [ ] Android: full registry through `android:sweep` on an emulator and a physical device; fix the emulator rendering corruption of `offscreen`.
- [ ] iOS: qualify device bundles on hardware; extend lifecycle/interaction smoke coverage (`tools/ios-smoke.mjs`).
- [ ] Linux/Vulkan: every registered scene within its thresholds against same-host browser references, including scene75 and scene187.
- [ ] macOS/Metal: every registered scene within its thresholds against same-host browser references, fonts included, on an Apple Silicon host.

## Performance

- [ ] `minecraft`: worst frame of a chunk-crossing sprint replay at most 16.7 ms (`BBLITE_FPS_PROFILE` maximum interval), with meshing, lighting, water settling and allocation attributed separately (`BBLITE_CPU_PROFILE`).
- [ ] `scene290`: at least 100 FPS uncapped through impact and settling (`BBLITE_BENCHMARK_FRAMES=0`, `BBLITE_FPS_PROFILE`); Bullet stepping is the bottleneck (`pal_physics_bullet.cpp`).

## Dependencies

- [ ] Drop `sdl-multisample-read.patch` at the first SDL release after 3.4.16 (libsdl-org/SDL#15838 merged), and `png-grey-ramp-last-index.patch` once an SDL_image release builds the ramp over the last index; `d3d12-multisample-lines.patch` needs a new upstream proposal (libsdl-org/SDL#16183 closed unmerged). `native/patches/manifest.json` records each patch's upstream state.
