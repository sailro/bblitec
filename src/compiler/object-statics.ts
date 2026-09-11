import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import { argumentAt } from "./syntax.js";
import type { LoweringServices } from "./lowering-services.js";
import { booleanValue, staticStringValue, type Value } from "./types.js";
import type { DataType } from "./data-types.js";
import { compileEntryCollection } from "./collection-methods.js";

export type ObjectStaticContext = Pick<
    LoweringServices,
        | "compileValue"
        | "probeEmission"
    | "dataLowerer"
    | "dataTypes"
    | "cppString"
    | "reachJsData"
    | "expectArgumentCount"
    | "allocateTemporaryCppName"
    | "emit"
    | "emitDiscardedValue"
    | "pinValueToTemporary"
    | "isInRuntimeControlFlow"
    | "invalidateRecordProperties"
    | "lookupIdentifierValue"
    | "resolveRecordValue"
    | "unwrap"
    | "isDefaultLibraryIdentifier"
    | "fail"
>;

/** A string-typed value's native text, static or data. */
function stringCpp(context: ObjectStaticContext, value: Value, node: ts.Node): string {
    return context.dataLowerer.compileKnownValueForSink(value, { kind: "string" }, node);
}

/** Read current field storage, using proven own keys when optional fields exist. */
function structEntries(
    context: ObjectStaticContext,
    owner: Value,
    dataType: DataType & { kind: "struct" },
    node: ts.Node,
): Array<[string, Value]> {
    const access = context.dataTypes.isReferenceStruct(dataType.name) ? "->" : ".";
    const fields = context.dataTypes.structFields(dataType.name, node);
    if (!owner.recordOwnKeys && fields.some(field => field.type.kind === "optional")) {
        context.fail(node, "Object enumeration requires known own keys for a struct with optional fields.");
    }
    const keys = owner.recordOwnKeys ?? fields.map(field => field.sourceName);
    return keys.map(key => {
        const field = context.dataTypes.structField(dataType.name, key, node);
        const value = context.dataLowerer.leafValue(`${owner.cpp}${access}${field.name}`, field.type);
        const original = owner.recordProperties?.[key];
        const definitelyPresent = original && original.kind !== "json-null" &&
            original.dataType?.kind !== "optional";
        return [key, definitelyPresent && field.type.kind === "optional"
            ? context.dataLowerer.leafValue(`(*${value.cpp})`, field.type.inner) : value];
    });
}

/** Common own-property projection for Object keys, values, entries and assign. */
export function ownObjectEntries(context: ObjectStaticContext, owner: Value, node: ts.Node): Array<[string, Value]> | undefined {
    if (owner.kind === "record") return Object.entries(owner.recordProperties ?? {});
    if (owner.kind === "data" && owner.dataType?.kind === "struct")
        return structEntries(context, owner, owner.dataType, node);
    if (owner.kind === "data" && owner.dataType?.kind === "enummap" && owner.recordOwnKeys) {
        const type = owner.dataType;
        return owner.recordOwnKeys.map(key => {
            const tag = context.dataTypes.enumMemberCpp({ kind: "enum", name: type.enumName }, key, node);
            return [key, context.dataLowerer.leafValue(`bbl::js::enum_map_at(${owner.cpp}, ${tag})`, type.element)];
        });
    }
    return undefined;
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
        return booleanValue(Object.is(left.staticNumber, right.staticNumber) ? "true" : "false");
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

/** `Object.hasOwn(object, key)`: the `in` membership without its struct arm. */
function compileObjectHasOwn(context: ObjectStaticContext, call: ts.CallExpression): Value {
    context.expectArgumentCount(call, 2, 2);
    const ownerNode = argumentAt(call, 0);
    const keyNode = argumentAt(call, 1);
    const owner = context.compileValue(ownerNode);
    const key = context.compileValue(keyNode);
    return booleanValue(context.dataLowerer.membershipCpp(owner, ownerNode, key, keyNode, "Object.hasOwn"));
}

/** The unbound own-property predicate uses the same owner/key contract as Object.hasOwn. */
export function compileObjectPrototypeCall(context: ObjectStaticContext, call: ts.CallExpression): Value | undefined {
    const callee = context.unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "call") return undefined;
    const method = context.unwrap(callee.expression);
    if (!ts.isPropertyAccessExpression(method) || method.name.text !== "hasOwnProperty") return undefined;
    const prototype = context.unwrap(method.expression);
    if (!ts.isPropertyAccessExpression(prototype) || prototype.name.text !== "prototype") return undefined;
    const owner = context.unwrap(prototype.expression);
    if (!ts.isIdentifier(owner) || owner.text !== "Object" || !context.isDefaultLibraryIdentifier(owner)) return undefined;
    return compileObjectHasOwn(context, call);
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
    const pairs = ownObjectEntries(context, owner, call);
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
                staticStringValue(key, (text) => context.cppString(text)),
                value.cpp && value.kind !== "callback"
                    ? context.pinValueToTemporary(value, "object_entry") : value,
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
    const record = context.probeEmission(() => {
        const entries = context.compileValue(argumentAt(call, 0));
        if (entries.kind !== "tuple") return undefined;
        const properties: Record<string, Value> = Object.create(null);
        for (const entry of entries.tupleElements ?? []) {
            if (entry.kind !== "tuple" || entry.tupleElements?.length !== 2) return undefined;
            const [key, value] = entry.tupleElements;
            const name = key?.staticString ?? (key?.staticNumber !== undefined ? String(key.staticNumber) : undefined);
            if (name === undefined) return undefined;
            if (properties[name]) context.emitDiscardedValue(properties[name]);
            properties[name] = value!;
        }
        return { kind: "record" as const, cpp: "", recordProperties: properties };
    });
    if (record) return record;
    const resultType = context.dataLowerer.dataTypeAt(call);
    if (resultType?.kind !== "map") {
        return context.fail(call, "Object.fromEntries requires a string-keyed dictionary result type.");
    }
    context.reachJsData();
    return compileEntryCollection(context.dataLowerer, argumentAt(call, 0), resultType);
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
        if (target.moduleNamespace) context.fail(call, "Module namespace properties are read-only.");
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

/**
 * The `Object` statics lowered here, beside `Object.keys`/`values` (the
 * expression lowerer's projection) and `Object.freeze`/`seal` (identities
 * the static evaluator sees through).
 */
export const OBJECT_STATIC_HANDLERS: ReadonlyMap<
    string,
    (context: ObjectStaticContext, call: ts.CallExpression) => Value
> = new Map([
    ["assign", compileObjectAssign],
    ["entries", compileObjectEntries],
    ["fromEntries", compileObjectFromEntries],
    ["hasOwn", compileObjectHasOwn],
    ["is", compileObjectIs],
]);
