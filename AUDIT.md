# bblitec audit tracker

Findings of the 2026-08-18 six-axis audit (feature activation, re-derivation,
transpiler structure, native/PAL, documentation, tooling), taken at `main`
d6c360f. Every entry was verified against the code with file:line evidence;
the four highest-stakes correctness claims were independently re-verified.

Rules of this file, mirroring `TODO.md`:

- Only unfinished findings belong here. **Delete an entry when its fix lands**;
  closing an entry must lower the count.
- Entries state the defect and the facts needed to act — not what was tried.
- The **Verified clean** section at the bottom is the exception: it persists,
  so future audits do not re-litigate what was already proven sound.
- Fix priority: work the sections in the order listed under
  [Suggested order](#suggested-order).

## Defects — wrong today

All fourteen defects are closed and validated; the section persists only so
its absence is legible.

## Feature activation


## Re-derivation (port, do not re-derive)

- [ ] **RD tail — one deletion batch.** The 20 never-read option keys
  the lane prune orphaned (renderer-lowerer options + the upstream-lower
  call sites :539-591/:594-632) ride the next upstream-lower touch; the
  emitted-but-uncalled `quantized_unorm_factor` in every generated
  loader can trim with them. (The formulas are lowered; both ordering
  divergences are ADOPTED from the pin, sweep-judged green, scene39
  improved — the revert seams are commits 3e2adb2's marked hunks.)


Quantified backlog: ~10,700 lines of hand-written C++ template text encoding
upstream semantics (gltf-loader 4,567; renderer ~1,900; in-lowerer ~3,460)
plus ~945 live transcribed WGSL lines, against ~1,100 lines of genuine
mechanisms (`pinned-ubo-writer-lowerer`, `light-lowerer#lowerMatrix`, the
sprite template evaluator) that are the templates to reuse. Two legitimate
shapes only: LOWER (walk the pinned AST) or EXECUTE (run the pin and bake).


## Transpiler structure


## Native

- [ ] **NA redesign-class remainders (reported, not forced).** The
  mesh-sync frame loops differ structurally (SDL walks the plan once
  and skips CPU rebakes for GPU-deformed meshes; Dawn walks per draw
  and rewrites unconditionally — same outcomes, different shapes;
  unifying is a frame-loop redesign). The CPU benchmark:
  `pal_sdl.cpp:1075` `print_benchmark` disagrees with shared
  `report_benchmark` in stats, line shape and warmup policy — unify
  deliberately, deciding which contract wins. (The
  capture's `pinned_mesh_block` world choice is now documented at the
  dump site — done.)


## Documentation

## Tooling


## Verified clean — do not re-audit

- **PAL isolation, both directions** (CMake TU selection, include graph
  grep-verified backend-type-free shared headers, stub contract,
  `run_engine` dispatch, sprite TUs, CPU-fallback-off): deleting a backend is
  dropping its files. Removing SDL_GPU keeps SDL3 as the platform layer —
  intended. One asymmetry: SDL TUs subtracted from the generated list, Dawn
  TUs added natively.
- **The PBR pinned pipeline end-to-end**: composer executed under Node,
  extensions in the pin's registration order, stages emitted verbatim and
  byte-gated against instrumented browser captures, UBO layouts cross-checked
  against the composer's own `_offsets`, `assertArmsCovered` +
  unwritten-field gates live. Solid skybox, HDR GGX prefilter, sprite path
  (template evaluated, atlas executed), Draco/meshopt (pin's own wasm),
  `lowerMatrix`, and the pin-derived constants that genuinely flow.
- **Pin-access discipline**: one executor (`importPinnedModule`, 24 call
  sites), one glTF→material mapper, one writer-lowerer; all 14 lowerers on
  `LoweringContext` (enforced by `compiler-architecture.test.ts`).
- **Tooling core**: one registry resolver, one browser harness
  (non-perturbation proven byte-for-byte), one PNG/MAD library, build
  identity enforced at every capture (the gap is only reuse, D9),
  differential env save/restore correct, dist-lock interlock coherent, no
  orphaned npm scripts.
- **Docs in the small**: every cited path/symbol/command exists; counts
  consistent (66+6 scenes, 72 previews, TODO corpus arithmetic); pinned pair
  stated exactly where policy says; zero documented-but-unread env vars.
- **Feature predicates matching upstream exactly**: transmission end-to-end
  (incl. the zero-factor-plus-texture agreement), specular/reflectance incl.
  factor-1-clears-IOR, clearcoat/sheen/iridescence/anisotropy option objects
  term-for-term, texture-transform stamps, skybox arms, `.babylon` light
  lists, morph-storage any-target rule, the feature→source cross-check, and
  the registry-parsed extension→module map.

## Suggested order

1. ~~Defects~~ — all fourteen closed 2026-08-18. (Validated: tests +
   corpus-neutral
   generated tree + 70-scene neutrality + packaged-run check. D3's shape as
   landed: pin-implemented extensions, sparse accessors, and the un-lowered
   ORM forms refuse at generation in `specializeGltf`; vertex attributes are
   deliberately not allowlisted — an attribute the pin also ignores renders
   identically on both sides — and the one pair the pin reads that this port
   truncates, `JOINTS_1`/`WEIGHTS_1`, records the `four-influence-skinning`
   fidelity adaptation instead of refusing, because Scene 7's ChibiRex
   carries it inside its gates; that truncation is now also the leading
   suspect for Scene 7's open TODO residual. D4's shape as landed: the
   `staticModules` skeleton record carries upstream's JOINTS_0 conjunct,
   `animatedWorldBounds` is its own emit option keyed on asset animations,
   and `gpuDeformation` deliberately keeps animation presence with the
   palette-as-world rationale written beside it — upstream recomputes node
   worlds live; this port bakes them, so any animated mesh needs the
   deformation transport.)
2. ~~FA-1 + DOC-A/B/C~~ — done 2026-08-18: the per-sample-transmission story
   rewritten across its six pages, the pinned-variant-era boundaries retired,
   the smaller corrections landed; only the DOC-C remainder above and DOC-D/E
   stay open.
3. ~~RD-4/6/7, RD-8/9/10, RD-1 generation half, RD-2/RD-11 round 1~~ done
   2026-08-18 (the pin executes for HDR/DDS/BRDF and the lifted
   background/grid/utility WGSL — scenes 8, 265 and 14 all moved TOWARD
   the golden; the Standard family composes from the pin behind the off
   emit option; the loader animation/sampler leaves and the four anchored
   lowerers flow from the pinned AST). Next: **RD-1 PAL wiring + flip**
   (the flagship's second half), RD-2/RD-3/RD-11 remaining rounds, RD-5,
   RD-12.
4. ~~NA-1, the NA small-table batch, TS-2/3/4, monolith round 1~~ done
   2026-08-18: the texture-slot table is generated (five copies → one, −229
   native lines), the shared native tables landed bit-identically, and
   `compiler.ts` dropped 846 lines along the proven seam. Wave D added
   TS-1/TS-8/9 (one browser harness, shared artifact paths) and monolith
   round 2 (compiler.ts to 2,906). Remaining: the NA remainders, the
   cli.ts extractions.
5. ~~TL-1..12, D10~~ done 2026-08-18 (one strict parser, one backend story,
   one artifact token, everything suffixed, provenance-stamped reports).
   The wave-C batch added (a) pinned blocks and (b) shader-arm attribution
   to `scene -- diff` plus (e) `scene -- measure`, and the
   feature-activation inventory ships per scene. Remaining: the TL-gaps
   rungs (c)-(d) and (f)-(j).

Full prose report with verdicts and method:
<https://claude.ai/code/artifact/eff041d1-9935-40b5-b726-8ccb4f034186>
