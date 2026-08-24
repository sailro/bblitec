/**
 * The PBR arms a scene's glTF materials actually compose, from the pin.
 *
 * Babylon composes one fragment per material feature set, and a missed arm
 * reads as a small systematic shading bias instead of a failure: the
 * fragment still compiles, still binds, still draws, and is simply missing a
 * term.
 *
 * This guards that. Every material is run through the pin's own composer and
 * the arms it produces are compared against the ones the emitted fragment was
 * built with. A material that reaches an arm the fragment does not have is a
 * generation error, named after the material, rather than a number moving in
 * a parity report weeks later.
 *
 * The comparison is deliberately one-directional. The emitted fragment is a
 * union over the scene, and scene code can enable arms no glTF material asks
 * for — Scene 21's cloth gets its sheen from `setPbrSheen`, not its asset — so
 * a fragment carrying more than the assets need is normal. Carrying less is not.
 */
import {
    animatedMaterialPointerPatterns,
    asNumber,
    asObject,
    glbDocument,
    selectedVariantIndex,
    variantMaterialIndex,
    type JsonObject,
} from "./gltf-document.js";
import {
    gltfAnimatedExtensionTargets,
    gltfAnimatedMaterialPointers,
    gltfImageResolver,
    pinnedMaterialInputFromGltf,
} from "./pinned-material-input.js";
import {
    composePinnedPbrVariant,
    type PinnedComposeOptions,
    type PinnedMaterialInput,
} from "./pinned-pbr-variants.js";
import type { PinnedSceneArm } from "./pinned-scene-arms.js";
import type { ScenePbrMaterialManifest } from "./compiler/types.js";
import {
    pinnedMeshFeaturesFromPrimitive,
    skinnedMeshIndices,
} from "./pinned-mesh-features.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

/**
 * The composer's material UBO spec as plain data.
 *
 * `_offsets` is a `Map<string, number>`, so it serializes to `{}` and any
 * consumer reading the JSON would have to recompute the layout from WGSL
 * alignment rules. The pin's own `_writeMaterialData` keys every field off this
 * map, which makes it the authority on where each field sits.
 */
function plainMaterialUboSpec(spec: unknown): unknown {
    const record = spec as
        | { _totalBytes?: number; _offsets?: unknown; _structBody?: string }
        | undefined;
    if (!record) return spec;
    const offsets: Record<string, number> = {};
    if (record._offsets instanceof Map) {
        for (const [name, offset] of record._offsets as Map<string, number>) {
            offsets[name] = offset;
        }
    }
    return {
        _totalBytes: record._totalBytes,
        _offsets: offsets,
        _structBody: record._structBody,
    };
}

/** The arms the emitted fragment either has or does not have. */
export interface PinnedMaterialArms {
    clearcoat: boolean;
    /** The coat's base-F0 remap — `useF0Remap`, which no glTF coat asks for. */
    clearcoatF0Remap: boolean;
    sheen: boolean;
    sheenAlbedoScaling: boolean;
    iridescence: boolean;
    occlusionUv2: boolean;
    transmission: boolean;
    dispersion: boolean;
}

const noArms: PinnedMaterialArms = {
    clearcoat: false,
    clearcoatF0Remap: false,
    sheen: false,
    sheenAlbedoScaling: false,
    iridescence: false,
    occlusionUv2: false,
    transmission: false,
    dispersion: false,
};

/** One composed material: the pin's key for it, plus the name to blame. */
export interface PinnedComposedMaterial {
    name: string;
    fragmentKey: string;
    arms: PinnedMaterialArms;
    /**
     * The pin's own composed stages and material UBO layout for this variant.
     *
     * The composer already runs here to derive the arms; keeping its output is
     * what lets generation emit the pin's fragment instead of the transcription
     * under `templates/renderer/`. One entry per distinct `fragmentKey` is the
     * variant table the per-variant renderer needs.
     */
    vertexWgsl: string;
    fragmentWgsl: string;
    materialUboSpec: unknown;
}

type GltfDocument = {
    materials?: Record<string, unknown>[];
    animations?: unknown;
    textures?: unknown;
};

/** The shared tolerant reader, through this module's typed view of it. */
const glbView = (path: string): GltfDocument | undefined =>
    glbDocument(path) as GltfDocument | undefined;

/** One material's composer input, plus what it takes to name and place it. */
export interface MaterialSubject {
    index: number;
    name: string;
    input: PinnedMaterialInput;
    uv2Mask: number;
    /**
     * The pin's `MSH_*` bits of the first primitive that names this material,
     * in mesh order — 0 when nothing draws it. The compose gate compares each
     * material's fragment at the attribute set it is actually drawn with;
     * generation does not read this, because it keys variants on every
     * distinct attribute set instead (`composeRenderableVariants`).
     */
    meshFeatures: number;
}

/**
 * The single-light kinds a glTF asset's own KHR_lights_punctual lights reach.
 *
 * The pin's loader creates these lights exactly like scene code does, and
 * `writeMeshLightSelection` walks them the same way, so the composed arms
 * must cover their kinds even when no scene-code intrinsic declares a light
 * feature. glTF has no hemispheric light, so the mapping is the identity on
 * the three punctual kinds.
 */
export function gltfLightKinds(path: string): readonly string[] {
    const record = glbDocument(path);
    if (!record) return [];
    const extensions = record["extensions"] as
        | Record<string, unknown>
        | undefined;
    const punctual = extensions?.["KHR_lights_punctual"] as
        | { lights?: { type?: string }[] }
        | undefined;
    const kinds = new Set<string>();
    for (const light of punctual?.lights ?? []) {
        if (
            light.type === "point" ||
            light.type === "directional" ||
            light.type === "spot") {
            kinds.add(light.type);
        }
    }
    return [...kinds];
}

/**
 * How many nodes reference a punctual light — the count the pin grows
 * `MAX_LIGHTS` from: `gltf-feature-lights-punctual.ts` walks the node array
 * and calls `setMaxLights(lightNodeCount)` when it exceeds the constant.
 * This port freezes the pin's constant and the native writers stop at it, so
 * the same count is read at generation to refuse what upstream would grow.
 */
export function gltfLightNodeCount(path: string): number {
    const record = glbDocument(path);
    if (!record) return 0;
    const nodes = Array.isArray(record["nodes"])
        ? (record["nodes"] as Record<string, unknown>[])
        : [];
    let count = 0;
    for (const node of nodes) {
        const extensions = node?.["extensions"] as
            | Record<string, unknown>
            | undefined;
        const punctual = extensions?.["KHR_lights_punctual"] as
            | { light?: unknown }
            | undefined;
        if (punctual?.light !== undefined) count += 1;
    }
    return count;
}

/**
 * Whether the asset installs its own image-based light.
 *
 * `EXT_lights_image_based` carries the irradiance SH9 and the prefiltered
 * specular cubemap inside the glTF, so the scene never calls
 * `loadEnvironment` and no `environment:*` feature exists -- yet the pin
 * composes every fragment with `PBR_HAS_ENV` and the tone-mapping arms the
 * environment turns on.
 */
export function gltfHasImageBasedLight(path: string): boolean {
    const record = glbDocument(path);
    if (!record) return false;
    const used = record["extensionsUsed"];
    return Array.isArray(used) &&
        used.includes("EXT_lights_image_based");
}

/**
 * Whether the asset alone makes the scene render linear: the pin's
 * `set-transmission.ts` retargets the frame graph's colour buffer when any
 * material transmits, and marks every material `_linearImageProcessing`.
 *
 * This is the asset-side half of the flag only. Generation passes its own
 * value into `materialSubjects` instead, because scene code reaches the same
 * retarget through the `renderer:transmission` feature with no transmissive
 * material in any asset; the compose gate has only the asset, and derives
 * the flag here.
 */
export function gltfLinearImageProcessing(document: JsonObject): boolean {
    const materials = (document as GltfDocument).materials ?? [];
    return materials.some(
        (entry) =>
            (asNumber(
                asObject(
                    asObject(entry["extensions"])?.[
                        "KHR_materials_transmission"
                    ],
                )?.["transmissionFactor"],
            ) ?? 0) > 0,
    );
}

/**
 * The composer's material-shaped input for every material in a document.
 *
 * Shared by the arms scan, the variant space and the compose gate so all
 * three compose the same material: the animated-pointer scans decide whether
 * a factor becomes a uniform or a constant, and a variant built without them
 * is a different fragment. The gate consuming this construction — instead of
 * a copy of it — is what keeps a new animated pointer or loader flag from
 * silently unsyncing the gate from generation.
 */
export async function materialSubjects(
    document: JsonObject,
    scene: { linearImageProcessing?: boolean } = {},
): Promise<readonly MaterialSubject[]> {
    const view = document as GltfDocument;
    const materials = view.materials ?? [];
    const imageOf = gltfImageResolver(document);
    const animatedBaseColor = gltfAnimatedMaterialPointers(
        document,
        animatedMaterialPointerPatterns.baseColorFactor,
    );
    const animatedUvTransform = gltfAnimatedMaterialPointers(
        document,
        animatedMaterialPointerPatterns.uvTransform,
    );
    const animatedEmissive = new Set(
        animatedMaterialPointerPatterns.emissive.flatMap((pointer) => [
            ...gltfAnimatedMaterialPointers(document, pointer),
        ]),
    );
    const animatedExtensions = gltfAnimatedExtensionTargets(document);
    // Which primitive first names each material, for the subject's mesh half:
    // a second UV set or a vertex-colour stream changes the composed fragment.
    const skinned = skinnedMeshIndices(document);
    const primitiveOf = new Map<
        number,
        { mesh: number; primitive: JsonObject }
    >();
    for (const [mesh, entry] of (
        Array.isArray(document["meshes"])
            ? (document["meshes"] as JsonObject[])
            : []
    ).entries()) {
        for (const primitive of Array.isArray(entry["primitives"])
            ? (entry["primitives"] as JsonObject[])
            : []) {
            const material = asNumber(primitive["material"]);
            if (material === undefined || primitiveOf.has(material)) continue;
            primitiveOf.set(material, { mesh, primitive });
        }
    }
    const subjects: MaterialSubject[] = [];
    for (const [index, material] of materials.entries()) {
        const input = pinnedMaterialInputFromGltf(material, {
            imageOf,
            ...scene,
            animatedBaseColorFactor: animatedBaseColor.has(index),
            animatedEmissive: animatedEmissive.has(index),
            animatedUvTransform: animatedUvTransform.has(index),
            ...(animatedExtensions.has(index)
                ? { animatedExtensionTargets: animatedExtensions.get(index)! }
                : {}),
        });
        const drawn = primitiveOf.get(index);
        subjects.push({
            index,
            name: typeof material["name"] === "string"
                ? material["name"]
                : `material ${index}`,
            input,
            uv2Mask: (input["_uv2Mask"] as number | undefined) ?? 0,
            meshFeatures: drawn
                ? await pinnedMeshFeaturesFromPrimitive(drawn.primitive, {
                    skinned: skinned.has(drawn.mesh),
                })
                : 0,
        });
    }
    if (documentHasDefaultMaterial(view)) {
        // The pin's getMat(undefined) assembles the default material from an
        // empty object; the same builder over the same empty object carries
        // the glTF loader's own stamps, specular AA included.
        const input = pinnedMaterialInputFromGltf({}, {
            imageOf,
            ...scene,
            animatedBaseColorFactor: false,
            animatedEmissive: false,
            animatedUvTransform: false,
        });
        subjects.push({
            index: materials.length,
            name: "default material",
            input,
            uv2Mask: 0,
            meshFeatures: 0,
        });
    }
    return subjects;
}

/**
 * Composes every material in a glTF document and reports the arms each needs.
 *
 * The scene-shaped inputs the composer also takes — the light mode, the
 * environment, tone mapping — are deliberately left at their defaults. None of
 * them changes *which extension arms* a material composes, and the ones that
 * would need the scene's own lowered state rather than its asset.
 */
export async function composeGltfMaterials(
    path: string,
    scene: { linearImageProcessing?: boolean } = {},
): Promise<readonly PinnedComposedMaterial[]> {
    const document = glbView(path);
    if (!document) return [];
    if (
        !document.materials?.length &&
        !documentHasDefaultMaterial(document)) {
        return [];
    }
    const { PBR_HAS_ENV, PBR_HAS_SHEEN_ALBEDO_SCALING } =
        await importPinnedModule<{
            PBR_HAS_ENV: number;
            PBR_HAS_SHEEN_ALBEDO_SCALING: number;
        }>("material/pbr/pbr-flag-bits.js");
    const composed: PinnedComposedMaterial[] = [];
    for (const { name, input, uv2Mask } of await materialSubjects(
        document!,
        scene,
    )) {
        const options: PinnedComposeOptions = {
            sceneFeatures: PBR_HAS_ENV,
            uv2Mask,
        };
        const variant = await composePinnedPbrVariant(input, options);
        const key = variant.fragmentKey;
        const coat = key.includes("clearcoat");
        composed.push({
            name,
            fragmentKey: key,
            arms: {
                clearcoat: coat,
                // `-X` in the coat's own key is PBR2_CC_F0_REMAP_OFF, which
                // every glTF coat sets; a coat without it wants the remap.
                clearcoatF0Remap: coat && !/clearcoat-[A-Z]*X/.test(key),
                sheen: key.includes("sheen"),
                // The two sheen models live inside one `sheen` arm, so the key
                // does not separate them and the bit has to be read. A glTF
                // sheen always takes the scaling one, because
                // `gltf-ext-sheen.ts` passes `albedoScaling: true` — but read
                // from the composition rather than asserted, so it follows the
                // pin if that ever stops being true.
                sheenAlbedoScaling:
                    (variant.features & PBR_HAS_SHEEN_ALBEDO_SCALING) !== 0,
                iridescence: key.includes("iridescence"),
                occlusionUv2: uv2Mask !== 0,
                transmission: key.includes("refraction"),
                // Dispersion has no feature bit of its own. It rides on
                // `_subsurface.refraction.dispersion`, which the refraction
                // extension's `frag` reads off the material to choose the
                // chromatic sample, so it is read from the same place.
                dispersion:
                    (
                        asObject(
                            asObject(input["_subsurface"])?.["refraction"],
                        )?.["dispersion"]
                    ) !== undefined,
            },
            vertexWgsl: variant.vertexWgsl,
            fragmentWgsl: variant.fragmentWgsl,
            // `_offsets` is a Map, which serializes to `{}`. The pin's own
            // `_writeMaterialData` keys every field off it, so it is the
            // authority on where each field sits — carry it as an object rather
            // than recomputing the layout from alignment rules here.
            materialUboSpec: plainMaterialUboSpec(variant.materialUboSpec),
        });
    }
    return composed;
}

/** The union of arms every material in a set needs. */
export function unionArms(
    materials: readonly PinnedComposedMaterial[],
): PinnedMaterialArms {
    const union = { ...noArms };
    for (const material of materials) {
        for (const arm of Object.keys(union) as (keyof PinnedMaterialArms)[]) {
            union[arm] ||= material.arms[arm];
        }
    }
    return union;
}

/**
 * Fails when a material composes an arm the emitted fragment does not carry.
 *
 * `emitted` is what the fragment was actually built with. Extra arms there are
 * fine — the fragment is a scene-wide union and scene code contributes to it —
 * so only missing ones are reported, with the material that needs each.
 */
export function assertArmsCovered(
    materials: readonly PinnedComposedMaterial[],
    emitted: Partial<PinnedMaterialArms>,
    asset: string,
): void {
    const missing: string[] = [];
    for (const material of materials) {
        for (const arm of Object.keys(noArms) as (keyof PinnedMaterialArms)[]) {
            if (material.arms[arm] && emitted[arm] !== true) {
                missing.push(
                    `  ${JSON.stringify(material.name)} composes ` +
                        `${material.fragmentKey} and needs '${arm}'`,
                );
            }
        }
    }
    if (missing.length === 0) return;
    throw new Error(
        `The PBR fragment emitted for ${asset} is missing arms Babylon Lite ` +
            `composes for its own materials:\n${missing.join("\n")}\n` +
            "Each of these would render as a shading bias rather than a " +
            "failure, so it is refused here instead.",
    );
}

/**
 * One composed renderable variant: the stages to execute, and the tuple that
 * selects it.
 *
 * The tuple is the pin's own composition key. `pbr-renderable.ts` builds it per
 * renderable from `(features, features2, meshFeatures, sceneFeatures, lightMode,
 * singleLightType, …)`, so a variant is not a property of a material: the same
 * material on a skinned mesh and on a static one composes two fragments, and so
 * does the same mesh under one light and under three.
 */
export interface PinnedRenderableVariant {
    materialIndex: number;
    materialName: string;
    /** The pin's `MSH_*` bits for the primitive this material is drawn on. */
    meshFeatures: number;
    lightMode: 0 | 1 | 2;
    singleLightType: string;
    toneMapping: boolean;
    /** The geometry-output task this MRT variant draws in, absent for the
     *  colour passes. The selector table keys on it so a geometry draw never
     *  resolves a colour variant or the reverse. */
    geometryTask?: number;
    /** The arm's label, for provenance and to disambiguate file names. */
    armLabel: string;
    fragmentKey: string;
    vertexWgsl: string;
    fragmentWgsl: string;
    materialUboSpec: unknown;
}

/**
 * Composes the variants a scene's renderables can reach.
 *
 * The mesh half of the key comes from the asset — which attributes each
 * primitive carries, and whether its node is skinned — because that is what the
 * pin reads off the mesh. The scene half comes from `arms`: generation cannot
 * know at build time how many lights will end up affecting a given mesh, so
 * every arm the scene compiles support for is composed and the runtime selects
 * the one its own light walk produces, exactly as `rebuildSingle` does.
 */
export interface PinnedGeometryTaskRequest {
    /** The task's index in the manifest's `geometryOutputTasks` order, which
     *  is also the runtime's registration order for geometry tasks. */
    index: number;
    attachments: readonly string[];
    emitColor: boolean;
}

export async function composeRenderableVariants(
    path: string,
    arms: readonly PinnedSceneArm[],
    materialIndexBase = 0,
    scene: {
        linearImageProcessing?: boolean;
        /** The `KHR_materials_variants` this scene selected on the asset. */
        selectedVariant?: string;
    } = {},
    geometryTasks: readonly PinnedGeometryTaskRequest[] = [],
): Promise<readonly PinnedRenderableVariant[]> {
    const document = glbView(path);
    if (!document || arms.length === 0) return [];
    if (
        !document.materials?.length &&
        !documentHasDefaultMaterial(document)) {
        return [];
    }
    // The first primitive drawn with each material. A material used on two
    // primitives with different attribute sets composes two variants; the
    // renderable table keys on `(material, meshFeatures)` so both are
    // reached. Grouped from the same walk that keys the runtime's handles.
    const featureSets = new Map<number, Set<number>>();
    for (
        const renderable of await gltfRenderables(
            document,
            scene.selectedVariant,
        )
    ) {
        const set = featureSets.get(renderable.material) ?? new Set<number>();
        set.add(renderable.features);
        featureSets.set(renderable.material, set);
    }
    const subjects = await materialSubjects(document, scene);
    const variants: PinnedRenderableVariant[] = [];
    for (const subject of subjects) {
        // A material no primitive references still composes, at the attribute
        // set a primitive would have to have: scene code can assign it to a
        // mesh the asset does not, and a missing variant is a missing draw.
        for (const meshFeatures of featureSets.get(subject.index) ?? [0]) {
            for (const arm of arms) {
                const variant = await composePinnedPbrVariant(subject.input, {
                    ...arm.options,
                    meshFeatures,
                    uv2Mask: subject.uv2Mask,
                });
                variants.push({
                    materialIndex: materialIndexBase + subject.index,
                    materialName: subject.name,
                    meshFeatures,
                    lightMode: arm.lightMode,
                    singleLightType: arm.singleLightType,
                    toneMapping: arm.toneMapping,
                    armLabel: arm.label,
                    fragmentKey: variant.fragmentKey,
                    vertexWgsl: variant.vertexWgsl,
                    fragmentWgsl: variant.fragmentWgsl,
                    materialUboSpec: plainMaterialUboSpec(
                        variant.materialUboSpec,
                    ),
                });
                // The pin composes each geometry task's MRT arm from the
                // same inputs through `composePbrGeometryShader`; only the
                // fragment's return differs, one write per attachment.
                for (const task of geometryTasks) {
                    const geometry = await composePinnedPbrVariant(
                        subject.input,
                        {
                            ...arm.options,
                            meshFeatures,
                            uv2Mask: subject.uv2Mask,
                            geometry: {
                                attachments: task.attachments,
                                emitColor: task.emitColor,
                            },
                        },
                    );
                    variants.push({
                        materialIndex: materialIndexBase + subject.index,
                        materialName: subject.name,
                        meshFeatures,
                        lightMode: arm.lightMode,
                        singleLightType: arm.singleLightType,
                        toneMapping: arm.toneMapping,
                        geometryTask: task.index,
                        armLabel: `${arm.label} geometry ${task.index}`,
                        fragmentKey: geometry.fragmentKey,
                        vertexWgsl: geometry.vertexWgsl,
                        fragmentWgsl: geometry.fragmentWgsl,
                        materialUboSpec: plainMaterialUboSpec(
                            geometry.materialUboSpec,
                        ),
                    });
                }
            }
        }
    }
    return variants;
}

/**
 * Composes the variants for a scene's own `createPbrMaterial(...)` calls.
 *
 * The pin's `createPbrMaterial(props)` is `{...props}` — the props ARE the
 * material record its feature derivation and extension detects read — so the
 * composer input carries the recorded option values verbatim under the pin's
 * own names, textures as presence. Nothing loader-side is stamped: specular
 * AA, `_hasUvTx` and the per-loader option sets are glTF-loader properties a
 * scene-code material never sees, which is why this does not share the glTF
 * input builder.
 */
/** Whether any meshed primitive omits its material index, which makes the
 *  loader create the pin's default material after the document's. */
function documentHasDefaultMaterial(document: GltfDocument): boolean {
    const record = document as unknown as Record<string, unknown>;
    const meshes = Array.isArray(record["meshes"])
        ? (record["meshes"] as Record<string, unknown>[])
        : [];
    for (const mesh of meshes) {
        const primitives = mesh["primitives"];
        if (!Array.isArray(primitives)) continue;
        for (const primitive of primitives as Record<string, unknown>[]) {
            if (typeof primitive["material"] !== "number") return true;
        }
    }
    return false;
}

/** The number of materials a glTF document creates -- the declared ones plus
 *  the pin's default when any primitive omits its index. */
export function gltfMaterialCount(path: string): number {
    const document = glbView(path);
    if (!document) return 0;
    return (
        (document.materials?.length ?? 0) +
        (documentHasDefaultMaterial(document) ? 1 : 0)
    );
}

type PinnedLayerSetter<TProps> = (
    material: PinnedMaterialInput,
    props: TProps,
) => void;

/**
 * The pin's own opt-in setters. Each stamps a material's props under the
 * field name its extension's `detect` reads, so composition and the
 * compiler's intrinsics agree by construction instead of through a field
 * name restated here — the failure that leaves a composed fragment
 * missing an arm rather than failing. Resolved once and shared, since
 * every material in the sweep wants the same four.
 */
interface ScenePbrSetters {
    setPbrSheen: PinnedLayerSetter<Record<string, unknown>>;
    setPbrClearCoat: PinnedLayerSetter<Record<string, unknown>>;
    setPbrIridescence: PinnedLayerSetter<Record<string, unknown>>;
    setPbrAnisotropy: PinnedLayerSetter<Record<string, unknown>>;
    setPbrEmissive: PinnedLayerSetter<readonly number[]>;
}

let scenePbrSettersPromise: Promise<ScenePbrSetters> | undefined;

function scenePbrSetters(): Promise<ScenePbrSetters> {
    scenePbrSettersPromise ??= (async () => {
        const [sheen, clearCoat, iridescence, anisotropy, emissive] =
            await Promise.all([
                importPinnedModule<Pick<ScenePbrSetters, "setPbrSheen">>(
                    "material/pbr/set-sheen.js",
                ),
                importPinnedModule<Pick<ScenePbrSetters, "setPbrClearCoat">>(
                    "material/pbr/set-clearcoat.js",
                ),
                importPinnedModule<Pick<ScenePbrSetters, "setPbrIridescence">>(
                    "material/pbr/set-iridescence.js",
                ),
                importPinnedModule<Pick<ScenePbrSetters, "setPbrAnisotropy">>(
                    "material/pbr/set-anisotropy.js",
                ),
                importPinnedModule<Pick<ScenePbrSetters, "setPbrEmissive">>(
                    "material/pbr/set-emissive.js",
                ),
            ]);
        return {
            setPbrSheen: sheen.setPbrSheen,
            setPbrClearCoat: clearCoat.setPbrClearCoat,
            setPbrIridescence: iridescence.setPbrIridescence,
            setPbrAnisotropy: anisotropy.setPbrAnisotropy,
            setPbrEmissive: emissive.setPbrEmissive,
        };
    })();
    return scenePbrSettersPromise;
}

export async function composeScenePbrVariants(
    materials: readonly ScenePbrMaterialManifest[],
    arms: readonly PinnedSceneArm[],
    materialIndexBase = 0,
    meshFeatureSets?: readonly number[],
    scene: { linearImageProcessing?: boolean } = {},
): Promise<readonly PinnedRenderableVariant[]> {
    if (materials.length === 0 || arms.length === 0) return [];
    // Scene code can assign its material to any renderable the scene has --
    // Scene 21 stamps its sheen material across the asset's meshes -- so the
    // variants compose over every distinct attribute set in the scene, the
    // procedural builders' fixed set included.
    const featureSets = meshFeatureSets && meshFeatureSets.length > 0
        ? meshFeatureSets
        : [await proceduralRenderableFeatures()];
    const variants: PinnedRenderableVariant[] = [];
    for (const material of materials) {
        // `createPbrMaterial` is `{...props}`. Carry the resolved scene option
        // back under its own name so `_computePbrMaterialFeatures` applies the
        // pin's `(mat.occlusionStrength ?? 1) > 0` gate. The glTF input
        // builder's separate `_occlusionImage ? 1 : 0` rule does not reach
        // this scene-code path.
        const input: PinnedMaterialInput = {};
        // The pin's setPbrUnlit stamps `mat._unlit = true`, and setPbrSkybox
        // stamps `mat._skyboxMode = true`.
        if (scene.linearImageProcessing) {
            input["_linearImageProcessing"] = true;
        }
        if (material.unlit) input["_unlit"] = true;
        if (material.skyboxMode) input["_skyboxMode"] = true;
        if (material.hasBaseColorTexture) input["baseColorTexture"] = {};
        if (material.hasOrmTexture) input["ormTexture"] = {};
        input.occlusionStrength = material.occlusionStrength ?? 1;
        if (material.doubleSided) input.doubleSided = true;
        // The resolved alpha, whatever it is: `_computePbrMaterialFeatures`
        // owns the `mat.alpha < 1` blend test, so restating the threshold
        // here would be a second copy of the pin's predicate.
        input.alpha = material.alpha;
        // The layer options reach the composer through the pin's own
        // setters, exactly as the loader half runs them
        // (`pinned-material-input.ts` calls `pin.setPbrEmissive`): each
        // stamps its props under the field name its extension's `detect`
        // reads, so a field this port never names cannot be forgotten and
        // a renamed one fails instead of composing a fragment missing the
        // arm. `useF0Remap` stays absent from the coat's props: only the
        // glTF loader turns the pin's remap default off. Textures ride as
        // presence, which is all `detect` asks of them.
        const setters = await scenePbrSetters();
        if (material.sheen) {
            setters.setPbrSheen(input, {
                isEnabled: material.sheen.isEnabled,
                color: material.sheen.color,
                roughness: material.sheen.roughness,
                intensity: material.sheen.intensity,
                ...(material.sheen.hasTexture ? { texture: {} } : {}),
                ...(material.sheen.albedoScaling
                    ? { albedoScaling: true }
                    : {}),
            });
        }
        if (material.clearCoat) {
            setters.setPbrClearCoat(input, {
                isEnabled: material.clearCoat.isEnabled,
                intensity: material.clearCoat.intensity,
                roughness: material.clearCoat.roughness,
                indexOfRefraction: material.clearCoat.indexOfRefraction,
            });
        }
        if (material.iridescence) {
            setters.setPbrIridescence(input, {
                isEnabled: material.iridescence.isEnabled,
                intensity: material.iridescence.intensity,
                indexOfRefraction:
                    material.iridescence.indexOfRefraction,
                minimumThickness:
                    material.iridescence.minimumThickness,
                maximumThickness:
                    material.iridescence.maximumThickness,
            });
        }
        if (material.anisotropy) {
            setters.setPbrAnisotropy(input, {
                isEnabled: material.anisotropy.isEnabled,
                // A computed intensity states no number, so the props reach
                // the pin without one and its writer's own default applies.
                ...(material.anisotropy.intensity !== undefined
                    ? { intensity: material.anisotropy.intensity }
                    : {}),
                direction: material.anisotropy.direction,
            });
        }
        if (material.emissiveColor) {
            setters.setPbrEmissive(input, material.emissiveColor);
        }
        if (material.transmission > 0) {
            throw new Error(
                "A scene-code transmissive material has no composed arm yet; " +
                    "the refraction pass structure is the open transmission " +
                    "item.",
            );
        }
        const noColor = material.noColorView
            ? {
                  passFeatures2: (
                      await importPinnedModule<{
                          PBR2_NO_COLOR_OUTPUT: number;
                      }>("material/pbr/pbr-flag-bits.js")
                  ).PBR2_NO_COLOR_OUTPUT,
              }
            : {};
        for (const meshFeatures of featureSets) {
        for (const arm of arms) {
            const variant = await composePinnedPbrVariant(input, {
                ...arm.options,
                ...noColor,
                meshFeatures,
            });
            variants.push({
                materialIndex:
                    materialIndexBase + material.materialsBefore,
                materialName: `scene-material-${
                    materialIndexBase + material.materialsBefore
                }`,
                meshFeatures,
                lightMode: arm.lightMode,
                singleLightType: arm.singleLightType,
                toneMapping: arm.toneMapping,
                armLabel: arm.label,
                fragmentKey: variant.fragmentKey,
                vertexWgsl: variant.vertexWgsl,
                fragmentWgsl: variant.fragmentWgsl,
                materialUboSpec: plainMaterialUboSpec(
                    variant.materialUboSpec,
                ),
            });
        }
        }
    }
    return variants;
}

/**
 * One entry per renderable, in the pinned loader's own node-order walk:
 * nodes by index, a meshed node's primitives in order. This is the walk
 * that keys the runtime's mesh handles, and composition groups the same
 * entries by material, so both sides read one traversal.
 */
export async function gltfRenderables(
    document: GltfDocument,
    /** The `KHR_materials_variants` a scene selected, by name. */
    selectedVariantName?: string,
): Promise<ReadonlyArray<{ material: number; features: number }>> {
    const record = document as unknown as Record<string, unknown>;
    const nodes = Array.isArray(record["nodes"])
        ? (record["nodes"] as Record<string, unknown>[])
        : [];
    const meshes = Array.isArray(record["meshes"])
        ? (record["meshes"] as Record<string, unknown>[])
        : [];
    // A selected variant reassigns which material a mapped primitive draws
    // with, so the arms compose for the material the frame actually carries.
    const selectedVariant = selectedVariantIndex(
        record,
        selectedVariantName,
        "composition",
    );
    const renderables: { material: number; features: number }[] = [];
    for (const node of nodes) {
        const meshIndex = node["mesh"];
        if (typeof meshIndex !== "number") continue;
        const primitives = meshes[meshIndex]?.["primitives"];
        if (!Array.isArray(primitives)) continue;
        for (const primitive of primitives as Record<string, unknown>[]) {
            const material = variantMaterialIndex(
                primitive,
                selectedVariant,
            );
            renderables.push({
                material: material ?? (document.materials?.length ?? 0),
                features: await pinnedMeshFeaturesFromPrimitive(primitive, {
                    skinned: node["skin"] !== undefined,
                    instanced:
                        (node["extensions"] as
                            | Record<string, unknown>
                            | undefined)?.["EXT_mesh_gpu_instancing"] !==
                        undefined,
                }),
            });
        }
    }
    return renderables;
}

/**
 * The mesh attribute bits per renderable, in the runtime's handle order.
 */
export async function gltfRenderableFeatures(
    path: string,
): Promise<readonly number[]> {
    const document = glbView(path);
    if (!document) return [];
    return (await gltfRenderables(document)).map(
        (renderable) => renderable.features,
    );
}

/**
 * The mesh bits of the procedural builders' fixed attribute set: position,
 * normal and uv -- the same walk the glTF path runs, over that set.
 */
export function proceduralRenderableFeatures(): Promise<number> {
    return pinnedMeshFeaturesFromPrimitive({
        attributes: { POSITION: 0, NORMAL: 0, TEXCOORD_0: 0 },
    });
}
