# Audit 2026-09-01

Whole-state audit at `294fd23` (eight axes: features, transpiler, native,
generated C++, documentation, tooling, building, applications, plus a global
backend-symmetry census). **An entry is deleted when fixed** — this file
tracks only what remains open. Every entry carries the evidence that proved
it and the shape of the fix. Full per-axis digests live in the audit session
scratchpad (`audit-reports/*.md`), not in the repository.

## Verified sound — do not re-audit

- **Feature activation, globally.** All ~120 `reachFeature` sites ride the
  pin's own factory calls; zero second detectors; the six shadow defines
  derive from one `shadowCapabilities` record; `feature-activation.ts`
  covers every family with concrete reasons.
- **No re-derivation beyond the two documented ones.** The whole-of-`src/`
  sweep found only the transcribed vertex stage (now pin-anchored on all
  three arms) and the camera-controls constants (now lowered from the pin);
  the 164-hit regex sweep found no unchecked surgery over pinned source or
  composed WGSL.
- **PAL isolation, both directions, including the new subsystems.** Deleting
  a backend is dropping its files; every shared header is backend-type-free;
  the UI IR seam (`pal_ui.hpp`) is plain data; audio/navigation/physics touch
  no GPU backend.
- **Corpus integrity.** All 530 manifest records hash-verified; all 399
  upstream-sourced files byte-identical to the upstream tree at the pin; all
  third-party origins version-pinned; no app-keyed branch anywhere in `src/`
  or `native/src`; all ten applications carry deterministic parity gates.
- **Tooling core.** The one-of-each unification (flag parser, backend
  tokens, PNG/MAD, report writer, browser harness, spawner, registry
  resolver, staleness discipline) held through all 252 commits.
- **Build partitioning, end-to-end.** UI/audio/navigation/physics/codecs are
  correctly feature-gated from scene reach through vcpkg manifest features;
  a visual-only scene links none of them; minimal builds and the packager
  refusals hold; both cache halves are content-addressed.
- **Generated-code memory model.** Timer drains, RAF queues, node-based
  `js::Map`/`Set`, zero raw `new` in generated code, no references held into
  growing engine vectors (the one Dawn PAL exception now copies),
  bounds-checked
  DataView/string access, full-aggregate record initialization.
- **Emission determinism.** Double regeneration is full-tree byte-identical.

## Open entries

None. Every finding of the 2026-09-01 audit was fixed on the audit branch
and validated (full test suite, corpus regeneration triaged file-by-file
against a `main` baseline, native builds of all 218 scenes on both
backends, the measured parity matrix, and a `/simplify` pass over the
complete body of work). What could not be closed inside the audit is filed
in `TODO.md` with what unblocks it, per that file's rules.
