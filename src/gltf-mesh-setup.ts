import { asIndex, asObject } from "./gltf-document.js";
import type { GltfGeometryPacker } from "./gltf-mesh-geometry.js";

interface RecordedVec3 {
    x: number;
    y: number;
    z: number;
}

/** The glTF node a primitive's mesh hangs under, as the pin built it. */
export interface RecordedSetupNode {
    position: RecordedVec3;
    rotationQuaternion: RecordedVec3 & { w: number };
    scaling: RecordedVec3;
    /** A glTF `matrix` node's raw local, which its TRS does not drive. */
    _localMatrix?: unknown;
    parent?: { worldMatrix: Float32Array } | null;
}

export interface RecordedMeshSetup {
    _gpu: { indexFormat: string };
    boundMin: ArrayLike<number>;
    boundMax: ArrayLike<number>;
    worldMatrix: Float32Array;
    visible?: boolean;
    parent?: RecordedSetupNode | null;
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

/**
 * The primitive's glTF node, for a scene that writes node transforms: its
 * own TRS as the pin's node stores it, and the world of the node above it.
 */
export interface GltfMeshSetupNode {
    translation: [number, number, number];
    rotation: [number, number, number, number];
    scaling: [number, number, number];
    parentWorld: number;
}

export interface GltfMeshSetup {
    world: number;
    bounds: number;
    topology: string;
    clockwise: boolean;
    visible: boolean;
    instances?: { matrices: number; count: number };
    node?: GltfMeshSetupNode;
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

/**
 * The primitive's own node, read off the pin's live hierarchy: absent for a
 * `matrix` node, whose TRS the pin does not compose.
 */
function packageSetupNode(
    mesh: RecordedMeshSetup,
    packer: GltfGeometryPacker,
): GltfMeshSetupNode | undefined {
    const node = mesh.parent;
    if (!node || node._localMatrix !== undefined) return undefined;
    const parentWorld = node.parent?.worldMatrix;
    const { position, rotationQuaternion, scaling } = node;
    const translation: [number, number, number] = [
        position.x,
        position.y,
        position.z,
    ];
    const rotation: [number, number, number, number] = [
        rotationQuaternion.x,
        rotationQuaternion.y,
        rotationQuaternion.z,
        rotationQuaternion.w,
    ];
    const scale: [number, number, number] = [scaling.x, scaling.y, scaling.z];
    if (
        !(parentWorld instanceof Float32Array) ||
        parentWorld.length !== 16 ||
        [...translation, ...rotation, ...scale, ...parentWorld].some(
            (value) => !Number.isFinite(value),
        )
    )
        throw new Error("Invalid constructed glTF node transform.");
    return {
        translation,
        rotation,
        scaling: scale,
        parentWorld: packer.float32(parentWorld, 4),
    };
}

/** Transport source-owned placement, bounds and instance matrices. */
export function packageMeshSetup(
    mesh: RecordedMeshSetup,
    packer: GltfGeometryPacker,
    nodeTransforms = false,
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
    if (nodeTransforms) {
        const node = packageSetupNode(mesh, packer);
        if (node) result.node = node;
    }
    return result;
}

function readLanes(value: unknown, length: number): number[] | undefined {
    if (!Array.isArray(value) || value.length !== length) return undefined;
    const lanes: number[] = [];
    for (const lane of value) {
        if (typeof lane !== "number" || !Number.isFinite(lane))
            return undefined;
        lanes.push(lane);
    }
    return lanes;
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
    if (setup.node !== undefined) {
        const node = asObject(setup.node);
        const translation = readLanes(node?.translation, 3),
            rotation = readLanes(node?.rotation, 4),
            scaling = readLanes(node?.scaling, 3),
            parentWorld = asIndex(node?.parentWorld);
        if (
            !translation ||
            !rotation ||
            !scaling ||
            parentWorld === undefined ||
            parentWorld >= accessorCount
        )
            throw new Error("Invalid packaged glTF node transform.");
        result.node = {
            translation: [translation[0]!, translation[1]!, translation[2]!],
            rotation: [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!],
            scaling: [scaling[0]!, scaling[1]!, scaling[2]!],
            parentWorld,
        };
    }
    return result;
}
