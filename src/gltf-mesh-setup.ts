import { asIndex, asObject } from "./gltf-document.js";
import type { GltfGeometryPacker } from "./gltf-mesh-geometry.js";

export interface RecordedMeshSetup {
    _gpu: { indexFormat: string };
    boundMin: ArrayLike<number>;
    boundMax: ArrayLike<number>;
    worldMatrix: Float32Array;
    visible?: boolean;
    _primitive?: {
        topology?: string;
        frontFace?: string;
        cullMode?: string;
        stripIndexFormat?: string;
    };
    thinInstances?: {
        matrices: Float32Array;
        count: number;
        colors?: Float32Array | null;
    } | null;
}

export interface GltfMeshSetup {
    world: number;
    bounds: number;
    topology: string;
    clockwise: boolean;
    visible: boolean;
    instances?: { matrices: number; count: number };
}

function topology(value: unknown): string {
    if (
        value !== "triangle-list" &&
        value !== "triangle-strip" &&
        value !== "point-list" &&
        value !== "line-list" &&
        value !== "line-strip"
    )
        throw new Error("Unsupported constructed glTF topology.");
    return value;
}

/** Transport source-owned placement, bounds and instance matrices. */
export function packageMeshSetup(
    mesh: RecordedMeshSetup,
    packer: GltfGeometryPacker,
): GltfMeshSetup {
    const primitive = mesh._primitive;
    const primitiveTopology = topology(primitive?.topology ?? "triangle-list");
    if (
        primitive &&
        (Object.keys(primitive).some(
            (key) =>
                ![
                    "topology",
                    "frontFace",
                    "cullMode",
                    "stripIndexFormat",
                ].includes(key),
        ) ||
            (primitive.frontFace !== undefined &&
                primitive.frontFace !== "cw" &&
                primitive.frontFace !== "ccw") ||
            (primitive.cullMode !== undefined &&
                (primitive.cullMode !== "none" ||
                    primitiveTopology.startsWith("triangle"))) ||
            ((primitiveTopology === "line-strip" ||
                primitiveTopology === "triangle-strip" ||
                primitive.stripIndexFormat !== undefined) &&
                primitive.stripIndexFormat !== mesh._gpu.indexFormat))
    )
        throw new Error("Unsupported constructed glTF primitive state.");
    if (
        (mesh.visible !== undefined && typeof mesh.visible !== "boolean") ||
        !(mesh.worldMatrix instanceof Float32Array) ||
        mesh.worldMatrix.length !== 16 ||
        mesh.boundMin.length !== 3 ||
        mesh.boundMax.length !== 3
    )
        throw new Error("Invalid constructed glTF mesh placement.");
    const bounds = new Float32Array(6);
    bounds.set(mesh.boundMin);
    bounds.set(mesh.boundMax, 3);
    if (
        [mesh.worldMatrix, bounds].some((values) =>
            values.some((value) => !Number.isFinite(value)),
        )
    )
        throw new Error("Non-finite constructed glTF mesh placement.");
    const result: GltfMeshSetup = {
        world: packer.float32(mesh.worldMatrix, 4),
        bounds: packer.float32(bounds, 3),
        topology: primitiveTopology,
        clockwise: primitive?.frontFace === "cw",
        visible: mesh.visible !== false,
    };
    if (mesh.thinInstances) {
        const instances = mesh.thinInstances;
        if (
            !(instances.matrices instanceof Float32Array) ||
            asIndex(instances.count) === undefined ||
            instances.matrices.length !== instances.count * 16 ||
            instances.colors ||
            instances.matrices.some((value) => !Number.isFinite(value))
        )
            throw new Error("Unsupported constructed glTF instance storage.");
        result.instances = {
            matrices: packer.float32(instances.matrices, 4),
            count: instances.count,
        };
    }
    return result;
}

export function readMeshSetup(
    value: unknown,
    accessorCount: number,
): GltfMeshSetup {
    const setup = asObject(value);
    const world = asIndex(setup?.world),
        bounds = asIndex(setup?.bounds);
    if (
        !setup ||
        world === undefined ||
        world >= accessorCount ||
        bounds === undefined ||
        bounds >= accessorCount ||
        typeof setup.clockwise !== "boolean" ||
        typeof setup.visible !== "boolean"
    )
        throw new Error("Invalid packaged glTF mesh placement.");
    const result: GltfMeshSetup = {
        world,
        bounds,
        topology: topology(setup.topology),
        clockwise: setup.clockwise,
        visible: setup.visible,
    };
    if (setup.instances !== undefined) {
        const instances = asObject(setup.instances);
        const matrices = asIndex(instances?.matrices),
            count = asIndex(instances?.count);
        if (
            matrices === undefined ||
            matrices >= accessorCount ||
            count === undefined
        )
            throw new Error("Invalid packaged glTF instance storage.");
        result.instances = { matrices, count };
    }
    return result;
}
