import { nativeDataMetadata, withNativeMetadata } from "./types.js";
// The data-container method knowledge: the method-name sets every
// mutation walk consults, and the dispatcher that lowers a data-method
// call (invoked through `DataLowerer.compileDataMethodCall`).
import { EmissionSet, EmissionMap } from "./emission-transaction.js";
import ts from "typescript";
import { argumentAt, regularExpressionParts } from "./syntax.js";
import { staticNumberValue } from "./option-helpers.js";
import { compileArrayValueMethod } from "./array-methods.js";
import { compileStringValueMethod } from "./string-methods.js";
import { compileDateMethod, compileDateTimeFormatMethod } from "./dates.js";
import { compileHttpResponseMethod } from "./http.js";
import { compileCollectionForEach } from "./collection-methods.js";

import {
    dataTypesEqual,
    isTypedArrayType,
    typedArrayStoreExpression,
    type DataType,
} from "./data-types.js";
import type { DataLowerer } from "./data-lowering.js";
import { isJsonValue } from "./json-bridge.js";
import { commonResourceValue, runtimeMeshValue, type Value } from "./types.js";

/**
 * `Array.isArray(value)` over the data model. Parsed JSON remains dynamic;
 * every statically typed value is decided at generation time.
 */
export function compileIsArrayOverData(
    lowerer: DataLowerer,
    call: ts.CallExpression,
): Value | undefined {
    const callee = lowerer.context.unwrap(call.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        callee.name.text !== "isArray" ||
        !ts.isIdentifier(callee.expression) ||
        callee.expression.text !== "Array" ||
        !lowerer.context.isDefaultLibraryIdentifier(callee.expression) ||
        lowerer.context.lookupIdentifierValue(callee.expression) !== undefined ||
        call.arguments.length !== 1
    ) {
        return undefined;
    }
    const value = lowerer.context.compileValue(argumentAt(call, 0));
    const decided = (answer: boolean): Value => {
        lowerer.context.emitDiscardedValue(value);
        return {kind:"boolean", cpp:answer ? "true" : "false", staticBoolean:answer, dataType:{kind:"boolean"}};
    };
    if (value.kind === "tuple") return decided(true);
    if (["record", "json-null", "number", "boolean", "string", "callback"].includes(value.kind)) return decided(false);
    const optional = value.dataType?.kind === "optional";
    const dataType =
        value.dataType?.kind === "optional"
            ? value.dataType.inner
            : value.dataType;
    if (!dataType || dataType.kind === "numberindex" ||
        (dataType.kind === "union" && dataType.members.some(member => member.kind === "numberindex"))) return undefined;
    if (dataType.kind === "json" && !optional) return {kind:"boolean", cpp:`${value.cpp}.is_array()`, dataType:{kind:"boolean"}};
    const arrayType = (type: DataType): boolean => ["vector", "span", "tuple", "product", "table"].includes(type.kind);
    const member = optional ? "(*candidate)" : "candidate";
    const predicate = dataType.kind === "json" ? `${member}.is_array()` : dataType.kind === "union"
        ? `std::array<bool, ${dataType.members.length}>{${dataType.members.map(arrayType).join(", ")}}[${member}.index()]`
        : arrayType(dataType) ? "true" : "false";
    if (predicate === "false" || (predicate === "true" && !optional)) return decided(predicate === "true");
    return {kind:"boolean", cpp:`([](const auto& candidate) { return ${optional ? "candidate.has_value() && " : ""}${predicate}; }(${value.cpp}))`, dataType:{kind:"boolean"}};
}

/**
 * The `[start, end]` pair a ranged builtin takes, as native doubles.
 *
 * `fill` and `copyWithin` both resolve their endpoints through the same
 * relative-index rule, both read an omitted end as the receiver's length,
 * and both take the pair after one leading argument (the fill value, the
 * copy target).
 */
function relativeRangeArguments(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    receiverCpp: string,
): [start: string, end: string] {
    const startArgument = call.arguments[1];
    const endArgument = call.arguments[2];
    return [
        startArgument
            ? lowerer.context.compileNumber(startArgument, "double")
            : "0.0",
        endArgument
            ? lowerer.context.compileNumber(endArgument, "double")
            : `static_cast<double>(${receiverCpp}.size())`,
    ];
}

/** Data-container methods whose receiver is not mutated. */
export const readOnlyDataMethods: ReadonlySet<string> = new EmissionSet([
    "at",
    "concat",
    "entries",
    "every",
    "filter",
    "flat",
    "flatMap",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "forEach",
    "get",
    "has",
    "includes",
    "indexOf",
    "join",
    "keys",
    "lastIndexOf",
    "map",
    "reduce",
    "reduceRight",
    "slice",
    "some",
    "values",
]);

interface ArrayCallbackReceiverPolicy {
    readonly snapshotIdentity: boolean;
    readonly skipRemoved: boolean;
    readonly invalidatesFacts: boolean;
}

const existingCallbackReceiver: ArrayCallbackReceiverPolicy = {
    snapshotIdentity: false, skipRemoved: false, invalidatesFacts: false,
};
const mutableCallbackReceiver: ArrayCallbackReceiverPolicy = {
    snapshotIdentity: true, skipRemoved: true, invalidatesFacts: true,
};

/** Receiver rules shared by callback emission and source-level fact analysis. */
export function arrayCallbackReceiverPolicy(method: string): ArrayCallbackReceiverPolicy {
    return method === "flatMap" ? mutableCallbackReceiver : existingCallbackReceiver;
}

/** Array methods that can change its length and invalidate element aliases. */
export const resizingArrayMethods: ReadonlySet<string> = new EmissionSet([
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
]);

/** Array methods that mutate the receiver even when its length is unchanged. */
export const mutatingArrayMethods: ReadonlySet<string> = new EmissionSet([
    ...resizingArrayMethods,
    "copyWithin",
    "fill",
    "reverse",
    "sort",
]);

/** Methods that retain argument identity without mutating the argument itself. */
export const storingDataMethods: ReadonlySet<string> = new EmissionSet([
    "add",
    "concat",
    "fill",
    "of",
    "push",
    "set",
    "splice",
    "unshift",
]);

/** Syntactic retention proof used conservatively by the alias analyses. */
export function isStoringDataCall(node: ts.Node): node is ts.CallExpression | ts.NewExpression {
    return (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        storingDataMethods.has(node.expression.name.text)) ||
        (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
            (node.expression.text === "Map" || node.expression.text === "Set"));
}

/**
 * The methods that change the container they are called on: every
 * mutating array method plus the Map/Set writers. A name outside this set
 * writes nothing through its receiver, so a container only ever read
 * through `get`, `has`, `map` or `find` stays folded.
 */
export const writeReceiverMethods: ReadonlySet<string> = new EmissionSet([
    "pop",
    "shift",
    "push",
    "unshift",
    "reverse",
    "fill",
    "copyWithin",
    "splice",
    "set",
    "add",
    "clear",
    "delete",
]);

const constantArrayMethods: ReadonlySet<string> = new EmissionSet([
    "at", "concat", "lastIndexOf", "flatMap", "slice",
    "indexOf",
    "includes",
    "find",
    "findIndex",
    "filter",
    "reduce",
    "some",
    "every",
    "map",
    "forEach",
    "join",
]);

const snapshotInvalidatingMethods: ReadonlySet<string> = new EmissionSet([
    "pop",
    "shift",
    "unshift",
    "reverse",
    "fill",
    "copyWithin",
    "splice",
    "set",
    "clear",
    "delete",
]);

/**
 * Compiles data-container method calls (`push`, `pop`, `fill`) and the
 * `new Array(n).fill(v)` chain.
 */
export function compileDataMethodCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    expectedResult?: DataType<"vector">,
): Value | undefined {
    const callee = lowerer.context.unwrap(
        call.expression,
    );
    if (!ts.isPropertyAccessExpression(callee)) {
        return undefined;
    }
    const method = callee.name.text;
    if (
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === "classList"
    ) {
        return undefined;
    }
    const moduleMapGet =
        method === "get" &&
        ts.isIdentifier(callee.expression)
            ? lowerer.compileModuleMapGet(
                  call,
                  callee.expression,
              )
            : undefined;
    if (moduleMapGet) {
        return moduleMapGet;
    }
    const ownerExpression = lowerer.context.unwrap(
        callee.expression,
    );
    if (
        ts.isNewExpression(ownerExpression) &&
        method === "fill"
    ) {
        const created = lowerer.newArrayInfo(
            ownerExpression,
        );
        if (created) {
            if (call.arguments.length !== 1) {
                lowerer.context.fail(
                    call,
                    "Array.fill expects one argument.",
                );
            }
            lowerer.context.reachJsData();
            const value = lowerer.compileForRetainedSink(
                argumentAt(call, 0),
                created.element,
                "Array.fill",
            );
            return {
                kind: "data",
                cpp: `bbl::js::array_filled<${lowerer.context.dataTypes.cppType(created.element)}>(${created.count}, ${value})`,
                dataType: {
                    kind: "vector",
                    element: created.element,
                },
            };
        }
        const typed = lowerer.compileTypedArrayNew(
            ownerExpression,
        );
        if (
            typed?.kind === "data" &&
            isTypedArrayType(typed.dataType)
        ) {
            if (call.arguments.length !== 1) {
                lowerer.context.fail(
                    call,
                    "TypedArray.fill expects one argument.",
                );
            }
            const temporary =
                lowerer.context.allocateTemporaryCppName(
                    "filled_array",
                );
            lowerer.context.emit({ kind: "declaration", type: "auto", name: temporary, initializer: typed.cpp });
            const number = lowerer.context.compileNumber(
                argumentAt(call, 0),
                "double",
            );
            const value = typedArrayStoreExpression(
                typed.dataType.kind,
                number,
            );
            lowerer.context.emit(
                `bbl::js::array_fill(${temporary}, ${value});`,
            );
            lowerer.registerLocal(temporary, "owned");
            return {
                kind: "data",
                cpp: temporary,
                dataType: typed.dataType,
            };
        }
    }
    const dynamicOwner =
        ts.isCallExpression(ownerExpression) ||
        ts.isNewExpression(ownerExpression) ||
        ts.isArrayLiteralExpression(ownerExpression) ||
        ts.isConditionalExpression(ownerExpression) ||
        ts.isBinaryExpression(ownerExpression)
            ? lowerer.context.compileValue(ownerExpression)
            : ts.isIdentifier(ownerExpression)
              ? (lowerer.context.lookupIdentifierValue(ownerExpression) ??
                (lowerer.dataTypeAt(ownerExpression)?.kind === "string"
                    ? lowerer.context.compileValue(ownerExpression)
                    : lowerer.compileStaticContainer(ownerExpression)))
              : (ts.isPropertyAccessExpression(ownerExpression) ||
                    ts.isElementAccessExpression(ownerExpression)) &&
                  lowerer.plainDataOwnerChain(ownerExpression)
                ? lowerer.context.compileValue(ownerExpression)
              : ts.isStringLiteralLike(ownerExpression) ||
                  ts.isTemplateExpression(ownerExpression)
                ? lowerer.context.compileValue(ownerExpression)
                : undefined;
    if (dynamicOwner?.dataType?.kind === "date") return compileDateMethod(lowerer, call, dynamicOwner, method);
    if (dynamicOwner?.dataType?.kind === "http-response") return compileHttpResponseMethod(lowerer, call, dynamicOwner, method);
    if (dynamicOwner?.dataType?.kind === "date-time-format") return compileDateTimeFormatMethod(lowerer, call, dynamicOwner, method);
    const tupleOwnerElements: Value[] | undefined =
        dynamicOwner?.kind === "tuple"
        ? (dynamicOwner.tupleElements ?? [])
        : dynamicOwner?.kind === "data" &&
            dynamicOwner.dataType?.kind === "tuple"
          ? Array.from(
                { length: dynamicOwner.dataType.arity },
                (_unused, index) => ({
                    kind: "number" as const,
                    cpp: `${dynamicOwner.cpp}[${index}]`,
                    dataType: { kind: "number" as const },
                }),
            )
          : undefined;
    if (dynamicOwner?.kind === "tuple" && tupleOwnerElements && method === "slice") {
        if (call.arguments.length > 2) lowerer.context.fail(call, "Array.slice expects zero, one, or two arguments.");
        const selected = lowerer.context.probeEmission(() => {
            // Receiver elements are evaluated before either endpoint, even
            // when the selected interval later excludes them.
            const elements = tupleOwnerElements.map(value => lowerer.context.pinValueToTemporary(value, "slice_member"));
            const begin = call.arguments[0] ? lowerer.context.compileValue(call.arguments[0]) : undefined;
            const end = call.arguments[1] ? lowerer.context.compileValue(call.arguments[1]) : undefined;
            if ((begin && begin.staticNumber === undefined) || (end && end.staticNumber === undefined)) return undefined;
            for (const element of elements) lowerer.context.emitDiscardedValue(element);
            return {kind: "tuple", cpp: "", tupleElements: elements.slice(begin?.staticNumber, end?.staticNumber)} satisfies Value;
        });
        if (selected) return selected;
    }
    if (tupleOwnerElements && method === "join") {
        if (call.arguments.length > 1) {
            lowerer.context.fail(
                call,
                "Tuple Array.join expects zero or one separator argument.",
            );
        }
        const separatorValue = call.arguments[0]
            ? lowerer.context.compileValue(call.arguments[0])
            : undefined;
        const separator = separatorValue
            ? separatorValue.staticString
            : ",";
        const strings = tupleOwnerElements.map(
            (element) => element.staticString,
        );
        if (
            separator !== undefined &&
            strings.every(
                (value): value is string => value !== undefined,
            )
        ) {
            const staticString = strings.join(separator);
            return {
                kind: "string",
                cpp: lowerer.context.cppString(staticString),
                staticString,
                dataType: { kind: "string" },
            };
        }
    }
    if (
        tupleOwnerElements &&
        dynamicOwner &&
        (method === "some" || method === "every" || method === "filter" || method === "find" || method === "findIndex")
    ) {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(
                call,
                `Tuple Array.${method} requires exactly one callback.`,
            );
        }
        const callback = lowerer.context.unwrap(argumentAt(call, 0));
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            lowerer.context.fail(
                callback,
                `Tuple Array.${method} requires a local function or function literal callback.`,
            );
        }
        const folded = lowerer.context.probeEmission(
            (): Value | undefined => {
                const selected: Value[] = [];
                for (let index = 0; index < tupleOwnerElements.length; ++index) {
                    const matched =
                        lowerer.context.compilePredicateWithValues(
                            callback,
                            [
                                tupleOwnerElements[index]!,
                                {
                                    kind: "number",
                                    cpp: `${index}.0`,
                                    staticNumber: index,
                                    dataType: { kind: "number" },
                                },
                                dynamicOwner,
                            ],
                            call,
                        );
                    if (matched.staticBoolean === undefined) {
                        return undefined;
                    }
                    if (method === "filter") {
                        if (matched.staticBoolean) selected.push(tupleOwnerElements[index]!);
                        continue;
                    }
                    if ((method === "find" || method === "findIndex") && matched.staticBoolean) {
                        return method === "find" ? tupleOwnerElements[index]! : {
                            kind: "number", cpp: `${index}.0`, staticNumber: index, dataType: { kind: "number" },
                        };
                    }
                    if (
                        (method === "some" && matched.staticBoolean) ||
                        (method === "every" && !matched.staticBoolean)
                    ) {
                        return {
                            kind: "boolean",
                            cpp: matched.staticBoolean ? "true" : "false",
                            staticBoolean: matched.staticBoolean,
                            dataType: { kind: "boolean" },
                        };
                    }
                }
                if (method === "filter") return { kind: "tuple", cpp: "", tupleElements: selected };
                if (method === "find") return { kind: "json-null", cpp: "std::nullopt" };
                if (method === "findIndex") return { kind: "number", cpp: "-1.0", staticNumber: -1, dataType: { kind: "number" } };
                const result = method === "every";
                return {
                    kind: "boolean",
                    cpp: result ? "true" : "false",
                    staticBoolean: result,
                    dataType: { kind: "boolean" },
                };
            },
        );
        if (folded) {
            return folded;
        }
    }
    if (tupleOwnerElements && dynamicOwner && method === "map") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(
                call,
                "Tuple Array.map requires exactly one callback.",
            );
        }
        const callback = lowerer.context.unwrap(argumentAt(call, 0));
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            lowerer.context.fail(
                callback,
                "Tuple Array.map requires a local function or function literal callback.",
            );
        }
        return {
            kind: "tuple",
            cpp: "",
            tupleElements: tupleOwnerElements.map((element, index) =>
                lowerer.context.compileCallbackWithValues(
                    callback,
                    [
                        element,
                        {
                            kind: "number",
                            cpp: `${index}.0`,
                            staticNumber: index,
                            dataType: { kind: "number" },
                        },
                        dynamicOwner,
                    ],
                    call,
                ),
            ),
        };
    }
    // A constructor receiver was already evaluated above. Recompiling it as
    // a data path would repeat its argument effects; naming the result also
    // keeps an omitted method endpoint from constructing it again for size().
    let constructedOwner: Value | undefined;
    if (ts.isNewExpression(ownerExpression) && dynamicOwner?.kind === "data") {
        const receiver = lowerer.context.allocateTemporaryCppName("constructed_receiver");
        lowerer.context.emit({ kind: "declaration", type: "auto", name: receiver, initializer: dynamicOwner.cpp });
        constructedOwner = { ...dynamicOwner, cpp: receiver };
    }
    const owner =
        constructedOwner ??
        (dynamicOwner?.kind === "tuple" ? undefined : lowerer.compileDataPath(
            callee.expression,
            writeReceiverMethods.has(method)
                ? "write"
                : "read",
        )) ??
        (dynamicOwner?.kind === "data" ||
        dynamicOwner?.kind === "string"
            ? dynamicOwner
            : undefined) ??
        // A constant array is a compile-time tuple with nothing to
        // search, so searching one materializes it exactly as a
        // runtime index into it does.
        (constantArrayMethods.has(method)
            ? (lowerer.materializeConstantArray(
                  callee.expression,
              ) ??
              (!lowerer.namesHandleCollection(callee.expression)
                  ? lowerer.materializeKnownTuple(
                        callee.expression,
                        dynamicOwner?.kind === "tuple" ? dynamicOwner : undefined,
                    )
                  : undefined))
            : undefined);
    if (
        !owner ||
        (owner.kind !== "data" && owner.kind !== "string")
    ) {
        return undefined;
    }
    const optionalOwnerType =
        owner.kind === "data" &&
        owner.dataType?.kind === "optional"
            ? owner.dataType
            : undefined;
    const optionalSetType =
        optionalOwnerType?.inner.kind === "set"
            ? optionalOwnerType.inner
            : undefined;
    if (callee.questionDotToken && optionalOwnerType &&
        (method === "indexOf" || method === "includes") &&
        (optionalOwnerType.inner.kind === "vector" || optionalOwnerType.inner.kind === "span")) {
        const receiver = lowerer.context.allocateTemporaryCppName("optional_array");
        const result = lowerer.context.allocateTemporaryCppName("optional_search");
        const resultType: DataType = { kind: "optional", inner: { kind: method === "indexOf" ? "number" : "boolean" } };
        lowerer.context.emit({ kind: "declaration", type: "const auto", name: receiver, initializer: owner.cpp });
        lowerer.context.emit(`${lowerer.context.dataTypes.cppType(resultType)} ${result};`);
        lowerer.context.emit(`if (${receiver}.has_value()) {`);
        lowerer.context.increaseIndent();
        lowerer.context.enterRuntimeControlFlow();
        try {
            const search = lowerer.compileArraySearch(call,
                { kind: "data", cpp: `(*${receiver})`, dataType: optionalOwnerType.inner },
                optionalOwnerType.inner.element, method);
            lowerer.context.emit(`${result} = ${search.cpp};`);
        } finally {
            lowerer.context.leaveRuntimeControlFlow();
            lowerer.context.decreaseIndent();
        }
        lowerer.context.emit("}");
        return { kind: "data", cpp: result, dataType: resultType };
    }
    if (
        callee.questionDotToken !== undefined &&
        method === "delete" &&
        optionalOwnerType &&
        optionalSetType
    ) {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(
                call,
                "Set.delete expects exactly one value.",
            );
        }
        const optional = lowerer.context.allocateTemporaryCppName(
            "optional_set",
        );
        const lookup = lowerer.context.allocateTemporaryCppName(
            "optional_set_lookup",
        );
        const result = lowerer.context.allocateTemporaryCppName(
            "optional_delete",
        );
        const resultType = {
            kind: "optional",
            inner: { kind: "boolean" },
        } as const;
        lowerer.context.emit(
            `${lowerer.context.dataTypes.cppType(optionalOwnerType)} ${optional};`,
        );
        lowerer.context.emit("{");
        lowerer.context.increaseIndent();
        lowerer.context.emit({ kind: "declaration", type: "const auto", name: lookup, initializer: owner.cpp });
        lowerer.context.emit(`if (${lookup}.has_value()) {`);
        lowerer.context.increaseIndent();
        lowerer.context.emit(`${optional} = *${lookup};`);
        lowerer.context.decreaseIndent();
        lowerer.context.emit("}");
        lowerer.context.decreaseIndent();
        lowerer.context.emit("}");
        lowerer.context.emit(
            `${lowerer.context.dataTypes.cppType(resultType)} ${result};`,
        );
        lowerer.context.emit(`if (${optional}.has_value()) {`);
        lowerer.context.increaseIndent();
        lowerer.context.enterRuntimeControlFlow();
        try {
            const value = lowerer.compileForSink(
                argumentAt(call, 0),
                optionalSetType.element,
            );
            lowerer.context.emit(
                `${result} = (*${optional}).erase(${value});`,
            );
        } finally {
            lowerer.context.leaveRuntimeControlFlow();
        }
        lowerer.context.decreaseIndent();
        lowerer.context.emit("}");
        return {
            kind: "data",
            cpp: result,
            dataType: resultType,
            truthinessCpp:
                `(${result}.has_value() && *${result})`,
            requiresExplicitDiscard: true,
        };
    }
    const narrowedOwner = lowerer.stringReceiver(lowerer.narrowOptional(
        owner,
        callee.expression,
    ), callee.expression);
    // An array method on a parsed document runs over the document's own
    // elements, each of which is another document. Handing the element
    // view to the ordinary array lowering is the whole adaptation:
    // nothing about the callback protocol changes.
    let narrowed = narrowedOwner;
    if (isJsonValue(narrowedOwner)) {
        narrowed = {
            kind: "data",
            cpp: `${narrowedOwner.cpp}.elements()`,
            dataType: { kind: "span", element: { kind: "json" } },
        };
    } else if (narrowedOwner.dataType?.kind === "tuple" &&
        (method === "some" || method === "every")) {
        narrowed = {
            ...narrowedOwner,
            // A numeric tuple's observing predicates use the same indexed
            // range loop as a readonly numeric array.
            dataType: { kind: "span", element: { kind: "number" } },
        };
    }
    if (snapshotInvalidatingMethods.has(method)) {
        lowerer.invalidateStaticElements(
            narrowed,
            method === "reverse" || method === "fill" || method === "copyWithin" ||
                ((method === "set" || method === "delete") &&
                    (narrowed.dataType?.kind === "map" || narrowed.dataType?.kind === "set")),
        );
    }
    const dataType =
        narrowed.dataType ??
        (narrowed.kind === "string"
            ? ({ kind: "string" } as const)
            : undefined);
    const recordType = dataType?.kind === "optional" ? dataType.inner : dataType;
    if (recordType?.kind === "struct") {
        const field = lowerer.context.dataTypes
            .structFields(recordType.name, callee.name)
            .find((candidate) => candidate.name === method);
        const functionType = field?.type;
        if (functionType?.kind === "function") {
            const referenceReceiver = lowerer.context.dataTypes.isReferenceStruct(recordType.name);
            const member = referenceReceiver ? "->" : ".";
            const receiver = lowerer.context.allocateTemporaryCppName("callback_receiver");
            const optional = dataType?.kind === "optional";
            lowerer.context.emit({kind:"declaration", type:referenceReceiver || optional ? "const auto" : "const auto&",
                name:receiver, initializer:narrowed.cpp});
            const record = optional ? `(*${receiver})` : receiver;
            const present = optional ? `${receiver}.has_value()` : referenceReceiver ? receiver : undefined;
            return lowerer.compileStoredCall(call, `${record}${member}${field!.name}`, functionType, present);
        }
    }
    if (dataType?.kind === "map") { return compileMapDataMethod(lowerer, call, callee, method, narrowed, dataType); }
    if (dataType?.kind === "set") { return compileSetDataMethod(lowerer, call, callee, method, narrowed, dataType); }
    if (dataType?.kind === "string") { const result = compileStringDataMethod(lowerer, call, callee, method, narrowed, dataType); if (result) return result; }
    if (
        dataType?.kind === "vector" &&
        method === "next" &&
        narrowed.freshData &&
        ts.isCallExpression(ownerExpression)
    ) {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(
                call,
                "Map iterator next expects no arguments.",
            );
        }
        const values = lowerer.context.allocateTemporaryCppName(
            "map_iterator_values",
        );
        lowerer.context.emit({ kind: "declaration", type: "auto", name: values, initializer: narrowed.cpp });
        lowerer.registerLocal(values, "owned");
        const found = `!${values}.empty()`;
        const first = `bbl::js::array_at_or_default(${values}, 0.0)`;
        return {
            kind: "record",
            cpp: "",
            recordProperties: {
                value: {
                    ...lowerer.leafValue(first, dataType.element),
                    optionalFoundCpp: found,
                },
                done: {
                    kind: "boolean",
                    cpp: `!(${found})`,
                    dataType: { kind: "boolean" },
                },
            },
        };
    }
    if (method === "indexOf" || method === "includes") {
        // Readonly arrays and materialized constants reach this
        // too: the demo cycles its mode through a
        // a `readonly` array of tags, which is a span of them, and a
        // constant numeric array is a one-dimensional table.
        const element =
            dataType?.kind === "vector" ||
            dataType?.kind === "span"
                ? dataType.element
                : dataType?.kind === "table" &&
                    dataType.dimensions.length === 1
                  ? ({ kind: "number" } as DataType)
                  : undefined;
        if (element) {
            return lowerer.compileArraySearch(
                call,
                narrowed,
                element,
                method,
            );
        }
    }
    if (
        isTypedArrayType(dataType) &&
        method === "fill"
    ) {
        if (
            call.arguments.length < 1 ||
            call.arguments.length > 3
        ) {
            lowerer.context.fail(
                call,
                "TypedArray.fill expects one to three arguments.",
            );
        }
        lowerer.context.reachJsData();
        const number = lowerer.context.compileNumber(
            argumentAt(call, 0),
            "double",
        );
        const stored = typedArrayStoreExpression(
            dataType.kind,
            number,
        );
        if (call.arguments.length === 1) {
            return {
                kind: "void",
                cpp: `bbl::js::array_fill(${narrowed.cpp}, ${stored})`,
            };
        }
        // `fill(value, start[, end])`: both endpoints are relative
        // indices and an omitted end is the length, exactly as `slice`
        // resolves its own pair.
        const [start, end] = relativeRangeArguments(
            lowerer,
            call,
            narrowed.cpp,
        );
        return {
            kind: "void",
            cpp:
                `bbl::js::array_fill_range(${narrowed.cpp}, ` +
                `${stored}, ${start}, ${end})`,
        };
    }
    if (
        isTypedArrayType(dataType) &&
        method === "copyWithin"
    ) {
        if (
            call.arguments.length < 2 ||
            call.arguments.length > 3
        ) {
            lowerer.context.fail(
                call,
                "TypedArray.copyWithin expects two or three arguments.",
            );
        }
        lowerer.context.reachJsData();
        const target = lowerer.context.compileNumber(
            argumentAt(call, 0),
            "double",
        );
        const [start, end] = relativeRangeArguments(
            lowerer,
            call,
            narrowed.cpp,
        );
        return {
            kind: "void",
            cpp:
                `bbl::js::array_copy_within(${narrowed.cpp}, ` +
                `${target}, ${start}, ${end})`,
        };
    }
    if (
        isTypedArrayType(dataType) &&
        method === "set"
    ) {
        return lowerer.compileTypedArraySet(
            call,
            narrowed,
            dataType.kind,
        );
    }
    if (
        dataType?.kind === "u8array" &&
        (method === "slice" || method === "subarray")
    ) {
        if (call.arguments.length > 2) {
            lowerer.context.fail(
                call,
                `Uint8Array.${method} expects up to two arguments.`,
            );
        }
        const begin = call.arguments[0]
            ? lowerer.context.compileNumber(
                  call.arguments[0],
                  "double",
              )
            : "0.0";
        const end = call.arguments[1]
            ? lowerer.context.compileNumber(
                  call.arguments[1],
                  "double",
              )
            : `static_cast<double>(${narrowed.cpp}.size())`;
        return {
            kind: "data",
            cpp:
                `${narrowed.cpp}.${method}(` +
                `bbl::js::array_index(${begin}), ` +
                `bbl::js::array_index(${end}))`,
            dataType: { kind: "u8array" },
        };
    }
    if (
        isTypedArrayType(dataType) &&
        dataType.kind !== "u8array" &&
        (method === "slice" || method === "subarray")
    ) {
        if (call.arguments.length > 2) {
            lowerer.context.fail(
                call,
                `TypedArray.${method} expects up to two arguments.`,
            );
        }
        const begin = call.arguments[0]
            ? lowerer.context.compileNumber(
                  call.arguments[0],
                  "double",
              )
            : "0.0";
        const end = call.arguments[1]
            ? lowerer.context.compileNumber(
                  call.arguments[1],
                  "double",
              )
            : `static_cast<double>(${narrowed.cpp}.size())`;
        lowerer.context.reachJsData();
        // `slice` copies the range; `subarray` is a view sharing the
        // receiver's bytes, so writes through it reach the source.
        return {
            kind: "data",
            cpp:
                `bbl::js::typed_array_${method}(${narrowed.cpp}, ` +
                `${begin}, ${end})`,
            dataType,
        };
    }
    if (dataType?.kind === "dataview") {
        const accessor = DATA_VIEW_ACCESSORS.get(method);
        if (accessor) {
            return compileDataViewAccessor(lowerer, call, narrowed, method, accessor);
        }
    }
    if (
        dataType?.kind !== "vector" &&
        dataType?.kind !== "span"
    ) {
        return undefined;
    }
    const arrayValue = compileArrayValueMethod(lowerer, call, method, narrowed, dataType);
    if (arrayValue) return arrayValue;
    if (
        dataType.kind === "span" &&
        !readOnlyDataMethods.has(method)
    ) {
        // A readonly array parameter is a span. Its observing methods
        // share the vector loop below; mutating/copy-producing methods
        // keep requiring owning storage.
        return undefined;
    }
    lowerer.context.reachJsData();
    const handler = arrayMethodHandlers.get(method);
    if (handler) return handler({ lowerer, call, narrowed, dataType, dynamicOwner, expectedResult });
    lowerer.context.fail(callee.name, `Array method '${method}' is not supported.`);
}

interface ArrayMethodState {
    lowerer: DataLowerer;
    call: ts.CallExpression;
    narrowed: Value;
    dataType: DataType & { kind: "vector" | "span" };
    dynamicOwner: Value | undefined;
    expectedResult: DataType<"vector"> | undefined;
}

function compileArrayFlat({ lowerer, call, narrowed, dataType }: ArrayMethodState): Value {
    if (call.arguments.length > 1) lowerer.context.fail(call, "Array.flat expects at most one depth argument.");
    const requested = call.arguments[0] ? staticNumberValue(lowerer.context, call.arguments[0]) : 1;
    if (requested === undefined) return lowerer.context.fail(call, "Array.flat requires a generation-known depth.");
    const depth = Number.isNaN(requested) ? 0 : Math.max(0, Math.trunc(requested));
    const resultType = lowerer.dataTypeAt(call);
    if (resultType?.kind !== "vector") return lowerer.context.fail(call, "Array.flat result must belong to the native data model.");
    const output = lowerer.context.allocateTemporaryCppName("flat_result");
    lowerer.context.emit({ kind: "declaration", type: lowerer.context.dataTypes.cppType(resultType), name: output, initializer: "{}" });
    const append = (cpp: string, type: DataType, levels: number): void => {
        if (levels > 0 && (type.kind === "vector" || type.kind === "span" || type.kind === "tuple")) {
            const item = lowerer.context.allocateTemporaryCppName("flat_item");
            lowerer.context.emit(`for (const auto& ${item} : ${cpp}) {`);
            lowerer.context.increaseIndent();
            append(item, type.kind === "tuple" ? { kind: "number" } : type.element, levels - 1);
            lowerer.context.decreaseIndent();
            lowerer.context.emit("}");
        } else {
            const value = lowerer.compileKnownValueForSink(lowerer.leafValue(cpp, type), resultType.element, call);
            lowerer.context.emit(`${output}.push_back(${value});`);
        }
    };
    append(narrowed.cpp, dataType, depth + 1);
    lowerer.registerLocal(output, "owned");
    return { kind: "data", cpp: output, dataType: resultType, freshData: true };
}

function compileArrayJoin(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (!["string", "enum", "number", "boolean"].includes(dataType.element.kind) ||
        call.arguments.length > 1) {
        lowerer.context.fail(call, "Array.join supports scalar arrays with at most one separator.");
    }
    const separator = call.arguments[0]
        ? lowerer.context.compileValue(argumentAt(call, 0))
        : undefined;
    if (separator &&
        separator.kind !== "string" &&
        !(separator.kind === "data" &&
            separator.dataType?.kind === "string")) {
        lowerer.context.fail(argumentAt(call, 0), "Array.join separator must be a string.");
    }
    return {
        kind: "string",
        cpp: `bbl::js::array_join(${narrowed.cpp}, ${separator
            ? separator.cpp
            : lowerer.context.cppString(",")}${dataType.element.kind === "enum"
            ? `, [](const auto& value) { return ${lowerer.context.dataTypes.enumToStringCpp(dataType.element, "value", call)}; }`
            : dataType.element.kind === "number"
                ? ", [](double value) { return bbl::js::number_to_string(value); }"
                : dataType.element.kind === "boolean"
                    ? ', [](bool value) { return value ? "true" : "false"; }'
                    : ""})`,
        dataType: { kind: "string" },
    };
}

function compileArraySlice(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length > 2) {
        lowerer.context.fail(call, "Array.slice expects zero, one, or two arguments.");
    }
    const begin = call.arguments[0]
        ? lowerer.context.compileNumber(call.arguments[0], "double")
        : "0.0";
    const end = call.arguments[1]
        ? lowerer.context.compileNumber(call.arguments[1], "double")
        : `static_cast<double>(${narrowed.cpp}.size())`;
    return {
        kind: "data",
        cpp: `bbl::js::array_slice(${narrowed.cpp}, ${begin}, ${end})`,
        dataType,
    };
}

function compileArraySort(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length !== 1) {
        lowerer.context.fail(call, "Array.sort currently requires one comparator callback.");
    }
    const callback = lowerer.context.unwrap(argumentAt(call, 0));
    if (!ts.isIdentifier(callback) &&
        !ts.isArrowFunction(callback) &&
        !ts.isFunctionExpression(callback)) {
        lowerer.context.fail(callback, "Array.sort requires a local function or function literal comparator.");
    }
    const result = lowerer.context.allocateTemporaryCppName("sort_result");
    const left = lowerer.context.allocateTemporaryCppName("sort_left");
    const right = lowerer.context.allocateTemporaryCppName("sort_right");
    lowerer.context.emit({ kind: "declaration", type: "auto", name: result, initializer: narrowed.cpp });
    lowerer.context.emit(`std::sort(${result}.begin(), ${result}.end(), [&](const auto& ${left}, const auto& ${right}) {`);
    lowerer.context.increaseIndent();
    lowerer.context.pushScope(lowerer.context.allocateBlockPrefix());
    try {
        lowerer.context.enterRuntimeIteration();
        try {
            const compared = lowerer.context.compileCallbackWithValues(callback, [
                { ...lowerer.leafValue(left, dataType.element), nativeCaptures: [lowerer.context.registerNativeBinding(left)] },
                { ...lowerer.leafValue(right, dataType.element), nativeCaptures: [lowerer.context.registerNativeBinding(right)] },
            ], call);
            if (compared.kind !== "number") {
                lowerer.context.fail(callback, "Array.sort comparator must return a number.");
            }
            lowerer.context.emit(`return ${compared.cpp} < 0.0;`);
        }
        finally {
            lowerer.context.leaveRuntimeIteration();
        }
    }
    finally {
        lowerer.context.popScope();
        lowerer.context.decreaseIndent();
    }
    lowerer.context.emit("});");
    lowerer.registerLocal(result, "owned");
    return { kind: "data", cpp: result, dataType };
}

function compileArrayFind(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    const resultType = lowerer.dataTypeAt(call) ?? {
        kind: "optional" as const,
        inner: dataType.element,
    };
    const result = lowerer.context.allocateTemporaryCppName("find_result");
    lowerer.emitArrayCallbackLoop(call, "find", narrowed, dataType, false, () => lowerer.context.emit(`${lowerer.context.dataTypes.cppType(resultType)} ${result}{};`), (matched, callback, source, index) => {
        if (matched.kind !== "boolean") {
            lowerer.context.fail(callback, "Array.find callback must return a boolean value.");
        }
        lowerer.context.emit(`if (${matched.cpp}) {`);
        lowerer.context.increaseIndent();
        lowerer.context.emit(`${result} = ${source}[${index}];`);
        lowerer.context.emit("break;");
        lowerer.context.decreaseIndent();
        lowerer.context.emit("}");
    });
    lowerer.registerLocal(result, "owned");
    return lowerer.leafValue(result, resultType);
}

function compileArrayFindIndex(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    const result = lowerer.context.allocateTemporaryCppName("find_index_result");
    lowerer.emitArrayCallbackLoop(call, "findIndex", narrowed, dataType, false, () => lowerer.context.emit({ kind: "declaration", type: "double", name: result, initializer: "-1.0" }), (matched, callback, _source, index) => {
        if (matched.kind !== "boolean") {
            lowerer.context.fail(callback, "Array.findIndex callback must return a boolean value.");
        }
        lowerer.context.emit(`if (${matched.cpp}) {`);
        lowerer.context.increaseIndent();
        lowerer.context.emit(`${result} = static_cast<double>(${index});`);
        lowerer.context.emit("break;");
        lowerer.context.decreaseIndent();
        lowerer.context.emit("}");
    });
    return {
        kind: "number",
        cpp: result,
        dataType: { kind: "number" },
    };
}

/** A fresh array can choose its contextual string storage before any aliases exist. */
function arrayResultType(lowerer: DataLowerer, call: ts.CallExpression, fallback?: DataType<"vector">): DataType<"vector"> | undefined {
    const inferred = lowerer.dataTypeAt(call);
    const result = fallback
        ? fallback.element.kind === "optional" && inferred?.kind === "vector" && dataTypesEqual(fallback.element.inner, inferred.element)
            ? inferred : fallback
        : inferred?.kind === "vector" ? inferred : undefined;
    if (!result) return undefined;
    const contextual = lowerer.context.checker.getContextualType(call);
    const destination = contextual ? lowerer.context.dataTypes.fromTsType(contextual, call) : undefined;
    return (destination?.kind === "vector" || destination?.kind === "span") &&
        destination.element.kind === "string" && result.element.kind === "enum"
        ? {kind: "vector", element: destination.element} : result;
}

function compileArrayFilter(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    const filteredType = arrayResultType(lowerer, call, {
        kind: "vector" as const,
        element: dataType.element,
    })!;
    const output = lowerer.context.allocateTemporaryCppName("filter_result");
    lowerer.emitArrayCallbackLoop(call, "filter", narrowed, dataType, false, (source) => {
        lowerer.context.emit(`${lowerer.context.dataTypes.cppType(filteredType)} ${output};`);
        lowerer.context.emit(`${output}.reserve(${source}.size());`);
    }, (matched, callback, source, index) => {
        if (matched.kind !== "boolean") {
            lowerer.context.fail(callback, "Array.filter callback must return a boolean value.");
        }
        lowerer.context.emit(`if (${matched.cpp}) {`);
        lowerer.context.increaseIndent();
        const cpp = `${source}[${index}]`;
        const selected = dataType.element.kind === "optional" && filteredType.element.kind !== "optional"
            ? lowerer.leafValue(`(*${cpp})`, dataType.element.inner) : lowerer.leafValue(cpp, dataType.element);
        lowerer.context.emit(`${output}.push_back(${lowerer.compileKnownValueForSink(selected, filteredType.element, call)});`);
        lowerer.context.decreaseIndent();
        lowerer.context.emit("}");
    });
    lowerer.registerLocal(output, "owned");
    return {
        kind: "data",
        cpp: output,
        dataType: filteredType,
    };
}

function compileArrayReduce(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length !== 2) {
        lowerer.context.fail(call, "Array.reduce currently requires a callback and an initial value.");
    }
    const callback = lowerer.context.unwrap(argumentAt(call, 0));
    if (!ts.isIdentifier(callback) &&
        !ts.isArrowFunction(callback) &&
        !ts.isFunctionExpression(callback)) {
        lowerer.context.fail(callback, "Array.reduce requires a local function or function literal callback.");
    }
    const resultType = lowerer.dataTypeAt(call);
    if (!resultType) {
        lowerer.context.fail(call, "Array.reduce accumulator must belong to the native data model.");
    }
    const source = lowerer.context.allocateTemporaryCppName("reduce_source");
    const count = lowerer.context.allocateTemporaryCppName("reduce_count");
    const index = lowerer.context.allocateTemporaryCppName("reduce_index");
    const accumulator = lowerer.context.allocateTemporaryCppName("reduce_result");
    lowerer.context.emit({ kind: "declaration", type: "auto&&", name: source, initializer: narrowed.cpp });
    lowerer.context.emit({ kind: "declaration", type: "const std::size_t", name: count, initializer: `${source}.size()` });
    lowerer.context.emit({ kind: "declaration", type: lowerer.context.dataTypes.cppType(resultType), name: accumulator, initializer: lowerer.compileForSink(argumentAt(call, 1), resultType) });
    lowerer.context.emit(`for (std::size_t ${index} = 0; ${index} < ${count}; ++${index}) {`);
    lowerer.context.increaseIndent();
    lowerer.context.pushScope(lowerer.context.allocateBlockPrefix());
    try {
        lowerer.context.enterRuntimeIteration();
        try {
            const reduced = lowerer.context.compileCallbackWithValues(callback, [
                { ...lowerer.leafValue(accumulator, resultType), nativeCaptures: [lowerer.context.registerNativeBinding(accumulator)] },
                { ...lowerer.leafValue(`${source}[${index}]`, dataType.element),
                    nativeCaptures: [lowerer.context.registerNativeBinding(source), lowerer.context.registerNativeBinding(index)] },
                {
                    kind: "number",
                    cpp: `static_cast<double>(${index})`,
                    dataType: { kind: "number" },
                    nativeCaptures: [lowerer.context.registerNativeBinding(index)],
                },
                {
                    ...nativeDataMetadata(narrowed),
                    kind: "data",
                    cpp: source,
                    dataType,
                    nativeCaptures: [lowerer.context.registerNativeBinding(source)],
                },
            ], call);
            lowerer.context.emit(`${accumulator} = ${lowerer.compileKnownValueForSink(reduced, resultType, callback)};`);
        }
        finally {
            lowerer.context.leaveRuntimeIteration();
        }
    }
    finally {
        lowerer.context.popScope();
        lowerer.context.decreaseIndent();
    }
    lowerer.context.emit("}");
    lowerer.registerLocal(accumulator, "owned");
    return lowerer.leafValue(accumulator, resultType);
}

function compileArraySome(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    const result = lowerer.context.allocateTemporaryCppName("some_result");
    lowerer.emitArrayCallbackLoop(call, "some", narrowed, dataType, false, () => lowerer.context.emit({ kind: "declaration", type: "bool", name: result, initializer: "false" }), (matched, callback) => {
        if (matched.kind !== "boolean") {
            lowerer.context.fail(callback, "Array.some callback must return a boolean value.");
        }
        lowerer.context.emit(`if (${matched.cpp}) {`);
        lowerer.context.increaseIndent();
        lowerer.context.emit(`${result} = true;`);
        lowerer.context.emit("break;");
        lowerer.context.decreaseIndent();
        lowerer.context.emit("}");
    });
    return {
        kind: "boolean",
        cpp: result,
        dataType: { kind: "boolean" },
    };
}

function compileArrayEvery(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    const result = lowerer.context.allocateTemporaryCppName("every_result");
    lowerer.emitArrayCallbackLoop(call, "every", narrowed, dataType, false, () => lowerer.context.emit({ kind: "declaration", type: "bool", name: result, initializer: "true" }), (matched, callback) => {
        if (matched.kind !== "boolean") {
            lowerer.context.fail(callback, "Array.every callback must return a boolean value.");
        }
        lowerer.context.emit(`if (!(${matched.cpp})) {`);
        lowerer.context.increaseIndent();
        lowerer.context.emit(`${result} = false;`);
        lowerer.context.emit("break;");
        lowerer.context.decreaseIndent();
        lowerer.context.emit("}");
    });
    return {
        kind: "boolean",
        cpp: result,
        dataType: { kind: "boolean" },
    };
}

function compileArrayMap(state: ArrayMethodState, method: "map" | "flatMap"): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    const mappedType = state.expectedResult ?? arrayResultType(lowerer, call);
    if (mappedType?.kind !== "vector") {
        lowerer.context.fail(call, `Array.${method} callback results must belong to the native data model.`);
    }
    const callback = call.arguments[0]
        ? lowerer.context.unwrap(call.arguments[0])
        : undefined;
    if (method === "map" && call.arguments.length === 1 &&
        callback &&
        ts.isIdentifier(callback) &&
        callback.text === "Number" &&
        !lowerer.context.lookupIdentifierValue(callback) &&
        mappedType.element.kind === "number" &&
        (dataType.element.kind === "string" ||
            dataType.element.kind === "number")) {
        const source = lowerer.context.allocateTemporaryCppName("map_source");
        const index = lowerer.context.allocateTemporaryCppName("map_index");
        const output = lowerer.context.allocateTemporaryCppName("map_result");
        lowerer.context.emit({ kind: "declaration", type: "auto&&", name: source, initializer: narrowed.cpp });
        lowerer.context.emit(`bbl::js::Array<double> ${output};`);
        lowerer.context.emit(`${output}.reserve(${source}.size());`);
        lowerer.context.emit(`for (std::size_t ${index} = 0; ${index} < ${source}.size(); ++${index}) {`);
        lowerer.context.increaseIndent();
        const converted = dataType.element.kind === "string"
            ? `bbl::js::number_from_string(${source}[${index}])`
            : `static_cast<double>(${source}[${index}])`;
        lowerer.context.emit(`${output}.push_back(${converted});`);
        lowerer.context.decreaseIndent();
        lowerer.context.emit("}");
        lowerer.registerLocal(output, "owned");
        return {
            kind: "data",
            cpp: output,
            dataType: mappedType,
        };
    }
    const output = lowerer.context.allocateTemporaryCppName("map_result");
    lowerer.emitArrayCallbackLoop(call, method, narrowed, dataType, true, (source) => {
        lowerer.context.emit(`bbl::js::Array<${lowerer.context.dataTypes.cppType(mappedType.element)}> ${output};`);
        lowerer.context.emit(`${output}.reserve(${source}.size());`);
    }, (result, callback) => {
        if (method === "flatMap" && (result.kind === "tuple" || result.dataType?.kind === "tuple" ||
            result.dataType?.kind === "vector" || result.dataType?.kind === "span")) {
            if (lowerer.context.dataTypes.carriesBorrowedPlatformEvent(mappedType.element))
                lowerer.context.refuseBorrowedPlatformEventEscape(result, callback, "Array.flatMap result");
            const values = lowerer.compileKnownValueForSink(result, mappedType, callback);
            lowerer.context.emit(`bbl::js::array_append(${output}, ${values});`);
            return;
        }
        let value: string;
        if (result.kind === "void" &&
            mappedType.element.kind === "boolean") {
            // Promise<void> is represented by its synchronous
            // settlement token. The callback body has already
            // run; preserve a concise call expression too, then
            // store the fulfilled token consumed by Promise.all.
            if (result.cpp.length > 0) {
                lowerer.context.emit(`${result.cpp};`);
            }
            value = "true";
        }
        else {
            if (lowerer.context.dataTypes.carriesBorrowedPlatformEvent(mappedType.element)) {
                lowerer.context.refuseBorrowedPlatformEventEscape(result, callback, "Array.map result");
            }
            value = lowerer.compileKnownValueForSink(result, mappedType.element, callback);
        }
        lowerer.context.emit(`${output}.push_back(${value});`);
    });
    lowerer.registerLocal(output, "owned");
    return {
        kind: "data",
        cpp: output,
        dataType: mappedType,
    };
}

function compileArrayForEach(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    lowerer.emitArrayCallbackLoop(call, "forEach", narrowed, dataType, true, () => undefined, (result) => lowerer.context.emitDiscardedValue(result));
    return { kind: "void", cpp: "" };
}

function compileArrayPush(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType, dynamicOwner } = state;
    if (call.arguments.length === 0) {
        lowerer.context.fail(call, "Array push requires at least one element.");
    }
    lowerer.invalidateAliases(narrowed.cpp);
    const pushedHandleKind = dataType.element.kind === "handle"
        ? dataType.element.handle
        : undefined;
    const hasSpread = call.arguments.some((argument) => ts.isSpreadElement(argument));
    const staticElements = narrowed.staticElementsOwner?.staticElements ??
        narrowed.staticElements;
    const pushedValues = (pushedHandleKind || staticElements) && !hasSpread
        ? call.arguments.map((argument) => {
            const value = lowerer.context.compileValue(argument);
            // A static snapshot owns the value selected at push, including
            // creation calls and a mutable source handle that is rebound later.
            if (!pushedHandleKind || !staticElements) return value;
            const snapshot = { ...value };
            delete snapshot.nativeBinding;
            return lowerer.context.pinValueToTemporary(snapshot, "array_handle", argument);
        })
        : undefined;
    let added: number | undefined = 0;
    for (const argument of call.arguments) {
        const count = ts.isSpreadElement(argument)
            ? lowerer.context.knownCollectionCardinality(argument.expression)
            : 1;
        if (count === undefined) {
            added = undefined;
            break;
        }
        added += count;
    }
    const knownPush = lowerer.context.recordArrayPush(narrowed, added);
    // A snapshot consumed by a later static iteration must be
    // path-complete. Intrinsics record their own generation-time reach
    // while the pushed arguments are compiled, so handles created behind
    // a runtime branch do not need to remain in this array snapshot.
    // Keeping one there would leak its block-local C++ name into code
    // emitted after the branch.
    if (knownPush && !lowerer.context.isInRuntimeControlFlow() &&
        staticElements &&
        pushedValues?.every((value) => (!pushedHandleKind ||
            value.kind === pushedHandleKind) &&
            !value.runtimeIteration)) {
        const firstIndex = staticElements.length;
        const snapshotCpp = (narrowed.staticElementsOwner ?? narrowed).cpp;
        staticElements.push(...pushedValues.map((value, index) => {
            if (pushedHandleKind)
                return value;
            // A pushed object literal is a compile-time record,
            // but the array stores a native element. Keep the
            // record's static facts while rebasing its identity
            // and every later writable path to that stored slot.
            return withNativeMetadata(lowerer.leafValue(`${snapshotCpp}[${firstIndex + index}]`, dataType.element), value);
        }));
    }
    else {
        if (pushedHandleKind && pushedValues?.length) {
            const snapshotOwner = narrowed.staticElementsOwner ?? narrowed;
            snapshotOwner.runtimeElementTemplate ??=
                staticElements?.[0] ?? pushedValues[0]!;
            if (pushedHandleKind === "mesh") {
                const candidates = [
                    snapshotOwner.runtimeElementTemplate,
                    ...(staticElements ?? []),
                    ...pushedValues,
                ];
                snapshotOwner.runtimeElementTemplate = commonResourceValue(runtimeMeshValue(snapshotOwner.runtimeElementTemplate), candidates);
            }
            else if (pushedHandleKind === "material") {
                snapshotOwner.runtimeElementTemplate = commonResourceValue(snapshotOwner.runtimeElementTemplate, [snapshotOwner.runtimeElementTemplate, ...(staticElements ?? []), ...pushedValues]);
            }
        }
        lowerer.invalidateStaticElements(narrowed, true);
        // `compileDataPath(..., "write")` may return a leaf wrapper
        // around an identifier binding. Invalidate the binding too;
        // otherwise a later for-of still sees the initializer's
        // stale static snapshot (notably `[]`) and erases a spread
        // append of a loaded asset's meshes.
        if (dynamicOwner) {
            lowerer.invalidateStaticElements(dynamicOwner, true);
        }
    }
    const pushes = call.arguments.map((argument, index) => {
        if (ts.isSpreadElement(argument)) {
            const spread = lowerer.context.compileValue(argument.expression);
            if (lowerer.context.dataTypes.carriesBorrowedPlatformEvent(dataType.element)) {
                lowerer.context.refuseBorrowedPlatformEventEscape(spread, argument, "Array.push spread");
            }
            if (spread.kind === "tuple" &&
                spread.tupleElements) {
                const values = spread.tupleElements.map((value) => lowerer.compileKnownValueForSink(value, dataType.element, argument));
                return (`${narrowed.cpp}.insert(${narrowed.cpp}.end(), ` +
                    `{${values.join(", ")}})`);
            }
            let source: string;
            if (spread.kind === "handle-collection" &&
                spread.handleCollection &&
                dataType.element.kind === "handle" &&
                spread.handleCollection.elementKind ===
                    dataType.element.handle) {
                source = spread.handleCollection.containerCpp;
            }
            else if (spread.kind === "data" &&
                ((spread.dataType?.kind === "vector" ||
                    spread.dataType?.kind === "span") &&
                    dataTypesEqual(spread.dataType.element, dataType.element) ||
                    spread.dataType?.kind === "tuple" &&
                        dataType.element.kind === "number")) {
                source = spread.cpp;
            }
            else {
                lowerer.context.fail(argument, `Array.push spread must contain values of the destination element type ${JSON.stringify(dataType.element)}; received ${spread.kind} ${spread.dataType ? JSON.stringify(spread.dataType) : "without a data type"}.`);
            }
            return (`${narrowed.cpp}.insert(${narrowed.cpp}.end(), ` +
                `${source}.begin(), ${source}.end())`);
        }
        if (pushedValues &&
            lowerer.context.dataTypes.carriesBorrowedPlatformEvent(dataType.element)) {
            lowerer.context.refuseBorrowedPlatformEventEscape(pushedValues[index]!, argument, "Array.push");
        }
        return `${narrowed.cpp}.push_back(${pushedValues
            ? lowerer.compileKnownValueForSink(pushedValues[index]!, dataType.element, argument)
            : lowerer.compileForRetainedSink(argument, dataType.element, "Array.push")})`;
    });
    return {
        kind: "void",
        cpp: pushes.length === 1
            ? pushes[0]!
            : `(${pushes.join(", ")})`,
    };
}

function compileArrayPop(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length !== 0) {
        lowerer.context.fail(call, "Array.pop expects no arguments.");
    }
    lowerer.invalidateAliases(narrowed.cpp);
    const popped = `bbl::js::array_pop(${narrowed.cpp})`;
    return lowerer.leafValue(popped, dataType.element);
}

function compileArrayShift(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length !== 0) {
        lowerer.context.fail(call, "Array.shift expects no arguments.");
    }
    lowerer.invalidateAliases(narrowed.cpp);
    return lowerer.leafValue(`bbl::js::array_shift(${narrowed.cpp})`, dataType.element);
}

function compileArrayUnshift(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length === 0) {
        return {
            kind: "number",
            cpp: `static_cast<double>(${narrowed.cpp}.size())`,
        };
    }
    lowerer.invalidateAliases(narrowed.cpp);
    const values = call.arguments.map((argument) => lowerer.compileForRetainedSink(argument, dataType.element, "Array.unshift"));
    return {
        kind: "number",
        cpp: `bbl::js::array_unshift(${narrowed.cpp}, ` +
            `{${values.join(", ")}})`,
    };
}

function compileArrayReverse(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length !== 0) {
        lowerer.context.fail(call, "Array.reverse expects no arguments.");
    }
    lowerer.invalidateAliases(narrowed.cpp);
    return {
        kind: "data",
        cpp: `bbl::js::array_reverse(${narrowed.cpp})`,
        dataType,
    };
}

function compileMapDataMethod(lowerer: DataLowerer, call: ts.CallExpression, callee: ts.PropertyAccessExpression, method: string, narrowed: Value, dataType: DataType & {kind: "map"}): Value | undefined {
    if (method === "forEach")
        return compileCollectionForEach(lowerer, call, narrowed, dataType);
    lowerer.context.reachJsData();
    if (method === "clear") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(call, "Map.clear expects no arguments.");
        }
        lowerer.context.recordCollectionClear(narrowed);
        if (lowerer.context.isInRuntimeControlFlow()) {
            lowerer.context.invalidateRecordProperties(narrowed);
        }
        else if (narrowed.recordProperties) {
            for (const key of Object.keys(narrowed.recordProperties)) {
                delete narrowed.recordProperties[key];
            }
        }
        return {
            kind: "void",
            cpp: `${narrowed.cpp}.clear()`,
        };
    }
    if (method === "has" || method === "get" || method === "delete") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(call, `Map.${method} expects exactly one key.`);
        }
        const keyValue = lowerer.context.compileValue(argumentAt(call, 0));
        const key = lowerer.compileKnownValueForSink(keyValue, dataType.key, argumentAt(call, 0));
        const staticKey = keyValue.staticString ??
            (keyValue.staticNumber !== undefined
                ? String(keyValue.staticNumber)
                : undefined);
        if (method === "has") {
            return {
                kind: "boolean",
                cpp: `${narrowed.cpp}.has(${key})`,
            };
        }
        if (method === "delete") {
            lowerer.context.recordCollectionKey(narrowed, keyValue, true);
            if (lowerer.context.isInRuntimeControlFlow()) {
                lowerer.context.invalidateRecordProperties(narrowed);
            }
            else if (staticKey !== undefined &&
                narrowed.recordProperties) {
                delete narrowed.recordProperties[staticKey];
            }
            else if (staticKey === undefined) {
                lowerer.context.invalidateRecordProperties(narrowed);
            }
            return {
                kind: "boolean",
                cpp: `${narrowed.cpp}.erase(${key})`,
                requiresExplicitDiscard: true,
            };
        }
        if (dataType.value.kind === "handle") {
            const result = lowerer.context.allocateTemporaryCppName("map_get");
            lowerer.context.emit({ kind: "declaration", type: "const auto", name: result, initializer: `${narrowed.cpp}.get(${key})` });
            const known = staticKey === undefined
                ? undefined
                : narrowed.recordProperties?.[staticKey];
            return { ...withNativeMetadata(lowerer.leafValue(`(*${result})`, dataType.value), known), optionalFoundCpp: `${result}.has_value()`, optionalStorageCpp: `${result}.to_optional()` };
        }
        if (dataType.value.kind === "struct" &&
            lowerer.context.dataTypes.isReferenceStruct(dataType.value.name)) {
            // Shared object handles carry absence themselves. Do
            // not wrap and immediately dereference Map.get: a miss
            // must remain an empty handle for the source guard.
            return {
                ...lowerer.leafValue(`${narrowed.cpp}.get(${key})`, dataType.value),
            };
        }
        return {
            kind: "data",
            cpp: `${narrowed.cpp}.get(${key})`,
            // TypeScript flattens `(T | null) | undefined` to one
            // nullable union. Preserve that shape so a single
            // source guard narrows a Map whose value is nullable.
            dataType: dataType.value.kind === "optional"
                ? dataType.value
                : {
                    kind: "optional",
                    inner: dataType.value,
                },
        };
    }
    if (method === "set") {
        if (call.arguments.length !== 2) {
            lowerer.context.fail(call, "Map.set expects exactly one key and one value.");
        }
        const keyValue = lowerer.context.compileValue(argumentAt(call, 0));
        const assignedValue = lowerer.context.compileValue(argumentAt(call, 1));
        lowerer.context.recordCollectionKey(narrowed, keyValue);
        if (lowerer.context.dataTypes.carriesBorrowedPlatformEvent(dataType.key)) {
            lowerer.context.refuseBorrowedPlatformEventEscape(keyValue, argumentAt(call, 0), "Map.set key");
        }
        if (lowerer.context.dataTypes.carriesBorrowedPlatformEvent(dataType.value)) {
            lowerer.context.refuseBorrowedPlatformEventEscape(assignedValue, argumentAt(call, 1), "Map.set value");
        }
        const key = lowerer.compileKnownValueForSink(keyValue, dataType.key, argumentAt(call, 0));
        const value = lowerer.compileKnownValueForSink(assignedValue, dataType.value, argumentAt(call, 1));
        const staticKey = keyValue.staticString ??
            (keyValue.staticNumber !== undefined
                ? String(keyValue.staticNumber)
                : undefined);
        if (lowerer.context.isInRuntimeControlFlow()) {
            lowerer.context.invalidateRecordProperties(narrowed);
        }
        else if (staticKey !== undefined &&
            narrowed.recordProperties) {
            narrowed.recordProperties[staticKey] = assignedValue;
        }
        else if (staticKey === undefined) {
            lowerer.context.invalidateRecordProperties(narrowed);
        }
        return {
            kind: "data",
            cpp: `${narrowed.cpp}.set(${key}, ${value})`,
            dataType,
            ...(narrowed.collectionCardinality ? { collectionCardinality: narrowed.collectionCardinality } : {}),
            ...(narrowed.recordProperties
                ? {
                    recordProperties: narrowed.recordProperties,
                }
                : {}),
        };
    }
    if (method === "entries") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(call, "Map.entries expects no arguments.");
        }
        // The entry iterator yields the map's own [key, value] pairs in
        // insertion order, which is what iterating the map yields.
        return narrowed;
    }
    if (method === "values" || method === "keys") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(call, `Map.${method} expects no arguments.`);
        }
        return {
            kind: "data",
            cpp: `bbl::js::map_${method}(${narrowed.cpp})`,
            dataType: {
                kind: "vector",
                element: method === "values"
                    ? dataType.value
                    : dataType.key,
            },
            freshData: true,
        };
    }
    lowerer.context.fail(callee.name, `Map method '${method}' is not supported.`);
}

function compileSetDataMethod(lowerer: DataLowerer, call: ts.CallExpression, callee: ts.PropertyAccessExpression, method: string, narrowed: Value, dataType: DataType & {kind: "set"}): Value | undefined {
    if (method === "forEach")
        return compileCollectionForEach(lowerer, call, narrowed, dataType);
    if (method === "values" || method === "keys") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(call, `Set.${method} expects no arguments.`);
        }
        // Both iterators yield the set's own members in insertion order,
        // which is what iterating the set yields.
        return narrowed;
    }
    lowerer.context.reachJsData();
    if (method === "clear") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(call, "Set.clear expects no arguments.");
        }
        lowerer.context.recordCollectionClear(narrowed);
        return {
            kind: "void",
            cpp: `${narrowed.cpp}.clear()`,
        };
    }
    if (method === "has" || method === "delete") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(call, `Set.${method} expects exactly one value.`);
        }
        const member = lowerer.context.compileValue(argumentAt(call, 0));
        const value = lowerer.compileKnownValueForSink(member, dataType.element, argumentAt(call, 0));
        if (method === "delete")
            lowerer.context.recordCollectionKey(narrowed, member, true);
        return {
            kind: "boolean",
            cpp: method === "has"
                ? `${narrowed.cpp}.has(${value})`
                : `${narrowed.cpp}.erase(${value})`,
            ...(method === "delete"
                ? { requiresExplicitDiscard: true }
                : {}),
        };
    }
    if (method === "add") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(call, "Set.add expects exactly one value.");
        }
        const member = lowerer.context.compileValue(argumentAt(call, 0));
        if (lowerer.context.dataTypes.carriesBorrowedPlatformEvent(dataType.element)) {
            lowerer.context.refuseBorrowedPlatformEventEscape(member, argumentAt(call, 0), "Set.add");
        }
        const value = lowerer.compileKnownValueForSink(member, dataType.element, argumentAt(call, 0));
        lowerer.context.recordCollectionKey(narrowed, member);
        return {
            kind: "data",
            cpp: `${narrowed.cpp}.add(${value})`,
            dataType,
            ...(narrowed.collectionCardinality ? { collectionCardinality: narrowed.collectionCardinality } : {}),
        };
    }
    lowerer.context.fail(callee.name, `Set method '${method}' is not supported.`);
}

function compileStringDataMethod(lowerer: DataLowerer, call: ts.CallExpression, _callee: ts.PropertyAccessExpression, method: string, narrowed: Value, _dataType: DataType & {kind: "string"}): Value | undefined {
    lowerer.context.reachJsData();
    const stringValue = compileStringValueMethod(lowerer, call, method, narrowed);
    if (stringValue)
        return stringValue;
    if (method === "match" || method === "matchAll") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(call, `String.${method} expects one RegExp argument.`);
        }
        const pattern = lowerer.context.compileValue(argumentAt(call, 0));
        if (pattern.kind !== "regexp") {
            lowerer.context.fail(argumentAt(call, 0), `Reached String.${method} uses a RegExp pattern.`);
        }
        const matches = {
            kind: "vector",
            element: { kind: "string" },
        } as const;
        return method === "match"
            ? {
                kind: "data",
                cpp: `${pattern.cpp}.match(${narrowed.cpp})`,
                dataType: {
                    kind: "optional",
                    inner: matches,
                },
            }
            : {
                kind: "data",
                cpp: `${pattern.cpp}.match_all(${narrowed.cpp})`,
                dataType: {
                    kind: "vector",
                    element: matches,
                },
                freshData: true,
            };
    }
    if (method === "indexOf" || method === "includes") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(call, `String.${method} expects one argument; the fromIndex form is outside the supported subset.`);
        }
        const search = lowerer.compileForSink(argumentAt(call, 0), { kind: "string" });
        const index = `bbl::js::string_index_of(${narrowed.cpp}, ${search})`;
        return method === "indexOf"
            ? {
                kind: "number",
                cpp: index,
                dataType: { kind: "number" },
            }
            : {
                kind: "boolean",
                cpp: `${index} >= 0.0`,
                dataType: { kind: "boolean" },
            };
    }
    if (method === "toUpperCase") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(call, "String.toUpperCase takes no arguments.");
        }
        return {
            kind: "data",
            cpp: `bbl::js::string_upper(${narrowed.cpp})`,
            dataType: { kind: "string" },
        };
    }
    if (method === "toLowerCase") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(call, "String.toLowerCase takes no arguments.");
        }
        return {
            kind: "data",
            cpp: `bbl::js::string_lower(${narrowed.cpp})`,
            dataType: { kind: "string" },
        };
    }
    if (method === "trim") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(call, "String.trim takes no arguments.");
        }
        return {
            kind: "data",
            cpp: `bbl::js::string_trim(${narrowed.cpp})`,
            dataType: { kind: "string" },
        };
    }
    if (method === "slice") {
        if (call.arguments.length < 1 || call.arguments.length > 2) {
            lowerer.context.fail(call, "String.slice expects one or two arguments.");
        }
        const staticBegin = lowerer.context.compileValue(argumentAt(call, 0));
        const staticEnd = call.arguments[1]
            ? lowerer.context.compileValue(call.arguments[1])
            : undefined;
        if (narrowed.staticString !== undefined &&
            staticBegin.kind === "number" &&
            staticBegin.staticNumber !== undefined &&
            !staticBegin.parameterBinding &&
            (staticEnd === undefined ||
                (staticEnd.kind === "number" &&
                    staticEnd.staticNumber !== undefined &&
                    !staticEnd.parameterBinding))) {
            const value = narrowed.staticString.slice(staticBegin.staticNumber, staticEnd?.staticNumber);
            return {
                kind: "string",
                cpp: lowerer.context.cppString(value),
                staticString: value,
                dataType: { kind: "string" },
            };
        }
        const begin = lowerer.context.castNumber(staticBegin, "double");
        const end = staticEnd
            ? lowerer.context.castNumber(staticEnd, "double")
            : `static_cast<double>(${narrowed.cpp}.size())`;
        return {
            kind: "data",
            cpp: `bbl::js::string_slice(${narrowed.cpp}, ${begin}, ${end})`,
            dataType: { kind: "string" },
        };
    }
    if (method === "split") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(call, "String.split expects one separator.");
        }
        const separatorValue = lowerer.context.compileValue(argumentAt(call, 0));
        if (separatorValue.kind === "regexp") {
            return {
                kind: "data",
                cpp: `${separatorValue.cpp}.split(${narrowed.cpp})`,
                dataType: {
                    kind: "vector",
                    element: { kind: "string" },
                },
            };
        }
        const separator = lowerer.compileForSink(argumentAt(call, 0), { kind: "string" });
        return {
            kind: "data",
            cpp: `bbl::js::string_split(${narrowed.cpp}, ${separator})`,
            dataType: {
                kind: "vector",
                element: { kind: "string" },
            },
        };
    }
    if (method === "replace" || method === "replaceAll") {
        if (call.arguments.length !== 2) {
            lowerer.context.fail(call, "String.replace expects a pattern and replacement.");
        }
        const snapshot = (value: Value, label: string): string => {
            if (value.staticString !== undefined && value.cpp === lowerer.context.cppString(value.staticString)) return value.cpp;
            const name = lowerer.context.allocateTemporaryCppName(label);
            lowerer.context.emit({ kind: "declaration", type: "const std::string", name, initializer: value.cpp, attributes: "[[maybe_unused]] " });
            return name;
        };
        const source = snapshot(narrowed, "replace_source");
        const pattern = lowerer.context.compileValue(argumentAt(call, 0));
        if (pattern.kind === "string" || pattern.dataType?.kind === "string") {
            const search = snapshot(pattern, "replace_search");
            const replacementValue = lowerer.context.compileValue(argumentAt(call, 1));
            if (replacementValue.kind === "callback" || replacementValue.dataType?.kind === "function") {
                const callbackType: DataType<"function"> = {
                    kind: "function", parameters: [{kind: "string"}, {kind: "number"}, {kind: "string"}], result: {kind: "string"},
                };
                let storedCallback: Value | undefined;
                if (replacementValue.dataType?.kind === "function") {
                    const stored = lowerer.context.allocateTemporaryCppName("replacement_callback");
                    lowerer.context.emit(`const auto ${stored} = ${replacementValue.cpp};`);
                    storedCallback = {...replacementValue, cpp: stored, nativeCaptures: [lowerer.context.registerNativeBinding(stored)]};
                }
                const adapter = lowerer.context.allocateTemporaryCppName("replacement_invoke");
                const supplied = callbackType.parameters.map(type => lowerer.leafValue(lowerer.context.allocateTemporaryCppName("replacement_arg"), type));
                const parameters = supplied.map(value => `[[maybe_unused]] ${lowerer.context.dataTypes.cppType(value.dataType!)} ${value.cpp}`).join(", ");
                lowerer.context.emit(`const auto ${adapter} = [&](${parameters}) -> std::string {`);
                lowerer.context.increaseIndent();
                lowerer.context.pushScope(lowerer.context.allocateBlockPrefix());
                lowerer.context.enterRuntimeControlFlow();
                lowerer.context.enterRuntimeIteration();
                try {
                    const arguments_ = supplied.map(value => ({...value, nativeCaptures: [lowerer.context.registerNativeBinding(value.cpp)]}));
                    const invoke = () => replacementValue.callbackDeclaration
                        ? lowerer.context.compileCallbackWithValues(replacementValue.callbackDeclaration, arguments_, call)
                        : lowerer.context.fail(call, "String replacement requires a callable value.");
                    const result = storedCallback ? lowerer.compileFunctionValueCall(storedCallback, arguments_, call)
                        : replacementValue.callbackRecordOwner ? lowerer.context.withRecordScopes(replacementValue.callbackRecordOwner, invoke) : invoke();
                    lowerer.context.emit(`return ${lowerer.compileKnownValueForSink(result, {kind: "string"}, call)};`);
                } finally {
                    lowerer.context.leaveRuntimeIteration();
                    lowerer.context.leaveRuntimeControlFlow();
                    lowerer.context.popScope();
                    lowerer.context.decreaseIndent();
                }
                lowerer.context.emit("};");
                return lowerer.leafValue(`bbl::js::string_replace_with(${source}, ${search}, ${adapter}, ${method === "replaceAll"})`, {kind: "string"});
            }
            if (narrowed.staticString !== undefined && pattern.staticString !== undefined && replacementValue.staticString !== undefined) {
                const value = method === "replaceAll"
                    ? narrowed.staticString.replaceAll(pattern.staticString, replacementValue.staticString)
                    : narrowed.staticString.replace(pattern.staticString, replacementValue.staticString);
                return { ...lowerer.leafValue(lowerer.context.cppString(value), { kind: "string" }), staticString: value };
            }
            const replacement = lowerer.compileKnownValueForSink(replacementValue, { kind: "string" }, argumentAt(call, 1));
            return lowerer.leafValue(`bbl::js::string_replace(${source}, ${search}, ${replacement}, ${method === "replaceAll"})`, { kind: "string" });
        }
        if (method === "replaceAll")
            lowerer.context.fail(call, "String.replaceAll currently requires a string pattern.");
        if (pattern.kind !== "regexp") {
            lowerer.context.fail(argumentAt(call, 0), "Reached String.replace uses a RegExp pattern.");
        }
        const replacementValue = lowerer.context.compileValue(argumentAt(call, 1));
        const patternExpression = lowerer.context.unwrap(argumentAt(call, 0));
        if (narrowed.staticString !== undefined &&
            replacementValue.staticString !== undefined &&
            ts.isRegularExpressionLiteral(patternExpression)) {
            const {pattern:source, flags} = regularExpressionParts(patternExpression)!;
            const value = narrowed.staticString.replace(new RegExp(source, flags), replacementValue.staticString);
            return {
                kind: "string",
                cpp: lowerer.context.cppString(value),
                staticString: value,
                dataType: { kind: "string" },
            };
        }
        if (replacementValue.kind !== "string" &&
            !(replacementValue.kind === "data" &&
                replacementValue.dataType?.kind === "string")) {
            lowerer.context.fail(argumentAt(call, 1), "String.replace expects a string replacement.");
        }
        const replacement = replacementValue.cpp;
        return {
            kind: "data",
            cpp: `${pattern.cpp}.replace(${source}, ${replacement})`,
            dataType: { kind: "string" },
        };
    }
    if (method === "startsWith") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(call, "String.startsWith expects one argument.");
        }
        const prefixValue = lowerer.context.compileValue(argumentAt(call, 0));
        if (narrowed.staticString !== undefined &&
            prefixValue.staticString !== undefined) {
            const value = narrowed.staticString.startsWith(prefixValue.staticString);
            return {
                kind: "boolean",
                cpp: value ? "true" : "false",
                staticBoolean: value,
                dataType: { kind: "boolean" },
            };
        }
        if (prefixValue.kind !== "string" &&
            !(prefixValue.kind === "data" &&
                prefixValue.dataType?.kind === "string")) {
            lowerer.context.fail(argumentAt(call, 0), "String.startsWith expects a string argument.");
        }
        const prefix = prefixValue.cpp;
        return {
            kind: "boolean",
            cpp: `bbl::js::string_starts_with(${narrowed.cpp}, ${prefix})`,
        };
    }
    if (method === "endsWith") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(call, "String.endsWith expects one argument.");
        }
        const suffix = lowerer.compileForSink(argumentAt(call, 0), { kind: "string" });
        return {
            kind: "boolean",
            cpp: `bbl::js::string_ends_with(${narrowed.cpp}, ${suffix})`,
        };
    }
    if (method === "charCodeAt") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(call, "String.charCodeAt expects one argument.");
        }
        return {
            kind: "number",
            cpp: `bbl::js::string_char_code_at(${narrowed.cpp}, ${lowerer.context.compileNumber(argumentAt(call, 0), "double")})`,
            dataType: { kind: "number" },
        };
    }
    if (method === "padStart" || method === "padEnd") {
        if (call.arguments.length < 1 || call.arguments.length > 2) {
            lowerer.context.fail(call, `String.${method} expects one or two arguments.`);
        }
        const fill = call.arguments[1]
            ? lowerer.compileForSink(call.arguments[1], { kind: "string" })
            : lowerer.context.cppString(" ");
        return {
            kind: "data",
            cpp: `bbl::js::string_pad_${method === "padStart" ? "start" : "end"}(${narrowed.cpp}, ${lowerer.context.compileNumber(argumentAt(call, 0), "double")}, ${fill})`,
            dataType: { kind: "string" },
        };
    }
    if (method === "trimStart" || method === "trimEnd") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(call, `String.${method} takes no arguments.`);
        }
        return {
            kind: "data",
            cpp: `bbl::js::string_trim_${method === "trimStart" ? "start" : "end"}(${narrowed.cpp})`,
            dataType: { kind: "string" },
        };
    }
    if (method === "charAt") {
        if (call.arguments.length > 1) {
            lowerer.context.fail(call, "String.charAt expects at most one index.");
        }
        const index = call.arguments[0]
            ? lowerer.context.compileNumber(argumentAt(call, 0), "double")
            : "0.0";
        return {
            kind: "data",
            cpp: `bbl::js::string_char_at(${narrowed.cpp}, ${index})`,
            dataType: { kind: "string" },
        };
    }
}

/**
 * The DataView accessors: each numeric width as a getter and a setter,
 * spelled natively as `get_<lane>`/`set_<lane>`. Single-byte lanes take
 * no byte-order argument; the wider ones default to big-endian, as the
 * DOM does.
 */
interface DataViewAccessor {
    readonly native: string;
    readonly setter: boolean;
    readonly wide: boolean;
}

const DATA_VIEW_ACCESSORS: ReadonlyMap<string, DataViewAccessor> = new EmissionMap(
    ["Int8", "Uint8", "Int16", "Uint16", "Int32", "Uint32", "Float32", "Float64"].flatMap(
        (lane): Array<[string, DataViewAccessor]> => {
            const native = lane.toLowerCase();
            const wide = !lane.endsWith("8");
            return [
                [`get${lane}`, { native: `get_${native}`, setter: false, wide }],
                [`set${lane}`, { native: `set_${native}`, setter: true, wide }],
            ];
        },
    ),
);

function compileDataViewAccessor(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    narrowed: Value,
    method: string,
    accessor: DataViewAccessor,
): Value {
    const fixed = accessor.setter ? 2 : 1;
    const maximum = fixed + (accessor.wide ? 1 : 0);
    if (call.arguments.length < fixed || call.arguments.length > maximum) {
        lowerer.context.fail(
            call,
            `DataView.${method} expects ${fixed === maximum ? fixed : `${fixed} or ${maximum}`} arguments.`,
        );
    }
    const offset = `bbl::js::array_index(${lowerer.context.compileNumber(argumentAt(call, 0), "double")})`;
    const value = accessor.setter
        ? [lowerer.context.compileNumber(argumentAt(call, 1), "double")]
        : [];
    const littleEndian = accessor.wide
        ? [call.arguments[fixed] ? lowerer.context.compileCondition(call.arguments[fixed]) : "false"]
        : [];
    const cpp = `${narrowed.cpp}.${accessor.native}(${[offset, ...value, ...littleEndian].join(", ")})`;
    if (accessor.setter) {
        return { kind: "void", cpp };
    }
    return {
        kind: "number",
        cpp: `static_cast<double>(${cpp})`,
        dataType: { kind: "number" },
    };
}

/** `array.keys()` as a value: the indices 0 through length - 1, in order. */
function compileArrayKeys({ lowerer, call, narrowed }: ArrayMethodState): Value {
    if (call.arguments.length !== 0) {
        lowerer.context.fail(call, "Array.keys expects no arguments.");
    }
    lowerer.context.reachJsData();
    return {
        kind: "data",
        cpp: `bbl::js::array_keys(${narrowed.cpp})`,
        dataType: { kind: "vector", element: { kind: "number" } },
        freshData: true,
    };
}

const arrayMethodHandlers = new EmissionMap<string, (state: ArrayMethodState) => Value>([
    ["flat", compileArrayFlat],
    ["join", compileArrayJoin],
    ["slice", compileArraySlice],
    ["sort", compileArraySort],
    ["find", compileArrayFind],
    ["findIndex", compileArrayFindIndex],
    ["filter", compileArrayFilter],
    ["reduce", compileArrayReduce],
    ["some", compileArraySome],
    ["every", compileArrayEvery],
    ["map", state => compileArrayMap(state, "map")],
    ["flatMap", state => compileArrayMap(state, "flatMap")],
    ["forEach", compileArrayForEach],
    // The iterator methods outside a for...of range (which walks the
    // array itself): keys is a fresh index list, values the array.
    ["keys", compileArrayKeys],
    ["values", ({ narrowed }) => narrowed],
    ["push", compileArrayPush],
    ["pop", compileArrayPop],
    ["shift", compileArrayShift],
    ["unshift", compileArrayUnshift],
    ["reverse", compileArrayReverse],
]);
