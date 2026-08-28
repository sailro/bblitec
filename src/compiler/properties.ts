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
        // `AssetContainer.cameras` — see AssetRecord::cameras.
        owner: "asset",
        property: "cameras",
        record: ["assets", "cameras"],
        temporaryLabel: "asset_camera",
    },
];

/** Whether any handle owner can expose a collection with this source name. */
export function isHandleCollectionProperty(
    property: string,
): boolean {
    return handleCollections.some(
        (candidate) => candidate.property === property,
    );
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
];

const AUDIO_PARAM_RULES: readonly PropertyRule[] =
    AUDIO_PARAM_NAMES.map(([property, enumerator]) => ({
        owner: "audio-node" as const,
        property,
        value: "audio-param" as const,
        helper: "bbl::pal::audio_node_param",
        helperArgument: `bbl::pal::AudioParamName::${enumerator}`,
        carriesAudioContext: true as const,
    }));

function ruleFor<Rule extends { owner: ValueKind; property: string }>(
    table: readonly Rule[],
    owner: Value,
    property: string,
): Rule | undefined {
    return table.find(
        (candidate) =>
            candidate.owner === owner.kind &&
            candidate.property === property,
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

const propertyRules: readonly PropertyRule[] = [
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
        // The pinned Mesh name — see MeshRecord::name for who fills it.
        owner: "mesh",
        property: "name",
        value: "data",
        dataType: { kind: "string" },
        record: ["meshes", "name"],
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
export function cameraRecordField(
    property: string,
): string | undefined {
    const rule = propertyRules.find(
        (candidate) =>
            candidate.owner === "camera" &&
            candidate.property === property &&
            "record" in candidate,
    );
    return rule && "record" in rule
        ? rule.record?.[1]
        : undefined;
}

/**
 * The compiler surface `readProperty` needs. Kept to what a field lookup
 * uses, so the table cannot grow a dependency on statement lowering.
 */
export interface PropertyContext {
    requireEngine(value: Value, node: ts.Node): string;
    reachFeature(feature: Feature, site: ts.Node): void;
    fail(node: ts.Node, message: string): never;
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
    if (rule.feature) {
        context.reachFeature(rule.feature, expression);
    }
    // An engine handle names itself; anything else carries the engine it
    // was created from, so the value read out of it stays resolvable.
    const engineCpp =
        owner.kind === "engine"
            ? owner.cpp
            : owner.engineCpp;
    const read = (cpp: string): Value => ({
        kind: rule.value,
        cpp,
        ...(rule.dataType ? { dataType: rule.dataType } : {}),
        ...(engineCpp ? { engineCpp } : {}),
        ...(rule.carriesScenePbrMaterial &&
        owner.scenePbrMaterialIndex !== undefined
            ? {
                  scenePbrMaterialIndex:
                      owner.scenePbrMaterialIndex,
              }
            : {}),
        ...(rule.carriesScenePbrMaterial && owner.standardMaterial
            ? { standardMaterial: true as const }
            : {}),
        ...(rule.carriesShadowGenerator &&
        owner.shadowGeneratorIndex !== undefined
            ? { shadowGeneratorIndex: owner.shadowGeneratorIndex }
            : {}),
        ...(rule.carriesNodeParticleSet &&
        owner.nodeParticleSetIndex !== undefined
            ? { nodeParticleSetIndex: owner.nodeParticleSetIndex }
            : {}),
        ...(rule.carriesAudioContext
            ? {
                  audioContextCpp:
                      owner.audioContextCpp ?? owner.cpp,
              }
            : {}),
        ...(rule.impure ? { impure: true as const } : {}),
        ...(rule.carriesRenderTextureAspect
            ? {
                  ...(owner.isDepthTexture
                      ? { isDepthTexture: owner.isDepthTexture }
                      : {}),
                  ...(owner.renderTextureSource
                      ? {
                            renderTextureSource:
                                owner.renderTextureSource,
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
                rule.record
                    ? context.requireEngine(owner, expression)
                    : "",
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
