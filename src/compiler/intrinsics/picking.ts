import { EmissionSet } from "../emission-transaction.js";
import type { LoweringServices } from "../lowering-services.js";
import ts from "typescript";
import {
    argumentAt,
    conditionalExpression,
    selectionArms,
    variableKind,
} from "../syntax.js";
import { knownCondition, staticBooleanOf } from "../values/model.js";
import { dataTypesEqual, handleCppType, type DataType } from "../data-types.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    resolveConditionalOptions,
    validateObjectProperties,
} from "../option-helpers.js";
import {
    optionalPresentCpp,
    optionalValueCpp,
    type PickDiscardRuleManifest,
} from "../types.js";
import { CompileError } from "../compile-error.js";
import {
    isNullishLiteral,
    resolvedSymbol,
    typeMayHoldNullish,
} from "../symbols.js";
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
            | "objectProperty"
            | "expectObjectLiteral"
            | "evaluationOrder"
            | "captureEmittedLines"
            | "evaluator"
            | "compileStaticString"
            | "probeEmission"
            | "runModelCall"
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
 * candidate collector while it builds the list (`pickOptions`); a `discard`
 * rule draws the meshes its storage admits through the pinned shaders
 * generation composes from it (`pickDiscard`). `enableDetailedPicking`
 * adds a third attachment plus the barycentric readback that
 * `detailed-picking.js` owns.
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
                            cpp: "info.distance",
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
 * `pickAsyncImpl` does, `ignore` its entries (`pickIgnoreEntries`) and
 * `discard` its rule (`pickDiscard`). The pin's `debugLabel` only names a
 * `console.trace` of the pick; a label with effects is evaluated for them.
 * Members compile in source order, those ahead of a spread before its
 * condition. Undefined for options naming none of the three.
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
                return pickDiscard(context, expression, member);
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
                read["filter"] !== undefined ||
                read["ignore"] !== undefined ||
                read["discard"] !== undefined;
            return {
                filter: read["filter"] ?? "bbl::Engine::PickFilter{}",
                ignore:
                    read["ignore"] ?? "std::vector<bbl::Engine::PickIgnore>{}",
                discard:
                    read["discard"] ??
                    "std::optional<bbl::Engine::PickDiscard>{}",
            };
        },
        [],
        compiled,
    );
    return named
        ? `bbl::Engine::PickOptions{${resolved["filter"]}, ${resolved["ignore"]}, ${resolved["discard"]}}`
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
    const type = pickOptionType(context, options, "ignore", ignore);
    if (type?.kind !== "union" || type.members.length !== 2) return refuse();
    const list = type.members.findIndex((arm) => arm.kind === "vector");
    const entry = type.members[1 - list];
    if (
        list < 0 ||
        entry?.kind !== "struct" ||
        !dataTypesEqual(type.members[list]!, { kind: "vector", element: entry })
    )
        return refuse();
    const read = (struct: string, owner: string, name: string): HeldSlot =>
        structMember(context, struct, owner, name, ignore) ?? refuse();
    const number = (field: HeldSlot): string =>
        field.type.kind === "number" ? field.cpp : refuse();
    const lane = (field: HeldSlot, cppType: string, cpp: string): string =>
        `${field.present} ? std::optional<${cppType}>{${cppType}{${cpp}}} : std::nullopt`;
    const field = read(entry.name, "ignore", "mesh");
    const mesh = context.dataLowerer.leafValue(field.cpp, field.type);
    // Every entry names its mesh: no slot of it can be empty.
    if (knownCondition(field.present) !== true || mesh.kind !== "mesh")
        return refuse();
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

/**
 * `discard` as the native rule (`Engine::PickDiscard`): the members the
 * pin's pipeline cache keys on (`ruleKey`) and each storage entry's `data`,
 * asked per mesh in declaration order (`createPickDiscardBindGroup`). Each
 * rule the value can hold is recorded for generation, which composes its
 * shaders (`foldPickDiscardRules`); the native pick draws through the
 * composed rule its key names.
 */
function pickDiscard(
    context: PickingIntrinsicContext,
    options: ts.Expression,
    discard: ts.Expression,
): string {
    // The pin reads `options?.discard ?? null`: a nullish rule discards nothing.
    if (isNullishLiteral(context.checker, discard))
        return "std::optional<bbl::Engine::PickDiscard>{}";
    const refuse = (): never =>
        context.fail(
            discard,
            "pickAsync's `discard` is lowered as the pin's `PickDiscardRule`.",
        );
    const type = pickOptionType(context, options, "discard", discard);
    if (type?.kind !== "struct") return refuse();
    for (const rule of foldPickDiscardRules(context, discard))
        context.sceneManifest.recordPickDiscardRule(rule, discard);
    const read = (struct: string, owner: string, name: string): HeldSlot =>
        structMember(context, struct, owner, name, discard) ?? refuse();
    const text = (owner: string, struct: string, name: string) => {
        const member = read(struct, owner, name);
        return member.type.kind === "string" ? member : refuse();
    };
    const key = text("rule", type.name, "key");
    const wgsl = text("rule", type.name, "wgsl");
    const worldAdjust = text("rule", type.name, "worldAdjustWgsl");
    const vertexData = read(type.name, "rule", "vertexData");
    const storage = read(type.name, "rule", "storage");
    if (
        vertexData.type.kind !== "enum" ||
        storage.type.kind !== "vector" ||
        storage.type.element.kind !== "struct"
    )
        return refuse();
    const entry = storage.type.element.name;
    const name = text("entry", entry, "name");
    const binding = text("entry", entry, "type");
    const vertex = read(entry, "entry", "vertex");
    const data = read(entry, "entry", "data");
    if (
        vertex.type.kind !== "boolean" ||
        data.type.kind !== "function" ||
        !data.type.result
    )
        return refuse();
    const view = heldSlot(context, "result", data.type.result);
    if (view.type.kind !== "bufferview") return refuse();
    // An undefined rule is none (`pickAsyncImpl`: `options?.discard ?? null`).
    const absent = typeMayHoldNullish(context.checker, discard, "undefined");
    const value = context.dataLowerer.compileForSink(
        discard,
        absent ? { kind: "optional", inner: type } : type,
    );
    return (
        `[&] { std::optional<bbl::Engine::PickDiscard> discard; ` +
        (absent
            ? `const auto& held = ${value}; if (!${optionalPresentCpp("held")}) return discard; const auto& rule = ${optionalValueCpp("held")}; `
            : `const auto& rule = ${value}; `) +
        `auto& native = discard.emplace(); native.key = ${key.cpp}; native.wgsl = ${wgsl.cpp}; ` +
        `if (${worldAdjust.present}) native.world_adjust_wgsl = ${worldAdjust.cpp}; ` +
        `if (${vertexData.present}) native.vertex_data = ${context.dataTypes.enumToStringCpp(vertexData.type, vertexData.cpp, discard)}; ` +
        `if (${storage.present}) for (const auto& entry : ${storage.cpp}) native.storage.push_back({${name.cpp}, ${binding.cpp}, ${vertex.present} && ${vertex.cpp}, ` +
        `[data = ${data.cpp}](bbl::MeshHandle mesh) -> std::optional<std::vector<std::uint8_t>> { ` +
        `const auto result = data(mesh); if (!(${view.present})) return std::nullopt; ` +
        `const auto bytes = bbl::storage_buffer_bytes(${view.cpp}); ` +
        `return std::vector<std::uint8_t>(bytes.begin(), bytes.end()); }}); ` +
        `return discard; }()`
    );
}

/** The data type the pin declares for `pickAsync`'s option `name`, past its absence. */
function pickOptionType(
    context: PickingIntrinsicContext,
    options: ts.Expression,
    name: string,
    node: ts.Expression,
): DataType | undefined {
    const declared = context.checker.getContextualType(options);
    const member =
        declared &&
        context.checker.getPropertyOfType(
            context.checker.getNonNullableType(declared),
            name,
        );
    return (
        member &&
        context.dataTypes.fromTsType(
            context.checker.getNonNullableType(
                context.checker.getTypeOfSymbol(member),
            ),
            node,
        )
    );
}

/**
 * A value's storage and the test that it holds one (`slotPresentCpp` of
 * each slot it is stored in): `true` where no slot of it can be empty.
 */
interface HeldSlot {
    readonly present: string;
    readonly cpp: string;
    readonly type: DataType;
}

/** The slot `cpp` of `slot` type, through each optional and tagged slot it is stored in. */
function heldSlot(
    context: PickingIntrinsicContext,
    cpp: string,
    slot: DataType,
): HeldSlot {
    const present: string[] = [];
    let type = slot;
    for (;;) {
        const test = context.dataTypes.slotPresentCpp(type, cpp);
        if (test) present.push(test);
        if (type.kind === "tagged") {
            cpp = `${cpp}.value()`;
            type = type.inner;
        } else if (type.kind === "optional") {
            cpp = optionalValueCpp(cpp);
            type = type.inner;
        } else return { present: present.join(" && ") || "true", cpp, type };
    }
}

/** Member `name` of the struct `owner` holds (`heldSlot`); undefined where it has none. */
function structMember(
    context: PickingIntrinsicContext,
    struct: string,
    owner: string,
    name: string,
    node: ts.Node,
): HeldSlot | undefined {
    const field = context.dataTypes
        .structFields(struct, node)
        .find((candidate) => candidate.sourceName === name);
    return (
        field &&
        heldSlot(
            context,
            `${owner}${context.dataTypes.memberAccess(struct)}${field.name}`,
            field.type,
        )
    );
}

/**
 * The generation-known members of every rule `expression` can hold: each
 * arm of a conditional; an object literal through the constants and calls
 * that resolve to it (`resolveStaticLiteral`), its spreads in order; or
 * what a model run of the application call building it settles with
 * (`modelPickDiscardRule`). The key and the WGSL the pin splices fold to
 * their text; each storage entry's `data` is the run-time half and is not
 * read here.
 */
function foldPickDiscardRules(
    context: PickingIntrinsicContext,
    expression: ts.Expression,
): PickDiscardRuleManifest[] {
    const node = context.unwrap(expression);
    if (isNullishLiteral(context.checker, node)) return [];
    const selection = conditionalExpression(node);
    if (selection)
        return selectionArms(selection).flatMap((arm) =>
            foldPickDiscardRules(context, arm),
        );
    const resolved = ruleLiteral(context, node);
    return [
        ts.isCallExpression(resolved)
            ? modelPickDiscardRule(context, resolved)
            : literalPickDiscardRule(context, resolved),
    ];
}

/** A rule's members, as the manifest records them; refuses what is not lowered. */
function pickDiscardRuleRow(
    context: PickingIntrinsicContext,
    node: ts.Node,
    members: {
        key: string | undefined;
        wgsl: string | undefined;
        worldAdjustWgsl: string | undefined;
        vertexData: string | undefined;
        storage: PickDiscardRuleManifest["storage"];
    },
): PickDiscardRuleManifest {
    const { key, wgsl, worldAdjustWgsl, vertexData, storage } = members;
    if (key === undefined || wgsl === undefined)
        return context.fail(
            node,
            "A pickAsync `discard` rule names its `key` and `wgsl`.",
        );
    // The pin draws a mesh without the attribute through the pipeline
    // without it (`getPickVertexDataBinding`); a mesh records whether its
    // source supplied each attribute but uv2.
    if (vertexData === "uv2")
        return context.fail(
            node,
            'A pickAsync `discard` rule\'s `vertexData: "uv2"` is not lowered: a mesh does not record whether its source supplied uv2.',
        );
    return {
        key,
        wgsl,
        ...(worldAdjustWgsl !== undefined ? { worldAdjustWgsl } : {}),
        ...(vertexData !== undefined ? { vertexData } : {}),
        storage,
    };
}

/** A rule written as an object literal: its members' generation-known text. */
function literalPickDiscardRule(
    context: PickingIntrinsicContext,
    literal: ts.Expression,
): PickDiscardRuleManifest {
    const member = ruleMembers(context, literal);
    const optional = (name: string): ts.Expression | undefined => {
        const value = member(name);
        return value && !isNullishLiteral(context.checker, value)
            ? value
            : undefined;
    };
    const text = (name: string): string | undefined => {
        const member = optional(name);
        return member && staticRuleText(context, member, name);
    };
    const list = optional("storage");
    return pickDiscardRuleRow(context, literal, {
        key: text("key"),
        wgsl: text("wgsl"),
        worldAdjustWgsl: text("worldAdjustWgsl"),
        vertexData: text("vertexData"),
        storage: (list ? staticArrayElements(context, list) : []).map(
            (element) => {
                const entry = ruleMembers(context, element);
                const name = entry("name");
                const type = entry("type");
                const vertex = entry("vertex");
                if (!name || !type)
                    return context.fail(
                        element,
                        "A pickAsync `discard` storage entry names its `name` and `type`.",
                    );
                const stage =
                    vertex && !isNullishLiteral(context.checker, vertex)
                        ? context.probeEmission(
                              () =>
                                  staticBooleanOf(context.compileValue(vertex)),
                              () => false,
                          )
                        : false;
                if (stage === undefined)
                    return context.fail(
                        vertex!,
                        "A pickAsync `discard` storage entry's `vertex` is a generation-known boolean: it selects the bind group layout the composed pipeline declares.",
                    );
                return {
                    name: staticRuleText(context, name, "name"),
                    type: staticRuleText(context, type, "type"),
                    vertex: stage,
                };
            },
        ),
    });
}

/**
 * A rule an application call builds -- a composer over parts whose storage
 * closes over run-time state -- read from a model run of the call
 * (`runModelCall`): its key, WGSL and storage layout are text and flags the
 * run settles with, and each entry's `data` a function it never calls. The
 * native pick checks the rule it is handed against this one
 * (`prepare_pick_discard`).
 */
function modelPickDiscardRule(
    context: PickingIntrinsicContext,
    call: ts.CallExpression,
): PickDiscardRuleManifest {
    const label = `pickAsync's discard rule '${call.expression.getText()}(...)'`;
    const run = context.runModelCall(call, label);
    const refuse = (message: string): never =>
        context.fail(call, `${label} ${message}`);
    const read = (owner: unknown, name: string): unknown => {
        if (typeof owner !== "object" || owner === null || !run.isPlain(owner))
            return refuse(
                `settles with a value that is not plain data where '${name}' is read.`,
            );
        return (owner as Record<string, unknown>)[name];
    };
    const text = (owner: unknown, name: string): string | undefined => {
        const value = read(owner, name);
        if (value === undefined || value === null) return undefined;
        return typeof value === "string"
            ? value
            : refuse(`settles with a '${name}' that is not text.`);
    };
    const rule = run.value;
    const list = read(rule, "storage");
    if (list !== undefined && list !== null && !Array.isArray(list))
        return refuse("settles with a 'storage' that is not a list.");
    return pickDiscardRuleRow(context, call, {
        key: text(rule, "key"),
        wgsl: text(rule, "wgsl"),
        worldAdjustWgsl: text(rule, "worldAdjustWgsl"),
        vertexData: text(rule, "vertexData"),
        // A list of this realm: the run's own carries its realm's prototype.
        storage: Array.from((list ?? []) as unknown[]).map((entry) => {
            const name = text(entry, "name");
            const type = text(entry, "type");
            const vertex = read(entry, "vertex");
            if (name === undefined || type === undefined)
                return refuse(
                    "settles with a storage entry without its 'name' and 'type'.",
                );
            if (
                vertex !== undefined &&
                vertex !== null &&
                typeof vertex !== "boolean"
            )
                return refuse(
                    "settles with a storage entry whose 'vertex' is not a boolean.",
                );
            return { name, type, vertex: vertex === true };
        }),
    });
}

/** A rule member the composed WGSL splices, as its generation-known text. */
function staticRuleText(
    context: PickingIntrinsicContext,
    member: ts.Expression,
    name: string,
): string {
    try {
        return context.probeEmission(
            () => context.compileStaticString(member),
            () => false,
        );
    } catch (error) {
        if (!(error instanceof CompileError)) throw error;
        return context.fail(
            member,
            `A pickAsync \`discard\` rule's \`${name}\` is generation-known text: the composed pick shaders splice it. ${error.message}`,
        );
    }
}

/**
 * The reader of a rule literal's members (`objectProperty`), the literal
 * resolved through the constants and calls that hold it (`ruleLiteral`).
 */
function ruleMembers(
    context: PickingIntrinsicContext,
    expression: ts.Expression,
): (name: string) => ts.Expression | undefined {
    const literal = ruleLiteral(context, expression);
    if (!ts.isObjectLiteralExpression(literal))
        return context.fail(
            expression,
            "A pickAsync `discard` rule folds at generation to an object literal: its WGSL and storage layout select the composed pick shaders.",
        );
    return (name) => context.objectProperty(literal, name);
}

/**
 * The literal a rule member resolves to (`resolveStaticLiteral`), through
 * the module and imported constants that hold it where nothing writes
 * through them.
 */
function ruleLiteral(
    context: PickingIntrinsicContext,
    expression: ts.Expression,
): ts.Expression {
    let resolved = context.evaluator.resolveStaticLiteral(expression);
    for (const seen = new Set<ts.Symbol>(); ts.isIdentifier(resolved);) {
        const symbol = resolvedSymbol(context.checker, resolved);
        const declaration =
            symbol?.declarations?.length === 1
                ? symbol.declarations[0]
                : undefined;
        if (
            !symbol ||
            seen.has(symbol) ||
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !declaration.initializer ||
            variableKind(declaration) !== "const" ||
            context.evaluator.isWrittenThrough(declaration)
        )
            break;
        seen.add(symbol);
        resolved = context.evaluator.resolveStaticLiteral(
            declaration.initializer,
        );
    }
    return resolved;
}

/** An array literal's elements through the constants that resolve to it, spreads inlined. */
function staticArrayElements(
    context: PickingIntrinsicContext,
    expression: ts.Expression,
): ts.Expression[] {
    const literal = ruleLiteral(context, expression);
    if (!ts.isArrayLiteralExpression(literal))
        return context.fail(
            expression,
            "A pickAsync `discard` rule's `storage` folds at generation to an array literal: each entry is a binding of the composed pick shaders.",
        );
    return literal.elements.flatMap((element) =>
        ts.isSpreadElement(element)
            ? staticArrayElements(context, element.expression)
            : ts.isOmittedExpression(element)
              ? context.fail(
                    element,
                    "A pickAsync `discard` rule's `storage` has no holes.",
                )
              : [element],
    );
}
