import { asIndex, asObject, areGltfIndices, type JsonObject } from "./gltf-document.js";
import { GltfGeometryPacker } from "./gltf-mesh-geometry.js";
import { RecordedBuffer, RecordedTexture } from "./recording-device.js";

export interface RecordedMeshDeformation {
    skeleton?: {jointsBuffer: RecordedBuffer; weightsBuffer: RecordedBuffer; boneCount: number; boneMatrices: Float32Array; boneTexture: RecordedTexture} | null;
    morphTargets?: {deltasBuffer: RecordedBuffer; weightsBuffer: RecordedBuffer; count: number; weights: Float32Array} | null;
}

export interface GltfMeshDeformation {
    skin?: {index: number; joints: number; weights: number; boneCount: number; matrices: number};
    morph?: {positions: number[]; normals: number[]; weights: number};
}

/** Preserve the constructed attachments and translate their GPU storage layouts. */
export function packageMeshDeformation(mesh: RecordedMeshDeformation, vertexCount: number, skinIndex: number | undefined, packer: GltfGeometryPacker): GltfMeshDeformation {
    const result: GltfMeshDeformation = {};
    if (mesh.skeleton) {
        const skin = mesh.skeleton;
        if (skinIndex === undefined || asIndex(skin.boneCount) === undefined) throw new Error("Invalid constructed glTF skeleton.");
        const texture = skin.boneTexture, matrices = skin.boneMatrices;
        const upload = texture instanceof RecordedTexture && texture.uploads.length === 1 ? texture.uploads[0] : undefined;
        const layout = upload?.kind === "write" ? asObject(upload.layout) : undefined;
        if (!(matrices instanceof Float32Array) || matrices.length !== skin.boneCount * 16 || matrices.some(value => !Number.isFinite(value)) ||
            !(texture instanceof RecordedTexture) || texture.destroyed || texture.width !== skin.boneCount * 4 || texture.height !== 1 ||
            texture.depthOrArrayLayers !== 1 || texture.mipLevelCount !== 1 || texture.format !== "rgba32float" ||
            upload?.kind !== "write" || upload.mipLevel !== 0 || upload.origin.x !== 0 || upload.origin.y !== 0 || upload.origin.z !== 0 ||
            upload.size.width !== texture.width || upload.size.height !== 1 || upload.size.depthOrArrayLayers !== 1 ||
            layout?.bytesPerRow !== skin.boneCount * 64 || (layout.offset !== undefined && layout.offset !== 0) ||
            upload.bytes.byteLength !== matrices.byteLength)
            throw new Error("Unsupported constructed glTF bone palette storage.");
        const bytes = new Uint8Array(matrices.buffer, matrices.byteOffset, matrices.byteLength);
        if (bytes.some((value, index) => value !== upload.bytes[index])) throw new Error("glTF bone CPU/GPU initial matrices disagree.");
        result.skin = {
            index: skinIndex, boneCount: skin.boneCount,
            joints: packer.accessor(skin.jointsBuffer, vertexCount, 4, 5125),
            weights: packer.accessor(skin.weightsBuffer, vertexCount, 4, 5126),
            matrices: packer.float32(matrices, 4),
        };
    }
    if (mesh.morphTargets) {
        const morph = mesh.morphTargets;
        // Native morph transport consumes position xyz + normal xyz and the
        // source's 16-byte weights header. A different GPU layout must refuse.
        if (asIndex(morph.count) === undefined || !(morph.deltasBuffer instanceof RecordedBuffer) ||
            !(morph.weightsBuffer instanceof RecordedBuffer) || !(morph.weights instanceof Float32Array) ||
            morph.deltasBuffer.size !== morph.count * vertexCount * 24 || morph.weightsBuffer.size !== 16 + morph.count * 4 ||
            morph.weights.length !== morph.count) throw new Error("Unsupported constructed glTF morph storage layout.");
        const header = new DataView(morph.weightsBuffer.bytes);
        if (header.getUint32(0, true) !== morph.count || header.getUint32(4, true) !== vertexCount)
            throw new Error("Unsupported constructed glTF morph weights header.");
        if (morph.weights.some((weight, index) => !Number.isFinite(weight) || !Object.is(weight, header.getFloat32(16 + index * 4, true))))
            throw new Error("glTF morph CPU/GPU initial weights disagree.");
        const positions: number[] = [], normals: number[] = [];
        for (let index = 0; index < morph.count; index++) {
            const layout = {_stride: 24, _count: vertexCount, _componentType: 5126, _componentCount: 3};
            positions.push(packer.accessor(morph.deltasBuffer, vertexCount, 3, 5126, {...layout, _offset: index * vertexCount * 24}));
            normals.push(packer.accessor(morph.deltasBuffer, vertexCount, 3, 5126, {...layout, _offset: index * vertexCount * 24 + 12}));
        }
        result.morph = {positions, normals, weights: packer.accessor(morph.weightsBuffer, morph.count, 1, 5126,
            {_stride: 4, _offset: 16, _count: morph.count, _componentType: 5126, _componentCount: 1})};
    }
    return result;
}

export function readMeshDeformation(mesh: JsonObject, accessorCount: number, skinCount: number): GltfMeshDeformation {
    const result: GltfMeshDeformation = {};
    if (mesh.skin !== undefined) {
        const skin = asObject(mesh.skin);
        const index = asIndex(skin?.index), joints = asIndex(skin?.joints), weights = asIndex(skin?.weights), boneCount = asIndex(skin?.boneCount), matrices = asIndex(skin?.matrices);
        if (index === undefined || index >= skinCount || joints === undefined || joints >= accessorCount ||
            weights === undefined || weights >= accessorCount || boneCount === undefined || matrices === undefined || matrices >= accessorCount)
            throw new Error("Invalid packaged glTF skeleton.");
        result.skin = {index, joints, weights, boneCount, matrices};
    }
    if (mesh.morph !== undefined) {
        const morph = asObject(mesh.morph);
        const weights = asIndex(morph?.weights);
        if (!morph || !areGltfIndices(morph.positions, accessorCount) || !areGltfIndices(morph.normals, accessorCount) ||
            morph.positions.length !== morph.normals.length || weights === undefined || weights >= accessorCount)
            throw new Error("Invalid packaged glTF morph targets.");
        result.morph = {positions: morph.positions, normals: morph.normals, weights};
    }
    return result;
}
