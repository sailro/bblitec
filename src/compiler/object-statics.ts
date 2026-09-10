import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import { argumentAt } from "./syntax.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import type { DataType } from "./data-types.js";

/**
 * The `Object` statics lowered here, beside `Object.keys`/`values` (the
 * expression lowerer's projection) and `Object.freeze`/`seal` (identities
 * the static evaluator sees through).
 */
export const OBJECT_STATICS: ReadonlySet<string> = new Set([
    "assign",
    "entries",
    "fromEntries",
    "hasOwn",
    "is",
]);

type ObjectStaticContext = Pick<
    LoweringServices,
    | "compileValue"
    | "dataLowerer"
    | "dataTypes"
    | "cppString"
    | "reachJsData"
    | "expectArgumentCount"
    | "allocateTemporaryCppName"
    | "emit"
    | "isInRuntimeControlFlow"
    | "invalidateRecordProperties"
    | "lookupIdentifierValue"
    | "resolveRecordValue"
    | "unwrap"
    | "fail"
>;

/** A string-typed value's native text, static or data. */
function stringCpp(context: ObjectStaticContext, value: Value, node: ts.Node): string {
    return value.staticString !== undefined
        ? context.cppString(value.staticString)
        : context.dataLowerer.compileKnownValueForSink(value, { kind: "string" }, node);
}

function booleanValue(cpp: string, staticBoolean?: boolean): Value {
    return {
        kind: "boolean",
        cpp,
        ...(staticBoolean === undefined ? {} : { staticBoolean }),
        dataType: { kind: "boolean" },
    };
}

/** The fields of a data struct as `[sourceName, value]` pairs, in declaration order. */
function structEntries(
    context: ObjectStaticContext,
    owner: Value,
    dataType: DataType & { kind: "struct" },
    node: ts.Node,
): Array<[string, Value]> {
    const access = context.dataTypes.isReferenceStruct(dataType.name) ? "->" : ".";
    return context.dataTypes
        .structFields(dataType.name, node)
        .map((field) => [
            field.sourceName,
            context.dataLowerer.leafValue(`${owner.cpp}${access}${field.name}`, field.type),
        ]);
}

/**
 * `Object.is(a, b)`: SameValue over the scalar kinds, where it differs from
 * `===` only for NaN (equal) and signed zeros (different).
 */
function compileObjectIs(context: ObjectStaticContext, call: ts.CallExpression): Value {
    context.expectArgumentCount(call, 2, 2);
    const left = context.compileValue(argumentAt(call, 0));
    const right = context.compileValue(argumentAt(call, 1));
    if (left.staticNumber !== undefined && right.staticNumber !== undefined) {
        const answer = Object.is(left.staticNumber, right.staticNumber);
        return booleanValue(answer ? "true" : "false", answer);
    }
    const numeric = (value: Value): boolean =>
        value.kind === "number" || value.dataType?.kind === "number";
    const textual = (value: Value): boolean =>
        value.kind === "string" || value.dataType?.kind === "string";
    const boolean = (value: Value): boolean =>
        value.kind === "boolean" || value.dataType?.kind === "boolean";
    if (numeric(left) && numeric(right)) {
        context.reachJsData();
        return booleanValue(`bbl::js::same_value(${left.cpp}, ${right.cpp})`);
    }
    if (textual(left) && textual(right)) {
        return booleanValue(
            `(${stringCpp(context, left, argumentAt(call, 0))} == ${stringCpp(context, right, argumentAt(call, 1))})`,
        );
    }
    if (boolean(left) && boolean(right)) {
        return booleanValue(`(${left.cpp} == ${right.cpp})`);
    }
    return context.fail(
        call,
        "Object.is compares numbers, strings and booleans; object identity takes `===`.",
    );
}

/**
 * `Object.hasOwn(object, key)`: a compile-time record answers from its
 * properties, a string-keyed dictionary from its native membership.
 */
function compileObjectHasOwn(context: ObjectStaticContext, call: ts.CallExpression): Value {
    context.expectArgumentCount(call, 2, 2);
    const owner = context.compileValue(argumentAt(call, 0));
    const key = context.compileValue(argumentAt(call, 1));
    if (owner.kind === "record") {
        if (key.staticString === undefined) {
            context.fail(argumentAt(call, 1), "Object.hasOwn over a compile-time record requires a static key.");
        }
        const answer = Object.hasOwn(owner.recordProperties ?? {}, key.staticString) ||
            Object.hasOwn(owner.recordMethods ?? {}, key.staticString) ||
            Object.hasOwn(owner.recordGetters ?? {}, key.staticString);
        return booleanValue(answer ? "true" : "false", answer);
    }
    if (owner.kind === "data" && owner.dataType?.kind === "map" && owner.dataType.key.kind === "string") {
        context.reachJsData();
        return booleanValue(`${owner.cpp}.has(${stringCpp(context, key, argumentAt(call, 1))})`);
    }
    return context.fail(
        argumentAt(call, 0),
        "Object.hasOwn is decided for compile-time records and string-keyed dictionaries; a struct's fields are its type's.",
    );
}

/**
 * `Object.entries(object)` as a value: a compile-time record's pairs are a
 * compile-time tuple of `[key, value]` tuples, which the static tuple
 * methods and loops consume. A dictionary's entries are iterated in a
 * for...of, where the loop walks the map itself.
 */
function compileObjectEntries(context: ObjectStaticContext, call: ts.CallExpression): Value {
    context.expectArgumentCount(call, 1, 1);
    const owner = context.compileValue(argumentAt(call, 0));
    const pairs: Array<[string, Value]> | undefined =
        owner.kind === "record"
            ? Object.entries(owner.recordProperties ?? {})
            : owner.kind === "data" && owner.dataType?.kind === "struct"
              ? structEntries(context, owner, owner.dataType, call)
              : undefined;
    if (!pairs) {
        return context.fail(
            argumentAt(call, 0),
            "Object.entries as a value takes a compile-time record or a struct; a dictionary's entries are iterated in a for...of.",
        );
    }
    return {
        kind: "tuple",
        cpp: "",
        tupleElements: pairs.map(([key, value]) => ({
            kind: "tuple",
            cpp: "",
            tupleElements: [
                { kind: "string", cpp: context.cppString(key), staticString: key },
                value,
            ],
        })),
    };
}

/**
 * `Object.fromEntries(entries)`: a Map becomes the dictionary with its
 * pairs; a compile-time tuple of `[key, value]` tuples becomes a
 * dictionary literal.
 */
function compileObjectFromEntries(context: ObjectStaticContext, call: ts.CallExpression): Value {
    context.expectArgumentCount(call, 1, 1);
    const resultType = context.dataLowerer.dataTypeAt(call);
    if (resultType?.kind !== "map") {
        return context.fail(call, "Object.fromEntries requires a string-keyed dictionary result type.");
    }
    const source = context.compileValue(argumentAt(call, 0));
    context.reachJsData();
    const cppType = context.dataTypes.cppType(resultType);
    if (source.kind === "data" && source.dataType?.kind === "map") {
        return { kind: "data", cpp: `${cppType}(${source.cpp})`, dataType: resultType };
    }
    if (source.kind === "tuple") {
        const entries = (source.tupleElements ?? []).map((pair, index) => {
            const [key, value] = pair.kind === "tuple" ? pair.tupleElements ?? [] : [];
            if (!key || !value) {
                context.fail(argumentAt(call, 0), `Object.fromEntries entry ${index} is not a [key, value] pair.`);
            }
            return `{${context.dataLowerer.compileKnownValueForSink(key, resultType.key, call)}, ` +
                `${context.dataLowerer.compileKnownValueForSink(value, resultType.value, call)}}`;
        });
        return { kind: "data", cpp: `${cppType}{${entries.join(", ")}}`, dataType: resultType };
    }
    return context.fail(
        argumentAt(call, 0),
        "Object.fromEntries takes a Map or a compile-time list of [key, value] pairs.",
    );
}

/**
 * `Object.assign(target, ...sources)`: an empty literal target merges its
 * sources into a fresh compile-time record, as an object spread does; a
 * struct target stores each source field in place. Sources are compile-time
 * records, object literals or structs of the target's own type.
 */
function compileObjectAssign(context: ObjectStaticContext, call: ts.CallExpression): Value {
    if (call.arguments.length < 1) {
        context.fail(call, "Object.assign takes a target and its sources.");
    }
    const targetExpression = context.unwrap(argumentAt(call, 0));
    // A bound record is written in place, so its later reads see the
    // stores; reading it as a value would write into a copy.
    const target = context.resolveRecordValue(targetExpression) ?? context.compileValue(targetExpression);
    const sources = call.arguments.slice(1);
    const sourcePairs = (source: ts.Expression): Array<[string, Value]> => {
        const value = context.compileValue(source);
        if (value.kind === "record") {
            if (Object.keys(value.recordMethods ?? {}).length > 0 ||
                Object.keys(value.recordGetters ?? {}).length > 0) {
                context.fail(source, "Object.assign copies plain properties; a source with methods or accessors is not represented.");
            }
            return Object.entries(value.recordProperties ?? {});
        }
        if (value.kind === "data" && value.dataType?.kind === "struct") {
            return structEntries(context, value, value.dataType, source);
        }
        return context.fail(source, "Object.assign sources are compile-time records, object literals or structs.");
    };
    if (target.kind === "record") {
        const fresh = ts.isObjectLiteralExpression(targetExpression);
        if (!fresh && context.isInRuntimeControlFlow()) {
            context.fail(call, "A compile-time record cannot be populated from runtime control flow.");
        }
        const properties = fresh ? { ...target.recordProperties } : (target.recordProperties ??= {});
        for (const source of sources) {
            for (const [key, value] of sourcePairs(source)) {
                const existing = properties[key];
                // A property with native storage takes the store there; the
                // record then reads its storage rather than a folded value.
                if (
                    !fresh &&
                    existing !== undefined &&
                    (existing.kind === "number" || existing.kind === "string" || existing.kind === "boolean") &&
                    cppIdentifierPattern.test(existing.cpp)
                ) {
                    const scalarKind = existing.kind;
                    const stored = context.dataLowerer.compileKnownValueForSink(value, { kind: scalarKind }, source);
                    context.emit(`${existing.cpp} = ${stored};`);
                    properties[key] = { kind: scalarKind, cpp: existing.cpp, dataType: { kind: scalarKind } };
                    continue;
                }
                properties[key] = value;
            }
        }
        return fresh ? { ...target, recordProperties: properties } : target;
    }
    if (target.kind === "data" && target.dataType?.kind === "struct") {
        const structType = target.dataType;
        const access = context.dataTypes.isReferenceStruct(structType.name) ? "->" : ".";
        for (const source of sources) {
            for (const [key, value] of sourcePairs(source)) {
                const field = context.dataTypes.structField(structType.name, key, source);
                const stored = context.dataLowerer.compileKnownValueForSink(value, field.type, source);
                context.emit(`${target.cpp}${access}${field.name} = ${stored};`);
            }
        }
        // The stores changed fields whose generation snapshot lives on the
        // binding the target was read from, not only on this read of it.
        context.invalidateRecordProperties(target);
        const bound = ts.isIdentifier(targetExpression)
            ? context.lookupIdentifierValue(targetExpression)
            : undefined;
        if (bound) {
            context.invalidateRecordProperties(bound);
        }
        return target;
    }
    // An engine handle has no data fields to store into. The statement
    // erases exactly as the browser-instrumentation path erased every
    // `Object.assign` before data targets were lowered; a tracked camera
    // still refuses through the camera-mutation scan.
    for (const source of sources) {
        context.compileValue(source);
    }
    return { kind: "void", cpp: "" };
}

/** Lowers one reached `Object.<name>(...)` from {@link OBJECT_STATICS}. */
export function compileObjectStatic(
    context: ObjectStaticContext,
    call: ts.CallExpression,
    name: string,
): Value | undefined {
    switch (name) {
        case "assign":
            return compileObjectAssign(context, call);
        case "entries":
            return compileObjectEntries(context, call);
        case "fromEntries":
            return compileObjectFromEntries(context, call);
        case "hasOwn":
            return compileObjectHasOwn(context, call);
        case "is":
            return compileObjectIs(context, call);
        default:
            return undefined;
    }
}
