import { resolveGlbGeometry } from "./compressed-geometry.js";
import type {AssetDecoders} from "./asset-decoders.js";
import { readGlb, writeGlb } from "./glb-container.js";
import { packageGltfMeshPlan, type GltfLoadFeatures } from "./gltf-mesh-plan.js";
import { packageVariantPlan } from "./gltf-variant-plan.js";
import {packageGltfTransmissionPlan} from "./pinned-material-arms.js";

/** Schedule native resources after the pin's geometry hooks finish rewriting accessors. */
export async function packageGltfLoadPlan(bytes: Uint8Array, label: string, features: GltfLoadFeatures = {}, decoders: AssetDecoders = {}): Promise<Uint8Array> {
    const glb = readGlb(bytes);
    if (!glb) return bytes;
    await resolveGlbGeometry(glb, label, decoders);
    glb.binary = await packageGltfMeshPlan(glb.json, new DataView(glb.binary.buffer, glb.binary.byteOffset, glb.binary.byteLength), undefined, features);
    await packageVariantPlan(glb.json);
    await packageGltfTransmissionPlan(glb.json);
    return writeGlb(glb.json, glb.binary);
}
