import { resolveGlbGeometry } from "./compressed-geometry.js";
import { readGlb, writeGlb } from "./glb-container.js";
import { packageGltfMeshPlan } from "./gltf-mesh-plan.js";
import { packageVariantPlan } from "./gltf-variant-plan.js";

/** Schedule native resources after the pin's geometry hooks finish rewriting accessors. */
export async function packageGltfLoadPlan(bytes: Uint8Array, label: string): Promise<Uint8Array> {
    const glb = readGlb(bytes);
    if (!glb) return bytes;
    await resolveGlbGeometry(glb, label);
    await packageGltfMeshPlan(glb.json, new DataView(glb.binary.buffer, glb.binary.byteOffset, glb.binary.byteLength));
    await packageVariantPlan(glb.json);
    return writeGlb(glb.json, glb.binary);
}
