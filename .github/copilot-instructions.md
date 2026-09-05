# Repository instructions

`bblitec` compiles a reachable, statically analyzable subset of pinned Babylon
Lite TypeScript into C++20. SDL3 provides platform services; SDL_GPU and Dawn
are independently validated GPU backends.

## Read before changing code

Read [README](../README.md), the canonical pages it lists, and
[TODO](../TODO.md) before feature work. Follow the active
[audit](../audit.md) when auditing. Previous reviews do not exempt any area
from rechecking.

The [documentation index](../README.md#documentation) assigns each page's scope.

Keep each fact in its owning page and link to it elsewhere. Documentation
states current behavior and actionable limitations; Git preserves history.

## Source and fidelity

- Before porting a feature, read its upstream architecture page and source at
  the commit in `upstream/babylon-lite.json`. Upstream docs live under
  `docs/lite/architecture/`; source takes precedence when the two disagree.
- The target and browser reference are Babylon Lite. An upstream comparison
  with legacy Babylon.js does not define this compiler's behavior.
- Reuse pinned functions, composers and AST lowering before writing behavior.
  Do not transcribe shader equations or introduce a fallback copy. Record
  unavoidable substitutions in generated `fidelity.json`.
- Babylon semantics belong in generated code; platform/library adaptation
  belongs in PAL. See architecture for existing exceptions and open work.
- Use the pinned loader's actual predicates and lazy feature registration.
  Asset metadata and API calls may reach the same feature through different
  upstream paths; do not invent source-text or scene-name detectors.
- Keep source and Tint pins unchanged unless an upstream migration is part of
  the task. A migration requires regeneration and compatibility validation.
- Corpus inputs, golden applications, thresholds and reference images are
  evidence. Do not edit them to make compilation or parity pass. Deliberate
  adoption or recapture must preserve source provenance and hashes.
- Fix source files, never generated output. `generated/` is disposable.

## Implementation

- Explicit TypeScript `any`, broad casts and success-shaped fallbacks are
  forbidden. Use typed records, unions and checked narrowing.
- Keep user-code lowering generic and symbol-based. Reuse compiler contexts,
  static evaluation and lowerer contracts before adding another recognizer.
- Preserve provenance, feature isolation and C++20 compatibility. Generated
  C++ must build warning-clean under the documented compiler settings.
- GPU initialization failure is an error; there is no software fallback.
- A scene is integrated only after both backends meet its gates and an
  interactive camera/input check succeeds.

## Workflow and validation

Diagnose rendering differences with captures. Start at
`npm run scene -- diff <id>` and follow the debugging page; statistics alone
do not establish a precision floor or a root cause.

Generation must finish before native builds. Do not build multiple CMake trees
against one vcpkg install concurrently. Use the current shell's quoting rules
and inspect command exit codes; output filtering must not hide failures.

Run `/simplify` over the complete change before the final validation sweep.
Apply findings that can be fixed; record an actual dependency and destination
for anything left open. The current diff needs a matching review record from
`npm run simplify:record`; `npm run simplify:verify` checks it.

Use the smallest relevant checks during development, then complete the
[validation workflow](../docs/development.md) appropriate to the change.
`scenes:process` already includes compilation, shaders and native builds;
`scenes:parity` measures both backends. There is no hosted CI.

On this Windows workspace, set `CMAKE_COMMAND` to the Visual Studio CMake path
documented in the user's `AGENTS.md` before native scene commands when CMake
is absent from `PATH`.
