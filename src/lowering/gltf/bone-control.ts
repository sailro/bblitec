import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerGltfBoneVisibility} from "./bone-visibility.js";
import { stringLiteral } from "../../cpp-literals.js";
import {
    coalescedPropertyDefault,
    findNodes,
    refuseModule,
    requirePropertyReads,
    topLevelFunction,
    unwrapExpression,
} from "./shared.js";

const SYMBOL = "bone-control";

/** A call to a method named `name`, anywhere under `root`. */
function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
    return findNodes(
        root,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === name,
    );
}

/**
 * `getBoneByName` is the skeleton's own name map, and the map keeps the
 * FIRST bone carrying a name. Both halves are asserted, because the
 * emitted lookup is a linear search in joint order and the two agree only
 * while that rule holds. The unnamed-joint fallback comes back as the
 * prefix its template writes.
 */
function nameLookupPrefix(boneControl: ts.SourceFile): string {
    requirePropertyReads(
        SYMBOL,
        topLevelFunction(boneControl, "getBoneByName"),
        ["_byName", "get"],
    );
    const builder = topLevelFunction(boneControl, "buildSkeletons");
    const firstWins = findNodes(
        builder,
        (node): node is ts.PrefixUnaryExpression =>
            ts.isPrefixUnaryExpression(node) &&
            node.operator === ts.SyntaxKind.ExclamationToken &&
            callsNamed(node.operand, "has").length > 0,
    ).length > 0;
    if (!firstWins) {
        refuseModule(
            SYMBOL,
            "buildSkeletons no longer keeps the first bone of a repeated " +
                "name",
        );
    }
    // `json.nodes?.[ni]?.name ?? `bone_${ni}`` — the same read the camera
    // and mesh name prefixes come from, so an authored empty name is kept
    // and only a missing one takes the fallback.
    const fallback = findNodes(
        builder,
        (node): node is ts.BinaryExpression => ts.isBinaryExpression(node),
    )
        .map((node) => coalescedPropertyDefault(node))
        .find(
            (candidate) =>
                candidate?.key === "name" &&
                ts.isTemplateExpression(unwrapExpression(candidate.fallback)),
        );
    if (!fallback) {
        refuseModule(
            SYMBOL,
            "buildSkeletons no longer defaults an unnamed joint's name " +
                "from its node index",
        );
    }
    return (
        unwrapExpression(fallback.fallback) as ts.TemplateExpression
    ).head.text;
}

/**
 * `extractSkinGroups` builds one group per NODE, which is what makes a skin
 * instanced twice two skeletons and a mesh split into primitives one -- the
 * grouping the emitted loader mirrors by de-duplicating its own bindings on
 * the node. Its inverse-bind matrices come from `resolveIBMs`, whose absent
 * arm the port's own skin runtime already fills.
 */
function assertSkinGrouping(boneControl: ts.SourceFile): void {
    const extract = topLevelFunction(
        boneControl,
        "extractSkinGroups",
    );
    requirePropertyReads(SYMBOL, extract, ["skin", "skins", "joints"]);
    const overNodes = findNodes(
        extract,
        (node): node is ts.ForStatement =>
            ts.isForStatement(node) &&
            node.condition !== undefined &&
            findNodes(
                node.condition,
                (inner): inner is ts.Identifier =>
                    ts.isIdentifier(inner) &&
                    inner.text === "nodeCount",
            ).length > 0,
    ).length > 0;
    if (!overNodes) {
        refuseModule(
            SYMBOL,
            "extractSkinGroups no longer groups over the document's nodes",
        );
    }
    requirePropertyReads(
        SYMBOL,
        topLevelFunction(boneControl, "resolveIBMs"),
        ["inverseBindMatrices"],
    );
}

interface LoweredBoneControl {
    /** The skeleton build, the override table and the eager bake. */
    loading: string;
    /** `getBoneByName` and `setBoneVisible`, as free functions. */
    entryPoints: string;
}

/** Bone handles adapt source skeleton identity; pose and visibility bodies derive from source. */
export function lowerBoneControl(context: LoweringContext): LoweredBoneControl {
    const boneControlFile = context.sourceFile("src/skeleton/bone-control.ts");
    assertSkinGrouping(boneControlFile);
    const unnamedBonePrefix = nameLookupPrefix(boneControlFile);
    return {
        loading: loadingCpp(unnamedBonePrefix),
        entryPoints: lowerGltfBoneVisibility(context) + entryPointsCpp(),
    };
}

/**
 * The skeleton build, the asset-wide override table and the eager bake, as
 * they are emitted inside the loader's animated block.
 */
function loadingCpp(unnamedBonePrefix: string): string {
    return `
        // src/skeleton/bone-control.ts#buildSkeletons. One Skeleton per
        // NODE carrying both a skin and mesh primitives, which is the
        // pin's own extractSkinGroups grouping: a skin instanced twice is
        // two skeletons, a mesh split into primitives is one. A scene that
        // never reached enableBoneControl emits a loader with none of this
        // in it, which is the boundary the pin draws with its two null
        // hooks in bone-control-hooks.ts.
        const std::uint32_t asset_index =
            static_cast<std::uint32_t>(engine.assets.size());
        std::vector<std::pair<std::size_t, std::size_t>> skin_groups;
        for (const AnimatedMeshBinding& binding :
             animation_runtime->meshes) {
            if (
                binding.skin >=
                animation_runtime->skins.size()) {
                continue;
            }
            const auto grouped = std::find_if(
                skin_groups.begin(),
                skin_groups.end(),
                [&binding](
                    const std::pair<std::size_t, std::size_t>& group) {
                    return group.first == binding.node;
                });
            if (grouped != skin_groups.end()) continue;
            skin_groups.emplace_back(binding.node, binding.skin);
        }
        for (const std::pair<std::size_t, std::size_t>& group :
             skin_groups) {
            const SkinRuntime& skin =
                animation_runtime->skins[group.second];
            const std::uint32_t skeleton_index =
                static_cast<std::uint32_t>(engine.skeletons.size());
            SkeletonRecord skeleton;
            skeleton.asset = asset_index;
            for (const std::size_t joint : skin.joints) {
                // The pin coalesces the joint node's name on ABSENCE, so
                // an authored empty name is kept and only a missing one
                // takes the interpolated fallback.
                const std::string fallback =
                    ${stringLiteral(unnamedBonePrefix)} + std::to_string(joint);
                BoneRecord bone;
                bone.name = joint < node_json.size()
                    ? string_or(
                          node_json[joint].as_object(),
                          "name",
                          fallback)
                    : fallback;
                bone.node_index = static_cast<std::uint32_t>(joint);
                engine.bones.push_back(std::move(bone));
                skeleton.bones.push_back(BoneHandle{
                    static_cast<std::uint32_t>(
                        engine.bones.size() - 1)});
            }
            engine.skeletons.push_back(std::move(skeleton));
            asset.skeletons.push_back(SkeletonHandle{skeleton_index});
        }
        // Each bake uses private rest/world scratch and shared source palette resources.
        if (!animation_runtime->source_skeletons.entries.empty()) {
            asset.bone_overrides.assign(animation_runtime->source_nodes.size(), BoneOverride{});
            auto bone_pose = std::make_shared<GltfAnimationPoseState>();
            bone_pose->nodes = animation_runtime->source_nodes;
            bone_pose->skeletons = animation_runtime->source_skeletons;
            gltf_initialize_skeleton_pose(*bone_pose);
            asset.bake_skeletons = [animation_runtime, bone_pose, &engine, asset_index]() {
                const auto overrides = gltf_animation_override_rows(engine, asset_index);
                const auto apply_overrides = [&](auto& trs, double count, bool hidden) {
                    gltf_apply_animation_bone_overrides(overrides, trs, count, hidden);
                };
                gltf_bake_skeleton_pose(*bone_pose, static_cast<double>(overrides.size()),
                    [](double) -> const GltfAnimationFloats* { return nullptr; },
                    apply_overrides, gltf_animation_compose, gltf_animation_multiply,
                    animation_runtime->upload_bones);
                animation_runtime->publish_pose();
            };
        }`;

}

/** `getBoneByName` and `setBoneVisible`, as the loader's own free functions. */
function entryPointsCpp(): string {
    return `
// src/skeleton/bone-control.ts#getBoneByName, which is one
// skeleton._byName.get(name). The map keeps the FIRST bone carrying a
// name, so the linear walk in joint order answers the same question; a
// miss is the invalid handle, which is the undefined the pin returns.
BoneHandle get_bone_by_name(
    Engine& engine,
    SkeletonHandle skeleton,
    const std::string& name) {
    if (skeleton.value >= engine.skeletons.size()) return BoneHandle{};
    for (const BoneHandle bone :
         engine.skeletons[skeleton.value].bones) {
        if (
            bone.value < engine.bones.size() &&
            engine.bones[bone.value].name == name) {
            return bone;
        }
    }
    return BoneHandle{};
}

// src/skeleton/bone-control.ts#setBoneVisible. Hiding ensures the override
// and sets the hidden bit; showing clears it, drops an override the clear
// emptied, and re-bakes only when there was one to clear. Visibility is not
// a transform override animation can overwrite -- the bake applies it after
// channel evaluation -- which is what makes it survive a rig that bakes a
// constant scale track onto every bone.
void set_bone_visible(
    Engine& engine,
    SkeletonHandle skeleton,
    BoneHandle bone,
    bool visible) {
    if (
        skeleton.value >= engine.skeletons.size() ||
        bone.value >= engine.bones.size()) {
        return;
    }
    const std::uint32_t asset =
        engine.skeletons[skeleton.value].asset;
    if (asset >= engine.assets.size()) return;
    AssetRecord& owner = engine.assets[asset];
    const std::uint32_t node = engine.bones[bone.value].node_index;
    if (node >= owner.bone_overrides.size()) return;
    gltf_set_bone_visibility(owner.bone_overrides, node, visible, [&] {
        if (owner.bake_skeletons) owner.bake_skeletons();
    });
}
`;
}
