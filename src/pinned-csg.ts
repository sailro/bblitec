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
import {
    cppArrayDeclaration,
    float32Literal,
} from "./cpp-literals.js";

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

/**
 * The baked geometry as C++: the four arrays the mesh's streams become,
 * and the four expressions that hand them to `create_mesh_from_data`.
 *
 * The declaration shape belongs to `cpp-literals.ts` -- every baked
 * numeric stream wants it -- and what is CSG's own is only which four
 * streams there are and at which width each is spelled.
 */
export function csgGeometryDeclarations(
    prefix: string,
    mesh: BakedCsgMesh,
): {
    readonly lines: readonly string[];
    readonly positions: string;
    readonly normals: string;
    readonly indices: string;
    readonly uvs: string;
} {
    const lines: string[] = [];
    const stream = (
        name: string,
        elementType: "float" | "std::uint32_t",
        values: ArrayLike<number>,
    ): string => {
        const declared = cppArrayDeclaration(
            `${prefix}_${name}`,
            elementType,
            values,
            elementType === "float"
                ? float32Literal
                : (value: number) => `${value}u`,
        );
        lines.push(...declared.lines);
        return declared.expression;
    };
    return {
        lines,
        positions: stream("positions", "float", mesh.positions),
        normals: stream("normals", "float", mesh.normals),
        uvs: stream("uvs", "float", mesh.uvs),
        indices: stream("indices", "std::uint32_t", mesh.indices),
    };
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
 * A device that answers the one call the mesh upload makes.
 *
 * `createMeshFromData` uploads through `createMappedBuffer`, which creates
 * a mapped buffer, copies into its range and unmaps it. None of that
 * reaches the bake — what does is the CPU geometry the same function
 * retains — so the range is a plain `ArrayBuffer` and the rest is inert.
 */
function recordingEngine(): unknown {
    return {
        _device: {
            createBuffer({ size }: { size: number }) {
                let range: ArrayBuffer = new ArrayBuffer(size);
                return {
                    size,
                    getMappedRange: () => range,
                    unmap() {
                        range = new ArrayBuffer(0);
                    },
                    destroy() {},
                };
            },
            queue: { writeBuffer() {} },
        },
        _renderingContexts: [],
    };
}

const identityMatrix = [
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

/** One replay per distinct plan; a scene builds each solid once. */
const bakedMeshes = new Map<string, BakedCsgMesh>();

/**
 * The four streams as one payload, because a cache entry is bytes.
 *
 * Four element counts, then the streams in declaration order. The header
 * is 16 bytes and every stream is 4 wide, so each one lands aligned and
 * unpacking is views rather than copies.
 */
function packBakedMesh(mesh: BakedCsgMesh): Uint8Array {
    const counts = [
        mesh.positions.length,
        mesh.normals.length,
        mesh.uvs.length,
        mesh.indices.length,
    ];
    const bytes = new Uint8Array(
        16 + 4 * counts.reduce((sum, count) => sum + count, 0),
    );
    new Uint32Array(bytes.buffer, 0, 4).set(counts);
    let offset = 16;
    for (const stream of [mesh.positions, mesh.normals, mesh.uvs]) {
        new Float32Array(bytes.buffer, offset, stream.length).set(stream);
        offset += 4 * stream.length;
    }
    new Uint32Array(bytes.buffer, offset, mesh.indices.length).set(
        mesh.indices,
    );
    return bytes;
}

function unpackBakedMesh(payload: Uint8Array): BakedCsgMesh {
    // `readFileSync` answers with a view that can start at any offset in a
    // pooled buffer, and a typed-array view needs a 4-byte-aligned one; the
    // copy is one memcpy and only on an unaligned read.
    const bytes =
        payload.byteOffset % 4 === 0 ? payload : new Uint8Array(payload);
    const [positionCount = 0, normalCount = 0, uvCount = 0, indexCount = 0] =
        new Uint32Array(bytes.buffer, bytes.byteOffset, 4);
    let offset = bytes.byteOffset + 16;
    // Each stream starts where the last ended, so the calls below have to
    // run in declaration order -- which is what an object literal's
    // property order guarantees.
    const take = (count: number): number => {
        const start = offset;
        offset += 4 * count;
        return start;
    };
    return {
        positions: new Float32Array(
            bytes.buffer,
            take(positionCount),
            positionCount,
        ),
        normals: new Float32Array(
            bytes.buffer,
            take(normalCount),
            normalCount,
        ),
        uvs: new Float32Array(bytes.buffer, take(uvCount), uvCount),
        indices: new Uint32Array(bytes.buffer, take(indexCount), indexCount),
    };
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
    const baked = unpackBakedMesh(
        cachedBakeSync(
            {
                kind: "executed-csg-solid",
                version: "1",
                module: moduleIdentity(import.meta.url),
                browser: false,
                parameters: { plan, node: process.version },
                inputs: [],
            },
            () => packBakedMesh(replayCsgPlan(plan, name)),
        ),
    );
    bakedMeshes.set(key, baked);
    return baked;
}

function replayCsgPlan(plan: CsgSolidPlan, name: string): BakedCsgMesh {
    const engine = recordingEngine();
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
