# AUDIT — 2026-08-24

Findings of the six-axis audit at main `e065f59`, covering the 113 commits since
the 2026-08-19 audit closed (PR #83). Same rules as [TODO](TODO.md): entries are
unfinished work, stated with the facts needed to act; **fixing an entry deletes
it**.

Three fix waves landed the same day and their entries are deleted: the
quick-win wave (docs facts and dev-log, the drift guards, the tooling dedups,
the lock fixes, lazy packager imports, the min-SDL patch fix), wave 1 (the
pin-anchored material-defaults table, located refusals, the full activation
inventory, the monolith splits, the Tint and bake caches, the tsc skip,
`diagnose`/`clean`, capture provenance, the registry pose derivation, the
docs duplication debt, the BU-1/BU-13 proof builds), and wave 2 (the
light-matrix double migration and walker consolidation, the splat/effect/
tone-map emit-once constants, the pipeline-traits/billboard-plan/MRT/blend
shares, the per-frame scene+lights hoist, the backend symmetry batch
NA-15..21, the runtime.hpp initializer trim, the build-stamp TU). Each wave
was proven by the full suite plus its matching proof — generated-tree digest,
warm-cache byte-stability, or the complete measured matrix
(`process all` + `parity all --differential` + `neutrality` + `status:verify`;
wave 2's only movers were two deterministic sub-threshold improvements toward
the golden — the runtime-sweep gate landed byte-exact on both backends, the
signature of the light-matrix precision fix).

## Verified sound at this baseline — do not re-audit

- **PAL isolation, re-proven over every post-08-19 surface**; semantic
  content ≥95% single-sourced (higher after wave 2's shares).
- **Activation triggers mirror the pin everywhere**; the activation inventory
  now covers every mechanism, test-enforced.
- **No new formula transcriptions**; the pinned-body translators are
  consolidated (two walkers stay by design: the glTF pair for its
  precedence-minimal emission, the UBO-writer lowerer for its data-lane
  domain).
- **Tooling core is coherent**; dead code ~zero; docs' mechanical facts
  verify; patch hygiene and concurrency docs match the code.

## Remaining

- [ ] **TL-1 / NA-8 — The native render capture cannot see the newest
  renderable families, so `diff` (rung 3) is blind for ~20 shipped scenes.**
  `pal_render_capture.hpp` writes the mesh render plan plus a dedicated splat
  writer and nothing else; `runtime.hpp` holds sprite layers, billboard
  systems, sprite renderers, effect wrappers/renderers as first-class
  renderables. A sprite-only scene refuses `capture --native` outright
  (`src/capture-native.ts`), and a mixed scene (billboards over meshes, node
  particles, effect tasks) produces a capture whose draw census omits those
  draws — `diff` then reports browser-only draw shapes on a byte-exact scene,
  the false-finding class the tool exists to kill. Fix: one writer per family
  mirroring `write_splat_draw_list` (the uniform pairing in `render-diff.ts`
  is generic; splats needed no diff-side change), then drop the no-PBR-plan
  refusal. Effort M (each family S).
- [ ] **TL-6 — `geometry` never caught up to its siblings' conventions.** No
  `--gpu-debug`; ignores `nativeEnvironment` and honours neither `--exe` nor
  `BBLITE_NATIVE_EXE`; no registry-pose default (an animated scene would
  compare a settled browser pose against native frame 0); cached `-lite.png`
  references reused on bare existence with no seek sidecar. Latent because
  current geometry scenes are static. Effort M.
- [ ] **BU-14 — Lazy-load `pinned-material-input`'s top-level await in the
  CLI.** The scene-command and packager halves landed; `cli.ts` still
  eagerly runs the ~15 pinned-module imports (57–288 ms) for every scene.
  Gating it behind an exported `ensurePinnedLoaderExecution()` must preserve
  the pin's process-global registration timing (scene 12's empty-setter
  semantics make registration order observable), so it takes its own careful
  pass with a compose-level test. Effort S–M.
- [ ] **RD-7 — The scene-code subsurface thickness ground state may diverge
  from the pin.** `compilePbrMaterialOptions` seeds `thickness = 0` while the
  pinned `writeRefractionUBO` reads `thick?.max ?? 1` — a scene-code material
  with `subsurface.refraction` present and no `thickness` object would write
  thicknessParams max 0 against the pin's 1, IF the composed variant carries
  the lane for that shape at all (the pinned `detect` decides). No reached
  scene hits it; the site carries a marking comment and is excluded from the
  defaults table. Measure the shape (an `examples/` probe against a browser
  recapture), then align or record. Effort S, needs a measurement.
- [ ] **NA-22 (remainder) — Generated positional aggregates and the two
  load-bearing initializer sets.** Wave 2 deleted the pin-mirror member
  initializers generation always overrides and the unused `= {}` defaults;
  two sets stayed with evidence: `BillboardSystemOptions` (the generated
  `node_particles.cpp` default-constructs and assigns only
  `capacity`+`blend`, so the other members' initializers are load-bearing)
  and the iridescence trio (the extension-absent ground state). The right
  finish is generated-side: emit full designated-initializer literals for
  those constructions (compiler-checked field pairing under `cxx_std_20`)
  and anchor the surviving ground-state initializers against
  `pinned-material-defaults.ts`. Effort S–M, matrix-validated.
- [ ] **TR-8 — Handle-collection semantics exist as ~12 exact-shape arms.**
  **Blocked on feature work by design**: when scene 158's collection
  contract lands (TRACKED in TODO), introduce one handle-collection value
  kind (iterate/index/find/push) in the entry compiler and retire the arms
  in expressions.ts/statements.ts/compiler.ts rather than adding a
  thirteenth. Effort L.
