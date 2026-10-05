/**
 * `enableSkeletonShadows`: the caster fit's live skinned bounds.
 *
 * Upstream the provider builds one bind-space box per influencing bone
 * (`buildSkinnedBoneCorners`), then each fit transforms every box's eight
 * corners by that bone's live `boneMatrices` entry and grows a mesh-local
 * box over them. The pin wraps each caster in a proxy mesh whose bounds it
 * rewrites; this port has one caster carrier per fit, so the provider runs
 * where the carrier is filled and composes over the morph provider's box
 * there, in the pin's stage order.
 *
 * The two numeric helpers are lowered from `src/mesh/aabb-corners.ts`. The
 * bone-box build closes over its arrays through a nested `accumulate` arrow
 * and returns object records, and the provider is a method on an object
 * literal over a WeakMap cache; neither is a shape `lowerPinnedFunction`
 * translates, so both are restated below and every pinned function they
 * restate is held to its complete body.
 */
import type { LoweringContext } from "./context.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";

const cornersModule = "src/mesh/aabb-corners.ts";
const providerModule = "src/shadow/enable-skeleton-shadows.ts";
const deformableModule = "src/shadow/deformable-shadow-casters.ts";

/** The pinned bodies the native provider restates, whole. */
const restatedBodies: readonly (readonly [string, string, string])[] = [
    [
        providerModule,
        "enableSkeletonShadows",
        `{
    enableDeformableShadowBounds(generator, createSkeletonBoundsProvider(generator));
}`,
    ],
    [
        providerModule,
        "createSkeletonBoundsProvider",
        `{
    return {
        kind: "skeleton",
        applies: (mesh) => !!mesh.skeleton?.weights && !!mesh.skeleton.boneMatrices,
        getLocalBounds(mesh) {
            const bounds = getPreviousDeformableShadowBounds(generator, mesh, "skeleton");
            const cache = getCache(mesh);
            const boneMatrices = mesh.skeleton?.boneMatrices;
            if (!cache?.boxes || !boneMatrices) {
                return bounds;
            }
            const min = cache.result[0];
            const max = cache.result[1];
            if (bounds && cache.base) {
                for (let axis = 0; axis < 3; axis++) {
                    min[axis] = Math.min(bounds[0][axis]!, cache.base[0][axis]!);
                    max[axis] = Math.max(bounds[1][axis]!, cache.base[1][axis]!);
                }
                setExtentCorners(cache.composedCorners, min, max);
            }
            min[0] = min[1] = min[2] = Infinity;
            max[0] = max[1] = max[2] = -Infinity;
            for (const box of cache.boxes) {
                growCornersByMatrix(bounds ? cache.composedCorners : box.corners, boneMatrices, min, max, box.boneIndex * 16);
            }
            return Number.isFinite(min[0]) ? cache.result : bounds;
        },
    };
}`,
    ],
    [
        providerModule,
        "getCache",
        `{
    const skeleton = mesh.skeleton;
    if (!skeleton?.weights || !skeleton.boneMatrices) {
        return null;
    }
    const cache = (caches ??= new WeakMap()).get(mesh);
    if (
        cache &&
        cache.positions === mesh._cpuPositions &&
        cache.skeleton === skeleton &&
        cache.joints === skeleton.joints &&
        cache.weights === skeleton.weights &&
        cache.joints1 === skeleton.joints1 &&
        cache.weights1 === skeleton.weights1
    ) {
        return cache;
    }
    const boxes = buildSkinnedBoneCorners(mesh);
    const base: Aabb | null = boxes
        ? [
              [Infinity, Infinity, Infinity],
              [-Infinity, -Infinity, -Infinity],
          ]
        : null;
    for (const box of boxes ?? []) {
        for (let axis = 0; axis < 3; axis++) {
            base![0][axis] = Math.min(base![0][axis]!, box.corners[axis]!);
            base![1][axis] = Math.max(base![1][axis]!, box.corners[21 + axis]!);
        }
    }
    const next: SkeletonBoundsCache = {
        positions: mesh._cpuPositions,
        skeleton,
        joints: skeleton.joints,
        weights: skeleton.weights,
        joints1: skeleton.joints1,
        weights1: skeleton.weights1,
        boxes,
        base,
        composedCorners: new Float32Array(24),
        result: [
            [0, 0, 0],
            [0, 0, 0],
        ],
    };
    caches.set(mesh, next);
    return next;
}`,
    ],
    [
        cornersModule,
        "buildSkinnedBoneCorners",
        `{
    const positions = mesh._cpuPositions;
    const skeleton = mesh.skeleton;
    if (!positions || positions.length === 0 || !skeleton || !skeleton.weights) {
        return null;
    }

    const vertexCount = (positions.length / 3) | 0;
    const boneCount = skeleton.boneCount;
    const boneMin = new F32(boneCount * 3).fill(Number.POSITIVE_INFINITY);
    const boneMax = new F32(boneCount * 3).fill(Number.NEGATIVE_INFINITY);
    const boneUsed = new Uint8Array(boneCount);

    const accumulate = (joints: Uint8Array | Uint16Array, weights: Float32Array, vertex: number): void => {
        const base = vertex * 4;
        for (let k = 0; k < 4; k++) {
            if (weights[base + k]! > 0) {
                const bone = joints[base + k]!;
                if (bone < boneCount) {
                    const bo = bone * 3;
                    const vo = vertex * 3;
                    if (positions[vo]! < boneMin[bo]!) {
                        boneMin[bo] = positions[vo]!;
                    }
                    if (positions[vo + 1]! < boneMin[bo + 1]!) {
                        boneMin[bo + 1] = positions[vo + 1]!;
                    }
                    if (positions[vo + 2]! < boneMin[bo + 2]!) {
                        boneMin[bo + 2] = positions[vo + 2]!;
                    }
                    if (positions[vo]! > boneMax[bo]!) {
                        boneMax[bo] = positions[vo]!;
                    }
                    if (positions[vo + 1]! > boneMax[bo + 1]!) {
                        boneMax[bo + 1] = positions[vo + 1]!;
                    }
                    if (positions[vo + 2]! > boneMax[bo + 2]!) {
                        boneMax[bo + 2] = positions[vo + 2]!;
                    }
                    boneUsed[bone] = 1;
                }
            }
        }
    };

    const joints0 = skeleton.joints;
    const weights0 = skeleton.weights;
    const joints1 = skeleton.joints1;
    const weights1 = skeleton.weights1;
    for (let v = 0; v < vertexCount; v++) {
        accumulate(joints0, weights0, v);
        if (joints1 && weights1) {
            accumulate(joints1, weights1, v);
        }
    }

    const bones: BoneCornerBox[] = [];
    for (let b = 0; b < boneCount; b++) {
        if (boneUsed[b]) {
            const o = b * 3;
            bones.push({
                boneIndex: b,
                corners: extentCorners([boneMin[o]!, boneMin[o + 1]!, boneMin[o + 2]!], [boneMax[o]!, boneMax[o + 1]!, boneMax[o + 2]!]),
            });
        }
    }
    return bones;
}`,
    ],
    [
        cornersModule,
        "extentCorners",
        `{
    const c = new F32(24);
    setExtentCorners(c, min, max);
    return c;
}`,
    ],
    // The stage order the composition reads: skeleton bounds sit at
    // provider index 0 and morph bounds at 1, so a caster that both apply
    // to takes the skeleton provider, over the morph provider's box.
    [
        deformableModule,
        "getPreviousDeformableShadowBounds",
        `{
    const providers = states?.get(generator)?.providers;
    let bounds: Aabb | null = null;
    for (let i = providers?.length ?? 0, kindIndex = kind === "morph" ? 1 : 0; --i > kindIndex;) {
        const provider = providers![i];
        if (provider?.applies(mesh)) {
            bounds = provider.getLocalBounds(mesh, bounds);
        }
    }
    return bounds;
}`,
    ],
    [
        deformableModule,
        "mapCasterMeshes",
        `{
    if (state.sourceMeshes === casterMeshes) {
        return state.shadowMeshes!;
    }
    const entries: ShadowMeshEntry[] = [];
    const shadowMeshes = casterMeshes.map((mesh) => {
        const provider = state.providers.find((candidate) => candidate?.applies(mesh));
        if (!provider) {
            return mesh;
        }
        const entry = createShadowMesh(mesh, provider);
        entries.push(entry);
        return entry.shadow;
    });
    state.sourceMeshes = casterMeshes;
    state.shadowMeshes = shadowMeshes;
    state.entries = entries;
    return shadowMeshes;
}`,
    ],
];

/** The lowered corner helpers and the provider, for the shadow header. */
export function lowerSkeletonShadowBounds(context: LoweringContext): string {
    for (const [module, name, body] of restatedBodies) {
        context.assertFunctionBodyShape(
            context.functionDeclaration(module, name).declaration,
            body,
            `Pinned ${name}`,
        );
    }
    context.expectShapeCount(
        context.sourceFile(deformableModule),
        'provider.kind === "morph" ? 1 : 0',
        "deformable bounds stage index",
    );
    const setExtentCorners = lowerPinnedFunction(
        context,
        cornersModule,
        "setExtentCorners",
        [
            {
                pinned: "corners",
                kind: "f32Buffer",
                cpp: "corners",
                cppType: "std::array<float, 24>",
                mutableRecord: true,
            },
            {
                pinned: "min",
                kind: "numberList",
                cpp: "min",
                annotation: "ArrayLike<number>",
                cppType: "std::array<double, 3>",
            },
            {
                pinned: "max",
                kind: "numberList",
                cpp: "max",
                annotation: "ArrayLike<number>",
                cppType: "std::array<double, 3>",
            },
        ],
        { cppName: "set_extent_corners", returns: "void", inline: true },
    );
    const growCornersByMatrix = lowerPinnedFunction(
        context,
        cornersModule,
        "growCornersByMatrix",
        [
            {
                pinned: "corners",
                kind: "f32Buffer",
                cpp: "corners",
                cppType: "std::array<float, 24>",
            },
            { pinned: "matrix", kind: "numberArray", cpp: "matrix" },
            {
                pinned: "min",
                kind: "numberList",
                cpp: "min",
                cppType: "std::array<double, 3>",
                mutableRecord: true,
            },
            {
                pinned: "max",
                kind: "numberList",
                cpp: "max",
                cppType: "std::array<double, 3>",
                mutableRecord: true,
            },
            // The pin indexes one flat palette at `boneIndex * 16`; the
            // native palette is one matrix per bone, handed over whole.
            {
                pinned: "offset",
                kind: "index",
                cpp: "offset",
                defaultValue: 0,
                specialized: true,
                binding: { cpp: "0", type: "index" },
            },
        ],
        { cppName: "grow_corners_by_matrix", returns: "void", inline: true },
    );
    return `
${setExtentCorners}

${growCornersByMatrix}

/**
 * \`getCache\`: the bone boxes \`buildSkinnedBoneCorners\` builds, with their
 * union, kept on the geometry until its skin lanes or bone count change. A
 * scene skeleton's attachment writes its joints and weights into those
 * lanes, so they are the one skin source; four influences, the lanes this
 * port skins with (eight-influence skins are truncated at load).
 */
inline const SkinnedBoneBounds& skinned_bone_bounds(
    const ModelGeometry& geometry, std::size_t bone_count) {
    SkinnedBoneBounds& cache = geometry.skinned_bones;
    if (cache.source == geometry.vertices.data() && cache.bone_count == bone_count) return cache;
    constexpr float inf = std::numeric_limits<float>::infinity();
    std::vector<std::array<float, 3>> bone_min(bone_count, {inf, inf, inf});
    std::vector<std::array<float, 3>> bone_max(bone_count, {-inf, -inf, -inf});
    std::vector<bool> bone_used(bone_count);
    for (const ModelVertex& vertex : geometry.vertices) {
        const std::array<float, 3> position{vertex.position.x, vertex.position.y, vertex.position.z};
        const std::array<float, 4> weights{vertex.weights.x, vertex.weights.y, vertex.weights.z, vertex.weights.w};
        for (std::size_t k = 0; k < 4u; ++k) {
            const std::size_t bone = vertex.joints[k];
            if (!(weights[k] > 0.0f) || bone >= bone_count) continue;
            for (std::size_t axis = 0; axis < 3u; ++axis) {
                bone_min[bone][axis] = std::min(bone_min[bone][axis], position[axis]);
                bone_max[bone][axis] = std::max(bone_max[bone][axis], position[axis]);
            }
            bone_used[bone] = true;
        }
    }
    cache.boxes.clear();
    cache.base = {std::array<float, 3>{inf, inf, inf}, std::array<float, 3>{-inf, -inf, -inf}};
    for (std::size_t bone = 0; bone < bone_count; ++bone) {
        if (!bone_used[bone]) continue;
        SkinnedBoneCorners box;
        box.bone_index = static_cast<std::uint32_t>(bone);
        set_extent_corners(
            box.corners,
            {bone_min[bone][0], bone_min[bone][1], bone_min[bone][2]},
            {bone_max[bone][0], bone_max[bone][1], bone_max[bone][2]});
        for (std::size_t axis = 0; axis < 3u; ++axis) {
            cache.base[0][axis] = std::min(cache.base[0][axis], box.corners[axis]);
            cache.base[1][axis] = std::max(cache.base[1][axis], box.corners[21u + axis]);
        }
        cache.boxes.push_back(box);
    }
    cache.source = geometry.vertices.data();
    cache.bone_count = bone_count;
    return cache;
}

/**
 * The skeleton provider over the carrier's box: it applies to a mesh with a
 * live palette (\`attachVat\` drops the skeleton). \`composed\` says the morph
 * stage already wrote that box (the pin's \`bounds\`), which every bone then
 * moves whole; otherwise each bone moves its own box. Bounds stay as they
 * were when no bone grew them, as the pin falls back to \`bounds\`.
 */
inline void expand_skeleton_caster_bounds(
    const ModelGeometry& geometry, const MeshRecord& mesh, bool composed,
    std::array<float, 3>& bounds_min, std::array<float, 3>& bounds_max) {
    if (mesh.bone_matrices.empty() || mesh.has_vat) return;
    const SkinnedBoneBounds& cache = skinned_bone_bounds(geometry, mesh.bone_matrices.size());
    std::array<float, 24> composed_corners{};
    if (composed) {
        std::array<double, 3> union_min{};
        std::array<double, 3> union_max{};
        for (std::size_t axis = 0; axis < 3u; ++axis) {
            union_min[axis] = std::min<double>(bounds_min[axis], cache.base[0][axis]);
            union_max[axis] = std::max<double>(bounds_max[axis], cache.base[1][axis]);
        }
        set_extent_corners(composed_corners, union_min, union_max);
    }
    constexpr double inf = std::numeric_limits<double>::infinity();
    std::array<double, 3> min{inf, inf, inf};
    std::array<double, 3> max{-inf, -inf, -inf};
    for (const SkinnedBoneCorners& box : cache.boxes) {
        grow_corners_by_matrix(composed ? composed_corners : box.corners,
                               mesh.bone_matrices.at(box.bone_index), min, max);
    }
    if (!std::isfinite(min[0])) return;
    for (std::size_t axis = 0; axis < 3u; ++axis) {
        bounds_min[axis] = static_cast<float>(min[axis]);
        bounds_max[axis] = static_cast<float>(max[axis]);
    }
}
`;
}
