import { GLTF_MESH_WALKS, type JsonObject } from "./gltf-document.js";
import { evaluateMeshWalks, type CompiledMeshWalk } from "./gltf-mesh-walks.js";
import { importPinnedModule, importPinnedModuleFetching, pinnedModuleUrl } from "./pinned-shader-composer.js";
import { javascriptModuleUrl } from "./data-url.js";

export async function packageBabylonMeshWalks(document: JsonObject, walks: readonly (CompiledMeshWalk | undefined)[]): Promise<void> {
    const demanded = walks.filter((walk): walk is CompiledMeshWalk => walk !== undefined);
    if (!demanded.length) return;
    if (GLTF_MESH_WALKS in document) throw new Error("Babylon source already carries compiler mesh-walk metadata.");
    type Container = Parameters<typeof evaluateMeshWalks>[0];
    type Meshes = Parameters<typeof evaluateMeshWalks>[1];
    const transport = `import { initMeshTransform } from ${JSON.stringify(pinnedModuleUrl("mesh/mesh.js"))};
        export { initMeshTransform }; export function uploadMeshToGPU() { return {}; }`;
    const imported = await importPinnedModuleFetching<{
        loadBabylon(engine: object, url: string, options: object): Promise<Container>;
    }>("loader-babylon/load-babylon.js", () => Buffer.from(JSON.stringify(document)),
        new Map([["../mesh/mesh.js", javascriptModuleUrl(transport)]]));
    try {
        const container = await imported.module.loadBabylon({}, "https://bblite.invalid/meshes.babylon", { loadTextures: false, loadCamera: false });
        const { getContainerMeshes } = await importPinnedModule<{ getContainerMeshes(container: Container): Meshes }>("asset-container.js");
        const observed = await evaluateMeshWalks(container, getContainerMeshes(container), demanded);
        let cursor = 0;
        document[GLTF_MESH_WALKS] = walks.map(walk => walk ? observed[cursor++]! : []);
    } finally { imported.release(); }
}
