# Unfinished work

Compiler, source-ownership and build remediation: [audit](audit.md#remediation).

## Qualification

- [ ] Add a reproducible sanitizer command for native allocator/ownership fixtures, then extend it to representative scenes and GPU/library lifetimes.
- [ ] Rebuild dependency artifacts with unknown pin/patch provenance through their maintained builders; `native/patch-identity.cmake` warns when an artifact has no identity record.
- [ ] Move mixed mesh/billboard ordering into a generated draw plan after retaining source deferred-build completion order and prior stable binding order; keep equal-order/depth and camera-less refusals until those inputs and ordering-neutrality coverage exist.
- [ ] Give remaining sliced PAL code standalone concern headers that harness fixtures include.
- [ ] Qualify `playroom` ragdoll fidelity and physics performance; current measured limits are in [status](docs/status.md#upstream-application-gates).
- [ ] Android: resolve same-device emulator visual gaps and qualify the full registry on a physical device.
- [ ] iOS: qualify device bundles on hardware.
- [ ] Linux/Vulkan: every registered scene within its thresholds against same-host browser references.
- [ ] macOS/Metal: every registered scene within its thresholds against same-host browser references, fonts included, on an Apple Silicon host.

## Compiler simplification

- [ ] One argument-to-parameter walk, on `parameter-effects.ts`, for shader view definitions (`definitionOnlyReference`), side-table escapes (`nonEscapingRead`) and traces (`trace`). They resolve callees and map spread, rest and `this` parameters differently today; unifying them changes which programs compile.
- [ ] `onlyReads` (`record-observations.ts`) classifies a use through `valueConsumer`. The two differ for `++x` and tagged templates.
- [ ] Static values read through the shared evaluator: `foldedArraySearch` lanes (`jsonScalarLiteral`, `staticArrayLiteral`), pick `ruleLiteral` (`resolveStaticLiteral` with a read-only initializer hook), and the render-target stand-in size (`PinnedNumericLowerer` with a canvas-size leaf hook). Each changes generated C++ or refusal messages.
- [ ] `presentHandleTemplate` (`expressions.ts`) compiles a handle conditional's arms once, taking their values from the sink compile instead of a probe.
