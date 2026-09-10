import { asRecords, asIndex, type JsonObject } from "../src/gltf-document.js";
import { packageGltfMeshPlan } from "../src/gltf-mesh-plan.js";

/** Real triangle bytes for fixtures focused on loader resource scheduling. */
export function meshPlanFixture(document: JsonObject): {document: JsonObject; bin: DataView} {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    document.buffers = [{byteLength: positions.byteLength}];
    document.bufferViews = [{buffer: 0, byteOffset: 0, byteLength: positions.byteLength}];
    document.accessors = [{bufferView: 0, componentType: 5126, count: 3, type: "VEC3"}];
    for (const mesh of asRecords(document.meshes)) for (const primitive of asRecords(mesh.primitives))
        primitive.attributes = {POSITION: 0};
    return {document, bin: new DataView(positions.buffer)};
}

export async function withMeshPlan(document: JsonObject): Promise<JsonObject> {
    const fixture = meshPlanFixture(document);
    await packageGltfMeshPlan(fixture.document, fixture.bin);
    return fixture.document;
}

export function readPackedGltfAttribute(document: JsonObject, binary: Buffer, accessor: number): number[] {
    const value = asRecords(document.accessors)[accessor]!;
    const view = asRecords(document.bufferViews)[asIndex(value.bufferView)!]!;
    const count = asIndex(value.count)!;
    const components = value.type === "SCALAR" ? 1 : Number(String(value.type).slice(3));
    const width = value.componentType === 5123 ? 2 : 4;
    const base = asIndex(view.byteOffset)! + (asIndex(value.byteOffset) ?? 0);
    const stride = asIndex(view.byteStride) ?? components * width;
    return Array.from({length: count * components}, (_, index) => {
        const offset = base + Math.floor(index / components) * stride + (index % components) * width;
        return value.componentType === 5123 ? binary.readUInt16LE(offset)
            : value.componentType === 5125 ? binary.readUInt32LE(offset) : binary.readFloatLE(offset);
    });
}
