# Unfinished work

Internal work, qualification, performance and refusal defects. Capability gaps are the Limits in
[features](docs/features.md) and [UI](docs/ui.md);
[status](docs/status.md) owns measurements.

## Qualification

- [ ] Extend sanitizer coverage beyond allocator/ownership fixtures to native fixture families and representative scenes, including GPU/library lifetimes.
- [ ] Rebuild dependency artifacts with unknown pin/patch provenance through their maintained builders; `native/patch-identity.cmake` warns when an artifact has no identity record.
- [ ] Move mixed mesh/billboard ordering into a generated draw plan after retaining source deferred-build completion order and prior stable binding order; keep equal-order/depth and camera-less refusals until those inputs and ordering-neutrality coverage exist.
- [ ] Give remaining sliced PAL code standalone concern headers that harness fixtures include.
- [ ] Android: resolve same-device emulator visual gaps and qualify the full registry on a physical device.
- [ ] iOS: qualify device bundles on hardware.
- [ ] Linux/Vulkan: every registered scene within its thresholds against same-host browser references.
- [ ] macOS/Metal: every registered scene within its thresholds against same-host browser references, fonts included, on an Apple Silicon host.
