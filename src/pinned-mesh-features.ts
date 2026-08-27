/**
 * Derives the pinned mesh feature bits for a glTF primitive.
 *
 * These are separate from the material bits and they change the composed
 * shader: `pbr-compose.ts` reads `MSH_HAS_TANGENTS` to choose between the
 * tangent-frame and cotangent normal paths, `MSH_HAS_UV2` to gate the second
 * UV set, and `MSH_FLAT_NORMAL` to compose the face-normal helper. So a variant
 * is keyed by (material, mesh) rather than by material alone, which is why one
 * material drawn on two differently-attributed meshes composes twice.
 *
 * The bits come from the primitive's own accessors, which is where the pinned
 * loader reads them from too.
 */
import type { JsonObject } from "./gltf-document.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

interface MeshFeatureBits {
    MSH_RECEIVE_SHADOWS: number;
    MSH_HAS_TANGENTS: number;
    MSH_HAS_SKELETON: number;
    MSH_HAS_MORPH_TARGETS: number;
    MSH_HAS_VERTEX_COLOR: number;
    MSH_HAS_UV2: number;
    MSH_FLAT_NORMAL: number;
    MSH_HAS_THIN_INSTANCES: number;
}

let bits: Promise<MeshFeatureBits> | undefined;

async function meshFeatureBits(): Promise<MeshFeatureBits> {
    bits ??= importPinnedModule<MeshFeatureBits>("material/mesh-features.js");
    return bits;
}

/**
 * The mesh bits a glTF primitive reaches.
 *
 * A primitive with no `NORMAL` accessor takes the pinned flat-normal path, and
 * one with a skin takes the skeleton path; both are read here from the
 * primitive and its owning node rather than inferred from the material.
 */
export async function pinnedMeshFeaturesFromPrimitive(
    primitive: JsonObject,
    options: { skinned?: boolean; instanced?: boolean } = {},
): Promise<number> {
    const bit = await meshFeatureBits();
    const attributes =
        (primitive["attributes"] as JsonObject | undefined) ?? {};
    let features = 0;
    if (attributes["TANGENT"] !== undefined) features |= bit.MSH_HAS_TANGENTS;
    if (attributes["COLOR_0"] !== undefined) {
        features |= bit.MSH_HAS_VERTEX_COLOR;
    }
    if (attributes["TEXCOORD_1"] !== undefined) features |= bit.MSH_HAS_UV2;
    if (attributes["NORMAL"] === undefined) features |= bit.MSH_FLAT_NORMAL;
    if (Array.isArray(primitive["targets"]) && primitive["targets"].length > 0) {
        features |= bit.MSH_HAS_MORPH_TARGETS;
    }
    if (options.skinned) features |= bit.MSH_HAS_SKELETON;
    // The node's EXT_mesh_gpu_instancing, which composes the pin's
    // thin-instance arm: the per-instance matrix as four vec4 attributes.
    if (options.instanced) features |= bit.MSH_HAS_THIN_INSTANCES;
    return features;
}

/**
 * The pin's own `MSH_RECEIVE_SHADOWS`.
 *
 * `rebuildSingle` ORs it through `_computeMeshFeatures(mesh, receiveShadows)`
 * where `receiveShadows` is `mesh.receiveShadows && hasSomeShadows`, so the
 * bit belongs to the mesh's row of the variant key rather than to its
 * material. Read from the pin rather than restated, like every other bit
 * this module hands out.
 */
export async function pinnedReceiveShadowsBit(): Promise<number> {
    return (await meshFeatureBits()).MSH_RECEIVE_SHADOWS;
}

/**
 * The pin's own runtime-attachable thin-instance bit.
 *
 * Unlike a primitive's static attribute bits, scene code can add this after
 * mesh creation with `setThinInstances`. Generation therefore composes both
 * halves of the reachable lattice and the PAL ORs this same value onto the
 * draw's static mesh word when the record owns an instance pool.
 */
export async function pinnedThinInstancesBit(): Promise<number> {
    return (await meshFeatureBits()).MSH_HAS_THIN_INSTANCES;
}

/**
 * Expands static mesh-feature words by runtime-attachable feature bits.
 *
 * Each bit doubles the current set rather than replacing it: a scene can draw
 * otherwise identical plain and decorated meshes, and multiple decorations
 * can coexist on one mesh. Keeping this as the generic product operation
 * avoids teaching material composition about the API that attached a bit.
 */
export function expandRuntimeMeshFeatureSets(
    featureSets: readonly number[],
    runtimeBits: readonly number[],
): number[] {
    const expanded = new Set(featureSets);
    for (const bit of runtimeBits) {
        for (const features of [...expanded]) {
            expanded.add(features | bit);
        }
    }
    return [...expanded];
}

/**
 * Whether any of these mesh feature words carries the pin's own skeleton
 * bit — which is what decides that a build's composed variants include a
 * skinned stage, and so which palette transport a skin takes.
 */
export async function pinnedFeaturesCarrySkeleton(
    features: readonly number[],
): Promise<boolean> {
    const bit = await meshFeatureBits();
    return features.some(
        (word) => (word & bit.MSH_HAS_SKELETON) !== 0,
    );
}

/** The set of nodes whose mesh is skinned, so primitives can be keyed by it. */
export function skinnedMeshIndices(document: JsonObject): ReadonlySet<number> {
    const nodes = Array.isArray(document["nodes"])
        ? (document["nodes"] as JsonObject[])
        : [];
    const skinned = new Set<number>();
    for (const node of nodes) {
        const mesh = node["mesh"];
        if (typeof mesh === "number" && node["skin"] !== undefined) {
            skinned.add(mesh);
        }
    }
    return skinned;
}
