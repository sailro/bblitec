# Fidelity strategy

Parity fails in two independent layers: TypeScript/Babylon semantics lowered
incorrectly, and correct Babylon shader semantics diverging on a native GPU
backend. `bblitec` records both rather than treating the screenshot as one
opaque score.

## Semantic contract

Every generated scene carries:

| Artifact | Holds |
| --- | --- |
| `manifest.json` | reached features, sources, assets, adaptations |
| `fidelity.json` | intentional source-to-native semantic differences |
| `upstream/provenance.json` | pinned modules and symbols |
| `upstream/feature-activation.json` | every activation unit, its reaching call site or asset, and the pinned module it mirrors |
| `upstream/renderer-fidelity.json` | shader bindings, formats, formulas, invariants |
| `upstream/shaders/composition.json` | the composed pinned modules deployed |
| `upstream/shaders/shader-material-reflection.json` | reached custom WGSL entry points, interfaces, uniform layouts |
| `upstream/shaders/*.wgsl` | reached custom material source before IR lowering |
| `upstream/shaders/*.native.wgsl` | the stages passed to Tint — custom and generated WGSL specialized for SDL bindings, locations and depth; pinned variants unchanged in the pin's scheme |
| `upstream/shaders/*.tint-reflection.txt` | Tint bindings checked against the native WGSL |
| `upstream/shaders/shader-compiler.json` | selected offline target and compiler hashes |

Recorded adaptations are semantic **divergences** only:

| Adaptation | What differs |
| --- | --- |
| `four-influence-skinning` | for an asset carrying `JOINTS_1`/`WEIGHTS_1` the pinned loader skins eight influences; the generated one keeps the first four and drops the tail weights |
| `plain-data-value-model` | a const local bound to a container element binds a native reference and is poisoned by a later structural mutation; mutable path-bound locals are copies that reject writes; object parameters pass by reference; sparse arrays zero-initialize; an index the compiler cannot prove in bounds reads or writes through a checked accessor that refuses by name at the access's source location where JavaScript would yield `undefined` (a proven index — static against a known length, or a canonical `i < arr.length` loop binding — keeps the raw fast path, and Array writes keep JavaScript growth) |
| `deterministic-seeded-random` | mulberry32 over seed 1, on the native runtime and the browser capture alike |
| `thin-instance-gpu-culling-omitted` | `enableThinInstanceGpuCulling` is accepted and recorded on the mesh, but no compute frustum culler runs and no indirect draw is issued: every ACTIVE instance is drawn, which is the pin's own fallback for a pool it cannot cull, so the pixels are the same and only the cost differs. The opt-in's second, load-bearing effect — marking the renderable `_direct` so it leaves the cached opaque bundle, which is what gives an application per-frame pool sync on a Standard material — needs nothing here, because this port records no bundles at all: both backends re-upload every live pool from the record's version and bind its buffers at the draw, every frame, culled or not. Recorded only where the opt-in can actually enable the culler: a statically-`false` call returns at the pin's own idempotence test, so it names no omission |
| `json-data-bridge` | `JSON.stringify` writes through codecs generated for exactly the records it reaches, in their declaration order, with a generation-known indent and no replacer; a property the source declared with `?` is omitted when absent, as an `undefined` member is. `JSON.parse` answers one dynamic document rather than a typed value: a missing or wrong-typed field reads as `undefined` so the source's own guards decide, and a malformed document throws where the browser's `SyntaxError` does. A record that reaches itself refuses at generation rather than recursing, where JavaScript throws on the circular structure at run time |
| `native-web-storage` | `localStorage` is a per-user file store under the host's own preference directory rather than per-origin browser storage: one injectively-named file per key, published through randomized exclusive staging and atomic replacement, with a bounded read. `getItem` still answers a nullable string and `setItem`/`removeItem` still throw where the browser throws its quota error, so the source's own arms are unchanged; what differs is the lifetime — the data outlives a browser profile and is not cleared with site data |
| `native-browser-file-bridge` | Browser save/open pickers settle asynchronously and an object URL is a browser-origin URL string. Native keeps only an opaque per-engine generation-checked object-URL token, synchronizes SDL3's portable asynchronous dialog behind the synchronous AOT call while pumping host events without dispatching application callbacks, and invokes a selected file input's stored `change` callback before `click()` returns. The observable order inside the callback is preserved — accepted bytes and display metadata are snapshotted under the PAL bound, the file list is populated first, and immediate `File.text().then(...)` runs from owned captures and shared mutable closure cells — while cancellation dispatches nothing and preserves the prior selection. Input/FileList/File handles share immutable selected snapshots, reclaim them after replacement/removal and the final retained handle, and enforce a 256 MiB per-engine live-byte cap. Dialog-selected paths never enter scene values; downloads use randomized exclusive staging and atomic replacement |

plus browser-wrapper erasure, immediate AOT `await`, compile-time asset
materialization, the SDL platform boundary and the native shader backends.
A new high-risk adaptation requires a record and a focused test.

Compile-time folds that are bit-identical by construction are deliberately
**not** recorded — the DDS harmonics from the pin's `computeSH`, Draco and
meshopt through the pin's decoder builds, quantized and sparse accessors
through its `preParse` hooks — because both sides read the same bytes. Two
freezes are stated here rather than per scene: the composed variant set is
closed at generation, so a run-time material change needing an uncomposed
variant refuses; and an asset carrying more punctual lights than `MAX_LIGHTS`
refuses where upstream grows the constant.

Voxel Sandbox adds two explicit boundaries. Its 43 source-owned tile PNGs are
drawn into one Canvas2D atlas by the browser path at load time; generation runs
that same bounded path and packages its exact RGBA result, recorded as
`fetched-canvas-atlas`. Its browser save/open pickers cross through the native
PAL: on Windows, Ctrl+S and Ctrl+O use the regular host dialogs with
`world.voxelsave.json` as the suggested name and preserve the same JSON
payload, recorded as `native-voxel-file-dialog`.

The generic browser-file boundary uses that same PAL dialog and atomic-file
mechanics without the voxel module's app-specific codec. Blob bytes remain
memory-only until a download is accepted; object URL slots clear on revoke and
advance their generation before reuse. File handles retain only an opaque
picker result for engine lifetime, so `File.text()` cannot be pointed at a
source-supplied path. The synchronous picker/callback ordering is the recorded
adaptation; payload bytes, cancel behavior, callback count, and failure arms are
the browser contract.

Curated inputs, thresholds and goldens are SHA-256-checked evidence, not
tuning knobs. Adding a scene or recapturing a reference is an explicit
operation.

Upstream's parity history is supporting evidence — the numbered scenes were
built as Lite-versus-Legacy differential tests, so the introduction PR and its
follow-up fixes classify a residual — but generated behaviour is derived from
the pinned source, never copied from an upstream workaround.

## Shader contract

Generated shaders preserve upstream markers for GGX distribution and Smith
geometry, BRDF LUT energy conservation, environment mip selection and RGBD
decoding, RGBE parsing, HDR cubemap projection, infinite-distance skybox
sampling, SH irradiance, exposure/tone mapping/gamma/contrast, depth, culling,
blending and multisample state, and GridMaterial's object-space derivatives,
major/minor lines, hard/cosine line paths, max-line composition and
transparent opacity.

### Where a shader comes from

One row transcribes; every other family composes, lifts or folds the pin's
own text. [status](status.md) carries the numbers.

| Family | Origin | Gate |
| --- | --- | --- |
| PBR colour and geometry variants | the pin's own composer, one fragment per renderable feature set | the whole corpus |
| Standard variants | the same composer, `variant-std-*` | 145, 273 |
| Shared material vertex stage | the one transcription: WGSL written in this repository (`src/shader-builtins-standard.ts`), its morph arm anchored to upstream markers | — |
| Ground, skybox | lifted from the pinned modules' string literals | 1, 8 |
| GridMaterial | the pinned template functions at the reached option set | 213 |
| Custom material | the entry file's WGSL through the typed shader IR | 159-163 |
| Frame-graph render task | `audit-shader-frame-graph`, a project-owned gate: alpha-card and circular-cutout materials keep their pipelines and uniforms when a task mirrors the scene | — |

Each composed variant carries the pin's own material UBO, mirrored field for
field with a `static_assert` per offset and filled by writers lowered from
`_writeMaterialData` and each extension's `writeUbo`. The transcribed PBR
fragment is deleted: a draw resolving no variant is an error naming its mesh
and material, never a fallback.

The layer helpers reach the deployed stages inside those fragments under the
pin's own names — `visibility_Kelemen`, `getR0RemappedForClearCoat`,
`ccSchlick`, `normalDistributionFunction_CharlieSheen`, `visibility_Ashikhmin`
and the `iri_*` thin-film stack with its `IRI_XYZ_TO_REC709` matrix. There is
no transcribed fallback, so a helper the pin renames or drops fails generation
rather than becoming a shading bias.

`assertArmsCovered` (`src/pinned-material-arms.ts`) is the cross-check: it runs
every glTF material through `_computePbrMaterialFeatures` and refuses a variant
set missing an arm one of them composes, naming both. That keeps a missed arm a
generation error rather than the small systematic bias it would render as.

The custom-material pipeline reflects uniform layout, binding order,
attributes, varyings, stages and entry points; PAL shader creation consumes the
reflected uniform-buffer counts. Pinned Tint emits the target-selected HLSL or
MSL, and register normalization plus DXC produce the SDL-compatible DXIL or
SPIR-V.

### Numeric width

One rule, in five places: **a value is held at the pin's own JavaScript-number
width, and each `static_cast<float>` is a store the pin performs.** Rounding
early is not a rounding-sized error.

- **Lanes.** A tuple element or static record property outlives the expression
  that filled it, so its width belongs to its sink: `castNumber` writes the
  folded static value at each sink's own width. Scene 206's box translations
  reached the double `MeshRecord::position` as `5000002.5` — the float32 ULP
  at five million is half a unit — measuring 0.828 against 0.000 written wide.
  A number in an ordinary expression position is consumed where it is written.
- **Camera scalars.** `alpha`, `beta`, `radius`, `target`, `position`, `fov`,
  `nearPlane` and `farPlane` are JavaScript numbers upstream, so `CameraRecord`
  keeps `double`/`Vec3d` and the chain reproduces the pinned stores in order:
  `camera_world_matrix`, `build_view_matrix`, `mat4PerspectiveLHToRef`,
  `mat4MultiplyInto`. `Math.PI / 2` has `cos = 6.1e-17` as a double and
  `-4.4e-8` as its float32 neighbour, which moves the view matrix's second row.
- **A spot cone.** The pinned factory computes `Math.cos(angle * 0.5)` in
  JavaScript numbers and only its light-UBO store rounds, so the native factory
  keeps the half-angle product double; rounding at the call boundary moves the
  hard `cosAngle >= cosHalfAngle` edge.
- **The procedural builders.** `create-sphere.ts`, `create-ground.ts` and
  `create-torus.ts` run the whole vertex chain in JavaScript numbers and round
  only at a `Float32Array` store; the emitted chain uses `pi_double` and builds
  each position from the unrounded normal. A float chain measures 0.004 with a
  33-byte peak against the pin's 0.002. The rule starts at the call site, since
  the pin halves a diameter before the chain rounds. `create-box.ts` and
  `create-plane.ts` need no care: their vertices are literals scaled by a
  halving, the last operation before the store.
- **Node TRS and world matrices** compose in double through the pinned
  `mat4ComposeInto` and matrix multiply, rounding once per component at the
  store, which makes native glTF instance matrices bit-identical to the
  browser's uploaded thin-instance buffers. Scene-code `mat4Identity` and
  `mat4Translation` are the neutral and translation-only specializations of
  that same compose path, rather than separate matrix arithmetic.

Two conversions are the pin's rule rather than C's: `Math.round` rounds halves
toward +Infinity (`bbl::js::round_js`), and `Math.hypot` is
implementation-approximated by the spec, so `bbl::js::hypot_js` is the plain
root of the sum of squares — recorded as `splat-hypot-approximation`. SCENE
code now takes that spelling too, where it used to emit `std::hypot`: the
contract is that any lowering reaching `Math.hypot` spells it one way, and
`<cmath>`'s two- or three-argument `hypot` has no spelling at all for the
four-argument call a quaternion length makes. The trade is real and worth
stating plainly — `std::hypot` is the overflow-safe scaled form and V8's is
too, so this moves scene code toward the LESS accurate of the two for the
sake of one spelling. It was measured rather than assumed: all nine affected
scenes and demos were rebuilt and re-measured against their committed
goldens, and every published number is unchanged, because the operands these
scenes hand it are nowhere near the range where scaling matters. Every
lowering in the tree now spells it that way: the CSM cascade fit's
light-direction normalize and the glTF camera lowerer's three decomposed
scale lanes were the last two to move, under the 1.27.0 bump's
differential sweep. The five
integer-valued one-argument `Math` functions fold at generation over a constant
argument, where the folded value and the emitted call agree exactly; the
transcendental ones deliberately do not, because V8 and a native maths library
need not.

**The RGBD decode's result type is the pin's storage type.**
`rgbd-decode.ts` decodes `.env` faces and the BRDF LUT into a
`texture_storage_2d<rgba16float, write>`, so a half *is* the result rather than
a packing step a caller may skip. Both backends upload halves on every path;
a float32 upload would carry more precision than the pin has.

### The reference pose

**A scene's pose can be a query string, and both sides read the same one.** A
corpus scene branching on `?seekTime=` reads `window.location.search`, and the
branch decides whether it animates at all. `parity.referenceSearch` is that
query: the reference page is navigated with it and the compiler folds the same
text, so `params.get`/`params.has` answer from the pin's own parser.
`reference/exact-corpus-manifest.json` records it beside the module digest,
because a navigation parameter is not module text and two goldens captured at
different poses would otherwise share a provenance.

A folded query value carries into ordinary arithmetic, because a module
constant is generation-known too. Scene 44 reads the step its capture is
pinned at as `Math.round(seconds * PHYSICS_FPS)` and scene 156 its elapsed
milliseconds as a subtraction against a module constant; both fold to a
literal rather than reaching the emitted program, and the emitted value is
the same IEEE-754 double either way. The constant is resolved through the
compiler's own static resolver, so one naming a handle or a factory call
still answers nothing and the expression stays where it was.

### Depth

**The reached slice renders under one convention, and it is the pin's.**
`render-target.ts` declares `REVERSE_DEPTH_COMPARE = "greater-equal"` and
`mat4PerspectiveLHToRef` maps `near -> 1`, `far -> 0`. Every family takes that
pair — PBR, Standard, node, shader materials, geometry tasks, background ground
and solid skybox — and both backends clear depth to zero, so the composed
view-projection equals the browser's uploaded matrix in all sixteen elements.

The compare is not typed here: `pinned-depth-state.ts` reads the pin's own
declaration and emits `upstream::pinned_depth_compare`, failing generation on a
spelling this runtime has no enumerator for — the contract
`pinned-blend-table.ts` holds for blend factors. The same module anchors the
projection half beside the clear value, shape-asserting the reverse-Z rows so a
remapped range fails by name rather than leaving consumers keyed to a far plane
of 0 stale.

Two arms name their own compare: shadow targets render standard-Z `less-equal`
(below), and a `ShaderMaterial` may pass `depthCompare` — unreached, and a
scene naming one refuses. `FragDepthBlock` composes *because* of the
convention: the block hands a graph `@builtin(frag_depth)`, so a renderer
ordering depth the other way would occlude by its inverse.

**A depth convention cannot move a coverage mask, but it can move a varying,
through the near-plane clipper.** A triangle straddling the eye plane gets new
vertices whose attributes interpolate from clip space, `z` included, so a
differing `z` row shifts the interpolated varying across the whole clipped
triangle. Scene 7's solid skybox is the case — its cube is centred on the eye —
and why `build_solid_skybox_scene_uniforms` builds its own view-projection
rather than binding the frame's: the pinned vertex stage offsets the cube by
the eye, and the clip row reaching its dither seed has to be exact.

### Shadows

**A caster that discards its own fragments moves the shadow edge, and that is
scene 140's whole residual.** It publishes 0.006 / 0.048 where scene 66 --
the same graph, the same `?freeze=1` pose, the same lights -- publishes
0.000017 / 0.000133. The difference is not diffuse: every hotspot sits on the
ground INSIDE the shadow, ringing the holes the caster's alpha discard
punches through the depth map. A discarded fragment moves the shadow's edge
by whatever fraction of a shadow texel the two rasterizations disagree on,
and the PCF kernel then spreads that disagreement over each hole's rim. 96.3%
of the region is exact, 99.8% is within five counts, and all of it is in
those rims; both backends measure the same number and differ from each other
by at most one count. Scene 66 has no discard, which is why it has no such
band -- the residual is what the feature costs, not what the port lost.

**A morph-target caster's bounds are computed live, and scene 140 does not
prove them.** `enableMorphTargetShadows` expands each caster's AABB by its
targets' weighted delta ranges every frame, which is the pin's own provider.
An A/B run by disabling the provider in the lowerer measured 0.006 / 0.047
against the shipped 0.006 / 0.048 -- so the expansion is not unobservable,
it is very slightly WORSE than not expanding at this pose. A difference that
small at a frozen weight says the expanded box barely moves the ortho fit,
not that it moves it correctly; the honest reading is that this gate
observes the feature compiling and running, and measures its arithmetic only
to about a thousandth of a MAD. A scene that animates a weight and depends
on the expansion is what would validate it, and none is registered.

The other half of the pin's provider is the refresh signal, and that one IS
reproduced: upstream the proxy mesh overrides `worldMatrixVersion` so a
weight change re-renders the shadow map, and this port sums the mesh's
`morph_weights_version` into the caster change signal for exactly the
generators that asked for the provider. Scene 140 cannot observe that either
-- it sets `forceRefreshEveryFrame`, which short-circuits the gate before the
version sum is read.

**A shadow map is the pin's one standard-Z target, and its bias reaches one of
two matrices.** `createShadowRenderTarget` names `dFormat: "depth32float"`,
`_depthCompare: "less-equal"` and `_depthClearValue: 1` at one sample, so a
caster pass is the one place this port clears depth to 1 and compares the other
way. The compare and the clear are *emitted* from that declaration
(`shadow_map_depth_compare`, `shadow_map_depth_clear`) for the reason the
`pinned_depth_state.hpp` pair they are the exception to is: a PAL constant
agrees with the pin only until it moves. The format and sample count are
checked rather than emitted, since both decide which texture a backend creates.

`renderPcfShadowMap` packs the *unbiased* view-projection into `sg._lightMatrix`
— what the receiver samples with — and hands `biasViewProjection`'s copy to the
shadow camera, which is what the caster renders through. Babylon's clip-space
linear bias (halved for WebGPU's [0, 1] range, added into each column's z row)
in both would shift the comparison twice, so the two stay apart on the record.
The light-space basis, the spot volume from `light.angle`, the 4x4 multiply and
the bias are each lowered from their own declarations, and the cone angle is
written wherever `cos_half_angle` is.

**CSM is the pin's own cascade array, and nothing about it is adapted.** The
source factory creates a `depth32float` depth-texture array, computes one
camera-frustum fit per cascade, and has receivers choose or blend by view
depth; this port creates the same array, renders one depth-only caster pass per
layer, and composes the pin's own receiver through
`csm-shadow-fragment-core.ts`. The split formula, float view-projection
inversion, clone-aware caster Z fit, texel snap, nine-tap filter,
cross-cascade blend and unbiased-receiver/biased-caster matrix split are all
source-derived, and `_computeCsmCascades` is **restated and anchored** — the
arithmetic is written in C++ and guarded against the pinned body by
expression-shape assertions on every formula it restates, by its statement
count (an added statement moves no shape, so the count is what refuses), and
by the two helpers the fit calls being taken from the pin rather than
restated: `buildLightViewMatrixInto`, the module's own copy of the light
basis, is lowered from its declaration, and `mat4InvertToRefOrIdentity` is
matched term for term against the lowered `mat4Invert` so the one inverse
serves both, with the identity the variant writes for a singular input
restated in its place. The sibling `computeDirectionalLightMatrix` is
lowered from its AST outright. The difference is not
cosmetic: a mirror can silently omit an arm where a lowering refuses one it
cannot express, and this one did. `_castersWorldAabbInto` opens with a
thin-instance branch — bound a caster by the union of its DRAWN instances,
because "one prototype-sized box wrecks the cascade Z-fit" — and only its
else-arm is implemented, so a thin-instanced CSM caster is refused by name
until that arm is lowered. The refusal is where the caster walk is, not at
generation: what makes it wrong is a thin-instanced mesh being *this
generator's caster*, and a caster list is a runtime array
(`setShadowTaskCasterMeshes` takes one, and racer spreads two into it). A
scene that merely reaches both features is fine — racer is exactly that
scene, with a cascaded sun over thin-instanced skid marks that are never
casters. The PCF and ESM fits are correct to have no such arm, because the
pinned function they mirror has none; CSM is the one family where the pin
does.

The array is **one** render target carrying `depth_layers = N`, with the layer
on the task rather than N targets each borrowing a layer: same GPU state — one
array texture, N single-layer attachment views, N clearing depth-only passes —
but one owner, so the pin's `_ownsDepthTexture: false` cannot become a double
free here. That flag is asserted at generation instead, so a pin that starts
owning the texture refuses rather than leaking.

The group-2 row for a cascaded light is reflected like every other, which is
what the type demanded: `texture_depth_2d_array` is its own binding kind, and
the row carries its own byte size because the CSM block is 320 bytes against
the single-map 96. On SDL_GPU `csmInfo_N` joins the demotable blocks, without
which the receiver exceeds the four-uniform cap. Scenes 214 (Standard
receiver) and 215 (PBR receiver) gate it, both at 0.000 on both backends, with
the composed receiver byte-identical to the browser's module and all eighty
floats of the cascade UBO bit-identical to its upload.

The upstream page says PBR renderables ignore CSM in v1. The pin disagrees —
`createPbrShadowFragment` dispatches to `pbr-csm-shadow-fragment` — and scene
215 is what measures which is true.

**A Standard or PBR receiver is a composed variant, not a uniform lane.**
`_computeMeshFeatures(mesh, receiveShadows)` turns `mesh.receiveShadows &&
hasSomeShadows` into `MSH_RECEIVE_SHADOWS`, and `rebuildSingle` splices
`createStdShadowFragment(slots)` after the vertex-colour fragment and before the
thin-instance one — so the varyings, the group-2 bindings and the nine-tap
comparison filter are named after each light's index in `scene.lights`. The
depth-only view of the same mesh drops the bit, because `rebuildSingle` derives
`receiveShadows` as `!shadowOutput && ...`.

A generation-known mesh closes to one receiver variant. A mesh reached through
a runtime handle collection has no stable scene-row identity, so composition
retains both variants and the assignment writes the live record lane used to
select between them. Imported meshes follow that dynamic route rather than
being silently excluded.

The node family follows the pin's other contract. `node-shadow.ts` continues
the graph's group-1 allocation with one reflected texture/sampler/info triple
per shadow light, while the live `meshU.receivesShadow` lane mixes the factor
per draw. For a PCF caster the pin recompiles the graph with
`NODE_NO_COLOR_OUTPUT`; `createNodeNoColorMaterialView` selects that module,
the PAL creates no colour target, and the graph's vertex and morph-storage
bindings still feed the standard-Z depth pass. Scene 66 gates the receiving
ground, the deformed caster and the empty-morph caster through this one path.

That group 2 costs SDL_GPU a uniform slot it does not have — scene, lights,
mesh and mat spend all four before `shadowInfo_N` arrives — so it takes the
geometry tasks' `gp` treatment: demoted to a read-only storage buffer for the
SDL-facing artifacts alone, while the `.native.wgsl` Dawn consumes keeps the
pin's uniform declaration. The layouts agree because every member is
16-byte-aligned, which is the argument that licenses the `gp` demotion too.

### Background

**The pinned dither reproduces on both backends, and which fragment carries it
is a pinned fork.** `WGSL_DITHER` seeds `fract(sin(dot(worldPosition.xy, k)) *
K)` on the interpolated world position, whose low bits follow the barycentrics,
so it reproduces only where the composed view-projection agrees with the pinned
engine bit for bit. On a scene whose background is otherwise flat it is the
whole residual: scene 6 attributes 0.314 to the background without it.

The fork is upstream's. `background-ground.ts` and `background-dds-skybox.ts`
prefix it behind their shared `enableNoise` (default `true`; scene 112 is the
one corpus scene that passes `false`), `background-solid-skybox.ts` prefixes
it unconditionally, and `background-hdr-skybox.ts` — the environment-cubemap
arm — composes none. So the ground has two generated fragments and the
skybox three, and a backend picks between them on the environment's own
`skybox_uses_environment` and `enable_noise` through one shared selector
rather than choosing per backend. Dithering the
environment arm puts ±1 on roughly half the background pixels of scenes 8 and
21: 0.129 to 0.343 and 0.330 to 0.537 full MAD.

**The DDS arm keeps the pin's vertex-stage ownership boundary.** Its cube
positions remain local, `mesh.world` carries the environment root position,
and the scene view-projection remains the other uniform. CPU-baking that
translation before the generic material vertex stage preserves the visible
geometry but changes the low interpolated `positionW` bits that the dither
hashes, producing an unrelated noise pattern over the whole sky. The pinned
DDS vertex body and both of its varyings are therefore lifted beside the
fragment and used by both PALs.

**Deferred environment sizing observes the live scene.** The pin first uses an
ArcRotate camera's nonzero `upperRadiusLimit` for both ground and skybox size;
otherwise it expands each mesh's local bounds through its current float32 world
matrix before taking the scene diagonal. Native preserves both branches,
including meshes and parent transforms created after environment loading, so
the cube size and root position feeding that same dither match the browser.

**The solid-colour skybox is a third arm with its own pair of stages, taken
from the pinned package rather than composed.** A scene loading an `.env`
environment that names no DDS or `.env` skybox and passes no `skipSkybox`
reaches `buildSolidSkyboxRenderable`: a cube shaded from the clear colour, the
dither unconditional, no image processing. Its vertex stage is the one arm that
is not root-positioned — `(mesh.world * vec4(pos, 0)) + scene.vEyePosition`
drops the world translation through `w = 0` and follows the camera, so the
dither seed is `pos + eye` rather than the DDS arm's `pos + rootPosition`. Both
stages ship as `?raw` literals with no source-map entry, so generation reads
them out of the packaged module and re-emits the pin's struct members and
statement bodies; only the `@group`/`@binding` declarations are re-addressed,
because SDL_GPU fixes vertex uniforms at space 1 and fragment at space 3 where
the pin binds WebGPU groups 0 and 1. The native mesh block is the pin's 96-byte
layout field for field.

**The background cube culls back faces; only the image skybox does not.** The
DDS, HDR and solid skyboxes build through `createDefaultPipelineDescriptor`,
whose `_cullMode` default is `"back"`; `skybox-cubemap.ts` passes `"none"`
explicitly, so `loadSkybox` keeps it. It is invisible from inside — each ray
meets one face and the near plane clips the rest — and from outside an unculled
cube rasterizes entry and exit faces, and since the skybox writes no depth the
later face in index order wins. The last two in that order are `+Y` and `-Y`,
so it renders a hard-edged quadrilateral of `-Y` over a `+Y` surround. No gated
pose reaches it; scene 14 at `cam.beta = 0.55` does.

### glTF material inputs

Clearcoat (`KHR_materials_clearcoat`), sheen (`KHR_materials_sheen`) and
iridescence (`KHR_materials_iridescence`) are metadata-driven PBR layers
selected by `extensionsUsed` and composed into each material's own variant. Their
per-material forks compose *different variants* rather than one fragment with a
uniform:

| Layer | Composition | Gate |
| --- | --- | --- |
| clearcoat | a GGX/Kelemen direct lobe plus a Jones analytical IBL lobe, attenuating the base by `1 - F(ccF0) * intensity`. The glTF loader disables the base-F0 remap, so intensity zero degenerates to the base composition; a scene-code coat keeps it | 28 (glTF), 19 (scene code) |
| sheen | the Charlie distribution with Ashikhmin visibility, sampling the BRDF LUT blue channel at sheen roughness and scaling the base by `1 - maxSheenColor * brdf.b` | 29 |
| iridescence | the thin-film airy summation in XYZ, blended into base F0 by intensity. An omitted intensity is the writer's default 1, not the loader's `iridescenceFactor ?? 0` | 178 (asset), 177 (`setPbrIridescence`) |

**Texture-less factors follow Babylon's factor-texture bake.**
`uploadBaseColorFactorTexture` and `uploadOrmFactorTexture` write factors into
1x1 8-bit texels (base colour through `linearToSrgbByte`, metallic/roughness as
linear bytes) and leave the shader uniforms at their defaults, so the browser
shades with the quantized values. Native mirrors each at its own precision
boundary: metallic/roughness quantize on the record (`round(f * 255) / 255` is
the unorm decode, so white fallback times quantized uniform is bit-equal to the
texel), while base colour bakes the pinned sRGB bytes into the fallback texel
with the uniform reverted to white — the hardware sRGB decode is the reference,
and a CPU transcription of the IEC formula measurably disagrees with the GPU's
table. Gated at texel level by scene 255. The record keeps the raw alpha.

**The base-colour slot's encoding is its texture's, not its family's.**
`loadTexture2D` picks `rgba8unorm-srgb` or `rgba8unorm` from its caller's
`srgb` option, and the format then lives on the `Texture2D`. Five cases share
one rule because the record carries that choice as a lane rather than assuming
an image is sRGB: the glTF loader passes true, the factor bake writes an sRGB
texel, a `createSolidTexture2D` texel is linear and sampled without decode, and
a scene decoding its own albedo (`setPbrGammaAlbedo`, whose extension
contributes `pow(rgb, 2.2)` and nothing else) loads the linear one. Scene 22
gates the linear-image arm, every glTF scene the sRGB one.

**An animated base colour factor inverts that bake.** `whiteFallback`
(`animation-pointer-basecolor.ts`) swaps the factor for `[1,1,1,1]` before
upload whenever a `KHR_animation_pointer` channel drives it and the material
has no base colour image, handing the real factor back as a UBO field for the
pointer writer to overwrite. Baking it as well would apply the factor twice
against the browser's uniform alone. Materials are built before animations are
read, so the answer is gathered in a pre-pass, as upstream gathers it. Gated by
scene 253.

**Environment horizon occlusion applies only to normal-mapped materials**: the
pinned `ibl-fragment` composes `eho = 1.0` without a normal map, and each
variant carries whichever arm its features produce, so the factor follows the
material by construction. Applying the polynomial unconditionally darkens
scene 247's silhouette speculars by one MSAA sample step.

**Every texture slot samples the UV set its own `textureInfo` names.**
`assemblePbrPropsExt` folds the six into one `_uv2Mask` — base colour 1, ORM 2,
normal 4, emissive 8, spec-gloss 16, occlusion 32 — and `createPbrTemplateExt`
decodes it into the fragment's own `input.uv`/`input.uv2` reads, gated on the
mesh carrying TEXCOORD_1. Generation executes both, so the selection is the
pin's and is composed into the stage rather than uploaded: the loader carries
no texCoord for the five slots a UV set alone resolves.
`KHR_texture_transform.texCoord` overrides the slot's own. A `texCoord` of 2 or
more needs nothing, since `wrapTexCoord` stamps only 1 and both sides sample
UV0.

Occlusion is the slot a UV set cannot resolve alone, and follows
`buildDefaultPbrTexturesExt` arm for arm:

| Asset shape | What binds |
| --- | --- |
| TEXCOORD_1 occlusion, no metallic-roughness image | the factor-driven ORM slot stays; the image binds through a dedicated uv2 pair (`occlusionOverride` replaces the ORM red channel) |
| TEXCOORD_0 occlusion, no metallic-roughness image | the occlusion image becomes the ORM texture at the *occlusion* slot's transform, metallic and roughness reverting to 1.0 |
| beside a metallic-roughness texture sharing its image | a second carrier whenever the two can be sampled apart — the uv2 pair, or `occlusionNeedsSplit` (a distinct texture object or its own transform) sampling `ormTexture` again at `occlUV` |

The record therefore carries `occlusion_transform` apart from `orm_transform`;
they agree wherever a material gives both slots the same transform, which is
every corpus material reaching them. Two shapes stay refused because upstream
renders them no better: distinct occlusion and metallic-roughness *images*
composite on a canvas upstream, and occlusion on TEXCOORD_1 naming the **same
texture object** as metallic-roughness sets mask bit 32 while building no
carrier, so the fragment declares a binding with no texture behind it — a
WebGPU validation failure. Occlusion is also the one slot refusing a `texCoord`
of 2 or more rather than mirroring it: `assemblePbrPropsExt` records the value
while `wrapTexCoord` leaves the bit clear, so upstream shades from a factor
texel. Gated by scene 243 (uv2 pair), scene 29 (orm-unpack split) and the
glTF UV-sets gate (all seven arms).

A scene-code material has no separate occlusion image and samples `orm.r` when
its resolved `occlusionStrength` is nonzero: `_computePbrMaterialFeatures` owns
the `(mat.occlusionStrength ?? 1) > 0` gate, and generation carries the option
into both the pinned feature input and the native record. The glTF
`_occlusionImage ? 1 : 0` rule belongs to the loader's input builder and does
not reach scene code. The pin's internal `_metallicF0Factor` stays distinct
from the public `reflectance`: a reached non-default writes both
`metallic_f0_factor` and the writer's fallback `specular_weight`, but stays
dormant in composition until `setPbrMetallicReflectance` registers the
reflectance extension. Registration is process-global in the pin, so even an
empty setter call makes a non-default creation-time F0 on another material
participate — likewise when the registering call came from a previously loaded
glTF dielectric. Repeated setter calls accumulate their conditionally supplied
fields exactly as the pinned material object does.

**A scene's `setPbr*` options reach composition through the pin's own
setters**, the way the loader half already runs `setPbrEmissive`: each stamps
its props under the field name its extension's `detect` reads, so the composed
arm set follows from the pinned setter rather than a field name restated here.
That is what an extension arm depends on — the emissive layer composes on the
presence of `_emissiveColor` alone, carrying no texture and no capability
define. Computed channels therefore use a finite witness only while the pin
derives the arm; the generated runtime setter stores the real values.

**`KHR_materials_variants` folds to the one selection a scene makes.**
`selectVariant` restores every original material then applies the chosen
variant's mapped entries, so one static selection ends at a per-primitive
material index, which generation resolves and the loader applies. The pin's
run-time variant table has no reached mutation to serve, so every shape the
fold cannot represent refuses: `getVariantNames` and `resetVariant` are
unlowered, a second differing selection or a selection on a second asset is
refused (one name is compiled in for the whole scene), and one made from a
frame callback would fold a per-frame reassignment into frame zero. An asset
carrying the extension that no scene selects on renders identically, because
the pin reassigns nothing until `selectVariant` runs. Gated by scene 27.

### Animation

A glTF file's animations are one group each, carrying the name, duration and
frame rate `animation-group.ts` gives them; upstream starts only the first
(`isPlaying: clipIndex === 0`), each looping over its own length. Two
consequences are not guessable from the file: a **stopped group writes nothing
at all** — `tickAnimationCore` returns early, so holding its channels at time
zero would overwrite a playing clip's value on a shared target — and **a seek
reaches only groups that are not stopped**, for the same early return.

**A container's entities are the pin's entity walk, and nothing else.**
`addToScene(scene, container)` recurses over `container.entities`, then does
four more things to the container: pushes the file's animation groups onto
`scene.animationGroups`, appends the per-frame tick that advances them, takes
the file's camera when the scene has none, and takes its clear colour. A scene
iterating `entities` reaches only the first half — which is the point, because
those scenes drive the same clips from an `AnimationManager` of their own and a
scene tick would double-advance them. Only static `entities[0]` on a glTF
container lowers, as an opaque imported-root identity, because the pin
guarantees the synthetic transform root at index zero; a dynamic or nonzero
index and every `.babylon` container refuse rather than conflating one root
with the complete walk.

**A manager owns animation time for the groups attached to it, and the measured
seek has to reach it.** Upstream has no seek: the harness writes `currentTime`
on each named group and pauses it, and whoever drives the group applies the
pose on its next tick. Native mirrors the shape rather than the call — a scene
registering with an engine contributes one seeker per manager it created,
beside the seeker each loaded asset already carries.

**A baked mesh gets a seeker of its own, for the same reason a manager does.**
`bakeVat` freezes a mesh's animation into a texture and `attachVat` drops its
live skeleton, so from then on the mesh's pose is a row index rather than a
palette, and nothing in the pinned animation path reaches it. Upstream a
scene picks that row itself, per frame, through `handle.play`/`handle.update`
or a direct `setInstances` write. Scenes 218 and 219 do exactly that from
`?seekTime=`, and they are captured after their own tenth frame so the
emitted callback -- not the harness -- performs the write on both sides.
`seek_vat` is this port's addition beside it: a scene whose registered pose
is a folded query value reaches the baked row without waiting on a clock, the
same adaptation the manager seeker above makes for animation groups. It is
project-owned rather than lowered, and the row arithmetic it performs is the
pin's own -- `clipFrameCount`'s formula and its frame rate are both asserted
at generation, so an upstream change to either fails rather than shifting
every baked pose by a frame.

**A property path is a lane plus a component, because that is what the pinned
walk produces.** `resolvePropertyBinding` splits the dotted path, walks to an
owner and a final property name, and `createPropertyWriter` then stores either
the whole value — through the value's own `set` — or the one number the last
part named. So which paths exist follows from which properties the bound
object has, not from a list: this port enumerates the record LANES its own
mesh and camera records hold (`position`, `scaling`, `rotationQuaternion`,
`alpha`) and derives from each the path that names the lane plus one per
component in the pin's own `"xyzw"` order. A lane of one component offers no
component path for the same reason `alpha.x` throws upstream — the walk
reaches a number and `asRecord` refuses it — and a path of more than two parts
finds no lane to land on. `regression-property-animation-paths` gates the
component half.

**A component of a rotation quaternion is lerped, and what it composes is not
a unit quaternion.** `evaluateSampler` slerps on the track's own `quaternion`
flag, which `createPropertyAnimationClip` sets from the path that names the
quaternion itself — so a track on `rotationQuaternion.y` interpolates one
number like any other. `mat4ComposeInto` then builds its basis from the four
components with no normalization at all, which makes the composed matrix a
rotation carrying the quaternion's squared norm. This port's CPU vertex bake
takes that basis directly (`rotate_quaternion`, `pal_gpu_shared.hpp`); a
normalized rotation agrees with it for every unit quaternion, which is why
the divergence only appeared once a component path could write a non-unit one.
An explicit `quaternion: true` on a track the path does not already make one
refuses at generation, because the pinned slerp would then read four
components out of a narrower key.

**The weighted property mixer buckets by the pair the pinned binding resolved.**
`resolvePropertyBinding` returns the object a dotted path landed on and the
final property name, and the mixer keys its accumulator on that pair — so
`position` and `position.x` are different buckets on one mesh, the first
keyed on the mesh and the second on its position vector. The native bucket is
the (target, lane, component) triple those resolve to, which also makes the
pin's mismatched-arity throw unreachable here: the width follows from the
triple. Weights are
summed and never normalized, which is upstream's stated choice: two groups at
0.25 and 0.75 write the weighted sum, and a single group at 0.5 writes half its
own value.

**The weighted glTF mixer is the same shape one level down, and its
partial-weight rotation blends against the rest pose.** Translation and scale
accumulate as weighted sums, zeroed on the first write to a node so the rest
pose is replaced rather than added to; rotations accumulate by incremental
slerp at `weight / (accumulated + weight)`, which makes the result independent
of clip order. A node whose weights sum below one slerps from its rest rotation
toward the accumulated one by that sum; at or above one it is renormalized. The
pose that follows is the same pass a single-clip tick runs.

**A cross-fade changes weights before mixing and does not choose a mixer.**
The manager's pre-update first preserves any hook it already owned, then
advances each fade by the non-negative delta, writes the two interpolated
weights, and erases completed jobs. Starting another fade removes every older
job touching either group before appending the replacement. Property and glTF
groups use the same job shape, and no call turns either weighted mixer on; the
scene must make that choice explicitly. Scene 156 measures the 250 ms point of
a one-second fade as weights 0.75 and 0.25 through its own `?seekTime=1.25`
branch.

**A group's `speedRatio` scales the future, not the past.** Upstream
accumulates `time += (deltaMs / 1000) * speedRatio`, so a write moves what
follows and leaves the pose already reached alone. The scene's master-clock
fan-out derives a clip time rather than accumulating one, so the writer
re-anchors: it records the clip time and the master clock at the write, and the
derived time is that base plus the scaled span since. At the default ratio with
no write this is the elapsed clock it always was. A **seek** is the deliberate
exception — the harness pins a pose by writing `currentTime`, which no ratio
scales — so the native seek takes the clock as the clip time and leaves the
ratio to the tick. No seek-pinned gate can therefore observe a ratio.

**An `AnimationGroupMask` resolves at the write, where the pin resolves it
lazily.** `animationGroupMaskRetainsTarget` retains a name when listing it and
including agree, and `resolveAnimationMask` turns that into a per-node skip
flag; the generated writer runs the same rule over the asset's own node names.
A masked channel is skipped and the node keeps the rest TRS the controller
resets to, which the generated pose pass restores for masked nodes alone since
every other animated node is overwritten by its own track. The names and mode
fold because they are constants in every reachable shape — the pin's
re-resolution exists to notice a `names` array that moves, which a compiled
scene cannot do. `group.mask` refuses anything but a
`createAnimationGroupMask` value, and a mode outside the enum fails by name.

`goToFrame`'s third argument is the pin's `engine`, and its only effect is the
guard `engine || !group._stopped || !group._gltfMixer`: a glTF group always
carries the mixer, so what is left is that a stopped group is posed when the
caller passed an engine and skipped when it did not. The native call takes that
as a boolean.

**The pose before the first tick is the file's REST hierarchy, not the first
clip at time zero.** `gltf-feature-skeleton.ts` seeds each skin's bone texture
with `computeBoneTextureData`, which composes `invMeshWorld * jointWorld * IBM`
over the authored node TRS, and nothing evaluates a channel until a tick runs.
This port therefore runs its pose pass alone at load -- the node TRS there is
still the authored one -- rather than evaluating clip zero. The two agree for
every scene whose clips tick, because the first tick overwrites the seed; they
part for a scene that never ticks, which is what an entity-by-entity
`addToScene` produces (the pin appends the tick to the container, and the
entity walk reaches only the first half of `addToScene`). Measured on scene
99's Xbot: 0.816 full MAD against the browser with the channel evaluation and
0.000 without it.

**A bone override is applied in two phases, and this slice reaches the second
alone.** `applyOverridesToTRS` writes the translation, rotation and scale bits
into the working pose *before* channel evaluation, so a clip that animates the
same bone wins; it writes the hidden bit *after* it, which is what keeps
`setBoneVisible` in force on a rig that bakes a constant scale track onto every
bone. `setBoneVisible` is the one lowered mutator, so no override this port can
build carries a transform bit — the emitted bake applies the hidden phase only,
and `BoneOverride` carries the mask without the lanes the refused setters would
fill. The bake takes a working pose of its own rather than walking the live node
TRS, exactly as `skeleton-pose.ts` exists apart from `skeleton-updater.ts`
upstream: it writes palettes and nothing else, as `writeBoneTextures` does, and
it answers with no animation running. The hidden bit, the pin's own bake order,
`setBoneVisible`'s two arms, the first-name-wins map, the per-node skin grouping
and the unnamed-joint fallback are each read from the declaration that states
them (`src/lowering/gltf/bone-control.ts`), because the two copies of the pose
math agree only while those do.

Writing palettes alone leaves one quantity behind, and it is unobservable: a
primitive with no authored normals carries CPU face normals the pose pass
recomputes (this port's own fold, [architecture](architecture.md#animation-and-deformation)),
and a bake does not. The vertices a hide moves are exactly those weighted to the
collapsed sub-tree, whose triangles degenerate to a point, so the normals that
go stale belong to triangles that cover no pixel; every other vertex keeps the
pose the seed gave it.

Reaching the feature at `enableBoneControl` is the pin's own boundary -- it
installs the builder hook, so only the loads after it carry skeletons. One
generated loader serves every load here, so an asset loaded before the enable
would get skeletons this port cannot withhold from it, and that order refuses
rather than building them quietly. Gated by scene 99.

**How large a skin stays on the GPU follows its palette's transport.** A mesh
whose palette rides the pinned per-bone texture leaves the uniform array's bone
lanes at the identity, because the stage that would read them is not the stage
drawing it. [Architecture](architecture.md#animation-and-deformation) carries
the two transports and the refusal between them.
### Transmission and draw order

Transmission uses an opaque scene-color copy, dielectric Fresnel
`((ior-1)/(ior+1))²`, and Beer-Lambert volume attenuation
`exp(log(color)/distance*thickness)`. Scenes 30, 33, 176, and 212 gate the
dependency chain. With 4x
MSAA, PAL resolves and stores the opaque color attachment for the copy, then
reloads the preserved multisample color and depth attachments before
transmissive draws resume.
`KHR_materials_dispersion` reuses that path and splits the refracted ray into
per-RGB indices with Babylon's `spread = 0.04 * (20/dispersion) * (ior-1)`;
Scene 212 gates it.

The generated material records preserve Babylon's distinction between volume
attenuation, thickness-based refraction depth, and glTF-only IOR-to-F0
mapping; direct `createPbrMaterial` refraction options do not implicitly enable
the glTF dielectric adaptations.
The scene-color source is RGBA16F and remains linear through opaque and
transmissive draws; exposure, tone mapping, gamma, and contrast run once in a
final full-screen pass. The scene-color grab is sampled through the pinned
repeat-addressing trilinear sampler, so refracted UVs outside the screen wrap
exactly as upstream's `getTrilinearAnisotropicSampler` does.
This final pass runs the pin's own shape on both backends: pinned Babylon
Lite keeps the transmission target multisampled to the end and applies image
processing per MSAA sample before averaging (`image-processing-task.ts`
samples `texture_multisampled_2d` and divides after the `ip()` loop). The
fragment is lifted at generation from that task's own literals and both
backends execute it: Dawn compiles it at startup like every other stage, and
SDL_GPU binds the multisampled colour
attachment for sampling through the vendored SDL patch
(`native/vcpkg-overlay-ports/sdl3`, SDL#15838) and runs the same per-sample
fragment at 4x; the resolved-pixel single-sample fragment remains only as the
`BBLITE_MSAA=1` and stock-SDL fallback. The remaining backend split on
transmission scenes is the scene-colour *grab*: SDL_GPU resolves and copies
the opaque colour into the refraction texture where the pin reads the
multisampled attachment directly.
Punctual glTF point lights use inverse-square falloff for the primary and
additional generated light paths. Their diffuse and specular sums remain
separate through transmission and transparent-alpha composition, and
transmissive materials retain their authored alpha/depth state while moving
after the scene-color grab.

Draw order is the pin's own. Opaque draws keep the pinned append order:
every renderable module stamps one shared `renderOrder`, so the pinned
stable sort is the identity on the emitted list, and generation refuses the
moment the stamps disagree. Transparent draws sort by the pinned view-space
depth of each mesh's world translation, lowered from
`sortTransparentBindings`' own distance assignment and comparator.

### Environment and background

Requested generated grounds render by default. Their mesh is translated to the
computed scene root while Babylon Lite's fade calculation deliberately keeps
`backgroundCenter` at the world origin; Scenes 1, 6, 13, and 14 gate that
distinction. Requested DDS skyboxes use Babylon's finite root-positioned cube
and normal scene view-projection. Which skybox a scene gets is decided at
generation from the two URLs and the pinned `skipSkybox` flag, exactly as
`load-env.ts`'s deferred builder decides it: a `.dds` URL takes the DDS arm, a
URL naming the `.env` itself takes the environment cubemap, and a scene naming
neither and skipping neither gets the solid-colour cube. Grounds and
DDS/HDR/solid-colour skyboxes can be disabled independently with
`BBLITE_GROUND=0` and `BBLITE_BACKGROUND=0`.

Embedded image-based lights evaluate SH unclamped. Environment rotation
affects SH and cubemap lookup directions, while horizon occlusion
intentionally uses the unrotated reflection vector.

### Deformation and instancing

glTF animation uses pinned LINEAR quaternion interpolation and deterministic
time seeking, plus CUBICSPLINE quaternion/translation interpolation where
reached, and STEP on every channel the loader carries. STEP has no arithmetic
to lower — it selects one stored key and copies it — so what is pinned is the
key it selects: `evaluateSampler` takes the later key once the time reaches
its own (`t >= t1 ? idx + 1 : idx`) and the earlier one inside the span, and
generation asserts that selection against the pin's own branch rather than
restating it. `track_key_at` already returns exactly those two keys, so the
generated `sample_step_*` arm is a choice between its own pair.

Morph position/normal deltas are applied before recursive skinning;
generated joint palettes and morph weights drive the deformation stage.
Every morphed mesh uses Babylon's pinned uncapped storage-buffer path
(`morph-fragment-core.ts`) — the pin's one morph mechanism, compiled in for
any morph target at all: a flat 6-float delta buffer and a weights
buffer with the 16-byte `{count, vertexCount}` header, accumulated in
ascending target order before skinning, with source-marker assertions
pinning the loop, indexing, and header ABI. Scene 243 gates it.
A node material's `MorphTargetsBlock` validates the same two reflected names
and their pin-allocated binding numbers rather than guessing slots from WGSL.
SDL resolves the sidecar names and Dawn consumes the emitted numbers, both to
the same per-mesh buffers. A node graph on a mesh without morph data receives
the pin's zero-count fallback buffers; Scene 64 gates the live storage pair at
a frozen weight of one.
Primitives without source normals remain deindexed, and their face normals
are recomputed after deformation while their positions stay GPU-skinned. See
[Architecture](architecture.md#animation-and-deformation) for layout,
specialization, and why that normal cannot come from a vertex stage.
Static `EXT_mesh_gpu_instancing` preserves Babylon Lite's split transform
contract: extension matrices remain local T/R/S data and the node world matrix
is applied separately in the vertex shader.

**A thin-instance stream is uploaded unoffset, so the whole floating-origin
subtraction stays on `mesh.world`.** `thin-instance-gpu.ts` packs the
per-instance matrices through the precision-only `packMat4IntoF32`, never
`packMat4IntoF32WithOffset` — the pin composes `finalWorld = mesh.world *
instanceWorld` and the large coordinate lives entirely in the first factor,
so subtracting per instance as well would bias the translation twice. The
large-world page lists "thin-instance per-instance world matrices" among its
wired bakes, which reads the other way; the source decides, and scene 204's
own comment says the same thing the source does. `instance_parent_draw_world`
is where this port states it: with the mode off the parent world is composed
by `build_instance_parent_world` and the clone offset added after it, and
with the mode on the recorded parent alone is handed to
`mesh_world_eye_relative`, which composes the record's TRS once and subtracts
the eye in double before the single float store. Composing the TRS in both
would apply it twice.

**A coloured thin-instance pool composes the material family's own colour
slot.** `_computeMeshFeatures` sets `MSH_HAS_INSTANCE_COLOR` from
`mesh.thinInstances.colors`, so the bit rides the pool bit and arrives with
the same call; `createThinInstanceFragment(hasInstanceColor)` then declares
the `instanceColor` attribute and the `vInstanceColor` varying. What
PBR reads next is the shared fragment's base-colour slot. What Standard's
`rebuildSingle` does instead is that family's alone: it spreads that
fragment into a copy whose only slot is a `BC` one — "Standard applies
instance color to final color (BC), not to baseColor (AT) like PBR", as its
own comment says — so the base-colour slot the shared fragment carries never
reaches a Standard variant. That rewrite lives inline in the renderable
rather than in a named export, so the slot text is lifted from the pinned
declaration: a pin that moves it, drops it or renames it fails generation
instead of composing a fragment whose instance colour silently stops
applying. PBR's runtime product contains plain, thin-instance, and the nested
thin-instance-plus-colour masks, never the impossible colour-only word. The
colour lane is its own instance-stepped buffer, which both backends bind from
the same predicate used to select either family's composed variant.

**Which of those lanes a scene-local ShaderMaterial takes is the mesh's
decision, settled after the whole entry is compiled.** The pin's `hasColor`
is `!!ti.colors && material._tic != 0`, and the material-side `_tic` opt-out
key is refused, so the mesh decides outright — a fact that cannot be settled
where the material is created, which precedes both its assignment and its
instances, so the `world0..3` and `instanceColor` lanes are resolved from
the material-to-mesh pairs recorded on the way through, in either source
order. Upstream builds one pipeline per renderable and keys it on exactly
those lanes, so a material can be instanced on one mesh and plain on
another; this port bakes one variant into the material record instead,
which is why meshes that disagree on a lane refuse
([features](features.md#scene-hierarchy)).

**Where that lane sits is the pin's, and it is taken rather than
restated** -- for the Standard and PBR families, whose fragment declares it.
The scene-local ShaderMaterial family is the exception: the pin appends its
lanes at `material.attributes.length` in a prelude string, and this port
declares them at the fixed 16-20 the line family already uses. Nothing
observable rides the numbers, because the port synthesizes the whole
`VertexInput` there rather than splicing the pin's prelude — it is why the
device asks for 21 vertex attributes where the pin asks for far fewer.
`createThinInstanceFragment` declares each attribute's
`_bufferGroup`, `_arrayStride`, `_stepMode` and `_offset` -- `ti-matrix` at
stride 64 for the four world columns, `ti-color` at 16 for the RGBA lane --
while the composed WGSL keeps only the location, the name and the type. So
the layout half never reaches a variant's reflected attribute row, and both
PALs would otherwise type it out. `pinnedInstanceAttributes` EXECUTES that
factory -- the same call both compositions already make -- and emits its rows
as `pinned_instance_attributes`, which `pinned_vertex_input` and
`vertex_stream_stride` read. A moved stride or a shifted offset therefore
moves both backends without either restating it, and a lane that stopped
being a per-instance float4 fails generation by name.

The group NAMES are the pin's too, and are emitted beside the rows as
`pinned_instance_groups`. What stays each backend's is only which SLOT a
group binds at -- the pin assigns none -- stated once in
`vertex_stream_group` and proved against the pin by three `static_assert`s:
a renamed group leaves its stride lookup at zero and a third group leaves
the list longer than the two streams a backend declares, so either one stops
the build rather than binding the wrong buffer at the right slot. Scene 204
gates the rendering half.
The project-owned `regression-track-clamp` gate is pixel-exact at 3 seconds
and verifies that shorter translation, rotation, and morph-weight channels
hold their final values while a separate channel determines the animation
duration.
Skin deformation applied without an animation array diverges from the pinned
Babylon Lite output, so that shape is unsupported: reaching it would require
an explicit fidelity adaptation rather than an ordinary fix.

Pinned property animations compile static clips and groups into typed native
records. LINEAR scalar/vector interpolation, quaternion slerp, STEP holds,
frame/time ranges, looping, speed ratios, and deterministic group seeking are
generated from the reached Babylon Lite APIs.

Direct `createMorphTargets` accepts one position target, nullable normal
deltas, one initial weight, and one mesh attachment. It rides the same
pinned storage-buffer morph path as glTF. `createSphereData` and the rendered
sphere consume the same arrays produced by an AST lowering of the pinned
`createSphereData` body, so procedural delta functions consume exactly the
base positions the renderer draws. The ground and torus builders use that
same translation path for their pinned typed-array bodies. JavaScript-number
locals remain doubles, `Math.sin`/`Math.cos` remain double calls, and each
`static_cast<float>` or `static_cast<std::uint32_t>` is emitted only at the
corresponding `F32` or `U32` indexed store. A structural gate derives the
`F32` store count from each pinned function and requires it to match every
emitted float narrowing. Scene 23 measures the sphere chain under a
mirror-metal anisotropic material, Scene 15 gates ground, and Scene 162 gates
torus on both native backends. Scene 252 remains the StandardMaterial morph
contract gate.

Scene 151 gates directional-plus-hemispheric Standard lighting; the
light-count boundary is in [features](features.md#lights).

### Scene hierarchy

**A mesh's world is the pin's own composition, and its parent is a matrix
product.** `composeTrsLocalMatrix` builds a node's local matrix and
`createWorldMatrixState` resolves its world as `parent.worldMatrix * local`;
both are lowered from their own declarations. The PAL does not re-derive
rotation or compose a child transform independently; negative scale above a
rotation remains part of the parent matrix product.

**The pin transforms a normal by the plain world basis.** `pbr-template.ts`
writes `(finalWorld * vec4<f32>(normalize(normal), 0.0)).xyz` and
`standard-template.ts` the `mat3x3` of the same three columns; neither
divides by the scale, so neither applies an inverse transpose. A port that
divided agreed for a uniform scale, and for a normal that lines up with a
scaling axis — which is every non-uniformly scaled scene-code mesh the
corpus draws, all of them boxes. Scene 270 is where the two part.

**A parent's move is pushed at the setter, because that is where the pin
pushes it.** `createWorldMatrixState` carries a version snapshot, but its
own header says that path is the *foreign*-parent fallback: every
in-engine host is tagged, and a tagged hierarchy invalidates by
`markLocalDirty` → `invalidate()` recursing into the children the parent
setter registered. So the port registers a child at `mesh.parent = node` —
the pin's `_addChild` trigger, not `children.push`, which upstream may
never be called — and each of the node's TRS setters bumps the transform
version of every mesh beneath it. That is the same version every re-bake
already keys on, and it is the shape
`set_asset_root_position_component` was already written in.

**`setParent` preserves world TRS rather than reinterpreting it as local.**
The child world is captured before graph membership changes; attachment
derives the new local as `inverse(parentWorld) * childWorld` through the
pin's `mat4Invert`, `mat4Multiply` and full `mat4Decompose` in that order,
while detachment decomposes the captured world directly. The decomposition's
negative determinant remains a negative Y scale, and a singular parent keeps
the new link but copies only world position, exactly as the pinned fallback
documents. Reparenting a matrix-declared node clears its captured raw matrix
so the decomposed TRS takes authority. Public `children` and private dirty
registries change only when the link changes, and a later parent-only TRS
write recursively invalidates every world-baked descendant. Flattened asset
roots apply the same operation to their rendered leaves, and recursive
imported-node lookup uses each glTF scene-node name while it walks the
loader-built `children` hierarchy. Scene 269 gates those paths together with
the procedural PBR winding transition.

**The mirrored-mesh watcher is scene state, not a frame-loop step.**
`installMirroredMeshSupport` seeds the signs its renderables are about to
be built with and then pushes its watcher onto `scene._beforeRender`. The
generated opt-in does both, so the two backends contain no mirrored-mesh
code at all and the frame position — after this frame's callbacks, before
the rebuild it can raise — follows from where the callback sits rather
than from a comment in each loop saying the other one matches.

**Mirrored winding is an opt-in, and the two families reach it
differently.** `std-mirrored-support.ts` installs a Standard primitive
resolver precisely because that family has no winding of its own, plus a
per-scene watcher that rebuilds when a determinant sign flips. This port
composes the Standard clockwise pipeline arms under the same opt-in and
runs the watcher in the frame position the pin gives it — after the
frame's callbacks, before the swap queue drains, which here means the
render plan, since a front face is chosen when a pipeline is. The PBR
loader rewinds a single-sided imported primitive's indices and stamps the
result as the watcher's authored baseline, so the live determinant does not
reverse imported winding a second time. A procedural PBR mesh has no loader
pass; if it crosses the determinant sign boundary at run time, the same
watcher rebuild selects a back-culled pipeline with the opposite front face.
A mesh mirrored before its renderable is built simply carries that winding
from the first frame.
Scene 269 gates that PBR transition, while scene 270 gates the Standard arms.

**A bare `visible` write takes effect when the draw list is rebuilt, not on
the next frame -- and that is the pin's rule, not a shortfall.**
`scene/visibility.ts` is the sole place that bumps the module-scoped
visibility epoch, and its own header says a bare `node.visible = ...` field
write deliberately does NOT, so the hot write path stays a plain assignment
and bundle invalidation stays O(1). The pin's renderables test
`mesh.visible === false` inside `draw`, which for an opaque mesh runs when
the cached render bundle is RECORDED; `render-task.ts` re-records only on
`scene._renderableVersion`, the visibility epoch, or an empty bundle list.
This port records no bundles and caches the draw lists on the same rule --
`append_draw` drops an invisible mesh and both backends rebuild the plan and
its lists on `render_topology_version` -- so for an OPAQUE mesh the two defer
identically. The `regression-mesh-flags` gate measures both ends of that: a
mesh hidden before the draw lists are built shows the one behind it, and a
mesh hidden two frames after the scene's last membership change stays drawn
on both sides.
`setMeshVisible` is the pin's entry point for a write that must take effect
at once: it bumps the visibility epoch, and only when the cascade actually
changed a flag, so a per-frame re-assertion stays a no-op. The demos reach
it (a weapon switch, a consumed pickup), and both backends answer the epoch
by re-running the draw-list build alone — the analogue of upstream
re-recording its bundles — leaving mesh GPU state untouched.

The deferral is the opaque bucket's alone, and this port applies it wider.
`drawList` tests `mesh.visible === false` too, and `render-task.ts` calls it
on `_directBindings` and `_transparentBindings` every frame, OUTSIDE the
bundle-record branch -- so upstream a transparent or direct-bound mesh
re-reads the flag each frame and a bare write lands on the next one. Here the
test sits in `append_draw`, the seam every draw-list builder funnels through,
so it runs when the draw lists are built and every bucket inherits the plan
cache's rate. No measured scene writes the flag on a transparent mesh.

Where the test sits is load-bearing for a reason the pin does not have: this
port's pick pass walks the render plan, because that is the list each
backend's own mesh vector is indexed by. Testing `visible` at plan MEMBERSHIP
would drop a hidden mesh from that list, and upstream a hidden mesh is still
a pick candidate -- see [features](features.md#picking).

**A bounded multi-frame drain holds the capture, it does not erase.** The
single-frame `await new Promise(r => requestAnimationFrame(() => r()))` is
erased, because the work it waits for has already happened by the next
statement. A drain that re-arms until a counter passes is a different
claim: the condition is the scene's own, and upstream it gates
`canvas.dataset.ready`, which is the flag the harness screenshots on. So
the condition is kept and every frame loop consults it before capturing.

Scene 117 carries one other closed shape: a zero-argument helper returns a
Promise whose executor nests exactly two `requestAnimationFrame` calls, and
both calls to that helper are awaited only as discarded statements. The
compiler proves that complete AST before erasing it; it does not infer a
general async runtime or recursively count arbitrary frame callbacks. A
retained timestamp, a callback body with other work, a third nesting level,
or the loop-shaped drain above remains outside the rule and refuses or keeps
its own capture condition.

### Lights

**The pin fills two spare scene-block lanes with the canvas size, and so does
this port.** `_packSceneUniforms` writes `eng.canvas.width` into
`vFogColor.w` and `eng.canvas.height` into `_envPad0` on every scene, in the
base pack rather than through a contributor. Nothing in the material families
reads either, which is why the two lanes went unwritten here until a node
graph's `ScreenSizeBlock` read them back through the pin's own
`vec2(scene.vFogColor.w, scene._envPad0)`.

**Standard lighting is the pin's own loop over the pin's own entries.** The
composed Standard fragment declares `array<LightEntry, MAX_LIGHTS>` and walks
`min(mesh.lc, MAX_LIGHTS)` of it through the per-mesh selection `mli()`, so a
slot past the count is never read and needs no marking — light count, kind
dispatch (the tag in `vLightData.w`) and per-mesh light lists are all UBO
data. The entries are filled by writers lowered from each pinned light's own
`_writeLightUbo`, reading direction and position out of the pin's own light
world matrix (`local_matrix_from_direction`): the spot exponent lands in
`vLightSpecular.w`, its cone cosine in `vLightDirection.w`, and a hemispheric
light's ground colour reuses `vLightDirection`, exactly where the pin puts
them. Scene 15 is the spot gate.

### Textures

**An image texture asks for anisotropic filtering only when nothing in its
chain is nearest.** `loadTexture2D` builds its sampler with
`maxAnisotropy: allLinear ? 4 : 1`, where `allLinear` folds in the mip filter
it derives as `mipMaps ? "linear" : "nearest"` — so turning mips off turns
anisotropy off with them. The upstream module page states a flat
`maxAnisotropy: 4`; the pinned source is the fork, and the port lowers from
the source. The magnitude is not rounding: scene 62's crate on a UV sphere
measures 0.031 full MAD with anisotropy 1 against 0.000 with the pin's rule,
all of it at the poles and the silhouette where the UV compression is
extreme. The glTF sampler path already carries the same rule
([backends](backends.md#ported-pinned-contracts)); this is the scene-code
loader's own copy of it, and a contract assertion on the pinned expression
fails generation if either arm moves. Scenes 62 and 81 gate it, and scenes
160 and 162 gate its absence — both pass `mipMaps: false`, which is the arm
that keeps anisotropy at one. Scene 21 reaches it too, through the
`loadTexture2D` its `Promise.all` awaits.

**A node graph's texture bindings are the pin's allocation, and the scene
supplies the images by name.** `compileNodePipeline` draws each
`TextureBlock`/`ImageSourceBlock` pair out of the same running binding counter
the node UBO and the environment take, so the numbers belong to the
composition; `parseNodeMaterialFromSnippet` then looks each declared binding
up in `options.textures` by the sanitized block name. Both halves are kept:
the generated variant table carries the pair and the name, and
`create_node_material` performs the same name join the pin performs when it
fills `_textureSlots`. Generation additionally refuses a binding the record
omits and a name the graph declares no binding for, which upstream raises at
the first render instead. Two calls sharing one graph must name the same
bindings, because the composed variant declares one set.

**A tone mapping is a value, not a flag.** `material/pbr/tone-mapping.ts`
declares `{ id, helpersWGSL, callWGSL }` and each algorithm is one exported
record in its own module, so a bundle carries only the curve it references and
`pbr-renderable.ts` composes
`scene.imageProcessing.toneMapping ?? StandardToneMapping` into the fragment.
This port reads the same records rather than restating one: a scene assigning
`imageProcessing.toneMapping` selects which export's WGSL reaches the composer,
and an unset selection reaches the pin's own default by the same `??`. The
composed arm set is closed at generation, so a scene selecting two different
curves refuses. A node graph's `ImageProcessingBlock` is untouched by the
selection — it reads `sceneU.vImageInfos.w` and carries the standard
exponential curve inline — which is why scene 87 composes identically either
way and the selection is a PBR-family contract.

**A solid texture is rounded once, where the pin rounds it.**
`createSolidTexture2D` writes `Math.round(channel * 255)` into a 1x1
`rgba8unorm` sampled without decode, so the byte *is* the texture and the
float is only how the caller spelled it. The lowered `create_solid_texture`
performs that rounding under a contract asserting the pin's four rounded
channels, and `SolidTexture` carries the resulting texel beside the float —
so a slot that bakes the texture into a fallback and a slot that uploads it
read the same bytes, and neither PAL knows the formula. Scenes 6, 21 and 76
reach it through three different consumers.

### Composed programs

**A fullscreen effect is the pin's own vertex stage around the caller's
fragment, and the pass state is checked rather than restated.**
`createEffectWrapper` builds one shader module as the default vertex stage,
one newline, then the caller's fragment, so generation lifts that constant
out of the pinned module and performs the same concatenation;
the fullscreen triangle, its `uv` varying and both entry-point names are the
pin's text, not a transcription. Everything else the pin decides about the
pass is fixed-function, or a default the frontend restates beside the
descriptor it reads — invisible to a text diff either way, so all of it is
asserted at generation instead: the `triangle-list` topology, the sample count
taken from the *output target's* signature, the two entry points, the single
three-vertex draw in each of the pin's own recorders, the `
` template
joining the two stages, `align4` and the sixteen-byte uniform default, both
arms of `matchesBinding`, the wrapper's own name default, and the clear flag
and colour on both the renderer and the task. The
`EffectBindingLayout` array is the authority on group 0 — the pin reflects
nothing out of the WGSL — so it travels whole into the generated table, with a
sampler's `textureBinding` fallback ("the texture it names, or the first
texture slot") resolved once at generation. Gated by scenes 74, 75 and 76.

**A line system is a mesh and a shader material, and both halves come from
the pin.** `create-line-system.ts` flattens the polylines at load and hands
the result to `createMeshFromData`, so the flatten is emitted as generated
C++ with each rule it folds asserted against the declaration that states it:
the segment index pair `(vertex - 1, vertex)` written only for
`pointIndex > 0`, the `Math.max(0, line.length - 1) * 2` index count, the
zero normal buffer (the shared mesh uploader requires one while the line
shader binds no normal), and the five validation throws. The material is the
program `line-material.ts` composes: its two stages are folded out of that
module's own `vertexSource`/`fragmentSource` builders — the same evaluator
the sprite composers go through — and its declarations and fixed-function
state are read off the `createShaderMaterial` call it makes, so the deployed
WGSL is the pin's text for the permutation the scene reached. Two of the
pin's own stamps fold away with a reason: `mesh._topology = 2` is glTF
bookkeeping the port carries on the material instead, and
`mesh.hasVertexAlpha` is read only by the Standard family, which no line
mesh reaches. The variant's *identity* is the permutation rather than the
name, because the pin names every line material `"LineMaterial"` while
composing a different program per flag set. Gated by scenes 278 and 279.

**A line-list on a multisampled target needs D3D12's multisampled line
rule.** SDL's D3D12 backend hardcodes
`RasterizerState.MultisampleEnable = FALSE` (`SDL_gpu_d3d12.c`), leaving line
lists on the aliased diamond-exit rule at any sample count, where Dawn sets
the flag from the pipeline's sample count and SDL's own Vulkan and Metal
backends have no such switch. The vendored overlay port
(`native/vcpkg-overlay-ports/sdl3`) carries the one-line fix beside
libsdl-org/SDL#15838; the isolating measurement and the triangle-edge A/B are
in [backends](backends.md#measured-contracts).

### Gaussian splats

**The SPZ container is the pinned loader executed, and the rotation it writes
is observed.** `loadSPZ` is a separate entry point upstream -- neither it nor
`loadSplat` sniffs the other's container -- and everything it does is either a
parse this port already takes at generation or a write no importable function
carries. So it is executed whole, through the same `attachParsedSplat`
recorder the glTF feature's `_sceneSetup` uses and a `fetch` shadowed in the
pinned module's own scope so the download cache still answers; the generated
`load_spz` is `load_splat` plus that observed lane, recorded as
`spz-loader-at-generation`. Gated by scene 123 at 0.001 on both backends, and
the gate OBSERVES the lane rather than merely reaching it: neutralizing it
measures 48.276 MAD at max 226, against a published 0.0013155 (SDL_GPU) and 0.0012905 (Dawn), with 25 of 921,600
pixels still matching. That probe ran at an earlier build stamp than the
parity numbers beside it; its artifact is
`artifacts/parity/scene123/probe-no-spz-rotation/`.

**A cloud carrying harmonics reaches the pin's other pipeline, and its shader
is built rather than lifted.** `attachParsedSplat` forks on the parse
(`parsed.sh && parsed.shDegree > 0`) into `gaussian-splatting-pipeline-sh.ts`,
whose WGSL `buildShShaderSource(degree)` EMITS -- one texture binding, one
`textureLoad`, one unpack per coefficient and one polynomial band per degree
-- so there is no packaged literal to extract and the builder is executed
rather than transcribed. The split into vertex and fragment is the same one
the stock module takes, over a second anchor table, and the payload packing
beside it is a fold. The pin states its texture count twice, as
`Math.ceil(coefficients / 16)` and as `SH_TEXTURE_COUNT[degree]`; the port
cross-checks the folded one against the table at run time, so a pin whose two
statements stopped agreeing refuses rather than packing short.

Gated by scene 124 at 0.000 on both backends, and the gate OBSERVES the arm
rather than merely reaching it: zeroing the eye position in the composed
shader moves the image by 1.9018 MAD at max 167, against a published residual
of 0.00018 -- about nine thousand times. That probe left its artifact under
`artifacts/capture/scene124/probe-variants/`; a companion probe neutralizing
the whole view-dependent term measured 1.878 while it ran, but each run
overwrites the last, so only the eye-position one is re-derivable here. The browser's own compiled
module is byte-identical to `buildShShaderSource(3)` run under Node, which is
what says the executed builder and the browser's are the same text.

**The shader plugins are spliced by the pin's own splicer, executed rather
than restated.** `loadSplat(scene, url, fragments)` takes `GsShaderFragment`
records — `gs-depth-fragments.ts`'s exports or the scene's own — and
`applyGsFragments` (`gaussian-splatting-pipeline.ts`) turns them plus the
packaged WGSL into the module the browser compiles. Two things in its body
decide it is executed: it concatenates several plugins into one slot, and it
runs a thirty-five-entry field-name mangler over the result so a plugin
written against `u.projection` agrees with a base the bundler shortened to
`u.p`. A second copy of that table would agree only until it moved. Gated
byte-identically by scenes 126, 127 and 128.

The two-stage split carries two things the stock module's does not: the
helpers upstream splices at `GS_FRAGMENT_DEFINITIONS`, which sit between the
entry points, and the uniform block — `getOrCreatePipeline` declares binding 0
`VERTEX | FRAGMENT` while the four data textures stay vertex-only, so it is
the one resource a fragment plugin may reach. It is declared whenever plugins
apply and left for the compiler to drop; SDL_GPU pushes it to the fragment
stage exactly when `splat.frag.slots` says it survived. Generation refuses a
composed module whose vertex half the splice moved, which checks the mangler's
idempotence on an already-shortened base.

**A glTF cloud arrives through the pin's own document hook, and is not an
adaptation.** `KHR_gaussian_splatting` is a `preParse` that strips the splat
primitives plus an `applyAsset` that packs the same 32-byte rows this port
already reads, so packaging runs the pinned module over the packaged GLB's own
chunks — the quantization and sparse-accessor class, bit-identical by
construction, rather than the `.ply` container-parse class that needs the pin's
parser for its per-exporter property list. Nothing is recorded in
`fidelity.json` for it because nothing diverges.

Two consequences are worth stating. The conversion *consumes* the primitives it
packs, so an asset whose only primitives were splats reaches its binary chunk
through nothing and the rows become the whole chunk — scene 226 packages at
11.0 MB rather than 31.8 MB. And the pin's `_sceneSetup` writes a 180° rotation
about Z on the attached cloud, which is exactly what separates these rows from
scene 120's `.ply`-parsed ones: same 345,217 splats and same 11,046,944 bytes,
differing by the negation of x, y and the matching quaternion. Gated by scene
226, which sits in the splat family's measured multisample wobble band.

**A cloud's world matrix is the pin's own TRS composition.** A
`GaussianSplattingMesh` is a `SceneNode`, so `composeTrsLocalMatrix` builds it
and `build_splat_world` is the same emitted composition the thin-instance
parent world uses. Nothing caches it — the sort's depth-transform gate and the
UBO writer both re-derive per frame — so a position write needs no version
bump. Gated by scene 127.

**The transform bake is folded, and its TRS reset turns on an Euler proxy.**
`bakeTransformIntoVertices` is arithmetic over the same 32-byte rows the
geometry build reads: a per-splat `mat4TransformCoord`, a scale by the
matrix's X basis length, and a quaternion multiply repacked to four bytes. Its
rotation comes from `mat4Decompose`, folded with `mat4Determinant3` and
`_quatFromRotationBasis` and specialized to the rotation its one caller reads
— licensed by an assertion on `mat4ToRotationQuat`'s own body. Two statements
are asserted rather than emitted: the pin copies `mesh.splatsData` and hands
the copy to `updateData`, where this port rewrites the rows in place and
rebuilds the geometry itself.

The reset is where the two records differ. Upstream `mesh.rotation` is an
**Euler proxy** over `rotationQuaternion` (`createEulerProxy`,
`scene-node.ts`): a component write re-applies the cached triple through
`eulerToQuat`, so there is no separate Euler storage and clearing the
quaternion clears the rotation. This port keeps two lanes and
`build_splat_world` prefers the quaternion only while one is set, so the
emitted reset clears the Euler lane too — leaving it would compose the
rotation twice. Gated by scene 125, whose remaining max of two bytes is the
multisampled splat band: the two backends differ from each other by the same
amount.

**A linear-depth material is folded from the factory that builds it.**
`render/linear-depth-material.ts` is one `createShaderMaterial` call over two
module-scope WGSL constants, so the stages come from those constants, the
attribute and uniform lists from the call, and the fixed-function state from
the properties beside it — the same reach `createLineMaterial` takes. Its
`depthCompare` is checked against the pin's `REVERSE_DEPTH_COMPARE` rather
than a spelling typed here: a `ShaderMaterial`'s own compare is not carried
through lowering, so a factory naming another refuses.

Its stages read `view` and `projection` as their own matrices, which is why
both joined the system-uniform table. They are the two factors of the product
the pass already built, so each pass builds all three from one camera —
`build_scene_projection` is the branch `build_view_projection` takes, which
answers the orthographic arm. A shadow caster renders through the light's
biased view-projection and its generator holds a light-space view but no
separate projection, so a stage declaring the missing factor fails by name
rather than reading the frame camera's.

### glTF geometry

**An external image URI inside a GLB becomes an embedded image buffer view.**
Packaging resolves the URI relative to the GLB, appends the exact image bytes
after the existing BIN data with four-byte alignment, and rewrites only the
image JSON to `bufferView` plus its MIME type. The original BIN chunk and all
existing buffer-view offsets remain unchanged, so geometry parsing sees the
source container while the native loader needs no adjacent file at run time.
Racer's `models/Textures/colormap.png` gates that path.

**A quantized glTF is dequantized by the pin's own hook, at generation.**
`KHR_mesh_quantization` is implemented upstream as a single `preParse` that
rewrites every quantized accessor into a freshly appended tightly-packed
FLOAT bufferView, so the rest of the loader never learns the asset was
quantized. It reads nothing but the document and its binary chunk, which is
what makes running the pinned module at generation the same answer rather
than a second implementation of it: `dequantizeGeometry` hands it the
packaged GLB's own chunks and writes back what it returned, then drops the
extension from `extensionsUsed`/`extensionsRequired` because the bytes no
longer carry it. The conversion rule is role-agnostic and the pin states why:
unnormalized unsigned VEC2/VEC3 storage must be rewritten tight or strided,
because the core loader's UV paths always divide unsigned integer data by
65535. Scene 220's Duck reaches all three arms — a normalized BYTE normal, an
unnormalized strided USHORT position, and an unnormalized USHORT UV the
material's `KHR_texture_transform` rescales.

### Standard UV transform

**The Standard UV transform is a mesh-phase extension, and its bit joins the
variant key from a hook rather than from a detector.** `stdUvTransformExt`
carries no `_detect` at all: `enableMaterialUvTransform` marks the material
and `_meshFeatures(meshFeatures, material)` turns that mark into
`STD_HAS_UV_TRANSFORM`, which `buildStandardMeshRenderables` ORs onto the
material's own word before composing and before keying its caches. So the
generated selector is keyed by that ORed word too, and the runtime derivation
lowers the hook beside the eight `_detect` bodies — refusing one that reads
its mesh-feature parameter, because the record-side derivation carries only
the material. Registering the extension is free for every other scene (an
unmarked material contributes nothing and `_computeStandardMaterialFeatures`
skips an extension with no `_detect`), so it registers unconditionally and
keeps the process-global registry independent of which scene composes first;
what is gated on reach is the emitted derivation line, where the pin's own
opt-in lives.

The block itself is lowered from `writeChannel`'s own AST, and two things are
folded because their shape is the contract: the `CHANNELS` table, read out of
the pinned module and unrolled into its seven calls, and the first conjunct
of `legacyFlipV`, which that same table decides. The pin computes in
JavaScript doubles and rounds once at its `Float32Array` store, so the
emitted writer's locals are doubles and the store is the single
`static_cast<float>` — the same rule the camera scalars and the pinned
matrices take. `material.uvOffset` reads its `?? 0` arm, because
`enableStandardUvOffset()` installs the resolver and no reached scene calls
it. Scene 282 measures the composed stages byte-identical to the browser's,
every uploaded lane bit-identical, and every pixel exact. Its one differing
pixel of 921600 sat 4.0e-6 from a texel boundary, where nearest filtering
took the neighbouring checker row — and that 4e-6 was the transform's own
`uScale` reaching this double lane as a float literal, which the lane rule
writes at the sink's width.

### Compressed textures

**A compressed texture's blocks are uploaded as the container carries them,
and which container is fetched is generation's one answer to a device
question.** `ktx-loader.ts` parses a KTX1 header, slices its mip chain and
resolves `glInternalFormat` through `compressed-formats.ts`; all three are
plain data over the file, so the parser is lowered to C++ and runs at load,
exactly as the `.env` container parser does. What cannot run at load is the
*selection*: `loadKtxTexture2D` keeps the suffixes whose feature
`device.features` reports and tries them in order, and a native build has no
network for a second candidate. Generation resolves it over the compiled
backends' feature set — block compression, which is what a D3D12 adapter
reports on both of them and in the browser reference
(`texture-compression-bc`, and neither ASTC nor ETC2) — and the emitted format
table carries the pin's block-compression rows alone, so a file outside them
refuses at the pin's own `if (!format) throw` rather than at an upload that
cannot name what it was handed. Both PALs then translate the pin's own WebGPU
format name, upload the block-padded copy extent the pin computes for each
level (a 2x2 tail mip still occupies one 4x4 block), and generate no mips.
Gated by scene 25, at a grazing camera that samples the whole chain.

**A Basis file is transcoded by the pin's own loader and packaged as KTX1.**
`basis-loader.ts` injects the Binomial transcoder from a CDN with a `<script>`
tag and picks its target format from `device.features` — a browser API and a
device question — so generation runs the pinned loader in headless Chromium
and bakes what it uploaded. It is written back as a KTX1 container because
the port already reads one: the transcoded chain is exactly what `parseKtx1`
returns, and the GL enum it is stored under is the pin's own table read
backwards. Recorded per scene as `executed-basis-transcode`, with the drawn atlas's
tradeoff. Scene 36's Mustang transcodes to `bc7-rgba-unorm` at 768x512 with
one level, which is what the browser uploads.

**`KHR_texture_basisu` is resolved away at packaging, like the geometry
extensions.** The extension redirects five material slots to a KTX2 image and
uploads each through `uploadKtx2Texture2D`, which fetches the Babylon KTX2
decoder from a CDN — the same browser-and-device question the `.basis` arm
answers, so the same answer applies. `gltf-packager.ts` runs the pin's own
`loadKtx2Texture2D` in headless Chromium per image, writes what it uploaded
back into the GLB as a KTX1 container under `image/ktx`, points the texture at
it with an ordinary `source`, and drops the extension from the document — so
the loader that ships sees an asset whose images happen to carry blocks, and
`image_data` fills `TextureData::compressed` through the same generated
`parseKtx1` the `.ktx` path uses. Three things are decided at packaging
because the pin decides them per upload rather than per image: sRGB selects
the container's GL enum through `ktx2-loader.ts`'s own `srgbFormat` table (the
transcode itself is colour-space-agnostic, so an image reached at both spaces
is refused rather than packaged once); the sampler is written as the glTF
enums for `makeSampler`, because the extension's textures never pass through
`makeSamplerFor`; and each level's captured extent is block-padded, because
`uploadCompressed` pads its copy extent where `basis-loader.ts` does not.
`uploadCompressed` also sets the texture-object `invertY`, which the record
carries as `uv_invert_y`. Recorded per scene as `executed-ktx2-transcode`.
Scene 112's Flight Helmet transcodes fifteen 2048x2048 images to
`bc7-rgba-unorm`, five of them under the sRGB enum, and its six materials
share one packed `OcclusionRoughMetal` image per material set — so the
extension's `OffscreenCanvas` ORM composite is never reached, and a document
that would reach it is refused by name.

**A background drawn into the transmission pass's linear target leaves its
image processing to the trailing task.** Both background fragments wrap
exposure, tone mapping and contrast in the pin's `scene.vImageInfos.w >= 0.0`,
and that lane is `+scene.imageProcessing.toneMappingEnabled` — which
`transmission.ts`'s `executeRenderTaskLinear` sets to `-1` for the duration of
the retargeted pass. So the plan writes the pin's own packed value into the
ground's `imageParameters.y` and the skybox's `imageParameters.z` rather than
a constant, and the gate closes exactly where upstream closes it. Nothing
measured this until scene 112, the first scene to reach a DDS background and
scene transmission together: with the gate held open, its sky and ground were
processed twice and every background pixel sat about 59 levels bright while
every model pixel was already byte-exact.

**A texture-object `invertY` is a UV-block flip, and the two compressed
loaders disagree about it.** `Texture2D.invertY` states that the texel data
is stored top-down and must be flipped when sampled, "applied at UV-transform
time in the material, so compressed-format textures remain correct" — an
in-place row swap over blocks being impossible. `basis-loader.ts` sets it and
`ktx-loader.ts` does not, so a Standard material sampling a Basis texture
flips its UV block and one sampling a KTX texture does not. The native record
keeps that property (`uv_invert_y`) apart from the upload flip (`invert_y`)
for the same reason the render-target arm does.

**A render target sampled as a Standard diffuse texture flips V in the UV
block, not at upload.** `createRenderTargetTexture` returns its colour
attachment as a `Texture2D` carrying `invertY: true`, and
`isStandardUvInverted` reads that property off the diffuse texture to decide
the sign `writeStandardUvTransformData` gives the material's UV scale. A
loaded image never carries it — `loadTexture2D`'s own `invertY` option
drives the flipped upload copy and nothing else — which is why the native
record keeps `uv_invert_y` and `invert_y` as separate fields, and why
reading the upload flag here would flip every textured Standard sample.
Scene 110 gates the render-target arm and scenes 9 and 24 the absence.

### PBR layers and slots

**The emissive slot samples through its own UV like every other slot** —
`emissiveUV` under its transform, `input.uv2` under a `texCoord` of 1 —
and the composed variants carry whichever arm the material reaches. Scene
39, whose water animates the emissive transform, gates it.

**The bitangent is a varying.** `pbr-template.ts`'s `tangentBlock` builds
`B_local = cross(N_local, T_local) * tangent.w` before the world and skin
transform and carries it as `worldBitangent`; the fragment composes
`mat3x3(worldTangent, worldBitangent, worldNormal)` from the raw varyings and
normalizes the sampled normal before the frame. `cross` is preserved only by a
similarity and a weight-blended skin matrix is not one, so the frame cannot be
rebuilt from the transformed pair. The mesh world is baked into the vertices
here and conjugated into the palette (`native_matrix`) rather than uploaded as
`MeshUniforms.world`, so the vertex stage reaches the same value by
`M·I·M⁻¹ · M·B = M·I·B`. Scenes 1, 5, 7, 14, 29, 33, 146, and 176 measure it.

**A coat rewrites the base F0 unless the coat came from glTF.** A layer over a
base changes the interface the base reflects off, so `createClearcoatFragment`
composes a `makeF0Remap` slot that runs before the base shades: it takes
`colorF0` through `getR0RemappedForClearCoat` with the coat's
`(1 - ior, 1 + ior)` pair and mixes by the coat intensity. The slot is dropped
only for the `PBR2_CC_F0_REMAP_OFF` bit, and the single thing that sets it is
`gltf-ext-clearcoat.ts` passing `useF0Remap: false`, so the choice is decided
by where the coat came from rather than by any value. `setPbrClearCoat` does
not expose `useF0Remap`, which is why the generated fragment carries the remap
for a scene-code coat and omits it for a glTF one, and why the two are
different fragments rather than one fragment with a uniform. The magnitude is
material: Scene 19's white dielectric sphere has a base F0 of 0.04, and its
ior-2.0 coat remaps that to 0.0204, so omitting the slot puts every sphere
pixel one channel step bright. Scene 19 gates the remap and Scene 28 gates its
absence.

**Sheen is composed as one of two pinned models, chosen at generation.**
`createSheenFragment` takes a `hasAlbedoScaling` flag and builds materially
different arithmetic from it, so it is a fragment fork rather than a uniform.
The `true` arm, which a glTF `KHR_materials_sheen` material reaches, scales
the base layer by `1 - shMax * shBrdf.b`, treats the tint texture as linear,
and multiplies the environment term by specular and horizon occlusion. The
`false` arm, which is what `setPbrSheen` defaults to, reads the tint through
`pow(rgb, 2.2)`, takes roughness from the tint texture's alpha because it
declares no separate roughness map, attenuates the lobe by `1 - dielectricF0`,
and leaves the base layer alone. Each composed variant carries whichever arm
its material reaches — the legacy one also drops the sheen roughness
texture's binding pair and UV transform, since nothing samples them. Scene 29
gates the glTF arm and Scene 21 the legacy one; a scene reaching both
composes two variants, one per material, like any other fork.

### Material plugins

**A material plugin is folded from the scene and spliced by the pin.** The
two halves are separated the way the fidelity rule separates them.
`MaterialPlugin` is a plain object upstream and everything the bridges read
off one for the reached slice is a constant the scene wrote — its `name`, the
WGSL `getCustomCode(shaderType)` returns per injection point, and the WGSL
names `getSamplers()` declares — so it is folded from the scene's own AST,
with each point name checked against the pin's own `FRAG_POINT_TO_SLOTS` and
`VERT_POINT_TO_SLOT` rather than a list retyped here, and each declaration's
optional types against the two defaults `buildPluginFragment` itself applies.
Everything downstream is executed: `buildPluginFragment` maps each point onto
its template slot, concatenates two plugins that share one, turns each
sampler pair into the two binding declarations the composed fragment carries,
and the two bridges number a signature. Scene 217's composed Standard and PBR
fragments are byte-identical to the ones an instrumented capture shows the
browser compiling.

**A plugin reached through a factory is still folded, not executed.** Scene
code writes `mat.plugins = [createStudMaterialPlugin(studs)]` as readily as
it writes the object inline, because the texture members close over the
factory's argument. The call is therefore seen THROUGH structurally: a local
function whose body is one `return` of one object literal, with the
parameters bound to the values the call site passed through the same
parameter binding the user-function inliner performs. No statement runs and
no branch is taken, so the object folded is the one the pin would have been
handed; a body with anything else in it refuses, because a statement could
compute a name or a sampler list nothing here can observe.

`enableMaterialPlugins(scene)` is where the port reaches the feature, because
it is where the pin does: it is the only thing that registers the bridges,
which is what makes a plugin-free scene byte-identical to a build without the
plugin system. A scene that attaches plugins and never calls it composes
plugin-free here too.

**The signature index rides each family's own key.** `pbrPluginExt.detect`
returns it in `features2`, which `_computePbrMaterialFeatures` already runs
for every material this port derives, and a PBR draw resolves its variant by
material index — so nothing about a PBR plugin reaches the runtime.
`stdPluginExt` has no `detect` to use: Standard's feature computation is not
extension-extensible, so `registerStdPlugins` walks the scene's meshes and
pre-bakes `_computeStandardMaterialFeatures(mat) | (idx << PLUGIN_INDEX_SHIFT)`
into each plugin material's cached `_renderFeatures`, which `rebuildSingle`
then reads back. This port has no pin meshes to walk, so it numbers the lists
itself, hands `registerStdPlugins` one stand-in material per list in that
order, and refuses generation if the pin disagreed about a single index. The
number then rides `MaterialRecord::plugin_signature_index` and the generated
`standard_material_features` shifts it back in at the same position, because
the Standard variant selector's key is that derived word.

**The three texture members are proven to agree, because nothing at run time
can.** Upstream `getSamplers` declares the bindings, `bindTextures(out)`
fills them positionally and `getActiveTextures(out)` enumerates the same
textures for the acquire and release `stdPluginExt._textures` performs;
upstream calls all three on live objects and trusts the author to keep them
in step. Here they are folded, so the agreement is a generation check:
equal counts against the declarations, and the same lowered texture at each
position. A disagreement binds one texture and keeps another alive, which is
exactly the class of defect a fold can catch and a capture cannot.

**A plugin's textures are the material's, and the binding table says which.**
The pin builds one plugin resource list per material (`bindPluginTextures`
walks that material's own plugins), so two materials sharing a signature bind
different images through the same declaration. The record mirrors that:
`MaterialRecord::plugin_textures` holds them in push order, and the generated
`standard_plugin_bindings` table — read back off `stdPluginExt._frag`'s own
`_bindings` rather than re-concatenated from the fold — maps a composed
binding name plus the material's signature index onto a position in it. Both
backends execute that one table; neither carries a scene-specific slot. A PBR
material's plugin declaring samplers refuses at generation instead, because
its entries are appended inside `createPbrMeshBindGroup` against a row keyed
by material index, and no scene measures that path.

### Node materials

**A node material is compiled by the pin, not re-emitted here.** A Babylon NME
document is a graph, and `material/node/node-emitter.ts` turns it into WGSL
through one emitter per block class — over a hundred of them, which are
the graph's semantics rather than formulas to restate. So the pin's own
`parseNodeMaterialFromSnippet` runs at generation against a recording device
(`src/pinned-node-material.ts`): every device call on `compileNodePipeline`'s
path happens after the module text is assembled, which is what makes four stub
methods enough, and a pin that started deciding the text from something a real
device answers would fail here rather than compose something else. What
deploys is that module, entered at the pin's own `vs_main`/`fs_main`; what the
generated `node_variants.hpp` carries is a transcript of the same run — the
uniform block's layout, the vertex inputs and the cull state the compiler
produced.

Two of that transcript's parts are folds with a stated reason. The **uniform
block is a constant**: `writeNodeUBO` scatters each named input's values at the
offset the pin's layout gave it, and the `inputs` handles that would change one
are not lowered, so generation bakes what the pin's own writer would have
written. And the **mesh block rides the identity world** where the pin passes
`mesh.worldMatrix`, because a scene-code mesh bakes its node transform into its
vertices here — the same argument the Standard family's draws make, and
the node mesh block writes the live `receiveShadows` value into
`receivesShadow`, where the pin mixes each composed light's factor rather than
selecting a second graph variant.

The graph itself arrives three ways and each gets the answer it deserves. A
module exporting the document as a literal is read as data, which is the fold
and cannot drift. A module that builds its graph at load — id counters,
spread-composed inputs, arrays it pushes into — is code this compiler does not
lower, so it is executed instead, under Node. A source-owned static
gzip/base64 document is data too: generation structurally recognizes the
`atob`/`Uint8Array`/`Blob`/gzip `DecompressionStream`/`Response.json()` chain,
decodes it, and folds the pure compatibility walk that fills an absent
connection `inputName` from `name`. A dynamic payload or wider transform does
not inherit that privilege.

The textures handed to composition are likewise a closed static record.
Scene 66 gates a sanitized, generation-known computed key written during its
graph scan; Scene 72 gates `{ ...fallback, ...loaded }`, with later loaded
entries replacing fallbacks in JavaScript order. The compiler preserves the
resource handles beside that complete key snapshot rather than treating either
source as a run-time string dictionary.

An optional scene `blockLoader` is not executed. Its accepted form is closed
and validated in the scene AST: one local function, one class-name switch,
string cases that each return the `emitter` export from one pinned
`material/node/blocks/*.js` dynamic import, and one throwing default. The
validated class-to-module table is what composition receives; a missing class
still throws there, while a callback, fallthrough, alternate export or
non-pinned module refuses at generation. Scene 72 gates the full 18-emitter
PBR table; Scene 83 gates the smaller closed table and the pin's resulting
normal/AO graph. Its solid AO texture also gates the
only texture normalization beside an ordinary file: the factory's RGBA texel
becomes a 1x1 file-texture record with the pin's clamp, bilinear and no-mipmap
sampler, while other texture storage kinds refuse.

The graph transcript also owns fixed-function alpha state. When its parser
sets `needsAlphaBlending` under Babylon alpha-combine mode 2, both PALs select
the shared source-over tuple and disable depth writes for the colour draw.
Other alpha modes refuse, and a PCF no-colour caster remains a depth-writing
shadow pass rather than inheriting the colour draw's transparency.

That last word is the whole difference from the two executed asset kinds
beside it. A drawn atlas and a computed pixel buffer produce *pixels*, so they
run in the engine the golden runs them in and each records an adaptation
saying the bytes depend on that Chrome. A graph is structure: an object of
numbers, strings and arrays, built from counters and `push`, with no Math and
no browser API in any of the seven corpus modules that write one. Two
ECMAScript engines cannot disagree about it, so there is no adaptation to
record — and a module reaching past plain data fails at its own import rather
than being executed against a shim.

### Node particles

**The simulation is executed and its state baked; everything that draws it is
folded.** `particle/node/npe-build.ts` walks a graph and dynamically imports
one evaluator per block class, each installing getters and update steps as
JavaScript closures — no shape to fold, and this compiler lowers no closures.
The value is fragile past any rounding argument too: every corpus scene seeds
its own `Math.random` through `Math.sin`, which is not bit-portable between V8
and a native maths library, and the graph consumes that sequence in an order
the block walk decides, so a native simulation would diverge into a *different*
set of particles within a few hundred calls. Generation runs the pin's parser,
builder and simulation in headless Chromium and bakes the buffer; recorded as
`executed-node-particle-simulation`, with the drawn atlas's tradeoff.

**The bridge is not executed.** `createParticleBillboard` and
`syncParticleBillboard` are lowered from their own declarations, each rule
asserted: the grid atlas takes the sprite sheet's cell size when it has one and
the texture's otherwise, the system is built at `buffer.capacity` on
`blendForMode(system.blendMode)`, and the sync writes exactly five props per
live particle (`position`, `sizeWorld` as `size * scale`, `color`, `rotation`,
the sheet's `cellIndex`). `clearBillboardSprites` is the identity where the
generated sync runs, so a second sync is refused rather than doubling every
particle.

**A registered set is folded, and the fold is measured rather than argued.**
`registerNodeParticleSet` appends a callback that animates and re-synchronizes
every frame, so a frozen bake answers for it only when that step is the
identity — which depends on the graph's own update blocks and cannot be settled
by reading. The bake driver calls `animateParticleSystem(system, 1)` once more
and compares every column the sync reads; generation refuses a registration
whose columns moved, and one whose `updateSpeed` is not zero. Together those
make the callback provably the identity for any ratio, since
`scaledUpdateSpeed = updateSpeed * ratio`. Gated by scenes 283 and 284.

**The blends are three mappings, all read as data.** `blendForMode`
(`particle-billboard.ts`) maps three modes to public billboard descriptors and
degrades the rest to Add; `createParticleBlend` (`particle-blend.ts`) resolves
all five to private ones, including Multiply (`dst`/`zero`) and MultiplyAdd;
`particle-sprite-2d.ts` carries the 2D twin, whose alpha factors differ. All
three are emitted from their own declarations, so a factor the pin edits
changes what is emitted and an arm it adds fails generation. Which mapping a
system takes rides the native descriptor as the pin's own `_particlePasses`
count rather than a mode number, because that is the field its registrar forks
on.

**Mode 4 is two passes over one renderable.** The pin wraps the Multiply draw
with a stock Add pipeline, a second bind group and a second copy of the system
uniform block, draws the same instances again, and restores the primary
pipeline so a caller caching it stays correct. Both backends do exactly that:
one instance buffer, one index buffer, two pipelines, and the Add blend built
where the pin builds it — `createParticleBlend(2)`, resolved by the generated
builder rather than either PAL. On the pure-2D path the registrar instead
adds two equal-order layers the renderer's stable sort keeps adjacent. Gated
by scene 284.

**The Multiply fragment is the pin's own module, not a fragment arm.**
`particle-billboard-renderable.ts` writes a whole WGSL module so a
Multiply-only bundle declares no `SpriteFx` block, and
`particle-sprite-2d-blend-modes.ts` carries the 2D twin with the layer's
`L.opacityMul` in place of the system's. Generation evaluates the first builder
and lifts the second's body into the pin's sprite composer, so both stages are
the pin's text: `baseColor.rgb * sourceAlpha + white * (1 - sourceAlpha)`,
which leaves a zero-alpha texel's destination unchanged under
destination-colour blending. Gated by scenes 283, 284 and 301.

**A particle buffer is generation-time state.** The simulation runs at
generation, so `buffer.alive` and every column exist only there. A scene
writing a column after the freeze is editing the state the bake hands on, and
one checking the live count is asserting about it: both move to the bake driver
and emit nothing native. The guard's message does not travel — the corpus
writes it as a template over the very count it rejects, and the driver knows
the real one.

**A particle graph's texture is a `loadTexture2D`, not a `loadSpriteAtlas`.**
`ParticleTextureSourceBlock` loads with `invertY` alone, so its atlas keeps
that loader's sampler: repeat addressing, a full mip chain, and
`maxAnisotropy: allLinear ? 4 : 1` resolving to 4. `loadSpriteAtlas` pins the
opposite — clamp, no chain, anisotropy 1 — and the difference is not rounding:
without the chain scene 262 measures 0.006 full, 0.266 edge-weighted, against
0.000 with it. Both backends read the chain off the record's mip filter, the
pin's `mipMaps ? "linear" : "nearest"`.

**The scene's camera is an input to a flow-map build.**
`UpdateFlowMapBlock` derives the view-projection from `scene.camera` while
the graph is built, and the pin leaves the prepared matrix unavailable — so
the update silently does nothing — when the scene has no camera. Generation's
driver therefore replays the scene's own camera construction, and a flow-map
build whose camera is not a static arc-rotate construction refuses rather
than simulating with the update disabled. Scene 280 measures 1.555 full MAD
without the camera and 0.000 with it.

### Sprites

**A sprite atlas that is drawn rather than fetched is executed, not
reimplemented.** `lab/lite/src/_shared/sprite-atlas-image.ts` builds its
256x128 atlas with canvas2D — rotated wedges, `arc`, `hsl` — and returns a
data URL, so there is no file to download and the pixels are a browser
rasterizer's antialiasing rather than a formula. Generation serves the pinned
module from a local server, calls its exported factory in headless Chromium,
and bakes the PNG the data URL carries as a generated asset. Nothing about the
drawing is transcribed. The tradeoff is the HDR prefilter's and is the same
one: the baked bytes depend on the Chrome that compiled them. It is recorded
per scene as the `drawn-sprite-atlas` adaptation.

The frames are not baked with them — the grid stays
`createGridSpriteAtlas`'s load-time derivation over the decoded atlas's own
extent ([features](features.md#drawn-and-computed-assets) owns that phase
split). `loadSpriteAtlas` fixes the sampler the pin fixes (clamp on both
axes, no mip chain, filter from `sampling`), and the texture is `rgba8unorm`
with `srgb` off, so the atlas texels reach the blend stage as the bytes on
disk.

**A texture a scene FUNCTION produces in a canvas is executed at the same
seam, for the same reason, and reached differently.** The three executed
asset kinds above are module *exports* named at the call site. Sandblox
instead calls a one-parameter function that takes the engine and builds the
texture itself, so what has to be intercepted is the call, ahead of ordinary
inlining — the body it would inline is a canvas this runtime does not have.
Neither of its two is lowerable. `character.ts`'s
`createClassicSmileTexture` rasterizes ellipses and a quadratic stroke into a
128-square 2D context, which is a rasterizer's antialiasing rather than an
expression. `stud-texture.ts`'s `createStudTextures` *is* arithmetic, but it
rounds a 64-square float height field into bytes through a `Math.round` this
data model does not compile, and then crosses `OffscreenCanvas` →
`convertToBlob` → `URL.createObjectURL` → `loadTexture2D`, which is a browser
PNG encode with no representation here at all — the shape-versus-value
arbitration lands on "execute" from both sides.

**What is executed is bounded by structure and by what the driver answers.**
The target is a one-parameter top-level function whose same-file call closure
owns a canvas and reaches `createTexture2DFromPixels` and/or `loadTexture2D`
and nothing else from the pin, returning once, either one texture or an
object of them. The module and its repository siblings are transpiled to
CommonJS and evaluated against a stub that records only those two factories —
a non-exported target is exposed by the driver rather than by editing what
the module exports — every other pinned import throws with the name it asked
for, the engine argument is a proxy that throws on any property read, and a
`loadTexture2D` URL that is not an object URL refuses. Anything the gate does
not accept is inlined as before and refuses by naming what it hit, so this
adds no path that silently substitutes a texture.

**Nothing about the pixels or the sampler is re-derived.** What the factory
was handed is what is packaged: the raw RGBA with its width, height and
`PixelsTexture2DOptions`, or the object URL's blob byte-for-byte with its
`Texture2DOptions`. Both then take the native entry points a written-out call
already lowers to (`create_texture_2d_from_pixels`, `load_file_texture`),
through the one copy of the pin's sampler rule in
`src/pinned-address-modes.ts` — including `maxAnisotropy: allLinear ? 4 : 1`
folding the mip filter, so a producer that turns mips off turns anisotropy
off with them. The tradeoff is the drawn atlas's: the baked bytes depend on
the Chrome that compiled them, recorded per scene as
`browser-produced-textures`.

**The platformer golden is a frame, not a wall-clock delay.** Its attract
camera and CRT grain both advance continuously, so a three-second browser
settle does not name a reproducible state. The capture harness therefore
drives `requestAnimationFrame` in registration order on a 60 Hz clock,
marks the first `startEngine` render as frame zero, fixes `performance.now()`
to that engine-relative clock, and freezes after every callback on frame 180
has run. Async browser initialization can consume RAF turns, but time remains
at zero until the engine starts, matching native's synchronous initialization.
Native derives
`BBLITE_SCREENSHOT_FRAME` from that one registry value. This keeps the source
live—the game loop and shader time still execute—while making the measured
state identical in reference, instrumented, and native captures. Interactive
RAF receives the absolute
monotonic timestamp at double precision too; converting it to float would
quantize a machine with long uptime into runs of zero `dt` followed by jumps,
which changes the platformer's collision, friction, and stand/crouch/jump
state machine even though a fixed-clock golden would hide the defect.

**The platformer's projection follows the canvas, so native has to as well.**
Its application loop reads `canvas.width` and `canvas.height` on every frame,
derives the world scale and visible width from them, and rebuilds its CRT
chain when they change. Native preserves those reads as live engine values;
the common window event path updates them from SDL's drawable pixel size
before the callback, while SDL_GPU's acquired texture and Dawn's reconfigured
sprite surface use that same extent. This is application behavior reached by
the demo, not a Platformer-specific resize rule.

**A pure-2D sprite layer is drawn by its own renderer, not by the scene.**
Upstream's `SpriteRenderer` implements `RenderingContext` directly and
registers on the engine rather than on a `SceneContext`, opens its own
single-sample swapchain pass, and draws one instanced quad per layer. Native
mirrors that: a scene registering a sprite renderer and no scene compiles no
scene renderer at all, and the sprite pass is a separate translation unit.
The same independent context can register after a scene and load its colour,
which is how Scene 52 overlays its HUD without sharing the scene depth pass.
The instance layout is the pinned pure-2D one — thirteen floats, 52 bytes,
position/size/uvMin/uvMax/rotation/colour — and the layer UBO is the pinned
sixteen floats.

Reached `depth: "none"` layers cover the exported blend descriptors, the
widened UV scroll layout, and custom fragment shaders with `fx.time`,
`fx.params`, and extra textures. Scene 51 closes the premultiplied path end to
end: its atlas decode premultiplies RGB by alpha before upload, the atlas
record carries that convention into the layer UBO's opacity rule, and the
descriptor uses source-one blending. Its explicit surface choice is folded
from the bare reference query to the `1` arm of the pin's `1 | 4` selection;
the SpriteRenderer pass itself remains directly single-sampled either way.

A depth-enabled layer is the other ownership arm. It attaches to a
`SceneContext`, appends per-instance z as float 13, and builds against the
scene's colour, depth, and multisample attachments. Scene 53 reaches the
depth-writing opaque path and its alpha-to-coverage gate. Coverage gamma
remains unreached. Both GPU backends draw the same generated stock or
pin-composed custom WGSL; their platformer captures differ by only 0.004 MAD,
with 99.91% of pixels within one channel level.

**A sprite target is another rendering context boundary, not a post-draw
copy.** `createSpriteRenderTexture` produces a single-sample colour attachment
that is also sampleable, and `setSpriteRendererTarget` directs a renderer's
ordinary pass into it. A later renderer can use `createSpriteAtlasFromTexture`
to sample those exact pixels. Both native drivers therefore group consecutive
registered renderers by target and end one GPU render pass before a later one
samples that target. The target and the later CRT renderer are created from
the platformer's first application animation callback, so the GPU mirrors are
created after the initial engine render. On the following turn the GPU mirrors
are synchronized before upload; building only the startup list would
permanently omit the chain.

The projection remains the canvas's drawing-buffer extent even when the
attachment is larger. That is upstream's `SpriteRenderer` contract rather
than a target-sized viewport convention: Freeciv renders to a 2x texture and
passes a half-scale view to compensate. Both scene-owned and scene-less loops
therefore upload canvas width and height to every sprite pass; using the
target extent shrinks the complete map to half size.

**One writer, two arms — because only the writer can see the previous
sprite.** `writeInstance` is shared upstream by `addSprite2DIndex` and
`updateSprite2DIndex`, and the argument that differs is `prev`: null on an
add, and the slot's own floats on an update. Every unsupplied field reads
from it, so this port shares one writer too rather than resolving defaults
at the two call sites — a caller cannot resolve them, since the previous
value lives in native memory. Each preserve rule takes its value from a
different place and the shapes are asserted against the pinned declaration:
position and rotation from the instance floats, the UV endpoints from the
slot (whose *order* carries the flip, which is what lets a frame change keep
a mirrored sprite mirrored), and the true size from the CPU-side shadow —
which exists precisely because `visible: false` is stored by zeroing the GPU
size, so the instance data cannot answer what size to restore. Two arms are
deliberately not symmetric: a supplied `frame` resets the size to that
frame's own `sourceSizePx`, discarding an explicitly set one, and an update
that supplies no colour writes no colour floats at all.
`clearSprite2DLayer` matches its early return as well as its body — an
already-empty layer does not bump the version, so a per-frame clear on an
idle layer re-uploads nothing.

**A renderer's layer list is mutable, and each layer's GPU record moves
with it.** Both backends build one record per layer — pipeline, instance
buffer, atlas binding — and `addSpriteRendererLayer`,
`removeSpriteRendererLayer` and `disposeSpriteRenderer` all move that list.
The pin keys `sr._layerGpu` by the layer object, so adding one compiles only
the new layer's pipeline and removing one disposes only that layer's entry;
this port keys by handle for the same reason, and a `layers_version` bump is
what makes it walk the list again. Rebuilding the whole set instead would be
observable rather than merely wasteful: a layer's `elapsed_ms` is the clock
its custom shader's `fx.time` reads, and a rebuild would restart it for
layers nobody touched.

Releasing the records that are dropped needs no wait on either backend, and
for two different reasons: SDL_GPU documents every `SDL_ReleaseGPU*` as
freeing "as soon as it is safe to do so", and a WebGPU object is
reference-counted with a submitted command buffer holding its own reference.
(The mesh-set rebuild in the Dawn scene renderer *does* wait, because it
re-uploads *into* buffers in-flight work reads — a different hazard.)

Unregistering moves one more thing: the frame's clear belongs to whichever
rendering context is at the *front* of the registered list, which is what
`startEngine` walks, so both drivers re-derive it per frame. Reading it once
at startup keeps clearing with a disposed renderer's colour — measured at
29.105 full MAD against 0.000 on the gate below. The one case upstream
leaves to the canvas is every renderer being disposed: it draws nothing and
the page keeps its last pixels, which a swapchain cannot answer on its first
frame, so the helper falls back to a default-constructed record and the
pinned `createSpriteRenderer` defaults come off its own initializers. No
reached scene disposes its last renderer.

`regression-sprite-layer-arms` measures all of it at 0.000 on both backends,
and each half is A/B-proven rather than assumed: it grows the list from three
layers to four, gives one late layer an additive blend, and disposes the
renderer registered *first*. With the synchronisation removed both backends
fault (`0xC0000005`); with the clear owner read once at startup the frame
paints the disposed renderer's colour.

### Environment packaging

HDR environments preserve mip zero and use the pinned WebGPU 1024-sample GGX
prefilter for higher mips. The generated package records the pinned module,
shader, source commit, and sample count.
`EXT_lights_image_based` likewise materializes Babylon Lite's 256-square,
1024-sample BRDF integration directly as RGBA16F and uploads decoded RGBD
cubemap faces with the same half-float quantization as WebGPU.

**A skybox size of zero asks the loader for the pinned default.** The
generated loader resolves an unset `skyboxSize` to `createDefaultEnvironment`'s
20, so the compiler passes zero rather than substituting a size of its own —
a compiler-substituted size builds a skybox the camera's far plane can clip,
invisible from the reference pose and a straight-edged hole in the background
as soon as the camera moves.

**A DDS environment's irradiance harmonics are projected at compile time.**
Babylon Lite's `loadDdsEnvironment` uploads the file's mip chain as the
specular cube and projects the first nine spherical harmonics out of mip 0
while the page loads, weighting each texel by the solid angle it subtends.
Both halves are decided entirely by the asset, so `src/dds-packager.ts` does
them once during generation and the runtime reads a package instead of a
container format — the same split the HDR path already uses. The projection is
reproduced rather than approximated: the 27 floats the package carries are
bit-identical to the ones an instrumented capture shows the browser uploading
for Scene 19. The package is the format the HDR path emits, so the DDS file's
face-major mip chain is transposed to mip-major during generation and one
native reader serves both. One difference from the HDR loader is the pin's own
and is carried through: a DDS environment writes no image-processing state at
all, where the HDR loader sets exposure, contrast, and tone mapping.

**All three environment routes share the source-derived LOD generation
scale.** `.env`, DDS, and HDR pass `0.8` to
`assembleEnvironmentTextures`; HDR reads `HDR_LOD_GENERATION_SCALE` from
`hdr-ibl-pipeline.ts`. The emitted `lod_generation_scale` follows the loader
argument and resolves named constants through their declaring modules.

Scene 8 is the one reached HDR environment and it measures byte-identical
either way, which is a fact about the scene rather than about the scale: its
sphere is `microSurface: 1`, so `log2(cubemapDim * alphaG)` is negative
before the scale multiplies it and `clamp(specLod, 0.0, maxLod)` returns mip
zero for both values. A rougher HDR-lit surface is what would measure the
difference, and the corpus has none.

Per-texture UV transforms follow the pin's own per-material rule: generation
executes the pinned `wrapTexture` and `needsGltfUvTransform`, so a material
with no transform never gains the fields, and each carrying slot's fields are
filled by writers lowered from the pin's own `writeUvTransform` family.
Rotation is composed in double before the float store, matching a `Math.cos`
result reaching a `Float32Array`.

One glTF material contract is expressed in a shape that differs from the
pinned one while producing the same values, and it holds for a stated reason.

**A glTF index of refraction folds into the material's reflectance.** The pin
keeps reflectance at its default and scales it with `metallicF0Factor`, so
`KHR_materials_ior` sets the factor to `((ior-1)/(ior+1))^2 / 0.04` and the
product is the dielectric F0. The loader stores that product directly instead,
which is the same value while nothing else scales F0. `KHR_materials_specular`
is the second scale, so a material declaring it separates the two again: the
factor becomes the extension's `specularFactor` and reflectance returns to its
default, which is also how the pin resolves the two extensions against each
other — the specular factor overwrites the one the index of refraction seeded.

DXC stays mandatory on the SDL_GPU D3D12 and Vulkan offline paths — Tint
emits no DXIL, and Vulkan temporarily recompiles normalized Tint HLSL through DXC
([features](features.md#stage-2-compiling-wgsl-for-the-device) tabulates the
paths and the binding-remap gap).

Tint HLSL is normalized before DXC so texture and sampler registers are dense
and corresponding, as required by SDL_GPU. D3D system-value inputs are ordered
to preserve the vertex/fragment signature convention used by the existing
native pipelines. Tint discard statements are lowered to `clip(-1.0)` to avoid
a D3D12 command-list failure in multisampled pipelines while preserving
fragment-kill semantics.

## Picking contract

A pick renders rather than intersects, so what it answers is the renderer's
and both backends run the pin's own modules -- three of them once detailed
picking is reached. Three facts are this port's: where a mesh's transform
lives, which boundary the picking continuation runs at, and how the detailed
pipeline is enabled.

**`enableDetailedPicking` answers yes or throws, where the pin can answer
no.** Upstream it is a feature PROBE -- `picker._detailedPicking =
engine._device.features.has("primitive-index")` -- with no fallback: a device
without the feature leaves picking silently coarse, and a scene that asked
for a face id gets none. This port answers true unconditionally. It can,
because both backends already carry the feature: Dawn requests
`PrimitiveIndex` from the adapter, and Tint lowers `@builtin(primitive_index)`
onto D3D12's core `SV_PrimitiveId` for SDL_GPU. A device that could not would
fail the detailed module's own shader compile, which is the answer -- the
silently-coarse arm is not composed, because a degraded path that renders a
different picture is the one thing this port does not build.

**A deforming mesh is the exception, and it is the one that bit.** Where this
port has baked a mesh's transform into its vertices the detail position is
world-space and must be mapped back; where the mesh DEFORMS, its buffer
carries no world at all -- the transform lives in the bone palette -- so
there is nothing to un-bake, and un-baking anyway sent scene 115's
barycentrics from `bu=0.188, bv=0.693` to `bu=36.71, bv=-15.89`. The rest
normal is the mirror case: it takes the mesh's own NODE world, which the pose
pass keeps on the record, because `mesh_world_matrix` is the identity for a
skinned record. Both were wrong until a capture said so; neither is
observable in a scene whose picked mesh does not deform, which is why scene
129 could not find them and scene 115 did.

**The detail attachment's position arrives in WORLD space for a baked mesh.**
The pin solves barycentrics against the REST triangle, and the attachment
carries the interpolated vertex position; where this port has baked a mesh's
transform into its vertices, that interpolation is already world-space, so it
is mapped back through the same `mesh_world_matrix` the bake used before the
rest-space solve. Barycentrics are affine-invariant, so this is a change of
basis rather than of answer. The face NORMAL is what needs it: it comes from
triangle edges, which a transform does change.

**A mesh's pick block carries the identity, because its vertices are already
world-space.** `transformed_vertices` bakes the node's world matrix into the
buffer the renderer draws, where the pin keeps vertices local and multiplies
by `mesh.worldMatrix` in the pick vertex stage. The browser's own
`pick-mesh-ubo` shows the pair: scene 129's sphere block holds
`(0, 0.5, -1)` against local vertices, and the identity against baked ones
puts the same positions in front of the same shader. A thin-instanced or
floating-origin mesh keeps LOCAL vertices precisely because its transform
travels as a matrix, so neither takes this arm; both refuse rather than
picking geometry at the wrong place. The position stream is the renderer's
interleaved buffer read at its own pitch rather than a second position-only
upload -- the pin binds `gpu.positionBuffer`, and these are the same numbers.

**The pick reads a sort the frame loop already wrote; the barrier before it
is real.** Upstream the scene awaits `splat.firstSortReady` and one more
animation frame before it picks. Here the statements after `startEngine` are
the browser's continuation and arrive on the deferred queue, which
`finish_frame` drains at the END of a frame -- after that frame's uploads
and render -- and a frame yield inside the continuation re-queues its
remainder to the NEXT frame's drain, one elapsed frame per yield. So by the
time a pick runs, the frame loop's own upload phase has created each cloud's
pass and brought its GPU-side order buffer current, on both backends, and
the pick performs no upload of its own. Neither PAL compensates any more;
the drain used to sit at the START of the frame, before its uploads, and
each pick then had to bring every cloud's sort current itself. The symptom
of an unwritten order buffer, should the sequencing ever regress, is not a
wrong depth but an absent fragment: the cloud samples its data textures at
garbage indices and covers no pixel at all, so disabling the cloud depth
test changes nothing.

**The answer is an identity, not a name.** `PickingInfo` stores the
collection and the index the pick resolved to, and `pickedMesh.name` reads
through them at the read site -- upstream's `pickedMesh` is a live node
reference, and this branch makes `splat.name` writable, so a name captured
at pick time would go stale exactly as the alpha-mode lane did.

**The sampled depth is also the picked point.** The basic picker already
writes clip depth beside the id. Both backends read that lane and run the
pin's `mat4Invert(vp)` reconstruction over the sampled NDC, producing the
same world-space `pickedPoint` the browser exposes. `ray` is intentionally
null in the pin for a non-detailed pick, so a scene's nullish fallback is the
faithful result rather than a missing native ray.

Scene 129 measures the whole chain because the pick decides a visible thing:
the scene removes its ground unless the pick resolved to the cloud, so a
miss is 12.866 MAD and the gate cannot pass without the pass actually
running.

## Physics contract

**The pinned physics layer is generated; the solver under it is not the
pin's, and that is the physics divergence a measurement cannot close.**

Ordinary physics lowerings are bit-faithful by construction — a fold whose
shape is the contract, or a value executed in the engine the golden runs it
in. A substituted rigid-body solver is neither. Havok V2 and
Bullet resolve contacts and converge their constraint solvers differently,
so a body's pose after N steps is a *different number* rather than a
rounding of the same one, and the difference compounds with every bounce.
It is recorded per scene as `substituted-physics-solver`, at `high` risk,
and it means a physics scene's threshold can never be driven toward zero.
What CAN be driven toward zero is the distance between the two solvers'
stepping models, because Havok's is measurable: the pinned WASM runs under
Node (`@babylonjs/havok` is an ESM module that takes its binary as an
option), so its per-step trajectory for a scene's exact `HP_*` call sequence
is a number with no pixel in between. Three properties were measured that
way and reproduced in the PAL, and each physics ceiling is set just above
what remains — gating this port's own solver against the pinned one's
measured behaviour rather than asserting agreement with it. Scenes 40 and
100 are the same drop at the same `?captureFrame=120`, so their ceilings are
the same measurement rather than two — what 100 adds is the collision surface
(`setPhysicsBodyCollisionEventsEnabled` and an `onPhysicsCollision` handler)
compiling, running and leaving the frame where 40 leaves it.

**Havok steps in fixed 1/240 s sub-steps, and the count follows the step.**
A free fall under `HP_World_Step(dt)` advances `y += v·dt + k·g·dt²` with `k`
= 0.000, 0.250, 0.375 and 0.4375 at dt = 1/240, 1/120, 1/60 and 1/30 —
`(m-1)/(2m)` for m = 1, 2, 4 and 8 semi-implicit Euler sub-steps. Bullet at
one step per frame is the m = 1 row, which lagged the reference by
0.375·g·dt² every step: 0.049 units over scene 40's 46-step fall, the 4 px
the previous entry here attributed to "an integrator-order difference". The
PAL now steps Bullet at the same 1/240 s, each sub-step an ordinary full
Bullet step (`stepSimulation(δ, 0, δ)`, no accumulator, no interpolation),
and the fall agrees with Havok's to 0.002 units at step 46. What still
differs there is Havok's first 1/120 s: a body receives 0.0025 m/s less
gravity over its first two sub-steps, at any step size and any gravity,
which is 0.16 px after scene 40's fall and 0.66 px at scene 45's slower
landing; it is not reproduced.

**Havok's contact is speculative, and its rebound is a step late.** Scene
40's sphere arrives at the step where it would cross the surface with
`y = 1.106167`, and Havok's next pose is `y = 1.000000` exactly, velocity
`-2.702623` = the remaining gap over one sub-step: the constraint lets a
body close exactly the gap in the sub-step where it would otherwise
penetrate, and nothing more. The rebound comes in the NEXT step, and holds
its velocity through every sub-step of that step (`y + v_out·dt` exactly,
the gravity of each sub-step re-cancelled by the still-active contact).
Bullet's solver already writes the landing rule for a positive-distance
point — `velocityError = restitution - rel_vel - distance/dt` — so the PAL
widens each manifold's contact-breaking threshold to one sub-step of the
pair's approach (a `btCollisionDispatcher` subclass for new manifolds, a
refresh for live ones) and gives such points no restitution, because
Bullet's own would spend the rebound on closing the gap: that is what left
scene 45's spheres at rest where the reference hops. The landed point that
follows keeps zero restitution while the pair's rebound is pending, or
Bullet would bounce off the landing speed first (0.137 on scene 40 with
both).

**The rebound speed is not `e·v`, and it is fitted rather than derived.**
Over 72 drops on the pinned WASM — restitutions 1, 0.75, 0.5 and 0.2,
nine heights, gravities 9.8 and 1 — the next step's velocity is
`e · sqrt((v_a - g·dt)² - 2·g·d_k)` within 0.3%, where `v_a` is the approach
speed at the start of the landing step, `g` the gravity into the surface,
`dt` the full step and `d_k` the gap at the start of the landing sub-step;
a 0.2 m box dropped on the ground fits the same rule within 1.5%. It is the
shape Unity Physics documents for the same Havok-derived solver (remove one
step of gravity from the approach, then the gap's potential energy), and
the residual it leaves compounds over a flight (scene 101's table below). A
body approaching slower than `g·dt` rests instead. One edge case is measured
and not reproduced: a body that reaches the surface on the LAST sub-step
keeps `-d_k/δ` of its speed into the next step, and Havok's rebound there
is weaker, or one step later (sphere from 2.5 m under gravity 1: the step
after landing is `v = 0`, the rebound the step after that). Box-box pairs
are a detector gap rather than an edge case: Bullet's `btBoxBoxDetector`
emits only penetrating points, so no speculative point exists for the
model to act on and such landings keep Bullet's own restitution — scene 44
measured 0.005--0.006 there against 0.023 when the rebound rule was fed a
penetrating point, and 0.021 / 0.074 when its box pairs were routed through
GJK/EPA, which does honour the threshold; the box-box detector's contact
set is what the stacks rest on.

**Scene 45 is the scene the rebound rule was measured on, by contrast with
scene 42.** Its two spheres fall 3 m and 4 m under `-1 m/s²`, land at 2.4
m/s and hop 0.12 units on restitution 0.2; at the pin's `?captureAfter=3`
pose both are half a second into that hop, and the native trajectories
follow Havok's to 0.0014 units at step 180 — the previous entry here, with
Bullet's restitution eaten by the gap-closing term, had both spheres at
rest 0.13 units under the golden's. Sphere 1 additionally takes
`applyPhysicsBodyForce` with the arguments in the order the pin declares
them, `(world, body, force, location)`, so the scene's `sphere1.position` is
the FORCE and `{x: 0, y: 1, z: 5}` is the application point; that point is
off the sphere's centre, so the impulse imparts spin, and Havok's friction
during the landing steps takes that spin from 0.81 to 0.20 rad/s where
Bullet's takes it less — invisible on a plain white sphere. Scene 42 has
neither: two spheres in straight vertical fall, one of them pre-stepped and
therefore positioned rather than simulated, at rest by its pose; it
measures 0.000 on both backends.

One thing that is NOT part of any of it: the impulse itself. The pin turns a
force into an impulse with `worldStepSeconds(world)`, which falls back to
the scene's per-frame delta when the world has no fixed step, and this port
used to read a `step_seconds` it remembered from the last step -- zero
before the first one, so a force applied before `startEngine` integrated to
nothing. `world_step_seconds` now derives it the pin's way, from the same
three sources in the same order. Scene 45 is the only scene that reaches
`applyPhysicsBodyForce` at all, and it applies its force before starting the
engine, so this is the difference between the force existing and not.

**Why the substitution, and why at this seam.** `createHavokWorld(scene,
hknp)` takes the solver module as a parameter and the pinned layer calls
only `HP_*` entry points on it, so upstream already separated its
rigid-body *semantics* from the library that integrates them. The port
keeps that line exactly: `src/physics/havok.ts` is lowered like any other
pinned module, and the `HP_*` surface becomes
`native/include/bblite/pal_physics.hpp`. No generated code names a solver.
The Havok WASM module is a proprietary binary this project cannot
redistribute; Bullet is Zlib and is the closest available relative of the
reference, since Babylon's legacy `AmmoJSPlugin` is Bullet compiled to
WebAssembly.

**What IS pinned, and is emitted from the pinned declarations rather than
restated:** the step gate `_fixedDeltaMs > 0 ? _fixedDeltaMs : deltaMs`, the
non-finite/non-positive rejection, the `Math.min(stepMs, MAX_STEP_MS) /
1000` tunnelling clamp with `MAX_STEP_MS` read from its own declaration, the
`gravity ?? { x: 0, y: -9.81, z: 0 }` default, the `?? 0.2` friction and
restitution defaults, all three motion/shape/prestep enumerations with the
pin's own numbering, the aggregate's ordering (shape, body, shape
assignment, material, then mass — upstream comments that ordering because
mass derives from the shape), the `mass === 0` static rule, and the
shape sizing `_buildShapeParams` derives.

That derivation is translated expression by expression from its own AST. Two
things specialize, and both are the ones the three helpers it replaced in
1.25.0 already specialized: the optional bound pair becomes the native
geometry record's `present` flag with each `??` taking the pin's own literal
fallback, and every component widens from its stored float into the
JavaScript-number double the pin computes in. Everything else is the pin's
expression — the four scale terms, the scaled extents, the centre the sphere
and box cases share, and the segment a capsule and a cylinder span: the
mesh's own scaled Y range at
`extents.x * 0.5`. `physics-lowerer.ts` asserts
every remaining restated rule against the declaration that states it,
including the *order* of the four phases, which no single expression would
catch, and `setPhysicsShapeMaterial`'s static-friction default, which is what
licenses the emitted aggregate writing one friction into both material
channels. Scene 40 directly gates the translated centre, ground extents, and
sphere radius on both backends.

**Racer extends the reached seam without bypassing that step order.** Shape
membership masks are installed on Bullet's broadphase proxy, filtered
raycasts use the source membership/collide-with pair, and linear velocity is
read after the preceding solver step. `applyPhysicsBodyForce` integrates the
source force over the world's fixed step before entering the existing impulse
path, preserving the caller's application point. Collision contacts are
snapshotted after Bullet steps, classified as STARTED/CONTINUED/FINISHED
against the prior snapshot, and delivered through the pin's after-step list;
the scene therefore never runs application code from inside the solver's
manifold callback.

### What a substituted solver is measured by

Two things, and only one needs Havok.

**Solver-independent properties**, from `BBLITE_PHYSICS_TRACE`'s per-step
pose, checkable with no reference:

- **Free fall.** Four semi-implicit Euler sub-steps per 1/60 s step put the
  pose after `n` steps at `y = y0 - g·dt²·(n²/2 + 3n/8)`; Havok's is the
  same expression less its first-1/120 s deficit, so `examples/physics-drop.ts`
  agrees with the pinned trace to 0.002 units at the 46th step.
- **A resting body settles at its geometric height**: a sphere of radius 1 on
  a ground plane at `y = 0` rests at exactly `y = 1.0`.
- **Restitution follows the fitted rule**: scene 40's sphere leaves its first
  landing at 5.5025 m/s where Havok leaves it at 5.502501.

**The pinned solver's own trajectory**, from the scratch driver this
contract was measured with: load `@babylonjs/havok`'s ESM build under Node
with its `.wasm` passed as `wasmBinary`, issue the scene's `HP_*` sequence
(shape, body, motion type, add, transform, shape assignment, material, mass
— the aggregate's order), step `HP_World_Step(1/60)` and read
`HP_Body_GetQTransform` / `HP_Body_GetLinearVelocity` per step. Beside
`BBLITE_PHYSICS_TRACE` of the same scene it is a per-step diff with no
renderer in it, which is how each rule above was found and how a future
divergence should be attributed before any parity number is read.

**A pixel comparison against Havok, at a pose where phase does not matter.**
`@babylonjs/havok` is a browser-only devDependency — never linked, never
shipped — so the reference page runs the pinned layer against the real solver.
A mid-flight pose cannot be compared: the harness screenshots three seconds
after `dataset.ready`, so the two sides sit at different steps and the number
is phase, not error (`examples/physics-drop.ts` reports 2.396 measured that
way). A resting pose has no phase, and it is what validates the
degenerate-box sink below.

At rest, Bullet against the Havok golden on `examples/physics-drop.ts`:
**921,584 of 921,600 pixels exactly identical**, full MAD 0.000056, region
0.000127, 15 of the 16 differing pixels within one byte and the last an
antialiased silhouette pixel at 37; extent, pixel count and mean RGB match
exactly, on both backends. The substitution costs nothing where both solvers
have converged, and everything it costs is in the transient.

Scene 40 is the corpus scene, frozen by the pin's own `?captureFrame=120`
mid-flight after two bounces, and the trajectory is the measurement: the
native sphere's height against Havok's stays within 0.002 units through
the fall and on the same side of every bounce after it, where the previous
PAL was 4 px low before the first contact, 13 px high at its apex and 5 px
low at the capture.

| | Scene 40 at step 120 |
| --- | --- |
| Full / region MAD | 0.003 / 0.006 |
| Pixels exactly equal | 99.77% foreground |
| Trajectory against Havok | 0.0004 units |
| SDL_GPU versus Dawn | 0.000, byte-identical |

The backends agreeing to zero puts all of it on the CPU side. The traces
index their steps differently — the native trace counts from 0, the
driver from 1 — which is the one-frame shift an earlier entry here read as
the harnesses' counters; it is the numbering, and nothing else.

**Scene 101 is the same substitution two bounces further on, and it costs
what the fitted rule's residual costs over two flights.** The pin's own spec
freezes it at `?captureFrame=150`: a unit sphere dropped from `y = 4` onto a
perfectly elastic ground (restitution 1, combined MAXIMUM against the
sphere's default 0.2), falling through a static trigger sphere of radius 2
on the way down and back out through it on the way up.

| | Scene 101 at step 150 |
| --- | --- |
| Full / region MAD | 0.027 / 0.178 |
| Pixels exactly equal | 92.36% foreground |
| Trajectory against Havok | 0.006 units at step 150, 0.019 at its worst (step 135) |
| SDL_GPU versus Dawn | 0.000, byte-identical |

Everything static is the golden's: the ground, the translucent red trigger
volume and the background all match, and the whole residual is the ball's
own disc. The first rebound leaves at 7.3365 m/s against Havok's 7.336499,
and that 0.2% grows linearly over the 90-step flight to the second bounce;
the second bounce resets it. The trigger events land where the pin's spec
expects them, ENTERED on the way down and EXITED on the way up.

Before the stepping model was measured, every `btContactSolverInfo` value
named for contact agreement was swept against the per-step trace and every
live perturbation moved *away* from the golden (`m_linearSlop` to `0.05`
gave 12.2 px against the default's 5.0, `m_erp2` to `0.8` gave 6.7,
`m_splitImpulse` off gave 35.4), as did the two Bullet arms that look like
Havok's speculative contact — `setApplySpeculativeContactRestitution` and
`setCcdMotionThreshold`/`setCcdSweptSphereRadius` are aimed at a body that
would TUNNEL within a step and never ran. The lesson that survives those
sweeps is the method: a solver difference is attributed against the pinned
solver's own trajectory, not against pixels, and not by reasoning about
which of Bullet's settings ought to reach it. Neither the pin nor upstream's
`ammoJSPlugin` sets anything beyond gravity and per-body friction and
restitution, so nothing above is a configuration to adopt from upstream;
each rule is a measured property of the reference solver.

### PAL-level equivalences

**The degenerate ground box is a real seam.** `createGround` builds a
zero-thickness Y extent and `createPhysicsAggregate(ground, BOX)` sizes the
shape from it — a plane in Havok's tolerance model, a zero-volume box Bullet
cannot resolve a contact against. The PAL grows any axis below Bullet's
`CONVEX_DISTANCE_MARGIN` to it and sinks the centre by the same amount, so the
+axis face stays where the mesh puts it: a unit sphere then rests at `1.000`
against `1.040` without.

Two things it deliberately does not do. It does not read the constructed
shape's extent back to compute the sink — `btBoxShape` maintains
`m_implicitShapeDimensions + margin == the constructor argument` (`setMargin`
re-adds the old margin before subtracting the new), so
`getHalfExtentsWithMargin()` returns its own input and the read-back would be
an identity dressed as a derivation. And it sets no per-shape margin, because
Bullet's is not one convention: a `btSphereShape`'s margin *is* its radius, so
one value across shape kinds moves surfaces rather than aligning them.

The sink direction is the PAL's one scene assumption — always along the -axis,
making the +axis face the contact surface. That is right for a ground and
wrong for a thin ceiling, and a scene cannot say which it meant; no reached
scene builds one.

**Two ordering repairs belong to the PAL, not the semantics.** The pin
configures a body in Havok's order — create, motion type, add to world,
transform, shape, material, mass — and Havok reads each write live. Bullet
takes collision group, broadphase proxy and gravity from the state at *add*
time, and a shape's centre offset is unknown when the transform is written.
`pal_physics_bullet.cpp` absorbs both by re-adding the body and re-applying
the recorded transform, preserving the pin's order above them. Without the
first the sphere never falls; without the second it rests 0.04 high.

**A convex hull keeps its physical frame, not only its vertices.** Havok's
`HP_Shape_BuildMassProperties` returns a centre of mass, inertia and
principal-axis orientation. Bullet's fast convex hull leaves its body frame
at the authored origin, so the PAL triangulates the hull once for
`calculatePrincipalAxisTransform`, stores that tuple, and retains the fast
collision hull in the resulting frame. The break-meshes probe compares all
fourteen cells of one boombox: centre, inertia and orientation agree with the
Havok tuple to the hull builders' float tolerance. Discarding the frame put
every shard's centre at the boombox pivot and turned one downward impulse
into the wrong torque.

**A trigger volume is a shape flag upstream and an object flag here.**
`HP_Shape_SetTrigger` marks the SHAPE; Bullet's equivalent,
`CF_NO_CONTACT_RESPONSE`, belongs to the collision object, so the PAL records
the flag on the shape and applies it to whichever bodies wear it — in both
orders, since the pin may flag a shape before or after attaching it. The
event stream is the same shape as the collision one: Havok reports the two
EDGES of an overlap, Bullet reports the overlap, so `ENTERED` and `EXITED`
come from the difference between consecutive steps' trigger-pair sets. A
trigger pair is one where exactly one side carries the flag, and those pairs
are excluded from both the collision stream and the contact-rest timer —
passing through a trigger is not resting on anything.

**Havok's reached body defaults cross the seam.** A fresh reference world
reports maximum linear/angular speeds `200/100`; a fresh body reports linear
and angular damping `0/0.1`. Bullet has no finite speed limit and defaults
both damping channels to zero, so the PAL clamps every impulse and post-step
contact result and installs the reference damping when a body is created.
The clicked shard consequently reads exactly `24/100` immediately after the
impulse rather than the previous `24/187.6`. The damping coefficient is
converted rather than copied: Havok multiplies a velocity by `1 - d·δ` per
sub-step where Bullet multiplies by `(1 - d)^δ`, and the same per-sub-step
factor needs Bullet's `d = 1 - (1 - 0.1/240)^240 = 0.0952` for Havok's 0.1 —
scene 45's spun sphere reads `0.99833` of its angular speed after one step
on both sides.

**Resting contact is graded as a trajectory, too.** With the same seeded
boombox, picked point and downward impulse, Havok has fourteen moving pieces
after its first step, two at step 150, one at 180--210 and zero at 240.
Bullet's contact jitter otherwise leaves pieces moving until roughly step
450. The PAL therefore stabilizes only a dynamic body which is already in a
contact manifold and remains inside the measured late-motion envelope for a
quarter second; free bodies are never touched, and ordinary Bullet island
activation wakes a stabilized body on a later collision or impulse. The
native trace has two movers at step 150, one at 210 and zero at 243. This
is an explicit solver-equivalence shim, not a changed demo impulse or global
damping knob. A body between a landing and its rebound, or hopping through
one, is exempt however slowly it moves: sleeping it there froze scene 42's
sphere 0.0003 units above the ground, and its timer restarts once the hop
has landed.

**Havok's combine modes are applied, not approximated.** The pin passes
`MaterialCombine.MINIMUM` for friction and `MAXIMUM` for restitution, where
Bullet's default is the product, so both rules run on the contact manifold
callback.

The remaining equivalences are documented where they happen: the step is
Havok's own 1/240 s sub-step grid (`stepSimulation(δ, 0, δ)` for each), a
kinematic `SetTargetQTransform` maps to `set_transform` (no corpus scene
exercises an ACTION prestep), and a material whose static and dynamic
friction differ refuses rather than averaging.

### The freeze

**A scene freezes itself, and both sides honour the same freeze.** The small
corpus physics scenes count their own steps and call `stopEngine` from a
zero-delay `setTimeout` at the step their `?captureFrame=` names. Both are
lowered rather than erased: `stopEngine` is a flag the frame conductor reads,
and `setTimeout(cb, 0)` is a one-shot callback it drains after the frame's own
— the boundary a browser runs a zero-delay timeout at. Once stopped the
conductor advances nothing and keeps presenting the frozen frame while a
capture is pending.

Non-zero `setTimeout` uses the conductor's double-precision monotonic clock
and fires once on the first frame boundary at or after its deadline. A
recursive callback is heap-owned by the engine after its defining scope
returns; scheduling itself again does not leave a reference to dead stack
storage. Racer exercises that real-delay path for its countdown/reset logic
while the physics world continues stepping.

## Audio contract

**The seam is the pin's own, and it is the Web Audio API.**
`packages/babylon-lite/src/audio/` is a behavioural port of Babylon.js
AudioV2 whose entire platform reach is `AudioContext`, `GainNode`,
`PannerNode`, `StereoPannerNode`, `AnalyserNode`,
`AudioBufferSourceNode` and `AudioParam`, plus the `document`/`navigator`
hooks in the modules this port refuses. Where `createHavokWorld(scene,
hknp)` takes its solver as a parameter, audio takes the *browser* — so
`native/include/bblite/pal_audio.hpp` mirrors Web Audio, and buses, the
sound sub-graph, ramp shapes and the sound state machine stay Babylon
behaviour.

**Racer is the first published application gate to reach decoded buffers.**
It creates the Lite audio engine and source bus, fetches four pinned Ogg clips,
decodes them, and builds looping engine/skid sources plus one-shot impacts from
the returned `AudioBuffer`s. Generation recognizes that helper by its
`fetch(url)` plus `ctx.decodeAudioData(...)` body and requires a static asset
URL; native packages the same encoded bytes and LabSound/libnyquist decodes
them at the context's sample rate. The graph retains loop, playback-rate,
gain, connect/disconnect, start/stop and `onended` behavior. This is asset
materialization, not a silent replacement with an oscillator.

The other reached consumers use the Lite engine for lifecycle
(`createAudioEngineAsync`, `engine.audioContext`, `createSoundSourceAsync`,
`unlockAudioEngineAsync`) and then build their own raw Web Audio graph on the
context they are handed. `audio-demo.ts`, the module's Tier-4 showcase, still
keeps the microphone, visualizer and unmute UI outside deterministic gates;
those surfaces refuse by name.

**The platformer also reaches the browser timer that drives its music.** Its
30 ms `setInterval` is a look-ahead scheduler: each wake reads
`AudioContext.state` and `currentTime`, then schedules lead, bass, and chord
voices at precise Web Audio times. It is therefore executable application
logic, not browser setup to erase. Native registers it on the shared frame
conductor, tests due time against the same double-precision monotonic clock as
RAF, coalesces a late wake to one callback while advancing the next deadline
by whole periods, and honors `clearInterval`. The audio notes remain timed by
the audio context; the conductor only performs the browser timer's wake-up.

**The engine's output graph is folded, and the fold is gated.**
`createAudioEngineAsync` builds `mainBus -> mainOut -> ctx.destination`
— three statements — so the shape is the contract and
`src/compiler/intrinsics/audio.ts` emits it at the reaching call site.
`src/lowering/audio-lowerer.ts` is the other half of that bargain: it
emits nothing and asserts every statement against the pinned declaration
that states it, including the one the fold omits
(`setMainOutVolume(engine._mainOut, engine._volume)`, inert only because
`_volume` defaults to `options.volume ?? 1`, which is therefore what gets
checked). A moved contract fails generation naming the declaration.

**`setMasterVolume` refuses, because the pin has no un-ramped form.**
`setMainOutVolume` goes through `setRampTarget`, whose shape defaults to
`"linear"` and whose duration defaults to the engine's `_rampDuration`
(0.01 s) — above `MinRampDuration`, so even a call passing no options
schedules `cancelScheduledValues(0)` and a two-point
`setValueCurveAtTime`. An instantaneous write would be a substituted
behaviour wearing a subset's clothes, so the call refuses until
`audio-param.ts`'s curve component is lowered.

**The engine under the seam is LabSound, and that is the one thing here
a measurement cannot close by construction.** LabSound is a fork of
WebKit's own WebAudio implementation with the copyleft code removed, so
the node graph, the parameter timeline and the panner math are the same
algorithms rather than a second design — the relationship navigation has
with recastnavigation rather than the one physics has with Bullet. It is
still a different codebase from the one that produced the references,
and it has diverged for a decade, so agreement is expected rather than
guaranteed. Recorded per scene as `substituted-audio-engine`. Two
divergences are known and translated in the PAL: a `StereoPannerNode`'s
`pan` is declared with default 0.5 over 0..1 where Web Audio specifies
0.0 over -1..1 (only the descriptor differs — the DSP clamps to [-1, 1]
and `setValue` does not enforce a range — so an unset panner would sit
right of centre), and a context's rate and channel count are the
device's, because `new AudioContext()` takes neither.

**Audio produces no pixels, so it is measured as PCM.**
`BBLITE_AUDIO_CAPTURE=<path.wav>` makes every context the scene creates
render offline: the same graph, no device, no thread, and the clock
advances only inside the render, which happens at the end of
`pal::run_engine` — the one place a run ends, the same seam
`CaptureGate` takes a screenshot at. The WAV and the reported
frames/peak/RMS come from one captured bus, so they are the same bytes
by construction. `examples/audio-probe.ts` measures 48000 frames at
48 kHz, peak 0.032524, RMS 0.004254, byte-identical across runs, with
the per-100 ms RMS rising monotonically as its own
`exponentialRampToValueAtTime` says. The pinned engine accepts an
`OfflineAudioContext` through `createAudioEngineAsync({ audioContext })`
for exactly this reason, so the browser half of a PCM comparison already
exists; that comparison is the gate this slice still lacks.

## What is measured: the full page

Parity compares the complete 1280×720 browser page with the native frame. The
golden includes the Babylon canvas and reached DOM/CSS UI. The bounded
[native page UI](ui.md) surface lowers supported controls, Canvas2D overlays,
events, and host-page companions into retained RmlUi records.
Runtime-selected root-relative background images are retained as RmlUi image
decorators and resolved through the packaged asset directory; Voxel Sandbox's
ten hotbar icons gate that path.

Author CSS is not widened into global class declarations. Generation parses a
closed selector IR (including two-class conjunctions and statically-proven
class/tag descendants), then RmlUi evaluates its source-ordered cascade,
`:hover`, and `max-width` rules against the live resized context. RmlUi 6.4
does not implement Grid, so only a fixed `repeat(integer, px)` track whose
direct-child width, height, gap, margin, padding, and border prove wrapping
equivalence is structurally lowered; the exact shape is recorded in
`substituted-ui-runtime`. Constant inline vector icons take the pinned RmlUi
LunaSVG path after a generation-time `svg`/`path`/`rect` grammar check.
Inherited `currentColor` becomes a white SVG source plus the computed RmlUi
text colour as image tint; mixed literal/currentColor paints refuse because
the tint covers the whole image, while `none` remains non-paint. These are
renderer substitutions, not silent fallbacks; unsupported selectors, markup,
attributes, or grid shapes refuse.
Programmatic render-canvas focus is retained as host state and its browser
focus outline is composited above the page UI.

Browser and native UI use different layout and font rasterization stacks, so a
composite residual can be larger than the canvas residual. Status rows above
MAD 0.5 identify UI as the dominant residual and publish both backend values
from a canvas-only attribution run.

`BBLITE_CAPTURE_UI=0` hides browser page chrome, suppresses the canvas's host
focus outline, and captures the native scene before UI composition. Those
references and reports live under
`artifacts/parity-canvas/`; they are diagnostics, not canonical gates.

Parity poses are deterministic source states and do not depend on clicking UI.
The browser and native harnesses use the same configured frame, clock, timers,
and CSS animation time.

## Parity reports

Reports name the backend they measured and include:

- full and foreground RGB MAD
- exact and within-1/3/5-byte ratios
- per-channel MAD and signed foreground bias
- background, high-gradient edge, and interior MAD
- highest-error tiles
- renderer/backend metadata

Interpretation:

| Signal | Likely source |
| --- | --- |
| background | clear color, skybox, ground, image processing |
| edges | camera, winding, depth, coverage, MSAA |
| interior | material inputs, color spaces, BRDF, IBL |
| uniform RGB bias | exposure, gamma, tone mapping |
| localized hotspot | one draw, material, texture, or mesh region |

## Attribution

Registry-enabled scenes emit draw-ID and triangle-cluster-ID buffers — the
`--id-diagnostics` generation option adds the ID outputs to the composed
shaders — and reports join those IDs to glTF nodes, meshes, materials, alpha
mode and double-sided state.

### Post-process passes

**A pass draws the module the pin composed and reads the parameters the pin's
own writer places.** Every effect is one `createPostProcessTask` differing
only in a `_shader` record, so the factory is *executed* at generation against
a descriptor-only render target and `getShaderModule` concatenates the module
that deploys — byte-identical to the browser's for scenes 142 and 143.
Executing rather than folding is the blur's doing: its kernel decides how many
taps the vertex stage carries, and each tap's offset and weight is a Gaussian
evaluated in doubles and printed through `toFixed(7)`, so folding would restate
an integration, a rounding rule and a formatter. The uniform half *is* lowered,
from each effect's own `writeUniforms`, because its values depend on the real
attachments — the blur's delta is the direction over the output extent, the
chromatic aberration's screen size is the source's. Two rules come from the pin
rather than a sibling: the pipeline's sample count is the *output target's*,
and the normalized viewport rounds its far edges up where a copy task's rounds
them down.

**A composite's inline pass is read off the composite, because the pass
publishes nothing.** Every post-process builds through a leaf factory whose
module declares the `_shader` — except bloom's merge, which `bloom.ts` builds
by calling `createPostProcessTask` directly with a `_shader` written inline.
That closure captures the composite's own `params`, so the merge task carries
no `weight` to read and its module no default to check; both live inside
`createBloomPostProcessTask`. The observation therefore watches
`createPostProcessTask` beside the leaves — the seam is keyed by relative
specifier, so that entry point is nameable — marks the pass it produced, and
reads its parameters off the composite. The effect row names the pinned
function declaring its `_shader`, keeping its own name out of the composite
table's key space.

**A name a pinned module declares is read off that declaration.** A pinned body
may reach a module-scope `const` of its own file — `extract-highlights.ts`
raises its threshold through `TO_GAMMA_SPACE` — and the translator resolves
such a name against the module being lowered. The initializer is lowered rather
than folded, so the arithmetic stays the pin's, and a constant it cannot lower
fails by the name that reads it. Only what the module does *not* declare
travels through the caller's bindings, the rule `pinned-shader-text.ts` states.

### Frame graph

**A depth attachment another task owns is loaded, not cleared.** The geometry
renderer publishes its depth as an eager wrapper target, and
`createRenderTask`'s `const loadOp = (config.depth ? depthSrc._eager : ...)`
turns that into a load: the borrowing task neither builds nor disposes the
attachment, and the writer stores rather than discards. Scene 147 shares one
depth buffer between the geometry pass and the colour pass.

`attachControl` and `attachFreeControl` register input on the camera they are
handed and make no camera the scene's, which lets scene 142 render its right
eye through the scene camera and its left through a task's own. A task with its
own camera carries its own copy of the per-pass scene block; a second camera
moves the view-projection and the eye position, nothing else.

The render task the compiler creates to materialize the implicit scene pass is
not an application list-only task. It replays the scene's skybox sub-order
before opaque and transparent lists and the ground stage after them. Keeping
that distinction prevents enabling a shadow task from silently replacing a
complete scene render with only its mesh draw lists.

Frame-graph depth targets select a supported D32/D24 sampled depth format,
matching the `depth32float` geometry-target contract. Scenes 145 and 146 gate
the production geometry-renderer path — all eleven geometry texture types,
split 7+4 MRT passes, optional real colour, independent depth, viewport copies
and MSAA resolve — and resolve each attachment at full resolution before
bilinearly downscaling it into one of twelve preview regions on a 4x-MSAA
target. Babylon Lite floors each normalized viewport edge to integer target
pixels and applies the same rectangle as a scissor; fractional bounds without
it introduce partial-sample coverage at tile boundaries, so native preserves
the double-precision viewport expressions and the floor/scissor contract.
Inspect the attachments with `npm run scene -- geometry scene145|scene146`.

The `scene geometry` command selects a copy task by *name* on both sides — the
native loop reads `BBLITE_COPY_TASK`, the capture harness serves a module
re-exporting the pin with `createCopyToTextureTask` wrapped. Selecting by name
rather than rewriting the source is what reaches scenes 145, 146 and 149, whose
copy tasks are built in a loop over a texture array: their names exist only as
`` `sceneNNN-impostor-${entry.name}` `` and their viewports come from the loop
index, so no per-task literal exists to rewrite.

### glTF geometry and topology

Standard double-sided materials disable culling but do not flip fragment
normals (gated by scene 145's full-resolution normal attachments). Mirrored
double-sided PBR meshes keep their authored index order and select a clockwise
front-face pipeline, preserving the `front_facing`-driven normal flip in scenes
168 and 266.

**A primitive with no `NORMAL` accessor takes the pinned `_flatNormal` path**,
which composes `normalize(cross(dpdx(worldPos), dpdy(worldPos)))`. World
position interpolates linearly across a triangle, so that expression is
constant over the face; the loader folds it by un-indexing the primitive and
baking the face normal into the three vertices each triangle then owns. Gated
by scenes 240, 246, 255, 259 and the track-clamp gate.

**Triangle strips (mode 5) expand to the triangle list they describe** as the
loader builds the index run — primitive `i` is `(i, i+1, i+2)` with odd `i`
swapped, the expansion every rasterizer performs — so triangles, winding and
submission order match what the pin hands to `topology: "triangle-strip"`.
glTF forbids an index equal to the component type's maximum precisely so
clients need not handle primitive restart, which keeps the run contiguous. The
expansion belongs to the loader rather than the pipeline because a face normal
needs each triangle to own its vertices, and scene 260 — a strip with no
`NORMAL` — needs both.

**Points (0), lines (1) and line strips (3) reach the pipeline as themselves**,
at `buildPrimitiveState`'s own fixed-function state: the topology, `cullMode:
"none"` (no faces to cull), and `stripIndexFormat` beside a line strip, which
the loader's uint32 index buffer settles. Each is one `RenderPipelineKind` per
blend state rather than per cull-and-winding combination. Three triangle-list
rules are skipped: the divisible-by-three index count, the mirrored-transform
winding swap, and the flat-normal deindex — that last a refusal rather than a
skip, since the pin's flat-normal expression needs a fragment quad with area
and a one-pixel line gives none, so a non-triangle primitive with no `NORMAL`
fails at load. LINE_LOOP (2) and TRIANGLE_FAN (6) have no WebGPU topology at
all; upstream leaves them as a triangle list, matching a legacy engine that
cannot render them either, so they are refused rather than mirrored.

Only the pinned colour pipeline carries a topology — the depth-only pipelines a
transmission grab pre-passes through, and the geometry-output tasks, are built
at a triangle list — so a scene reaching both a point-or-line primitive and one
of those passes refuses at generation. All of it rides the
`nonTrianglePrimitives` specialization flag, the predicate behind the pin's
dynamically imported `gltf-feature-primitive.js`: a scene whose assets are all
triangle lists emits a loader carrying no topology handling at all.

### Standard material inputs

**Standard bump maps compose the pin's own `normal-map-fragment`**
(`HAS_BUMP_TEXTURE`), whose `WGSL_PERTURB_NORMAL` builds the cotangent frame
from screen-space derivatives — so a mesh needs no tangent attribute — with the
interpolated normal scaled by 1 over the texture's `level` first. The pair
binds through `material_texture_slots.hpp`, whose rows append in a fixed order
(base slots, then transmission, extension, uv2-occlusion, Standard bump and 2D
reflection pairs) so no existing slot index moves when one appears. A material
with no bump map composes a variant that never declares the pair.

**Standard vertex colours follow the `enableStandardVertexColors` opt-in and
compose per mesh.** Under the opt-in a mesh carrying a colour buffer sets the
vertex-colour bit, and only its variants compose `_stdVertexColorFragment` —
the RGB multiply against the diffuse. The `vertexAlpha` half stays off because
the `mesh.hasVertexAlpha` setter is not lowered. Gated by scene 267.

**A `.babylon` light applies to the meshes its `includedOnlyMeshesIds` names**,
or to every mesh its `excludedMeshesIds` does not, resolved at load against the
records the loader creates. The per-mesh count and index selection uploaded
with each draw therefore hold the set the pinned `min(mesh.lc, MAX_LIGHTS)`
loop walks.

**Scene code names the same set through `light.includedOnlyMeshIds`, and it
folds.** The pin reads that field in exactly one place — `affectsMesh`, called
from `writeMeshLightSelection`, which packs the surviving slots into the mesh
block's `lc`/`li` — and joins it by `mesh.id`, which is the only thing that
field is read for at run time. Both sides of the join are generation-known in
the reached shape, so the set resolves to the same `LightRecord` index vector
the `.babylon` loader produces and no native code distinguishes the two
producers. Scene 111 gates it with sixteen lights over six meshes. One shape
the fold cannot represent, and refuses: an id no mesh carries. Upstream gates
on the set's own size rather than on the resolved list, so such a light
illuminates nothing, where an empty index vector here means every mesh — the
same hole the `.babylon` path has had, and closing either needs a
`has_included_meshes` lane on the record.

### glTF animation targets

`KHR_node_visibility` is materialized per mesh rather than tested per draw: the
pinned `setSubtreeVisible` writes the flag on a node and every descendant at
set time, so the loader bakes the ancestor cascade into each mesh record and
both the render path and default-camera framing test one boolean.

`KHR_animation_pointer` material targets write the record the fragment reads
back each frame — base colour factor, emissive factor, and the
`KHR_materials_emissive_strength` scalar, which folds into the emissive factor
at load so animating either half keeps both apart and redoes the product. Their
samplers are LINEAR, and the writers are gated on a scene whose animations
actually name a material. The pointer also reaches
`/nodes/N/extensions/KHR_node_visibility/visible`, whose sampler must be STEP
because interpolating a boolean has no meaning. Every other pointer fails at
load naming the pointer it could not resolve.

### Camera framing

**An animated primitive keeps local vertices** and receives its node matrix
each frame, so the box the loader accumulates is local, while a static
primitive bakes that matrix into its vertices and accumulates a world box. The
loader records the world box separately, transforming the local one through the
node matrix as `expandWorldAabbForMesh` does, so framing an animated asset
sizes it where the geometry actually is.

A scene-code `boundMin`/`boundMax` assignment replaces that side of the
object-local box before the same world transform. It is not folded into
procedural dimensions: doing so drops scene 26's tiny light-sphere override
from framing and makes the dragon visibly too large, so both optional sides
stay on `MeshRecord`.

**Orthographic cameras write the pinned reverse-Z off-centre projection term by
term**, the four planes derived from the half-extent and the render target's
aspect ratio. The pinned writer runs in doubles into a `Float32Array` cache, so
the native branch computes in double and stores float. Only the scene
projection takes that branch — environment skyboxes and grounds build their own
perspective view-projection, and generation fails on the combination. Gated by
scene 268.

## Validation policy

There is no hosted CI. A validated milestone keeps:

- renderer-specific actual, diff, hotspot, and attribution images
- renderer-specific JSON reports
- manifests, fidelity records, and provenance
- measured local thresholds in `src/scene-registry.ts`

GPU results are device-specific and must record the selected backend. Golden
images are evidence, not tuning targets: fixes must follow upstream semantics
or metadata rather than scene or pixel heuristics.

On Windows, runtime topology changes wait for GPU idle before appending
resources, and screenshot/diagnostic capture defers one frame
([architecture](architecture.md#renderer) carries the deferral contract and
its bounded grace period).
