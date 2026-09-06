/** Execute the pin's CSG2 adapter and bundled Manifold WASM in Chromium.
 * The package's Manifold build deliberately disables Node's require seam.
 * Only retained CPU geometry crosses this boundary; source and output mesh
 * construction remain live through the existing native mesh-data intrinsic.
 */
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";
import { createSuiteSceneServer } from "./capture-suite-reference.js";
import { pageBase64Script, runPageGlobal } from "./browser-harness.js";
import { runGenerationChild } from "./compiler/generation-child.js";
import {
    packBakedCsgMesh,
    recordingCsgEngine,
    unpackBakedCsgMesh,
    type BakedCsgMesh,
    type CsgSourceMesh,
} from "./pinned-csg.js";

export const csg2BooleanNames = ["csg2Subtract", "csg2Intersect", "csg2Add"] as const;
export type Csg2BooleanName = (typeof csg2BooleanNames)[number];
export type Csg2SolidPlan =
    | { readonly op: "from-mesh"; readonly source: CsgSourceMesh; readonly materialSlot: number }
    | { readonly op: Csg2BooleanName; readonly left: Csg2SolidPlan; readonly right: Csg2SolidPlan };

export interface Csg2BakeRequest {
    readonly plan: Csg2SolidPlan;
    readonly name: string;
    /** Absent selects the single-mesh factory. */
    readonly materialCount?: number;
}
export interface BakedCsg2Mesh {
    readonly name: string;
    readonly materialSlot?: number;
    readonly geometry: BakedCsgMesh;
}
interface SerializedCsg2Mesh {
    readonly name: string;
    readonly materialSlot?: number;
    readonly geometry: string;
}

interface PinnedMesh {
    readonly name: string;
    readonly material?: { readonly slot: number };
    readonly worldMatrix: ArrayLike<number>;
    readonly _cpuPositions?: Float32Array;
    readonly _cpuNormals?: Float32Array;
    readonly _cpuUvs?: Float32Array;
    readonly _cpuIndices?: Uint32Array;
}
interface PinnedSolid { readonly _manifold: unknown }
type PinnedCsg2 = Record<Csg2BooleanName, (a: PinnedSolid, b: PinnedSolid) => PinnedSolid> & {
    initializeCsg2Async(): Promise<void>;
    createCsg2FromMesh(mesh: PinnedMesh, materialSlot: number): PinnedSolid;
    disposeCsg2(solid: PinnedSolid): void;
    createMeshFromCsg2(engine: unknown, solid: PinnedSolid, name: string): PinnedMesh;
    createMeshesFromCsg2(engine: unknown, solid: PinnedSolid, materials: { slot: number }[], name: string): PinnedMesh[];
};

/** This body is serialized into the page; every dependency is an argument. */
async function replayPlan(
    request: Csg2BakeRequest,
    csg: PinnedCsg2,
    factories: Record<CsgSourceMesh["factory"], (engine: unknown, options: unknown) => PinnedMesh>,
    makeEngine: typeof recordingCsgEngine,
    pack: typeof packBakedCsgMesh,
    base64: (bytes: Uint8Array) => string,
): Promise<SerializedCsg2Mesh[]> {
    await csg.initializeCsg2Async();
    const engine = makeEngine();
    const solids: PinnedSolid[] = [];
    const build = (plan: Csg2SolidPlan): PinnedSolid => {
        let solid: PinnedSolid;
        if (plan.op === "from-mesh") {
            const mesh = factories[plan.source.factory](engine, plan.source.options);
            const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
            if (mesh.worldMatrix.length !== 16 || identity.some((value, index) => mesh.worldMatrix[index] !== value)) {
                throw new Error("A pinned CSG2 source factory no longer starts at the identity transform.");
            }
            solid = csg.createCsg2FromMesh(mesh, plan.materialSlot);
        } else {
            solid = csg[plan.op](build(plan.left), build(plan.right));
        }
        solids.push(solid);
        return solid;
    };
    try {
        const solid = build(request.plan);
        const meshes = request.materialCount === undefined
            ? [csg.createMeshFromCsg2(engine, solid, request.name)]
            : csg.createMeshesFromCsg2(engine, solid,
                Array.from({ length: request.materialCount }, (_, slot) => ({ slot })), request.name);
        return meshes.map((mesh) => {
            if (!mesh._cpuPositions || !mesh._cpuNormals || !mesh._cpuUvs || !mesh._cpuIndices) {
                throw new Error("A pinned CSG2 output omitted a required retained CPU stream.");
            }
            return {
                name: mesh.name,
                ...(mesh.material ? { materialSlot: mesh.material.slot } : {}),
                geometry: base64(pack({ positions: mesh._cpuPositions, normals: mesh._cpuNormals,
                    uvs: mesh._cpuUvs, indices: mesh._cpuIndices })),
            };
        });
    } finally {
        for (const solid of solids.reverse()) csg.disposeCsg2(solid);
    }
}

/** Called by the synchronous compiler's generation child. */
export async function executeCsg2Bake(request: Csg2BakeRequest): Promise<unknown> {
    const server = createSuiteSceneServer(`
import * as csg from "/node_modules/@babylonjs/lite/lib/mesh/csg2.js";
import * as factories from "/node_modules/@babylonjs/lite/lib/mesh/mesh-factories.js";
${pageBase64Script}
window.__bakeCsg2 = () => (${replayPlan.toString()})(
    ${JSON.stringify(request)}, csg, factories,
    ${recordingCsgEngine.toString()}, ${packBakedCsgMesh.toString()}, bblBase64);
`);
    return runPageGlobal(server, "__bakeCsg2", {
        serverName: "pinned CSG2 bake",
        browserRequirement: "Pinned CSG2 Manifold WASM requires Chrome or Edge.",
    });
}

export function bakeCsg2Meshes(request: Csg2BakeRequest): readonly BakedCsg2Mesh[] {
    const bytes = cachedBakeSync({
        kind: "executed-csg2-solid", version: "1", module: moduleIdentity(import.meta.url),
        browser: true, parameters: { request }, inputs: [],
    }, () => Buffer.from(runGenerationChild({
        script: `
const source = JSON.parse(process.env.BBLITE_CSG2_REQUEST);
const module = await import(process.env.BBLITE_CSG2_MODULE);
process.stdout.write(JSON.stringify(await module.executeCsg2Bake(source)));
`,
        label: "Executing pinned CSG2 Manifold WASM",
        env: { BBLITE_CSG2_REQUEST: JSON.stringify(request), BBLITE_CSG2_MODULE: import.meta.url },
        maxBuffer: 128 * 1024 * 1024,
    }), "utf8"));
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!Array.isArray(value)) throw new Error("Pinned CSG2 bake did not return a mesh list.");
    return value.map((entry: unknown) => {
        if (typeof entry !== "object" || entry === null || !("name" in entry) || typeof entry.name !== "string" ||
            !("geometry" in entry) || typeof entry.geometry !== "string" ||
            ("materialSlot" in entry && (typeof entry.materialSlot !== "number" || !Number.isInteger(entry.materialSlot)))) {
            throw new Error("Pinned CSG2 bake returned an invalid mesh descriptor.");
        }
        return { name: entry.name,
            ...("materialSlot" in entry ? { materialSlot: entry.materialSlot as number } : {}),
            geometry: unpackBakedCsgMesh(Buffer.from(entry.geometry, "base64")) };
    });
}
