import {asIndex, asObject, asRecords, areGltfIndices, GLTF_MESH_PLAN, type JsonObject} from "./gltf-document.js";
import type {GltfGeometryPacker} from "./gltf-mesh-geometry.js";

interface Vector3 { x: number; y: number; z: number }
interface Quaternion extends Vector3 { w: number }
export interface SourceCameraMatrices {
    composeTrsLocalMatrix(position: Vector3, rotation: Quaternion, scaling: Vector3): Float32Array;
}

export interface GltfCamera {
    name: string;
    position: number[];
    target: number[];
    fov: number;
    nearPlane: number;
    farPlane: number;
    speed: number;
    angularSensitivity: number;
    inertia: number;
    yaw: number;
    pitch: number;
    parentWorld: number;
    binding: {node: number; local: number} | null;
}

export interface GltfCameraPlan {
    cameras: GltfCamera[];
    containerCameras: number[];
}

function scalar(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid glTF camera scalar.");
    return value;
}

function vector(value: unknown): Vector3 {
    const record = asObject(value);
    if (!record) throw new Error("Invalid glTF camera vector.");
    return {x: scalar(record.x), y: scalar(record.y), z: scalar(record.z)};
}

function matrix(value: unknown): Float32Array {
    if (!(value instanceof Float32Array) || value.length !== 16 || value.some(value => !Number.isFinite(value)))
        throw new Error("Invalid glTF camera matrix.");
    return value;
}

function fields(camera: JsonObject): Omit<GltfCamera, "parentWorld" | "binding"> {
    if (typeof camera.name !== "string") throw new Error("Invalid glTF camera name.");
    const lanes = (value: unknown) => {
        if (!Array.isArray(value) || value.length !== 3) throw new Error("Invalid glTF camera vector lanes.");
        return value.map(scalar);
    };
    return {name: camera.name, position: lanes(camera.position), target: lanes(camera.target),
        fov: scalar(camera.fov), nearPlane: scalar(camera.nearPlane), farPlane: scalar(camera.farPlane),
        speed: scalar(camera.speed), angularSensitivity: scalar(camera.angularSensitivity), inertia: scalar(camera.inertia),
        yaw: scalar(camera.yaw), pitch: scalar(camera.pitch)};
}

/** Observe the constructed FreeCamera and its actual fixup parent. */
export function packageGltfCamera(value: object, nodes: ReadonlyMap<object, number>, packer: GltfGeometryPacker,
    source: SourceCameraMatrices): GltfCamera {
    const camera = asObject(value), parent = asObject(camera?.parent);
    if (!camera || !parent) throw new Error("Unrepresented glTF camera parent.");
    if (camera.ortho !== undefined) throw new Error("glTF orthographic cameras require native explicit clip-plane storage.");
    const position = vector(camera.position), target = vector(camera.target);
    const node = typeof parent.parent === "object" && parent.parent !== null ? nodes.get(parent.parent) : undefined;
    // A parent outside the selected hierarchy is the source's baked fallback.
    // It has no live node binding; its actual world is still retained below.
    let binding: GltfCamera["binding"] = null;
    if (node !== undefined) {
        const rotation = asObject(parent.rotationQuaternion);
        const local = parent._localMatrix ?? source.composeTrsLocalMatrix(vector(parent.position),
            {...vector(rotation), w: scalar(rotation?.w)}, vector(parent.scaling));
        binding = {node, local: packer.float32(matrix(local), 4)};
    } else if (!asObject(parent.parent)?._localMatrix) throw new Error("Unrepresented glTF camera ancestor.");
    return {...fields({name: camera.name, position: [position.x, position.y, position.z], target: [target.x, target.y, target.z],
        fov: camera.fov, nearPlane: camera.nearPlane, farPlane: camera.farPlane, speed: camera.speed,
        angularSensitivity: camera.angularSensitivity, inertia: camera.inertia, yaw: camera._yaw, pitch: camera._pitch}),
        parentWorld: packer.float32(matrix(parent.worldMatrix), 4), binding};
}

export function packagedGltfCameras(document: JsonObject): GltfCameraPlan {
    const plan = asObject(document[GLTF_MESH_PLAN]);
    if (!plan || !Array.isArray(plan.cameras) || !areGltfIndices(plan.containerCameras, plan.cameras.length))
        throw new Error("Invalid or missing packaged glTF camera schedule.");
    if (plan.cameras.length === 0) return {cameras: [], containerCameras: []};
    const accessors = asRecords(document.accessors), nodeCount = asRecords(document.nodes).length;
    const accessor = (value: unknown): number => {
        const index = asIndex(value), record = index === undefined ? undefined : accessors[index];
        if (index === undefined || record?.type !== "VEC4" || record.count !== 4 || record.componentType !== 5126)
            throw new Error("Invalid packaged glTF camera matrix storage.");
        return index;
    };
    return {cameras: plan.cameras.map(value => {
        const camera = asObject(value), binding = asObject(camera?.binding);
        const node = asIndex(binding?.node);
        if (!camera || (camera.binding !== null && (!binding || node === undefined || node >= nodeCount)))
            throw new Error("Invalid packaged glTF camera binding.");
        return {...fields(camera), parentWorld: accessor(camera.parentWorld),
            binding: binding ? {node: node!, local: accessor(binding.local)} : null};
    }), containerCameras: plan.containerCameras};
}
