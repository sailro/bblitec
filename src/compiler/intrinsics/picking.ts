import { EmissionSet } from "../emission-transaction.js";
import type { LoweringServices } from "../lowering-services.js";
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import { dataTypesEqual, handleCppType, type DataType } from "../data-types.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    resolveConditionalOptions,
    validateObjectProperties,
} from "../option-helpers.js";
import { optionalPresentCpp, optionalValueCpp } from "../types.js";
import { isNullishLiteral, typeMayHoldNullish } from "../symbols.js";
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
            | "propertyName"
            | "emitDiscardedValue"
            | "bindings"
            | "dataLowerer"
            | "objectProperties"
            | "expectObjectLiteral"
            | "evaluationOrder"
            | "captureEmittedLines"
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
 * `pickAsync`'s `filter` and `ignore` options are read by the shared
 * candidate collector while it builds the list (`pickOptions`). `discard`
 * selects another pinned pipeline (`picking-advanced-pipeline.js`) and
 * refuses, and `enableDetailedPicking` adds a third attachment plus the
 * barycentric readback that `detailed-picking.js` owns.
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
                return call.arguments.length === 3
                    ? cpp
                    : context.bindings.pinValueToTemporary(
                          { kind: "number", cpp },
                          "pick_coordinate",
                      ).cpp;
            });
            const options =
                call.arguments.length === 4
                    ? pickOptions(context, argumentAt(call, 3))
                    : undefined;
            return {
                kind: "picking-info",
                dataType: { kind: "handle", handle: "picking-info" },
                cpp:
                    `bbl::gpu_pick(` +
                    `${context.requireEngine(picker, call)}, ` +
                    `${picker.cpp}, ${x}, ${y}` +
                    `${options === undefined ? "" : `, ${options}`})`,
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
 * `pickAsync`'s options literal as the native pick's `Engine::PickOptions`,
 * through its conditional spreads: `filter` is the predicate the shared
 * candidate collector asks per mesh, under which no pick source draws, as
 * `pickAsyncImpl` does, and `ignore` its entries (`pickIgnoreEntries`).
 * The pin's `debugLabel` only names a `console.trace` of the pick; a label
 * with effects is evaluated for them. `discard` selects the pin's advanced
 * pipeline and refuses. Members compile in source order, those ahead of a
 * spread before its condition. Undefined for options naming neither
 * `filter` nor `ignore`.
 */
function pickOptions(
    context: PickingIntrinsicContext,
    expression: ts.Expression,
): string | undefined {
    const options = context.unwrap(expression);
    if (!ts.isObjectLiteralExpression(options))
        return context.fail(
            expression,
            "pickAsync options are lowered from an object literal naming each option.",
        );
    const compileMember = (name: string, member: ts.Expression): string => {
        switch (name) {
            case "filter":
                return pickFilter(context, member);
            case "ignore":
                return pickIgnoreEntries(context, expression, member);
            case "discard":
                return context.fail(
                    member,
                    "pickAsync's `discard` rule is not lowered: its WGSL predicate and per-mesh storage select a pinned picking pipeline variant (`picking-advanced-pipeline.js`) composed from the rule.",
                );
            default:
                if (
                    context.evaluationOrder.writesStorage(member) ||
                    context.evaluationOrder.hasModuleEffects(member)
                )
                    context.emitDiscardedValue(context.compileValue(member));
                return "";
        }
    };
    const names = ["filter", "discard", "ignore", "debugLabel"];
    // Each option's value, in source order.
    const members = (properties: readonly ts.ObjectLiteralElementLike[]) => {
        const seen = new Set<string>();
        return properties.flatMap((property) => {
            const member = ts.isPropertyAssignment(property)
                ? property.initializer
                : ts.isShorthandPropertyAssignment(property)
                  ? property.name
                  : undefined;
            const name = member && context.propertyName(property.name!);
            if (!member || !name || !names.includes(name)) return [];
            if (seen.has(name))
                context.fail(
                    property,
                    `pickAsync options name '${name}' once.`,
                );
            seen.add(name);
            return [{ name, member }];
        });
    };
    const properties = context.objectProperties(options);
    const compiled = new Map<ts.Expression, string>();
    for (const { name, member } of members(
        properties.slice(
            0,
            Math.max(0, properties.findIndex(ts.isSpreadAssignment)),
        ),
    ))
        compiled.set(member, compileMember(name, member));
    let named = false;
    const resolved = resolveConditionalOptions(
        context,
        options,
        (literal, once) => {
            validateObjectProperties(
                context,
                literal,
                names,
                "pickAsync options are lowered from plain `filter`, `discard`, `ignore` and `debugLabel` members.",
            );
            const read: Record<string, string> = {};
            for (const { name, member } of members(
                context.objectProperties(literal),
            ))
                read[name] = once(member, () => compileMember(name, member));
            named ||=
                read["filter"] !== undefined || read["ignore"] !== undefined;
            return {
                filter: read["filter"] ?? "bbl::Engine::PickFilter{}",
                ignore:
                    read["ignore"] ?? "std::vector<bbl::Engine::PickIgnore>{}",
            };
        },
        [],
        compiled,
    );
    return named
        ? `bbl::Engine::PickOptions{${resolved["filter"]}, ${resolved["ignore"]}}`
        : undefined;
}

/** `filter` as an `Engine::PickFilter` over the scene's stored predicate. */
function pickFilter(
    context: PickingIntrinsicContext,
    filter: ts.Expression,
): string {
    // The pin reads `options?.filter ?? null`: a nullish one filters nothing.
    if (isNullishLiteral(context.checker, filter))
        return "bbl::Engine::PickFilter{}";
    const predicate = context.dataLowerer.compileForSink(filter, {
        kind: "function",
        parameters: [{ kind: "handle", handle: "mesh" }],
        result: { kind: "boolean" },
    });
    return `bbl::Engine::PickFilter([predicate = ${predicate}](bbl::MeshHandle mesh) { return static_cast<bool>(predicate(mesh)); })`;
}

/**
 * `ignore` as the native entries, in its order: the value is stored as the
 * pin's declared `PickIgnore | readonly PickIgnore[]`, so one entry is a
 * list of one, and each entry carries its mesh and the index and range
 * lanes it holds (`picking-ignore.ts`, `ignoredRange`).
 */
function pickIgnoreEntries(
    context: PickingIntrinsicContext,
    options: ts.Expression,
    ignore: ts.Expression,
): string {
    const refuse = (): never =>
        context.fail(
            ignore,
            "pickAsync's `ignore` is lowered as the pin's `PickIgnore | readonly PickIgnore[]`.",
        );
    const declared = context.checker.getContextualType(options);
    const member =
        declared &&
        context.checker.getPropertyOfType(
            context.checker.getNonNullableType(declared),
            "ignore",
        );
    if (!member) return refuse();
    const type = context.dataTypes.fromTsType(
        context.checker.getNonNullableType(
            context.checker.getTypeOfSymbol(member),
        ),
        ignore,
    );
    if (type?.kind !== "union" || type.members.length !== 2) return refuse();
    const list = type.members.findIndex((arm) => arm.kind === "vector");
    const entry = type.members[1 - list];
    if (
        list < 0 ||
        entry?.kind !== "struct" ||
        !dataTypesEqual(type.members[list]!, { kind: "vector", element: entry })
    )
        return refuse();
    // A member's present value: absent where its slot is empty.
    const read = (struct: string, owner: string, name: string) => {
        const field = context.dataTypes
            .structFields(struct, ignore)
            .find((candidate) => candidate.sourceName === name);
        if (
            !field ||
            field.type.kind === "tagged" ||
            field.type.kind === "json"
        )
            return refuse();
        const cpp = `${owner}${context.dataTypes.memberAccess(struct)}${field.name}`;
        const optional =
            field.type.kind === "optional" ? field.type : undefined;
        return {
            present: context.dataTypes.slotPresentCpp(field.type, cpp),
            cpp: optional ? optionalValueCpp(cpp) : cpp,
            type: optional?.inner ?? field.type,
        };
    };
    const number = (field: ReturnType<typeof read>): string =>
        field.type.kind === "number" ? field.cpp : refuse();
    const lane = (
        field: ReturnType<typeof read>,
        cppType: string,
        cpp: string,
    ): string =>
        `${field.present ?? "true"} ? std::optional<${cppType}>{${cppType}{${cpp}}} : std::nullopt`;
    const field = read(entry.name, "ignore", "mesh");
    const mesh = context.dataLowerer.leafValue(field.cpp, field.type);
    if (field.present !== undefined || mesh.kind !== "mesh") return refuse();
    const index = read(entry.name, "ignore", "thinInstanceIndex");
    const range = read(entry.name, "ignore", "thinInstanceRange");
    const lanes = range.type.kind === "struct" ? range.type.name : refuse();
    const [start, count] = ["start", "count"].map((name) =>
        number(read(lanes, range.cpp, name)),
    );
    // An undefined `ignore` is none (`pickAsyncImpl`: `if (ignored)`).
    const absent = typeMayHoldNullish(context.checker, ignore, "undefined");
    const value = context.dataLowerer.compileForSink(
        ignore,
        absent ? { kind: "optional", inner: type } : type,
    );
    return (
        `[&] { std::vector<bbl::Engine::PickIgnore> entries; ` +
        `const auto entry = [&entries](const auto& ignore) { entries.push_back({${mesh.cpp}, ` +
        `${lane(index, "double", number(index))}, ` +
        `${lane(range, "std::array<double, 2>", `${start}, ${count}`)}}); }; ` +
        (absent
            ? `const auto& held = ${value}; if (!${optionalPresentCpp("held")}) return entries; const auto& ignored = ${optionalValueCpp("held")}; `
            : `const auto& ignored = ${value}; `) +
        `if (ignored.index() == ${list}) { for (const auto& each : std::get<${list}>(ignored)) entry(each); } ` +
        `else entry(std::get<${1 - list}>(ignored)); ` +
        `return entries; }()`
    );
}
