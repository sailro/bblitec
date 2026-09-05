# Generic retained-UI fidelity: full-branch cleanup

Reviewed the complete integration and overnight fidelity work against
`origin/main`, including all working-tree and untracked implementation files.
The committed range was empty when reviewed. The simplify skill's reuse,
simplification, and efficiency reviews ran independently in three agents;
the primary agent reviewed altitude concurrently because the host allows
three child agents. All four reviews completed before cleanup edits began.

The prior review's applied changes remain in this branch. The 22 pinned
Antigravity Racer TypeScript files are source evidence, not cleanup targets.
No existing Racer source or host companion was edited. Shared compiler,
runtime, browser capture, and UI changes apply across scenes.

## Applied findings

- One bounded selector descriptor now drives host-UI validation, CSS emission,
  and native selector kinds. Legacy `classStyles` inputs normalize to generic
  style rules; public input compatibility remains intact.
- Backdrop-filter support detection is shared by audit and lowering, avoiding
  divergent accepted/degraded CSS classifications.
- Look-direction quaternion generation now lowers the pinned implementation
  and reuses its rotation-basis fold. Numerical fixtures compare ordinary,
  skewed, zero, parallel, and very large vectors with the pinned JavaScript.
- Native dispatch lists use copy-on-write membership snapshots. Unchanged
  frame dispatch no longer allocates a vector, while nested mutation preserves
  the already-selected callbacks and their shared mutable closure identity.
  A tombstoned DOM listener registry would change this behavior and was not used.
- Gamepad button handles are cached per connected instance. Axes are read live
  and their arrays replaced only on value changes, preserving retained old
  snapshots. Virtual-controller coverage includes stable indices, holes,
  reconnects, and retained handles after disconnection. The cache owns no SDL
  pointers and does not defer SDL state reads to the enumeration call.
- Dawn thin-pick bind groups are cached by uniform buffer, instance buffer,
  and bound byte range, then invalidated before either buffer is replaced,
  on mesh disposal, and before renderer-state resource destruction.
- Backdrop snapshots copy only their sampled region. Blur pipelines are lazy,
  triangle intersections use bounded stack scratch, and Gaussian kernels are
  cached by effective sigma rather than recomputed each frame.
- Gradient text caches candidate discovery and parsed animation parameters,
  avoids unchanged color writes and redundant layout updates, and still finds
  static `innerHTML` descendants without JavaScript bindings.
- Gradient shaders share one stop representation and a kind plus repetition
  flag. Text parsing reuses existing string/Unicode/color helpers.
- SDL frame/backdrop texture creation uses the existing shared backend helper;
  Dawn UI consumers share one texture/view/bind-group owner.
- CMake now honors the explicit RmlUi installation root even when a previous
  configuration cached another `RmlUi_DIR`. This prevents silently linking an
  unpatched font library while reporting the patched dependency directory.
- Follow-up reviews of the sweep repair consolidated SceneNode transform
  metadata into one typed descriptor. Reads, component writes, `.set` calls,
  and generated native dispatch use the same field names and precision rules.
  The bridge is emitted only when that capability is reached.
- SceneNode component writes dispatch once instead of rebuilding an entire
  vector through repeated variant reads. Live TransformNode writes preserve
  the existing GPU transform path, and whole imported-root vector writes
  traverse dependent meshes once rather than once per component.

The first sweep stopped during generation on Racer, Minecraft and Sandblox:
retained SceneNode unions lacked transform operations and optional-handle
narrowing was bypassed by `.set`. The shared compiler repair preserves
wide positions and casts float vector lanes explicitly. A native fixture also
covers variant identity, concrete writer dispatch and imported-root limits.
The follow-up quality reviews completed before this repair's cleanup began.

The second sweep compiled all sources and shaders, then exposed feature-trimmed
native builds and typed-array/storage-boundary cases. Repairs make the existing
SceneNode bridge respect concrete factory reachability, align SDL scratch
storage with shader consumers, and retain Dawn surface extents independently
of geometry-only matrices. Native vector/typed-array boundaries now preserve
copy and alias semantics; scalar reads no longer imply retained object aliases.
Closed-record storage and structurally equivalent native parameters choose
reference representation before member access is emitted. SceneNode scalar
writes use the existing property-setter path rather than temporary getter data.

The follow-up simplify reviews consolidated full-array fill into one range
implementation, removed redundant typed-array intermediates in native mesh
readback, made geometry matrices lazy, and cached storage-demand analysis by
coalesced native struct identity. Parameter type lookups are reused, and the
predicate's name now describes both parameter and return consumers. These
repairs add native `/W4 /WX` fixtures and focused compiler regressions; they do
not alter scene sources or relax validation thresholds.

The third sweep built 254 of 256 scenes. The remaining two exposed non-inline
definitions in the shared normalization header. Its record-length and
record-normalization functions now use the same existing inline-emission option
as the tuple normalizer. The numerical fixture links two translation units
including both generated math headers, covering this boundary directly. All
four follow-up quality angles found the repair minimal and required no cleanup;
both previously failing native scene builds pass independently.

The fourth sweep built all 256 scenes and exposed 11 SDL shader-stage failures
plus two UI parity regressions. Shader fragment-uniform reflection no longer
stands in for fragment-stage presence: reached shadow tasks explicitly mark
their variants, and color pipelines keep their fragment stage. Unicode default
emoji presentation and explicit VS15/VS16 select the proper color or text face;
the generated Unicode table records its ICU provenance. Per-glyph gradients
preserve word spaces with non-breaking spaces in their isolated inline boxes.
Focused Doom, Platformer, Bath Day, and Antigravity parity passes on both backends.

All four follow-up quality angles reviewed these repairs before cleanup. Dawn
now loads a custom fragment module only on its first color use; raw ordinary
text avoids escaped/normalized temporary strings; owned markup normalization
allocates expanded output only on its first change and skips ASCII decoding;
and the missing-emoji fallback reuses the already resolved symbol face.

The fifth sweep built all 256 scenes and passed 254 of 255 differential parity
cases. Sandblox exposed a stored-object identity error: reconstructing inferred
factory records at each sink lost replacement of a grown instance-color buffer.
Plain reference records now acquire their object home once, while compile-time
JSON metadata, classes, callbacks, and accessors retain their existing policies.
Runtime numeric-tuple predicates reuse the indexed observer loop with the same
short-circuit and callback-index semantics as arrays. Native executable fixtures
cover cross-owner buffer replacement and both tuple predicates.

The four follow-up quality reviews consolidated record eligibility/projection,
reused the canonical class registry and Promise-return normalization, flattened
collection adaptation, and eliminated intermediate field-box allocations before
whole-object storage. Fresh reference results move into their owning bindings.
Sandblox's full/foreground MAD returns to 0.110/0.116 on both backends, and its
independently enforced 0.001 canvas gates pass without changing scene sources.

The sixth sweep caught overly eager projection of scalar and opaque-resource
records: their generation metadata is still needed by object spread, enumeration,
and resource factories. Whole-object projection is now limited to records with
replaceable containers, using the existing mutable-container classifier and a
cycle-safe property walk. Scalar/resource records keep their established shared
field homes. A native regression preserves spread and enumeration across a
retained scalar record, alongside the buffer-replacement regression.

## Remaining design limitations

These are not hidden cleanup failures or relaxed parity gates:

1. Arbitrary canvas pane placement needs a primary-canvas retained handle and
   a shared CSS-layout-to-drawable geometry contract, including resize tests.
   Existing auxiliary UI rectangles alone cannot supply that mapping. The
   reached equal horizontal split remains supported.
2. Removing the recorded one-frame capture offset requires paired callback,
   upload, and capture traces and an aligned publication contract. Reordering
   render callbacks is not an equivalent structural cleanup.
3. SDL storage publication batching likewise needs a validated resource-order
   schedule for multi-scene/custom-shadow consumers before uploads or callbacks
   can move across graph boundaries.

The earlier quaternion, gamepad, callback snapshot, and Dawn pick-cache
deferrals are resolved by the implementations and regression fixtures above.

## Validation

The final full suite passes 1,560 tests with no failures or skips. The seventh
sweep passes all five stages, including all 256 native builds and 255
differential parity cases. Published status verification passes. The intentional
UI-only baseline movements, remaining visual residuals, and final executable
checks are documented in [the validation report](antigravity-validation.md).
Tests use hidden native fixtures and queued SDL input replay; none moves the
desktop cursor, types into other applications, or changes foreground focus.
The interactive executable remains an optimized Release without ASAN.
