// Property reads on the compiled surface.
//
// Every read here answers the same question -- given a handle and a
// property name, which native expression names the value -- and the
// answers differed by about three tokens each while the ceremony around
// them was copied verbatim: resolve the owning engine, index the record
// collection, carry `engineCpp` forward so a later read can resolve the
// engine again. The table below states the three tokens; `readProperty`
// holds the ceremony once.
//
// Reads that are not a field lookup stay in the compiler: `this.x`
// resolves through the instance record, a record read runs its getter, a
// tuple length and an engine's MSAA sample count come from compile-time
// metadata rather than from a native field, and `camera.target`
// synthesizes a three-component record. Those differ in what they *do*,
// not in which field they name.
import type ts from "typescript";

import type { DataType } from "./data-types.js";
import type { Feature, Value, ValueKind } from "./types.js";

/** A property the compiled surface deliberately does not serve. */
interface RefusedProperty {
  owner: ValueKind;
  property: string;
  /** Says why, and what to reach for instead. */
  unsupported: string;
}

interface PropertyRead {
  /** The value kind the owner must have. */
  owner: ValueKind;
  /** The property name as the source writes it. */
  property: string;
  /** The kind the read produces. */
  value: ValueKind;
  /**
   * Exactly one of these says where the value lives:
   *
   *   `record` -- `[collection, field]`, indexed by the owner handle
   *               through the engine it belongs to;
   *   `field`  -- a member of the owner's own expression;
   *   `helper` -- a native function that takes the owner expression;
   *   `retag`  -- the same handle under a different kind, reading
   *               nothing;
   *   `barrier`-- reads nothing and produces nothing: a property whose
   *               only meaning is "wait until this has happened", and
   *               which this runtime satisfies by construction.
   */
  record?: readonly [collection: string, field: string];
  field?: string;
  helper?: string;
  /**
   * The helper's first argument is the owning engine. A read whose
   * answer lives in a record the value only NAMES -- a pick result's
   * node, say -- needs the collection as well as the value.
   */
  helperTakesEngine?: true;
  /** The helper returns a new owning data container, not aliased storage. */
  helperReturnsFreshData?: true;
  retag?: true;
  barrier?: true;
  /**
   * Carries the owner's scene-material identity onto the value read.
   * The native read is a record field either way; this is the pin's
   * object identity, which a field read alone would drop.
   */
  carriesScenePbrMaterial?: true;
  /**
   * Carries the owner's shadow-generator identity onto the value read,
   * the same way the material rule carries its record: `light.shadowGenerator`
   * is how the corpus hands the generator to `setShadowTaskCasterMeshes`,
   * and the manifest entry is what tells generation which casters that
   * registration named.
   */
  carriesShadowGenerator?: true;
  /**
   * The pinned property is `T | undefined`, so a scene may guard on it.
   * The native handle says the same thing by carrying `invalid_handle`
   * when nothing filled the slot, which is exactly the question
   * `optionalFoundCpp` answers for a handle a search produced — a slot
   * nothing assigned and a search that matched nothing are one shape, so
   * the read publishes that field and every guard the model already
   * serves through it (`if`, `??`, a null comparison) answers.
   */
  optionalHandle?: true;
  /** Presence expression for an optional value whose owner is not a handle. */
  optionalFound?: (ownerCpp: string, engineCpp?: string) => string;
  /** Concrete storage used by a Texture2D-valued native property. */
  textureStorage?: "file";
  /** JavaScript object/typed-array truthiness for a retained native value. */
  alwaysTruthy?: true;
  /**
   * Carries the owner's `isDepthTexture` and `renderTextureSource` onto
   * the value read, for a read that names the owner's own attachment.
   */
  carriesRenderTextureAspect?: true;
  /**
   * Carries which recorded node-particle set the owner names onto the
   * value read, so the element access that follows can say which set's
   * system it took.
   */
  carriesNodeParticleSet?: true;
  /**
   * A second, constant argument to `helper`. The Web Audio parameter
   * reads are `audio_node_param(owner, AudioParamName::Gain)` -- the
   * same "a native function that takes the owner expression" shape the
   * other helpers take, plus the enumerator that says which parameter.
   */
  helperArgument?: string;
  /**
   * Carries the owner's audio context onto the value read. Web Audio
   * forbids connecting nodes across contexts and every factory is a
   * method on one, so the context travels with everything a context
   * produced.
   */
  carriesAudioContext?: true;
  /**
   * This read is a clock rather than a constant: see `Value.impure`.
   */
  impure?: true;
  /** A generated helper this property read makes reachable. */
  feature?: Feature;
  /**
   * The plain-data type this read produces, when it produces data rather
   * than a handle or a scalar the compiler models itself. Set it and the
   * value arrives as `kind: "data"`, which is what the comparison, sink
   * and binding paths consume.
   */
  dataType?: DataType;
  /**
   * Rejects an owner this read cannot serve, returning the message.
   * Runs before anything is emitted.
   */
  reject?: (owner: Value) => string | undefined;
  /**
   * The read is served only where generation cannot prove the mesh has no
   * thin-instance pool. The pool is not a handle: it is `MeshRecord`'s own
   * live count and matrix rows, so a mesh whose identity generation
   * resolved and which never reached a setter says so at its source line.
   * A mesh arriving as a runtime handle keeps the pin's own non-null
   * failure, raised by the emitted read.
   */
  requiresThinInstancePool?: true;
}

type PropertyRule = PropertyRead | RefusedProperty;

/**
 * A collection an engine handle exposes.
 *
 * Only one fact here is this port's to state: which native member holds the
 * collection, because native spellings are not the source's
 * (`angularSensitivity` is `angular_sensibility`). Everything else the
 * program already knows — the declared type says whether the property is
 * iterable and what its elements are, and `data-types.ts` already turns a
 * pinned type symbol into a handle kind and that kind into its C++ type. So a
 * further collection is one row naming a member, not a restatement of the
 * element model. User code iterating its own arrays never reaches here: that
 * is the plain-data path.
 */
export interface HandleCollectionRead {
  /** The value kind the owner must have. */
  owner: ValueKind;
  /** The property name as the source writes it. */
  property: string;
  /**
   * Where the collection lives, in the same vocabulary the property table
   * uses: `field` is a member of the owner's own expression, `record` is
   * `[collection, field]` indexed by the owner handle through its engine.
   */
  field?: string;
  record?: readonly [collection: string, field: string];
  /** The generated temporary's label, so emitted names stay stable. */
  temporaryLabel: string;
}

const handleCollections: readonly HandleCollectionRead[] = [
  {
    owner: "scene",
    property: "meshes",
    field: "meshes",
    temporaryLabel: "scene_mesh",
  },
  {
    owner: "scene",
    property: "animationGroups",
    field: "animation_groups",
    temporaryLabel: "animation_group",
  },
  {
    // The container's own groups, before addToScene registers them with
    // the scene: the same handles, read off the asset.
    owner: "asset",
    property: "animationGroups",
    record: ["assets", "animation_groups"],
    temporaryLabel: "asset_animation_group",
  },
  {
    // `getContainerMeshes(container)` flattens the container's entity
    // hierarchy to the renderable mesh nodes. The generated loader has
    // already performed that walk into AssetRecord::meshes in the same
    // document order, so the intrinsic exposes that owned collection.
    owner: "asset",
    property: "meshes",
    record: ["assets", "meshes"],
    temporaryLabel: "asset_mesh",
  },
  {
    // `AssetContainer.cameras` — see AssetRecord::cameras.
    owner: "asset",
    property: "cameras",
    record: ["assets", "cameras"],
    temporaryLabel: "asset_camera",
  },
  {
    // HierarchyInstancePool.meshes: the descendant carrier meshes, in the
    // same depth-first order createHierarchyInstancePool collected them.
    owner: "hierarchy-instance-pool",
    property: "meshes",
    record: ["hierarchy_instance_pools", "meshes"],
    temporaryLabel: "hierarchy_instance_mesh",
  },
  {
    // `AssetContainer.skeletons` — one per glTF skin instance, filled
    // only by the opt-in bone-control chunk, so a scene that never
    // called `enableBoneControl` reads the empty vector upstream leaves
    // and here alike.
    owner: "asset",
    property: "skeletons",
    record: ["assets", "skeletons"],
    temporaryLabel: "asset_skeleton",
  },
  {
    // `AssetContainer._gaussianSplats` — one cloud per GS primitive the
    // `KHR_gaussian_splatting` feature consumed. Upstream the entries are
    // promises the feature's `_sceneSetup` fills during `addToScene`; here
    // the generated loader builds each cloud and the same hook registers it,
    // so a scene reading the collection holds the attached clouds. It is
    // `@internal`, which `program.ts` restores the declaration for.
    owner: "asset",
    property: "_gaussianSplats",
    record: ["assets", "gaussian_splats"],
    temporaryLabel: "asset_gaussian_splat",
  },
];

/**
 * The `T | undefined` test for a handle: a slot nothing filled and a
 * search that matched nothing are one shape here, and both report it by
 * carrying `invalid_handle`. Spelled once, because a second spelling
 * composes differently under `??` and `!`.
 */
export function handleFoundCpp(cpp: string): string {
  return `(${cpp}.value != bbl::invalid_handle)`;
}

/** Whether any handle owner can expose a collection with this source name. */
export function isHandleCollectionProperty(property: string): boolean {
  return handleCollections.some((candidate) => candidate.property === property);
}

/** The rule in a table claiming this (owner kind, property) pair. */
/**
 * `node.<name>` for every automatable parameter the PAL serves. A node
 * and a source both carry them, so each name yields two rows -- the
 * enumerator is spelled once.
 */
const AUDIO_PARAM_NAMES: readonly (readonly [
  property: string,
  enumerator: string,
])[] = [
  ["gain", "Gain"],
  ["frequency", "Frequency"],
  ["detune", "Detune"],
  ["Q", "Q"],
  ["pan", "Pan"],
  ["playbackRate", "PlaybackRate"],
];

const AUDIO_PARAM_RULES: readonly PropertyRule[] = AUDIO_PARAM_NAMES.map(
  ([property, enumerator]) => ({
    owner: "audio-node" as const,
    property,
    value: "audio-param" as const,
    helper: "bbl::pal::audio_node_param",
    helperArgument: `bbl::pal::AudioParamName::${enumerator}`,
    carriesAudioContext: true as const,
  }),
);

function ruleFor<Rule extends { owner: ValueKind; property: string }>(
  table: readonly Rule[],
  owner: Value,
  property: string,
): Rule | undefined {
  return table.find(
    (candidate) =>
      candidate.owner === owner.kind && candidate.property === property,
  );
}

/**
 * The native expression a `record`/`field` location names. Both tables
 * speak this vocabulary, and the expression it denotes must not be spelled
 * twice.
 */
export function nativeLocation(
  rule: {
    record?: readonly [collection: string, field: string];
    field?: string;
  },
  ownerCpp: string,
  engineCpp: string,
): string {
  if (rule.record) {
    const [collection, field] = rule.record;
    return `${engineCpp}.${collection}[${ownerCpp}.value].${field}`;
  }
  return `${ownerCpp}.${rule.field!}`;
}

/**
 * The collection an expression names, or undefined when it names none — so
 * the caller can fall through to the plain-data and static-literal paths.
 */
export function readHandleCollection(
  owner: Value,
  property: string,
): HandleCollectionRead | undefined {
  return ruleFor(handleCollections, owner, property);
}

/**
 * Exported for the table-validation test beside it, which is what keeps
 * a container-returning helper from shipping without
 * `helperReturnsFreshData` -- the flag whose absence bound a C++
 * reference into a returned temporary and made a pick point alternate
 * between two values run to run.
 */
export const propertyRules: readonly PropertyRule[] = [
  // --- Display gizmos -------------------------------------------------
  // `gizmo.root` is the node the per-frame follow drives, and the one
  // member the reached slice reads: scene 223 places the hemispheric
  // gizmo by hand because a HemisphericLight has no position for the
  // follow to copy.
  {
    owner: "camera-gizmo",
    property: "root",
    value: "transform-node",
    record: ["camera_gizmos", "root"],
  },
  {
    owner: "light-gizmo",
    property: "root",
    value: "transform-node",
    record: ["light_gizmos", "root"],
  },
  // --- Vertex animation textures ---------------------------------------
  // `VatClip`'s three readonly members, off the row the bake produced.
  // The row is a native record, so these are field reads like any other
  // record's -- what the bake decided stays the bake's answer.
  {
    owner: "vat-clip",
    property: "fromRow",
    value: "number",
    field: "from_row",
  },
  {
    owner: "vat-clip",
    property: "frameCount",
    value: "number",
    field: "frame_count",
  },
  {
    owner: "vat-clip",
    property: "fps",
    value: "number",
    field: "fps",
  },
  {
    owner: "physics-aggregate",
    property: "body",
    value: "physics-body",
    field: "body",
  },
  {
    owner: "physics-aggregate",
    property: "shape",
    value: "physics-shape",
    field: "shape",
  },
  // --- Web Audio ------------------------------------------------------
  // The seam the pinned `src/audio/*.ts` reaches is the browser's API,
  // so these read like any other handle's properties: a helper that
  // takes the owner, or the same handle retagged.
  {
    // The engine handle IS the context handle: the pin's
    // `audioContext` getter returns the context it was built over,
    // and every node the scene makes belongs to it.
    owner: "audio-engine",
    property: "audioContext",
    value: "audio-context",
    retag: true,
    carriesAudioContext: true,
  },
  {
    owner: "audio-engine",
    property: "currentTime",
    value: "number",
    helper: "bbl::pal::audio_current_time",
    // The audio clock advances on the audio thread; two reads are two
    // instants. A scene binding it to a `const` means one.
    impure: true,
  },
  {
    owner: "audio-engine",
    property: "state",
    value: "data",
    helper: "bbl::pal::audio_state",
    dataType: { kind: "string" },
  },
  {
    owner: "audio-engine",
    property: "onStateChanged",
    unsupported:
      "AudioEngine.onStateChanged is an observer, and escaping callbacks are not lowered.",
  },
  {
    owner: "audio-engine",
    property: "onUserGesture",
    unsupported:
      "AudioEngine.onUserGesture is an observer, and escaping callbacks are not lowered.",
  },
  {
    owner: "audio-context",
    property: "currentTime",
    value: "number",
    helper: "bbl::pal::audio_current_time",
    // The audio clock advances on the audio thread; two reads are two
    // instants. A scene binding it to a `const` means one.
    impure: true,
  },
  {
    owner: "audio-context",
    property: "sampleRate",
    value: "number",
    helper: "bbl::pal::audio_sample_rate",
  },
  {
    owner: "audio-context",
    property: "state",
    value: "data",
    helper: "bbl::pal::audio_state",
    dataType: { kind: "string" },
  },
  {
    owner: "audio-context",
    property: "destination",
    value: "audio-node",
    helper: "bbl::pal::audio_destination",
    carriesAudioContext: true,
  },
  ...AUDIO_PARAM_RULES,
  {
    owner: "audio-param",
    property: "value",
    value: "number",
    helper: "bbl::pal::audio_param_value",
  },
  {
    // The handle itself is compile-time evidence for the structurally
    // recognized direct thin-instance upload helper below the expression
    // dispatcher. It has no native representation and exposes no general
    // device surface.
    owner: "engine",
    property: "_device",
    value: "gpu-device",
    barrier: true,
  },
  {
    owner: "gpu-device",
    property: "queue",
    unsupported:
      "Raw GPU device access is supported only inside the recognized thin-instance matrix upload helper.",
  },
  {
    owner: "engine",
    property: "scRT",
    value: "render-target",
    helper: "bbl::swapchain_render_target",
    feature: "frame-graph:resources",
  },
  {
    owner: "camera",
    property: "alpha",
    value: "number",
    record: ["cameras", "alpha"],
  },
  {
    owner: "camera",
    property: "beta",
    value: "number",
    record: ["cameras", "beta"],
  },
  {
    owner: "camera",
    property: "radius",
    value: "number",
    record: ["cameras", "radius"],
  },
  {
    owner: "camera",
    property: "fov",
    value: "number",
    record: ["cameras", "fov"],
  },
  {
    owner: "camera",
    property: "nearPlane",
    value: "number",
    record: ["cameras", "near_plane"],
  },
  {
    owner: "camera",
    property: "farPlane",
    value: "number",
    record: ["cameras", "far_plane"],
  },
  {
    owner: "camera",
    property: "speed",
    value: "number",
    record: ["cameras", "speed"],
  },
  {
    // The native record keeps upstream's spelling of the field.
    owner: "camera",
    property: "angularSensitivity",
    value: "number",
    record: ["cameras", "angular_sensibility"],
  },
  {
    // The pinned bounds object is also reachable as `camera.ortho`
    // after the opt-in.
    owner: "camera",
    property: "ortho",
    value: "camera-ortho",
    retag: true,
  },
  {
    // `set.systems` is the pin's own array, and the element access that
    // follows names one of its systems by index. The read produces the
    // set again rather than a kind of its own: what identifies a system
    // is the set plus the index, and the bake refuses an index the built
    // set has no system for.
    owner: "node-particle-set",
    property: "systems",
    value: "node-particle-set",
    retag: true,
    carriesNodeParticleSet: true,
  },
  {
    owner: "camera",
    property: "worldMatrix",
    value: "camera-world-matrix",
    retag: true,
    reject: (owner) =>
      owner.cameraKind === "arc-rotate"
        ? undefined
        : "Reached camera worldMatrix access currently requires an ArcRotateCamera.",
  },
  {
    owner: "camera-ortho",
    property: "halfHeight",
    value: "number",
    record: ["cameras", "ortho_half_height"],
  },
  {
    // The opt-in PBR setters take the material back off the mesh it
    // was assigned to (`setPbrSkybox(box.material)`), and they mutate
    // the object they are handed, so the read carries which scene
    // material the assignment stored.
    owner: "mesh",
    property: "material",
    value: "material",
    record: ["meshes", "material"],
    carriesScenePbrMaterial: true,
    // `Mesh.material` is optional upstream, and a scene walking
    // `scene.meshes` guards on it before writing a material property,
    // because a mesh the loader built without one has none.
    optionalHandle: true,
  },
  {
    // Material is the polymorphic source object, and every loader copies
    // its authored name onto it. A mapped walk over `scene.meshes` uses this
    // field to find one shared glTF material before mutating its texture.
    owner: "material",
    property: "name",
    value: "data",
    dataType: { kind: "string" },
    record: ["materials", "name"],
  },
  {
    // A loaded PBR material exposes its Texture2D objects through these five
    // public slots. `material_texture` preserves the object identity of a
    // slot while adapting the renderer's TextureData record to the common
    // StoredTexture value used by source arrays. The racer walks the names
    // through a readonly tuple, so the ordinary statically-resolved element
    // access reaches the same rows as a spelled-out property read.
    owner: "material",
    property: "baseColorTexture",
    value: "texture",
    helper: "bbl::material_texture",
    helperTakesEngine: true,
    helperArgument: "bbl::MaterialTextureSlot::base_color",
    textureStorage: "file",
    optionalFound: (ownerCpp, engineCpp) =>
      `${engineCpp}.materials[${ownerCpp}.value].base_color_texture.has_image()`,
  },
  {
    owner: "material",
    property: "normalTexture",
    value: "texture",
    helper: "bbl::material_texture",
    helperTakesEngine: true,
    helperArgument: "bbl::MaterialTextureSlot::normal",
    textureStorage: "file",
    optionalFound: (ownerCpp, engineCpp) =>
      `${engineCpp}.materials[${ownerCpp}.value].normal_texture.has_image()`,
  },
  {
    owner: "material",
    property: "ormTexture",
    value: "texture",
    helper: "bbl::material_texture",
    helperTakesEngine: true,
    helperArgument: "bbl::MaterialTextureSlot::orm",
    textureStorage: "file",
    optionalFound: (ownerCpp, engineCpp) =>
      `${engineCpp}.materials[${ownerCpp}.value].metallic_roughness_texture.has_image()`,
  },
  {
    owner: "material",
    property: "emissiveTexture",
    value: "texture",
    helper: "bbl::material_texture",
    helperTakesEngine: true,
    helperArgument: "bbl::MaterialTextureSlot::emissive",
    textureStorage: "file",
    optionalFound: (ownerCpp, engineCpp) =>
      `${engineCpp}.materials[${ownerCpp}.value].emissive_texture.has_image()`,
  },
  {
    // The separate UV2 occlusion carrier. Unlike the other four slots its
    // subsequent reached write replaces it through the dedicated setter.
    owner: "material",
    property: "occlusionTexture",
    value: "texture",
    helper: "bbl::material_texture",
    helperTakesEngine: true,
    helperArgument: "bbl::MaterialTextureSlot::occlusion",
    textureStorage: "file",
    optionalFound: (ownerCpp, engineCpp) =>
      `${engineCpp}.materials[${ownerCpp}.value].occlusion_texture.has_image()`,
  },
  {
    // The corpus creates a generator, assigns it to its light, and then
    // reads it back off the light to register the casters -- so this
    // read has to resolve the same manifest entry the assignment stored.
    owner: "light",
    property: "shadowGenerator",
    value: "shadow-generator",
    record: ["lights", "shadow_generator"],
    carriesShadowGenerator: true,
  },
  {
    owner: "gamepad",
    property: "index",
    value: "number",
    helper: "bbl::gamepad_index",
    helperTakesEngine: true,
  },
  {
    owner: "gamepad",
    property: "axes",
    value: "data",
    dataType: { kind: "vector", element: { kind: "number" } },
    helper: "bbl::gamepad_axes",
    helperTakesEngine: true,
    helperReturnsFreshData: true,
  },
  {
    owner: "gamepad",
    property: "buttons",
    value: "data",
    dataType: {
      kind: "vector",
      element: { kind: "handle", handle: "gamepad-button" },
    },
    helper: "bbl::gamepad_buttons",
    helperTakesEngine: true,
    helperReturnsFreshData: true,
  },
  {
    owner: "gamepad-button",
    property: "pressed",
    value: "boolean",
    helper: "bbl::gamepad_button_pressed",
    helperTakesEngine: true,
  },
  {
    // Read as plain data, which is what lets `g.name !== "swimming"`
    // compile through the ordinary comparison path.
    owner: "animation-group",
    property: "name",
    value: "data",
    dataType: { kind: "string" },
    record: ["animation_groups", "name"],
  },
  {
    // The `_camera` loader feature names each imported camera
    // `def.name ?? camera<index>`; a scene-created camera carries the
    // record default, the empty string, which no equality against a
    // scene's literal matches — the pin's undefined compares the same
    // way. This read is what the `.find` search loop tests.
    owner: "camera",
    property: "name",
    value: "data",
    dataType: { kind: "string" },
    record: ["cameras", "name"],
  },
  {
    // A pick answers with the id it read out of the one-pixel target,
    // so `hit` is a field of the value rather than a lookup.
    owner: "picking-info",
    property: "hit",
    value: "data",
    dataType: { kind: "boolean" },
    field: "hit",
  },
  {
    // Upstream `pickedMesh` is the node object itself, and both kinds
    // that can be hit carry a name. This port keeps meshes and clouds
    // in separate collections, so the pick resolves the identity once
    // and the value carries it: the retag reads nothing, and the one
    // member the reached slice asks for is below.
    owner: "picking-info",
    property: "pickedMesh",
    value: "picked-node",
    retag: true,
    optionalFound: (ownerCpp) =>
      `(${ownerCpp}.picked_kind != bbl::PickedNodeKind::none)`,
  },
  {
    owner: "picked-node",
    property: "name",
    value: "data",
    dataType: { kind: "string" },
    helper: "bbl::picked_node_name",
    helperTakesEngine: true,
  },
  {
    owner: "picking-info",
    property: "pickedPoint",
    value: "data",
    dataType: {
      kind: "optional",
      inner: { kind: "tuple", arity: 3 },
    },
    helper: "bbl::picked_point",
    // `picked_point` BUILDS its nullable from the record's own array, so
    // the value is owned rather than aliased storage. Without this a
    // `const point = info.pickedPoint` after the pin's own null guard
    // binds a C++ reference into the helper's returned temporary and
    // reads freed memory afterwards -- which scene 113 caught as a pick
    // point that alternated between two values run to run while every
    // input to it stayed bit-identical.
    helperReturnsFreshData: true,
  },
  {
    // The pinned Mesh name — see MeshRecord::name for who fills it.
    owner: "mesh",
    property: "name",
    value: "data",
    dataType: { kind: "string" },
    record: ["meshes", "name"],
  },
  {
    // TransformNode is the pin's SceneNode alias and carries the factory name
    // exactly like Mesh does.
    owner: "transform-node",
    property: "name",
    value: "data",
    dataType: { kind: "string" },
    record: ["transform_nodes", "name"],
  },
  {
    // Node.parent is the same nullable object reference installed by
    // setParent; the zero handle is the native null state.
    owner: "mesh",
    property: "parent",
    value: "mesh",
    record: ["meshes", "parent"],
    optionalHandle: true,
    feature: "mesh:parenting",
  },
  {
    owner: "mesh",
    property: "_cpuPositions",
    value: "data",
    dataType: { kind: "f32array" },
    helper: "bbl::mesh_cpu_positions",
    helperTakesEngine: true,
    helperReturnsFreshData: true,
    alwaysTruthy: true,
    feature: "mesh:geometry-access",
  },
  {
    owner: "mesh",
    property: "_cpuNormals",
    value: "data",
    dataType: { kind: "f32array" },
    helper: "bbl::mesh_cpu_normals",
    helperTakesEngine: true,
    helperReturnsFreshData: true,
    alwaysTruthy: true,
    feature: "mesh:geometry-access",
  },
  {
    owner: "mesh",
    property: "_cpuUvs",
    value: "data",
    dataType: { kind: "f32array" },
    helper: "bbl::mesh_cpu_uvs",
    helperTakesEngine: true,
    helperReturnsFreshData: true,
    alwaysTruthy: true,
    feature: "mesh:geometry-access",
  },
  {
    owner: "mesh",
    property: "_cpuIndices",
    value: "data",
    dataType: { kind: "u32array" },
    helper: "bbl::mesh_cpu_indices",
    helperTakesEngine: true,
    helperReturnsFreshData: true,
    alwaysTruthy: true,
    feature: "mesh:geometry-access",
  },
  {
    owner: "mesh",
    property: "worldMatrix",
    value: "data",
    // Each lane is already rounded by the pin's Float32Array store.
    // The native container uses the common JS-number width so an
    // ArrayLike<number> helper can accept it alongside number[].
    dataType: { kind: "vector", element: { kind: "number" } },
    helper: "bbl::mesh_world_matrix_array",
    helperTakesEngine: true,
    helperReturnsFreshData: true,
    alwaysTruthy: true,
    feature: "mesh:geometry-access",
  },
  {
    owner: "mesh",
    property: "boundMin",
    value: "data",
    dataType: { kind: "vector", element: { kind: "number" } },
    helper: "bbl::mesh_bound_min_array",
    helperTakesEngine: true,
    helperReturnsFreshData: true,
    alwaysTruthy: true,
    feature: "mesh:geometry-access",
  },
  {
    owner: "mesh",
    property: "boundMax",
    value: "data",
    dataType: { kind: "vector", element: { kind: "number" } },
    helper: "bbl::mesh_bound_max_array",
    helperTakesEngine: true,
    helperReturnsFreshData: true,
    alwaysTruthy: true,
    feature: "mesh:geometry-access",
  },
  {
    // src/mesh/thin-instance.ts ThinInstanceData. The pool is state on the
    // mesh record rather than a handle of its own, so the read retags the
    // mesh and the member below resolves against it.
    owner: "mesh",
    property: "thinInstances",
    value: "thin-instance-pool",
    retag: true,
    requiresThinInstancePool: true,
    feature: "mesh:thin-instances",
  },
  {
    // `ti.count` — the ACTIVE instance count, which every pinned helper
    // moves (add appends, remove swap-removes, the count setter assigns).
    // Read live off the record so a source that computes the last slot
    // from it sees what the previous call left.
    owner: "thin-instance-pool",
    property: "count",
    value: "number",
    helper: "bbl::thin_instance_count",
    helperTakesEngine: true,
    feature: "mesh:thin-instances-dynamic",
  },
  {
    // `ySort.enabled` — sprite-2d-y-sort.ts keeps the flag on the state it
    // returns, and `disableSprite2DYSort` is the only thing that clears it,
    // in the same call that detaches the state from its layer. So the live
    // question the port asks the layer is the same one, and reading it
    // rather than folding true is what keeps a scene that later disables
    // its layer honest.
    owner: "sprite-2d-y-sort",
    property: "enabled",
    value: "boolean",
    helper: "bbl::sprite_2d_y_sort_enabled",
    helperTakesEngine: true,
    feature: "sprite:2d-y-sort",
  },
  {
    owner: "hierarchy-instance-pool",
    property: "count",
    value: "number",
    record: ["hierarchy_instance_pools", "count"],
    feature: "mesh:thin-instances-dynamic",
  },
  {
    owner: "scene",
    property: "clearColor",
    value: "color4",
    field: "clear_color",
  },
  {
    owner: "scene",
    property: "camera",
    value: "camera",
    field: "camera",
    // SceneContext.camera is Camera | null and an empty native scene carries
    // invalid_handle. Publish the same presence contract as optional mesh and
    // material handles so bindings, guards, ??, and null comparisons all test
    // the handle before any camera-record access.
    optionalHandle: true,
  },
  {
    // The pin exposes this only as an internal lifecycle sentinel: removal
    // arms it and a successful registration/rebuild clears it. Native's
    // topology version applies the rebuild synchronously at the next frame,
    // but retains the same observable pending/applied state.
    owner: "scene",
    property: "_rebuildHook",
    value: "boolean",
    field: "topology_rebuild_pending",
  },
  {
    owner: "render-target-texture",
    property: "rt",
    value: "render-target",
    field: "rt",
  },
  {
    // `loadSplat`'s promise that the sort worker has produced its first
    // depth order. This runtime has no worker: the sort runs on the
    // frame's own thread before the draw that reads it
    // (`postSplatSortIfDirty` + `uploadPendingSplatOrder`, both in the
    // renderable's update hook), so every frame is already the state
    // this await is waiting for. Reached rather than ignored, so a
    // scene that never waits is not silently given the same guarantee.
    owner: "splat-mesh",
    property: "firstSortReady",
    value: "void",
    barrier: true,
  },
  {
    // Which attachment `rtt.ts` hands back is the target's own fact,
    // decided by the format it declared; the texture read off it is
    // that attachment, so it inherits the answer rather than being
    // asked again downstream.
    owner: "render-target-texture",
    property: "texture",
    value: "render-texture",
    field: "texture",
    carriesRenderTextureAspect: true,
  },
];

/**
 * The native field a camera property stores into, or undefined when the
 * property is not one of them.
 *
 * Writes go through `assignments.ts`, but they name the same fields, and
 * the map used to be restated at each write site: `camera.speed = 2`
 * compiled while `scene.camera.speed = 2` was refused as an unsupported
 * camera property, purely because one copy listed fewer names than the
 * other. Reads and writes now agree by construction.
 */
export function cameraRecordField(property: string): string | undefined {
  const rule = propertyRules.find(
    (candidate) =>
      candidate.owner === "camera" &&
      candidate.property === property &&
      "record" in candidate,
  );
  return rule && "record" in rule ? rule.record?.[1] : undefined;
}

/**
 * The compiler surface `readProperty` needs. Kept to what a field lookup
 * uses, so the table cannot grow a dependency on statement lowering.
 */
export interface PropertyContext {
  requireEngine(value: Value, node: ts.Node): string;
  reachFeature(feature: Feature, site: ts.Node): void;
  fail(node: ts.Node, message: string): never;
  /** Whether generation has seen a thin-instance pool set on this mesh. */
  meshHasThinInstancePool(owner: Value): boolean;
}

/**
 * Resolves a declared property read, or returns undefined when no rule
 * claims the pair, so the caller can try the readings that are not field
 * lookups.
 */
export function readProperty(
  context: PropertyContext,
  owner: Value,
  property: string,
  /**
   * Where to report a refusal. Usually the property access, but a
   * destructuring element names the same properties.
   */
  expression: ts.Node,
): Value | undefined {
  const rule = ruleFor(propertyRules, owner, property);
  if (!rule) {
    return undefined;
  }
  if ("unsupported" in rule) {
    context.fail(expression, rule.unsupported);
  }
  const rejection = rule.reject?.(owner);
  if (rejection) {
    context.fail(expression, rejection);
  }
  if (
    rule.requiresThinInstancePool &&
    !context.meshHasThinInstancePool(owner)
  ) {
    context.fail(
      expression,
      `Reading '${property}' requires a thin-instance pool this mesh ` +
        "never establishes; bind one with setThinInstances or " +
        "addThinInstance first.",
    );
  }
  if (rule.feature) {
    context.reachFeature(rule.feature, expression);
  }
  // An engine handle names itself; anything else carries the engine it
  // was created from, so the value read out of it stays resolvable.
  const engineCpp = owner.kind === "engine" ? owner.cpp : owner.engineCpp;
  const shadowGeneratorIndex =
    owner.kind === "light"
      ? owner.lightIdentity?.shadowGeneratorIndex
      : owner.shadowGeneratorIndex;
  const read = (cpp: string): Value => ({
    kind: rule.value,
    cpp,
    ...(rule.dataType ? { dataType: rule.dataType } : {}),
    ...(rule.textureStorage
      ? { textureStorage: rule.textureStorage }
      : {}),
    ...(engineCpp ? { engineCpp } : {}),
    ...(rule.carriesScenePbrMaterial &&
    owner.scenePbrMaterialIndex !== undefined
      ? {
          scenePbrMaterialIndex: owner.scenePbrMaterialIndex,
        }
      : {}),
    ...(rule.carriesScenePbrMaterial && owner.standardMaterial
      ? { standardMaterial: true as const }
      : {}),
    ...(rule.carriesScenePbrMaterial &&
    owner.kind === "mesh" &&
    owner.sceneMeshIndex === undefined &&
    owner.scenePbrMaterialIndex === undefined &&
    !owner.standardMaterial
      ? {
          assetPbrMaterial: true as const,
          // The container a proven whole-list walk is visiting, when this
          // mesh came from one. A loaded material has no scene-side record
          // to stamp, so this is the only compile-time identity a setter
          // reaching it has: the document whose materials compose.
          ...(owner.assetWholeMeshList
            ? { assetWholeMeshList: owner.assetWholeMeshList }
            : {}),
        }
      : {}),
    ...(rule.carriesShadowGenerator && shadowGeneratorIndex !== undefined
      ? { shadowGeneratorIndex }
      : {}),
    ...(rule.carriesNodeParticleSet && owner.nodeParticleSetIndex !== undefined
      ? { nodeParticleSetIndex: owner.nodeParticleSetIndex }
      : {}),
    ...(rule.carriesAudioContext
      ? {
          audioContextCpp: owner.audioContextCpp ?? owner.cpp,
        }
      : {}),
    ...(rule.impure ? { impure: true as const } : {}),
    ...(rule.optionalHandle
      ? {
          optionalFoundCpp: handleFoundCpp(cpp),
        }
      : {}),
    ...(rule.optionalFound
      ? { optionalFoundCpp: rule.optionalFound(owner.cpp, engineCpp) }
      : {}),
    ...(rule.alwaysTruthy ? { truthinessCpp: "true" } : {}),
    ...(rule.helperReturnsFreshData
      ? { freshData: true as const }
      : {}),
    ...(rule.carriesRenderTextureAspect
      ? {
          ...(owner.isDepthTexture
            ? { isDepthTexture: owner.isDepthTexture }
            : {}),
          ...(owner.renderTextureSource
            ? {
                renderTextureSource: owner.renderTextureSource,
              }
            : {}),
        }
      : {}),
  });
  if (rule.record || rule.field) {
    return read(
      nativeLocation(
        rule,
        owner.cpp,
        rule.record ? context.requireEngine(owner, expression) : "",
      ),
    );
  }
  if (rule.helper) {
    const engine = rule.helperTakesEngine
      ? `${context.requireEngine(owner, expression)}, `
      : "";
    return read(
      rule.helperArgument
        ? `${rule.helper}(${engine}${owner.cpp}, ${rule.helperArgument})`
        : `${rule.helper}(${engine}${owner.cpp})`,
    );
  }
  if (rule.barrier) {
    return read("");
  }
  return read(owner.cpp);
}
