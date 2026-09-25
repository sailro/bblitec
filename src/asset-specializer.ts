import { mkdirSync, writeFileSync } from "node:fs";
import { compressedTextureFormat } from "./compressed-texture-format.js";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { CompileAsset } from "./compiler.js";
import {
    GAUSSIAN_SPLATTING_EXTENSION,
    GAUSSIAN_SPLAT_DOCUMENT_KEY,
    GLTF_MESH_PLAN,
    asIndex,
    asObject,
    asRecords,
    primitiveRecords,
    asString,
    asStrings,
    parseGlbJson,
    selectedVariantIndex,
    variantMaterialIndex,
    type JsonRecord,
} from "./gltf-document.js";
import { sharedUpstreamStore, UpstreamSourceStore } from "./upstream-source.js";
import { refuseGeneration } from "./generation-refusal.js";
import {
    packagedGltfTransmissionPlan,
    selectedGltfTransmission,
} from "./gltf-transmission-plan.js";
import { packagedFlowGraphPrograms } from "./pinned-flow-graph.js";
import {
    gltfFeatureModules,
    packagedGltfLoaderFacts,
    pinnedGltfFeatureId,
} from "./gltf-mesh-plan.js";
import { pinnedContextOver } from "./lowering/context.js";

interface GltfSpecialization {
    asset: string;
    extensionsUsed: string[];
    renderItems: RenderItemSpecialization[];
    features: {
        /** Joints in the largest skin, which the palette transport bounds. */
        maxSkinJoints: number;
        animationPointerMaterials: boolean;
        /** Null until asynchronous material construction has packaged its selection. */
        transmissiveMaterial: boolean | null;
        specularReflectance: boolean;
        eightInfluenceSkinning: boolean;
        /** The packaged document carries converted Gaussian-splat clouds. */
        gaussianSplats: boolean;
        /** Packaging transcoded this asset's KHR_texture_basisu images. */
        compressedImages: boolean;
    };
    /** Null until packaging has recorded the pinned loader's run. */
    loader: GltfLoaderSpecialization | null;
}

/**
 * What the pinned loader's own run over the packaged document decided, read
 * from the record packaging wrote (`GltfMeshPlan.features` and each planned
 * mesh's topology) rather than from its triggers restated here.
 */
interface GltfLoaderSpecialization {
    animations: boolean;
    morphTargets: boolean;
    skins: boolean;
    /**
     * A mesh the primitive feature gave a topology other than the triangle
     * list; the generated loader carries topology handling only then.
     */
    nonTrianglePrimitives: boolean;
    /**
     * A mesh that reaches the pipeline as points, lines or a line strip. A
     * triangle strip is excluded because the generated loader expands one
     * into the triangle list it describes.
     */
    pointOrLinePrimitives: boolean;
    nodeVisibility: boolean;
    animationPointer: boolean;
    textureTransform: boolean;
    gpuInstancing: boolean;
    /** The pin's interactivity feature kept at least one graph. */
    interactivity: boolean;
}

function gltfLoaderSpecialization(
    document: JsonRecord,
    store: UpstreamSourceStore,
): GltfLoaderSpecialization {
    const facts = packagedGltfLoaderFacts(document);
    const context = pinnedContextOver(store);
    const ran = (module: string): boolean =>
        facts.features.has(pinnedGltfFeatureId(context, module));
    return {
        animations: ran(gltfFeatureModules.animations),
        morphTargets: ran(gltfFeatureModules.morph),
        skins: ran(gltfFeatureModules.skeleton),
        nonTrianglePrimitives: facts.topologies.some(
            (topology) => topology !== "triangle-list",
        ),
        pointOrLinePrimitives: facts.topologies.some(
            (topology) => !topology.startsWith("triangle-"),
        ),
        nodeVisibility: ran(gltfFeatureModules.nodeVisibility),
        animationPointer: ran(gltfFeatureModules.animationPointer),
        textureTransform: ran(gltfFeatureModules.textureTransform),
        gpuInstancing: ran(gltfFeatureModules.gpuInstancing),
        interactivity: packagedFlowGraphPrograms(document).length > 0,
    };
}

/**
 * One draw the specializer records for a glTF asset, and the shape the
 * parity attribution reads back out of the emitted JSON. Both ends of
 * that file used to declare it, so a field added to the writer was
 * simply absent from the reader's view.
 */
export interface RenderItemSpecialization {
    drawId: number;
    nodeIndex: number;
    nodeName?: string;
    meshIndex: number;
    meshName?: string;
    primitiveIndex: number;
    triangleCount: number;
    trianglesPerCluster: number;
    clusterIdStart: number;
    clusterCount: number;
    materialIndex?: number;
    materialName?: string;
    shaderVariant: "pbr";
    alphaMode: "OPAQUE" | "MASK" | "BLEND";
    doubleSided: boolean;
}

function renderItemSpecializations(
    document: JsonRecord,
    selectedVariant: number | undefined,
): RenderItemSpecialization[] {
    const nodes = asRecords(document.nodes);
    const meshes = asRecords(document.meshes);
    const materials = asRecords(document.materials);
    const accessors = asRecords(document.accessors);
    const result: RenderItemSpecialization[] = [];
    let nextClusterId = 1;
    nodes.forEach((node, nodeIndex) => {
        const meshIndex = asIndex(node.mesh);
        if (meshIndex === undefined) return;
        const mesh = meshes[meshIndex];
        if (!mesh) return;
        asRecords(mesh.primitives).forEach((primitive, primitiveIndex) => {
            const materialIndex = variantMaterialIndex(
                primitive,
                selectedVariant,
            );
            const material =
                materialIndex === undefined
                    ? undefined
                    : materials[materialIndex];
            const alphaModeValue = asString(material?.alphaMode);
            const alphaMode =
                alphaModeValue === "BLEND" || alphaModeValue === "MASK"
                    ? alphaModeValue
                    : "OPAQUE";
            const attributes = asObject(primitive.attributes);
            const indexAccessor = asIndex(primitive.indices);
            const positionAccessor = asIndex(attributes?.POSITION);
            const elementAccessor =
                indexAccessor === undefined ? positionAccessor : indexAccessor;
            const elementCount =
                elementAccessor === undefined
                    ? 0
                    : (asIndex(accessors[elementAccessor]?.count) ?? 0);
            const triangleCount =
                (asIndex(primitive.mode) ?? 4) === 4
                    ? Math.floor(elementCount / 3)
                    : 0;
            const trianglesPerCluster = 128;
            const clusterCount = Math.ceil(triangleCount / trianglesPerCluster);
            const clusterIdStart = clusterCount > 0 ? nextClusterId : 0;
            nextClusterId += clusterCount;
            result.push({
                drawId: result.length + 1,
                nodeIndex,
                ...(asString(node.name)
                    ? { nodeName: asString(node.name)! }
                    : {}),
                meshIndex,
                ...(asString(mesh.name)
                    ? { meshName: asString(mesh.name)! }
                    : {}),
                primitiveIndex,
                triangleCount,
                trianglesPerCluster,
                clusterIdStart,
                clusterCount,
                ...(materialIndex !== undefined ? { materialIndex } : {}),
                ...(asString(material?.name)
                    ? { materialName: asString(material?.name)! }
                    : {}),
                shaderVariant: "pbr",
                alphaMode,
                doubleSided: material?.doubleSided === true,
            });
        });
    });
    return result;
}

/**
 * The glTF extensions this port lowers end to end. The refusal rule below is
 * anchored on the PIN, not on the glTF spec: an extension the pinned loader
 * implements that is absent here must fail generation, because the pin would
 * change the material or geometry it builds and ignoring the extension
 * renders a plausible wrong image rather than an error —
 * `KHR_materials_pbrSpecularGlossiness` composes a spec-gloss fragment
 * upstream and the metallic-roughness one here. An extension NEITHER side
 * implements passes: both ignore it identically, so rendering agrees.
 */
const supportedExtensions = new Set<string>([
    "KHR_materials_clearcoat",
    "KHR_materials_sheen",
    "KHR_materials_iridescence",
    "KHR_materials_anisotropy",
    "KHR_materials_diffuse_transmission",
    "KHR_materials_dispersion",
    "KHR_materials_ior",
    "KHR_materials_specular",
    "KHR_materials_volume",
    "KHR_materials_transmission",
    "KHR_materials_emissive_strength",
    "KHR_materials_unlit",
    // The pin's own extension replaces the metallic-roughness workflow, and
    // generation runs it: the spec-gloss texture reaches the composed variant
    // through `PBR_HAS_SPEC_GLOSS` exactly as it does in the browser.
    "KHR_materials_pbrSpecularGlossiness",
    "KHR_texture_transform",
    "KHR_lights_punctual",
    "EXT_lights_image_based",
    "KHR_node_visibility",
    "KHR_animation_pointer",
    // The pin's loader selects its interactivity feature by the document
    // predicate `extensions.KHR_interactivity`, so the registry map below
    // never names it; generation parses the graphs through the pin and
    // the flow-graph lowering emits them (src/pinned-flow-graph.ts).
    "KHR_interactivity",
    // No loader feature reads it on either side; the flow graph's pointer
    // accessors are the only consumer, and they keep their own flag.
    "KHR_node_selectability",
    // The mappings only take effect through `selectVariant`; until a scene
    // selects, the pin reassigns nothing and both sides draw
    // `primitive.material`.
    "KHR_materials_variants",
    "EXT_mesh_gpu_instancing",
    "EXT_texture_webp",
    // Decoded away during materialization (compressed-geometry.ts), so the
    // specializer normally never sees them; listed for a direct
    // specializeGltf call over a pre-decompression asset.
    "KHR_draco_mesh_compression",
    "EXT_meshopt_compression",
    // Resolved away by the same module, running the pin's own preParse hook:
    // every quantized accessor is rewritten to tightly-packed floats and the
    // packaged document drops the extension, so the loader that ships sees an
    // ordinary asset. Listed for the same reason as the two above.
    "KHR_mesh_quantization",
    // Resolved by the same module through the pin's own hooks; a survivor is
    // refused by name beside the sparse one, below.
    GAUSSIAN_SPLATTING_EXTENSION,
    // Packaging replaces each redirected KTX2 image with the pin's GPU blocks
    // and mip list. Direct specialization can still see the source extension.
    "KHR_texture_basisu",
]);

/** Metadata-only extensions with no rendering effect on either side. */
const metadataExtensions = new Set<string>(["KHR_xmp", "KHR_xmp_json_ld"]);

/**
 * The effective image behind a texture index, through the `EXT_texture_webp`
 * source override, mirroring the generated loader's `texture_image_index`.
 */
function textureImageIndex(
    document: JsonRecord,
    textureIndex: unknown,
): number | undefined {
    const index = asIndex(textureIndex);
    if (index === undefined) return undefined;
    const texture = asRecords(document.textures)[index];
    if (!texture) return index;
    const webp = asObject(asObject(texture.extensions)?.["EXT_texture_webp"]);
    return asIndex(webp?.source) ?? asIndex(texture.source) ?? index;
}

/**
 * Fails generation for asset content the pinned loader implements and this
 * port does not, instead of shipping a binary that renders a plausible wrong
 * image (unhandled extensions, eight-influence skinning) or throws while
 * loading (an unresolved sparse accessor, the un-lowered ORM shapes). The load-time
 * checks stay in the generated loader as defense for `BBLITE_ASSET_DIR`
 * overrides; this names the asset before a native build exists.
 */
function refuseUnsupportedGltf(
    assetName: string,
    document: JsonRecord,
    accessors: JsonRecord[],
    extensionsUsed: string[],
    extensionModules: Map<string, string>,
): void {
    // The same feature also accepts the Babylon editor's serialized graphs,
    // which this port does not lower; the pin selects it by the document
    // predicate rather than by an extension name, so it is refused here.
    if (asObject(document.extensions)?.["BABYLON_flow_graph"] !== undefined) {
        refuseGeneration(
            assetName,
            `${assetName}: BABYLON_flow_graph editor JSON is run by the ` +
                `pinned loader (flow-graph/editor-serialization.ts) and not ` +
                `lowered by this port.`,
        );
    }
    for (const extension of extensionsUsed) {
        if (supportedExtensions.has(extension)) continue;
        if (metadataExtensions.has(extension)) continue;
        const pinModule = extensionModules.get(extension);
        if (pinModule !== undefined) {
            refuseGeneration(
                assetName,
                `${assetName}: glTF extension ${extension} is implemented by ` +
                    `the pinned loader${
                        pinModule !== undefined ? ` (${pinModule})` : ""
                    } and not lowered by this port, so the browser and the ` +
                    `native build would silently render different images. ` +
                    `Integrate the extension or strip it from the asset.`,
            );
        }
    }
    // Vertex attributes are deliberately NOT allowlisted here: an attribute
    // the pinned loader also ignores (TEXCOORD_2 and above — `wrapTexCoord`
    // stamps only `_texCoord: 1` — or a vendor-custom name) is ignored by
    // both sides identically, so rendering agrees. Scene 176's asset carries
    // a TEXCOORD_2 nothing samples on either side. The one attribute pair
    // the pin reads and this port does not — JOINTS_1/WEIGHTS_1 — is
    // detected as `eightInfluenceSkinning` below and recorded as a fidelity
    // adaptation rather than refused: the truncation is bounded (the second
    // pair carries the small weight tail) and Scene 7 gates it.

    // Packaging runs the pin's own `gltf-feature-sparse` preParse over every
    // asset (compressed-geometry.ts), which materializes each sparse accessor
    // into a tightly-packed bufferView and deletes `.sparse`. One surviving
    // here means the packaged document was not produced by that pass, and the
    // generated loader -- which reads `bufferView` alone, exactly as the
    // pinned `resolveAccessor` does -- would read the unpatched base values
    // and render a plausible wrong mesh.
    if (accessors.some((accessor) => accessor.sparse !== undefined)) {
        refuseGeneration(
            assetName,
            `${assetName}: a sparse glTF accessor survived packaging, so ` +
                `the pinned gltf-feature-sparse preParse did not run over ` +
                `this document.`,
        );
    }
    // The same rule for KHR_gaussian_splatting (see gltf-document.ts): the
    // generated loader carries no reader for a POINTS primitive whose
    // ellipsoid lives in custom vertex attributes.
    if (extensionsUsed.includes(GAUSSIAN_SPLATTING_EXTENSION)) {
        refuseGeneration(
            assetName,
            `${assetName}: ${GAUSSIAN_SPLATTING_EXTENSION} survived ` +
                `packaging, so the pinned Gaussian-splatting conversion did ` +
                `not run over this document.`,
        );
    }
    for (const material of asRecords(document.materials)) {
        const occlusion = asObject(material.occlusionTexture);
        if (!occlusion) continue;
        const metallicRoughness = asObject(
            asObject(material.pbrMetallicRoughness)?.metallicRoughnessTexture,
        );
        const texCoord = asIndex(occlusion.texCoord) ?? 0;
        if (texCoord > 1) {
            refuseGeneration(
                assetName,
                `${assetName}: a glTF occlusion texture on TEXCOORD_${texCoord} ` +
                    `is not lowered.`,
            );
        }
        // `buildDefaultPbrTexturesExt` builds an occlusion carrier beside a
        // metallic-roughness texture only for `occlusionNeedsSplit` -- a
        // distinct texture object, or occlusion carrying its own
        // KHR_texture_transform -- while `assemblePbrPropsExt` sets uv2 mask
        // bit 32 from the texCoord alone. Naming the same texture object on
        // TEXCOORD_1 therefore has the composed fragment declare the
        // dedicated occlusion pair with no texture behind it, which is a
        // WebGPU validation failure: the browser draws nothing at all and its
        // golden is a black canvas. Measured on a fixture before this refusal
        // was written; upstream renders it no more than we would.
        if (
            texCoord === 1 &&
            metallicRoughness !== undefined &&
            asIndex(occlusion.index) === asIndex(metallicRoughness.index) &&
            asObject(occlusion.extensions)?.["KHR_texture_transform"] ===
                undefined
        ) {
            refuseGeneration(
                assetName,
                `${assetName}: a glTF occlusion texture on TEXCOORD_1 that ` +
                    `names the same texture object as the ` +
                    `metallic-roughness slot composes an occlusion binding ` +
                    `the pinned loader builds no texture for.`,
            );
        }
        if (
            metallicRoughness !== undefined &&
            textureImageIndex(document, occlusion.index) !==
                textureImageIndex(document, metallicRoughness.index)
        ) {
            refuseGeneration(
                assetName,
                `${assetName}: distinct glTF occlusion and metallic-roughness ` +
                    `images are not lowered (upstream composites them on a ` +
                    `canvas — gltf-ext-orm.ts).`,
            );
        }
    }
}

/**
 * The pinned registry's extension→module rows, read from its own AST rather
 * than from text patterns: the former regexes hard-coded the minified prefix
 * alias, so an upstream rename would have produced a silently empty map
 * instead of a contract error. A row whose name expression the walk cannot
 * resolve — or a registry with no rows at all — fails generation naming the
 * file.
 */
function extensionModuleMap(store: UpstreamSourceStore): Map<string, string> {
    const path = "src/loader-gltf/gltf-feature-registry.ts";
    const file = store.getSourceFile(path);
    const constants = new Map<string, string>();
    const rows: Array<[ts.Expression, ts.Expression]> = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined &&
            ts.isStringLiteral(node.initializer)
        ) {
            constants.set(node.name.text, node.initializer.text);
        }
        if (ts.isArrayLiteralExpression(node) && node.elements.length === 2) {
            rows.push([node.elements[0]!, node.elements[1]!]);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    const importTarget = (expression: ts.Expression): string | undefined => {
        let found: string | undefined;
        const walk = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                node.arguments.length === 1 &&
                ts.isStringLiteral(node.arguments[0]!)
            ) {
                found = node.arguments[0].text;
            }
            ts.forEachChild(node, walk);
        };
        walk(expression);
        return found;
    };
    const result = new Map<string, string>();
    for (const [name, loader] of rows) {
        const module = importTarget(loader);
        if (module === undefined) continue;
        // The registry keys rows two ways: extension NAMES (a string
        // literal, a prefix + literal, or a string constant) and document
        // PREDICATES (arrow functions or references to them — the skeleton
        // and morph rows, `hasGltfExtras`, …). Only the named rows belong in
        // this map; which rows a document triggered is read back from the
        // packaged loader run (`gltfLoaderSpecialization`).
        if (ts.isStringLiteral(name)) {
            result.set(name.text, module);
            continue;
        }
        if (
            ts.isBinaryExpression(name) &&
            name.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isIdentifier(name.left) &&
            ts.isStringLiteral(name.right)
        ) {
            const prefix = constants.get(name.left.text);
            if (prefix === undefined) {
                refuseGeneration(
                    path,
                    `${path}: the registry prefix ${name.left.text} did not ` +
                        `resolve to a string constant.`,
                );
            }
            result.set(`${prefix}${name.right.text}`, module);
            continue;
        }
        if (ts.isIdentifier(name)) {
            const resolved = constants.get(name.text);
            if (resolved !== undefined) result.set(resolved, module);
            continue;
        }
        if (
            ts.isArrowFunction(name) ||
            ts.isFunctionExpression(name) ||
            ts.isCallExpression(name)
        ) {
            continue;
        }
        refuseGeneration(
            path,
            `${path}: a registry row's name expression has an unrecognized ` +
                `shape.`,
        );
    }
    if (result.size === 0) {
        refuseGeneration(
            path,
            `${path}: no extension registry rows were found; the registry ` +
                `shape changed.`,
        );
    }
    return result;
}

export function specializeGltf(
    /** The packaged document, parsed once by `gltfAssetDocuments`. */
    document: JsonRecord,
    assetName: string,
    /** The variant a scene's `selectVariant` chose on this asset, by name. */
    selectedVariantName?: string,
    // The process-shared store: the pin cannot change within a run, and a
    // fresh store per asset re-reads every source map. A caller that wants
    // an isolated store (a test pointing at another tree) still passes one.
    store = sharedUpstreamStore(),
): GltfSpecialization {
    const selectedVariant = selectedVariantIndex(
        document,
        selectedVariantName,
        assetName,
    );
    const extensionsUsed = asStrings(document.extensionsUsed);
    const extensionModules = extensionModuleMap(store);

    const primitives = primitiveRecords(document);
    const accessors = asRecords(document.accessors);
    refuseUnsupportedGltf(
        assetName,
        document,
        accessors,
        extensionsUsed,
        extensionModules,
    );
    // Which palette transport can carry this asset is decided by its
    // largest skin. The composed skeleton variants read the pin's own
    // per-bone texture and cap nothing; the transcribed vertex stage's
    // uniform array does, so generation compares the two.
    // `joints` is an array of node indices, so it is counted rather than
    // read through `asRecords`, which keeps only object entries.
    const maxSkinJoints = asRecords(document.skins).reduce(
        (largest, skin) =>
            Math.max(
                largest,
                Array.isArray(skin.joints) ? skin.joints.length : 0,
            ),
        0,
    );
    // The pinned loader reads a second influence pair when a primitive
    // carries one (`gltf-feature-skeleton.ts`, MSH_HAS_SKELETON_8, eight
    // influences per vertex); the generated loader reads four. Recorded per
    // scene as the `four-influence-skinning` fidelity adaptation.
    const eightInfluenceSkinning = primitives.some((primitive) =>
        Object.keys(asObject(primitive.attributes) ?? {}).some(
            (name) =>
                /^(?:JOINTS|WEIGHTS)_\d+$/.test(name) && !name.endsWith("_0"),
        ),
    );
    // Babylon Lite splits KHR_animation_pointer across modules: the base one
    // resolves node targets, and material targets pull their own. A scene
    // that animates only node visibility never carries the material writers.
    const animationPointerMaterials = asRecords(document.animations).some(
        (animation) =>
            asRecords(animation.channels).some((channel) =>
                asString(
                    asObject(
                        asObject(asObject(channel.target)?.extensions)?.[
                            "KHR_animation_pointer"
                        ],
                    )?.pointer,
                )?.startsWith("/materials/"),
            ),
    );
    const transmission = packagedGltfTransmissionPlan(document);
    const transmissiveMaterial = transmission
        ? selectedGltfTransmission(transmission, selectedVariantName)
        : null;
    // The specular half of the pinned `needsReflectance` — which also fires
    // on `ior !== 1.5` alone; that arm is folded exactly by the generated
    // loader's reflectance fold and `applyDielectric`, so this predicate
    // deliberately reads only the specular fields. A material declaring the
    // extension at factor 1 and colour (1,1,1) reaches nothing.
    const specularReflectance = asRecords(document.materials).some(
        (material) => {
            const specular = asObject(
                asObject(material.extensions)?.["KHR_materials_specular"],
            );
            if (!specular) return false;
            const factor = specular.specularFactor as number | undefined;
            const color = specular.specularColorFactor;
            return (
                specular.specularTexture !== undefined ||
                specular.specularColorTexture !== undefined ||
                (typeof factor === "number" && Math.abs(factor - 1) > 1e-6) ||
                (Array.isArray(color) &&
                    color.length === 3 &&
                    (color[0] !== 1 || color[1] !== 1 || color[2] !== 1))
            );
        },
    );
    return {
        asset: assetName,
        extensionsUsed,
        renderItems: renderItemSpecializations(document, selectedVariant),
        features: {
            maxSkinJoints,
            animationPointerMaterials,
            transmissiveMaterial,
            specularReflectance,
            eightInfluenceSkinning,
            gaussianSplats: gltfHasGaussianSplats(document),
            compressedImages: gltfHasCompressedImages(document),
        },
        loader:
            GLTF_MESH_PLAN in document
                ? gltfLoaderSpecialization(document, store)
                : null,
    };
}

/**
 * Whether packaging left converted Gaussian-splat clouds on this document.
 *
 * `KHR_gaussian_splatting`'s conversion happens at generation, so what the
 * loader ships against is the row buffer rather than the extension — which
 * packaging drops. The specializer and the asset feature join both ask the
 * rows for that reason: `loader:splat` selects the generated splat units,
 * and only the runtime feature list can do that.
 */
export function gltfHasGaussianSplats(document: JsonRecord): boolean {
    return asRecords(document[GAUSSIAN_SPLAT_DOCUMENT_KEY]).length > 0;
}

/** Packaged mip lists reach the compressed-texture reader after materialization. */
export function gltfHasCompressedImages(document: JsonRecord): boolean {
    return asRecords(document.images).some(
        (image) => image.mimeType === compressedTextureFormat.mimeType,
    );
}

export interface AssetSpecializationFeatures {
    gpuDeformation: boolean;
    morphStorage: boolean;
    /**
     * Joints in the largest skin any reached asset carries. Compared at
     * generation against the palette transport the scene's composed
     * variants select, so an unrenderable skin is named before a native
     * build exists rather than throwing at load.
     */
    maxSkinJoints: number;
    nonTrianglePrimitives: boolean;
    pointOrLinePrimitives: boolean;
    nodeVisibility: boolean;
    animationPointer: boolean;
    animationPointerMaterials: boolean;
    assetTransmission: boolean;
    materialSpecular: boolean;
    textureTransform: boolean;
    gpuInstancing: boolean;
    /** Any asset carries JOINTS_1/WEIGHTS_1 the pin would skin and this port truncates. */
    eightInfluenceSkinning: boolean;
    /** Any asset carries transcoded KHR_texture_basisu images. */
    compressedImages: boolean;
    /**
     * Any asset carries Gaussian-splat clouds. The asset alone decides: no
     * scene API reaches the extension, as none reaches the spec-gloss
     * workflow replacement.
     */
    gaussianSplats: boolean;
    /**
     * Any asset carries `KHR_interactivity` graphs. The asset alone decides
     * here too: the pinned loader feature runs the graphs whenever the
     * container is added to a scene.
     */
    interactivity: boolean;
}

/**
 * Every packaged glTF document, parsed once for everything generation asks
 * of it: the specializer and the asset feature join both read these.
 */
export function gltfAssetDocuments(
    outputRoot: string,
    assets: readonly CompileAsset[],
): ReadonlyMap<string, JsonRecord> {
    return new Map(
        assets
            .filter((asset) => asset.kind === "gltf")
            .map((asset) => [
                asset.output,
                parseGlbJson(resolve(outputRoot, "assets", asset.output)),
            ]),
    );
}

/** The document `gltfAssetDocuments` parsed for a glTF asset. */
export function gltfAssetDocument(
    documents: ReadonlyMap<string, JsonRecord>,
    asset: CompileAsset,
): JsonRecord {
    const document = documents.get(asset.output);
    if (document === undefined)
        throw new Error(`glTF asset '${asset.output}' was not parsed.`);
    return document;
}

export function emitAssetSpecializations(
    outputRoot: string,
    assets: CompileAsset[],
    documents: ReadonlyMap<string, JsonRecord>,
): AssetSpecializationFeatures {
    const gltfAssets = assets.filter((asset) => asset.kind === "gltf");
    if (gltfAssets.length === 0) {
        return {
            gpuDeformation: false,
            morphStorage: false,
            maxSkinJoints: 0,
            nonTrianglePrimitives: false,
            pointOrLinePrimitives: false,
            nodeVisibility: false,
            animationPointer: false,
            animationPointerMaterials: false,
            assetTransmission: false,
            materialSpecular: false,
            textureTransform: false,
            gpuInstancing: false,
            eightInfluenceSkinning: false,
            gaussianSplats: false,
            compressedImages: false,
            interactivity: false,
        };
    }
    let nextDrawId = 1;
    let nextClusterId = 1;
    const specializations = gltfAssets.map((asset) => {
        const specialization = specializeGltf(
            gltfAssetDocument(documents, asset),
            asset.output,
            asset.selectedVariant,
        );
        const { transmissiveMaterial } = specialization.features;
        const { loader } = specialization;
        if (transmissiveMaterial === null)
            throw new Error(
                `Asset '${asset.output}' requires packaged source transmission selection before specialization emission.`,
            );
        if (loader === null)
            throw new Error(
                `Asset '${asset.output}' requires the packaged pinned loader run before specialization emission.`,
            );
        return {
            ...specialization,
            features: { ...specialization.features, transmissiveMaterial },
            loader,
            renderItems: specialization.renderItems.map((item) => {
                const clusterIdStart =
                    item.clusterCount > 0 ? nextClusterId : 0;
                nextClusterId += item.clusterCount;
                return {
                    ...item,
                    drawId: nextDrawId++,
                    clusterIdStart,
                };
            }),
        };
    });
    const output = resolve(outputRoot, "upstream/gltf-specialization.json");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
        output,
        `${JSON.stringify(specializations, null, 2)}
`,
    );
    const anyAsset = (
        fact: (specialization: (typeof specializations)[number]) => boolean,
    ): boolean => specializations.some(fact);
    // Initial skin/morph state needs the same local-vertex transport as
    // animated nodes, even when no clip exists to update it afterward.
    const deformed = anyAsset(
        ({ loader }) =>
            loader.animations || loader.skins || loader.morphTargets,
    );
    return {
        gpuDeformation: deformed,
        // Babylon Lite has one morph mechanism -- the uncapped storage-buffer
        // path -- and the composed morph variants read it, so any morph
        // target at all compiles it in. The two-slot vertex-attribute slice
        // remains for the Standard family's transcribed stage.
        morphStorage: anyAsset(({ loader }) => loader.morphTargets),
        maxSkinJoints: specializations.reduce(
            (largest, specialization) =>
                Math.max(largest, specialization.features.maxSkinJoints),
            0,
        ),
        // Off, the generated loader carries no topology handling at all,
        // which is where upstream keeps it. The negative-determinant half of
        // the pinned primitive feature is unconditional inline code in the
        // generated loader (`clockwise_front_face`).
        nonTrianglePrimitives: anyAsset(
            ({ loader }) => loader.nonTrianglePrimitives,
        ),
        pointOrLinePrimitives: anyAsset(
            ({ loader }) => loader.pointOrLinePrimitives,
        ),
        nodeVisibility: anyAsset(({ loader }) => loader.nodeVisibility),
        animationPointer: anyAsset(({ loader }) => loader.animationPointer),
        animationPointerMaterials: anyAsset(
            ({ features }) => features.animationPointerMaterials,
        ),
        assetTransmission: anyAsset(
            ({ features }) => features.transmissiveMaterial,
        ),
        materialSpecular: anyAsset(
            ({ features }) => features.specularReflectance,
        ),
        textureTransform: anyAsset(({ loader }) => loader.textureTransform),
        gpuInstancing: anyAsset(({ loader }) => loader.gpuInstancing),
        eightInfluenceSkinning: anyAsset(
            ({ features }) => features.eightInfluenceSkinning,
        ),
        compressedImages: anyAsset(({ features }) => features.compressedImages),
        gaussianSplats: anyAsset(({ features }) => features.gaussianSplats),
        interactivity: anyAsset(({ loader }) => loader.interactivity),
    };
}
