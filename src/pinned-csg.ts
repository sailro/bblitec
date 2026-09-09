/**
 * The pinned BSP solid modeller, EXECUTED at generation.
 *
 * `src/mesh/csg.ts` is pure TypeScript over plain numbers — no WASM, no
 * browser API — importing only the maths helpers and `mesh-factories`, and
 * terminating in `createMeshFromData`, which this port already lowers. So
 * what a scene reaching it needs is the geometry the pin's own boolean
 * produced, and the question the repository's fold-versus-execute rule
 * asks is whether the SHAPE or the VALUE is the contract here.
 *
 * It is the value, for two independent reasons:
 *
 *   - **The BSP is epsilon-driven.** `splitPolygon` classifies each vertex
 *     against `EPSILON = 1e-5` and splits a spanning polygon at the
 *     parameter its own dot products produce. A reassociated dot product
 *     moves a vertex across that threshold, which does not perturb a
 *     position — it changes the polygon COUNT and with it the whole tree
 *     the next operation is built from.
 *   - **Every normal goes through `Math.hypot`.** `normalizeVec3` is the
 *     pin's, `planeFromVertices` and `interpolateVertex` both call it, and
 *     the specification leaves `Math.hypot` implementation-approximated —
 *     the same fact this port already records as
 *     `splat-hypot-approximation`. A native transcription would have to
 *     reproduce V8's approximation rather than a formula.
 *
 * And the shape is not the contract, because nothing downstream reads it:
 * the solid never reaches the runtime at all. What ships is a mesh, at the
 * one entry point `createMeshFromCsg` already ends in.
 *
 * So the plan a scene's calls describe is replayed against the pin's own
 * modules through the one pin executor, and the arrays it handed
 * `createMeshFromData` are baked. Like the polyhedron table and the
 * node-material compiler this runs under Node rather than in headless
 * Chromium — the module reaches no browser API, and a canvas rasterizer's
 * pixels are what force the drawn atlas into a browser. The engine it
 * needs is a recording stub, because `createMeshFromData` uploads before
 * it returns and nothing about the upload reaches the bake.
 */
import { importPinnedModule } from "./pinned-shader-composer.js";
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";
import { createRecordingDevice } from "./recording-device.js";

/**
 * A mesh a CSG solid was built from.
 *
 * `createCsgFromMesh` reads the mesh's retained CPU geometry and bakes its
 * world matrix into every vertex, so what generation must know is which
 * pinned factory built the geometry and with which options — and that the
 * world matrix is still the identity, which the intrinsic proves at the
 * call site and the replay asserts here.
 */
export type CsgSourceMesh =
    | {
          readonly factory: "createBox";
          readonly options: number | CsgBoxOptions;
      }
    | { readonly factory: "createSphere"; readonly options: CsgSphereOptions };

export interface CsgBoxOptions {
    readonly size?: number;
    readonly width?: number;
    readonly height?: number;
    readonly depth?: number;
}

export interface CsgSphereOptions {
    readonly segments?: number;
    readonly diameter?: number;
    readonly diameterX?: number;
    readonly diameterY?: number;
    readonly diameterZ?: number;
}

/** The expression tree one `CsgSolid` value stands for. */
export type CsgSolidPlan =
    | {
          readonly op: "from-mesh";
          readonly source: CsgSourceMesh;
          readonly materialSlot: number;
      }
    | {
          /** The pin's own export name, so the replay looks it up. */
          readonly op: CsgBooleanName;
          readonly left: CsgSolidPlan;
          readonly right: CsgSolidPlan;
      };

/** The three booleans `csg.ts` exports, by the names it exports them under. */
export const csgBooleanNames = [
    "csgUnion",
    "csgSubtract",
    "csgIntersect",
] as const;

export type CsgBooleanName = (typeof csgBooleanNames)[number];

/** The four streams `createMeshFromCsg` hands `createMeshFromData`. */
export interface BakedCsgMesh {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly uvs: Float32Array;
    readonly indices: Uint32Array;
}

/** The pin's own `Mesh`, in the members this replay reads. */
interface PinnedCsgMesh {
    readonly worldMatrix: ArrayLike<number>;
    readonly _cpuPositions?: Float32Array;
    readonly _cpuNormals?: Float32Array;
    readonly _cpuUvs?: Float32Array;
    readonly _cpuIndices?: Uint32Array;
}

type PinnedCsgSolid = { readonly __csgSolid?: never };

const pinnedCsg = await importPinnedModule<{
    createCsgFromMesh(
        mesh: PinnedCsgMesh,
        materialSlot?: number,
    ): PinnedCsgSolid;
    csgUnion(a: PinnedCsgSolid, b: PinnedCsgSolid): PinnedCsgSolid;
    csgSubtract(a: PinnedCsgSolid, b: PinnedCsgSolid): PinnedCsgSolid;
    csgIntersect(a: PinnedCsgSolid, b: PinnedCsgSolid): PinnedCsgSolid;
    createMeshFromCsg(
        engine: unknown,
        solid: PinnedCsgSolid,
        name?: string,
    ): PinnedCsgMesh;
}>("mesh/csg.js");

const pinnedMeshFactories = await importPinnedModule<
    Record<string, (engine: unknown, options?: unknown) => PinnedCsgMesh>
>("mesh/mesh-factories.js");

/**
 * An engine that answers the one call the mesh upload makes.
 *
 * `createMeshFromData` uploads through `createMappedBuffer`, which creates
 * a mapped buffer, copies into its range and unmaps it. None of that
 * reaches the bake — what does is the CPU geometry the same function
 * retains — so the device records and nothing reads the recording.
 *
 * The CSG2 bake serializes this function into its Chromium page with
 * `toString()`, beside a served copy of the recorder module: the body may
 * reference nothing but `createRecordingDevice`, which the page imports
 * under that name.
 */
export function recordingCsgEngine(): unknown {
    return {
        _device: createRecordingDevice({
            producer: "csg",
            device: ["createBuffer"],
            queue: ["writeBuffer"],
        }).device,
        _renderingContexts: [],
    };
}

const identityMatrix = [
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

/** One replay per distinct plan; a scene builds each solid once. */
const bakedMeshes = new Map<string, BakedCsgMesh>();
/** Four little-endian u32 counts, then f32 positions, normals, UVs and u32 indices. */
export function packBakedCsgMesh(mesh: BakedCsgMesh): Uint8Array {
    const streams = [mesh.positions, mesh.normals, mesh.uvs, mesh.indices];
    const bytes = new Uint8Array(16 + streams.reduce((size, stream) => size + stream.byteLength, 0));
    const view = new DataView(bytes.buffer);
    let offset = 16;
    streams.forEach((stream, index) => {
        if (stream.length > 0xffffffff) throw new Error("Baked mesh stream exceeds its u32 count.");
        view.setUint32(index * 4, stream.length, true);
        for (const value of stream) {
            if (stream instanceof Uint32Array) view.setUint32(offset, value, true);
            else view.setFloat32(offset, value, true);
            offset += 4;
        }
    });
    return bytes;
}
/** Decode the private cache/package transport without depending on host byte order. */
export function unpackBakedCsgMesh(payload: Uint8Array): BakedCsgMesh {
    if (payload.byteLength < 16) throw new Error("Truncated baked mesh header.");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = (index: number): number => view.getUint32(index * 4, true);
    const expected = 16 + 4 * (count(0) + count(1) + count(2) + count(3));
    if (expected !== payload.byteLength) throw new Error("Invalid baked mesh stream lengths.");
    let offset = 16;
    const floats = (length: number): Float32Array => {
        const result = new Float32Array(length);
        for (let i = 0; i < length; ++i, offset += 4) result[i] = view.getFloat32(offset, true);
        return result;
    };
    const positions = floats(count(0)), normals = floats(count(1)), uvs = floats(count(2));
    const indices = new Uint32Array(count(3));
    for (let i = 0; i < indices.length; ++i, offset += 4) indices[i] = view.getUint32(offset, true);
    return { positions, normals, uvs, indices };
}

/**
 * Replay one plan and return the mesh the pin built.
 *
 * The plan is the complete input, and the memo is keyed on it alone: the
 * pinned modules are pinned, the factories read nothing else, and the
 * name `createMeshFromCsg` forwards reaches only the record's own name
 * (`createMeshFromPolygons` builds the four streams out of the polygons
 * before `createMeshFromData` ever sees it). Two identically-shaped
 * solids under different names therefore replay once.
 */
export function bakeCsgMesh(
    plan: CsgSolidPlan,
    name: string,
): BakedCsgMesh {
    const key = JSON.stringify(plan);
    const cached = bakedMeshes.get(key);
    if (cached) return cached;
    // The memo above is one compile; the replay itself is the eighth
    // executed bake and belongs in the same content-addressed cache as
    // the other seven. Scene 90's three solids replay in 658 ms, paid
    // again on every recompile: its generation measures 2.38 s cold
    // against 1.70 s on a hit, with a byte-identical tree.
    //
    // `process.version` joins the key for the reason the browser identity
    // joins the Chromium ones: this module's own note, and the
    // `executed-csg-solid` adaptation record, say the baked geometry
    // depends on the V8 that ran it -- `Math.hypot` is
    // implementation-approximated and every normal goes through it. A
    // cache that outlived a Node upgrade would replay bytes a cold run no
    // longer produces, which is the delete-equals-cold contract the
    // record's "byte-stable across repeated compilations" rests on.
    const baked = unpackBakedCsgMesh(
        cachedBakeSync(
            {
                kind: "executed-csg-solid",
                version: "1",
                module: moduleIdentity(import.meta.url),
                browser: false,
                parameters: { plan, node: process.version },
                inputs: [],
            },
            () => packBakedCsgMesh(replayCsgPlan(plan, name)),
        ),
    );
    bakedMeshes.set(key, baked);
    return baked;
}

function replayCsgPlan(plan: CsgSolidPlan, name: string): BakedCsgMesh {
    const engine = recordingCsgEngine();
    const mesh = pinnedCsg.createMeshFromCsg(
        engine,
        buildSolid(engine, plan),
        name,
    );
    return {
        positions: mesh._cpuPositions ?? new Float32Array(),
        normals: mesh._cpuNormals ?? new Float32Array(),
        uvs: mesh._cpuUvs ?? new Float32Array(),
        indices: mesh._cpuIndices ?? new Uint32Array(),
    };
}

function buildSolid(engine: unknown, plan: CsgSolidPlan): PinnedCsgSolid {
    if (plan.op === "from-mesh") {
        return pinnedCsg.createCsgFromMesh(
            sourceMesh(engine, plan.source),
            plan.materialSlot,
        );
    }
    return pinnedCsg[plan.op](
        buildSolid(engine, plan.left),
        buildSolid(engine, plan.right),
    );
}

function sourceMesh(
    engine: unknown,
    source: CsgSourceMesh,
): PinnedCsgMesh {
    const factory = pinnedMeshFactories[source.factory];
    if (typeof factory !== "function") {
        throw new Error(
            `The pin declares no mesh factory '${source.factory}'.`,
        );
    }
    const mesh = factory(engine, source.options);
    // `createCsgFromMesh` bakes `mesh.worldMatrix` into every vertex. The
    // intrinsic proves the scene never wrote a transform before the call;
    // this proves the pin still starts one at the identity, so a changed
    // factory fails here rather than baking a solid in the wrong place.
    const world = Array.from(mesh.worldMatrix);
    if (
        world.length !== identityMatrix.length ||
        world.some((value, index) => value !== identityMatrix[index])
    ) {
        throw new Error(
            `Pinned ${source.factory} no longer starts at the identity ` +
                "world matrix, which a CSG solid bakes into every polygon.",
        );
    }
    return mesh;
}
