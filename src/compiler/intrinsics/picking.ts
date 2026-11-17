import { EmissionSet } from "../emission-transaction.js";
import type { LoweringServices } from "../lowering-services.js";
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import { handleCppType, type DataType } from "../data-types.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { validateObjectProperties } from "../option-helpers.js";
import {
    compileNullableHitRecord,
    numberField,
    type HitRecordContext,
} from "./hit-record.js";

/** Readback and picker retirement change native state only; repeated calls do
 * not allocate a generation-owned composition row. */
export const runtimeOnlyPickingIntrinsics: ReadonlySet<string> =
    new EmissionSet(["pickAsync", "disposePicker", "getPickedNormal"]);

export interface PickingIntrinsicContext
    extends
        IntrinsicCallContext,
        HitRecordContext,
        Pick<
            LoweringServices,
            | "dataTypes"
            | "checker"
            | "compileNumber"
            | "compileTypedArrayArgument"
            | "allocateTemporaryCppName"
            | "reachJsData"
            | "requireEngine"
            | "conditions"
            | "fail"
            | "unwrap"
            | "objectProperty"
            | "propertyName"
            | "compileStoredDataFunction"
            | "emitDiscardedValue"
            | "emit"
        > {}

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
 * `pickAsync`'s `filter` option is the scene's predicate over meshes,
 * which the shared candidate collector calls per mesh (`pickOptionsFilter`).
 * `discard` and `ignore` select another pinned pipeline
 * (`picking-advanced-pipeline.js`, `picking-ignore.js`) and refuse, and
 * `enableDetailedPicking` adds a third attachment plus the barycentric
 * readback that `detailed-picking.js` owns.
 */
export function compilePickingIntrinsic(
    context: PickingIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createPickingRay": {
            context.expectArgumentCount(call, 5, 5);
            context.reachJsData();
            context.reachFeature("picking:ray", call);
            // The call reads the matrix and keeps none of it, so that
            // argument binds where its value already lives.
            const argumentsCpp = call.arguments.map((argument, index) =>
                index === 2
                    ? context.compileTypedArrayArgument(argument, "f32array")
                    : context.compileNumber(argument, "double"),
            );
            const names = argumentsCpp.map(() =>
                context.allocateTemporaryCppName("ray_argument"),
            );
            const ray = context.allocateTemporaryCppName("ray");
            const tupleField = (member: "origin" | "direction") => ({
                cpp: `bbl::js::Tuple<3>{${ray}->${member}}`,
                accepts: (type: DataType) =>
                    type.kind === "tuple" && type.arity === 3,
            });
            return compileNullableHitRecord(context, call, {
                intrinsic: importedName,
                resultType: context.dataTypes.fromTsType(
                    context.checker.getTypeAtLocation(call),
                    call,
                ),
                fields: {
                    origin: tupleField("origin"),
                    direction: tupleField("direction"),
                    length: { cpp: `${ray}->length`, accepts: numberField },
                },
                probe:
                    argumentsCpp
                        .map(
                            (cpp, index) =>
                                `const auto${index === 2 ? "&" : ""} ${names[index]} = ${cpp};`,
                        )
                        .join(" ") +
                    ` const auto ${ray} = bbl::upstream::picking_ray::create_picking_ray_array(${names.join(", ")});`,
                miss: `!${ray}`,
            });
        }
        case "createGpuPicker": {
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(argumentAt(call, 0));
            context.expectKind(scene, "scene", argumentAt(call, 0));
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
            const picker = context.compileValue(argumentAt(call, 0));
            context.expectKind(picker, "gpu-picker", argumentAt(call, 0));
            // The coordinates are read before the options literal runs.
            const [x, y] = [1, 2].map((index) => {
                const cpp = context.compileNumber(
                    argumentAt(call, index),
                    "double",
                );
                if (call.arguments.length === 3) return cpp;
                const name =
                    context.allocateTemporaryCppName("pick_coordinate");
                context.emit({
                    kind: "declaration",
                    type: "const double",
                    name,
                    initializer: cpp,
                });
                return name;
            });
            const filter =
                call.arguments.length === 4
                    ? pickOptionsFilter(context, argumentAt(call, 3))
                    : undefined;
            return {
                kind: "picking-info",
                dataType: { kind: "handle", handle: "picking-info" },
                cpp:
                    `bbl::gpu_pick(` +
                    `${context.requireEngine(picker, call)}, ` +
                    `${picker.cpp}, ${x}, ${y}` +
                    `${filter === undefined ? "" : `, ${filter}`})`,
                ...(picker.engineCpp === undefined
                    ? {}
                    : {
                          engineCpp: picker.engineCpp,
                          pickingEngineKnown: true as const,
                      }),
            };
        }

        case "disposePicker": {
            context.expectArgumentCount(call, 1, 1);
            const picker = context.compileValue(argumentAt(call, 0));
            context.expectKind(picker, "gpu-picker", argumentAt(call, 0));
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
                    argumentAt(call, 3),
                    "pickBillboardSprite's optional picker is the pin's " +
                        "own reuse path for high-frequency picking; the " +
                        "reached slice passes none, and the default arm " +
                        "creates and disposes one per call as upstream " +
                        "does.",
                );
            }
            const scene = context.compileValue(argumentAt(call, 0));
            context.expectKind(scene, "scene", argumentAt(call, 0));
            const engine = context.requireEngine(scene, call);
            const promised = context.checker.getTypeAtLocation(call);
            context.reachFeature("picking:gpu", call);
            context.reachFeature("picking:billboard", call);
            return {
                ...compileNullableHitRecord(context, call, {
                    intrinsic: "pickBillboardSprite",
                    resultType: context.dataTypes.fromTsType(
                        context.checker.getAwaitedType(promised) ?? promised,
                        call,
                    ),
                    // The pin's own four members. `pickedPoint` and
                    // `distance` are the shared readback's -- the picker
                    // reconstructs both before it hands the info to a
                    // contributor -- and the contributor's `resolve` adds
                    // the two that identify the sprite.
                    fields: {
                        system: {
                            cpp: `${handleCppType("billboard-system")}{info.picked_index}`,
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
                        `${context.compileNumber(argumentAt(call, 1), "double")}, ` +
                        `${context.compileNumber(argumentAt(call, 2), "double")});`,
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
            const picker = context.compileValue(argumentAt(call, 0));
            context.expectKind(picker, "gpu-picker", argumentAt(call, 0));
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
            const info = context.compileValue(argumentAt(call, 0));
            context.expectKind(info, "picking-info", argumentAt(call, 0));
            return {
                kind: "data",
                cpp:
                    `bbl::picked_normal(${info.cpp}, ` +
                    `${
                        call.arguments.length === 2
                            ? context.conditions.compileCondition(
                                  argumentAt(call, 1),
                              )
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

/**
 * `pickAsync`'s options literal: its `filter` as the native pick's
 * `Engine::PickFilter`, which the shared candidate collector asks per mesh
 * and under which no pick source draws, as `pickAsyncImpl` does. The pin's
 * `debugLabel` only names a `console.trace` of the pick; the label is
 * evaluated for its effects. `discard` and `ignore` select the pin's
 * advanced pipeline and refuse.
 */
function pickOptionsFilter(
    context: PickingIntrinsicContext,
    expression: ts.Expression,
): string | undefined {
    const options = context.unwrap(expression);
    if (!ts.isObjectLiteralExpression(options))
        return context.fail(
            expression,
            "pickAsync options are lowered from an object literal naming each option.",
        );
    validateObjectProperties(
        context,
        options,
        ["filter", "discard", "ignore", "debugLabel"],
        "pickAsync options are lowered from plain `filter`, `discard`, `ignore` and `debugLabel` members.",
    );
    for (const [name, refusal] of [
        [
            "discard",
            "pickAsync's `discard` rule is not lowered: its WGSL predicate and per-mesh storage select a pinned picking pipeline variant (`picking-advanced-pipeline.js`) composed from the rule.",
        ],
        [
            "ignore",
            "pickAsync's `ignore` option is not lowered: its mesh and thin-instance exclusions select the pin's advanced picking pipeline (`picking-ignore.js`).",
        ],
    ] as const) {
        const value = context.objectProperty(options, name);
        if (value) context.fail(value, refusal);
    }
    const label = context.objectProperty(options, "debugLabel");
    if (label) context.emitDiscardedValue(context.compileValue(label));
    const filter = context.objectProperty(options, "filter");
    if (!filter) return undefined;
    const callback = context.unwrap(filter);
    if (
        !ts.isIdentifier(callback) &&
        !ts.isArrowFunction(callback) &&
        !ts.isFunctionExpression(callback)
    )
        return context.fail(
            filter,
            "pickAsync's `filter` is lowered from a function or a name holding one.",
        );
    const predicate = context.compileStoredDataFunction(callback, {
        kind: "function",
        parameters: [{ kind: "handle", handle: "mesh" }],
        result: { kind: "boolean" },
    });
    return `bbl::Engine::PickFilter([predicate = ${predicate}](bbl::MeshHandle mesh) { return static_cast<bool>(predicate(mesh)); })`;
}
