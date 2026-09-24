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
// Reads that are not a field lookup are `PropertyAccessLowerer`'s, below:
// `this.x` resolves through the instance record, a record read runs its
// getter, a tuple length and an engine's MSAA sample count come from
// compile-time metadata rather than from a native field, and
// `camera.target` synthesizes a three-component record. Those differ in
// what they *do*, not in which field they name.
import ts from "typescript";
import { doubleLiteral } from "../cpp-literals.js";
import {
    compositeScalarAccessors,
    compositeScalarFunction,
} from "../lowering/post-process-accessors.js";
import { screenSpaceFacts } from "../pinned-screen-space.js";
import { sceneNodeTransformDescriptor } from "../scene-node-transform-descriptor.js";
import { readPngDimensionsSync } from "./asset-bytes-sync.js";
import {
    cameraVectorProperties,
    sceneNodeVectorProperties,
    type BindingScopes,
} from "./binding-scopes.js";
import {
    browserDeploymentValue,
    browserEnvironmentPropertyValue,
    type BrowserGlobalContext,
} from "./browser-erasure.js";
import {
    compileBrowserFileProperty,
    type BrowserFileContext,
} from "./browser-file.js";
import {
    compileCanvasValue,
    readMediaQueryProperty,
    type CanvasContext,
} from "./canvas.js";
import { renderClosure } from "./closure-captures.js";
import { handleCppType, type DataType } from "./data-types.js";
import { EmissionMap } from "./emission-transaction.js";
import { engineSampleCountCpp } from "./engine-samples.js";
import { httpResponseProperty } from "./http.js";
import { readCharacterProperty } from "./intrinsics/character-controller.js";
import { geometryEnumMember } from "./intrinsics/engine-options.js";
import type { PhysicsIntrinsicContext } from "./intrinsics/physics.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    readNodeInputProperty,
    type NodeInputContext,
} from "./node-input-surface.js";
import { readFrozenParticleProperty } from "./particle-buffer.js";
import { recordAt } from "./record-access.js";
import { staticFetchProperty } from "./static-fetch.js";
import { isAssignmentOperator } from "./syntax.js";
import { readTextProperty, type TextSurfaceContext } from "./text-surface.js";
import {
    optionalPresentCpp,
    valueForKind,
    type Feature,
    type GeometryOutputTaskManifest,
    type GeometryTextureTypeName,
    type Value,
    type ValueKind,
} from "./types.js";
import type { UiProjection } from "./ui-projection.js";
import type { WindowProperties } from "./window-properties.js";

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
    /** The helper returns an owning data wrapper by value; backing storage may be shared. */
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
    textureStorage?: "file" | "stored";
    /** JavaScript object/typed-array truthiness for a retained native value. */
    alwaysTruthy?: true;
    /**
     * Carries the owner's `isDepthTexture` and `renderTextureSource` onto
     * the value read, for a read that names the owner's own attachment.
     */
    carriesRenderTextureAspect?: true;
    renderTextureAspect?: "depth";
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
    /** The native scalar field uses std::optional rather than js::Nullable. */
    nativeOptionalScalar?: "double" | "bool";
    /** A producer whose optional native carrier is statically known present. */
    knownPresent?: (owner: Value) => boolean;
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
interface HandleCollectionRead {
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
        // `container.flowGraphRuntimes`: the KHR_interactivity runtimes
        // addToScene attached for this asset, one per graph, in graph order.
        // Upstream a promise of the array; here the attach is synchronous, so
        // the awaited read is the asset record's own list.
        owner: "asset",
        property: "flowGraphRuntimes",
        record: ["assets", "flow_graph_runtimes"],
        temporaryLabel: "flow_graph_runtime",
    },
    {
        // `container.flowGraphs`: the graphs the document declares, parsed at
        // load, one handle per graph in graph order.
        owner: "asset",
        property: "flowGraphs",
        record: ["assets", "flow_graphs"],
        temporaryLabel: "flow_graph",
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
    ["playbackRate", "PlaybackRate"],
];

const AUDIO_PARAM_RULES: readonly PropertyRule[] = AUDIO_PARAM_NAMES.map(
    ([property, enumerator]) => ({
        owner: "audio-node" as const,
        property,
        value: "audio-param" as const,
        helper: "bbl::pal::audio_node_param",
        helperArgument: `bbl::pal::AudioParamName::${enumerator}`,
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
        return `${recordAt(`${engineCpp}.${collection}`, ownerCpp)}.${field}`;
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
    {
        owner: "compute-dispatch",
        property: "enabled",
        value: "boolean",
        helper: "bbl::compute_dispatch_enabled",
    },
    {
        owner: "compute-dispatch",
        property: "shader",
        value: "compute-shader",
        helper: "bbl::compute_dispatch_shader",
    },
    {
        owner: "compute-dispatch",
        property: "bindings",
        value: "compute-binding-set",
        helper: "bbl::compute_dispatch_bindings",
    },
    {
        owner: "compute-shader",
        property: "name",
        value: "string",
        helper: "bbl::compute_shader_name",
    },
    {
        owner: "compute-shader",
        property: "_destroyed",
        value: "boolean",
        helper: "bbl::compute_shader_destroyed",
    },
    {
        owner: "compute-binding-decl",
        property: "name",
        value: "string",
        helper: "bbl::compute_binding_name",
    },
    {
        owner: "compute-binding-decl",
        property: "group",
        value: "number",
        helper: "bbl::compute_binding_group",
    },
    {
        owner: "compute-binding-decl",
        property: "binding",
        value: "number",
        helper: "bbl::compute_binding_index",
    },
    {
        owner: "compute-uniform-writer",
        property: "slot",
        value: "number",
        helper: "bbl::compute_uniform_writer_slot",
    },
    {
        owner: "compute-uniform-writer",
        property: "arena",
        value: "compute-uniform-arena",
        helper: "bbl::compute_uniform_writer_arena",
    },
    {
        owner: "compute-uniform-writer",
        property: "layout",
        value: "compute-uniform-layout",
        helper: "bbl::compute_uniform_writer_layout",
    },

    {
        owner: "compute-uniform-arena",
        property: "slotByteLength",
        value: "number",
        helper: "bbl::compute_uniform_arena_slot_byte_length",
    },
    {
        owner: "compute-uniform-arena",
        property: "slotStride",
        value: "number",
        helper: "bbl::compute_uniform_arena_slot_stride",
    },
    {
        owner: "compute-uniform-arena",
        property: "slotCount",
        value: "number",
        helper: "bbl::compute_uniform_arena_slot_count",
    },
    {
        owner: "compute-uniform-arena",
        property: "_destroyed",
        value: "boolean",
        helper: "bbl::compute_uniform_arena_destroyed",
    },
    {
        owner: "compute-uniform-arena",
        property: "buffer",
        value: "uniform-buffer",
        helper: "bbl::compute_uniform_arena_buffer",
    },

    {
        owner: "uniform-buffer",
        property: "byteLength",
        value: "number",
        helper: "bbl::uniform_buffer_byte_length",
    },
    {
        owner: "uniform-buffer",
        property: "_destroyed",
        value: "boolean",
        helper: "bbl::uniform_buffer_destroyed",
    },
    {
        owner: "compute-uniform-layout",
        property: "byteLength",
        value: "number",
        helper: "bbl::compute_uniform_layout_byte_length",
    },
    {
        owner: "compute-task",
        property: "name",
        value: "string",
        helper: "bbl::compute_task_name",
    },
    {
        owner: "compute-one-shot",
        property: "completion",
        value: "promise",
        dataType: { kind: "promise" },
        helper: "bbl::compute_one_shot_completion",
        feature: "compute:one-shot",
    },
    {
        owner: "task",
        property: "executionEnabled",
        value: "data",
        dataType: { kind: "optional", inner: { kind: "boolean" } },
        record: ["frame_tasks", "execution_enabled"],
        nativeOptionalScalar: "bool",
    },
    {
        owner: "compute-task",
        property: "executionEnabled",
        value: "boolean",
        helper: "bbl::compute_task_execution_enabled",
    },
    {
        owner: "compute-task",
        property: "_disposed",
        value: "boolean",
        helper: "bbl::compute_task_disposed",
    },
    {
        owner: "compute-task",
        property: "dispose",
        value: "data",
        dataType: { kind: "function", parameters: [], identity: true },
        helper: "bbl::compute_task_dispose",
        helperReturnsFreshData: true,
    },
    {
        owner: "compute-task",
        property: "record",
        value: "data",
        dataType: { kind: "function", parameters: [], identity: true },
        helper: "bbl::compute_task_record",
        helperReturnsFreshData: true,
        feature: "compute:task-execution",
    },
    ...(["width", "height", "depthOrArrayLayers"] as const).map(
        (property): PropertyRead => ({
            owner: "compute-storage-texture",
            property,
            value: "number",
            helper: `bbl::compute_storage_texture_${property}`,
        }),
    ),
    {
        owner: "compute-storage-texture",
        property: "_destroyed",
        value: "boolean",
        helper: "bbl::compute_storage_texture_destroyed",
    },
    {
        owner: "compute-storage-texture",
        property: "sampledTexture",
        value: "texture",
        textureStorage: "file",
        helper: "bbl::compute_storage_texture_sampled_texture",
        optionalFound: (owner) =>
            optionalPresentCpp(`(${owner})->sampled_texture`),
    },
    {
        owner: "compute-storage-texture",
        property: "computeTexture",
        value: "compute-texture-resource",
        helper: "bbl::compute_storage_texture_compute_texture",
        optionalFound: (owner) =>
            `static_cast<bool>((${owner})->compute_texture)`,
    },
    {
        owner: "compute-storage-texture",
        property: "computeSampler",
        value: "compute-sampler",
        helper: "bbl::compute_storage_texture_compute_sampler",
        optionalFound: (owner) =>
            `static_cast<bool>((${owner})->compute_sampler)`,
    },
    ...(["platform-mouse-event", "platform-keyboard-event"] as const).map(
        (owner): PropertyRead => ({
            owner,
            property: "persisted",
            value: "data",
            helper: "bbl::dom_event_persisted",
            dataType: {
                kind: "optional",
                inner: { kind: "boolean" },
                undefinedOnly: true,
            },
        }),
    ),
    // --- Flow graphs ----------------------------------------------------
    // A container's declared graphs and attached runtimes are handles into
    // the generated graph; the pin's records behind them stay at generation.
    {
        owner: "flow-graph",
        property: "accessors",
        unsupported:
            "A loaded flow graph's accessor records (path-converter.ts) stay at " +
            "generation: pointer reads and writes are lowered into the generated " +
            "graph, and scene code reads the node or material state they target.",
    },
    {
        owner: "flow-graph-runtime",
        property: "context",
        unsupported:
            "A flow-graph runtime's context (its variables and slots) is the " +
            "generated graph's own state; scene code observes the graph through " +
            "what it drives.",
    },
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
        impure: true,
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
    },
    ...AUDIO_PARAM_RULES,
    ...(
        [
            ["duration", "Duration"],
            ["length", "Length"],
            ["sampleRate", "SampleRate"],
            ["numberOfChannels", "NumberOfChannels"],
        ] as const
    ).map(([property, member]): PropertyRead => ({
        owner: "audio-buffer",
        property,
        value: "number",
        helper: "bbl::pal::audio_buffer_property",
        helperArgument: `bbl::pal::AudioBufferProperty::${member}`,
        feature: "audio:buffer-source",
    })),
    {
        owner: "audio-node",
        property: "buffer",
        value: "data",
        helper: "bbl::pal::audio_source_buffer",
        helperReturnsFreshData: true,
        dataType: {
            kind: "optional",
            inner: { kind: "handle", handle: "audio-buffer" },
        },
        feature: "audio:buffer-source",
        impure: true,
    },
    {
        owner: "audio-param",
        property: "value",
        value: "number",
        helper: "bbl::pal::audio_param_value",
    },
    {
        // Device generation is observable by recovery. Queue uploads still
        // use their structurally checked transport instead of exposing a GPU API.
        owner: "engine",
        property: "_device",
        value: "gpu-device",
        helper: "bbl::gpu_device_identity",
        impure: true,
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
        owner: "camera",
        property: "_yaw",
        value: "number",
        record: ["cameras", "free_yaw"],
    },
    {
        owner: "camera",
        property: "_pitch",
        value: "number",
        record: ["cameras", "free_pitch"],
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
    },
    {
        owner: "camera",
        property: "worldMatrixVersion",
        value: "number",
        record: ["cameras", "world_matrix_version"],
        feature: "camera:world-matrix-version",
    },
    {
        owner: "camera-ortho",
        property: "halfHeight",
        value: "number",
        record: ["cameras", "ortho_half_height"],
    },
    {
        owner: "mesh",
        property: "_topology",
        value: "data",
        dataType: { kind: "optional", inner: { kind: "number" } },
        record: ["meshes", "topology_index"],
        nativeOptionalScalar: "double",
    },
    {
        owner: "mesh",
        property: "_primitiveFeatures",
        value: "data",
        dataType: { kind: "optional", inner: { kind: "number" } },
        record: ["meshes", "primitive_features"],
        nativeOptionalScalar: "double",
    },
    {
        // The read retains the identity assigned to this mesh.
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
        // Albedo reads retain the actual producer arm and Texture2D identity.
        owner: "material",
        property: "baseColorTexture",
        value: "texture",
        textureStorage: "stored",
        helper: "bbl::material_source_texture",
        feature: "material:source-texture-read",
        helperTakesEngine: true,
        helperArgument: "bbl::MaterialTextureSlot::base_color",
        dataType: { kind: "handle", handle: "texture" },
        optionalFound: (ownerCpp, engineCpp) =>
            `bbl::material_texture_present(${engineCpp}, ${ownerCpp}, bbl::MaterialTextureSlot::base_color)`,
    },
    ...(
        [
            ["baseColorFactor", "base_color_factor"],
            ["diffuseColor", "diffuse_color"],
        ] as const
    ).map(([property, slot]): PropertyRead => ({
        owner: "material",
        property,
        value: "data",
        dataType: {
            kind: "optional",
            inner: { kind: "vector", element: { kind: "number" } },
        },
        helper: "bbl::material_color",
        helperTakesEngine: true,
        helperArgument: `bbl::MaterialColorSlot::${slot}`,
        helperReturnsFreshData: true,
        ...(property === "diffuseColor"
            ? {
                  knownPresent: (owner: Value) =>
                      owner.standardMaterial === true,
              }
            : {}),
    })),
    {
        owner: "material",
        property: "diffuseTexture",
        value: "texture",
        textureStorage: "stored",
        helper: "bbl::material_source_texture",
        feature: "material:source-texture-read",
        helperTakesEngine: true,
        helperArgument: "bbl::MaterialTextureSlot::diffuse",
        dataType: { kind: "handle", handle: "texture" },
        optionalFound: (ownerCpp, engineCpp) =>
            `bbl::material_texture_present(${engineCpp}, ${ownerCpp}, bbl::MaterialTextureSlot::diffuse)`,
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
            `${recordAt(`${engineCpp}.materials`, ownerCpp)}.normal_texture.has_image()`,
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
            `${recordAt(`${engineCpp}.materials`, ownerCpp)}.metallic_roughness_texture.has_image()`,
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
            `${recordAt(`${engineCpp}.materials`, ownerCpp)}.emissive_texture.has_image()`,
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
            `${recordAt(`${engineCpp}.materials`, ownerCpp)}.occlusion_texture.has_image()`,
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
    ...(
        [
            ["duration", "duration"],
            ["frameRate", "frame_rate"],
        ] as const
    ).map(([property, field]): PropertyRead => ({
        owner: "animation-group",
        property,
        value: "number",
        record: ["animation_groups", field],
    })),
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
    ...(["bu", "bv"] as const).map((field): PropertyRead => ({
        owner: "picking-info",
        property: field,
        value: "data",
        dataType: { kind: "number" },
        field,
    })),
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
        owner: "asset-root",
        property: "worldMatrix",
        value: "data",
        dataType: { kind: "vector", element: { kind: "number" } },
        helper: "bbl::asset_root_world_matrix_array",
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
        owner: "splat-mesh",
        property: "splatsData",
        value: "data",
        dataType: { kind: "arraybuffer" },
        helper: "bbl::splat_data",
        helperTakesEngine: true,
        helperReturnsFreshData: true,
        feature: "loader:splat-data",
        alwaysTruthy: true,
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
    {
        owner: "render-target-texture",
        property: "depthTexture",
        value: "render-texture",
        field: "depth_texture",
        renderTextureAspect: "depth",
        optionalFound: (owner) =>
            `${owner}.depth_texture.target.value != bbl::invalid_handle`,
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
    if (property === "worldMatrixVersion") return undefined;
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
export interface PropertyContext extends Pick<
    LoweringServices,
    | "requireEngine"
    | "reachFeature"
    | "reachJsData"
    | "noteMaterialColorRead"
    | "fail"
    | "sceneManifest"
    | "dataValue"
> {}

/**
 * Resolves a declared property read, or returns undefined when no rule
 * claims the pair, so the caller can try the readings that are not field
 * lookups.
 */
export function readCallableProperty(
    context: PropertyContext,
    owner: Value,
    property: string,
    expression: ts.Node,
): Value | undefined {
    const rule = ruleFor(propertyRules, owner, property);
    if (!rule || !("dataType" in rule) || rule.dataType?.kind !== "function")
        return undefined;
    return readProperty(context, owner, property, expression);
}

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
    if (owner.kind === "task" && owner.postProcessComposite) {
        const composite = owner.postProcessComposite;
        const accessor = compositeScalarAccessors(composite.intrinsic, [
            property,
        ]).find((entry) => entry.property === property);
        if (accessor) {
            composite.scalarAccesses = [
                ...new Set([...(composite.scalarAccesses ?? []), property]),
            ];
            const engineCpp = context.requireEngine(owner, expression);
            return {
                kind: "number",
                cpp: `bbl::${compositeScalarFunction(composite.compositeIndex, property, false)}(${engineCpp}, ${owner.cpp})`,
                engineCpp,
                impure: true,
            };
        }
    }
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
        !context.sceneManifest.meshHasThinInstancePool(owner)
    ) {
        context.fail(
            expression,
            `Reading '${property}' requires a thin-instance pool this mesh ` +
                "never establishes; bind one with setThinInstances or " +
                "addThinInstance first.",
        );
    }
    const originalExpression = ts.getOriginalNode(expression);
    const parent = originalExpression.parent;
    const simpleWriteTarget =
        parent &&
        ts.isBinaryExpression(parent) &&
        parent.left === originalExpression &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    if (
        rule.nativeOptionalScalar &&
        parent &&
        ((ts.isBinaryExpression(parent) &&
            parent.left === originalExpression &&
            isAssignmentOperator(parent.operatorToken.kind)) ||
            ((ts.isPrefixUnaryExpression(parent) ||
                ts.isPostfixUnaryExpression(parent)) &&
                parent.operand === originalExpression))
    ) {
        // This read is a value conversion; the resource setter owns writes.
        return undefined;
    }
    if (
        rule.feature &&
        !(rule.feature === "material:source-texture-read" && simpleWriteTarget)
    ) {
        context.reachFeature(rule.feature, expression);
    }
    if (rule.helperReturnsFreshData) {
        context.reachJsData();
    }
    if (
        owner.kind === "material" &&
        (property === "baseColorFactor" || property === "diffuseColor")
    ) {
        // Assignment probing asks the property table for the LHS shape too;
        // replacing that property does not read its previous array value.
        if (!simpleWriteTarget) {
            context.noteMaterialColorRead(property);
        }
    }
    // An engine handle names itself; anything else carries the engine it
    // was created from, so the value read out of it stays resolvable.
    const engineCpp = owner.kind === "engine" ? owner.cpp : owner.engineCpp;
    const shadowGeneratorIndex =
        owner.kind === "light"
            ? owner.lightIdentity?.shadowGeneratorIndex
            : owner.shadowGeneratorIndex;
    const dataType =
        rule.dataType?.kind === "optional" && rule.knownPresent?.(owner)
            ? rule.dataType.inner
            : rule.dataType;
    const read = (cpp: string): Value =>
        dataType?.kind === "promise"
            ? context.dataValue(cpp, dataType)
            : valueForKind(rule.value, {
                  cpp:
                      dataType !== rule.dataType
                          ? `(*${cpp})`
                          : rule.nativeOptionalScalar
                            ? `([](const auto& value) { return value ? bbl::js::Nullable<${rule.nativeOptionalScalar}>{*value} : bbl::js::Nullable<${rule.nativeOptionalScalar}>{}; })(${cpp})`
                            : cpp,
                  ...(dataType ? { dataType } : {}),
                  ...(rule.textureStorage
                      ? { textureStorage: rule.textureStorage }
                      : {}),
                  ...(engineCpp ? { engineCpp } : {}),
                  ...(rule.value === "picked-node" && owner.pickingEngineKnown
                      ? { pickingEngineKnown: true as const }
                      : {}),
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
                                ? {
                                      assetWholeMeshList:
                                          owner.assetWholeMeshList,
                                  }
                                : {}),
                        }
                      : {}),
                  ...(rule.carriesShadowGenerator &&
                  shadowGeneratorIndex !== undefined
                      ? { shadowGeneratorIndex }
                      : {}),
                  ...(rule.carriesNodeParticleSet &&
                  owner.nodeParticleSetIndex !== undefined
                      ? { nodeParticleSetIndex: owner.nodeParticleSetIndex }
                      : {}),
                  ...(rule.impure ||
                  (owner.kind === "camera" && rule.value === "number")
                      ? { impure: true as const }
                      : {}),
                  ...(rule.optionalHandle
                      ? {
                            optionalFoundCpp: handleFoundCpp(cpp),
                        }
                      : {}),
                  ...(rule.optionalFound
                      ? {
                            optionalFoundCpp: rule.optionalFound(
                                owner.cpp,
                                engineCpp,
                            ),
                        }
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
                                      renderTextureSource:
                                          owner.renderTextureSource,
                                  }
                                : {}),
                        }
                      : {}),
                  ...(rule.renderTextureAspect === "depth"
                      ? {
                            isDepthTexture: true as const,
                            renderTextureSource: "render-target" as const,
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

/** A bare MeshHandle can carry only the entry's statically known engine.
 * Its lexical aliases may have different emitted names.
 * Data-transported picking results instead own a checked engine association;
 * dropping that carrier would lose both provenance and lifetime checks. */
export function pickedMeshHandleCpp(
    context: Pick<PropertyContext, "fail">,
    value: Value,
    site: ts.Node,
): string {
    if (!value.engineCpp || !value.pickingEngineKnown) {
        context.fail(
            site,
            "A data-transported PickingInfo cannot become a bare Mesh handle; " +
                "read pickedMesh.name or getPickedNormal from the result so its checked engine owner travels with it.",
        );
    }
    return `bbl::picked_mesh(${value.cpp})`;
}

/**
 * What property-access lowering reads of the compiler: the surfaces its
 * special readers take, and the members it reads itself.
 */
interface PropertyAccessContext
    extends
        PropertyContext,
        PhysicsIntrinsicContext,
        CanvasContext,
        BrowserFileContext,
        BrowserGlobalContext,
        TextSurfaceContext,
        NodeInputContext,
        Pick<
            LoweringServices,
            | "captureManagedClosureLines"
            | "checker"
            | "classLowerer"
            | "compileValue"
            | "cppString"
            | "dataLowerer"
            | "dataTypes"
            | "emit"
            | "fail"
            | "handleCollections"
            | "isCanvasElement"
            | "libraryGlobal"
            | "options"
            | "reachFeature"
            | "reachJsData"
            | "requireDefaultEngine"
            | "requireEngine"
            | "resolveStaticExpression"
            | "unwrap"
            | "useNativeValue"
        > {
    readonly bindings: BindingScopes;
    /** Bound only while lowering a platform visibility callback body. */
    readonly platformDocumentHiddenCpp: string | undefined;
    /** Platform owner for an entry that has no source-created engine. */
    readonly presentationHostCpp: string | undefined;
    readonly ui: UiProjection;
    readonly windowProperties: WindowProperties;
    compileRecordGetter(
        owner: Value,
        accessor: ts.GetAccessorDeclaration,
    ): Value;
    enumMemberValue(expression: ts.PropertyAccessExpression): Value | undefined;
}

const KEY_EVENT_FIELDS = new EmissionMap<string, string>([
    ["repeat", "repeat"],
    ["shiftKey", "shift_key"],
    ["ctrlKey", "ctrl_key"],
    ["altKey", "alt_key"],
    ["metaKey", "meta_key"],
]);
const DOM_EVENT_FLAGS = new EmissionMap<string, string>([
    ["bubbles", "bubbles"],
    ["cancelable", "cancelable"],
    ["composed", "composed"],
    ["isTrusted", "trusted"],
]);

/** Property access on every owner the compiler represents. */
export class PropertyAccessLowerer {
    constructor(private readonly context: PropertyAccessContext) {}

    /** The complete chained property path containing a failed sub-read. */
    private propertyPathForDiagnostic(
        expression: ts.PropertyAccessExpression,
    ): string {
        let path: ts.Expression = expression;
        while (
            path.parent &&
            ts.isPropertyAccessExpression(path.parent) &&
            this.context.unwrap(path.parent.expression) === path
        ) {
            path = path.parent;
        }
        return path.getText();
    }

    public compilePropertyAccess(
        expression: ts.PropertyAccessExpression,
    ): Value {
        const windowProperty = this.context.windowProperties.read(expression);
        if (windowProperty) return windowProperty;
        const environment = browserEnvironmentPropertyValue(
            this.context,
            expression,
        );
        if (environment) return environment;
        const deployed = browserDeploymentValue(this.context, expression);
        if (deployed === null)
            return { kind: "json-null", cpp: "std::nullopt" };
        if (typeof deployed === "boolean")
            return {
                kind: "boolean",
                cpp: deployed ? "true" : "false",
                staticBoolean: deployed,
            };
        if (deployed !== undefined)
            return {
                kind: "string",
                cpp: this.context.cppString(deployed),
                staticString: deployed,
            };
        const dataset = this.context.ui.primaryCanvasDataset(expression);
        if (dataset)
            return {
                kind: "string",
                cpp: `bbl::canvas_dataset(${this.context.requireDefaultEngine(expression)}, ${this.context.cppString(dataset)})`,
                dataType: { kind: "string" },
            };
        const canvas = compileCanvasValue(this.context, expression);
        if (canvas) return canvas;
        if (
            expression.name.text === "activeElement" &&
            this.context.libraryGlobal(expression.expression) === "document"
        ) {
            const engine = this.context.requireDefaultEngine(expression);
            this.context.reachFeature("ui:rml", expression);
            return {
                kind: "ui-element",
                cpp: `bbl::ui_active_element(${engine})`,
                engineCpp: engine,
                dataType: { kind: "handle", handle: "ui-element" },
            };
        }
        if (
            expression.questionDotToken &&
            expression.name.text === "direction" &&
            ts.isPropertyAccessExpression(
                this.context.unwrap(expression.expression),
            )
        ) {
            const ray = this.context.unwrap(
                expression.expression,
            ) as ts.PropertyAccessExpression;
            if (ray.name.text === "ray") {
                const pick = this.context.compileValue(ray.expression);
                if (pick.kind === "picking-info") {
                    // `pickAsync` is only lowered in its pinned BASIC mode.
                    // Upstream sets `info.ray = null` in that mode, so the
                    // optional access is exactly the nullish left operand.
                    return { kind: "json-null", cpp: "std::nullopt" };
                }
            }
        }
        const ownerExpression = this.context.unwrap(expression.expression);
        const enumMember = this.context.enumMemberValue(expression);
        if (enumMember) {
            return enumMember;
        }
        if (ts.isNewExpression(ownerExpression)) {
            // `new C().member`: the temporary instance is a record like
            // any other, read once here.
            const instance = this.context.compileValue(ownerExpression);
            if (instance.kind === "record") {
                const accessor = instance.recordGetters?.[expression.name.text];
                const member = accessor
                    ? this.context.compileRecordGetter(instance, accessor)
                    : instance.recordProperties?.[expression.name.text];
                if (member) {
                    return member;
                }
            }
        }
        const staticField =
            this.context.classLowerer.resolveStaticField(expression);
        if (staticField?.initializer) {
            return this.context.compileValue(staticField.initializer);
        }
        if (
            ts.isPropertyAccessExpression(ownerExpression) &&
            ownerExpression.name.text === "style"
        ) {
            const element = this.context.ui.uiElementValue(
                ownerExpression.expression,
            );
            if (element) {
                const engine = this.context.requireEngine(element, expression);
                const property = this.context.ui.nativeUiStyleProperty(
                    expression.name.text,
                );
                this.context.ui.auditUiStylePropertyName(
                    property,
                    expression.name,
                );
                return {
                    kind: "string",
                    cpp: `bbl::ui_get_style_property(${engine}, ${element.cpp}, ${this.context.cppString(property)})`,
                };
            }
        }
        const documentRoot = this.context.ui.documentRootValue(expression);
        if (documentRoot) return documentRoot;
        if (
            expression.name.text === "hidden" &&
            this.context.libraryGlobal(ownerExpression) === "document" &&
            this.context.platformDocumentHiddenCpp !== undefined
        ) {
            return {
                kind: "boolean",
                cpp: this.context.platformDocumentHiddenCpp,
            };
        }
        if (
            this.context.libraryGlobal(ownerExpression) === "window" &&
            (expression.name.text === "innerWidth" ||
                expression.name.text === "innerHeight")
        ) {
            const property =
                expression.name.text === "innerWidth" ? "width" : "height";
            return {
                kind: "number",
                cpp:
                    `static_cast<double>(${this.context.requireDefaultEngine(expression)}` +
                    `.options.${property})`,
                dataType: { kind: "number" },
            };
        }
        if (ownerExpression.kind === ts.SyntaxKind.ThisKeyword) {
            // Field reads resolve through the instance record the
            // constructor built.
            const instance = this.context.compileValue(ownerExpression);
            const field = instance.recordProperties?.[expression.name.text];
            if (!field) {
                const accessor = instance.recordGetters?.[expression.name.text];
                if (accessor) {
                    return this.context.compileRecordGetter(instance, accessor);
                }
                this.context.fail(
                    expression,
                    `Field '${expression.name.text}' is not assigned before this read ` +
                        `(class ${instance.classDeclaration?.name?.text ?? "unknown"}; ` +
                        `fields ${Object.keys(instance.recordProperties ?? {}).join(", ") || "none"}).`,
                );
            }
            return field;
        }
        if (
            !ts.isIdentifier(ownerExpression) &&
            !ts.isPropertyAccessExpression(ownerExpression) &&
            !ts.isElementAccessExpression(ownerExpression) &&
            !ts.isCallExpression(ownerExpression) &&
            !ts.isStringLiteralLike(ownerExpression)
        ) {
            this.context.fail(
                expression,
                `Unsupported property value '${this.propertyPathForDiagnostic(expression)}'.`,
            );
        }
        if (
            expression.name.text === "className" &&
            this.context.isCanvasElement(ownerExpression) &&
            !this.context.ui.uiElementValue(ownerExpression)
        ) {
            // The generated host's primary renderCanvas has no class
            // attribute. Keep that browser fact available to multi-surface
            // code which mirrors its class onto an auxiliary canvas.
            return {
                kind: "string",
                cpp: this.context.cppString(""),
                staticString: "",
                dataType: { kind: "string" },
            };
        }
        // Through compileValue rather than lookup: a module-level
        // constant is never bound in a variable scope, so it resolves
        // through its own initializer the way an entry-scope constant
        // resolves through its binding, and a property-access owner
        // resolves by recursing here, so `camera.ortho.halfHeight` reads
        // as the path it is written as. Unknown identifiers still fail
        // in lookup at the end of that chain, and an owner that is
        // itself unsupported fails naming the sub-path that failed.
        const compiledOwner = this.context.compileValue(ownerExpression);
        const rawOwner =
            this.context.presentationHostCpp &&
            compiledOwner.browserValue?.kind === "object" &&
            compiledOwner.browserValue.primaryCanvas
                ? this.context.ui.primaryPresentationCanvas(ownerExpression)
                : compiledOwner;
        // A shared class instance read back out of a container is a `Ref`
        // with no compile-time shape of its own. Hydrating it here is what
        // gives the ordinary record path its fields, getters and setters,
        // so `part.locked` and `part.size` read the same way whether the
        // receiver was just constructed or came out of an array.
        const owner = this.context.classLowerer.hydrate(rawOwner) ?? rawOwner;
        const httpProperty = httpResponseProperty(
            this.context.dataLowerer,
            owner,
            expression.name.text,
        );
        if (httpProperty) return httpProperty;
        if (
            owner.kind === "json-null" &&
            (expression.questionDotToken ||
                (ts.isOptionalChain(expression) &&
                    owner.optionalChainShortCircuited))
        ) {
            return {
                kind: "json-null",
                cpp: "std::nullopt",
                optionalChainShortCircuited: true,
            };
        }
        const property = expression.name.text;
        if (owner.kind === "physics-viewer" && property === "scene") {
            return {
                kind: "scene",
                cpp: `(${owner.cpp})->scene`,
                ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
            };
        }
        if (owner.kind === "scene" && property === "_envTextures") {
            this.context.reachFeature("engine:device-recovery", expression);
            return {
                kind: "gpu-environment",
                cpp: `bbl::environment_identity(${owner.cpp})`,
                engineCpp: this.context.requireEngine(owner, expression),
                dataType: { kind: "handle", handle: "gpu-environment" },
                impure: true,
            };
        }
        if (owner.kind === "gpu-environment" && property === "specularCube") {
            return {
                kind: "gpu-texture",
                cpp: `bbl::environment_texture_identity(${owner.cpp})`,
                engineCpp: this.context.requireEngine(owner, expression),
                dataType: { kind: "handle", handle: "gpu-texture" },
                impure: true,
            };
        }
        if (owner.kind === "engine" && property === "_pbrFallbackTex") {
            this.context.reachFeature("engine:device-recovery", expression);
            return {
                kind: "record",
                cpp: "",
                recordProperties: {
                    texture: {
                        kind: "gpu-texture",
                        cpp: `bbl::fallback_texture_identity(${owner.cpp})`,
                        engineCpp: owner.cpp,
                        dataType: { kind: "handle", handle: "gpu-texture" },
                        impure: true,
                    },
                },
            };
        }
        if (owner.kind === "shadow-generator" && property === "_depthTexture") {
            this.context.reachFeature("engine:device-recovery", expression);
            return {
                kind: "gpu-texture",
                cpp: `bbl::shadow_texture_identity(${this.context.requireEngine(owner, expression)}, ${owner.cpp})`,
                engineCpp: this.context.requireEngine(owner, expression),
                dataType: { kind: "handle", handle: "gpu-texture" },
                impure: true,
            };
        }
        if (owner.kind === "scene" && property === "_renderables") {
            this.context.reachFeature("engine:device-recovery", expression);
            return {
                kind: "record",
                cpp: "",
                recordProperties: {
                    length: {
                        kind: "number",
                        cpp: `bbl::scene_renderable_count(${owner.cpp})`,
                        impure: true,
                    },
                },
            };
        }
        if (owner.kind === "engine" && property === "drawCallCount") {
            this.context.reachFeature("engine:device-recovery", expression);
            return { kind: "number", cpp: `${owner.cpp}.draw_call_count` };
        }
        if (owner.kind === "ui-element" && property === "dataset") {
            return { ...owner, uiDataset: true };
        }
        if (owner.kind === "ui-element" && !owner.uiDataset) {
            if (property === "checked") {
                if (owner.uiTag && owner.uiTag !== "input")
                    this.context.fail(
                        expression,
                        "UI checked requires an input element.",
                    );
                return {
                    kind: "boolean",
                    cpp: `bbl::ui_get_checked(${this.context.requireEngine(owner, expression)}, ${owner.cpp})`,
                    impure: true,
                };
            }
            if (property === "selected") {
                if (owner.uiTag && owner.uiTag !== "option")
                    this.context.fail(
                        expression,
                        "UI selected requires an option element.",
                    );
                return {
                    kind: "boolean",
                    cpp: `bbl::ui_get_selected(${this.context.requireEngine(owner, expression)}, ${owner.cpp})`,
                    impure: true,
                };
            }
            if (
                this.context.options.workers &&
                ["complete", "naturalWidth", "naturalHeight"].includes(property)
            ) {
                if (owner.uiTag && owner.uiTag !== "img")
                    this.context.fail(
                        expression,
                        "Image readiness requires an img element.",
                    );
                const method =
                    property === "complete"
                        ? "complete"
                        : property === "naturalWidth"
                          ? "natural_width"
                          : "natural_height";
                return this.context.dataLowerer.leafValue(
                    `bbl::ui_image_${method}(${this.context.requireEngine(owner, expression)}, ${owner.cpp})`,
                    { kind: property === "complete" ? "boolean" : "number" },
                );
            }
            if (this.context.options.workers && property === "decode") {
                if (owner.uiTag && owner.uiTag !== "img")
                    this.context.fail(
                        expression,
                        "Image decoding requires an img element.",
                    );
                const engine = this.context.requireEngine(owner, expression);
                const compiled = this.context.captureManagedClosureLines(() => {
                    this.context.useNativeValue(owner);
                    this.context.emit(
                        `return bbl::ui_decode_image(${engine}, ${owner.cpp});`,
                    );
                });
                const type: DataType = {
                    kind: "function",
                    parameters: [],
                    result: { kind: "promise" },
                };
                return this.context.dataLowerer.leafValue(
                    `${this.context.dataTypes.cppType(type)}{${renderClosure(compiled, "")}}`,
                    type,
                );
            }
            if (property === "lang")
                return {
                    kind: "string",
                    cpp: `bbl::ui_get_attribute(${this.context.requireEngine(owner, expression)}, ${owner.cpp}, "lang")`,
                    dataType: { kind: "string" },
                };
            if (["min", "max", "step"].includes(property)) {
                if (owner.uiTag !== "input")
                    this.context.fail(
                        expression,
                        `UI ${property} requires an input element.`,
                    );
                return {
                    kind: "string",
                    cpp: `bbl::ui_get_attribute(${this.context.requireEngine(owner, expression)}, ${owner.cpp}, ${this.context.cppString(property)})`,
                    dataType: { kind: "string" },
                    freshData: true,
                };
            }
            const attribute = this.context.ui.booleanAttribute(
                owner,
                property,
                expression,
            );
            if (attribute)
                return {
                    kind: "boolean",
                    cpp: `bbl::ui_has_attribute(${this.context.requireEngine(owner, expression)}, ${owner.cpp}, ${this.context.cppString(attribute)})`,
                    impure: true,
                };
        }
        if (
            owner.kind === "ui-element" &&
            property === "value" &&
            ["textarea", "input", "select", "option", "output"].includes(
                owner.uiTag ?? "",
            ) &&
            !owner.uiFileInput
        ) {
            return {
                kind: "string",
                cpp: `bbl::ui_get_form_value(${this.context.requireEngine(owner, expression)}, ${owner.cpp})`,
                dataType: { kind: "string" },
                freshData: true,
            };
        }
        if (owner.kind === "ui-element" && owner.uiDataset) {
            const dataName = property.replace(
                /[A-Z]/g,
                (letter) => `-${letter.toLowerCase()}`,
            );
            const engine = this.context.requireEngine(owner, expression);
            return {
                kind: "string",
                cpp:
                    `bbl::ui_get_attribute(${engine}, ${owner.cpp}, ` +
                    `${this.context.cppString(`data-${dataName}`)})`,
                dataType: { kind: "string" },
                engineCpp: engine,
            };
        }
        if (
            owner.kind === "animation-group" &&
            owner.animationGroupSource === "property"
        ) {
            if (property === "loopAnimation" || property === "isPlaying") {
                return {
                    kind: "boolean",
                    cpp:
                        `${owner.cpp}->` +
                        (property === "loopAnimation" ? "loop" : "playing"),
                    dataType: { kind: "boolean" },
                };
            }
            const field = {
                currentTime: "current_time",
                duration: "clip.duration",
                frameRate: "clip.frame_rate",
                speedRatio: "speed_ratio",
                weight: "weight",
            }[property];
            if (field) {
                return {
                    kind: "number",
                    cpp: `${owner.cpp}->${field}`,
                    dataType: { kind: "number" },
                };
            }
        }
        const browserFileProperty = compileBrowserFileProperty(
            this.context,
            owner,
            expression,
        );
        if (browserFileProperty) {
            return browserFileProperty;
        }
        const ownerTsType =
            this.context.checker.getTypeAtLocation(ownerExpression);
        const ownerTsMembers =
            (ownerTsType.flags & ts.TypeFlags.Union) !== 0
                ? (ownerTsType as ts.UnionType).types
                : [ownerTsType];
        const sourceIsCanvas = ownerTsMembers.some(
            (member) =>
                member.getSymbol()?.getName() === "HTMLCanvasElement" ||
                member.getSymbol()?.getName() === "OffscreenCanvas",
        );
        if (
            owner.kind === "ui-element" &&
            (owner.uiCanvas || sourceIsCanvas) &&
            !owner.uiCanvasContext &&
            (property === "width" || property === "height")
        ) {
            const engine = this.context.requireEngine(owner, expression);
            return {
                kind: "number",
                cpp: `bbl::ui_canvas_${property}(${engine}, ${owner.cpp})`,
                dataType: { kind: "number" },
            };
        }
        if (owner.kind === "picking-info" && property === "ray") {
            // Basic GPU picks publish a null ray; only the detailed pipeline
            // carries one. Keeping that null in the value model lets the
            // source's optional chain and fallback lower unchanged.
            return { kind: "json-null", cpp: "std::nullopt" };
        }
        if (
            owner.kind === "platform-mouse-event" ||
            owner.kind === "platform-keyboard-event"
        ) {
            if (
                property === "target" ||
                property === "currentTarget" ||
                property === "relatedTarget"
            ) {
                if (
                    property === "relatedTarget" &&
                    (owner.kind !== "platform-mouse-event" ||
                        owner.platformEventBase)
                )
                    this.context.fail(
                        expression,
                        "This event view does not expose relatedTarget.",
                    );
                this.context.reachFeature("input:dom", expression);
                this.context.reachJsData();
                const field =
                    property === "target"
                        ? "exposed_target()"
                        : property === "currentTarget"
                          ? "current_target"
                          : "related_target";
                const value = this.context.dataLowerer.leafValue(
                    `bbl::dom_target_value(bbl::dom_event_owner(${owner.cpp}), bbl::dom_event_state(${owner.cpp}).${field})`,
                    property === "target"
                        ? { kind: "event-target" }
                        : { kind: "optional", inner: { kind: "event-target" } },
                );
                return value;
            }
            if (property === "defaultPrevented")
                return {
                    kind: "boolean",
                    cpp: `${owner.cpp}.${owner.platformEventBase ? "is_default_prevented()" : "default_prevented"}`,
                };
            const declared = readProperty(
                this.context,
                owner,
                property,
                expression,
            );
            if (declared) return declared;
            if (property === "type")
                return {
                    kind: "string",
                    cpp: `bbl::dom_event_state(${owner.cpp}).type`,
                };
            if (property === "eventPhase")
                return {
                    kind: "number",
                    cpp: `bbl::dom_event_state(${owner.cpp}).phase`,
                };
            const booleanField = DOM_EVENT_FLAGS.get(property);
            if (booleanField)
                return {
                    kind: "boolean",
                    cpp: `bbl::dom_event_state(${owner.cpp}).${booleanField}`,
                };
        }
        if (owner.platformEventBase) {
            this.context.fail(
                expression.name,
                `Borrowed DOM Event values do not expose '${property}'; only preventDefault is supported on the base Event view.`,
            );
        }
        if (owner.kind === "platform-keyboard-event") {
            const field = KEY_EVENT_FIELDS.get(property);
            if (field) {
                return {
                    kind: "boolean",
                    cpp: `${owner.cpp}.${field}`,
                };
            }
            if (property === "code") {
                return {
                    kind: "data",
                    cpp: `${owner.cpp}.code`,
                    dataType: { kind: "string" },
                    readOnly: true,
                };
            }
            if (property === "key") {
                return {
                    kind: "data",
                    cpp: `${owner.cpp}.key`,
                    dataType: { kind: "string" },
                    readOnly: true,
                };
            }
            this.context.fail(
                expression.name,
                `Platform keyboard events do not expose '${property}'.`,
            );
        }
        if (owner.kind === "platform-mouse-event") {
            if (property === "pointerType")
                return { kind: "string", cpp: `${owner.cpp}.pointer_type` };
            if (property === "isPrimary")
                return { kind: "boolean", cpp: `${owner.cpp}.is_primary` };
            const modifier = KEY_EVENT_FIELDS.get(property);
            if (modifier && property !== "repeat")
                return { kind: "boolean", cpp: `${owner.cpp}.${modifier}` };
            if (
                property === "button" ||
                property === "buttons" ||
                property === "clientX" ||
                property === "clientY" ||
                property === "offsetX" ||
                property === "offsetY" ||
                property === "movementX" ||
                property === "movementY" ||
                property === "deltaY" ||
                property === "pointerId"
            ) {
                return {
                    kind: "number",
                    cpp:
                        property === "pointerId"
                            ? `${owner.cpp}.pointer_id`
                            : property === "button"
                              ? `${owner.cpp}.button`
                              : property === "buttons"
                                ? `${owner.cpp}.buttons`
                                : property === "clientX" ||
                                    property === "offsetX"
                                  ? `${owner.cpp}.client_x`
                                  : property === "clientY" ||
                                      property === "offsetY"
                                    ? `${owner.cpp}.client_y`
                                    : property === "movementX"
                                      ? `${owner.cpp}.movement_x`
                                      : property === "movementY"
                                        ? `${owner.cpp}.movement_y`
                                        : `${owner.cpp}.delta_y`,
                    dataType: { kind: "number" },
                };
            }
            this.context.fail(
                expression.name,
                `Platform mouse events do not expose '${property}'.`,
            );
        }
        if (
            owner.kind === "browser" &&
            owner.browserValue?.kind === "dom-rect" &&
            (property === "left" ||
                property === "top" ||
                property === "width" ||
                property === "height")
        ) {
            const axis =
                property === "width" || property === "height"
                    ? property
                    : undefined;
            return {
                kind: "number",
                cpp: axis
                    ? `${this.context.requireDefaultEngine(expression)}.canvas_client_${axis}`
                    : "0.0",
                ...(axis ? {} : { staticNumber: 0 }),
                dataType: { kind: "number" },
            };
        }
        const fetchedProperty = staticFetchProperty(owner, property);
        if (fetchedProperty) return fetchedProperty;
        if (owner.kind === "regexp" && property === "lastIndex") {
            return {
                kind: "number",
                cpp: `${owner.cpp}.last_index()`,
            };
        }
        if (
            owner.kind === "texture" &&
            (property === "width" || property === "height")
        ) {
            let size =
                property === "width" ? owner.textureWidth : owner.textureHeight;
            if (
                size === undefined &&
                owner.textureFile?.source &&
                owner.textureFile.entryFileName
            ) {
                const dimensions = readPngDimensionsSync(
                    owner.textureFile.source,
                    owner.textureFile.entryFileName,
                );
                if (dimensions) {
                    owner.textureWidth = dimensions.width;
                    owner.textureHeight = dimensions.height;
                    size =
                        property === "width"
                            ? dimensions.width
                            : dimensions.height;
                }
            }
            if (size === undefined) {
                if (owner.textureStorage === "file") {
                    return {
                        kind: "number",
                        cpp: `static_cast<double>(${owner.cpp}.${property})`,
                        dataType: { kind: "number" },
                    };
                }
                this.context.fail(
                    expression,
                    `Texture ${property} requires a PNG source with generation-known dimensions.`,
                );
            }
            return {
                kind: "number",
                cpp: doubleLiteral(size),
                staticNumber: size,
            };
        }
        if (owner.kind === "sprite-renderer" && property === "layers") {
            const engine = this.context.requireEngine(owner, expression);
            return {
                kind: "data",
                cpp: `${recordAt(`${engine}.sprite_renderers`, owner.cpp)}.layers`,
                dataType: {
                    kind: "vector",
                    element: {
                        kind: "handle",
                        handle: "sprite-layer",
                    },
                },
                borrowedData: true,
                nativeVectorData: true,
                engineCpp: engine,
            };
        }
        if (owner.kind === "record") {
            const accessor = owner.recordGetters?.[property];
            const value = accessor
                ? this.context.compileRecordGetter(owner, accessor)
                : owner.recordProperties?.[property];
            if (!value) {
                const method = owner.recordMethods?.[property];
                if (method) {
                    return {
                        kind: "callback",
                        cpp: "",
                        callbackDeclaration: method,
                        callbackRecordOwner: owner,
                    };
                }
                const declared =
                    this.context.dataLowerer.dataTypeAt(expression);
                const declaredTsType =
                    this.context.checker.getTypeAtLocation(expression);
                const declaredMembers = declaredTsType.isUnion()
                    ? declaredTsType.types
                    : [declaredTsType];
                const optionalProperty = this.context.checker
                    .getTypeAtLocation(expression.expression)
                    .getProperty(property);
                if (
                    declared?.kind === "optional" ||
                    (optionalProperty !== undefined &&
                        (optionalProperty.flags & ts.SymbolFlags.Optional) !==
                            0) ||
                    (declared?.kind === "function" &&
                        declaredMembers.some(
                            (member) =>
                                (member.flags &
                                    (ts.TypeFlags.Null |
                                        ts.TypeFlags.Undefined)) !==
                                0,
                        ))
                ) {
                    // Object literals omit optional fields entirely. A
                    // compile-time record preserves that absence as the
                    // nullish value consumed by `??` and equality guards.
                    return { kind: "json-null", cpp: "" };
                }
                this.context.fail(
                    expression,
                    `Static record has no property '${property}' ` +
                        `(fields: ${Object.keys(owner.recordProperties ?? {}).join(", ") || "none"}; ` +
                        `getters: ${Object.keys(owner.recordGetters ?? {}).join(", ") || "none"}; ` +
                        `class: ${owner.classDeclaration?.name?.text ?? "none"}).`,
                );
            }
            return this.propertyWithOwnerPresence(owner, value, expression);
        }
        // `baked.clips`: the bake's own row map. It carries the bake and
        // nothing else, so the name lookup that follows is the native row
        // read rather than a generation-time table.
        if (owner.kind === "vat-bake" && property === "clips") {
            return {
                kind: "vat-clip-map",
                cpp: owner.cpp,
                ...(owner.engineCpp !== undefined
                    ? { engineCpp: owner.engineCpp }
                    : {}),
            };
        }
        // A container's own handle collection, read without the `?? []`
        // guard the nullish resolver already claims. Asked before the
        // failure below rather than in `readOwnerProperty`, because the
        // collection concept resolves the owner itself.
        if (
            owner.kind === "asset" ||
            owner.kind === "hierarchy-instance-pool"
        ) {
            const collection =
                this.context.handleCollections.resolveCollectionRead(
                    expression,
                );
            if (collection) return collection;
        }
        if (owner.kind === "surface" && property === "engine") {
            if (!owner.engineCpp) {
                this.context.fail(
                    expression,
                    "A surface without an owning engine cannot expose SurfaceContext.engine.",
                );
            }
            return {
                kind: "engine",
                cpp: owner.engineCpp,
                engineCpp: owner.engineCpp,
            };
        }
        const resolved = this.readOwnerProperty(owner, expression);
        if (resolved) {
            return expression.questionDotToken
                ? this.propertyWithOwnerPresence(owner, resolved, expression)
                : resolved;
        }
        return this.context.fail(
            expression,
            `Unsupported property value '${this.propertyPathForDiagnostic(expression)}' (owner ${owner.kind} ${owner.dataType ? JSON.stringify(owner.dataType) : "without data type"}).`,
        );
    }

    public lookupRecordProperty(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        if (ts.isPropertyAccessExpression(expression.expression)) {
            // A path resolves one link at a time, through this same
            // non-throwing lookup: an owner nobody here can name is
            // still the data lowerer's to try, not an error.
            const nested = this.lookupRecordProperty(expression.expression);
            return nested
                ? this.readOwnerProperty(nested, expression)
                : undefined;
        }
        if (!ts.isIdentifier(expression.expression)) {
            return undefined;
        }
        const owner =
            this.context.bindings.lookupOptional(expression.expression) ??
            (() => {
                const resolved = this.context.resolveStaticExpression(
                    expression.expression,
                );
                return resolved !== expression.expression
                    ? this.context.compileValue(resolved)
                    : undefined;
            })();
        return owner ? this.readOwnerProperty(owner, expression) : undefined;
    }

    /**
     * A declared property of an engine handle that the table types as plain
     * data. The data lowerer asks here so a comparison, a sink and a binding
     * all read the one table the expression path reads, instead of each
     * growing its own notion of which handle properties are data.
     */
    public declaredDataProperty(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        // The owner is looked up rather than compiled: this runs inside the
        // data lowerer's path resolution, which must stay free of emission
        // and of failure, and every current producer of a handle in a data
        // position is a bound local. The boundary this draws: a handle
        // STORED IN DATA (`groups[0]` out of a pushed vector) does not
        // resolve here — its owner path is data, not a local — so its
        // declared properties stay unreadable until this consults the
        // nested resolution `lookupRecordProperty` already implements.
        const owner = ts.isIdentifier(expression.expression)
            ? this.context.bindings.lookupOptional(expression.expression)
            : undefined;
        if (!owner || owner.kind === "data" || owner.kind === "record") {
            return undefined;
        }
        // Through the same single funnel every other read uses, so this
        // does not become a third reader of the table.
        const declared = this.readOwnerProperty(owner, expression);
        return declared?.dataType ? declared : undefined;
    }

    public readResolvedProperty(
        owner: Value,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const hydrated = this.context.classLowerer.hydrate(owner) ?? owner;
        const value = this.readOwnerProperty(hydrated, expression);
        return value &&
            (hydrated.kind === "record" || expression.questionDotToken)
            ? this.propertyWithOwnerPresence(hydrated, value, expression)
            : value;
    }

    private propertyWithOwnerPresence(
        owner: Value,
        value: Value,
        expression: ts.PropertyAccessExpression,
    ): Value {
        const ownerPresent =
            owner.optionalFoundCpp ??
            (expression.questionDotToken &&
            owner.dataType?.kind === "struct" &&
            this.context.dataTypes.isReferenceStruct(owner.dataType.name)
                ? `static_cast<bool>(${owner.cpp})`
                : undefined);
        if (ownerPresent === undefined) return value;
        const present =
            value.optionalFoundCpp === undefined
                ? ownerPresent
                : `(${ownerPresent} && ${value.optionalFoundCpp})`;
        return { ...value, optionalFoundCpp: present };
    }

    /**
     * One link of a path, once the owner is resolved. Every read site
     * ends here -- the general property path, the static evaluator's
     * lookup, the data lowerer's plain-data property bridge, and each
     * nested link -- so a path resolves the same way wherever it is
     * written and however deep it goes. The readings that are not a
     * declared field lookup live here because they are what differs, and
     * each used to sit in only one of the two paths: `camera.target` and
     * the geometry-task outputs resolved in an expression but not in a
     * numeric context.
     *
     * A record owner is the exception: this returns the property or
     * nothing, because the lookup path must stay non-throwing for the
     * data lowerer to try next. The general path handles records itself,
     * where a missing property is an error with a message.
     */
    private readOwnerProperty(
        owner: Value,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const media = readMediaQueryProperty(this.context, owner, expression);
        if (media) return media;
        const character = readCharacterProperty(
            this.context,
            owner,
            expression.name.text,
        );
        if (character) return character;
        if (owner.kind === "physics-body" && expression.name.text === "node") {
            return {
                kind: "record",
                cpp: "",
                recordProperties: {
                    name: {
                        kind: "string",
                        cpp: `bbl::upstream::physics_body_node_name(${owner.cpp})`,
                        dataType: { kind: "string" },
                    },
                },
            };
        }
        const staticProperty = owner.recordProperties?.[expression.name.text];
        if (staticProperty) {
            // A materialized record can still carry an exact value for a
            // property produced during static iteration. Prefer that fact
            // over reconstructing the field from its wider declared type
            // (notably `boolean | undefined`), just as a plain record does.
            return staticProperty;
        }
        if (owner.kind === "record") {
            const accessor = owner.recordGetters?.[expression.name.text];
            if (accessor) {
                return this.context.compileRecordGetter(owner, accessor);
            }
            return undefined;
        }
        // A handle collection's size. The concept's other operations are
        // its loop and its searches; this is the same native vector read
        // through its one remaining JavaScript member, which is how both
        // VAT scenes ask whether the file carried any clips at all.
        if (
            owner.kind === "handle-collection" &&
            owner.handleCollection &&
            expression.name.text === "length"
        ) {
            return {
                kind: "number",
                cpp:
                    "static_cast<double>(" +
                    `${owner.handleCollection.containerCpp}.size())`,
                engineCpp: owner.handleCollection.engineCpp,
            };
        }
        if (owner.kind === "data") {
            const dataProperty =
                this.context.dataLowerer.compilePropertyFromValue(
                    owner,
                    expression,
                );
            if (dataProperty) {
                return dataProperty;
            }
        }
        const frozenParticleProperty = readFrozenParticleProperty(
            this.context,
            owner,
            expression.name.text,
            expression,
        );
        if (frozenParticleProperty) return frozenParticleProperty;
        const textProperty = readTextProperty(
            this.context,
            owner,
            expression.name.text,
            expression,
        );
        if (textProperty) return textProperty;
        const inputProperty = readNodeInputProperty(
            this.context,
            owner,
            expression.name.text,
            expression,
        );
        if (inputProperty) return inputProperty;
        // A live pure-2D binding's bridges, and the one path scene code
        // reads through one: `bridge.system.buffer.alive`, the simulated
        // count the generated registrar keeps. `bridges` is the pin's own
        // array, read as the binding again so the element access that
        // follows names one bridge by index -- the same shape
        // `set.systems[k]` takes.
        if (
            owner.kind === "node-particle-2d-binding" &&
            expression.name.text === "bridges" &&
            owner.nodeParticleLive
        ) {
            return owner;
        }
        if (
            owner.kind === "node-particle-2d-bridge" &&
            expression.name.text === "system"
        ) {
            return { ...owner, kind: "node-particle-system" };
        }
        if (
            owner.kind === "node-particle-system" &&
            expression.name.text === "buffer" &&
            owner.nodeParticleLive
        ) {
            return { ...owner, kind: "node-particle-buffer" };
        }
        if (
            owner.kind === "node-particle-buffer" &&
            expression.name.text === "alive" &&
            owner.nodeParticleLive
        ) {
            return {
                kind: "number",
                cpp:
                    "bbl::upstream::node_particle_2d_alive(" +
                    `${owner.nodeParticleRequestIndex!}, ` +
                    `${owner.nodeParticleBridgeIndex!})`,
                dataType: { kind: "number" },
            };
        }
        // The same table the general property path reads. Keeping a
        // second copy here is what made `camera.ortho.halfHeight`
        // resolve in an expression but not in a numeric context: the
        // copy was never told about the orthographic bounds.
        const declared = readProperty(
            this.context,
            owner,
            expression.name.text,
            expression,
        );
        if (declared) {
            return declared;
        }
        if (owner.kind === "tuple" && expression.name.text === "length") {
            const length = owner.tupleElements?.length ?? 0;
            return {
                kind: "number",
                cpp: `${length}.0f`,
                staticNumber: length,
            };
        }
        if (owner.kind === "string" && expression.name.text === "length") {
            const length = owner.staticString?.length;
            if (length === undefined) this.context.reachJsData();
            return {
                kind: "number",
                cpp:
                    length === undefined
                        ? `bbl::js::string_length(${owner.cpp})`
                        : doubleLiteral(length),
                ...(length === undefined ? {} : { staticNumber: length }),
                dataType: { kind: "number" },
            };
        }
        if (owner.kind === "engine" && expression.name.text === "msaaSamples") {
            if (owner.msaaSamples === "runtime")
                return {
                    kind: "number",
                    cpp: engineSampleCountCpp(owner),
                    dataType: { kind: "number" },
                };
            return {
                kind: "number",
                cpp: `${owner.msaaSamples ?? 4}.0f`,
                staticNumber: owner.msaaSamples ?? 4,
            };
        }
        if (
            owner.kind === "frame-graph-context" &&
            expression.name.text === "frameGraph"
        ) {
            return owner;
        }
        if (
            owner.kind === "utility-layer" &&
            expression.name.text === "scene"
        ) {
            const engine = this.context.requireEngine(owner, expression);
            return {
                kind: "scene",
                cpp: `bbl::utility_layer_scene(${engine}, ${owner.cpp})`,
                engineCpp: engine,
                sceneEnvironmentState: {
                    rotationSet: false,
                    hasTexturedSkybox: false,
                },
                sceneTopologyState: { lights: [] },
            };
        }
        if (owner.kind === "position-gizmo") {
            const parts: Readonly<
                Record<
                    string,
                    {
                        index: number;
                        kind: "axis-drag-gizmo" | "plane-drag-gizmo";
                    }
                >
            > = {
                xGizmo: { index: 0, kind: "axis-drag-gizmo" },
                yGizmo: { index: 1, kind: "axis-drag-gizmo" },
                zGizmo: { index: 2, kind: "axis-drag-gizmo" },
                xPlaneGizmo: { index: 3, kind: "plane-drag-gizmo" },
                yPlaneGizmo: { index: 4, kind: "plane-drag-gizmo" },
                zPlaneGizmo: { index: 5, kind: "plane-drag-gizmo" },
            };
            const part = parts[expression.name.text];
            if (part) {
                const engine = this.context.requireEngine(owner, expression);
                const cpp = `${owner.cpp}.parts[${part.index}]`;
                const drag: Value = {
                    kind: "pointer-drag",
                    cpp: `${handleCppType("pointer-drag")}{${cpp}.value}`,
                    engineCpp: engine,
                    dataType: { kind: "handle", handle: "pointer-drag" },
                };
                return valueForKind(part.kind, {
                    cpp,
                    engineCpp: engine,
                    ...(part.index >= 3
                        ? {
                              optionalFoundCpp: `${owner.cpp}.part_count > ${part.index}u`,
                              truthinessCpp: `${owner.cpp}.part_count > ${part.index}u`,
                          }
                        : {}),
                    recordProperties: {
                        drag,
                        _disposePointer: {
                            kind: "data",
                            cpp: `${recordAt(`${engine}.edit_gizmos`, cpp)}.dispose_pointer`,
                            dataType: {
                                kind: "function",
                                parameters: [],
                            },
                        },
                    },
                });
            }
        }
        if (owner.kind === "pointer-drag") {
            const engine = this.context.requireEngine(owner, expression);
            const record = `${recordAt(`${engine}.edit_gizmos`, owner.cpp)}`;
            if (
                expression.name.text === "enabled" ||
                expression.name.text === "dragging" ||
                expression.name.text === "hovering"
            ) {
                return {
                    kind: "boolean",
                    cpp: `${record}.${expression.name.text}`,
                    dataType: { kind: "boolean" },
                    nativeLvalue: true,
                };
            }
            if (expression.name.text === "_colliders") {
                return {
                    kind: "record",
                    cpp: "",
                    recordProperties: {
                        includes: {
                            kind: "data",
                            cpp:
                                `std::function<bool(${handleCppType("mesh")})>{` +
                                `[&](${handleCppType("mesh")} mesh) { return ` +
                                `bbl::pointer_drag_has_collider(${engine}, ` +
                                `${owner.cpp}, mesh); }}`,
                            dataType: {
                                kind: "function",
                                parameters: [
                                    { kind: "handle", handle: "mesh" },
                                ],
                                result: { kind: "boolean" },
                            },
                        },
                    },
                };
            }
            if (
                expression.name.text === "onHoverStart" ||
                expression.name.text === "onHoverEnd"
            ) {
                return {
                    kind: "record",
                    cpp: "",
                    recordProperties: {
                        notify: {
                            kind: "data",
                            cpp: `std::function<void()>{[&${engine}, drag = ${owner.cpp}]() { bbl::pointer_drag_hover(${engine}, drag, ${expression.name.text === "onHoverStart"}); }}`,
                            dataType: {
                                kind: "function",
                                parameters: [],
                            },
                        },
                    },
                };
            }
        }
        if (
            owner.kind === "camera" &&
            (expression.name.text === "position" ||
                expression.name.text === "target" ||
                expression.name.text === "upVector")
        ) {
            // Not a field but three of them: the record this synthesizes
            // is what makes `camera.position.x`, `camera.target.x`, and
            // destructuring either vector read the same components.
            const engine = this.context.requireEngine(owner, expression);
            const vector =
                expression.name.text === "upVector"
                    ? "up_vector"
                    : expression.name.text;
            const cameraVector = {
                owner: { ...owner, engineCpp: engine },
                field: vector,
            } as const;
            return {
                kind: "record",
                cpp: "",
                cameraVector,
                recordProperties: cameraVectorProperties(cameraVector),
            };
        }
        if (
            owner.kind === "light" &&
            (expression.name.text === "position" ||
                expression.name.text === "direction")
        ) {
            const engine = this.context.requireEngine(owner, expression);
            const vector = expression.name.text;
            const record = `${recordAt(`${engine}.lights`, owner.cpp)}`;
            const component = (name: "x" | "y" | "z"): Value => ({
                kind: "number",
                cpp: `${record}.${vector}.${name}`,
                dataType: { kind: "number" },
                engineCpp: engine,
            });
            return {
                kind: "record",
                cpp: "",
                recordProperties: {
                    x: component("x"),
                    y: component("y"),
                    z: component("z"),
                },
            };
        }
        const sceneNodeTransform = sceneNodeTransformDescriptor(
            expression.name.text,
        );
        if (
            (owner.kind === "mesh" ||
                owner.kind === "transform-node" ||
                owner.kind === "scene-node" ||
                owner.kind === "asset-root") &&
            sceneNodeTransform
        ) {
            const engine = this.context.requireEngine(owner, expression);
            if (owner.kind === "scene-node") {
                this.context.reachFeature("scene:node-transforms", expression);
            }
            const vectorOwner = { ...owner, engineCpp: engine };
            return {
                kind: "record",
                cpp: "",
                sceneNodeVector: {
                    owner: vectorOwner,
                    transform: sceneNodeTransform,
                },
                recordProperties: sceneNodeVectorProperties(
                    vectorOwner,
                    sceneNodeTransform,
                    owner.kind === "scene-node" || owner.kind === "asset-root",
                ),
            };
        }
        if (owner.kind === "task" && owner.geometryTask) {
            return this.readGeometryTaskProperty(
                owner,
                owner.geometryTask,
                expression,
            );
        }
        if (
            owner.kind === "task" &&
            (owner.postProcessTask || owner.postProcessComposite) &&
            expression.name.text === "outputTexture"
        ) {
            // A pass writes into the target it was given, or into one it
            // made from the source's own descriptor. The pin resolves that
            // in `prepareOutputTarget`; the record holds whichever it is,
            // so chaining a pass onto the one before it reads a field. A
            // composite's public output may precede a history update pass;
            // generation resolves it from the pinned facade's identity.
            return {
                kind: "render-target",
                cpp: `${recordAt(`${this.context.requireEngine(owner, expression)}.frame_tasks`, owner.cpp)}.post_process.output_target`,
                ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
            };
        }
        if (owner.kind === "task" && owner.screenSpaceTask) {
            // The pin publishes three targets on a screen-space task: its
            // output (the composite's, or the stable effect target when it
            // composes nothing) and the stable target under the effect's
            // own name. All three are record fields the factory resolved.
            const fields: Readonly<Record<string, string>> = {
                outputTexture: "output_target",
                [screenSpaceFacts(owner.screenSpaceTask.intrinsic)
                    .stableTexture]: "stable",
            };
            const field = fields[expression.name.text];
            if (field === undefined) return undefined;
            return {
                kind: "render-target",
                cpp: `${recordAt(`${this.context.requireEngine(owner, expression)}.frame_tasks`, owner.cpp)}.screen_space.${field}`,
                ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
            };
        }
        return undefined;
    }

    /**
     * A geometry task's outputs, which are gated on what the task was
     * asked to write rather than on the property name alone.
     */
    private readGeometryTaskProperty(
        owner: Value,
        task: GeometryOutputTaskManifest,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const property = expression.name.text;
        const engineCpp = owner.engineCpp ? { engineCpp: owner.engineCpp } : {};
        if (property === "outputTexture") {
            if (!task.emitColor) {
                this.context.fail(
                    expression,
                    "Geometry task has no targetTexture output.",
                );
            }
            return {
                kind: "render-texture",
                cpp: `bbl::geometry_task_output_texture(${owner.cpp})`,
                renderTextureSource: "geometry-output",
                ...engineCpp,
            };
        }
        if (property === "geometryDepthTexture") {
            // The pin's eager depth wrapper over the task's MRT depth: a later
            // render task binds and loads it, and owns none of it.
            return {
                kind: "render-texture",
                cpp: `bbl::geometry_task_depth_texture(${owner.cpp})`,
                isDepthTexture: true,
                renderTextureSource: "geometry-depth",
                ...engineCpp,
            };
        }
        const geometryProperties: Record<string, GeometryTextureTypeName> = {
            geometryIrradianceTexture: "IRRADIANCE",
            geometryWorldPositionTexture: "WORLD_POSITION",
            geometryLocalPositionTexture: "LOCAL_POSITION",
            geometryReflectivityTexture: "REFLECTIVITY",
            geometryViewDepthTexture: "VIEW_DEPTH",
            geometryNormalizedViewDepthTexture: "NORMALIZED_VIEW_DEPTH",
            geometryScreenspaceDepthTexture: "SCREENSPACE_DEPTH",
            geometryViewNormalTexture: "VIEW_NORMAL",
            geometryWorldNormalTexture: "WORLD_NORMAL",
            geometryAlbedoTexture: "ALBEDO",
            geometryLinearVelocityTexture: "LINEAR_VELOCITY",
        };
        const type = geometryProperties[property];
        if (!type) {
            return undefined;
        }
        if (!task.attachments.includes(type)) {
            this.context.fail(
                expression,
                `Geometry task did not request ${type}.`,
            );
        }
        return {
            kind: "render-texture",
            cpp: `bbl::geometry_task_texture(${owner.cpp}, bbl::GeometryTextureType::${geometryEnumMember(type)})`,
            renderTextureSource: "geometry",
            ...engineCpp,
        };
    }
}
