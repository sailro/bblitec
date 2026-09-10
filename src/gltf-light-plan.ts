import { asIndex, asObject, asRecords, areGltfIndices, GLTF_MESH_PLAN, type JsonObject } from "./gltf-document.js";
import type { GltfGeometryPacker } from "./gltf-mesh-geometry.js";

export interface GltfLight {
    kind: "point" | "directional" | "spot";
    world: number;
    node: number | null;
    diffuse: number[];
    specular: number[];
    intensity: number;
    range?: number;
    spot?: {angle: number; cosine: number; exponent: number};
}

export interface GltfLightPlan {
    lights: GltfLight[];
    sceneLights: number[];
    lightTargets: Array<number | null>;
}

function scalar(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid glTF light scalar.");
    return value;
}

function color(value: unknown): number[] {
    if (!Array.isArray(value) || value.length !== 3) throw new Error("Invalid glTF light color.");
    return value.map(scalar);
}

function kind(value: unknown): GltfLight["kind"] {
    if (value !== "point" && value !== "directional" && value !== "spot") throw new Error("Unsupported glTF light kind.");
    return value;
}

/** Observe an actual source light after its source scene parents are attached. */
export function packageGltfLight(value: object, nodes: ReadonlyMap<object, number>, packer: GltfGeometryPacker): GltfLight {
    const light: JsonObject | undefined = asObject(value);
    if (!light) throw new Error("Invalid constructed glTF light.");
    const type = kind(light.lightType), world = light.worldMatrix;
    if (!(world instanceof Float32Array) || world.length !== 16 || world.some(value => !Number.isFinite(value)))
        throw new Error("Invalid constructed glTF light world matrix.");
    const parent = light.parent;
    const node = parent == null ? null : typeof parent === "object" ? nodes.get(parent) : undefined;
    if (node === undefined) throw new Error("Unrepresented glTF light parent.");
    const result: GltfLight = {kind: type, world: packer.float32(world, 4), node,
        diffuse: color(light.diffuse), specular: color(light.specular), intensity: scalar(light.intensity)};
    if (light.range !== undefined) result.range = scalar(light.range);
    if (type === "spot") {
        if (typeof light._writeLightUbo !== "function") throw new Error("Missing glTF spot light writer.");
        const uniform = new Float32Array(16);
        light._writeLightUbo(uniform, 0);
        result.spot = {angle: scalar(light.angle), cosine: scalar(uniform[15]), exponent: scalar(light.exponent)};
    }
    return result;
}

function readGltfLight(value: unknown, accessorCount: number, nodeCount: number): GltfLight {
    const light = asObject(value), world = asIndex(light?.world), node = light?.node === null ? null : asIndex(light?.node);
    if (!light || world === undefined || world >= accessorCount ||
        node === undefined || (node !== null && node >= nodeCount))
        throw new Error("Invalid packaged glTF light binding.");
    const result: GltfLight = {kind: kind(light.kind), world, node,
        diffuse: color(light.diffuse), specular: color(light.specular), intensity: scalar(light.intensity)};
    if (light.range !== undefined) result.range = scalar(light.range);
    if (result.kind === "spot") {
        const spot = asObject(light.spot);
        if (!spot) throw new Error("Missing packaged glTF spot light state.");
        result.spot = {angle: scalar(spot.angle), cosine: scalar(spot.cosine), exponent: scalar(spot.exponent)};
    } else if (light.spot !== undefined) throw new Error("Unexpected packaged glTF spot light state.");
    return result;
}

/** Read the light section without reconstructing unrelated mesh resources. */
export function packagedGltfLights(document: JsonObject): GltfLightPlan {
    const plan = asObject(document[GLTF_MESH_PLAN]);
    const count = Array.isArray(plan?.lights) ? plan.lights.length : 0;
    const definitions = asObject(asObject(document.extensions)?.KHR_lights_punctual)?.lights;
    if (!plan || !Array.isArray(plan.lights) || !areGltfIndices(plan.sceneLights, count) ||
        !Array.isArray(plan.lightTargets) || plan.lightTargets.length !== (Array.isArray(definitions) ? definitions.length : 0) ||
        !plan.lightTargets.every(index => index === null || (asIndex(index) !== undefined && index < count)))
        throw new Error("Invalid or missing packaged glTF light schedule.");
    const accessorCount = asRecords(document.accessors).length, nodeCount = asRecords(document.nodes).length;
    return {lights: plan.lights.map(light => readGltfLight(light, accessorCount, nodeCount)),
        sceneLights: plan.sceneLights, lightTargets: plan.lightTargets};
}
