import { asIndex, asObject, asRecords, type JsonObject } from "./gltf-document.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

/** The raw local attributes consumed by the pinned node geometry view. */
export async function nodeGeometryAssetRefusal(document: JsonObject): Promise<string | undefined> {
    if (asRecords(document.animations).length > 0) return "animated imported geometry";
    const meshes = Array.isArray(document.meshes) ? document.meshes : [];
    const accessors = Array.isArray(document.accessors) ? document.accessors : [];
    const views = Array.isArray(document.bufferViews) ? document.bufferViews : [];
    const { accessorIsStrided } = await importPinnedModule<{
        accessorIsStrided(document: JsonObject, index: number): boolean;
    }>("loader-gltf/gltf-interleave.js");
    for (const node of asRecords(document.nodes)) {
        const meshIndex = asIndex(node.mesh);
        if (meshIndex === undefined) continue;
        if (node.skin !== undefined) return "skinned imported geometry";
        if (asObject(node.extensions)?.EXT_mesh_gpu_instancing !== undefined) return "instanced imported geometry";
        const mesh = asObject(meshes[meshIndex]);
        if (!mesh) return "an unresolved imported mesh";
        for (const primitive of asRecords(mesh.primitives)) {
            if (asRecords(primitive.targets).length > 0) return "imported morph targets";
            const attributes = asObject(primitive.attributes);
            if (attributes?.JOINTS_0 !== undefined || attributes?.WEIGHTS_0 !== undefined) return "imported joint attributes";
            let positionCount: unknown;
            for (const [name, type] of [["POSITION", "VEC3"], ["NORMAL", "VEC3"], ["TEXCOORD_0", "VEC2"]] as const) {
                const index = asIndex(attributes?.[name]);
                if (index === undefined) {
                    if (name === "TEXCOORD_0") continue;
                    return `missing imported ${name}`;
                }
                const accessor = asObject(accessors[index]);
                if (!accessor || accessor.componentType !== 5126 || accessor.type !== type) return `non-FLOAT ${type} imported ${name}`;
                if (name === "POSITION") positionCount = accessor.count;
                else if (accessor.count !== positionCount) return `mismatched imported ${name} count`;
                const viewIndex = asIndex(accessor.bufferView);
                const view = viewIndex === undefined ? undefined : asObject(views[viewIndex]);
                if (!view) return `missing imported ${name} bufferView`;
            }
            // The loader chooses its interleaved path if ANY primitive
            // attribute is strided, even one the node shader does not read.
            // getAttrBuffer then supplies a whole GPU buffer without the
            // attribute offset to the node pipeline's tight 12/8-byte
            // layouts. Tight accessor views instead get their own buffers.
            for (const [name, rawIndex] of Object.entries(attributes ?? {})) {
                const index = asIndex(rawIndex);
                if (index === undefined) return `an unresolved imported ${name} accessor`;
                const accessor = asObject(accessors[index]);
                if (!accessor || ![5121, 5123, 5125, 5126].includes(Number(accessor.componentType))) return `unsupported imported ${name} component format`;
                if (accessorIsStrided(document, index)) return `strided imported ${name} bufferView`;
            }
        }
    }
    return undefined;
}
