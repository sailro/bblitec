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
import { importPinnedModule } from "./pinned-shader-composer.js";

type JsonObject = Record<string, unknown>;

interface MeshFeatureBits {
    MSH_HAS_TANGENTS: number;
    MSH_HAS_SKELETON: number;
    MSH_HAS_MORPH_TARGETS: number;
    MSH_HAS_VERTEX_COLOR: number;
    MSH_HAS_UV2: number;
    MSH_FLAT_NORMAL: number;
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
    options: { skinned?: boolean } = {},
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
    return features;
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
