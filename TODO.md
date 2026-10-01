# Unfinished work

Internal work, qualification, performance and refusal defects. Capability gaps are the Limits in
[features](docs/features.md) and [UI](docs/ui.md); [audit](audit.md) tracks audit findings;
[status](docs/status.md) owns measurements.

## Qualification

- [ ] Move mixed mesh/billboard ordering into a generated draw plan after retaining source deferred-build completion order and prior stable binding order; keep equal-order/depth and camera-less refusals until those inputs and ordering-neutrality coverage exist.
- [ ] Give remaining sliced PAL code standalone concern headers that harness fixtures include.
- [ ] Android: resolve same-device emulator visual gaps and qualify the full registry on a physical device.
- [ ] iOS: qualify device bundles on hardware.
- [ ] Linux/Vulkan: every registered scene within its thresholds against same-host browser references.
- [ ] macOS/Metal: every registered scene within its thresholds against same-host browser references, fonts included, on an Apple Silicon host.

## UI text

- [ ] Render UI text at its fractional CSS size on every platform. Text is the largest remaining UI residual. RmlUi's `ElementStyle` passes `(int)font_size` to `GetFontFaceHandle`, so 11.52 px renders at 11 px. A Windows-only DirectWrite prototype matching Skia's `SkScalerContext_DW` measured Tetris 1.143 → 0.255, Antigravity 2.393 → 1.130, Voxel Sandbox 1.090 → 0.381, Racer 0.466 → 0.204 and Screen-Space Effects 0.361 → 0.149. That prototype used fractional sizes rounded to 1/64 px, gasp and bitmap-strike rules, and effects drawn from its own glyph masks. It was withdrawn from PR #288 (commits f240c859, 12d09bac):
    - it was platform-asymmetric;
    - it created one face per (handle, 1/64 px) with no eviction, so an animated font-size grew memory without bound.

    Also found: one glyph missing from the face (🛠 in Antigravity) sends its whole run to the FreeType fallback engine, where Chromium (`font_fallback_win.cc`) falls back per character. Needed:
    - fractional sizes through the shared font engine on all platforms;
    - a bounded face cache;
    - per-character fallback;
    - measurement against same-host browser references.

## Dependencies

- [ ] Drop `sdl-multisample-read.patch` at the release its `retire` field in `native/patches/manifest.json` names, and `png-grey-ramp-last-index.patch` once an SDL_image release builds the ramp over the last index; the manifest records each patch's upstream state.
