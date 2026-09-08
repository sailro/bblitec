import ts from "typescript";
import { handleCppType, type DataType } from "../data-types.js";
import type { Value } from "../types.js";
import { handleFoundCpp } from "../properties.js";
import type { IntrinsicCallContext } from "./context.js";

export interface SkeletonIntrinsicContext
    extends IntrinsicCallContext {
    allocateTemporaryCppName(label: string): string;
    emit(line: string): void;
    cppString(value: string): string;
    compileStringLiteral(expression: ts.Expression): string;
    compileCondition(expression: ts.Expression): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    // The typed-array sink in its general form rather than the mesh
    // family's `compileTypedArrayArgument`, whose kind union does not
    // carry the u16 joint stream `createSkeleton` takes.
    compileForDataSink(
        expression: ts.Expression,
        dataType: DataType,
    ): string;
    requireEngine(value: Value, node: ts.Node): string;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    gltfAlreadyLoaded(): boolean;
    fail(node: ts.Node, message: string): never;
}

/**
 * The bone palette, read WITHOUT marking the caller's array escaped.
 *
 * The pin does not copy this one: `createSkeleton` publishes it as
 * `skeleton.boneMatrices`, and `updateSkeletonBoneMatrices` uploads that
 * same array. So a scene that keeps writing into it -- corpus scene 231
 * rewrites its pose in place every frame -- is doing what upstream
 * expects, and the ordinary typed-array sink's escape rule (which exists
 * for a stream genuinely consumed into another data location, as the
 * joint and weight streams are) would refuse it.
 *
 * The native side snapshots the palette at each call instead of aliasing
 * the caller's array. That is invisible to the reached slice, because the
 * pin uploads at exactly those two calls too: a write with no update
 * reaches no GPU either way. The one place the two would differ is an
 * update handed a DIFFERENT array of the same length, which upstream also
 * writes back into the array `createSkeleton` was given; nothing reads a
 * skeleton's palette back through this port, so there is nothing here to
 * observe it with.
 */
function bonePaletteArgument(
    context: SkeletonIntrinsicContext,
    expression: ts.Expression,
    label: string,
): string {
    const value = context.compileValue(expression);
    if (
        value.kind !== "data" ||
        value.dataType?.kind !== "f32array"
    ) {
        context.fail(
            expression,
            `${label} takes the Float32Array of bone matrices ` +
                "createSkeleton was given, 16 floats per bone.",
        );
    }
    return value.cpp;
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
 * builder hook, and only a `loadGltf` *after* it produces skeletons. One
 * generated loader serves every load here, so an asset loaded before the
 * enable would get skeletons this port cannot withhold from it — the
 * order refuses rather than building them quietly.
 */
export function compileSkeletonIntrinsic(
    context: SkeletonIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createSkeleton": {
            // The pin's own resource factory: the per-vertex joint and
            // weight streams plus the initial bone palette, uploaded as
            // one rgba32float row. The two optional 8-bone streams are
            // the pin's JOINTS_1/WEIGHTS_1 arm, which composes a second
            // pair of vertex attributes and a longer skinning sum -- a
            // different composed variant, not a wider argument list -- so
            // passing them refuses by name.
            context.expectArgumentCount(call, 5, 5);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const joints = context.compileForDataSink(
                call.arguments[1]!,
                { kind: "u16array" },
            );
            const weights = context.compileForDataSink(
                call.arguments[2]!,
                { kind: "f32array" },
            );
            const boneCount = context.compileNumber(
                call.arguments[3]!,
                "double",
            );
            const boneData = bonePaletteArgument(
                context,
                call.arguments[4]!,
                "createSkeleton",
            );
            const engineCpp = engine.engineCpp ?? engine.cpp;
            const skeleton =
                context.allocateTemporaryCppName("skeleton");
            context.emit(
                `const ${handleCppType("scene-skeleton")} ${skeleton} = ` +
                    `bbl::create_scene_skeleton(${engineCpp}, ` +
                    `${joints}, ${weights}, ${boneCount}, ${boneData});`,
            );
            context.reachFeature("mesh:skeleton", call);
            return {
                kind: "scene-skeleton",
                cpp: skeleton,
                engineCpp,
            };
        }

        case "updateSkeletonBoneMatrices": {
            // The live half. The pose is read at the call, never folded
            // at creation: scene 231 rewrites the same array every frame
            // and hands it back, which is exactly what the pin's own
            // mirror-then-upload does.
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const skeleton = context.compileValue(call.arguments[1]!);
            context.expectKind(
                skeleton,
                "scene-skeleton",
                call.arguments[1]!,
            );
            if (
                skeleton.engineCpp !==
                (engine.engineCpp ?? engine.cpp)
            ) {
                context.fail(
                    call,
                    "A skeleton and the engine updating it must be the " +
                        "same engine.",
                );
            }
            const boneData = bonePaletteArgument(
                context,
                call.arguments[2]!,
                "updateSkeletonBoneMatrices",
            );
            context.reachFeature("mesh:skeleton", call);
            return {
                kind: "void",
                cpp:
                    `bbl::update_scene_skeleton_bone_matrices(` +
                    `${context.requireEngine(skeleton, call)}, ` +
                    `${skeleton.cpp}, ${boneData})`,
            };
        }

        case "enableBoneControl": {
            // `_installBoneControl(buildSkeletons, applyOverridesToTRS)` —
            // the call creates nothing, so it emits no statement; what it
            // does is decide which loader is generated.
            context.expectArgumentCount(call, 0, 0);
            if (context.gltfAlreadyLoaded()) {
                context.fail(
                    call,
                    "enableBoneControl installs the pin's builder hook, so " +
                        "only a glTF loaded after it carries skeletons. This " +
                        "port emits one loader for every load and cannot give " +
                        "two assets different builders, so call it before the " +
                        "first load.",
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
            const engine = context.requireEngine(skeleton, call);
            const bone =
                context.allocateTemporaryCppName("bone");
            context.emit(
                `const ${handleCppType("bone")} ${bone} = ` +
                    `bbl::get_bone_by_name(` +
                    `${engine}, ` +
                    `${skeleton.cpp}, ${context.cppString(name)});`,
            );
            return {
                kind: "bone",
                cpp: bone,
                engineCpp: engine,
                optionalFoundCpp: handleFoundCpp(bone),
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
            context.expectSameEngine(skeleton, bone, call);
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
