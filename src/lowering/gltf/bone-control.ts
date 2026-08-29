import ts from "typescript";
import { stringLiteral } from "../../cpp-literals.js";
import {
    coalescedPropertyDefault,
    collectNodes,
    declarationOf,
    identifierText,
    refuseModule,
    requirePropertyReads,
    signedNumericValue,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

const SYMBOL = "bone-control";

/** A call to a method named `name`, anywhere under `root`. */
function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
    return collectNodes(
        root,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === name,
    );
}

/** `<identifier> & <numeric literal>`, as the literal it tests. */
function maskBit(
    file: ts.SourceFile,
    expression: ts.Expression,
): number | undefined {
    const node = unwrapPin(expression);
    if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.AmpersandToken ||
        identifierText(node.left) === undefined ||
        !ts.isNumericLiteral(unwrapPin(node.right))
    ) {
        return undefined;
    }
    return signedNumericValue(SYMBOL, file, node.right);
}

/**
 * The hidden bit, read from the phase that applies it.
 *
 * `applyOverridesToTRS` has two phases and the split is the whole point of
 * the feature: the transform bits are written *before* channel evaluation
 * so a clip that animates the same bone wins, and the hidden bit is
 * written *after* it, which is what keeps `setBoneVisible` in force on a
 * rig that bakes a constant scale track onto every bone. Only the second
 * phase is reached here -- `setBoneVisible` is the one lowered mutator, so
 * no override this port can build carries a transform bit -- and the bit
 * is read out of the `hiddenOnly` branch rather than restated, so a
 * renumbering fails here.
 */
function hiddenMaskBit(boneControl: ts.SourceFile): number {
    const applier = topLevelFunction(
        boneControl,
        "applyOverridesToTRS",
    );
    const hiddenOnly = collectNodes(
        applier,
        (node): node is ts.IfStatement =>
            ts.isIfStatement(node) &&
            collectNodes(
                node.expression,
                (inner): inner is ts.Identifier =>
                    ts.isIdentifier(inner) &&
                    inner.text === "hiddenOnly",
            ).length > 0,
    )[0];
    const bit = hiddenOnly
        ? collectNodes(
              hiddenOnly.thenStatement,
              (node): node is ts.IfStatement => ts.isIfStatement(node),
          )
              .map((node) => maskBit(boneControl, node.expression))
              .find((value) => value !== undefined)
        : undefined;
    if (bit === undefined) {
        refuseModule(
            SYMBOL,
            "applyOverridesToTRS no longer applies a hidden bit in a " +
                "phase of its own",
        );
    }
    return bit;
}

/**
 * `setBoneVisible`'s two arms, asserted rather than emitted from the body:
 * hiding sets the bit and bakes, showing clears exactly that bit, drops an
 * override the clear emptied, and bakes only when there was one.
 */
function assertVisibilityArms(
    boneControl: ts.SourceFile,
    hidden: number,
): void {
    const declaration = topLevelFunction(
        boneControl,
        "setBoneVisible",
    );
    const assigns = (
        operator: ts.SyntaxKind,
        right: (node: ts.Expression) => boolean,
    ): boolean =>
        collectNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === operator &&
                right(node.right),
        ).length > 0;
    const setsBit = assigns(
        ts.SyntaxKind.BarEqualsToken,
        (right) =>
            ts.isNumericLiteral(unwrapPin(right)) &&
            signedNumericValue(SYMBOL, boneControl, right) === hidden,
    );
    // The clear is `&= ~<hidden>`: the complement of the same bit, not any
    // mask, because the emitted arm hardcodes that one.
    const clearsBit = assigns(
        ts.SyntaxKind.AmpersandEqualsToken,
        (right) => {
            const node = unwrapPin(right);
            return (
                ts.isPrefixUnaryExpression(node) &&
                node.operator === ts.SyntaxKind.TildeToken &&
                signedNumericValue(
                    SYMBOL,
                    boneControl,
                    node.operand,
                ) === hidden
            );
        },
    );
    if (
        !setsBit ||
        !clearsBit ||
        callsNamed(declaration, "delete").length === 0 ||
        callsNamed(declaration, "_bake").length !== 2
    ) {
        refuseModule(
            SYMBOL,
            "setBoneVisible no longer sets the hidden bit and bakes on " +
                "one arm and clears exactly that bit, deletes an emptied " +
                "override and bakes on the other",
        );
    }
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
    const firstWins = collectNodes(
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
    const fallback = collectNodes(
        builder,
        (node): node is ts.BinaryExpression => ts.isBinaryExpression(node),
    )
        .map((node) => coalescedPropertyDefault(node))
        .find(
            (candidate) =>
                candidate?.key === "name" &&
                ts.isTemplateExpression(unwrapPin(candidate.fallback)),
        );
    if (!fallback) {
        refuseModule(
            SYMBOL,
            "buildSkeletons no longer defaults an unnamed joint's name " +
                "from its node index",
        );
    }
    return (
        unwrapPin(fallback.fallback) as ts.TemplateExpression
    ).head.text;
}

/**
 * The bake's own statement order, which is the contract the emitted bake
 * mirrors with a working pose of its own: reset to rest, apply the
 * overrides, compose the node worlds, write the palettes.
 */
function assertBakeOrder(boneControl: ts.SourceFile): void {
    const builder = topLevelFunction(boneControl, "buildSkeletons");
    const bake = declarationOf(builder, "bake")?.initializer;
    const body =
        bake && ts.isArrowFunction(bake) && ts.isBlock(bake.body)
            ? bake.body
            : undefined;
    if (!body) {
        refuseModule(
            SYMBOL,
            "buildSkeletons no longer builds its eager bake as one arrow",
        );
    }
    const expected = [
        "resetTRS",
        "applyOverridesToTRS",
        "applyOverridesToTRS",
        "computeNodeWorldMatrices",
        "writeBoneTextures",
    ];
    const named = collectNodes(
        body,
        (node): node is ts.CallExpression => ts.isCallExpression(node),
    )
        .map((node) => identifierText(node.expression))
        .filter(
            (name): name is string =>
                name !== undefined && expected.includes(name),
        );
    if (named.join(",") !== expected.join(",")) {
        refuseModule(
            SYMBOL,
            "the eager bake no longer resets to rest, applies both " +
                "override phases, composes the node worlds and writes the " +
                "palettes in that order",
        );
    }
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
    const overNodes = collectNodes(
        extract,
        (node): node is ts.ForStatement =>
            ts.isForStatement(node) &&
            node.condition !== undefined &&
            collectNodes(
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

export interface LoweredBoneControl {
    /** The skeleton build, the override table and the eager bake. */
    loading: string;
    /** `getBoneByName` and `setBoneVisible`, as free functions. */
    entryPoints: string;
}

/**
 * The opt-in bone-control chunk (`src/skeleton/bone-control.ts` plus its
 * own `src/skeleton/skeleton-pose.ts`).
 *
 * Nothing here emits arithmetic: the bake is the node-world composition and
 * palette product the loader already owns, run over a working pose this
 * feature supplies. Upstream draws exactly that line too --
 * `skeleton-pose.ts` says it "mirrors the per-frame math the animation tick
 * runs" and exists only so the always-fetched tick stays byte identical
 * without bone control. So what this lowering owes is the facts the two
 * copies must agree on, each read from the declaration that states it.
 */
export function lowerBoneControl(
    boneControlFile: ts.SourceFile,
): LoweredBoneControl {
    const hidden = hiddenMaskBit(boneControlFile);
    assertVisibilityArms(boneControlFile, hidden);
    assertBakeOrder(boneControlFile);
    assertSkinGrouping(boneControlFile);
    const unnamedBonePrefix = nameLookupPrefix(boneControlFile);
    return {
        loading: loadingCpp(unnamedBonePrefix, hidden),
        entryPoints: entryPointsCpp(hidden),
    };
}

/**
 * The skeleton build, the asset-wide override table and the eager bake, as
 * they are emitted inside the loader's animated block.
 */
function loadingCpp(
    unnamedBonePrefix: string,
    hidden: number,
): string {
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
        // The override map is asset-wide upstream and keyed by node index,
        // because one skin is often split across meshes and an override
        // may reach across skins through the hierarchy. One slot per node
        // says the same thing.
        asset.bone_overrides.assign(
            animation_runtime->nodes.size(), BoneOverride{});
        // The eager bake: rest pose, the hidden phase, the node worlds and
        // the palettes. It composes a working pose of its own rather than
        // walking the live node TRS, exactly as upstream keeps
        // skeleton-pose.ts apart from the animation tick -- so a bake
        // moves the skins and nothing else, and it answers with no
        // animation running at all.
        asset.bake_skeletons =
            [animation_runtime, &engine, asset_index]() {
            const AssetRecord& owner = engine.assets[asset_index];
            const std::size_t node_count =
                animation_runtime->nodes.size();
            // resetTRS
            std::vector<Vec3> translation(node_count);
            std::vector<Vec4> rotation(node_count);
            std::vector<Vec3> scaling(node_count);
            for (std::size_t index = 0; index < node_count; ++index) {
                const AnimatedNode& node =
                    animation_runtime->nodes[index];
                translation[index] = node.rest_translation;
                rotation[index] = node.rest_rotation;
                scaling[index] = node.rest_scale;
            }
            // applyOverridesToTRS, hidden phase. The pin's first phase
            // writes the translation, rotation and scale bits before
            // channel evaluation; no override this port can build carries
            // one, because \`setBoneVisible\` is the single lowered
            // mutator, so only the phase it fills is emitted.
            for (
                std::size_t index = 0;
                index < node_count &&
                index < owner.bone_overrides.size();
                ++index) {
                if (
                    (owner.bone_overrides[index].mask &
                     ${hidden}u) != 0u) {
                    scaling[index] = Vec3{0.0f, 0.0f, 0.0f};
                }
            }
            // computeNodeWorldMatrices, over that working pose. The root
            // flip stays folded into native_matrix at the palette, which
            // is where every other node world in this loader carries it.
            std::vector<Matrix> world(node_count);
            std::vector<bool> computed(node_count, false);
            std::vector<bool> computing(node_count, false);
            std::function<const Matrix&(std::size_t)> bake_world =
                [&](std::size_t index) -> const Matrix& {
                if (computed[index]) return world[index];
                if (computing[index]) {
                    throw std::runtime_error(
                        "glTF node hierarchy contains a cycle.");
                }
                computing[index] = true;
                const AnimatedNode& node =
                    animation_runtime->nodes[index];
                const Matrix local = node.has_matrix
                    ? node.matrix
                    : trs_matrix(
                          translation[index],
                          rotation[index],
                          scaling[index]);
                world[index] = node.parent >= 0
                    ? multiply_matrix(
                          bake_world(
                              static_cast<std::size_t>(node.parent)),
                          local)
                    : local;
                computing[index] = false;
                computed[index] = true;
                return world[index];
            };
            // writeBoneTextures: the same joint-world times inverse-bind
            // product the pose pass composes, in the same convention --
            // the mesh world is conjugated into the palette here, which is
            // what native_matrix applies. Palettes and nothing else, as
            // the pin's own bake writes bone textures and nothing else.
            for (const AnimatedMeshBinding& binding :
                 animation_runtime->meshes) {
                if (
                    binding.skin >=
                    animation_runtime->skins.size()) {
                    continue;
                }
                const SkinRuntime& skin =
                    animation_runtime->skins[binding.skin];
                MeshRecord& mesh_record =
                    engine.meshes.at(binding.mesh);
                mesh_record.bone_matrices.clear();
                for (
                    std::size_t joint = 0;
                    joint < skin.joints.size();
                    ++joint) {
                    mesh_record.bone_matrices.push_back(
                        native_matrix(
                            multiply_matrix(
                                bake_world(skin.joints[joint]),
                                skin.inverse_bind_matrices[joint])));
                }
            }
        };`;
}

/** `getBoneByName` and `setBoneVisible`, as the loader's own free functions. */
function entryPointsCpp(hidden: number): string {
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
    BoneOverride& entry = owner.bone_overrides[node];
    if (!visible) {
        entry.mask |= ${hidden}u;
        if (owner.bake_skeletons) owner.bake_skeletons();
        return;
    }
    if ((entry.mask & ${hidden}u) == 0u) return;
    entry.mask &= ~static_cast<std::uint32_t>(${hidden}u);
    if (owner.bake_skeletons) owner.bake_skeletons();
}
`;
}
