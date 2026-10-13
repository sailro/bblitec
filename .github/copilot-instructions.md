# Repository instructions

Read the [documentation](../README.md#documentation) before feature work; its table names the page that owns each
topic. In status, read only the rows you touch.

## Documentation

Persistent user requirement:

- Facts and actions only: current state, commands, rules, file locations. Keep it short.
- No history, session logs, chronology, progress or rationale narratives, and no handoff documents. Keep evidence in
  ignored `artifacts/`.
- One owner per fact. Replace stale text; never restate a fact in another page.

## Source and implementation

- Read the reached upstream source at the pin in `upstream/babylon-lite.json`; source beats prose.
- The target is Babylon Lite, not legacy Babylon.js.
- Reuse pinned functions/composers and shared AST/typed lowering. Generate Babylon behavior; keep platform/library
  adaptation in PAL.
- Derive activation from API reach and loader predicates; never from scene names, source text or fallback transcriptions.
- Keep source/Tint pins unless an upgrade is requested.
- Corpus inputs, references and thresholds are evidence; adoption/recapture keeps source provenance.
- Fix source, never generated output. No explicit `any`, broad casts or silent fallbacks.
- Keep C++20 output warning-clean, with provenance and feature isolation.
- Unsupported source/ownership combinations refuse explicitly.

## Work and validation

- Report exact scene IDs and measured state.
- Validate per [development](../docs/development.md#validation); diagnose with [debugging](../docs/debugging.md).
- Check exit codes; never hide failures in pipelines. There is no hosted CI.
- Stay within the user's task and validation instructions; do not substitute a repository audit.
