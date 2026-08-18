/**
 * The PBR arms a scene's glTF materials actually compose, from the pin.
 *
 * The renderer emits one PBR fragment per scene and selects per-material
 * behaviour from uniform lanes inside it, where Babylon composes one fragment
 * per material feature set. That difference is why a missed arm reads as a
 * small systematic shading bias instead of a failure: the fragment still
 * compiles, still binds, still draws, and is simply missing a term.
 *
 * This closes that. Every material is run through the pin's own composer and
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
import { readFileSync } from "node:fs";
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

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

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

interface GltfDocument {
    materials?: Record<string, unknown>[];
    animations?: unknown;
    textures?: unknown;
}

/** Reads a .glb's JSON chunk. Returns nothing for anything else. */
function glbDocument(path: string): GltfDocument | undefined {
    let bytes: Buffer;
    try {
        bytes = readFileSync(path);
    } catch {
        return undefined;
    }
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) {
        return undefined;
    }
    const jsonLength = bytes.readUInt32LE(12);
    if (bytes.length < 20 + jsonLength) return undefined;
    try {
        return JSON.parse(
            bytes.subarray(20, 20 + jsonLength).toString("utf8"),
        ) as GltfDocument;
    } catch {
        return undefined;
    }
}

/** One material's composer input, plus what it takes to name and place it. */
interface MaterialSubject {
    index: number;
    name: string;
    input: PinnedMaterialInput;
    uv2Mask: number;
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
    const document = glbDocument(path);
    if (!document) return [];
    const record = document as unknown as Record<string, unknown>;
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
 * The composer's material-shaped input for every material in a document.
 *
 * Shared by the arms scan and the variant space so both compose the same
 * material: the animated-pointer scans decide whether a factor becomes a
 * uniform or a constant, and a variant built without them is a different
 * fragment.
 */
async function materialSubjects(
    document: GltfDocument,
    scene: { linearImageProcessing?: boolean } = {},
): Promise<readonly MaterialSubject[]> {
    const materials = document.materials ?? [];
    const record = document as unknown as Record<string, unknown>;
    const imageOf = gltfImageResolver(record);
    const animatedBaseColor = gltfAnimatedMaterialPointers(
        record,
        "pbrMetallicRoughness/baseColorFactor",
    );
    const animatedUvTransform = gltfAnimatedMaterialPointers(
        record,
        ".*/KHR_texture_transform/(?:offset|scale|rotation)",
    );
    const animatedEmissive = new Set([
        ...gltfAnimatedMaterialPointers(record, "emissiveFactor"),
        ...gltfAnimatedMaterialPointers(
            record,
            "extensions/KHR_materials_emissive_strength/emissiveStrength",
        ),
    ]);
    const animatedExtensions = gltfAnimatedExtensionTargets(record);
    const subjects = materials.map((material, index) => {
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
        return {
            index,
            name: typeof material["name"] === "string"
                ? material["name"]
                : `material ${index}`,
            input,
            uv2Mask: (input["_uv2Mask"] as number | undefined) ?? 0,
        };
    });
    if (documentHasDefaultMaterial(document)) {
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
    const document = glbDocument(path);
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
                        asRecord(
                            asRecord(input["_subsurface"])?.["refraction"],
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
export async function composeRenderableVariants(
    path: string,
    arms: readonly PinnedSceneArm[],
    materialIndexBase = 0,
    scene: { linearImageProcessing?: boolean } = {},
): Promise<readonly PinnedRenderableVariant[]> {
    const document = glbDocument(path);
    if (!document || arms.length === 0) return [];
    if (
        !document.materials?.length &&
        !documentHasDefaultMaterial(document)) {
        return [];
    }
    const record = document as unknown as Record<string, unknown>;
    const skinned = skinnedMeshIndices(record);
    // The first primitive drawn with each material. A material used on two
    // primitives with different attribute sets composes two variants; the
    // renderable table keys on `(material, meshFeatures)` so both are reached.
    const featureSets = new Map<number, Set<number>>();
    const nodes = Array.isArray(record["nodes"])
        ? (record["nodes"] as Record<string, unknown>[])
        : [];
    const meshes = Array.isArray(record["meshes"])
        ? (record["meshes"] as Record<string, unknown>[])
        : [];
    for (const node of nodes) {
        const meshIndex = node["mesh"];
        if (typeof meshIndex !== "number") continue;
        const primitives = meshes[meshIndex]?.["primitives"];
        if (!Array.isArray(primitives)) continue;
        for (const primitive of primitives as Record<string, unknown>[]) {
            const material = typeof primitive["material"] === "number"
                ? (primitive["material"] as number)
                : (document.materials?.length ?? 0);
            const features = await pinnedMeshFeaturesFromPrimitive(primitive, {
                skinned: skinned.has(meshIndex),
                instanced:
                    (node["extensions"] as Record<string, unknown> | undefined)
                        ?.["EXT_mesh_gpu_instancing"] !== undefined,
            });
            const set = featureSets.get(material) ?? new Set<number>();
            set.add(features);
            featureSets.set(material, set);
        }
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
    const document = glbDocument(path);
    if (!document) return 0;
    return (
        (document.materials?.length ?? 0) +
        (documentHasDefaultMaterial(document) ? 1 : 0)
    );
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
        const input: PinnedMaterialInput = {
            // No createPbrMaterial option carries an occlusion image, and a
            // material without one composes the constant 1.0 rather than
            // sampling orm.r -- the same `_occlusionImage ? 1 : 0` rule the
            // glTF input builder documents.
            occlusionStrength: 0,
        };
        // The pin's setPbrUnlit stamps `mat._unlit = true`, and setPbrSkybox
        // stamps `mat._skyboxMode = true`.
        if (scene.linearImageProcessing) {
            input["_linearImageProcessing"] = true;
        }
        if (material.unlit) input["_unlit"] = true;
        if (material.skyboxMode) input["_skyboxMode"] = true;
        if (material.hasBaseColorTexture) input["baseColorTexture"] = {};
        if (material.hasOrmTexture) input["ormTexture"] = {};
        if (material.doubleSided) input.doubleSided = true;
        // The pin reads `mat.alpha < 1` for the blend bit; a material that
        // never passed alpha carries no field, and one that passed 1 composes
        // identically, so only a blending alpha is carried.
        if (material.alpha < 1) input.alpha = material.alpha;
        // The pin's setters stamp the props object verbatim; the extension
        // detects read `_sheen` and `_clearCoat` off the material, so the
        // recorded options land under those names, textures as presence.
        // `useF0Remap` stays absent: only the glTF loader turns the pin's
        // remap default off.
        if (material.sheen) {
            input["_sheen"] = {
                isEnabled: material.sheen.isEnabled,
                color: material.sheen.color,
                roughness: material.sheen.roughness,
                intensity: material.sheen.intensity,
                ...(material.sheen.hasTexture ? { texture: {} } : {}),
                ...(material.sheen.albedoScaling
                    ? { albedoScaling: true }
                    : {}),
            };
        }
        if (material.clearCoat) {
            input["_clearCoat"] = {
                isEnabled: material.clearCoat.isEnabled,
                intensity: material.clearCoat.intensity,
                roughness: material.clearCoat.roughness,
                indexOfRefraction: material.clearCoat.indexOfRefraction,
            };
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
 * The mesh bits for every renderable a glTF document creates, keyed by the
 * runtime mesh handle.
 *
 * The pinned loader walks nodes in index order and each meshed node's
 * primitives in order (`load-gltf.ts`), and the lowered loader pushes one
 * MeshRecord per step of that same walk -- so index `i` here is runtime mesh
 * handle `i` for a scene whose meshes all come from this asset. The skeleton
 * bit is the node's: a skin sits on the node, not the mesh.
 */
export async function gltfRenderableFeatures(
    path: string,
): Promise<readonly number[]> {
    const document = glbDocument(path) as
        | (GltfDocument & Record<string, unknown>)
        | undefined;
    if (!document) return [];
    const nodes = Array.isArray(document["nodes"])
        ? (document["nodes"] as Record<string, unknown>[])
        : [];
    const meshes = Array.isArray(document["meshes"])
        ? (document["meshes"] as Record<string, unknown>[])
        : [];
    const features: number[] = [];
    for (const node of nodes) {
        const meshIndex = node["mesh"];
        if (typeof meshIndex !== "number") continue;
        const primitives = meshes[meshIndex]?.["primitives"];
        if (!Array.isArray(primitives)) continue;
        for (const primitive of primitives as Record<string, unknown>[]) {
            features.push(
                await pinnedMeshFeaturesFromPrimitive(primitive, {
                    skinned: node["skin"] !== undefined,
                    instanced:
                        (node["extensions"] as
                            | Record<string, unknown>
                            | undefined)?.["EXT_mesh_gpu_instancing"] !==
                        undefined,
                }),
            );
        }
    }
    return features;
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
