import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CompileAsset } from "./compiler.js";
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
        skins: boolean;
        sparseAccessors: boolean;
        nonTrianglePrimitives: boolean;
        extras: boolean;
    };
}

interface RenderItemSpecialization {
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

function parseGlbJson(path: string): JsonRecord {
    const bytes = readFileSync(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${path} is not a GLB file.`);
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error(`${path} has no JSON first chunk.`);
    const text = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/[\0 ]+$/g, "");
    const parsed: unknown = JSON.parse(text);
    const record = asRecord(parsed);
    if (!record) throw new Error(`${path} GLB JSON root is not an object.`);
    return record;
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

function extensionModuleMap(store: UpstreamSourceStore): Map<string, string> {
    const source = store.getSource("src/loader-gltf/gltf-feature-registry.ts");
    const result = new Map<string, string>();
    for (const match of source.matchAll(/\["([^"]+)",\s*\(\)\s*=>\s*import\("([^"]+)"\)\]/g)) {
        result.set(match[1]!, match[2]!);
    }
    for (const match of source.matchAll(/\[M \+ "([^"]+)",\s*\(\)\s*=>\s*import\("([^"]+)"\)\]/g)) {
        result.set(`KHR_materials_${match[1]!}`, match[2]!);
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
    const animations = asRecords(document.animations).length > 0;
    const morphTargets = primitives.some((primitive) => Array.isArray(primitive.targets) && primitive.targets.length > 0);
    const skins = asRecords(document.skins).length > 0;
    const sparseAccessors = accessors.some((accessor) => accessor.sparse !== undefined);
    const nonTrianglePrimitives = primitives.some(
        (primitive) => typeof primitive.mode === "number" && primitive.mode !== 4,
    );
    const extras = hasExtras(document);

    if (animations) modules.add("./gltf-feature-animations.js");
    if (morphTargets) modules.add("./gltf-feature-morph.js");
    if (skins) modules.add("./gltf-feature-skeleton.js");
    if (sparseAccessors) modules.add("./gltf-feature-sparse.js");
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
            skins,
            sparseAccessors,
            nonTrianglePrimitives,
            extras,
        },
    };
}

export interface AssetSpecializationFeatures {
    gpuDeformation: boolean;
    imageBasedLighting: boolean;
    textureTransform: boolean;
}

export function emitAssetSpecializations(
    outputRoot: string,
    assets: CompileAsset[],
): AssetSpecializationFeatures {
    const gltfAssets = assets.filter((asset) => asset.kind === "gltf");
    if (gltfAssets.length === 0) {
        return {
            gpuDeformation: false,
            imageBasedLighting: false,
            textureTransform: false,
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
    return {
        gpuDeformation: specializations.some(
            (specialization) => specialization.features.animations,
        ),
        imageBasedLighting: specializations.some(
            (specialization) =>
                specialization.extensionsUsed.includes(
                    "EXT_lights_image_based",
                ),
        ),
        textureTransform: specializations.some(
            (specialization) =>
                specialization.extensionsUsed.includes(
                    "KHR_texture_transform",
                ),
        ),
    };
}
