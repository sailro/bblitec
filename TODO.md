# Unfinished work

Compiler, source-ownership and build remediation: [audit](audit.md#remediation).

## Qualification

- [ ] Extend [allocator/GC sanitizer coverage](docs/debugging.md#memory) to representative generated scenes and GPU/library lifetimes; run whole-process leak detection on a supported host.
- [ ] Rebuild stale Windows shipping dependencies (trimmed SDL, static RmlUi and LabSound) through their maintained builders before measuring package size. The desktop development artifacts have current identity records.
- [ ] Move mixed mesh/billboard ordering into a generated draw plan after retaining source deferred-build completion order and prior stable binding order; keep equal-order/depth and camera-less refusals until those inputs and ordering-neutrality coverage exist.
- [ ] Give remaining sliced PAL code standalone concern headers that harness fixtures include.
- [ ] Qualify `playroom` ragdoll fidelity and physics performance; current measured limits are in [status](docs/status.md#upstream-application-gates).
- [ ] Android: resolve same-device emulator visual gaps and qualify the full registry on a physical device.
- [ ] iOS: qualify device bundles on hardware.
- [ ] Linux/Vulkan: every registered scene within its thresholds against same-host browser references.
- [ ] macOS/Metal: every registered scene within its thresholds against same-host browser references, fonts included, on an Apple Silicon host.
