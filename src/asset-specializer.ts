import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { CompileAsset } from "./compiler.js";
import { parseGlbJson } from "./gltf-document.js";
import { UpstreamSourceStore } from "./upstream-source.js";

type JsonRecord = Record<string, unknown>;

interface GltfSpecialization {
    asset: string;
    extensionsUsed: string[];
    staticModules: string[];
    renderItems: RenderItemSpecialization[];
    features: {
        animations: boolean;
        morphTargets: boolean;
        maxMorphTargets: number;
        skins: boolean;
        sparseAccessors: boolean;
        nonTrianglePrimitives: boolean;
        animationPointerMaterials: boolean;
        transmissiveMaterial: boolean;
        specularReflectance: boolean;
        extras: boolean;
        occlusionUv2: boolean;
        eightInfluenceSkinning: boolean;
        dispersionReached: boolean;
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

function asRecord(value: unknown): JsonRecord | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as JsonRecord)
        : undefined;
}

function asRecords(value: unknown): JsonRecord[] {
    return Array.isArray(value)
        ? value.map(asRecord).filter((entry): entry is JsonRecord => entry !== undefined)
        : [];
}

function asStrings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function renderItemSpecializations(document: JsonRecord): RenderItemSpecialization[] {
    const nodes = asRecords(document.nodes);
    const meshes = asRecords(document.meshes);
    const materials = asRecords(document.materials);
    const accessors = asRecords(document.accessors);
    const result: RenderItemSpecialization[] = [];
    let nextClusterId = 1;
    nodes.forEach((node, nodeIndex) => {
        const meshIndex = asNumber(node.mesh);
        if (meshIndex === undefined) return;
        const mesh = meshes[meshIndex];
        if (!mesh) return;
        asRecords(mesh.primitives).forEach((primitive, primitiveIndex) => {
            const materialIndex = asNumber(primitive.material);
            const material = materialIndex === undefined ? undefined : materials[materialIndex];
            const alphaModeValue = asString(material?.alphaMode);
            const alphaMode =
                alphaModeValue === "BLEND" || alphaModeValue === "MASK"
                    ? alphaModeValue
                    : "OPAQUE";
            const attributes = asRecord(primitive.attributes);
            const indexAccessor = asNumber(primitive.indices);
            const positionAccessor = asNumber(attributes?.POSITION);
            const elementAccessor =
                indexAccessor === undefined ? positionAccessor : indexAccessor;
            const elementCount =
                elementAccessor === undefined
                    ? 0
                    : asNumber(accessors[elementAccessor]?.count) ?? 0;
            const triangleCount = (asNumber(primitive.mode) ?? 4) === 4
                ? Math.floor(elementCount / 3)
                : 0;
            const trianglesPerCluster = 128;
            const clusterCount = Math.ceil(triangleCount / trianglesPerCluster);
            const clusterIdStart = clusterCount > 0 ? nextClusterId : 0;
            nextClusterId += clusterCount;
            result.push({
                drawId: result.length + 1,
                nodeIndex,
                ...(asString(node.name) ? { nodeName: asString(node.name)! } : {}),
                meshIndex,
                ...(asString(mesh.name) ? { meshName: asString(mesh.name)! } : {}),
                primitiveIndex,
                triangleCount,
                trianglesPerCluster,
                clusterIdStart,
                clusterCount,
                ...(materialIndex !== undefined ? { materialIndex } : {}),
                ...(asString(material?.name) ? { materialName: asString(material?.name)! } : {}),
                shaderVariant: "pbr",
                alphaMode,
                doubleSided: material?.doubleSided === true,
            });
        });
    });
    return result;
}

function primitiveRecords(document: JsonRecord): JsonRecord[] {
    return asRecords(document.meshes).flatMap((mesh) => asRecords(mesh.primitives));
}

function hasExtras(document: JsonRecord): boolean {
    const collections: unknown[] = [
        document.asset,
        document.nodes,
        document.materials,
        document.animations,
        document.meshes,
    ];
    return collections
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .some((value) => asRecord(value)?.extras !== undefined) ||
        primitiveRecords(document).some((primitive) => primitive.extras !== undefined);
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
    "KHR_materials_dispersion",
    "KHR_materials_ior",
    "KHR_materials_specular",
    "KHR_materials_volume",
    "KHR_materials_transmission",
    "KHR_materials_emissive_strength",
    "KHR_materials_unlit",
    "KHR_texture_transform",
    "KHR_lights_punctual",
    "EXT_lights_image_based",
    "KHR_node_visibility",
    "KHR_animation_pointer",
    "EXT_mesh_gpu_instancing",
    "EXT_texture_webp",
    // Decoded away during materialization (compressed-geometry.ts), so the
    // specializer normally never sees them; listed for a direct
    // specializeGltf call over a pre-decompression asset.
    "KHR_draco_mesh_compression",
    "EXT_meshopt_compression",
]);

/** Metadata-only extensions with no rendering effect on either side. */
const metadataExtensions = new Set<string>(["KHR_xmp", "KHR_xmp_json_ld"]);

/**
 * Pin-implemented extensions that do not arrive through the dynamic feature
 * registry (their modules are loader extensions dispatched elsewhere), so the
 * parsed registry cannot vouch for them; each is named explicitly because
 * ignoring it renders silently wrong. `gltf-ext-anisotropy.ts` was previously
 * caught only by the unwritten-UBO-field gate, which names a field rather
 * than the extension.
 */
const pinOnlyExtensions = new Set<string>([
    "KHR_materials_pbrSpecularGlossiness",
    "KHR_materials_anisotropy",
    "KHR_materials_diffuse_transmission",
    "KHR_texture_basisu",
    "KHR_materials_variants",
]);

/**
 * The effective image behind a texture index, through the `EXT_texture_webp`
 * source override, mirroring the generated loader's `texture_image_index`.
 */
function textureImageIndex(
    document: JsonRecord,
    textureIndex: unknown,
): number | undefined {
    const index = asNumber(textureIndex);
    if (index === undefined) return undefined;
    const texture = asRecords(document.textures)[index];
    if (!texture) return index;
    const webp = asRecord(
        asRecord(texture.extensions)?.["EXT_texture_webp"],
    );
    return asNumber(webp?.source) ?? asNumber(texture.source) ?? index;
}

/**
 * Fails generation for asset content the pinned loader implements and this
 * port does not, instead of shipping a binary that renders a plausible wrong
 * image (unhandled extensions, eight-influence skinning) or throws while
 * loading (sparse accessors, the un-lowered ORM shapes). The load-time
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
    for (const extension of extensionsUsed) {
        if (supportedExtensions.has(extension)) continue;
        if (metadataExtensions.has(extension)) continue;
        const pinModule = extensionModules.get(extension);
        if (pinModule !== undefined || pinOnlyExtensions.has(extension)) {
            throw new Error(
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
    if (accessors.some((accessor) => accessor.sparse !== undefined)) {
        throw new Error(
            `${assetName}: sparse glTF accessors are not supported ` +
                `(the pinned gltf-feature-sparse module reads them).`,
        );
    }
    for (const material of asRecords(document.materials)) {
        const occlusion = asRecord(material.occlusionTexture);
        if (!occlusion) continue;
        const metallicRoughness = asRecord(
            asRecord(material.pbrMetallicRoughness)?.metallicRoughnessTexture,
        );
        const texCoord = asNumber(occlusion.texCoord) ?? 0;
        if (texCoord === 1 && metallicRoughness !== undefined) {
            throw new Error(
                `${assetName}: a glTF occlusion texture on TEXCOORD_1 ` +
                    `alongside a metallic-roughness texture is not lowered.`,
            );
        }
        if (texCoord > 1) {
            throw new Error(
                `${assetName}: a glTF occlusion texture on TEXCOORD_${texCoord} ` +
                    `is not lowered.`,
            );
        }
        if (
            texCoord === 0 &&
            metallicRoughness !== undefined &&
            textureImageIndex(document, occlusion.index) !==
                textureImageIndex(document, metallicRoughness.index)
        ) {
            throw new Error(
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
    const source = store.getSource(path);
    const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.ES2022,
        true,
    );
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
                found = node.arguments[0]!.text;
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
        // this map; predicate rows are the asset-feature half the
        // specializer mirrors term by term elsewhere.
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
                throw new Error(
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
        throw new Error(
            `${path}: a registry row's name expression has an unrecognized ` +
                `shape.`,
        );
    }
    if (result.size === 0) {
        throw new Error(
            `${path}: no extension registry rows were found; the registry ` +
                `shape changed.`,
        );
    }
    return result;
}

export function specializeGltf(path: string, assetName: string, store = new UpstreamSourceStore()): GltfSpecialization {
    const document = parseGlbJson(path);
    const extensionsUsed = asStrings(document.extensionsUsed);
    const modules = new Set<string>();
    const extensionModules = extensionModuleMap(store);
    extensionsUsed.forEach((extension) => {
        const module = extensionModules.get(extension);
        if (module) modules.add(module);
    });

    const primitives = primitiveRecords(document);
    const accessors = asRecords(document.accessors);
    refuseUnsupportedGltf(
        assetName,
        document,
        accessors,
        extensionsUsed,
        extensionModules,
    );
    const animations = asRecords(document.animations).length > 0;
    const morphTargets = primitives.some((primitive) => Array.isArray(primitive.targets) && primitive.targets.length > 0);
    const maxMorphTargets = primitives.reduce(
        (count, primitive) =>
            Array.isArray(primitive.targets)
                ? Math.max(count, primitive.targets.length)
                : count,
        0,
    );
    // The pinned skeleton predicate, both conjuncts:
    // `!!j.skins?.length && anyPrimitive(j, p.attributes?.JOINTS_0 !== void 0)`
    // (gltf-feature-registry.ts). A skins array with no skinned primitive
    // imports nothing upstream, so it must record nothing here either.
    const skins =
        asRecords(document.skins).length > 0 &&
        primitives.some(
            (primitive) =>
                asRecord(primitive.attributes)?.JOINTS_0 !== undefined,
        );
    const sparseAccessors = accessors.some((accessor) => accessor.sparse !== undefined);
    // The pinned loader reads a second influence pair when a primitive
    // carries one (`gltf-feature-skeleton.ts`, MSH_HAS_SKELETON_8, eight
    // influences per vertex); the generated loader reads four. Recorded per
    // scene as the `four-influence-skinning` fidelity adaptation.
    const eightInfluenceSkinning = primitives.some((primitive) =>
        Object.keys(asRecord(primitive.attributes) ?? {}).some(
            (name) =>
                /^(?:JOINTS|WEIGHTS)_\d+$/.test(name) &&
                !name.endsWith("_0"),
        ),
    );
    const nonTrianglePrimitives = primitives.some(
        (primitive) => typeof primitive.mode === "number" && primitive.mode !== 4,
    );
    // Babylon Lite splits KHR_animation_pointer across modules: the base one
    // resolves node targets, and material targets pull their own. A scene
    // that animates only node visibility never carries the material writers.
    const animationPointerMaterials = asRecords(document.animations).some(
        (animation) =>
            asRecords(animation.channels).some((channel) =>
                asString(
                    asRecord(
                        asRecord(asRecord(channel.target)?.extensions)?.[
                            "KHR_animation_pointer"
                        ],
                    )?.pointer,
                )?.startsWith("/materials/"),
            ),
    );
    // Babylon Lite turns scene transmission on from the asset rather than from
    // scene code: `registerPbrTransmission` accepts a mesh whose material is
    // `_transmissive` with a refraction intensity above zero, and the dielectric
    // loader sets both from `transmissionFactor`. A declared extension with a
    // zero factor leaves the intensity at zero and reaches nothing, which is why
    // the predicate reads the factor rather than the extension.
    const transmissiveMaterial = asRecords(document.materials).some(
        (material) =>
            (asRecord(
                asRecord(material.extensions)?.["KHR_materials_transmission"],
            )?.transmissionFactor as number | undefined ?? 0) > 0,
    );
    // The specular half of the pinned `needsReflectance` — which also fires
    // on `ior !== 1.5` alone; that arm is folded exactly by the generated
    // loader's reflectance fold and `applyDielectric`, so this predicate
    // deliberately reads only the specular fields. A material declaring the
    // extension at factor 1 and colour (1,1,1) reaches nothing.
    const specularReflectance = asRecords(document.materials).some((material) => {
        const specular = asRecord(
            asRecord(material.extensions)?.["KHR_materials_specular"],
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
    });
    // The pinned `needsDispersion`, term for term (`gltf-ext-dielectric.ts`):
    // `dispersion > 0 && (!!eIor || needsTransmission) && !!eVol &&
    // (thicknessFactor > 0 || !!eVol.thicknessTexture)`, with
    // `needsTransmission = !!eTx && (intensity > 0 ||
    // !!eTx.transmissionTexture)`. Keying the capability on extension
    // presence instead shipped dispersion arms for assets whose declared
    // extension the pin never imports.
    const dispersionReached = asRecords(document.materials).some((material) => {
        const extensions = asRecord(material.extensions);
        const dispersionExtension = asRecord(
            extensions?.["KHR_materials_dispersion"],
        );
        const dispersion =
            typeof dispersionExtension?.dispersion === "number"
                ? dispersionExtension.dispersion
                : 0;
        if (!(dispersion > 0)) return false;
        const ior = asRecord(extensions?.["KHR_materials_ior"]);
        const transmission = asRecord(
            extensions?.["KHR_materials_transmission"],
        );
        const transmissionFactor =
            typeof transmission?.transmissionFactor === "number"
                ? transmission.transmissionFactor
                : 0;
        const needsTransmission =
            transmission !== undefined &&
            (transmissionFactor > 0 ||
                transmission.transmissionTexture !== undefined);
        const volume = asRecord(extensions?.["KHR_materials_volume"]);
        const thicknessFactor =
            typeof volume?.thicknessFactor === "number"
                ? volume.thicknessFactor
                : 0;
        return (
            (ior !== undefined || needsTransmission) &&
            volume !== undefined &&
            (thicknessFactor > 0 || volume.thicknessTexture !== undefined)
        );
    });
    const extras = hasExtras(document);
    // Babylon Lite's pbr-template-ext appends a dedicated occlusion
    // texture pair sampled at uv2 when a material's occlusionTexture
    // selects TEXCOORD_1.
    const occlusionUv2 = asRecords(document.materials).some(
        (material) =>
            asRecord(material.occlusionTexture)?.texCoord === 1,
    );

    if (animations) modules.add("./gltf-feature-animations.js");
    if (morphTargets) modules.add("./gltf-feature-morph.js");
    if (skins) modules.add("./gltf-feature-skeleton.js");
    // gltf-feature-sparse.js is unreachable: sparse accessors refuse at
    // generation above.
    if (nonTrianglePrimitives) modules.add("./gltf-feature-primitive.js");
    if (extras) modules.add("./gltf-feature-extras.js");

    return {
        asset: assetName,
        extensionsUsed,
        staticModules: [...modules].sort(),
        renderItems: renderItemSpecializations(document),
        features: {
            animations,
            morphTargets,
            maxMorphTargets,
            skins,
            sparseAccessors,
            nonTrianglePrimitives,
            animationPointerMaterials,
            transmissiveMaterial,
            specularReflectance,
            extras,
            occlusionUv2,
            eightInfluenceSkinning,
            dispersionReached,
        },
    };
}

export interface AssetSpecializationFeatures {
    gpuDeformation: boolean;
    /**
     * Whether the loader records a live world box beside each primitive's
     * local one: an animated primitive keeps local vertices and receives its
     * node matrix per frame, so default framing must size the box where the
     * geometry actually is. Decided by asset animations alone — a morph
     * target moves vertices, not the node box the pinned
     * `expandWorldAabbForMesh` composes.
     */
    animatedWorldBounds: boolean;
    morphStorage: boolean;
    nonTrianglePrimitives: boolean;
    nodeVisibility: boolean;
    animationPointer: boolean;
    animationPointerMaterials: boolean;
    assetTransmission: boolean;
    materialSpecular: boolean;
    imageBasedLighting: boolean;
    textureTransform: boolean;
    gpuInstancing: boolean;
    multiLight: boolean;
    clearcoat: boolean;
    sheen: boolean;
    iridescence: boolean;
    dispersion: boolean;
    occlusionUv2: boolean;
    /** Any asset carries JOINTS_1/WEIGHTS_1 the pin would skin and this port truncates. */
    eightInfluenceSkinning: boolean;
}

export function emitAssetSpecializations(
    outputRoot: string,
    assets: CompileAsset[],
): AssetSpecializationFeatures {
    const gltfAssets = assets.filter((asset) => asset.kind === "gltf");
    if (gltfAssets.length === 0) {
        return {
            gpuDeformation: false,
            animatedWorldBounds: false,
            morphStorage: false,
            nonTrianglePrimitives: false,
            nodeVisibility: false,
            animationPointer: false,
            animationPointerMaterials: false,
            assetTransmission: false,
            materialSpecular: false,
            imageBasedLighting: false,
            textureTransform: false,
            gpuInstancing: false,
            multiLight: false,
            clearcoat: false,
            sheen: false,
            iridescence: false,
            dispersion: false,
            occlusionUv2: false,
            eightInfluenceSkinning: false,
        };
    }
    let nextDrawId = 1;
    let nextClusterId = 1;
    const specializations = gltfAssets.map((asset) => {
        const specialization =
            specializeGltf(resolve(outputRoot, "assets", asset.output), asset.output);
        return {
            ...specialization,
            renderItems: specialization.renderItems.map((item) => {
                const clusterIdStart = item.clusterCount > 0 ? nextClusterId : 0;
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
    writeFileSync(output, `${JSON.stringify(specializations, null, 2)}\n`);
    const usesExtension = (extension: string): boolean =>
        specializations.some((specialization) =>
            specialization.extensionsUsed.includes(extension),
        );
    return {
        // Animation presence, and deliberately not upstream's skeleton
        // predicate: upstream recomputes node world matrices live, so its
        // skeleton module keys on skins with JOINTS_0
        // (gltf-feature-registry.ts) — but this port bakes static node
        // matrices into vertices, and ANY animated mesh needs the
        // deformation path's palette-as-world transport to receive its
        // matrix per frame (bone_matrices[0] as the final world, even with
        // no skin). Skinned-but-unanimated assets stay out on purpose: the
        // static-skin experiment diverged from the pinned output and was
        // not retained (docs/fidelity.md).
        gpuDeformation: specializations.some(
            (specialization) => specialization.features.animations,
        ),
        animatedWorldBounds: specializations.some(
            (specialization) => specialization.features.animations,
        ),
        // Babylon Lite has one morph mechanism -- the uncapped storage-buffer
        // path -- and the composed morph variants read it, so any morph
        // target at all compiles it in. The two-slot vertex-attribute slice
        // remains for the Standard family's transcribed stage.
        morphStorage: specializations.some(
            (specialization) =>
                specialization.features.maxMorphTargets > 0,
        ),
        // Half of Babylon Lite's own predicate for the dynamically imported
        // `gltf-feature-primitive.js` — the pinned registry tests
        // `hasNegDetNode(j) || anyPrimitive(mode !== 4)`, and the
        // negative-determinant half is unconditional inline code in the
        // generated loader (`mirrored_x`), so only the mode half selects the
        // module here. Off, the generated loader carries no topology handling
        // at all, which is where upstream keeps it.
        nonTrianglePrimitives: specializations.some(
            (specialization) =>
                specialization.features.nonTrianglePrimitives,
        ),
        nodeVisibility: usesExtension("KHR_node_visibility"),
        // (Dispersion keys on the evaluated pinned predicate below, not on
        // extension presence — see `dispersionReached`.)
        animationPointer: usesExtension("KHR_animation_pointer"),
        animationPointerMaterials: specializations.some(
            (specialization) =>
                specialization.features.animationPointerMaterials,
        ),
        assetTransmission: specializations.some(
            (specialization) => specialization.features.transmissiveMaterial,
        ),
        materialSpecular: specializations.some(
            (specialization) => specialization.features.specularReflectance,
        ),
        imageBasedLighting: usesExtension("EXT_lights_image_based"),
        textureTransform: usesExtension("KHR_texture_transform"),
        gpuInstancing: usesExtension("EXT_mesh_gpu_instancing"),
        multiLight: usesExtension("KHR_lights_punctual"),
        clearcoat: usesExtension("KHR_materials_clearcoat"),
        sheen: usesExtension("KHR_materials_sheen"),
        iridescence: usesExtension("KHR_materials_iridescence"),
        dispersion: specializations.some(
            (specialization) => specialization.features.dispersionReached,
        ),
        occlusionUv2: specializations.some(
            (specialization) =>
                specialization.features.occlusionUv2,
        ),
        eightInfluenceSkinning: specializations.some(
            (specialization) =>
                specialization.features.eightInfluenceSkinning,
        ),
    };
}
