# Repository instructions

Read [README](../README.md#documentation) and its canonical pages before feature
work. Use its ownership table: facts live in one page, support in Features,
adaptations in Fidelity, unfinished work in TODO. Keep docs concise; no
checkpoint logs, completed-work lists or duplicated test narratives.

## Source and implementation

- Read the reached upstream source and architecture at the pin in
  `upstream/babylon-lite.json`. Source takes precedence over prose.
- The target is Babylon Lite, not legacy Babylon.js.
- Reuse pinned functions/composers and shared AST/typed lowering. Generate
  Babylon behavior; keep platform/library adaptation in PAL.
- Derive activation from API reach and actual loader predicates. Avoid
  scene-name/source-text detection and fallback transcriptions.
- Preserve source/Tint pins unless an upgrade is requested.
- Preserve corpus inputs, references and thresholds as evidence. Deliberate
  adoption/recapture must retain source provenance.
- Fix source, never generated output. Use typed records/unions/narrowing;
  explicit TypeScript any, broad casts and silent fallbacks are forbidden.
- Preserve C++20 warning-clean output, provenance and feature isolation.
  GPU initialization failure is an error.
- Unsupported source/ownership combinations must refuse explicitly.

## Work and validation

State exact scene IDs in a checkpoint; distinguish assessed, implemented and
integrated work. Follow [development](../docs/development.md#validation) for
focused checks, simplify records and final validation. Use
[debugging](../docs/debugging.md) for unexplained differences. An integrated
scene needs current measurements and interaction checks on both backends.

Finish generation before native builds and never rebuild dist during its runs.
Coordinate shared dependency installation as described in development. Check
command exit codes without hiding failures in pipelines. There is no hosted CI.

Apply the user's task scope and validation instructions; do not launch a new
repository audit as a substitute for requested implementation.
