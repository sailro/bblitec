import ts from "typescript";
import type { DataTypeRegistry } from "../data-types.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    compileNullableHitRecord,
    numberField,
    type HitRecordContext,
} from "./hit-record.js";

export interface PickingIntrinsicContext
    extends IntrinsicCallContext, HitRecordContext {
    readonly dataTypes: DataTypeRegistry;
    readonly checker: ts.TypeChecker;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    requireEngine(value: Value, node: ts.Node): string;
    requireDefaultEngine(node: ts.Node): string;
    compileCondition(expression: ts.Expression): string;
    fail(node: ts.Node, message: string): never;
}

/**
 * GPU picking, at the slice scene 129 reaches.
 *
 * The pin renders the scene into a ONE-PIXEL target through a view
 * projection sheared so the sampled point lands on that pixel
 * (`computePickVP`), writes each candidate's id as a colour and its depth
 * to a second attachment, and reads both back. Nothing about it is a ray
 * cast, which is why the answer is the renderer's rather than the scene
 * graph's -- a splat cloud has no triangles to intersect and still picks.
 *
 * The picker is a handle rather than a value because it owns GPU
 * resources: the two 1x1 attachments, the depth buffer and the two staging
 * buffers the readback maps. `disposePicker` releases them, and a build
 * that never disposes still frees them with the renderer.
 *
 * What refuses here is everything the reached slice does not name: the
 * `filter`, `discard` and `ignore` options each select a different pinned
 * pipeline (`picking-advanced-pipeline.js`, `picking-ignore.js`), and
 * `enableDetailedPicking` adds a third attachment plus the barycentric
 * readback that `detailed-picking.js` owns. Each is its own contract, and
 * composing one from this one would be guessing.
 */
export function compilePickingIntrinsic(
    context: PickingIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createGpuPicker": {
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            context.reachFeature("picking:gpu", call);
            return {
                kind: "gpu-picker",
                cpp: `bbl::create_gpu_picker(${scene.cpp})`,
                engineCpp: scene.engineCpp ?? scene.cpp,
            };
        }

        // Upstream this is a promise because the readback maps a buffer;
        // here the readback is a wait on submitted work, so the value is
        // ready when the call returns and the `await` resolves immediately
        // -- the same shape every materialized asset takes.
        case "pickAsync": {
            context.expectArgumentCount(call, 3, 4);
            if (call.arguments.length === 4) {
                context.fail(
                    call.arguments[3]!,
                    "pickAsync options are not lowered: `filter`, " +
                        "`discard` and `ignore` each select a different " +
                        "pinned picking pipeline, and the reached slice " +
                        "passes none.",
                );
            }
            const picker = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                picker,
                "gpu-picker",
                call.arguments[0]!,
            );
            return {
                kind: "picking-info",
                cpp:
                    `bbl::gpu_pick(` +
                    `${context.requireEngine(picker, call)}, ` +
                    `${picker.cpp}, ` +
                    `${context.compileNumber(call.arguments[1]!, "double")}, ` +
                    `${context.compileNumber(call.arguments[2]!, "double")})`,
                ...(picker.engineCpp === undefined
                    ? {}
                    : { engineCpp: picker.engineCpp }),
            };
        }

        case "disposePicker": {
            context.expectArgumentCount(call, 1, 1);
            const picker = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                picker,
                "gpu-picker",
                call.arguments[0]!,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::dispose_picker(` +
                    `${context.requireEngine(picker, call)}, ` +
                    `${picker.cpp})`,
            };
        }

        // src/sprite/picking/pick-billboard.ts: a thin wrapper over the
        // same `pickAsync` pass, which is the whole point of the pin's
        // contributor seam -- the picker draws meshes, then walks
        // `scene._pickSources` and lets each entity's own module draw its
        // ids into the SAME one-pixel target against the SAME depth
        // buffer, so a billboard behind a wall loses. What the wrapper
        // adds is one read: the billboard contributor's `resolve` hangs
        // `_spritePick` on the info, and this returns that or null.
        case "pickBillboardSprite": {
            context.expectArgumentCount(call, 3, 4);
            if (call.arguments.length === 4) {
                context.fail(
                    call.arguments[3]!,
                    "pickBillboardSprite's optional picker is the pin's " +
                        "own reuse path for high-frequency picking; the " +
                        "reached slice passes none, and the default arm " +
                        "creates and disposes one per call as upstream " +
                        "does.",
                );
            }
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            const engine = context.requireEngine(scene, call);
            const promised = context.checker.getTypeAtLocation(call);
            context.reachFeature("picking:gpu", call);
            context.reachFeature("picking:billboard", call);
            return {
                ...compileNullableHitRecord(context, call, {
                    intrinsic: "pickBillboardSprite",
                    resultType:
                        context.dataTypes.fromTsType(
                            context.checker.getAwaitedType(promised) ??
                                promised,
                            call,
                        ),
                    // The pin's own four members. `pickedPoint` and
                    // `distance` are the shared readback's -- the picker
                    // reconstructs both before it hands the info to a
                    // contributor -- and the contributor's `resolve` adds
                    // the two that identify the sprite.
                    fields: {
                        system: {
                            cpp: "bbl::BillboardSystemHandle{info.picked_index}",
                            accepts: (type) =>
                                type.kind === "handle" &&
                                type.handle === "billboard-system",
                        },
                        spriteIndex: {
                            cpp: "static_cast<double>(info.picked_range_offset)",
                            accepts: numberField,
                        },
                        pickedPoint: {
                            cpp: "bbl::picked_point(info)",
                            accepts: (type) =>
                                type.kind === "optional" &&
                                type.inner.kind === "tuple" &&
                                type.inner.arity === 3,
                        },
                        distance: {
                            cpp: `bbl::picked_distance(${scene.cpp}, info)`,
                            accepts: numberField,
                        },
                    },
                    probe:
                        `const bbl::PickingInfo info = ` +
                        `bbl::pick_billboard_sprite(${engine}, ` +
                        `${scene.cpp}, ` +
                        `${context.compileNumber(call.arguments[1]!, "double")}, ` +
                        `${context.compileNumber(call.arguments[2]!, "double")});`,
                    miss:
                        "info.picked_kind != " +
                        "bbl::PickedNodeKind::billboard_sprite",
                }),
                engineCpp: engine,
            };
        }

        // The pin's own opt-in for the detailed pipeline: a picker armed
        // here draws a third `rgba32uint` attachment carrying the winning
        // `@builtin(primitive_index)` and the interpolated rest position,
        // and every later `pickAsync` on it runs the CPU solve over that
        // readback. `detailed-picking.ts` imports `normalizeVec3` and
        // reads `mesh._cpuPositions`/`_cpuNormals`/`_cpuIndices`, so
        // reaching it reaches those two features exactly as the pin's own
        // module graph does.
        case "enableDetailedPicking": {
            context.expectArgumentCount(call, 1, 1);
            const picker = context.compileValue(call.arguments[0]!);
            context.expectKind(picker, "gpu-picker", call.arguments[0]!);
            context.reachFeature("picking:detailed", call);
            context.reachFeature("math:normalize-vec3", call);
            context.reachFeature("mesh:geometry-access", call);
            return {
                kind: "void",
                cpp:
                    `bbl::enable_detailed_picking(` +
                    `${context.requireEngine(picker, call)}, ` +
                    `${picker.cpp})`,
            };
        }

        // `picking-helpers.ts`. The second argument selects the world
        // normal over the local one; the pin defaults it to false and the
        // emitted signature carries that same default, so an omitted one
        // is the pin's own answer rather than this port's.
        case "getPickedNormal": {
            context.expectArgumentCount(call, 1, 2);
            // The same three the arming call reaches. `picking-helpers.ts`
            // imports `normalizeVec3` and reads the mesh's CPU normals and
            // indices, and the emitted body is the detailed half's -- so a
            // scene that reads a normal without arming a detailed pick
            // would otherwise generate clean and fail at link.
            context.reachFeature("picking:detailed", call);
            context.reachFeature("math:normalize-vec3", call);
            context.reachFeature("mesh:geometry-access", call);
            const info = context.compileValue(call.arguments[0]!);
            context.expectKind(info, "picking-info", call.arguments[0]!);
            // The engine the pick's own value carries, or the scene's
            // only one: upstream reads the mesh through a live node
            // reference, so an info that crossed a function boundary --
            // which is exactly how scene 113 hands its result to a
            // placement helper -- still has to reach the collections the
            // handle indexes.
            const engine =
                info.engineCpp ?? context.requireDefaultEngine(call);
            return {
                kind: "data",
                cpp:
                    `bbl::picked_normal(${engine}, ${info.cpp}, ` +
                    `${
                        call.arguments.length === 2
                            ? context.compileCondition(call.arguments[1]!)
                            : "false"
                    })`,
                dataType: {
                    kind: "optional",
                    inner: { kind: "tuple", arity: 3 },
                },
                // The helper builds its nullable rather than aliasing a
                // record field, so a `const` bound to it owns a copy
                // instead of referencing the returned temporary.
                freshData: true,
            };
        }

        default:
            return undefined;
    }
}
