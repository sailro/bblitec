import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

export interface SkeletonIntrinsicContext
    extends IntrinsicCallContext {
    allocateTemporaryCppName(label: string): string;
    emit(line: string): void;
    cppString(value: string): string;
    compileStringLiteral(expression: ts.Expression): string;
    compileCondition(expression: ts.Expression): string;
    requireEngine(value: Value, node: ts.Node): string;
    featureReached(feature: "loader:gltf"): boolean;
    fail(node: ts.Node, message: string): never;
}

/**
 * Opt-in bone control (`src/skeleton/bone-control.ts`), at the slice
 * scene 99 reaches.
 *
 * Upstream keeps the whole chunk behind two null hooks in
 * `bone-control-hooks.ts`: until `enableBoneControl()` is imported and
 * called, the tree-shaker folds the handle building, the skin extraction,
 * the eager bake and the override application away. This port reaches the
 * feature at the same call, so a scene that never enables it emits a
 * loader with no skeletons in it at all.
 *
 * The order matters and is the pin's: `enableBoneControl` installs the
 * builder hook, and only a `loadGltf` *after* it produces skeletons. A
 * scene enabling it after a load would get skeletons upstream for no
 * asset and for every asset here, so that order refuses rather than
 * quietly building them.
 */
export function compileSkeletonIntrinsic(
    context: SkeletonIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "enableBoneControl": {
            // `_installBoneControl(buildSkeletons, applyOverridesToTRS)` —
            // the call creates nothing, so it emits no statement; what it
            // does is decide which loader is generated.
            context.expectArgumentCount(call, 0, 0);
            if (context.featureReached("loader:gltf")) {
                context.fail(
                    call,
                    "enableBoneControl installs the pin's builder hook, so " +
                        "only a glTF loaded after it carries skeletons. Call " +
                        "it before the load it should build them for.",
                );
            }
            context.reachFeature("loader:gltf-bone-control", call);
            return { kind: "void", cpp: "" };
        }

        case "getBoneByName": {
            // The pin's `skeleton._byName.get(name)`: the first joint
            // carrying the name, in the skin's own joint order, and
            // `undefined` for a miss. The native read reports the miss as
            // an invalid handle, which is the shape every optional handle
            // in this port already takes — so the guards the scene writes
            // (`if`, `??`, a null comparison) answer through it.
            context.expectArgumentCount(call, 2, 2);
            const skeleton = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                skeleton,
                "skeleton",
                call.arguments[0]!,
            );
            const name = context.compileStringLiteral(
                call.arguments[1]!,
            );
            const bone =
                context.allocateTemporaryCppName("bone");
            context.emit(
                `const bbl::BoneHandle ${bone} = ` +
                    `bbl::get_bone_by_name(` +
                    `${context.requireEngine(skeleton, call)}, ` +
                    `${skeleton.cpp}, ${context.cppString(name)});`,
            );
            return {
                kind: "bone",
                cpp: bone,
                engineCpp: context.requireEngine(skeleton, call),
                optionalFoundCpp:
                    `${bone}.value != bbl::invalid_handle`,
            };
        }

        case "setBoneVisible": {
            // The pin's own two arms: hiding sets the hidden bit and
            // re-bakes, showing clears it, drops an override the clear
            // emptied, and re-bakes only when there was one to clear.
            context.expectArgumentCount(call, 3, 3);
            const skeleton = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                skeleton,
                "skeleton",
                call.arguments[0]!,
            );
            const bone = context.compileValue(
                call.arguments[1]!,
            );
            context.expectKind(bone, "bone", call.arguments[1]!);
            const visible = context.compileCondition(
                call.arguments[2]!,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::set_bone_visible(` +
                    `${context.requireEngine(skeleton, call)}, ` +
                    `${skeleton.cpp}, ${bone.cpp}, ${visible})`,
            };
        }

        // Every other member of the chunk is unreached and refuses by
        // name, so a scene reaching one is told which arm it needs rather
        // than getting the visibility one.
        case "setBonePosition":
        case "setBoneRotationQuaternion":
        case "setBoneScaling":
        case "setBonePoseDeferred":
        case "setBoneWorldPoseDeferred":
        case "bakeSkeleton":
        case "clearBoneOverride": {
            context.fail(
                call,
                `${importedName} is part of the bone-control chunk this ` +
                    "port has not lowered: the reached slice is " +
                    "`getBoneByName` plus `setBoneVisible`.",
            );
        }

        default:
            return undefined;
    }
}
