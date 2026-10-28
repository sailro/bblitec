/**
 * The engine, scene, camera and render-task objects every lowered pinned
 * library reaches, as native records over `bblite/library_runtime.hpp`; the
 * platform calls into them; and the generated prelude of the camera and
 * scene-node functions their members call (`library_prelude.hpp`).
 */
import ts from "typescript";
import { type LoweringContext } from "./context.js";
import {
    pinnedEulerProxy,
    pinnedQuaternionMath,
} from "./pinned-euler-proxy.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import {
    type CallAdapter,
    type MemberSpec,
    type PinnedRecordModel,
    type RecordShape,
    type RecordSpec,
} from "./pinned-record-lowerer.js";
import {
    arrayOf as array,
    field,
    functionOf as fn,
    gpuObjectShape as gpuObject,
    matrixValues,
    members,
    optionalOf as optional,
    promiseOf,
    recordOf as record,
    recordScalars,
    spelled,
    tupleOf,
    typedF32,
} from "./record-shapes.js";
import {
    objectProperty,
    plainDataMembers,
    sameSource,
} from "../compiler/syntax.js";
import { snakeCase, stringLiteral } from "../cpp-literals.js";
import {
    pinnedToneMapping,
    toneMappingExportNames,
} from "../pinned-tone-mapping.js";
import {
    seededMaterialDefault,
    type SeededMaterialDefault,
} from "./pinned-material-defaults.js";

/** The native header declaring the runtime records' types and seams. */
export const LIBRARY_RUNTIME_HEADER = "bblite/library_runtime.hpp";
/** The generated header of the runtime's pinned camera and node functions. */
export const LIBRARY_PRELUDE_HEADER = "bblite/upstream/library_prelude.hpp";

const CAMERA = "src/camera/camera.ts";
/** The namespace of library_runtime.hpp's helpers. */
export const RUNTIME = "bbl::library";
const { number, boolean, string, void: none } = recordScalars;
const read = (shape: RecordShape, native: string): MemberSpec => ({
    shape,
    access: (owner) => `${RUNTIME}::${native}(${owner})`,
});
/**
 * `scene.<list>.<method>(...)` through the scene-list helpers scene programs
 * use too (`bbl::scene_list_push` / `_index_of` / `_splice`, runtime.hpp),
 * over the list's SceneState field; a splice inserts what it passes after
 * its count.
 */
const sceneListMember = (
    method: "push" | "indexOf" | "splice",
    field: string,
    shape: RecordShape,
    element: RecordShape,
): readonly [string, MemberSpec] => [
    method,
    {
        shape,
        access: (owner) => owner,
        call: (owner, args) =>
            `bbl::scene_list_${method === "indexOf" ? "index_of" : method}(${owner}->${field}, ${args.join(", ")})`,
        ...(method === "splice" ? { rest: element } : {}),
    },
];
/** A scene list the pin pushes to, searches and splices by identity. */
const list = (native: string): MemberSpec => ({
    shape: { kind: "record", name: native },
    access: (owner) => owner,
});

/**
 * The scene's renderables a library writes: a pushed one is published as a
 * deferred builder's is (its engine and publication stamped), and a sort
 * orders the scene's own list (library_runtime.hpp).
 */
const renderableListMembers: readonly (readonly [string, MemberSpec])[] = [
    [
        "push",
        {
            shape: fn([record("Renderable")], number),
            access: (owner) => owner,
            call: (owner, args) =>
                `${RUNTIME}::push_scene_renderable(${owner}, ${args.join(", ")})`,
        },
    ],
    [
        "sort",
        {
            shape: fn(
                [fn([record("Renderable"), record("Renderable")], number)],
                none,
            ),
            access: (owner) => owner,
            call: (owner, args) =>
                `${RUNTIME}::sort_scene_renderables(${owner}, ${args.join(", ")})`,
        },
    ],
];

/** The scene's lists a lowered library reaches, by their SceneState field. */
const sceneLists: readonly {
    readonly name: string;
    readonly element: RecordShape;
    readonly field: string;
    readonly own?: readonly (readonly [string, MemberSpec])[];
    readonly elements?: RecordSpec["elements"];
}[] = [
    {
        name: "LibraryBeforeRenderList",
        element: fn([number], none),
        field: "before_render",
    },
    {
        name: "LibraryDisposableList",
        element: fn([], none),
        field: "disposables",
    },
    {
        name: "LibraryRenderableList",
        element: record("Renderable"),
        field: "external_renderables",
        own: renderableListMembers,
        elements: {
            shape: array(record("Renderable")),
            cpp: (owner) => `${RUNTIME}::scene_renderables(${owner})`,
        },
    },
];

/** The frame's encoder as the engine's compute work and post-submit hooks hold it. */
const computeEncoder: RecordShape = {
    kind: "native",
    cpp: "std::shared_ptr<bbl::pal::ComputeCommandEncoder>",
    nullable: true,
};

/** `DrawUpdateBatch`'s members, as the scene pass calls them. */
const drawUpdateBatchMembers: readonly (readonly [string, MemberSpec])[] = [
    ["_retired", field(boolean, "retired_flag")],
    ["reset", field(fn([], none), "reset_callback")],
    ["flush", field(fn([record("EngineContext")], none), "flush_callback")],
    ["destroy", field(fn([], none), "destroy_callback")],
];

/**
 * A library's own `DrawUpdateBatch` (`SplatStreamDrawBatch extends
 * DrawUpdateBatch`): native, since its base is a type-only declaration,
 * as `<namespace>::DrawBatch` (`libraryDrawBatchStruct`), with `own`
 * members besides the scene pass's.
 */
export function libraryDrawBatch(
    pinned: string,
    namespace: string,
    own: readonly (readonly [string, MemberSpec])[],
): RecordSpec {
    return {
        pinned: [pinned],
        cpp: `${namespace}::DrawBatch`,
        reference: true,
        native: true,
        bases: ["DrawUpdateBatch"],
        members: members([...drawUpdateBatchMembers, ...own]),
    };
}

/** The forward declaration of a `libraryDrawBatch` struct, before the records naming it. */
export function libraryDrawBatchDeclaration(
    model: PinnedRecordModel,
    pinned: string,
): string {
    const [namespace, name] = model.record(pinned).spec.cpp.split("::");
    return `namespace ${namespace} {
struct ${name};
} // namespace ${namespace}`;
}

/**
 * A pinned library lowered whole for the programs that call it: its public
 * functions, each with the pinned module declaring it (the roots its header
 * lowers and the calls the application compiler admits), the public records
 * a program holds or passes, the scene node it adds, its record model (once
 * per lowering context) and what its header emits beside the model's
 * literal records.
 */
export interface LoweredLibrary {
    /** The pinned module and root the header names as its provenance. */
    readonly provenance: readonly [module: string, root: string];
    readonly roots: ReadonlyMap<string, string>;
    readonly records: readonly string[];
    /** The library's scene node (`librarySceneNode`), whose parent a program sets. */
    readonly node: string;
    readonly model: (context: LoweringContext) => PinnedRecordModel;
    /** The records the header emits ahead of the model's literal ones. */
    readonly emitted: readonly string[];
    /** Its `libraryDrawBatch` and the pinned module describing it. */
    readonly batch: readonly [record: string, module: string];
    readonly includes: readonly string[];
}

/** A lowered library's generated header: every reached root over its records. */
export function loweredLibraryHeader(
    context: LoweringContext,
    library: LoweredLibrary,
): string {
    const model = library.model(context);
    const { declarations, definitions } = model.lower(
        [...library.roots].map(([name, module]) =>
            model.functionDeclaration(module, name),
        ),
    );
    const emitted = [...library.emitted, ...model.literalRecords()].filter(
        (name, index, names) =>
            names.indexOf(name) === index && !model.record(name).spec.native,
    );
    const includes = [
        "bblite/pinned_records.hpp",
        "bblite/gpu.hpp",
        "bblite/web_platform.hpp",
        LIBRARY_RUNTIME_HEADER,
        LIBRARY_PRELUDE_HEADER,
        ...library.includes,
        ...model.includes,
    ].filter((header, index, headers) => headers.indexOf(header) === index);
    const [batch, batchModule] = library.batch;
    return `#pragma once
// ${context.provenance(...library.provenance)}
${includes.map((header) => `#include <${header}>`).join("\n")}
#include <array>
#include <cmath>
#include <string>
#include <utility>
#include <vector>

namespace bbl {
${libraryDrawBatchDeclaration(model, batch)}
${model.structs(emitted)}
${libraryDrawBatchStruct(model, batch, batchModule)}
${declarations}
${definitions}
} // namespace bbl
`;
}

/** The struct of a `libraryDrawBatch`: the runtime's batch and the record's own members. */
export function libraryDrawBatchStruct(
    model: PinnedRecordModel,
    pinned: string,
    module: string,
): string {
    const record = model.record(pinned);
    const [namespace, name] = record.spec.cpp.split("::");
    const base = new Set(drawUpdateBatchMembers.map(([member]) => member));
    const own = [...record.members().values()].filter(
        (member) => !base.has(member.name),
    );
    return `namespace ${namespace} {
/** \`${pinned}\` (${module}), a \`DrawUpdateBatch\` the scene pass drives. */
struct ${name} final : library::DrawUpdateBatch {
${own.map((member) => `    ${model.cppType(member.shape)} ${member.field}{};`).join("\n")}
    void gc_trace(const bbl::js::TraceVisitor& visitor) const {
        library::DrawUpdateBatch::gc_trace(visitor);
${own.map((member) => `        visitor(${member.field});`).join("\n")}
    }
};
} // namespace ${namespace}`;
}

/**
 * A scene member a lowered library keeps (`scene._meshLoDRegistry`), stored
 * on the native scene by its pinned name (`library::scene_member`).
 */
export function sceneMember(name: string, shape: RecordShape): MemberSpec {
    const key = stringLiteral(name);
    return {
        shape,
        slot: {
            read: (owner, type) =>
                `${RUNTIME}::scene_member<${type}>(${owner}, ${key})`,
            store: (owner, value, type) =>
                `${RUNTIME}::set_scene_member<${type}>(${owner}, ${key}, ${value})`,
        },
    };
}

/** A PBR material's seeded member: read as the record holds it, under the pin's default. */
const seeded = (
    shape: RecordShape,
    native: string,
    name: SeededMaterialDefault,
): MemberSpec => ({
    ...read(shape, native),
    seeded: (fallback) => seededMaterialDefault(name, fallback),
});

/**
 * pbr-material.ts `PbrMaterialProps` (and the `Material` it extends) over
 * the native material record: a feature flag the pin leaves absent reads
 * true or absent, a value the record holds seeded with the writer's default
 * reads under that default (`seeded`), a texture slot as its `Texture2D`.
 * Composition inputs the native record does not keep read absent: stencil
 * state, which no native program writes, and material plugins, which
 * generation refuses beside MeshLoD (generation-refusal.ts).
 */
const pbrMaterialRecord: RecordSpec = {
    pinned: ["PbrMaterialProps", "Material"],
    cpp: "library::PbrMaterial",
    reference: false,
    native: true,
    members: members([
        ["alphaBlend", read(optional(boolean), "pbr_alpha_blend")],
        ["_alphaCutOff", read(optional(number), "pbr_alpha_cutoff")],
        ["alpha", seeded(number, "pbr_alpha", "pbrAlpha")],
        ["stencil", read(optional({ kind: "object" }), "pbr_absent_object")],
        [
            "plugins",
            read(optional(array({ kind: "object" })), "pbr_absent_plugins"),
        ],
        ["_gammaAlbedo", read(optional(boolean), "pbr_gamma_albedo")],
        ["_transmissive", read(optional(boolean), "pbr_transmissive")],
        ["_clearCoat", read(optional(boolean), "pbr_clear_coat")],
        ["_sheen", read(optional(boolean), "pbr_sheen")],
        ["_iridescence", read(optional(boolean), "pbr_iridescence")],
        ["_anisotropy", read(optional(boolean), "pbr_anisotropy")],
        ["_subsurface", read(optional(boolean), "pbr_subsurface")],
        ["_hasUvTx", read(optional(boolean), "pbr_has_uv_transform")],
        ["_shadowOnly", read(optional(boolean), "pbr_shadow_only")],
        ["_skyboxMode", read(optional(boolean), "pbr_skybox_mode")],
        ["_unlit", read(optional(boolean), "pbr_unlit")],
        ["enableSpecularAA", read(optional(boolean), "pbr_specular_aa")],
        ["doubleSided", read(optional(boolean), "pbr_double_sided")],
        [
            "usePhysicalLightFalloff",
            read(optional(boolean), "pbr_use_physical_light_falloff"),
        ],
        [
            "occlusionTexCoord",
            read(optional(number), "pbr_occlusion_tex_coord"),
        ],
        ["_uv2Mask", read(optional(number), "pbr_occlusion_tex_coord")],
        [
            "baseColorTexture",
            read(optional(record("Texture2D")), "pbr_base_color_texture"),
        ],
        [
            "normalTexture",
            read(optional(record("Texture2D")), "pbr_normal_texture"),
        ],
        ["ormTexture", read(optional(record("Texture2D")), "pbr_orm_texture")],
        [
            "emissiveTexture",
            read(optional(record("Texture2D")), "pbr_emissive_texture"),
        ],
        [
            "lightmapTexture",
            read(optional(record("Texture2D")), "pbr_lightmap_texture"),
        ],
        [
            "specGlossTexture",
            read(optional(record("Texture2D")), "pbr_spec_gloss_texture"),
        ],
        [
            "baseColorFactor",
            seeded(
                tupleOf([number, number, number, number]),
                "pbr_base_color_factor",
                "pbrBaseColorFactor",
            ),
        ],
        [
            "_unlitColor",
            seeded(
                tupleOf([number, number, number]),
                "pbr_unlit_color",
                "unlitColor",
            ),
        ],
        [
            "_emissiveColor",
            read(
                optional(tupleOf([number, number, number])),
                "pbr_emissive_color",
            ),
        ],
        [
            "metallicFactor",
            seeded(number, "pbr_metallic_factor", "pbrMetallicFactor"),
        ],
        [
            "roughnessFactor",
            seeded(number, "pbr_roughness_factor", "pbrRoughnessFactor"),
        ],
        [
            "normalTextureScale",
            seeded(number, "pbr_normal_texture_scale", "pbrNormalTextureScale"),
        ],
        [
            "occlusionStrength",
            seeded(number, "pbr_occlusion_strength", "occlusionStrength"),
        ],
        [
            "environmentIntensity",
            seeded(
                number,
                "pbr_environment_intensity",
                "pbrEnvironmentIntensity",
            ),
        ],
        [
            "directIntensity",
            seeded(number, "pbr_direct_intensity", "pbrDirectIntensity"),
        ],
        ["reflectance", seeded(number, "pbr_reflectance", "pbrReflectance")],
        ["_uboVersion", read(number, "pbr_ubo_version")],
    ]),
};

/**
 * The engine a library holds: its WebGPU-subset device and the frame encoder
 * a scene pass names while batches flush.
 */
const libraryEngineRecord: RecordSpec = {
    pinned: ["EngineContext"],
    cpp: "Engine",
    handle: "StoredEngine",
    reference: true,
    native: true,
    members: members([
        ["_device", read(record("GPUDevice"), "engine_device")],
        [
            "_currentEncoder",
            read(record("GPUCommandEncoder"), "engine_encoder"),
        ],
        // Decided at generation (`renderer:floating-origin`).
        ["useFloatingOrigin", read(boolean, "engine_floating_origin")],
        // Device-lost recovery's capture, absent: generation refuses a
        // lowered library's textures beside recovery.
        [
            "_dlr",
            read(
                optional(record("DeviceLostRecoveryCapture")),
                "engine_device_loss_capture",
            ),
        ],
        // The frame's end hook, which the renderer runs as the pin's
        // `_renderFrame` does.
        [
            "_finishOptionalFrame",
            field(optional(fn([boolean], none)), "finish_optional_frame"),
        ],
    ]),
};

/** A device-lost recovery capture, which no lowered library records into. */
const deviceLossCaptureRecord: RecordSpec = {
    pinned: ["DeviceLostRecoveryCapture"],
    cpp: "library::DeviceLossCapture",
    reference: true,
    native: true,
    members: members([
        // A solid texture's capture (`createSolidTexture2D`).
        [
            "s",
            spelled(
                fn([record("Texture2D"), number, number, number, number], none),
                (owner) => `${owner}->refuse()`,
            ),
        ],
    ]),
};

/** The engine and the records its members name. */
export const libraryEngineRecords: readonly RecordSpec[] = [
    libraryEngineRecord,
    deviceLossCaptureRecord,
];

/** The engine, scene, camera and render-task objects a library reaches. */
export function libraryRuntimeRecords(
    sceneMembers: readonly (readonly [string, MemberSpec])[] = [],
): readonly RecordSpec[] {
    return [
        ...libraryEngineRecords,
        {
            // `scene.surface`: the scene's engine.
            pinned: ["SurfaceContext"],
            cpp: "SceneState",
            handle: "LibraryScene",
            reference: true,
            native: true,
            members: members([
                ["engine", read(record("EngineContext"), "scene_engine")],
            ]),
        },
        {
            pinned: ["SceneContext"],
            cpp: "SceneState",
            handle: "LibraryScene",
            reference: true,
            native: true,
            members: members([
                [
                    "surface",
                    {
                        shape: record("SurfaceContext"),
                        access: (owner) => owner,
                    },
                ],
                [
                    "_built",
                    {
                        shape: boolean,
                        access: (owner) => `${owner}->source_built`,
                    },
                ],
                ["_beforeRender", list("LibraryBeforeRenderList")],
                ["_disposables", list("LibraryDisposableList")],
                ["_renderables", list("LibraryRenderableList")],
                [
                    // Only advanced (`++`): the counter renderers follow.
                    "_renderableVersion",
                    field(number, "renderable_version"),
                ],
                ["_z", read(boolean, "scene_disposed")],
                ["fog", read(optional(record("FogConfig")), "scene_fog")],
                [
                    "imageProcessing",
                    {
                        shape: record("ImageProcessingConfig"),
                        access: (owner) => owner,
                    },
                ],
                [
                    "_envTextures",
                    read(
                        optional(record("EnvironmentTextures")),
                        "scene_environment",
                    ),
                ],
                // A pin field no native reader follows (bundles re-record on the
                // renderable version): kept for the pin's own reads.
                ["_materialEpoch", sceneMember("_materialEpoch", number)],
                ...sceneMembers,
            ]),
        },
        {
            // `scene.fog`, by presence: no lowered library reads its fields.
            pinned: ["FogConfig"],
            cpp: "library::Fog",
            reference: false,
            native: true,
            members: members([]),
        },
        {
            // `scene.imageProcessing`: the live tone-mapping switch and the
            // pinned curve the program selected (`imageProcessing.toneMapping`).
            pinned: ["ImageProcessingConfig"],
            cpp: "SceneState",
            handle: "LibraryScene",
            reference: true,
            native: true,
            members: members([
                [
                    "toneMappingEnabled",
                    {
                        shape: boolean,
                        access: (owner) =>
                            `${owner}->environment.tone_mapping_enabled`,
                    },
                ],
                [
                    "toneMapping",
                    read(optional(record("ToneMapping")), "scene_tone_mapping"),
                ],
            ]),
        },
        {
            // tone-mapping.ts `ToneMapping`: one of the pin's curves, as data.
            pinned: ["ToneMapping"],
            cpp: "library::ToneMapping",
            reference: false,
            native: true,
            members: members([
                ["id", field(string)],
                ["helpersWGSL", field(string, "helpers_wgsl")],
                ["callWGSL", field(string, "call_wgsl")],
            ]),
        },
        {
            pinned: ["EnvironmentTextures"],
            cpp: "library::EnvironmentTextures",
            reference: true,
            native: true,
            members: members([
                ["brdfLutView", field(gpuObject, "brdf_lut_view")],
                ["brdfSampler", field(gpuObject, "brdf_sampler")],
                ["specularCubeView", field(gpuObject, "specular_cube_view")],
                ["cubeSampler", field(gpuObject, "cube_sampler")],
            ]),
        },
        {
            // texture-2d.ts `Texture2D`, on the engine's WebGPU-subset device.
            pinned: ["Texture2D"],
            cpp: "library::Texture2D",
            reference: true,
            native: true,
            omit: new Map(
                ["_sampleType", "_uvTransformDisabled", "_recoverySource"].map(
                    (name) => [
                        name,
                        "a material or solid texture a lowered library binds is a sampled colour texture device-lost recovery does not capture",
                    ],
                ),
            ),
            members: members([
                ["texture", field(record("GPUTexture"))],
                ["view", field(gpuObject)],
                ["sampler", field(gpuObject)],
                ["width", field(number)],
                ["height", field(number)],
                ["uScale", field(optional(number))],
                ["vScale", field(optional(number))],
                ["uOffset", field(optional(number))],
                ["vOffset", field(optional(number))],
                ["uAng", field(optional(number))],
                ["invertY", field(optional(boolean))],
            ]),
        },
        pbrMaterialRecord,
        // The scene's lists, through the scene-list helpers scene programs use
        // too (`runtime.hpp`), by their SceneState field: a plain `push`
        // unless the list declares its own members, and its array view.
        ...sceneLists.map(
            ({ name, element, field, own, elements }): RecordSpec => ({
                pinned: [name],
                cpp: "SceneState",
                handle: "LibraryScene",
                reference: true,
                native: true,
                members: members([
                    ...(own ?? [
                        sceneListMember(
                            "push",
                            field,
                            fn([element], number),
                            element,
                        ),
                    ]),
                    sceneListMember(
                        "indexOf",
                        field,
                        fn([element], number),
                        element,
                    ),
                    sceneListMember(
                        "splice",
                        field,
                        fn([number, number], none),
                        element,
                    ),
                ]),
                ...(elements ? { elements } : {}),
            }),
        ),
        {
            // What a deferred builder publishes when the scene builds.
            pinned: ["DeferredSceneRenderables"],
            cpp: "library::DeferredRenderables",
            reference: false,
            native: true,
            members: members([
                ["renderables", field(array(record("Renderable")))],
                ["dispose", field(optional(fn([], none)))],
            ]),
        },
        {
            // The scene camera a pass draws with, read through its record.
            pinned: ["Camera"],
            cpp: "library::Camera",
            reference: false,
            native: true,
            members: members([
                [
                    "ortho",
                    read(
                        optional(record("OrthographicBounds")),
                        "camera_ortho",
                    ),
                ],
                ["fov", read(number, "camera_fov")],
                [
                    "viewport",
                    read(
                        optional(record("NormalizedViewport")),
                        "camera_viewport",
                    ),
                ],
                ["nearPlane", read(number, "camera_near_plane")],
                ["farPlane", read(number, "camera_far_plane")],
            ]),
        },
        {
            // The camera's orthographic planes, a null one derived from the
            // half-extent.
            pinned: ["OrthographicBounds"],
            cpp: "library::OrthographicBounds",
            reference: false,
            native: true,
            members: members([
                ["halfHeight", field(number, "half_height")],
                ["left", field(optional(number))],
                ["right", field(optional(number))],
                ["bottom", field(optional(number))],
                ["top", field(optional(number))],
            ]),
        },
        {
            pinned: ["NormalizedViewport"],
            cpp: "NormalizedViewport",
            reference: false,
            native: true,
            members: members([
                ["x", field(number)],
                ["y", field(number)],
                ["width", field(number)],
                ["height", field(number)],
            ]),
        },
        {
            pinned: ["Vec3"],
            cpp: "Vec3d",
            reference: false,
            native: true,
            members: members([
                ["x", field(number)],
                ["y", field(number)],
                ["z", field(number)],
            ]),
        },
        {
            // A scene pass's attachments, one object per distinct signature.
            pinned: ["RenderTargetSignature"],
            cpp: "GpuRenderTargetSignature",
            handle: "LibraryTargetSignature",
            reference: true,
            native: true,
            members: members([
                [
                    "_colorFormat",
                    read(optional(string), "signature_color_format"),
                ],
                [
                    "_depthStencilFormat",
                    field(optional(string), "depth_stencil_format"),
                ],
                ["_depthCompare", field(optional(string), "depth_compare")],
                ["_sampleCount", field(number, "sample_count")],
            ]),
        },
        {
            // The scene task drawing a signature's pass: what a library
            // reads of its depth and the renderables it draws.
            pinned: ["RenderTask"],
            cpp: "library::RenderTaskView",
            reference: false,
            native: true,
            members: members([
                ["_config", field(record("RenderTaskConfig"), "config")],
                [
                    "_renderables",
                    read(record("LibraryRenderableList"), "task_renderables"),
                ],
            ]),
        },
        {
            pinned: ["RenderTaskConfig"],
            cpp: "library::RenderTaskConfigView",
            reference: false,
            native: true,
            members: members([
                ["rt", field(record("RenderTarget"), "target")],
                ["depth", field(optional(record("RenderTarget")), "depth")],
                ["depthClear", field(optional(boolean), "depth_clear")],
            ]),
        },
        {
            pinned: ["RenderTarget"],
            cpp: "library::RenderTargetView",
            reference: false,
            native: true,
            members: members([
                [
                    "_depthTexture",
                    field(optional(record("GPUTexture")), "depth_texture"),
                ],
                ["_eager", field(boolean, "eager")],
            ]),
        },
        {
            pinned: ["DrawUpdateContext"],
            cpp: "library::DrawContext",
            reference: false,
            native: true,
            members: members([
                ["targetWidth", field(number, "target_width")],
                ["targetHeight", field(number, "target_height")],
                ["_camera", field(optional(record("Camera")), "camera")],
            ]),
        },
        {
            pinned: ["Renderable"],
            cpp: "library::Renderable",
            reference: true,
            native: true,
            members: members([
                ["order", field(number, "order_value")],
                ["isTransparent", field(boolean, "is_transparent")],
                [
                    "bind",
                    field(
                        fn(
                            [
                                record("EngineContext"),
                                record("RenderTargetSignature"),
                            ],
                            record("DrawBinding"),
                        ),
                        "bind_callback",
                    ),
                ],
                [
                    // The device-recovery thunk a builder stamps on what it built.
                    "_rebuild",
                    field(
                        optional(
                            fn([], promiseOf(optional(record("Renderable")))),
                        ),
                        "rebuild_callback",
                    ),
                ],
            ]),
        },
        {
            pinned: ["DrawBinding"],
            cpp: "library::DrawBinding",
            reference: true,
            native: true,
            // A binding whose pipeline its update replaces reads it through a getter.
            accessors: new Set(["pipeline"]),
            members: members([
                ["renderable", field(record("Renderable"))],
                ["pipeline", field(gpuObject)],
                [
                    "update",
                    field(
                        optional(fn([record("DrawUpdateContext")], none)),
                        "update_callback",
                    ),
                ],
                [
                    "draw",
                    field(
                        fn(
                            [
                                record("GPURenderPassEncoder"),
                                record("EngineContext"),
                            ],
                            number,
                        ),
                        "draw_callback",
                    ),
                ],
                [
                    "_updateBatches",
                    field(
                        optional(array(record("DrawUpdateBatch"))),
                        "update_batch_list",
                    ),
                ],
            ]),
        },
        {
            pinned: ["DrawUpdateBatch"],
            cpp: "library::DrawUpdateBatch",
            reference: true,
            native: true,
            members: members(drawUpdateBatchMembers),
        },
        {
            // The TRS triple `initSceneNodeTransform` adds, as the pin's
            // world-matrix composition reads it.
            pinned: ["SceneNode"],
            cpp: "library::SceneNode",
            reference: true,
            native: true,
            members: members([
                ["name", field(string)],
                ["children", field(array({ kind: "object" }))],
                ["worldMatrix", read(typedF32, "node_world_matrix")],
                [
                    "worldMatrixVersion",
                    read(number, "node_world_matrix_version"),
                ],
            ]),
        },
    ];
}

/**
 * A library's own node record over `library::SceneNode`: the SceneNode
 * members it leaves to the native node are the transform and parent the
 * application writes, which the library reads only as `worldMatrix` and
 * `worldMatrixVersion`, and the
 * clone and visibility hooks no lowered program reaches through a library
 * node; `keep` names those the record declares itself.
 */
export function librarySceneNode(
    spec: RecordSpec,
    keep: readonly string[] = [],
): RecordSpec {
    return {
        ...spec,
        bases: ["SceneNode"],
        omit: new Map([
            ...(spec.omit ?? []),
            ...[
                "position",
                "rotationQuaternion",
                "rotation",
                "scaling",
                "parent",
                "_localMatrix",
                "_localMatrixLocked",
                "visible",
                "metadata",
                "_cloneNode",
            ]
                .filter((name) => !keep.includes(name))
                .map((name): [string, string] => [
                    name,
                    "the native scene node holds the transform the library reads as worldMatrix",
                ]),
        ]),
        members: members([
            ["children", field(array({ kind: "object" }))],
            ...(spec.members ?? []),
        ]),
    };
}

/**
 * `initSceneNodeTransform(node)` over a library's own node record: the TRS
 * triple starts at the pin's defaults.
 */
export function sceneNodeTransformAdapter(
    node: string,
): readonly [string, CallAdapter] {
    return [
        "src/scene/scene-node.ts#initSceneNodeTransform",
        { cpp: (argument) => argument(0), parameters: [record(node)] },
    ];
}

/** A library's platform calls into the native engine, scene and camera. */
export const libraryRuntimeAdapters: readonly (readonly [
    string,
    CallAdapter,
])[] = [
    [
        "src/engine/gpu-resource-retirement.ts#retireGpuResources",
        {
            cpp: (argument) =>
                `${RUNTIME}::retire_gpu_resources(${argument(0)}, ${argument(1)})`,
        },
    ],
    [
        // The scene pass collects every binding's batches already.
        "src/render/draw-update-batches.ts#enableDrawBatchCollection",
        { cpp: (argument) => `static_cast<void>(${argument(0)})` },
    ],
    [
        // The one texture reference store, where a material's own reference
        // to the GPU texture a library borrows is already counted.
        "src/resource/texture-reference-store.ts#getTextureReferenceStore",
        { cpp: () => `${RUNTIME}::texture_references()` },
    ],
    [
        "src/material/pbr/pbr-local-cubemap-state.ts#_getPbrLocalEnvironment",
        {
            cpp: (argument) =>
                `${RUNTIME}::pbr_local_environment(${argument(0)})`,
            parameters: [record("PbrMaterialProps")],
            // By presence: no lowered library reads the state.
            result: optional(boolean),
        },
    ],
    [
        "src/material/pbr/pbr-material-accessors.ts#getPbrMetallicReflectance",
        {
            cpp: (argument) =>
                `${RUNTIME}::pbr_metallic_reflectance(${argument(0)})`,
            result: optional(boolean),
        },
    ],
    [
        // texture-metadata.ts reads a texture's transform reflectively.
        "src/texture/texture-metadata.ts#hasTextureTransform",
        {
            cpp: (argument) =>
                `${RUNTIME}::texture_has_transform(${argument(0)})`,
        },
    ],
    [
        // The engine's own post-submit hooks (frame-post-submit-lowerer.ts).
        "src/engine/frame-post-submit.ts#addFramePostSubmitHook",
        {
            cpp: (argument) =>
                `bbl::add_frame_post_submit_hook(${[0, 1, 2, 3].map(argument).join(", ")})`,
            parameters: [
                record("EngineContext"),
                string,
                fn([computeEncoder], none),
                optional(fn([], none)),
            ],
            result: fn([], none),
        },
    ],
    [
        // The engine's own (`mesh:render-bundle-invalidation`).
        "src/mesh/mesh-factories.ts#invalidateRenderBundles",
        {
            cpp: (argument) =>
                `bbl::invalidate_render_bundles(*${argument(0)})`,
        },
    ],
    [
        "src/render/scene-helpers.ts#getSceneBindGroupLayout",
        {
            cpp: (argument) =>
                `${RUNTIME}::scene_bind_group_layout(${argument(0)})`,
        },
    ],
    [
        "src/scene/scene-core.ts#addDeferredSceneRenderables",
        {
            cpp: (argument) =>
                `${RUNTIME}::add_deferred_scene_renderables(${argument(0)}, ${argument(1)})`,
            // The builder's renderables, or their promise.
            parameters: [
                record("SceneContext"),
                fn([record("EngineContext"), record("SceneContext")], {
                    kind: "variant",
                    members: [
                        record("DeferredSceneRenderables"),
                        promiseOf(record("DeferredSceneRenderables")),
                    ],
                }),
            ],
        },
    ],
    [
        `${CAMERA}#getCameraPosition`,
        { cpp: (argument) => `${RUNTIME}::camera_position(${argument(0)})` },
    ],
    [
        `${CAMERA}#getEffectiveAspectRatio`,
        {
            cpp: (argument) =>
                `${RUNTIME}::camera_effective_aspect_ratio(${argument(0)}, ${argument(1)}, ${argument(2)})`,
        },
    ],
    [
        `${CAMERA}#getProjectionMatrix`,
        {
            cpp: (argument) =>
                `${RUNTIME}::camera_projection_matrix(${argument(0)}, ${argument(1)})`,
        },
    ],
    [
        `${CAMERA}#getViewProjectionMatrix`,
        {
            cpp: (argument) =>
                `${RUNTIME}::camera_view_projection_matrix(${argument(0)}, ${argument(1)})`,
        },
    ],
    [
        `${CAMERA}#getViewMatrix`,
        {
            cpp: (argument) => `${RUNTIME}::camera_view_matrix(${argument(0)})`,
        },
    ],
];

/** Types declared in modules the source maps do not carry. */
export const libraryRuntimeUnresolved: readonly (readonly [
    string,
    RecordShape,
])[] = [
    ...matrixValues,
    ["Vec3", record("Vec3")],
    ["DrawUpdateContext", record("DrawUpdateContext")],
    ["Renderable", record("Renderable")],
    ["DrawBinding", record("DrawBinding")],
    ["DrawUpdateBatch", record("DrawUpdateBatch")],
];

/**
 * The sampler env-helpers.ts `assembleEnvironmentTextures` binds as
 * `member`, which samplers.ts `helper` pools from its descriptor `name`: the
 * descriptor as a WebGPU-subset `GpuSamplerDescriptor`, each stated field by
 * its native name and the rest WebGPU's defaults.
 */
function environmentSampler(
    context: LoweringContext,
    member: string,
    helper: string,
    name: string,
): string {
    const assembled = context.returnObject(
        context.functionDeclaration(
            "src/loader-env/env-helpers.ts",
            "assembleEnvironmentTextures",
        ).declaration,
    );
    const bound = objectProperty(assembled, member);
    if (!bound)
        context.contractError(
            assembled,
            `Expected assembleEnvironmentTextures to bind ${member}.`,
        );
    context.assertExpressionShape(
        bound,
        `${helper}(engine)`,
        `Environment ${member}`,
    );
    context.assertExpressionShape(
        context.returnedExpression("src/resource/samplers.ts", helper),
        `getOrCreateSampler(engine, ${name})`,
        `Environment ${member} pool`,
    );
    const descriptor = context.variableInitializer(
        context.functionDeclaration("src/resource/samplers.ts", helper).file,
        name,
    );
    const members = ts.isObjectLiteralExpression(descriptor)
        ? plainDataMembers(descriptor)
        : undefined;
    if (!members)
        context.contractError(
            descriptor,
            `Expected samplers.ts ${name} to be a plain object literal.`,
        );
    const fields = members.map(({ key, value }) => {
        if (!ts.isStringLiteral(value))
            context.contractError(
                value,
                `Expected samplers.ts ${name} to state string fields.`,
            );
        return ` sampler.${snakeCase(key)} = std::string(${stringLiteral(value.text)});`;
    });
    return `[] { GpuSamplerDescriptor sampler;${fields.join("")} return sampler; }()`;
}

/**
 * The camera functions a library calls, over the generated pinned camera
 * math, and a scene node's world matrix and Euler proxy, from the pin's
 * world-matrix composition, ObservableQuat and createEulerProxy: one header
 * every lowered library includes.
 */
export function libraryPreludeHeader(context: LoweringContext): string {
    const { file, declaration: quaternion } = context.classDeclaration(
        "src/math/observable-quat.ts",
        "ObservableQuat",
    );
    const set = quaternion.members.find(
        (node): node is ts.MethodDeclaration =>
            ts.isMethodDeclaration(node) && sameSource(node.name, "set"),
    );
    if (!set?.body)
        context.contractError(quaternion, "Expected ObservableQuat.set.");
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    const lanes = ["x", "y", "z", "w"] as const;
    const setQuaternion = new PinnedNumericLowerer(file, {
        bindings: new Map<string, PinnedBinding>([
            ["this._version", scalar("node.quaternion_version")],
            ...lanes.map((lane): [string, PinnedBinding] => [
                `this._${lane}`,
                scalar(`node.rotation_quaternion.${lane}`),
            ]),
            ...lanes.map((lane): [string, PinnedBinding] => [
                lane,
                scalar(lane),
            ]),
        ]),
        // The world matrix is composed on read; nothing caches it.
        calls: new Map([["this._onDirty", () => "static_cast<void>(node)"]]),
    }).statements(set.body.statements, "    ");
    return `#pragma once
// ${context.provenance("src/scene/scene-node.ts", "initSceneNodeTransform")}
#include <${LIBRARY_RUNTIME_HEADER}>
#include <bblite/upstream/camera_math.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>

namespace bbl::library {
/** \`scene.imageProcessing.toneMapping\`: the pinned curve the program selected, if any. */
[[nodiscard]] inline js::Nullable<ToneMapping> scene_tone_mapping(const LibraryScene& scene) {
    const auto& name = scene->environment.tone_mapping;
${toneMappingExportNames()
    .map((name) => {
        const { id, helpersWGSL, callWGSL } = pinnedToneMapping(name, context);
        return `    if (name == ${stringLiteral(name)})
        return ToneMapping{${[id, helpersWGSL, callWGSL].map(stringLiteral).join(", ")}};`;
    })
    .join("\n")}
    if (!name.empty())
        throw std::logic_error("A scene selected an unknown tone mapping.");
    return std::nullopt;
}
/** \`scene._envTextures\` (\`environment_textures\`), with the samplers the pin pools for it. */
[[nodiscard]] inline std::shared_ptr<EnvironmentTextures>
scene_environment(const LibraryScene& scene) {
    static const GpuSamplerDescriptor cube_sampler = ${environmentSampler(context, "cubeSampler", "getTrilinearSampler", "_trilinearDesc")};
    static const GpuSamplerDescriptor brdf_sampler = ${environmentSampler(context, "brdfSampler", "getBilinearSampler", "_bilinearDesc")};
    return environment_textures(scene, cube_sampler, brdf_sampler);
}
/** \`engine.useFloatingOrigin\`: the engine option generation folded. */
[[nodiscard]] inline bool engine_floating_origin(const StoredEngine&) {
    return BBLITE_FLOATING_ORIGIN != 0;
}
/** \`getCameraPosition(camera)\`: the eye in the camera's world matrix. */
[[nodiscard]] inline Vec3d camera_position(const Camera& camera) {
    const auto world = upstream::camera_world_matrix(camera.record());
    return {static_cast<double>(world[12]), static_cast<double>(world[13]),
            static_cast<double>(world[14])};
}
/** \`getEffectiveAspectRatio(camera, width, height)\`. */
[[nodiscard]] inline double camera_effective_aspect_ratio(const js::Nullable<Camera>& camera,
                                                          double width, double height) {
    return camera ? upstream::effective_aspect_ratio(camera->record(), width, height)
                  : width / height;
}
[[nodiscard]] inline js::F32Array camera_projection_matrix(const Camera& camera, double aspect) {
    return upstream::get_camera_projection_matrix(camera.record(), aspect);
}
[[nodiscard]] inline js::F32Array camera_view_projection_matrix(const Camera& camera,
                                                                double aspect) {
    return upstream::get_camera_view_projection_matrix(camera.record(), aspect);
}
[[nodiscard]] inline js::F32Array camera_view_matrix(const Camera& camera) {
    return upstream::get_camera_view_matrix(camera.record());
}

${pinnedQuaternionMath(context)}
/** ObservableQuat.set over the node's quaternion. */
inline void node_set_quaternion(SceneNode& node, double x, double y, double z, double w) {
${setQuaternion.join("\n")}
}
${pinnedEulerProxy(context, {
    parameters: "SceneNode& node",
    arguments: "node",
    prefix: "node_euler",
    rotation: "node.rotation",
    quaternion: "node.rotation_quaternion",
    version: "node.quaternion_version",
    syncedVersion: "node.synced_quaternion_version",
    mathNamespace: "bbl::library",
    setQuaternion: (args) => `node_set_quaternion(node, ${args.join(", ")})`,
})}
/**
 * \`node.worldMatrix\`: the TRS composition, under the native parent's world
 * when the node has one (world-matrix-state.ts \`getWorldMatrix\`), in the
 * allocator's Float32Array.
 */
template <class Node>
[[nodiscard]] js::F32Array node_world_matrix(const std::shared_ptr<Node>& owner) {
    const SceneNode& node = *owner;
    const auto local = upstream::trs_matrix(upstream::TrsLanes64{
        .rotation = node.rotation,
        .scaling = node.scaling,
        .position = node.position,
        .has_rotation_quaternion = true,
        .rotation_quaternion = node.rotation_quaternion});
    if (!node.parent_world)
        return js::F32Array(local.begin(), local.end());
    js::F32Array world(16);
    upstream::mat4_multiply_into_view(world, 0, node.parent_world(), 0, local, 0);
    return world;
}
/** \`node.worldMatrixVersion\`: moved when the composed world moved (\`SceneNode::world_version\`). */
template <class Node>
[[nodiscard]] double node_world_matrix_version(const std::shared_ptr<Node>& owner) {
    const SceneNode& node = *owner;
    const auto view = node_world_matrix(owner);
    std::array<float, 16> world{};
    for (std::size_t lane = 0; lane < world.size(); ++lane)
        world[lane] = view[lane];
    if (node.versioned_world != world) {
        node.versioned_world = world;
        ++node.world_version;
    }
    return node.world_version;
}
} // namespace bbl::library
`;
}
