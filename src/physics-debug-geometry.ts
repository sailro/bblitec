import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import HavokPhysics, { type HavokPhysicsWithBindings, type HP_ShapeId, type Result } from "@babylonjs/havok";
import { cachedJsonBake, moduleIdentity } from "./bake-cache.js";

type Vector3 = readonly [number, number, number];
type Quaternion = readonly [number, number, number, number];

/** Complete arguments at the opaque HP_Shape_* geometry boundary. All coordinates
 * are shape-local; body identity, pose, simulation state and presentation are absent. */
export type PhysicsDebugShape =
    | { type: "SPHERE"; center: Vector3; radius: number }
    | { type: "BOX"; center: Vector3; rotation: Quaternion; extents: Vector3 }
    | { type: "CAPSULE" | "CYLINDER"; pointA: Vector3; pointB: Vector3; radius: number }
    | { type: "CONVEX_HULL"; positions: readonly number[] }
    | { type: "MESH"; positions: readonly number[]; indices: readonly number[] }
    | { type: "HEIGHTFIELD"; samplesX: number; samplesZ: number; scale: Vector3; heights: readonly number[] }
    | { type: "CONTAINER"; children: readonly {
        shape: PhysicsDebugShape; position: Vector3; rotation: Quaternion; scale: Vector3;
    }[] };

export interface PhysicsDebugGeometry {
    positions: number[];
    /** Triangles from HP_DebugGeometry_GetInfo; the pinned viewer forms its own lines. */
    indices: number[];
}

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm");

function checked<T>(havok: HavokPhysicsWithBindings, result: [Result, T], operation: string): T {
    if (result[0] !== havok.Result.RESULT_OK) throw new Error(`Physics debug geometry: ${operation} failed.`);
    return result[1];
}

/** Stable field order also discards no inputs: an unknown field is refused. */
function canonicalShape(shape: PhysicsDebugShape): PhysicsDebugShape {
    const fields = (names: string[]) => {
        for (const name of Object.keys(shape)) if (!names.includes(name)) {
            throw new Error(`Physics debug geometry: unrepresented ${shape.type} field '${name}'.`);
        }
    };
    const finite = (values: readonly number[], label: string, length?: number): number[] => {
        if ((length !== undefined && values.length !== length) || !values.every(Number.isFinite)) {
            throw new Error(`Physics debug geometry: ${label} requires ${length ?? "only"} finite values.`);
        }
        return Array.from(values);
    };
    const vector = (value: Vector3): [number, number, number] => finite(value, "vector", 3) as [number, number, number];
    const rotation = (value: Quaternion): [number, number, number, number] => finite(value, "quaternion", 4) as [number, number, number, number];
    const radius = (value: number): number => {
        if (!Number.isFinite(value) || value <= 0) throw new Error("Physics debug geometry: radius must be positive and finite.");
        return value;
    };
    switch (shape.type) {
        case "SPHERE":
            fields(["type", "center", "radius"]);
            return { type: shape.type, center: vector(shape.center), radius: radius(shape.radius) };
        case "BOX":
            fields(["type", "center", "rotation", "extents"]);
            return { type: shape.type, center: vector(shape.center), rotation: rotation(shape.rotation), extents: vector(shape.extents) };
        case "CAPSULE": case "CYLINDER":
            fields(["type", "pointA", "pointB", "radius"]);
            return { type: shape.type, pointA: vector(shape.pointA), pointB: vector(shape.pointB), radius: radius(shape.radius) };
        case "CONVEX_HULL": case "MESH": {
            fields(shape.type === "MESH" ? ["type", "positions", "indices"] : ["type", "positions"]);
            const positions = finite(shape.positions, "positions");
            if (positions.length % 3 !== 0 || positions.length < (shape.type === "MESH" ? 9 : 12)) {
                throw new Error("Physics debug geometry: incomplete vertex triples.");
            }
            if (shape.type === "CONVEX_HULL") return { type: shape.type, positions };
            const indices = finite(shape.indices, "indices");
            if (!indices.length || indices.length % 3 !== 0 || !indices.every(index => Number.isInteger(index) && index >= 0 && index < positions.length / 3)) {
                throw new Error("Physics debug geometry: triangle indices must address complete vertices.");
            }
            return { type: shape.type, positions, indices };
        }
        case "HEIGHTFIELD": {
            fields(["type", "samplesX", "samplesZ", "scale", "heights"]);
            if (![shape.samplesX, shape.samplesZ].every(value => Number.isInteger(value) && value >= 2)) {
                throw new Error("Physics debug geometry: heightfield sample dimensions must be integers of at least two.");
            }
            if (shape.samplesX !== shape.samplesZ) throw new Error("Physics debug geometry: only square heightfield grids are materialized.");
            return { type: shape.type, samplesX: shape.samplesX, samplesZ: shape.samplesZ,
                scale: vector(shape.scale), heights: finite(shape.heights, "heights", shape.samplesX * shape.samplesZ) };
        }
        case "CONTAINER":
            fields(["type", "children"]);
            return { type: shape.type, children: shape.children.map(child => {
                for (const name of Object.keys(child)) if (!["shape", "position", "rotation", "scale"].includes(name)) {
                    throw new Error(`Physics debug geometry: unrepresented child field '${name}'.`);
                }
                return { shape: canonicalShape(child.shape), position: vector(child.position), rotation: rotation(child.rotation), scale: vector(child.scale) };
            }) };
        default: throw new Error("Physics debug geometry: unrepresented shape type.");
    }
}

function createShape(havok: HavokPhysicsWithBindings, shape: PhysicsDebugShape): HP_ShapeId {
    const allocated: number[] = [];
    const buffer = (data: Float32Array | Uint32Array): number => {
        const address = havok._malloc(data.byteLength);
        if (!address) throw new Error("Physics debug geometry: WASM buffer allocation failed.");
        allocated.push(address);
        havok.HEAPU8.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), address);
        return address;
    };
    try {
        switch (shape.type) {
            case "SPHERE": return checked(havok, havok.HP_Shape_CreateSphere([...shape.center], shape.radius), shape.type);
            case "BOX": return checked(havok, havok.HP_Shape_CreateBox([...shape.center], [...shape.rotation], [...shape.extents]), shape.type);
            case "CAPSULE": return checked(havok, havok.HP_Shape_CreateCapsule([...shape.pointA], [...shape.pointB], shape.radius), shape.type);
            case "CYLINDER": return checked(havok, havok.HP_Shape_CreateCylinder([...shape.pointA], [...shape.pointB], shape.radius), shape.type);
            case "CONVEX_HULL": return checked(havok, havok.HP_Shape_CreateConvexHull(buffer(new Float32Array(shape.positions)), shape.positions.length / 3), shape.type);
            case "MESH": return checked(havok, havok.HP_Shape_CreateMesh(buffer(new Float32Array(shape.positions)), shape.positions.length / 3,
                buffer(new Uint32Array(shape.indices)), shape.indices.length / 3), shape.type);
            case "HEIGHTFIELD": return checked(havok, havok.HP_Shape_CreateHeightField(shape.samplesX, shape.samplesZ, [...shape.scale], buffer(new Float32Array(shape.heights))), shape.type);
            case "CONTAINER": {
                const container = checked(havok, havok.HP_Shape_CreateContainer(), shape.type);
                try {
                    for (const child of shape.children) {
                        const childShape = createShape(havok, child.shape);
                        try {
                            const result = havok.HP_Shape_AddChild(container, childShape, [[...child.position], [...child.rotation], [...child.scale]]);
                            if (result !== havok.Result.RESULT_OK) throw new Error("Physics debug geometry: AddChild failed.");
                        } finally { havok.HP_Shape_Release(childShape); }
                    }
                    return container;
                } catch (error) { havok.HP_Shape_Release(container); throw error; }
            }
        }
        throw new Error("Physics debug geometry: unrepresented shape type.");
    } finally { for (const address of allocated) havok._free(address); }
}

/** Execute only the library's local-shape producer. Callers must supply complete
 * source-proven constructor inputs and validate those inputs at native selection. */
export async function materializePhysicsDebugGeometry(input: PhysicsDebugShape): Promise<PhysicsDebugGeometry> {
    const shape = canonicalShape(input);
    const wasm = readFileSync(wasmPath);
    const wrapper = readFileSync(fileURLToPath(import.meta.resolve("@babylonjs/havok")));
    return cachedJsonBake({
        kind: "physics-debug-geometry", version: "1", module: moduleIdentity(import.meta.url), browser: false,
        parameters: { shape }, inputs: [wasm, wrapper],
    }, async () => {
        const havok = await HavokPhysics({ wasmBinary: new Uint8Array(wasm).buffer });
        const handle = createShape(havok, shape);
        try {
            const geometry = checked(havok, havok.HP_Shape_CreateDebugDisplayGeometry(handle), "CreateDebugDisplayGeometry");
            try {
                const [vertexAddress, vertexCount, indexAddress, triangleCount] = checked(havok, havok.HP_DebugGeometry_GetInfo(geometry), "GetInfo");
                return { positions: Array.from(new Float32Array(havok.HEAPU8.buffer, vertexAddress, vertexCount * 3)),
                    indices: Array.from(new Uint32Array(havok.HEAPU8.buffer, indexAddress, triangleCount * 3)) };
            } finally { havok.HP_DebugGeometry_Release(geometry); }
        } finally { havok.HP_Shape_Release(handle); }
    });
}

/** Native catalogs can use this digest for provenance; selection must still compare
 * the complete descriptor, since a digest alone does not prove runtime geometry. */
export function physicsDebugShapeIdentity(input: PhysicsDebugShape): string {
    return createHash("sha256").update(JSON.stringify(canonicalShape(input))).digest("hex");
}
