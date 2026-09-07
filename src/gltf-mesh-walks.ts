import { asIndex, asObject, asStrings, GLTF_MESH_WALKS, isGaussianSplatPrimitive, type JsonObject } from "./gltf-document.js";
import { importPinnedModule, importPinnedModuleWithExports } from "./pinned-shader-composer.js";
import { transpileCommonJs } from "./typescript-transpile.js";

/** Only bodies already proven to be closed, total mesh collectors reach here. */
export type CompiledMeshWalk = { kind: "preorder" } | { kind: "source"; parameter: string; body: string };

interface Mesh { _gpu: object; material: object }
interface Node { children?: Array<Node | Mesh> }

function records(value: unknown, field: string): JsonObject[] {
    if (!Array.isArray(value) || value.some(entry => !asObject(entry))) {
        throw new Error(`Source mesh walks require an object array at glTF ${field}.`);
    }
    return value as JsonObject[];
}

function indices(value: unknown, limit: number): number[] {
    if (!Array.isArray(value) || value.some(entry => asIndex(entry) === undefined || entry >= limit)) {
        throw new Error("Source mesh walks require valid glTF hierarchy node indices.");
    }
    return value as number[];
}

/** Keep native document-order mesh storage and observe source traversal separately. */
export async function gltfMeshWalks(document: JsonObject, walks: readonly CompiledMeshWalk[]): Promise<number[][]> {
    if (asStrings(document.extensionsUsed).some(name => name === "EXT_mesh_gpu_instancing" || name === "KHR_gaussian_splatting")) {
        throw new Error("Source mesh walks do not yet represent instancing or splat loader producers.");
    }
    const definitions = records(document.meshes, "meshes");
    const nodes = records(document.nodes, "nodes");
    const scenes = records(document.scenes, "scenes");
    const scene = scenes[asIndex(document.scene) ?? 0];
    const pending = [...indices(scene?.nodes ?? [], nodes.length)];
    const seen = new Set<number>();
    // Validate only: the ordering below comes from the pin's actual builder
    // and collector, never this graph check. Cycles/shared nodes cannot be
    // represented by the one-wrapper-per-primitive native loader.
    while (pending.length) {
        const node = pending.pop()!;
        if (seen.has(node)) throw new Error("Source mesh walks require a non-repeated glTF hierarchy.");
        seen.add(node);
        pending.push(...indices(nodes[node]!.children ?? [], nodes.length));
    }
    const meshDatas: Array<{_nodeIndex: number}> = [];
    for (const [index, node] of nodes.entries()) {
        if (asObject(node.extensions)?.EXT_mesh_gpu_instancing !== undefined) {
            throw new Error("Source mesh walks do not represent instancing loader producers.");
        }
        const mesh = asIndex(node.mesh);
        if (mesh === undefined) continue;
        for (const primitive of records(definitions[mesh]?.primitives, "mesh primitives")) {
            if (isGaussianSplatPrimitive(primitive)) throw new Error("Source mesh walks do not represent splat primitives.");
            meshDatas.push({_nodeIndex: index});
        }
    }
    const meshes: Mesh[] = meshDatas.map(() => ({_gpu: {}, material: {}}));
    const { buildNodeHierarchy } = await importPinnedModuleWithExports<{
        buildNodeHierarchy(document: JsonObject, meshes: Mesh[], data: Array<{_nodeIndex: number}>): {root: Node};
    }>("loader-gltf/load-gltf.js", ["buildNodeHierarchy"]);
    const { getContainerMeshes } = await importPinnedModule<{
        getContainerMeshes(container: {entities: Node[]}): Mesh[];
    }>("asset-container.js");
    const { root } = buildNodeHierarchy(document, meshes, meshDatas);
    const container = {entities: [root]};
    const indexOf = new Map(meshes.map((mesh, index) => [mesh, index]));
    return walks.map(walk => {
        const collect: (container: {entities: Node[]}) => Mesh[] = walk.kind === "preorder"
            ? getContainerMeshes
            : new Function(walk.parameter, transpileCommonJs(walk.body, "source-mesh-walk.ts")) as (container: {entities: Node[]}) => Mesh[];
        const indices = collect(container).map(mesh => {
            const index = indexOf.get(mesh);
            if (index === undefined) throw new Error("Source mesh walk returned an unknown loader mesh.");
            return index;
        });
        // Existing resource-loop cardinality requires exactly the native mesh
        // set. Partial scenes, shared-node DAGs and extra entity producers need
        // their own cardinality/identity transport before admission.
        if (indices.length !== meshes.length || new Set(indices).size !== meshes.length) {
            throw new Error("Source mesh walks require one visit to every imported mesh; partial or repeated hierarchies are not represented.");
        }
        return indices;
    });
}

export async function packageMeshWalks(document: JsonObject, walks: readonly (CompiledMeshWalk | undefined)[]): Promise<void> {
    const demanded = walks.filter((walk): walk is CompiledMeshWalk => walk !== undefined);
    if (!demanded.length) return;
    if (GLTF_MESH_WALKS in document) throw new Error("glTF source already carries compiler mesh-walk metadata.");
    const observed = await gltfMeshWalks(document, demanded);
    let cursor = 0;
    document[GLTF_MESH_WALKS] = walks.map(walk => walk ? observed[cursor++]! : []);
}
