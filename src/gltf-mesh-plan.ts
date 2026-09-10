import ts from "typescript";
import { asIndex, asObject, asRecords, areGltfIndices, GLTF_MESH_PLAN, type JsonObject } from "./gltf-document.js";
import { LoweringContext } from "./lowering/context.js";
import { gltfBaseMaterialConstruction } from "./lowering/gltf/material-construction.js";
import { ensurePinnedLoaderExecution } from "./pinned-material-input.js";
import { importPinnedModule, pinnedModuleTextUrl } from "./pinned-shader-composer.js";
import { createRecordingDevice } from "./recording-device.js";
import { transpileForBrowser } from "./typescript-transpile.js";

export interface GltfMeshPlan {
    /** Source material indices in assembly order; -1 denotes the implicit default. */
    cores: number[];
    /** Core record indices in native material construction order. */
    materials: number[];
    meshes: Array<{node: number; primitive: number; material: number; geometry: number; name: string}>;
}
type CoreMaterial = object;
type Material = object;
interface MeshData { _nodeIndex: number; _primitive: JsonObject }
interface Mesh { material: Material; name: string; _gpu: object }
interface UploadContext {
    _engine: {_device: object}; _json: JsonObject; _binChunk: DataView; _baseUrl: string;
    _matExts: unknown[]; _wrapTex: unknown; recordMaterial(material: CoreMaterial): Promise<Material>;
}
interface SourceLoader {
    extractAllMeshes(json: JsonObject, bin: DataView, base: string, parents: Map<number, number>, world: Map<number, Float32Array>, decoded: Map<unknown, unknown>,
        recordCore: (json: JsonObject, bin: DataView, index: number, base: string, cache: unknown[]) => Promise<CoreMaterial>): Promise<MeshData[]>;
    uploadMeshes(data: MeshData[], features: Array<{applyMesh(data: MeshData, mesh: Mesh, context: UploadContext): void}>,
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
    // Core material records are opaque to extraction. Their actual assembler
    // and the replaced PBR constructor both execute in the generated loader.
    return await import(pinnedModuleTextUrl("loader-gltf/load-gltf.js", source, ["extractAllMeshes", "uploadMeshes"])) as SourceLoader;
}

/** Run complete pinned extraction and mesh upload with real bytes and recording GPU resources. */
export async function gltfMeshPlan(document: JsonObject, bin: DataView, context?: LoweringContext): Promise<GltfMeshPlan> {
    const loader = await (context ? recordingLoader(context) : pinnedLoader ??= recordingLoader(new LoweringContext()));
    const {buildParentMap} = await importPinnedModule<{buildParentMap(json: JsonObject): Map<number, number>}>("loader-gltf/gltf-parser.js");
    const {identityTexWrap} = await importPinnedModule<{identityTexWrap: unknown}>("loader-gltf/gltf-pbr-builder.js");
    const cores: number[] = [], coreRecords = new Map<CoreMaterial, number>();
    const sourceMaterials = asRecords(document.materials);
    let imageCache: unknown[] | undefined;
    const data = await loader.extractAllMeshes(document, bin, "", buildParentMap(document), new Map(), new Map(), async (json, bytes, index, base, cache) => {
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
    const {device} = createRecordingDevice({producer: "gltf-mesh-plan", device: ["createBuffer", "createSampler"], queue: []});
    const materials: number[] = [];
    const builtRecords = new Map<Material, number>();
    const associations = new Map<Mesh, MeshData>();
    const uploadContext: UploadContext = {
        _engine: {_device: device}, _json: document, _binChunk: bin, _baseUrl: "", _matExts: [], _wrapTex: identityTexWrap,
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
    const meshes = await loader.uploadMeshes(data, [{applyMesh(input, mesh, suppliedContext) {
        if (!inputs.has(input) || suppliedContext !== uploadContext || associations.has(mesh))
            throw new Error("glTF mesh planning changed its mesh data ownership.");
        associations.set(mesh, input);
    }}], uploadContext);
    const nodes = asRecords(document.nodes), definitions = asRecords(document.meshes);
    const primitiveIndices = definitions.map(definition => new Map(asRecords(definition.primitives).map((primitive, index) => [primitive, index])));
    if (meshes.length !== data.length) throw new Error("glTF mesh planning changed its extraction cardinality.");
    const geometries = new Map<object, number>();
    return {cores, materials, meshes: meshes.map(mesh => {
        const input = associations.get(mesh);
        if (!input || asIndex(input._nodeIndex) === undefined) throw new Error("glTF mesh planning lost its source node.");
        const node = nodes[input._nodeIndex];
        const meshIndex = asIndex(node?.mesh);
        const primitive = meshIndex === undefined ? undefined : primitiveIndices[meshIndex]?.get(input._primitive);
        if (primitive === undefined) throw new Error("glTF mesh planning lost its source primitive.");
        const material = builtRecords.get(mesh.material);
        if (material === undefined || !mesh._gpu || typeof mesh.name !== "string")
            throw new Error("glTF mesh planning lost its constructed resource identity.");
        let geometry = geometries.get(mesh._gpu);
        if (geometry === undefined) { geometry = geometries.size; geometries.set(mesh._gpu, geometry); }
        return {node: input._nodeIndex, primitive, material, geometry, name: mesh.name};
    })};
}

/** Read the validated source-owned schedule carried by a packaged asset. */
export function packagedGltfMeshPlan(document: JsonObject): GltfMeshPlan {
    const plan = asObject(document[GLTF_MESH_PLAN]);
    const sourceMaterialCount = asRecords(document.materials).length;
    if (!plan || !Array.isArray(plan.cores) || !plan.cores.every(index => index === -1 ||
        (asIndex(index) !== undefined && index < sourceMaterialCount)) ||
        !areGltfIndices(plan.materials, plan.cores.length) || !Array.isArray(plan.meshes))
        throw new Error("Invalid or missing packaged glTF mesh schedule.");
    const nodes = asRecords(document.nodes), definitions = asRecords(document.meshes);
    const primitives = definitions.map(definition => asRecords(definition.primitives));
    const materialIndices = plan.materials, meshRecords = plan.meshes;
    const meshes = meshRecords.map(value => {
        const mesh = asObject(value);
        const node = asIndex(mesh?.node), primitive = asIndex(mesh?.primitive), material = asIndex(mesh?.material), geometry = asIndex(mesh?.geometry);
        const definition = node === undefined ? undefined : asIndex(nodes[node]?.mesh);
        if (!mesh || node === undefined || primitive === undefined || material === undefined || material >= materialIndices.length ||
            geometry === undefined || geometry >= meshRecords.length || typeof mesh.name !== "string" ||
            definition === undefined || !primitives[definition]?.[primitive])
            throw new Error("Invalid packaged glTF mesh resource.");
        return {node, primitive, material, geometry, name: mesh.name};
    });
    return {cores: plan.cores, materials: plan.materials, meshes};
}

export async function packageGltfMeshPlan(document: JsonObject, bin: DataView): Promise<void> {
    if (GLTF_MESH_PLAN in document) throw new Error("glTF source already carries compiler mesh scheduling metadata.");
    document[GLTF_MESH_PLAN] = await gltfMeshPlan(document, bin);
}
