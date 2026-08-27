# Development guide

## Requirements

- Node.js 22.12+
- CMake 3.24+
- Ninja
- a C++20 compiler (Visual Studio's bundled clang-cl is recommended for the
  Windows development loop; MSVC remains the shipping default)
- vcpkg
- PowerShell, pinned Tint for shader compilation, pinned Dawn for the default
  Windows dual-backend build, and DXC for D3D12/Vulkan
- Chrome or Edge with WebGPU for exact HDR GGX asset prefiltering and browser references
- a GPU to run what is built. bblitec renders through SDL_GPU or Dawn and
  carries no software renderer, so a device that cannot be brought up fails
  the run rather than degrading it

Development scene builds select clang-cl when it is installed and fall back
to MSVC. Shipping builds use MSVC. Linux and macOS use the same generated
sources with their native CMake generator and SDL_GPU backend.

## Core workflow

```powershell
npm ci
npm run dev:setup
npm run doctor
npm test
npm run scene -- list
npm run sweep
```

`dev:setup` is the idempotent Windows development bootstrap. It uses Visual
Studio's installed CMake and vcpkg when they are not on `PATH`, installs the
full development manifest once, and builds missing pinned Dawn, Tint, DXC, and
LabSound artifacts. `doctor` is read-only and prints the resolved path or the
missing prerequisite for Node.js, CMake, Ninja, the compiler, vcpkg, Dawn,
PowerShell, DXC, Tint, LabSound, and Chromium. `sweep` is the full registered
scene validation (`scene -- validate all`), including both GPU backends on
Windows.

Use the generic scene command rather than adding scripts for ordinary work:

```powershell
npm run scene -- show scene1
npm run scene -- compile scene1
npm run scene -- build scene1
npm run scene -- process scene1
npm run scene -- parity scene1
npm run scene -- parity scene243 --without background
npm run scene -- geometry scene145 --recapture-reference
npm run scene -- capture scene5 --seek-bracket
npm run scene -- diff scene1
npm run scene -- compose scene1
npm run scene -- measure artifacts\parity\scene1\native-gpu.png
npm run scene -- stability scene9 --backend dawn
npm run scene -- diagnose scene33
npm run scene -- clean --orphans
npm run scene -- validate scene1
npm run scene -- neutrality artifacts/parity-baseline
npm run scene -- neutrality-generated artifacts/generated-baseline.txt --write
```

`process` runs compile, scene-local shader compilation, CMake configure, and
parallel native build in order.
The compiler CLI underneath (`node dist\src\cli.js <entry.ts> --out <dir>`)
also takes `--title <text>`, `--width <pixels>` and `--height <pixels>` —
the generated engine's window title and size, default 1280x720 — and
`--id-diagnostics` for the attribution buffers. The scene command supplies
the title and attribution flag from the registry and leaves the size at its
default, which is what every golden is captured at.
`diff` captures both renderers and reports where they disagree; `compose`
checks our material feature derivation by composing each material through
Babylon Lite's own pipeline and comparing the whole fragment against the
captured one. `measure` prints a PNG's non-background bounding box, pixel
count and mean RGB (`--background r,g,b` overrides the top-left-pixel
default) — the measure-the-PNG rule as a command, for any render or probe
image. `parity --without ground|background` re-runs the native side with
one element suppressed against the unchanged golden (artifacts suffixed
`-without-<element>`, no threshold gate) — the residual-attribution
bisection. `capture --seek-bracket` captures the browser at the seek and
at ±1 frame and prints the one-frame motion scale a residual should be
judged against. `stability` renders the native side N times and prints
every run against the first *and* against the golden — both always,
because run-to-run agreement alone hides a stable-but-wrong image.
`stability` also takes `--seek <t>`: at a non-registry pose the golden
columns are suppressed (two poses measure nothing) and artifacts gain a
`-seek<t>` suffix so experiments never clobber registry-pose evidence.
`diagnose` walks the diagnosis ladder for one scene — parity
`--differential`, then `diff`, then `compose` over one shared capture —
and prints each rung's verdict in order (`--backend`, `--seek` and
`--gpu-debug` pass through).
`clean --orphans` deletes build trees and `generated/` entries no registry
scene owns; `--all` additionally removes owned build trees.
`validate` chains compile, shaders, build, parity and the status check
with one summary line per stage, preserving every artifact on failure. A retry
resumes the compile and shader stages only when their input fingerprint and
on-disk outputs still match the completed stage; changed or missing inputs run
the stage again.
See [debugging](debugging.md) for the ladder they sit in.
`geometry` captures each existing geometry-output copy task full-screen in
Babylon Lite and native without changing the curated scene source; its
native outputs and report carry the same `-gpu`/`-dawn` filename token as
parity's, and it takes `--backend` and `--seek` (the latter with
`--recapture-reference`) under the same rules.

HDR scene compilation launches headless Chromium to run the pinned
1024-sample GGX compute shader, a node-particle scene launches it to run
the pin's own simulation to the frame the scene freezes, and a scene loading
a `.basis` texture launches it to run the pinned loader's own transcode. Set
`CHROME_PATH` when Chrome/Edge is not in a standard location. Those executed
bakes replay from a content-addressed cache under `artifacts\bake-cache`
(keyed on the pin, the input bytes, the parameters, the packager module and
the browser build), so a warm recompile launches no Chromium and produces
byte-identical output; the directory is disposable, and `BBLITE_BAKE_CACHE=0`
disables the replay.

Aggregate registered-scene workflows are registry-driven through `sweep`,
`scenes:compile`, `scenes:build`, `scenes:process`, and `scenes:parity`.

Registered Babylon Lite inputs live under `corpus\babylon-lite` and must match
`upstream\babylon-lite-scenes.json` byte-for-byte. They are read-only evidence;
compiler gaps are fixed in the compiler rather than by adapting a scene.

## Integrating a curated parity scene

Numbered scenes are Babylon Lite-versus-Babylon Legacy differential tests, not
just feature samples. Investigate their Babylon Lite history as soon as a
scene is considered for integration, before implementing native fixes:

1. Trace both `lab/lite/src/lite/scene<N>.ts` and
   `lab/lite/src/bjs/scene<N>.ts` through renames with `git log --follow`.
2. Read the original parity pull request, inline reviews, and discussion.
   Record the measured MAD, accepted backend floor, known residual regions,
   rejected approaches, and any reference-page corrections.
3. Trace the reached loader, material, shader, animation, and frame-graph
   modules from that introduction through the pinned source commit. Later
   pre-pin fixes often document the exact Babylon Legacy semantic mismatch.
4. Verify every historical claim against the pinned source. History explains
   intent and failed approaches; it does not override the current source
   contract.
5. Carry useful evidence into the scene dashboard note, focused tests, or
   `TODO.md` before setting a curated threshold.
6. Run the scene in the demo window and move the camera before calling the
   integration done — a manual step, since a second capture per scene would
   double the matrix to cover something only a few scenes reach.
   [Debugging](debugging.md#before-calling-a-scene-done) carries the
   orbit-then-measure recipe and the suppression bisection to run before
   trusting the description a defect came with.

Do not wait for a high MAD investigation to perform this review. Upstream
history inspection avoids repeating Babylon Lite's own parity debugging and
helps separate a known WebGPU/raster floor from a missing compiler or PAL
contract. Post-pin commits are relevant only to an explicit upstream-version
evaluation.

### What a registered scene owns

A curated scene is described by several files that are checked against each
other, so a missing one fails the corpus tests rather than degrading quietly.

| File | What it carries |
| --- | --- |
| `src/scene-registry.ts` | the entry: id, source, title, thresholds, background, native environment |
| `upstream/babylon-lite-scenes.json` | the SHA-256 of the corpus source, proving it matches the pin |
| `reference/<id>/babylon-lite-golden.png` | the browser golden |
| `reference/exact-corpus-manifest.json` | `sourceSha256`, `referenceSha256`, `moduleSha256` over the browser module the capture harness builds, and `referenceSearch` for a scene the pin serves at a query |
| `test/scene-registry.test.ts` | the registry id list in file order, and the curated count the README publishes |
| `docs/images/scenes/scene<N>.png` | a 320x180 preview: a 4x4 box-filtered average of the golden |
| `docs/images/scenes/scene<N>-banner.png` | optional. The same box-filtered derivation taken over a centred window of the golden rather than the whole frame, for a README banner cell whose subject is too small to read at 170px |
| `docs/status.md` | the published row, checked against measurement by `status:verify` |

The README states the curated count twice, and a curated scene is a `sceneNNN`
entry only — primitives and the project-owned regression gates are counted
separately in the same sentence.

Thresholds are set by measurement, not by intent: register with loose values,
measure both backends, then tighten to just above what was measured. Scenes
where Dawn is structurally closer to the golden carry their own
`dawnThresholds`. `backgroundColor` is the scene's clear color rounded to
bytes per channel.

Animated scenes pin a frame rather than a wall-clock moment.
`referenceTimeSeconds` makes the browser harness seek and pause, and the
registry derives `nativeEnvironment.BBLITE_ANIMATION_SEEK_SECONDS` from it so
the pose is spelled once — an entry that still writes the variable explicitly
must agree numerically or registry load refuses. A golden is only valid for the registry parameters it was captured
under: a reference captured without them carries no seek, so the scene
free-ran, and diffing a seeked native run against it produces a large and
meaningless result. When native and `scene -- capture <id> --seek <t>` agree
but the golden does not, the golden is stale.

A scene can pin its pose a second way, which the seek does not cover: a
corpus scene that reads `?seekTime=` off its own URL branches on the query
before it ever installs an animation, so what freezes it is the query, not a
seek. `parity.referenceSearch` is that query string. The reference page is
navigated with it and the compiler is given the same text, so
`window.location.search` folds to what the reference read and the native
scene takes the branch the golden was captured under. It also belongs in
`reference/exact-corpus-manifest.json` beside the module digest, which
cannot carry it: the query is a navigation parameter, not module text.

### Sizing a capability before implementing it

A blocker names a capability; it does not size one. Compile-probe the scene
first, because the first blocker a scene reports is the first line of its
chain rather than its length. Then answer two questions before choosing a
shape, and let the answers decide it rather than deciding first and checking
after.

1. **Sweep the whole corpus for every usage.** Grep the scene sources, and
   read the *assets* as well whenever the capability is asset-borne — a glTF
   primitive mode or accessor layout appears in no scene source and is still
   reached by a packaged `.glb`. What the sweep is really measuring is
   whether the capability can arrive by more than one route, because that
   decides where an answer is allowed to live: a glTF primitive mode is
   settled entirely by the asset, while a topology that `createLineSystem`
   assigns to geometry built from plain arrays can never be settled at
   packaging time. One scene through one route is a slice; several scenes
   through several routes is an axis, and the two deserve different shapes.
2. **Ask whether Babylon Lite implements it on the core path or behind an
   opt-in boundary.** Upstream splits deliberately and says so in comments:
   `gltf-feature-*.ts` modules are dynamically imported behind a document
   predicate, the Draco decoder is fetched at run time, and
   `pbr-primitive-topology.ts` is a module of its own so that ordinary PBR
   scenes never carry the topology names. A capability upstream keeps off its
   core path must not become unconditional here. The generated loader, plan,
   and shaders are where this project expresses the same boundary, and
   `asset-specializer.ts` already records upstream's own predicates per
   asset, so the gate usually exists before the feature does.

Then arbitrate, and record the arbitration. An exact fold that covers every
reached usage beats a general mechanism, but only while the sweep says the
general form is unreached — so write down in `TODO.md` which usages the fold
does not cover and what would force the general shape. A capability that
compiles away entirely still owes a `docs/fidelity.md` contract explaining why
the folded form and the pinned form agree.

## Updating Babylon Lite

The repository supports one pinned upstream version. Source-located semantic
contract failures are the compatibility report; the project intentionally does
not maintain simultaneous support for multiple Babylon Lite versions, so a bump
is always "move the pin, then fix what the assertions catch".

### 1. Read the upstream delta first

Clone the upstream repository (see `upstream\babylon-lite.json` for the current
pin) and diff the pinned commit against the target release tag before changing
anything:

```powershell
git log --oneline <pinned-sha>..<tag>
git diff --name-status <pinned-sha>..<tag> -- lab/lite/src/lite lab/lite/src/demos
```

A commit subject marked `!` is a breaking API change and predicts most of the
work. The scene diff tells you which registered corpus scenes must be
re-synced: cross-check the changed file list against `src\scene-registry.ts`.

### 2. Move the pin

Four files carry the pin and all four move together:

| File | What it holds |
| --- | --- |
| `upstream\babylon-lite.json` | `version` and `sourceVersion` |
| `upstream\babylon-lite-scenes.json` | its *own* `version` and `sourceVersion`, beside the corpus digests |
| `package.json` + lock | the dependency, via `npm install` |
| `README.md` | the only prose copy of the pair |

**`sourceVersion` is the commit the published package embeds, not the release
tag's object.** Read it from the package rather than from git — an annotated
tag's `git rev-parse` returns the tag, and `rev-parse <tag>^{}` its commit,
neither of which is guaranteed to be what npm shipped:

```powershell
node -p "require('./node_modules/@babylonjs/lite/package.json').babylonLiteRelease.sourceVersion"
```

Getting it wrong fails every source-mapped test at once with
`Upstream source commit mismatch`, which reads like a broken bump and is not.

Then sync the corpus, which is read-only evidence of the pinned tree.
`corpus\babylon-lite\lab\lite\src\lite\` mirrors upstream's whole scene
directory, so new scenes land there too; `shared\` and `_shared\` hold only
the modules a registered scene imports, so those are copied by name. Refresh
the `sha256` values in `upstream\babylon-lite-scenes.json` afterwards — it
pins the registered scenes only.

### 3. Fix the compatibility report

`npm run test:upstream` reports the failures. They sort into three kinds:

- **Moved contracts.** A lowerer asserts an expression the upstream refactor
  relocated. Check whether the *semantics* moved or only the shape: if the
  formula is unchanged, retarget the assertion at the new path. Do not weaken
  an assertion to make it pass.
- **New or relocated API.** Options that became functions need intrinsics.
  Mirror the pinned setter exactly, and check what the *old* form reached:
  an option that gated a feature must have its setter reach the same feature.
  A setter is not only a spelling change when the option it replaces was also
  the trigger for a compiled feature.
- **Provenance and pin churn.** Assertions embedding the version or commit sha
  should derive them from `readUpstreamPin()` rather than hardcoding, so the
  next bump does not touch them at all.
- **Relocated *derivation*.** The hardest kind: a function this repository
  lowers from its own AST stops computing a value and starts delegating it to
  a per-extension hook. `_computeStandardMaterialFeatures` is the standing
  shape — it keeps its four base flags and derives every texture bit from a
  loop over registered extensions calling `ext._detect(m)`. The AST walker
  refuses a loop it does not recognize by name rather than lowering it
  partially, which is what keeps the texture bits from being dropped
  silently. The fix is to follow the delegation: lower each extension's
  `_detect` in the loop's place. Their results are OR-ed, so their order does
  not matter, but each body is its own shape to handle (an arrow returning
  `cond ? FLAG : 0`, an early `return 0`, an accumulator `let f = FLAG`).

  **Delegation moves preconditions with it.** Detection inside `ext._detect`
  makes registering the extensions a precondition of *deriving features at
  all*, not only of composing a fragment: an unregistered extension
  contributes no bit, silently, so every material derives as untextured and
  the variant table comes out short. Nothing fails at generation — the scene
  builds, and the first frame dies with `resolves no composed variant`. Ask
  what else relocated code depends on, and satisfy it where the derivation
  happens rather than where the composition does.

### Read the release notes, not only the log

`git log --oneline` gives subjects; the release page for each tag links the
pull requests, and the migration detail lives in those bodies. For a
moved-property change that is a setter-to-field table naming every moved
property and the places its old dispatch lived — the map this port has to
follow. Reading it is faster than reconstructing it from the diff, and it
surfaces changes whose *subject* sounds unrelated: a release described as
adding material UV transform support can add a Standard material extension,
which matters here even when no reached scene enables it.

```bash
gh api "repos/BabylonJS/Babylon-Lite/releases/tags/npm-lite-v<version>" --jq .body
gh api "repos/BabylonJS/Babylon-Lite/pulls/<number>" --jq .body
```

### Assets renamed by the pin leave orphans behind

An asset's deployed filename is hashed from its *source URL*, and the pinned
BRDF LUT's URL embeds the upstream commit — so every bump renames it, and the
previous file stays beside the executable (`native\CMakeLists.txt` records why
the asset deploy merges rather than mirrors). `scene -- build` prunes what the
generated tree no longer has, so this resolves itself; a stale-payload error
naming a file with an unfamiliar hash prefix is what it looks like otherwise.

### 4. Prove the bump is behavior-neutral

An API refactor should not move a single pixel. Keep the previous goldens,
recapture the affected scenes' browser references, and compare byte for byte:

```powershell
node dist\src\scene-command.js parity scene<N> --recapture-reference
```

A golden that changes means upstream changed behavior, not just shape — treat
that as a finding to investigate and record, not as a golden to accept. A
golden that stays identical while native parity moves means the bump broke
something on the native side.

Then run the full validation sequence. Regenerate everything: a feature that
silently stops being reached only shows up as a parity regression.

### The pin's own field names are not this port's

When upstream moves a property behind a setter it usually renames the storage
too (`emissiveTexture` becomes `_emissiveTexture`). Two places have to follow,
and they are different in kind:

- the **record-source table** that maps a pinned property to its native
  expression, because the walker looks the property up by the name the pinned
  code reads;
- the **material object generation hands to pinned code**, because the pin
  only sees a slot under its own name.

The second is a translation at one boundary, not a rename through this
repository: `emissiveTexture` describes what a material has, while
`_emissiveTexture` is the pin's bundling convention. Keep the port's own
vocabulary and translate where the object crosses over
(`pinnedOptInSlots` in `src\pinned-standard-variants.ts`).

A setter that registers an extension needs nothing extra here — generation
registers every Standard and PBR extension the pin ships before composing, so
the tree-shaking half of an opt-in change has no native counterpart. Check the
*feature reach* anyway: an option that gated a compiled feature must have its
setter gate the same one.

## Ad-hoc scenes

A repository-local TypeScript file does not need a registry entry:

```powershell
npm run scene -- process examples\my-scene.ts
npm run scene -- parity examples\my-scene.ts --recapture-reference
```

Derived paths:

| Artifact | Path |
| --- | --- |
| generated output | `generated\my-scene` |
| native build | `native\build-my-scene-release` |
| reference | `reference\my-scene\babylon-lite-golden.png` |
| parity output | `artifacts\parity\my-scene` |

Add a registry entry only for stable thresholds, custom references, native
environment flags, or attribution capabilities.

For project-owned local glTF fixtures used by both the browser oracle and the
compiler, keep binary payloads embedded and reference the `.gltf` from an
`examples` scene with a repository-root-safe path such as
`../examples/assets/<fixture>.gltf`.

## Generation and assets

Generation:

- validates the entry TypeScript and reached APIs
- materializes remote assets under `generated\<scene>\assets`, through a
  content-addressed cache in `.cache\assets` keyed by URL hash — every corpus
  URL is commit-pinned, so the bytes never change, and a populated cache
  builds the whole corpus offline. A clone of the pinned upstream commit can
  seed it directly, since asset paths under the commit are paths in the clone
- emits typed C++, headers, scene-local shaders, and CMake features
- writes `manifest.json`, `fidelity.json`, upstream provenance, and the
  per-scene activation inventory `upstream/feature-activation.json` —
  every activation unit with whether this scene reaches it, the reaching
  call site, and the pinned module or predicate it mirrors

`generated\` is disposable. Never fix generated files directly.

Generation must finish before shader compilation and native build. Do not run
those phases concurrently.

Every `npm run scene -- ...` invocation first runs `npm run build`. Changed
inputs compile with the TypeScript 7.0.2 native Go compiler from
`@typescript/native`; the TypeScript 5.9 package remains installed because
bblitec imports its JavaScript compiler API for AST analysis. The wrapper
skips the clean and `tsc` when `dist/.build-stamp` still matches the sources
and both TypeScript packages (any doubt rebuilds; `npm run clean:dist` forces
cold) — so editing TypeScript while one is running still risks a mixed
`dist`. For a chain of
several operations, build once and call `node dist/src/scene-command.js <op>
<scene>` directly, which leaves `dist` frozen while sources change. That
freezes generation entirely: its only inputs are the compiled `dist` and the
pinned package under `node_modules` — C++ text and WGSL are embedded in the
compiled modules or lifted from the pin at run time, not read from `src/`.

## Shader compilation

The development bootstrap installs DXC and builds pinned Tint:

```powershell
npm run dev:setup
npm run doctor
```

Set `DXC_PATH` when DXC is not discoverable. The Windows SDK DXC may lack
SPIR-V support; the vcpkg `directx-dxc` build is preferred.

Native CMake builds snapshot the reached shader directory. Rebuild a scene
after regenerating or recompiling its shaders. The snapshot is a stamped
custom command the executable depends on, so shader-only changes redeploy
beside the executable on single- and multi-config generators while unchanged
builds remain no-op.

## Native builds

`scene -- build` validates the native prerequisites once, configures the
registry-derived build directory, and invokes `cmake --build`. On Windows it
discovers Visual Studio's bundled CMake and vcpkg when `CMAKE_COMMAND` and
`VCPKG_ROOT` are unset. Explicit variables override discovery.

Manual equivalent:

```powershell
cmake -S native -B native\build-scene1-release `
  -G Ninja `
  -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT\scripts\buildsystems\vcpkg.cmake" `
  -DBBLITE_GENERATED_DIR="$PWD\generated\scene1"
cmake --build native\build-scene1-release --config Release
```

Ninja is the default on every platform. On Windows, the scene command locates
Visual Studio, the latest MSVC toolset, the Windows SDK, Visual Studio's
bundled CMake, vcpkg, Ninja, and the optional bundled clang-cl without
requiring a Developer Command Prompt. `--compiler auto|clangcl|msvc` selects
the development compiler; `auto` prefers clang-cl and falls back to MSVC. Set
`BBLITE_DEV_COMPILER` for the same persistent choice and
`BBLITE_CMAKE_GENERATOR` to override the generator. If the generator, compiler,
make program, toolchain, or vcpkg install root differs from the CMake cache, the
command replaces only that incompatible disposable scene build tree. All build
trees are ignored and safe to delete.

Warnings in the first-party `bblite_native` target are errors under MSVC,
clang-cl, Clang, and GCC. Imported dependency headers remain system headers and
dependency build warnings do not inherit the first-party error policy.

Scenes build several at a time, but their CMake *configure* steps are
serialized, because that is where vcpkg runs and concurrent vcpkg use is
unreliable. Every development scene shares one full install at
`artifacts\vcpkg-installed\development-full`. Its feature list is derived from
every feature key in `native\vcpkg.json`, so adding a manifest feature
automatically adds it to the reusable development set; one scene cannot
reconcile another scene's packages away. This deliberately spends development
disk space once to make switching among and building all scenes cheap. Set
`BBLITE_VCPKG_INSTALLED_ROOT` to relocate the disposable shared cache.
Compiling and linking touch nothing shared. A warm tree skips configure
entirely, so the lock is normally uncontended. Shipping does not use this
superset: its exact static tree contains only the selected scene/backend's
reached dependencies.

How many scenes run at once is configurable per stage; see
[Build switches](#build-switches).

An existing directory first configured without vcpkg is detected from its
CMake cache and replaced automatically before configuration. `VCPKG_ROOT`
remains the override for a vcpkg checkout other than the one discovered from
Visual Studio or `PATH`.

Override the generator only when needed:

```powershell
$env:BBLITE_CMAKE_GENERATOR = "Visual Studio 18 2026"
npm run scene -- process scene1
```

Ninja places `bblite_native.exe` directly in the build directory; multi-config
Visual Studio generators place it under `Release`.

Native outputs are self-contained by default: CMake places `assets` and
`shaders` beside the executable, and runtime lookup is relative to that
executable. `BBLITE_ASSET_DIR` and `BBLITE_GPU_SHADER_DIR` remain explicit
overrides for diagnostics and unusual layouts.

Shader compilation uses `artifacts\shader-cache` for both halves of the
offline path: each requested DXC format is independently keyed by source,
profile, DXC executable/codegen DLLs and its exact invocation flags, and the
Tint half (`tint-*` entries holding HLSL, reflection, `.slots`, and MSL when
requested) by the Tint executable, the source WGSL, the entry point, the
selected outputs and the script itself — so a warm corpus pass reports `0
transpiled, N replayed`. Requested binaries are validated and atomically
published, so interrupted or malformed entries are rebuilt instead of
reused. Identical variants are reused across scenes; the cache is disposable.
The step also enforces SDL_GPU's four-uniform-buffer
stage cap on every compiled stage, refusing by block name (release SDL
corrupts the D3D12 command buffer past it), with the `gp` demotion keyed on
the block's own declaration rather than a filename.

Build only the pinned Tint CLI with:

```powershell
pwsh -File tools\build-tint.ps1
```

Build only the pinned Dawn library (same source pin, shared checkout) with
`pwsh -File tools\build-dawn.ps1`. Build only pinned LabSound with
`pwsh -File tools\build-labsound.ps1`. The normal full development bootstrap is
`npm run dev:setup`; `build-dawn-min.ps1` belongs only to the trimmed shipping
flow. The CMake `BBLITE_BACKEND`
selection (`SDL_GPU`, `DAWN`, or `BOTH`) picks the compiled backend
set. Windows development scene builds default to `BOTH` and require
`artifacts\tools\dawn`; Linux and macOS retain the SDL_GPU default. The
`BBLITE_BACKEND` environment variable overrides the default. `build` and
`process` also accept
`--backend sdl_gpu|dawn|both`. An explicit single backend is available for
focused diagnosis or backend-specific timing. Shipping is always one exact
backend:

```powershell
npm run scene -- process scene1
npm run scene -- build scene1 --backend sdl_gpu
```

`process` also accepts `--shader d3d12|vulkan|metal|all`. It defaults to the
one target the host can execute (`d3d12` on Windows, `metal` on macOS,
`vulkan` elsewhere), removing stale non-target artifacts from the generated
tree. Use `all` only for a deliberate portability/compiler sweep:

```powershell
npm run scene -- process all --backend sdl_gpu --shader d3d12
npm run scene -- process scene1 --backend sdl_gpu --shader all
```

`BBLITE_SHADER_TARGET` is the environment equivalent. Plain `build` does not
run the shader compiler, so the selector intentionally belongs to `process`.

In `BOTH` builds
`BBLITE_GPU_BACKEND=dawn` selects Dawn at runtime — the parity
harness forwards the environment and labels its reports with the
active backend; single-backend builds default to their compiled
backend and fail explicitly when the other one is requested. See
[backends](backends.md).

Reached WGSL shaders require `artifacts\tools\tint\tint.exe` (or `TINT_PATH`).
Tint validates WGSL and emits the source required by the selected target:
HLSL for D3D12/Vulkan and MSL for Metal. DXC compiles normalized HLSL to DXIL
for D3D12; it temporarily emits SPIR-V for Vulkan until Tint resource bindings
are remapped to SDL_GPU's dense texture/sampler convention. Each shader
directory records the selected target and participating tool hashes in
`shader-compiler.json`.

## Build switches

The CMake cache variables that shape a native build (see
[Minimal-size shipping builds](#minimal-size-shipping-builds) for the size-optimized
combination):

| Variable | Default | Purpose |
| --- | --- | --- |
| `BBLITE_GENERATED_DIR` | required | directory produced by bblitec (`main.cpp`, `features.cmake`) |
| `BBLITE_BACKEND` | Windows: `BOTH`; other hosts: `SDL_GPU` | compiled GPU backend set: `SDL_GPU`, `DAWN`, or `BOTH`; Windows development commands require the pinned Dawn install by default and honor the `BBLITE_BACKEND` environment variable |
| `BBLITE_DAWN_DIR` | `artifacts/tools/dawn` | installed Dawn package root; point at `artifacts/tools/dawn-min` for the minimal static FXC-only library |
| `BBLITE_SDL_DIR` | empty | subsystem-trimmed static SDL3 root (`tools/build-sdl-min.ps1`); empty selects the toolchain (vcpkg) SDL3 |
| `BBLITE_LABSOUND_DIR` | `artifacts/tools/labsound` | installed pinned LabSound root (`tools/build-labsound.ps1`); required only by a scene reaching `audio:engine` |
| `BBLITE_MINSIZE` | `OFF` | size-first compilation (MSVC `/O1 /Ob1 /GL`; clang-cl `/clang:-Oz /clang:-flto`; non-MSVC Clang `-Oz -flto`; `-Os` elsewhere), whole-program optimization and dead-stripping plus a `/MAP` linker map for `tools/map-size-report.mjs` on Windows |
| `VCPKG_TARGET_TRIPLET` | `x64-windows` | `x64-windows-static` folds SDL/image/codec dependencies into the executable |
| `CMAKE_MSVC_RUNTIME_LIBRARY` | toolchain | pass `MultiThreaded$<$<CONFIG:Debug>:Debug>` with the static triplet; vcpkg does not flip the project's own CRT |

Generation additionally writes `BBLITE_IMAGE_CODECS` into
`features.cmake` (the image codecs the scene's materialized assets reach).
The exact shipping configure maps that list onto vcpkg manifest features
before `project()`, so JPEG or WebP support is linked only when the selected
scene carries that content; a generated directory that carries no list falls
back to the png+jpeg pair. Development scene commands instead pass the full
manifest feature set described above.

### Concurrency

Environment variables read by `scene -- <stage> all`, not CMake cache
variables. Each stage runs several scenes at once; these decide how many. A
single-scene invocation ignores them and takes the whole machine.

| Variable | Default | Bound by |
| --- | --- | --- |
| `BBLITE_PARALLEL_COMPILES` | hardware threads | threads alone — a generating Node process is small |
| `BBLITE_PARALLEL_SCENES` | `min(threads, RAM / 2GB) / jobs` | threads and memory, conservatively budgeted at roughly 2 GB per native compiler process from the heaviest MSVC translation unit |
| `BBLITE_SCENE_BUILD_JOBS` | `1` | measured: see below |
| `BBLITE_PARALLEL_PARITY` | `8` | GPU throughput; a flat number because GPU memory measured too small to bind |

Thread counts come from `availableParallelism()`, which respects CPU affinity
and container limits, rather than the host's processor count.

One job per scene is the measured optimum. An incremental corpus rebuild after
a `pal_dawn.cpp` edit, 58 scenes on a 24-core/32-thread host: 246.7s
sequential, `32x1` 25.9s, `24x1` 28.4s, `16x2` 30.6s, `12x2` 33.6s, `8x3`
42.3s. Splitting the same budget the other way costs 15-33%, because an
incremental rebuild leaves most scenes with one or two dirty translation
units — a second job per scene has nothing to do while a second scene always
does.

Measurement is the one stage whose default is a flat number rather than a
function of the machine, because GPU memory does not bind it. Each scene
creates a GPU device, a swapchain and its own textures, which samples at
0.28 GB of dedicated GPU memory per concurrent scene — 2.25 GB attributable at
eight at a time, 2.09 GB at sixteen, since scenes finish sooner and fewer
overlap. That fits a 4 GB card beside a desktop, so scaling the default to the
adapter would add a platform probe to guard a limit nothing reaches.

GPU throughput binds instead. All 57 scenes: 195.5s at one, 100.0s at two,
52.8s at four, 33.6s at eight, 26.0s at sixteen — doubling past eight buys 23%.
Eight sits at the knee without assuming a workstation GPU. Every level produces
byte-identical differential reports, so raising it on a known machine is safe.

## Minimal-size shipping builds

"Shipping", "release/demo", and "mini" all mean this one shape. There is no
second dynamic demo variant: every published demo ZIP is aggressively trimmed
to one scene and one backend, uses the static CRT and exact static
dependencies, and enables whole-program size optimization and dead stripping.
The current static examples are 2.3 MB for Scene 1 SDL_GPU, 7.7 MB for Scene 1
Dawn, and 2.5 MB for the Bullet-backed Scene 40 SDL_GPU executable.

Build the trimmed dependencies once:

```powershell
pwsh -File tools\build-sdl-min.ps1
pwsh -File tools\build-dawn-min.ps1
```

`build-sdl-min.ps1` compiles the vcpkg-pinned SDL3 version with only
video, events, and SDL_GPU (no audio, joystick, haptic, HIDAPI,
sensor, camera, power, dialog, GL/Vulkan, or SDL_Renderer — nothing
links the software renderer, since bblitec requires a GPU). **A scene
reaching `audio:engine` is refused at configure against this install**,
because `SDL_AUDIO=OFF` leaves no device to open; a minimal build with
audio needs that option flipped in an install root of its own.
`build-dawn-min.ps1` builds the monolithic static, D3D12-only,
FXC-only Dawn: the package ships no compiler DLLs and resolves
`d3dcompiler_47.dll` from the executable directory or System32, with
the documented FXC-versus-DXC LSB tradeoff
(see [backends](backends.md#measured-contracts)).

Configure with the static triplet:

```powershell
cmake -S native -B native\build-scene1-min-sdl `
  -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT\scripts\buildsystems\vcpkg.cmake" `
  -DVCPKG_TARGET_TRIPLET=x64-windows-static `
  '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>' `
  -DBBLITE_GENERATED_DIR="$PWD\generated\scene1" `
  -DBBLITE_BACKEND=SDL_GPU `
  -DBBLITE_MINSIZE=ON `
  -DBBLITE_SDL_DIR="$PWD\artifacts\tools\sdl-min"
cmake --build native\build-scene1-min-sdl --config Release --parallel
```

The Dawn shape substitutes `-DBBLITE_BACKEND=DAWN` and
`-DBBLITE_DAWN_DIR="$PWD\artifacts\tools\dawn-min"`. Package with
`tools/package-demo.ps1 -Scene scene1 -BuildDirectory <dir>`. The packager
refuses a development, dynamic, dual-backend, or non-`BBLITE_MINSIZE` tree;
shipping packages contain no runtime or CRT DLLs.
Attribute the executable's bytes after any change:

```powershell
node tools\map-size-report.mjs native\build-scene1-min-sdl\Release\bblite_native.map
```

## Runtime switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GPU_BACKEND=dawn` | select the Dawn (WebGPU) render backend; every backend-running scene subcommand also takes `--backend`, which wins over this variable and prints the override |
| `BBLITE_GPU_DEBUG=1` | enable the backend GPU validation layer |
| `BBLITE_MSAA=1` | force single-sample rendering for diagnostics, on both backends: it answers whether a difference is multisampling by removing it (`scene -- stability --single-sample` drives it) |
| `BBLITE_BACKGROUND=0` | disable a requested DDS/HDR/solid-colour skybox (`scene -- parity <id> --without background` drives it) |
| `BBLITE_GROUND=0` | disable a requested transparent environment ground (`scene -- parity <id> --without ground` drives it) |
| `BBLITE_MAX_FRAMES=<n>` | automated frame limit |
| `BBLITE_ANIMATION_SEEK_SECONDS=<t>` | seek the deterministic clock before the measured frame (registry entries pin per-scene poses; `--seek` on `parity`/`geometry`/`capture`/`diff`/`probe-variants` overrides) |
| `BBLITE_TEST_PASS=1` | the measured-run contract the harnesses set: capture-driven frame gating |
| `BBLITE_ID_BUFFER=<path>` / `BBLITE_CLUSTER_BUFFER=<path>` | write the draw-id / triangle-cluster attribution buffers (set by `parity` for registry-attributed scenes) |
| `BBLITE_COPY_TASK=<name>` | select one frame-graph copy task full-screen (driven by `scene -- geometry`) |
| `BBLITE_SCREENSHOT=<path>` | capture PNG |
| `BBLITE_SCREENSHOT_FRAME=<n>` | delay callback-driven capture |
| `BBLITE_BENCHMARK_FRAMES=<n>` | benchmark after warmup |
| `BBLITE_ASSET_DIR=<path>` | override asset directory |
| `BBLITE_GPU_SHADER_DIR=<path>` | override shader directory |
| `BBLITE_DEFORMATION_DUMP=<path>` | append first-frame bone palettes and morph weights as hexfloats (SDL_GPU deformation scenes) |
| `BBLITE_RENDER_CAPTURE=<path>` | write the captured frame's full CPU-side description as JSON (both GPU backends) |
| `BBLITE_PHYSICS_TRACE=1` | print each rigid-body step's `dt` and every body's post-step position to stderr. A substituted solver cannot be gated by MAD against a Havok golden, so the trajectory is what grades it: free fall has a closed form both solvers share, and a resting height is geometry ([fidelity](fidelity.md#physics-contract)) |
| `BBLITE_AUDIO_CAPTURE=<path.wav>` | render the scene's audio graph offline instead of opening a device, and write it as 32-bit float WAV when the run ends, with a frames/peak/RMS line on stderr. Audio produces no pixels, so this is what a comparison reads; two runs of one scene produce byte-identical PCM |
| `BBLITE_AUDIO_CAPTURE_SECONDS=<t>` | how long to render for `BBLITE_AUDIO_CAPTURE` (default 1.0) |
| `BBLITE_BUILD_STAMP_OUT=<path>` | write the digest of the sources this executable was built from |

Controls: left-drag orbit, right/middle-drag pan, wheel zoom; arrows and
`W`/`S` are the orbit camera's keyboard fallbacks, and free cameras take
`WASD`/arrows plus `Space`/`Shift`.

## Parity

Corpus reference capture serves a minimal local page containing only the
render canvas; it does not include Babylon Lite's showcase loading overlay.
A physics scene additionally resolves `@babylonjs/havok` to the published
ESM module and its WASM to the pinned `lab/public` copy, so the reference
runs the real solver; the devDependency exists for that page alone and
nothing native links it ([fidelity](fidelity.md#physics-contract)).
Relative local imports resolve from the entry source's repository path;
requested `.js` modules transpile on demand from their sibling `.ts`
sources. When the generated manifest records the
`deterministic-seeded-random` adaptation, the page installs the pinned
mulberry32 (seed 1) `Math.random` before the scene module loads, matching
`bbl::js::random_js` in the native runtime.
The gate waits for `canvas.dataset.ready`, which is set only after awaited
asset loads, scene registration, and `startEngine`, then captures the canvas
alone. A slow or failed load therefore times out instead of recording the
progress bar.

Run a curated scene:

```powershell
npm run scene -- parity scene273
```

Refresh a source-based reference only intentionally:

```powershell
npm run scene -- parity scene273 --recapture-reference
```

Registered scenes require their curated reference to exist. Ordinary parity
fails instead of recreating a missing golden; only
`--recapture-reference` authorizes an intentional replacement. Ad-hoc scenes
retain the bootstrap behavior shown above, and one without configured
thresholds still measures — its reports and console output are labelled
`diagnostic-only`.

The full parity flag set (an unknown flag is an error naming this set):

| Flag | Effect |
| --- | --- |
| `--backend sdl_gpu\|dawn` | select the backend. `gpu` is accepted for `sdl_gpu`. Ambient `BBLITE_GPU_BACKEND` is the fallback; an explicit flag that disagrees with it wins and prints the override. |
| `--seek <t>` | measure pose `<t>` instead of the registry pose, on both sides — the browser capture seeks through the harness, the native run through `BBLITE_ANIMATION_SEEK_SECONDS`. Requires `--recapture-reference` while a golden exists, because a seeked native against an unseeked golden compares two different poses. |
| `--recapture-reference` | intentionally replace the golden (see above) |
| `--differential` | both GPU backends plus their direct comparison (below); accepts only `--gpu-debug` beside it |
| `--gpu-debug` | the backend's validation layer plus SDL assertion defusal (see [debugging](debugging.md#runtime-switches-worth-knowing)) |
| `--exe <path>` | measure a specific native executable instead of the scene's Release build; `BBLITE_NATIVE_EXE` is the environment form of the same override |
| `--actual <png>` | compare an existing image instead of rendering one |
| `--without ground\|background` | re-run the native side with one element suppressed against the unchanged golden — artifacts suffixed `-without-<element>`, no threshold gate |
| `--no-fail` | report a threshold violation as a warning instead of a failing exit |

Outputs land in the scene's parity directory `artifacts\parity\<scene>`:
the actual image as `native-{gpu,dawn}.png` — suffixed per backend, so
an SDL_GPU run and a Dawn run never overwrite each other's evidence — plus
the diff map, hotspots, `report-{gpu,dawn}.json`, and optional
draw/cluster buffers. Committed goldens live under `reference\<scene>`.

Both GPU backends serve the attribution captures. `BBLITE_GPU_BACKEND=dawn`
before any of the scene 1 commands renders the draw-id and triangle-cluster
buffers through Dawn instead of SDL_GPU, and the filenames carry the backend
token like every other artifact (`draw-ids-<token>.png`,
`triangle-clusters-<token>.png`). The two backends produce
byte-identical id/cluster buffers, so either side can attribute a diff.

Render both GPU backends and diff them against each other and the
golden in one report:

```powershell
npm run scene -- parity scene33 --differential
```

Each backend still runs through its standard gates (scenes where Dawn
is structurally closer to the golden carry tighter `dawnThresholds`
in the registry), and `report-differential.json` adds the direct
SDL_GPU-versus-Dawn comparison — backend agreement to one LSB puts a
divergence on the CPU side, disagreement on the GPU side
([backends](backends.md)).
`--differential` also composes with `parity all`. It runs each backend in its
own process, because the backend selection is process-global, and those
processes receive only the differential flag — combining it with anything
except `--gpu-debug` is an error rather than a silent drop. Capture a new
golden with a plain `parity <id> --recapture-reference` first, then run the
differential.

## Instrumented browser capture

When a parity residual resists chain reasoning, capture the browser's
actual GPU state instead of theorizing about it:

```powershell
npm run scene -- capture scene247
npm run scene -- capture scene247 --skip-draw 12096
```

The command renders the scene through the pinned package exactly like
the reference capture, with every WebGPU entry point hooked, and
writes to `artifacts\capture\<scene>`:

- `shaders/*.wgsl` — the browser's composed shader modules
- `buffers.json` / `buffers-summary.txt` — every buffer with its
  size, usage, and uploaded bytes (base64; the last eight writes per
  buffer)
- `tex-uploads.json` — texture uploads, including raw bytes for small
  texels (the 1x1 factor textures), raw bytes for 32-bit-float texel
  rows up to 32 KB (the per-skin bone-matrix textures), and a 4x4
  sample of image uploads
- `draws.json` — draw-call census across pass **and render-bundle**
  encoders (Babylon Lite records mesh draws into bundles; hooking the
  pass encoder alone sees none of them)
- `screenshot.png` — checked byte-for-byte against the committed
  golden when no draw filter is active, proving the hooks are
  non-perturbing

The buffers are recorded as base64, and nothing in the file says what they
mean. Decode them against the layouts the capture already contains:

```powershell
npm run scene -- uniforms scene253 --size 96
```

`uniforms` reads a capture directory, parses the struct declarations out of the
browser's own composed shader modules beside it, and prints every uniform
buffer whose size matches one of them as named fields. That turns "is our
material record right?" into a direct comparison against the values the
browser actually uploaded, rather than an argument about shader text.

A composed fragment declares one struct per material feature set, so several
unrelated layouts can share a size — the base-colour UV transform pair and the
dielectric reflectance slice both occupy 32 bytes. Every candidate is decoded
and labelled with the module it came from rather than one being picked, since
reading plausible values out of the wrong layout is worse than reporting the
ambiguity. `--module <substring>` narrows it once the right fragment is known,
and `--capture <dir>` reads a capture written somewhere other than
`artifacts\capture\<scene>`.

`--seek` overrides the registry's `referenceTimeSeconds`,
`--capture <dir>` writes the capture somewhere other than
`artifacts\capture\<scene>`, and `--skip-draw <indexCount>` drops
matching draws for per-draw isolation; pair it with a matching
temporary filter in the native frame loop to localize a residual to a
single draw. The recorded
buffer bytes support bit-level comparison against native uploads —
weights, morph deltas, instance matrices, material UBOs, and factor
texels. The scene 243 occlusion and scene 247 shading contracts this
resolves are recorded in
[backends](backends.md#measured-contracts) and
[fidelity](fidelity.md).

## Native render capture

The native half of the same question:

```powershell
npm run scene -- capture scene33 --native
npm run scene -- capture scene33 --native --backend dawn
```

`BBLITE_RENDER_CAPTURE=<path>` makes either backend write the frame it
screenshots as JSON: the scene, camera, environment, light, mesh and
material records, the draw list in submission order with its pipeline and
bucket, and every uniform block it builds. The blocks are rebuilt through
the same generated `build_*_uniforms` functions the frame loop calls with
the same `(scene, engine, camera, item)`, which is why both backends
write byte-identical captures for a scene — and why this describes what
our CPU computed rather than intercepting the graphics API. A backend
that uploaded correct bytes to the wrong slot still looks correct here;
that is what `parity --differential` is for.

The run is subject to the same build-identity checks as a measured parity
run, so a capture cannot silently describe a stale executable. The capture
lands beside the browser capture as `native-{gpu,dawn}.json` with its
screenshot — the same `gpu` filename token the parity artifacts use, while
`--backend` keeps the unambiguous `sdl_gpu|dawn` values (`gpu` accepted,
ambient `BBLITE_GPU_BACKEND` as the fallback). `--capture <dir>` redirects
the output directory and `--gpu-debug` turns the backend's validation
layer on for the run.

```powershell
npm run scene -- diff scene33
npm run scene -- diff scene33 --backend dawn --recapture
```

`diff` takes both captures — capturing whichever is missing — and reports
where they part: draw shapes, then uniform values field by field — the
capture's pinned material and mesh blocks included, with per-block
tallies and any block no PBR draw carries flagged refused — then the
native bone palettes looked up among the browser's float-texture uploads
(mirror map applied), then the browser's composed shaders hashed against
the generated arms (matched groups, both one-sided sets, and the closest
near miss's first divergent line), then the texture sample expressions
in each side's shaders. Native fields are named through the struct
declarations in the scene's own generated headers — `renderer_plan.hpp`
plus the pinned uniform mirrors in `standard_variants.hpp` /
`pbr_variants.hpp`; browser buffers through the structs in the
browser's own composed shaders. See [debugging](debugging.md) for how to
read the report, including why a byte-exact scene still lists entries.

Its flags: `--backend` selects which native capture to pair (values and
fallback as above), `--seek <t>` diffs pose `<t>` instead of the registry
pose, `--capture <dir>` reads and writes a capture directory other than
`artifacts\capture\<scene>`, `--recapture` forces both sides fresh, and
`--gpu-debug` applies to the native recapture. The paired report is
written beside the captures as `diff-{gpu,dawn}.json`.

## Build identity

A measurement is only worth its number if the executable was built from the
inputs currently on disk. Three things decide what a run renders, and each is
checked separately because each goes stale differently:

- **Compiled inputs.** Generation digests the generated C++ and the tracked
  native sources into `generated\<scene>\build-inputs.json` and embeds the
  digest through `build_stamp.hpp`. The executable writes it to
  `BBLITE_BUILD_STAMP_OUT` when asked, and `scene -- parity` refuses a binary
  whose stamp no longer matches the tree.
- **Deployed payload.** The shader and asset directories beside the executable
  are compared file by file against the generated tree before a run starts, so
  a shader step that failed without stopping the build cannot be measured.
- **Build configuration.** The CMake cache values are read from the build
  directory rather than embedded, so one generated tree serves the release
  build and a minimal-size build without either looking stale.

The stamp deliberately covers the whole tracked native source set rather than
the subset a configuration compiles: `BBLITE_BACKEND` drops a backend's
translation units, and the same sources must digest identically either way.

Generation rewrites a file only when its bytes change and prunes what a run no
longer emits, so an unchanged scene rebuilds nothing. `scene -- process`
reconfigures only when the CMake cache differs from the values it would pass or
a configure input is newer than CMake's `CMakeFiles/cmake.check_cache`
generation marker. `--cold` forces the configure regardless.

## Proving a change moved nothing

Most changes are supposed to leave every measured scene where it was, and the
proof should match what the change can possibly affect. The full matrix is not
always the right tool, and for compiler-only work it is strictly weaker than
the cheap one.

**A change confined to TypeScript is proved by the generated tree.** Compile
every registered scene, then digest every file under `generated/`:

```powershell
npm run scene -- compile all
npm run scene -- neutrality-generated artifacts\generated-baseline.txt --write
# ...apply the change...
npm run scene -- compile all
npm run scene -- neutrality-generated artifacts\generated-baseline.txt
```

Byte-identical generated output plus an untouched `native/` tree means the
build stamps are identical, which means the executables are the same binaries,
which means the measurements cannot have moved. That is an exact proof rather
than a measurement, and it costs a compile pass instead of a build-and-render
pass. The command digests what is on disk and never compiles — hence the
explicit `compile all` before each invocation. It exits non-zero and lists
every added, removed or changed file when the tree moved.

Two conditions bound the digest. Top-level directories under `generated/` that
no registry scene owns — a corpus sweep's `sceneNNN` leftovers, a deleted
probe — are listed and excluded rather than counted; delete them when they are
reported. And nothing else may use `dist/` while `npm run build` runs, because
the build removes the directory first.

**A change that reaches native sources, the PAL, or shader emission has to be
measured**, because generated bytes changing tells you nothing about the
image. Snapshot every `artifacts/parity/*/report-differential.json` before the
run and compare the same files afterwards, cell by cell — reading MAD columns
by eye misses a moved backend delta:

```powershell
Copy-Item -Recurse artifacts/parity artifacts/parity-baseline
npm run scenes:process
npm run scenes:parity
npm run scene -- neutrality artifacts/parity-baseline
```

`neutrality` prints every cell that moved and exits non-zero if any did. It
compares `report-differential.json` only — a single-backend sweep produces
nothing it can compare.
`status:verify` performs the published half of the same comparison.

It already knows the movements that are not findings: scenes 9, 37, 120 and
126 do not render bit-identically from one run to the next, so those cells
move for any change and for no change alike. They are reported as expected wobble and
excluded from the exit status; every other moved cell is real. The whitelist
is per scene AND per backend — scene 9's wobble is Dawn-only, scenes 37 and
120 wobble on both — because the mover is multisampling
([debugging](debugging.md#2-which-side-is-it-on) carries the measured
mechanism and the magnitudes). A cross-backend cell moves when either side
does, so one wobbling backend excuses it; each scene's own
`goldenVersusSdlGpu` cells stay compared regardless.

Nothing else is on that list, and the entry fee is a measurement rather than a
surprising neutrality run: `scene -- stability <id> --backend <b>` has to show
the re-runs differing and `--single-sample` has to show them stop. A whitelist
entry excuses those cells permanently, so it hides any regression smaller than
the wobble.

There is no hosted CI. During iteration, run only the smallest relevant tests,
generation steps, affected native builds, and scene parity gates. Do not repeat
the complete corpus matrix after every local change.

Before pushing compiler, renderer, shader-interface, loader, animation, or PAL
changes, run the canonical full validation sequence once:

```powershell
npm run simplify:verify
npm test
npm run scenes:process
npm run scenes:parity
npm run status:verify
```

`simplify:verify` is gate 3 as a command: it fails until
`docs/reviews/<content-hash>.json` records the `/simplify` angles run and, per
finding, whether it was applied — and for an unapplied one, what blocks it and
where it is filed. The hash is over the branch's own diff against `main`, so
applying the findings changes it and the record is written last;
`npm run simplify:record` prints the path. It runs first because the sweep
below is the expensive step and a review that follows it guarantees a second
one.

`scenes:process` *is* compile, shaders and build. `npm run scene -- validate
all` bundles the same three stages plus parity and `status:verify` behind one
summary line per stage — its parity stage runs `--differential` when the
pinned Dawn library is installed, mirroring `scenes:parity` — and stops at the
first failing stage while preserving every artifact the completed stages
wrote (`validate <id>` runs every stage for that scene alone and filters
the status check to its row); `npm test` stays separate.

`scenes:parity` runs both backends (`parity all --differential`) because
[status](status.md) publishes an SDL_GPU and a Dawn number for every scene; a
single-backend sweep leaves the second column unverified between manual runs.
On a machine without the pinned Dawn library, run `npm run scene -- parity all`
instead and treat the Dawn column as unmeasured.

`status:verify` compares every published pair, and its severity colour, against
the reports the parity run wrote. The table is checked data, not prose.

Do not run generation and native builds concurrently. Do not build multiple
CMake trees concurrently against the same vcpkg installation.

The full list of deterministic animation gates is the set of
`referenceTimeSeconds` entries in `src/scene-registry.ts`; these five anchor
the distinct mechanisms:

| Scene | Seek | Coverage |
| ---: | ---: | --- |
| 5 | 2.0 s | morph targets plus skeleton |
| 151 | 0.5 s | grouped position/scaling/quaternion property tracks |
| 154 | 0.75 s | LINEAR versus STEP property interpolation |
| 240 | 0.5 s | glTF node transform |
| 245 | 1.0 s | recursive skeleton hierarchy |

`referenceTimeSeconds` and optional `referenceAnimationGroups` in
`src/scene-registry.ts` describe browser capture seeking: the harness writes
that time onto each named group and pauses it, so the pose lands on the next
tick from whoever drives the group. The shape is upstream's own parity
freeze — a frame-count gate that pauses and signals through
`canvas.dataset.animationFrozen` — with the pose pinned by time rather than
by frame count, since the native side measures a time. Native parity uses
`BBLITE_ANIMATION_SEEK_SECONDS`. The groups are scene-source expressions
evaluated where the seek is injected — a local name, or a spread of a
container's own collection — and a scene that names none seeks
`scene.animationGroups`, which is what a glTF file added whole exposes. A
scene driving its clips through its own manager has to name them, since it
never registers them with the scene.

## Shipping demo packages

Package the exact Scene 1 SDL_GPU mini tree (the default build directory is
`native\build-scene1-min-sdl`):

```powershell
npm run package:demo -- -Scene scene1
```

For another scene or Dawn tree, pass `-BuildDirectory <dir>` explicitly. The
packager reads the cache and requires one backend, `BBLITE_MINSIZE=ON`, the
`x64-windows-static` triplet, the `MultiThreaded` static CRT, and no runtime
dependency DLLs. SDL_GPU ships
only offline D3D12 DXIL shaders with their `.slots` binding sidecars; it does
not ship SPIR-V. Dawn ships only the reached native WGSL text and uses the
static FXC-only library from `tools/build-dawn-min.ps1`. Reached assets and
the notices for statically linked dependencies remain in the ZIP. Text shader
intermediates (HLSL, MSL, reflection dumps) never ship. The archive is written to
`artifacts\releases\bblitec-<scene>-<backend>-windows-x64.zip`, and
the README embeds the scene's current parity numbers when
`artifacts\parity\<scene>` reports exist.

## Windows troubleshooting

- Run `npm run doctor` first. It reports all full-development prerequisites
  before generation or per-scene CMake configuration begins.
- Shader-step failures do not say `error C`: when filtering `process`
  output, also match `Tint HLSL generation failed` and `exited with
  status`, or a scene keeps its stale shaders and executable and parity
  silently validates the previous build. When a validation result looks
  surprisingly unchanged after a shader edit, rerun `process` with full
  output before trusting it.
- `scene -- build` never regenerates: hand-instrumented files under
  `generated\` survive a build (useful for disposable printf debugging)
  but are wiped by the next `compile`/`process`.
- `LNK1168`: stop the specific running executable that locks the output.
- `C1083: Cannot open compiler generated file` while vcpkg builds a
  dependency from source: MSVC hit `MAX_PATH`. vcpkg's build trees live under
  the build directory, so a repository checked out at a long path (a
  `.claude/worktrees/<name>` worktree, for instance) overflows it for a port
  with deep sources. Configure once with
  `-DVCPKG_INSTALL_OPTIONS=--x-buildtrees-root=C:/bt`; the port then lands in
  the global binary cache and every later configure restores it from there.
- `ucrtd.lib` missing: ensure `LIB` contains the MSVC x64, Windows UCRT x64,
  and Windows UM x64 library directories.
- generator/compiler/toolchain mismatch: the scene command replaces the
  affected disposable `native\build-*` directory automatically.
- stale shader/runtime pair: regenerate shaders, then rebuild the same scene.
- new build cannot find SDL/nlohmann-json: run `npm run doctor`; set
  `VCPKG_ROOT` only when the intended vcpkg is not the Visual Studio or `PATH`
  installation discovered by the command.
- D3D12 command-list failure during screenshot after runtime mesh append:
  capture must occur after the topology-update frame, which PAL defers
  automatically.

## Common mistakes

- editing `generated\`
- adding Babylon semantics to PAL
- using explicit TypeScript `any`
- sampling normal/ORM textures as sRGB
- ignoring alpha mode, cutoff, culling, or draw order
- building while generation is still running
- treating the swapchain as readable
- changing thresholds, references, or scene inputs to hide a semantic bug
