import ts from "typescript";
import { asIndex, asObject, asRecords, areGltfIndices, GLTF_MESH_PLAN, type JsonObject } from "./gltf-document.js";
import { LoweringContext } from "./lowering/context.js";
import { gltfBaseMaterialConstruction } from "./lowering/gltf/material-construction.js";
import { ensurePinnedLoaderExecution } from "./pinned-material-input.js";
import { importPinnedModule, pinnedModuleTextUrl } from "./pinned-shader-composer.js";
import { createRecordingDevice } from "./recording-device.js";
import { transpileForBrowser } from "./typescript-transpile.js";
import { GltfGeometryPacker, type GltfMeshGeometry, type GltfRecordedGeometry } from "./gltf-mesh-geometry.js";
import { packageMeshDeformation, readMeshDeformation, type GltfMeshDeformation, type RecordedMeshDeformation } from "./gltf-mesh-deformation.js";
import { packageMeshSetup, readMeshSetup, type GltfMeshSetup, type RecordedMeshSetup, type SourceWorldBounds } from "./gltf-mesh-setup.js";

export interface GltfMeshPlan {
    /** Source material indices in assembly order; -1 denotes the implicit default. */
    cores: number[];
    /** Core record indices in native material construction order. */
    materials: number[];
    nodeVisibility: boolean[];
    meshes: Array<{node: number; primitive: number; material: number; geometry: number; name: string; flatNormal: boolean; setup: GltfMeshSetup} & GltfMeshDeformation>;
    geometries: GltfMeshGeometry[];
}
type CoreMaterial = object;
type Material = object;
interface MeshData { _nodeIndex: number; _primitive: JsonObject; _vertexCount: number }
interface Mesh extends RecordedMeshDeformation, RecordedMeshSetup { material: Material; name: string; _gpu: GltfRecordedGeometry; _flatNormal?: boolean }
interface SceneNode { visible?: boolean }
interface UploadContext {
    _engine: {_device: object}; _json: JsonObject; _binChunk: DataView; _baseUrl: string;
    _matExts: unknown[]; _wrapTex: unknown; recordMaterial(material: CoreMaterial): Promise<Material>;
    _parentMap: Map<number, number>; _worldMatrixCache: Map<number, Float32Array>;
    _nodeMap?: readonly (SceneNode | undefined)[];
}
interface MeshFeature {
    applyMesh?(data: MeshData, mesh: Mesh, context: UploadContext): void | Promise<void>;
    applyAsset?(meshes: Mesh[], root: object, context: UploadContext): Promise<object>;
}
interface SourceLoader {
    __instanceFeature: MeshFeature;
    __visibilityFeature: MeshFeature;
    __worldBounds: SourceWorldBounds;
    __attachMeshParents(scene: undefined, entity: object): void;
    __applyPreparedAssets(features: MeshFeature[], meshes: Mesh[], root: object, context: UploadContext): Promise<{entities: object[]}>;
    __prepareMeshes(json: JsonObject): Promise<{features: MeshFeature[]; parentMap: Map<number, number>; worldMatrixCache: Map<number, Float32Array>}>;
    buildNodeHierarchy(json: JsonObject, meshes: Mesh[], data: MeshData[]): {root: object; nodeMap: readonly (SceneNode | undefined)[]};
    extractAllMeshes(json: JsonObject, bin: DataView, base: string, parents: Map<number, number>, world: Map<number, Float32Array>, decoded: Map<unknown, unknown>,
        recordCore: (json: JsonObject, bin: DataView, index: number, base: string, cache: unknown[]) => Promise<CoreMaterial>): Promise<MeshData[]>;
    uploadMeshes(data: MeshData[], features: MeshFeature[],
        context: UploadContext): Promise<Mesh[]>;
}
let pinnedLoader: Promise<SourceLoader> | undefined;

function materialIdentity(): object {
    return new Proxy(Object.freeze({}), {get(_target, key) {
        if (key === "then") return undefined;
        throw new Error(`glTF scheduling reads opaque material property '${String(key)}'.`);
    }});
}

async function recordingLoader(context: LoweringContext): Promise<SourceLoader> {
    await ensurePinnedLoaderExecution();
    const sourceModule = (path: string, redirects: ReadonlyMap<string, string> = new Map()): string =>
        pinnedModuleTextUrl(path.replace(/^src\//, "").replace(/\.ts$/, ".js"),
            transpileForBrowser(context.sourceFile(path).text, path), [], redirects);
    const skeleton = sourceModule("src/loader-gltf/gltf-feature-skeleton.ts", new Map([
        ["../skeleton/create-skeleton.js", sourceModule("src/skeleton/create-skeleton.ts")],
    ]));
    const morph = sourceModule("src/loader-gltf/gltf-feature-morph.ts", new Map([
        ["../morph/create-morph-targets.js", sourceModule("src/morph/create-morph-targets.ts")],
    ]));
    const instances = sourceModule("src/loader-gltf/gltf-feature-gpu-instancing.ts", new Map([
        ["../mesh/thin-instance.js", sourceModule("src/mesh/thin-instance.ts")],
        ["../mesh/enable-thin-instance-world-bounds.js", sourceModule("src/mesh/enable-thin-instance-world-bounds.ts")],
    ]));
    const primitive = sourceModule("src/loader-gltf/gltf-feature-primitive.ts", new Map([
        ["../material/pbr/pbr-primitive-topology.js", sourceModule("src/material/pbr/pbr-primitive-topology.ts")],
    ]));
    const visibility = sourceModule("src/loader-gltf/gltf-ext-node-visibility.ts", new Map([
        ["../scene/visibility.js", sourceModule("src/scene/visibility.ts")],
    ]));
    const registry = sourceModule("src/loader-gltf/gltf-feature-registry.ts", new Map([
        ["./gltf-feature-skeleton.js", skeleton], ["./gltf-feature-morph.js", morph],
        ["./gltf-feature-gpu-instancing.js", instances], ["./gltf-feature-primitive.js", primitive],
        ["./gltf-ext-node-visibility.js", visibility],
    ]));
    const module = "src/loader-gltf/load-gltf.ts";
    const {file, call, material, uploadContext} = gltfBaseMaterialConstruction(context);
    const extraction = context.functionDeclaration(module, "extractAllMeshes").declaration;
    const assemblies = context.findNodes(extraction, (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "assembleMaterial"));
    if (assemblies.length !== 1 || assemblies[0]!.arguments.length !== 5)
        context.contractError(extraction, "Expected glTF core material assembly arguments.");
    const transformed = ts.transform(file, [visitorContext => root => {
        const visit: ts.Visitor = node => {
            if (node === call) return ts.factory.createCallExpression(
                ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(uploadContext), "recordMaterial"),
                undefined, [ts.factory.createIdentifier(material)]);
            if (node === assemblies[0]) return ts.factory.updateCallExpression(assemblies[0],
                ts.factory.createIdentifier("__recordCore"), undefined, assemblies[0].arguments);
            const visited = ts.visitEachChild(node, visit, visitorContext);
            if (node === extraction && ts.isFunctionDeclaration(visited)) return ts.factory.updateFunctionDeclaration(visited,
                visited.modifiers, visited.asteriskToken, visited.name, visited.typeParameters,
                [...visited.parameters, ts.factory.createParameterDeclaration(undefined, undefined, "__recordCore")], visited.type, visited.body);
            return visited;
        };
        return ts.visitNode(root, visit, ts.isSourceFile)!;
    }]);
    const source = transpileForBrowser(ts.createPrinter().printFile(transformed.transformed[0]!), module);
    transformed.dispose();
    // Execute the source's feature-discovery prefix, between fetched input and
    // the binary pre-parse phase already performed by asset packaging.
    const load = context.functionDeclaration(module, "loadGltf").declaration;
    const statements = load.body!.statements;
    const binaryStart = statements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "activeBin"));
    if (binaryStart < 2) context.contractError(load, "Expected the glTF feature-discovery boundary before activeBin.");
    const preparation = transpileForBrowser(`async function __prepareMeshes(json) {\n${statements.slice(1, binaryStart).map(statement => statement.getText(file)).join("\n")}\nreturn {features, parentMap, worldMatrixCache};\n}`, module);
    const assetStart = statements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "assetFragments"));
    if (assetStart < 0) context.contractError(load, "Expected the glTF asset-feature phase.");
    const assetPhase = transpileForBrowser(`async function __applyPreparedAssets(features, meshes, root, ctx) {\n${statements.slice(assetStart).map(statement => statement.getText(file)).join("\n")}\n}`, module);
    // Hierarchy construction populates children; scene attachment establishes
    // parents. Execute that complete suffix before observing world matrices.
    const attach = context.functionDeclaration("src/scene/scene-core.ts", "addToScene").declaration;
    const attachStatements = attach.body!.statements;
    const childrenStart = attachStatements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "kids"));
    if (childrenStart < 0) context.contractError(attach, "Expected scene child-attachment statements.");
    const attachment = transpileForBrowser(`function __attachMeshParents(${attach.parameters.map(parameter => parameter.getText()).join(", ")}) {\nconst addToScene = __attachMeshParents;\n${attachStatements.slice(childrenStart).map(statement => statement.getText()).join("\n")}\n}`, "src/scene/scene-core.ts");
    // Core material records are opaque to extraction. Their actual assembler
    // and the replaced PBR constructor both execute in the generated loader.
    const setupImports = `import __instanceFeature from ${JSON.stringify(instances)};\nimport __visibilityFeature from ${JSON.stringify(visibility)};\nimport * as __worldBounds from ${JSON.stringify(sourceModule("src/mesh/mesh-world-bounds.ts"))};`;
    return await import(pinnedModuleTextUrl("loader-gltf/load-gltf.js", source + "\n" + preparation + "\n" + assetPhase + "\n" + attachment + "\n" + setupImports,
        ["extractAllMeshes", "uploadMeshes", "buildNodeHierarchy", "__prepareMeshes", "__applyPreparedAssets", "__attachMeshParents", "__instanceFeature", "__visibilityFeature", "__worldBounds"],
        new Map([["./gltf-feature-registry.js", registry]]))) as SourceLoader;
}

/** Run complete pinned extraction and mesh upload with real bytes and recording GPU resources. */
export async function gltfMeshPlan(document: JsonObject, bin: DataView, context?: LoweringContext): Promise<GltfMeshPlan> {
    return (await recordMeshPlan(document, bin, context)).plan;
}

async function recordMeshPlan(document: JsonObject, bin: DataView, context?: LoweringContext): Promise<{plan: GltfMeshPlan; packer: GltfGeometryPacker}> {
    const loader = await (context ? recordingLoader(context) : pinnedLoader ??= recordingLoader(new LoweringContext()));
    const {identityTexWrap} = await importPinnedModule<{identityTexWrap: unknown}>("loader-gltf/gltf-pbr-builder.js");
    const {features, parentMap, worldMatrixCache} = await loader.__prepareMeshes(document);
    const cores: number[] = [], coreRecords = new Map<CoreMaterial, number>();
    const sourceMaterials = asRecords(document.materials);
    let imageCache: unknown[] | undefined;
    const data = await loader.extractAllMeshes(document, bin, "", parentMap, worldMatrixCache, new Map(), async (json, bytes, index, base, cache) => {
        if (json !== document || bytes !== bin || base !== "" || !Array.isArray(cache) || (imageCache && imageCache !== cache))
            throw new Error("glTF core material scheduling changed its resource ownership.");
        imageCache = cache;
        if (index !== -1 && (asIndex(index) === undefined || !sourceMaterials[index]))
            throw new Error("glTF mesh planning received an invalid source material.");
        const record = materialIdentity();
        coreRecords.set(record, cores.length);
        cores.push(index);
        return record;
    });
    const {device} = createRecordingDevice({producer: "gltf-mesh-plan", device: ["createBuffer", "createSampler", "createTexture"], queue: ["writeTexture", "writeBuffer"]});
    const materials: number[] = [];
    const builtRecords = new Map<Material, number>();
    const associations = new Map<Mesh, MeshData>();
    const uploadContext: UploadContext = {
        _engine: {_device: device}, _json: document, _binChunk: bin, _baseUrl: "", _matExts: [], _wrapTex: identityTexWrap,
        _parentMap: parentMap, _worldMatrixCache: worldMatrixCache,
        async recordMaterial(material) {
            const core = coreRecords.get(material);
            if (core === undefined) throw new Error("glTF mesh planning lost its assembled material identity.");
            const result = materialIdentity();
            builtRecords.set(result, materials.length);
            materials.push(core);
            return result;
        },
    };
    const inputs = new Set(data);
    const meshes = await loader.uploadMeshes(data, [...features, {applyMesh(input, mesh, suppliedContext) {
        if (!inputs.has(input) || suppliedContext !== uploadContext || associations.has(mesh))
            throw new Error("glTF mesh planning changed its mesh data ownership.");
        associations.set(mesh, input);
    }}], uploadContext);
    const {root, nodeMap} = loader.buildNodeHierarchy(document, meshes, data);
    uploadContext._nodeMap = nodeMap;
    // Other per-asset hooks retain their native adapters until their bindings
    // are represented. The source phase owns hook scheduling and fragment merge.
    const prepared = features.filter(feature => feature === loader.__instanceFeature || feature === loader.__visibilityFeature);
    const container = await loader.__applyPreparedAssets(prepared, meshes, root, uploadContext);
    if (Object.keys(container).some(key => key !== "entities") || !Array.isArray(container.entities) ||
        container.entities.length !== 1 || container.entities[0] !== root)
        throw new Error("Unrepresented glTF mesh asset fragment.");
    loader.__attachMeshParents(undefined, root);
    const nodes = asRecords(document.nodes), definitions = asRecords(document.meshes);
    const primitiveIndices = definitions.map(definition => new Map(asRecords(definition.primitives).map((primitive, index) => [primitive, index])));
    if (meshes.length !== data.length) throw new Error("glTF mesh planning changed its extraction cardinality.");
    const geometries = new Map<object, number>();
    const packer = new GltfGeometryPacker(document, bin);
    const geometryRecords: GltfMeshGeometry[] = [];
    const plannedMeshes = meshes.map(mesh => {
        const input = associations.get(mesh);
        if (!input || asIndex(input._nodeIndex) === undefined) throw new Error("glTF mesh planning lost its source node.");
        const node = nodes[input._nodeIndex];
        const meshIndex = asIndex(node?.mesh);
        const primitive = meshIndex === undefined ? undefined : primitiveIndices[meshIndex]?.get(input._primitive);
        if (primitive === undefined) throw new Error("glTF mesh planning lost its source primitive.");
        const material = builtRecords.get(mesh.material);
        if (material === undefined || !mesh._gpu || typeof mesh.name !== "string" ||
            (mesh._flatNormal !== undefined && typeof mesh._flatNormal !== "boolean"))
            throw new Error("glTF mesh planning lost its constructed resource identity.");
        let geometry = geometries.get(mesh._gpu);
        if (geometry === undefined) {
            geometry = geometries.size;
            geometries.set(mesh._gpu, geometry);
            geometryRecords.push(packer.geometry(mesh._gpu, input._vertexCount));
        }
        return {node: input._nodeIndex, primitive, material, geometry, name: mesh.name, flatNormal: mesh._flatNormal === true,
            setup: packageMeshSetup(mesh, loader.__worldBounds, packer),
            ...packageMeshDeformation(mesh, input._vertexCount, asIndex(node?.skin), packer)};
    });
    if (nodeMap.length !== nodes.length) throw new Error("glTF mesh planning changed its node-map cardinality.");
    const nodeVisibility = Array.from(nodeMap, node => {
        if (node?.visible !== undefined && typeof node.visible !== "boolean") throw new Error("Invalid constructed glTF node visibility.");
        return node?.visible !== false;
    });
    return {plan: {cores, materials, nodeVisibility, meshes: plannedMeshes, geometries: geometryRecords}, packer};
}

/** Read the validated source-owned schedule carried by a packaged asset. */
export function packagedGltfMeshPlan(document: JsonObject): GltfMeshPlan {
    const plan = asObject(document[GLTF_MESH_PLAN]);
    const nodes = asRecords(document.nodes);
    const sourceMaterialCount = asRecords(document.materials).length;
    if (!plan || !Array.isArray(plan.cores) || !plan.cores.every(index => index === -1 ||
        (asIndex(index) !== undefined && index < sourceMaterialCount)) ||
        !areGltfIndices(plan.materials, plan.cores.length) || !Array.isArray(plan.meshes) || !Array.isArray(plan.geometries) ||
        !Array.isArray(plan.nodeVisibility) || plan.nodeVisibility.length !== nodes.length ||
        !plan.nodeVisibility.every((value): value is boolean => typeof value === "boolean"))
        throw new Error("Invalid or missing packaged glTF mesh schedule.");
    const accessorCount = asRecords(document.accessors).length;
    const geometries = plan.geometries.map(value => {
        const geometry = asObject(value), attributes = asObject(geometry?.attributes), indices = asIndex(geometry?.indices);
        if (!attributes || indices === undefined || indices >= accessorCount ||
            !areGltfIndices(Object.values(attributes), accessorCount) ||
            !["POSITION", "NORMAL", "TEXCOORD_0"].every(key => asIndex(attributes[key]) !== undefined))
            throw new Error("Invalid packaged glTF geometry.");
        const mapped: Record<string, number> = {};
        for (const [key, value] of Object.entries(attributes)) mapped[key] = asIndex(value)!;
        return {attributes: mapped, indices};
    });
    const definitions = asRecords(document.meshes);
    const primitives = definitions.map(definition => asRecords(definition.primitives));
    const skinCount = asRecords(document.skins).length;
    const materialIndices = plan.materials, meshRecords = plan.meshes;
    const meshes = meshRecords.map(value => {
        const mesh = asObject(value);
        const node = asIndex(mesh?.node), primitive = asIndex(mesh?.primitive), material = asIndex(mesh?.material), geometry = asIndex(mesh?.geometry);
        const definition = node === undefined ? undefined : asIndex(nodes[node]?.mesh);
        if (!mesh || node === undefined || primitive === undefined || material === undefined || material >= materialIndices.length ||
            geometry === undefined || geometry >= geometries.length || typeof mesh.name !== "string" || typeof mesh.flatNormal !== "boolean" ||
            definition === undefined || !primitives[definition]?.[primitive])
            throw new Error("Invalid packaged glTF mesh resource.");
        return {node, primitive, material, geometry, name: mesh.name, flatNormal: mesh.flatNormal,
            setup: readMeshSetup(mesh.setup, accessorCount),
            ...readMeshDeformation(mesh, accessorCount, skinCount)};
    });
    return {cores: plan.cores, materials: plan.materials, nodeVisibility: plan.nodeVisibility, meshes, geometries};
}

export async function packageGltfMeshPlan(document: JsonObject, bin: DataView, context?: LoweringContext): Promise<Buffer> {
    if (GLTF_MESH_PLAN in document) throw new Error("glTF source already carries compiler mesh scheduling metadata.");
    const {plan, packer} = await recordMeshPlan(document, bin, context);
    const binary = packer.build();
    document.accessors = packer.accessors;
    document.bufferViews = packer.bufferViews;
    document.buffers = [{byteLength: binary.length}];
    document[GLTF_MESH_PLAN] = plan;
    return binary;
}
