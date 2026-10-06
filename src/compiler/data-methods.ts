import {
    isStringValue,
    nativeDataMetadata,
    optionalPresentCpp,
    withNativeMetadata,
} from "./types.js";
// The data-container method knowledge: the method-name sets every
// mutation walk consults, and the dispatcher that lowers a data-method
// call (invoked through `DataLowerer.compileDataMethodCall`).
import { EmissionSet, EmissionMap, writable } from "./emission-transaction.js";
import {
    mutatingArrayMethods,
    receiverWritingMethods,
} from "./receiver-methods.js";
import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import {
    argumentAt,
    expressionMayRunCode,
    regularExpressionParts,
} from "./syntax.js";
import { staticNumberValue } from "./option-helpers.js";
import { isObjectIdentityFunction } from "./static-evaluator.js";
import {
    captureArrayReceiver,
    compileArrayValueMethod,
} from "./array-methods.js";
import { compileStringValueMethod } from "./string-methods.js";
import { compileDateMethod, compileDateTimeFormatMethod } from "./dates.js";
import { compileHttpResponseMethod } from "./http.js";
import { compileTextCodecMethod } from "./text-codecs.js";
import { compileCollatorMethod } from "./locale.js";
import { compileWeakRefMethod } from "./weak-refs.js";
import {
    compileSearchParamsMethod,
    deploymentSearchParamsValue,
    RuntimeSearchParamsRequired,
} from "./search-params.js";
import { compileCollectionForEach } from "./collection-methods.js";
import { pinOperand } from "./evaluation-order.js";

import {
    dataTypesEqual,
    pinnedHandleKind,
    platformHandleKind,
    isTypedArrayType,
    typedArrayStoreExpression,
    type DataType,
    type TypedArrayKind,
} from "./data-types.js";
import type { DataLowerer } from "./data-lowering.js";
import { isJsonValue } from "./json-bridge.js";
import { commonResourceValue, runtimeMeshValue, type Value } from "./types.js";
import { declarationInDefaultLibrary, libraryGlobal } from "./symbols.js";
import { replacementCallback } from "./string-replacement.js";
import { stringConcatPart } from "./expressions.js";
import { numberConstantValue } from "./number-intrinsics.js";
import {
    absenceKind,
    arrayElementType,
    declaredContextualType,
    isTypeReference,
    nullability,
    slotHoldsOnlyNull,
} from "./type-facts.js";

/**
 * Array and binary-view predicates share the same finite data discrimination.
 * Parsed JSON is dynamic only for Array.isArray.
 */
export function compileArrayPredicateOverData(
    lowerer: DataLowerer,
    call: ts.CallExpression,
): Value | undefined {
    const callee = lowerer.context.unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || call.arguments.length !== 1) {
        return undefined;
    }
    const global = lowerer.context.libraryGlobal(callee.expression);
    const binaryView =
        global === "ArrayBuffer" && callee.name.text === "isView";
    if (!binaryView && !(global === "Array" && callee.name.text === "isArray"))
        return undefined;
    const value = lowerer.context.compileValue(argumentAt(call, 0));
    const decided = (answer: boolean): Value => {
        lowerer.context.emitDiscardedValue(value);
        return {
            kind: "boolean",
            cpp: answer ? "true" : "false",
            staticBoolean: answer,
            dataType: { kind: "boolean" },
        };
    };
    if (value.kind === "tuple") return decided(!binaryView);
    if (
        [
            "record",
            "json-null",
            "number",
            "boolean",
            "string",
            "callback",
            "void",
        ].includes(value.kind)
    )
        return decided(false);
    const optional = value.dataType?.kind === "optional";
    const dataType =
        value.dataType?.kind === "optional"
            ? value.dataType.inner
            : value.dataType;
    if (
        !dataType ||
        dataType.kind === "numberindex" ||
        (dataType.kind === "union" &&
            dataType.members.some((member) => member.kind === "numberindex"))
    )
        return undefined;
    if (dataType.kind === "json" && !optional && !binaryView)
        return {
            kind: "boolean",
            cpp: `${value.cpp}.is_array()`,
            dataType: { kind: "boolean" },
        };
    const matchesType = (type: DataType): boolean =>
        binaryView
            ? isTypedArrayType(type) ||
              type.kind === "dataview" ||
              type.kind === "bufferview"
            : ["vector", "span", "tuple", "product", "table"].includes(
                  type.kind,
              );
    const member = optional ? "(*candidate)" : "candidate";
    const predicate =
        dataType.kind === "json" && !binaryView
            ? `${member}.is_array()`
            : dataType.kind === "union"
              ? `std::array<bool, ${dataType.members.length}>{${dataType.members.map(matchesType).join(", ")}}[${member}.index()]`
              : matchesType(dataType)
                ? "true"
                : "false";
    if (predicate === "false" || (predicate === "true" && !optional))
        return decided(predicate === "true");
    return {
        kind: "boolean",
        cpp: `([](const auto& candidate) { return ${optional ? "candidate.has_value() && " : ""}${predicate}; }(${value.cpp}))`,
        dataType: { kind: "boolean" },
    };
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
    "toReversed",
    "toSorted",
    "values",
    "with",
]);

/** The observing methods a numeric tuple shares with a readonly number array. */
const tupleReadingMethods: ReadonlySet<string> = new EmissionSet(
    [...readOnlyDataMethods].filter(
        (method) => !["entries", "keys", "slice", "values"].includes(method),
    ),
);

interface ArrayCallbackReceiverPolicy {
    readonly snapshotIdentity: boolean;
    readonly skipRemoved: boolean;
    readonly invalidatesFacts: boolean;
}

const existingCallbackReceiver: ArrayCallbackReceiverPolicy = {
    snapshotIdentity: false,
    skipRemoved: false,
    invalidatesFacts: false,
};
const mutableCallbackReceiver: ArrayCallbackReceiverPolicy = {
    snapshotIdentity: true,
    skipRemoved: true,
    invalidatesFacts: true,
};

/** Receiver rules shared by callback emission and source-level fact analysis. */
export function arrayCallbackReceiverPolicy(
    method: string,
): ArrayCallbackReceiverPolicy {
    return method === "flatMap"
        ? mutableCallbackReceiver
        : existingCallbackReceiver;
}

/** Methods that retain argument identity without mutating the argument itself. */
export const storingDataMethods: ReadonlySet<string> = new EmissionSet([
    "add",
    "concat",
    "fill",
    "of",
    "push",
    "resolve",
    "set",
    "splice",
    "unshift",
]);

/** Syntactic retention proof used conservatively by the alias analyses. */
export function isStoringDataCall(
    node: ts.Node,
    checker: ts.TypeChecker,
): node is ts.CallExpression | ts.NewExpression {
    if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node)?.declaration;
        // Resolver signatures originate in the default library constructor,
        // including when the source renames or forwards its executor parameter.
        const parameter = signature?.parent;
        const executor = parameter?.parent?.parent;
        const constructor = executor?.parent;
        if (
            signature &&
            declarationInDefaultLibrary(signature) &&
            parameter &&
            ts.isParameter(parameter) &&
            executor &&
            ts.isParameter(executor) &&
            constructor &&
            ts.isConstructSignatureDeclaration(constructor) &&
            ts.isInterfaceDeclaration(constructor.parent) &&
            constructor.parent.name.text === "PromiseConstructor"
        )
            return true;
    }
    return (
        (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            storingDataMethods.has(node.expression.name.text)) ||
        (ts.isNewExpression(node) &&
            ["Map", "Set"].includes(
                libraryGlobal(checker, node.expression) ?? "",
            ))
    );
}

const constantArrayMethods: ReadonlySet<string> = new EmissionSet([
    "at",
    "concat",
    "lastIndexOf",
    "flatMap",
    "slice",
    "indexOf",
    "includes",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "filter",
    "reduce",
    "reduceRight",
    "some",
    "every",
    "map",
    "forEach",
    "join",
    "toReversed",
    "toSorted",
    "with",
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
export function mayCompileDataMethodCall(
    checker: ts.TypeChecker,
    callee: ts.PropertyAccessExpression,
): boolean {
    const owner = checker.getNonNullableType(
        checker.getTypeAtLocation(callee.expression),
    );
    // Handle methods belong to their platform adapter. Plain records may
    // contain stored callbacks and still need the data-method dispatcher.
    return (
        !pinnedHandleKind(owner) &&
        !platformHandleKind(owner) &&
        (owner.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) ===
            0
    );
}

/** `this` when it is a native plain record (a literal method's home object), not a class instance. */
function plainRecordReceiver(lowerer: DataLowerer): Value | undefined {
    const receiver = lowerer.context.activeThis();
    return receiver?.kind === "data" &&
        receiver.dataType?.kind === "struct" &&
        !lowerer.context.dataTypes.isClassStruct(receiver.dataType.name)
        ? receiver
        : undefined;
}

export function compileDataMethodCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    expectedResult?: DataType<"vector">,
): Value | undefined {
    const callee = lowerer.context.unwrap(call.expression);
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
        method === "get" && ts.isIdentifier(callee.expression)
            ? lowerer.compileModuleMapGet(call, callee.expression)
            : undefined;
    if (moduleMapGet) {
        return moduleMapGet;
    }
    const ownerExpression = lowerer.context.unwrap(callee.expression);
    if (
        (ts.isNewExpression(ownerExpression) ||
            ts.isCallExpression(ownerExpression)) &&
        method === "fill"
    ) {
        const created = lowerer.newArrayInfo(
            ownerExpression,
            expectedResult?.element ??
                (call.arguments[0]
                    ? lowerer.dataTypeAt(call.arguments[0])
                    : undefined),
        );
        if (created) {
            if (call.arguments.length !== 1) {
                lowerer.context.fail(call, "Array.fill expects one argument.");
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
        const typed = ts.isNewExpression(ownerExpression)
            ? lowerer.compileTypedArrayNew(ownerExpression)
            : undefined;
        if (typed?.kind === "data" && isTypedArrayType(typed.dataType)) {
            if (call.arguments.length !== 1) {
                lowerer.context.fail(
                    call,
                    "TypedArray.fill expects one argument.",
                );
            }
            const temporary =
                lowerer.context.allocateTemporaryCppName("filled_array");
            lowerer.context.emit({
                kind: "declaration",
                type: "auto",
                name: temporary,
                initializer: typed.cpp,
            });
            const number = lowerer.context.compileNumber(
                argumentAt(call, 0),
                "double",
            );
            const value = typedArrayStoreExpression(
                typed.dataType.kind,
                number,
            );
            lowerer.context.emit({
                kind: "expression",
                code: `bbl::js::array_fill(${temporary}, ${value});`,
            });
            lowerer.registerLocal(temporary, "owned");
            return {
                kind: "data",
                cpp: temporary,
                dataType: typed.dataType,
            };
        }
    }
    let dynamicOwner =
        ts.isCallExpression(ownerExpression) ||
        ts.isNewExpression(ownerExpression) ||
        ts.isArrayLiteralExpression(ownerExpression) ||
        ts.isConditionalExpression(ownerExpression) ||
        ts.isBinaryExpression(ownerExpression)
            ? lowerer.context.compileValue(ownerExpression)
            : ts.isIdentifier(ownerExpression)
              ? (lowerer.context.bindings.lookupOptional(ownerExpression) ??
                // A module string or query bag without a runtime binding
                // is its value at the use site.
                (["string", "search-params"].includes(
                    lowerer.dataTypeAt(ownerExpression)?.kind ?? "",
                )
                    ? lowerer.context.compileValue(ownerExpression)
                    : lowerer.compileStaticContainer(ownerExpression)))
              : (ts.isPropertyAccessExpression(ownerExpression) ||
                      ts.isElementAccessExpression(ownerExpression)) &&
                  lowerer.plainDataOwnerChain(ownerExpression)
                ? lowerer.context.compileValue(ownerExpression)
                : ts.isStringLiteralLike(ownerExpression) ||
                    ts.isTemplateExpression(ownerExpression)
                  ? lowerer.context.compileValue(ownerExpression)
                  : ownerExpression.kind === ts.SyntaxKind.ThisKeyword
                    ? plainRecordReceiver(lowerer)
                    : undefined;
    if (dynamicOwner && !ts.isOptionalChain(callee)) {
        dynamicOwner = lowerer.narrowOptional(
            dynamicOwner,
            callee.expression,
            true,
        );
    }
    // A query bag the fold answered stays a browser value until a read it
    // cannot answer arrives here; that read parses the deployment query.
    if (
        dynamicOwner?.kind === "browser" &&
        dynamicOwner.browserValue?.kind === "search-params"
    ) {
        if (method === "set") throw new RuntimeSearchParamsRequired();
        dynamicOwner = deploymentSearchParamsValue(
            lowerer,
            dynamicOwner.browserValue.search,
        );
    }
    if (dynamicOwner?.dataType?.kind === "date")
        return compileDateMethod(lowerer, call, dynamicOwner, method);
    if (dynamicOwner?.dataType?.kind === "http-response")
        return compileHttpResponseMethod(lowerer, call, dynamicOwner, method);
    if (dynamicOwner?.dataType?.kind === "search-params")
        return compileSearchParamsMethod(lowerer, call, dynamicOwner, method);
    if (dynamicOwner?.dataType?.kind === "date-time-format")
        return compileDateTimeFormatMethod(lowerer, call, dynamicOwner, method);
    if (
        dynamicOwner?.dataType?.kind === "text-decoder" ||
        dynamicOwner?.dataType?.kind === "text-encoder"
    )
        return compileTextCodecMethod(lowerer, call, dynamicOwner, method);
    if (dynamicOwner?.dataType?.kind === "collator")
        return compileCollatorMethod(lowerer, call, dynamicOwner, method);
    if (dynamicOwner?.dataType?.kind === "weak-ref")
        return compileWeakRefMethod(lowerer, call, dynamicOwner, method);
    if (
        dynamicOwner?.kind === "tuple" &&
        lowerer.prefersRuntimeTupleIteration(ownerExpression, call.arguments[0])
    ) {
        dynamicOwner =
            lowerer.materializeConstantArray(ownerExpression) ??
            lowerer.materializeKnownTuple(ownerExpression, dynamicOwner) ??
            dynamicOwner;
    }
    const tupleOwnerElements: readonly Value[] | undefined =
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
    if (
        dynamicOwner?.kind === "tuple" &&
        tupleOwnerElements &&
        method === "slice"
    ) {
        if (call.arguments.length > 2)
            lowerer.context.fail(
                call,
                "Array.slice expects zero, one, or two arguments.",
            );
        const selected = lowerer.context.probeEmission(() => {
            // Receiver elements are evaluated before either endpoint, even
            // when the selected interval later excludes them.
            const elements = tupleOwnerElements.map((value) =>
                lowerer.context.bindings.pinValueToTemporary(
                    value,
                    "slice_member",
                ),
            );
            const begin = call.arguments[0]
                ? lowerer.context.compileValue(call.arguments[0])
                : undefined;
            const end = call.arguments[1]
                ? lowerer.context.compileValue(call.arguments[1])
                : undefined;
            if (
                (begin && begin.staticNumber === undefined) ||
                (end && end.staticNumber === undefined)
            )
                return undefined;
            for (const element of elements)
                lowerer.context.emitDiscardedValue(element);
            return {
                kind: "tuple",
                cpp: "",
                tupleElements: elements.slice(
                    begin?.staticNumber,
                    end?.staticNumber,
                ),
            } satisfies Value;
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
        const separator = separatorValue ? separatorValue.staticString : ",";
        const strings = tupleOwnerElements.map(
            (element) => element.staticString,
        );
        if (
            separator !== undefined &&
            strings.every((value): value is string => value !== undefined)
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
    const predicateMethod =
        method === "some" ||
        method === "every" ||
        method === "filter" ||
        method === "find" ||
        method === "findIndex";
    if (
        tupleOwnerElements &&
        dynamicOwner &&
        predicateMethod &&
        call.arguments.length !== 1
    ) {
        lowerer.context.fail(
            call,
            `Tuple Array.${method} requires exactly one callback.`,
        );
    }
    // A callback that is not a local function -- a stored expression, a
    // library function -- is evaluated once by the run-time callback path;
    // speculative folding must not re-run its getters.
    const callback =
        call.arguments.length === 1
            ? lowerer.context.unwrap(argumentAt(call, 0))
            : undefined;
    if (
        tupleOwnerElements &&
        dynamicOwner &&
        predicateMethod &&
        callback &&
        (ts.isIdentifier(callback) ||
            ts.isArrowFunction(callback) ||
            ts.isFunctionExpression(callback))
    ) {
        const folded = lowerer.promiseCallbackType(callback)
            ? undefined
            : lowerer.context.probeEmission((): Value | undefined => {
                  const selected: Value[] = [];
                  for (
                      let index = 0;
                      index < tupleOwnerElements.length;
                      ++index
                  ) {
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
                          if (matched.staticBoolean)
                              selected.push(tupleOwnerElements[index]!);
                          continue;
                      }
                      if (
                          (method === "find" || method === "findIndex") &&
                          matched.staticBoolean
                      ) {
                          return method === "find"
                              ? tupleOwnerElements[index]!
                              : {
                                    kind: "number",
                                    cpp: `${index}.0`,
                                    staticNumber: index,
                                    dataType: { kind: "number" },
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
                  if (method === "filter")
                      return {
                          kind: "tuple",
                          cpp: "",
                          tupleElements: selected,
                      };
                  if (method === "find")
                      return { kind: "json-null", cpp: "std::nullopt" };
                  if (method === "findIndex")
                      return {
                          kind: "number",
                          cpp: "-1.0",
                          staticNumber: -1,
                          dataType: { kind: "number" },
                      };
                  const result = method === "every";
                  return {
                      kind: "boolean",
                      cpp: result ? "true" : "false",
                      staticBoolean: result,
                      dataType: { kind: "boolean" },
                  };
              });
        if (folded) {
            return folded;
        }
    }
    const snapshotOwner = dynamicOwner?.staticElementsOwner ?? dynamicOwner;
    const nativeRecordElements =
        method === "map" &&
        dynamicOwner?.dataType?.kind === "vector" &&
        dynamicOwner.dataType.element.kind === "struct" &&
        snapshotOwner?.staticElements?.every(
            (element, index) =>
                element.staticElementsOwner === snapshotOwner &&
                element.staticElementIndex === index &&
                element.recordProperties !== undefined,
        )
            ? snapshotOwner.staticElements
            : undefined;
    const requiresStaticMap =
        method === "map" &&
        (tupleOwnerElements !== undefined ||
            nativeRecordElements !== undefined) &&
        call.arguments.length === 1 &&
        lowerer.context.requiresStaticDataIteration(call.arguments[0]!);
    if (
        (tupleOwnerElements || (requiresStaticMap && nativeRecordElements)) &&
        dynamicOwner &&
        method === "map"
    ) {
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
        const storedCallback = requiresStaticMap
            ? undefined
            : lowerer.prepareCallbackValue(callback, "tuple_map");
        const elements = tupleOwnerElements ?? nativeRecordElements!;
        const elementCount = elements.length;
        const snapshotIntact = (): boolean =>
            !nativeRecordElements ||
            (snapshotOwner?.staticElements === nativeRecordElements &&
                nativeRecordElements.length === elementCount);
        const compile = (): Value | undefined => {
            const mapped: Value[] = [];
            for (const [index, element] of elements.entries()) {
                if (!snapshotIntact()) return undefined;
                const arguments_: Value[] = [
                    element,
                    {
                        kind: "number",
                        cpp: `${index}.0`,
                        staticNumber: index,
                        dataType: { kind: "number" },
                    },
                    dynamicOwner,
                ];
                mapped.push(
                    storedCallback
                        ? lowerer.context.bindings.pinValueToTemporary(
                              lowerer.compileFunctionValueCall(
                                  storedCallback,
                                  arguments_,
                                  call,
                              ),
                              "mapped_result",
                              callback,
                          )
                        : lowerer.context.asyncActivations.withStaticCollectionCallback(
                              call,
                              callback,
                              () =>
                                  lowerer.context.compileCallbackWithValues(
                                      callback,
                                      arguments_,
                                      call,
                                  ),
                          ),
                );
                if (!snapshotIntact()) return undefined;
            }
            return {
                kind: "tuple",
                cpp: "",
                tupleElements: mapped,
            };
        };
        if (!nativeRecordElements) return compile();
        const result = lowerer.context.probeEmission(compile);
        if (result) return result;
    }
    // A constructor receiver was already evaluated above. Recompiling it as
    // a data path would repeat its argument effects; naming the result also
    // keeps an omitted method endpoint from constructing it again for size().
    let constructedOwner: Value | undefined;
    if (ts.isNewExpression(ownerExpression) && dynamicOwner?.kind === "data") {
        constructedOwner = lowerer.context.bindings.pinValueToTemporary(
            dynamicOwner,
            "constructed_receiver",
            ownerExpression,
        );
    }
    // An array literal receiver is a fresh array only this call sees: a
    // method that changes it (`[a, b].pop()`) runs on a native copy of its
    // elements, as it would on the array JavaScript builds.
    if (
        ts.isArrayLiteralExpression(ownerExpression) &&
        dynamicOwner?.kind === "tuple" &&
        receiverWritingMethods.has(method)
    ) {
        const element = lowerer.knownTupleElement(
            callee.expression,
            dynamicOwner,
        );
        if (!element) {
            lowerer.context.fail(
                ownerExpression,
                `Array.${method} on an array literal needs one element type.`,
            );
        }
        const dataType: DataType = { kind: "vector", element };
        const temporary =
            lowerer.context.allocateTemporaryCppName("literal_receiver");
        lowerer.context.reachJsData();
        lowerer.context.emit({
            kind: "declaration",
            type: "auto",
            name: temporary,
            initializer: lowerer.compileKnownValueForSink(
                dynamicOwner,
                dataType,
                ownerExpression,
            ),
        });
        lowerer.registerLocal(temporary, "owned");
        constructedOwner = { kind: "data", cpp: temporary, dataType };
    }
    const owner =
        constructedOwner ??
        (dynamicOwner?.kind === "tuple"
            ? undefined
            : lowerer.compileDataPath(
                  callee.expression,
                  receiverWritingMethods.has(method) ? "write" : "read",
                  true,
              )) ??
        (dynamicOwner?.kind === "data" || dynamicOwner?.kind === "string"
            ? dynamicOwner
            : undefined) ??
        // A constant array is a compile-time tuple with nothing to
        // search, so searching one materializes it exactly as a
        // runtime index into it does.
        (constantArrayMethods.has(method)
            ? (lowerer.materializeConstantArray(callee.expression) ??
              (!lowerer.namesHandleCollection(callee.expression)
                  ? lowerer.materializeKnownTuple(
                        callee.expression,
                        dynamicOwner?.kind === "tuple"
                            ? dynamicOwner
                            : undefined,
                    )
                  : undefined))
            : undefined);
    if (!owner || (owner.kind !== "data" && owner.kind !== "string")) {
        return undefined;
    }
    // Optional chains continue through later calls even without another ?.
    // Guard the whole method, including its argument effects, with the same
    // snapshot and result-flattening mechanism used by property/DOM accesses.
    if (
        ts.isPropertyAccessChain(callee) &&
        owner.dataType?.kind === "optional"
    ) {
        return lowerer.optionalAccess(owner, call, (present) =>
            compileKnownDataMethod(
                lowerer,
                call,
                callee,
                present,
                dynamicOwner,
                expectedResult,
            ),
        );
    }
    return compileKnownDataMethod(
        lowerer,
        call,
        callee,
        owner,
        dynamicOwner,
        expectedResult,
    );
}

function compileKnownDataMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    owner: Value,
    dynamicOwner: Value | undefined,
    expectedResult?: DataType<"vector">,
): Value | undefined {
    const method = callee.name.text;
    const ownerExpression = lowerer.context.unwrap(callee.expression);
    let narrowedOwner = lowerer.stringReceiver(
        lowerer.narrowOptional(
            owner,
            callee.expression,
            !ts.isOptionalChain(callee),
        ),
        callee.expression,
    );
    if (isJsonValue(narrowedOwner)) {
        const declared = lowerer.dataTypeAt(callee.expression);
        if (declared?.kind === "string" || declared?.kind === "enum") {
            narrowedOwner = lowerer.leafValue(
                `${narrowedOwner.cpp}.string_value()`,
                { kind: "string" },
            );
        }
    }
    // An array method on a parsed document runs over the document's own
    // elements, each of which is another document. Handing the element
    // view to the ordinary array lowering is the whole adaptation:
    // nothing about the callback protocol changes.
    let narrowed = narrowedOwner;
    if (isJsonValue(narrowedOwner)) {
        const mutable = mutatingArrayMethods.has(method);
        narrowed = {
            kind: "data",
            cpp: `${narrowedOwner.cpp}.${mutable ? "array_value" : "elements"}()`,
            ...(mutable
                ? {}
                : { nativeCollectionCppType: "bbl::js::JsonArrayView" }),
            dataType: {
                kind: mutable ? "vector" : "span",
                element: { kind: "json" },
            },
        };
    } else if (
        narrowedOwner.dataType?.kind === "tuple" &&
        tupleReadingMethods.has(method)
    ) {
        narrowed = {
            ...narrowedOwner,
            // A numeric tuple's observing methods use the same indexed
            // range loop as a readonly numeric array.
            dataType: { kind: "span", element: { kind: "number" } },
        };
    }
    if (snapshotInvalidatingMethods.has(method)) {
        lowerer.invalidateStaticElements(
            narrowed,
            method === "reverse" ||
                method === "fill" ||
                method === "copyWithin" ||
                ((method === "set" || method === "delete") &&
                    (narrowed.dataType?.kind === "map" ||
                        narrowed.dataType?.kind === "set")),
        );
    }
    const dataType =
        narrowed.dataType ??
        (narrowed.kind === "string"
            ? ({ kind: "string" } as const)
            : undefined);
    const recordType =
        dataType?.kind === "optional" ? dataType.inner : dataType;
    if (recordType?.kind === "struct") {
        const field = lowerer.context.dataTypes
            .structFields(recordType.name, callee.name, "accessors")
            .find((candidate) => candidate.sourceName === method);
        const functionType = field?.type;
        if (functionType?.kind === "function") {
            const referenceReceiver =
                lowerer.context.dataTypes.isReferenceStruct(recordType.name);
            const member = referenceReceiver ? "->" : ".";
            const receiver =
                lowerer.context.allocateTemporaryCppName("callback_receiver");
            const optional = dataType?.kind === "optional";
            lowerer.context.emit({
                kind: "declaration",
                type: "const auto&",
                name: receiver,
                initializer: narrowed.cpp,
            });
            const record = optional ? `(*${receiver})` : receiver;
            const present = optional
                ? optionalPresentCpp(receiver)
                : referenceReceiver
                  ? receiver
                  : undefined;
            return lowerer.compileStoredCall(
                call,
                `${record}${member}${field!.name}${field!.accessor ? ".get()" : ""}`,
                functionType,
                present,
            );
        }
    }
    if (dataType?.kind === "iterator") {
        if (!["next", "return"].includes(method) || call.arguments.length !== 0)
            lowerer.context.fail(
                call,
                "Stored iterators support next() and return() without arguments.",
            );
        const result =
            lowerer.context.allocateTemporaryCppName("iterator_result");
        if (dataType.asynchronous) {
            const output = lowerer.context.dataTypes.ownedRecordType([
                { sourceName: "done", type: { kind: "boolean" } },
                {
                    sourceName: "value",
                    type: { kind: "optional", inner: dataType.element },
                },
            ]);
            const cppType = lowerer.context.dataTypes.cppType(output);
            return {
                kind: "promise",
                cpp: `bbl::js::Promise<${cppType}>::view(${narrowed.cpp}.${method === "return" ? "return_" : "next"}(), [](const auto& ${result}) { return bbl::js::make_ref<bblscene::${output.name}Data>(bblscene::${output.name}Data{${result}.done, ${result}.value}); })`,
                promiseResult: lowerer.leafValue("", output),
                promiseType: cppType,
                dataType: { kind: "promise", result: output },
            };
        }
        lowerer.context.emit({
            kind: "declaration",
            type: "auto",
            name: result,
            initializer: `${narrowed.cpp}.${method === "return" ? "return_" : "next"}()`,
        });
        const nativeCaptures = [lowerer.context.registerNativeBinding(result)];
        return {
            kind: "record",
            cpp: "",
            recordProperties: {
                done: {
                    ...lowerer.leafValue(`${result}.done`, { kind: "boolean" }),
                    nativeCaptures,
                },
                value: {
                    ...lowerer.leafValue(`${result}.value`, {
                        kind: "optional",
                        inner: dataType.element,
                    }),
                    nativeCaptures,
                },
            },
        };
    }
    if (dataType?.kind === "map") {
        return compileMapDataMethod(
            lowerer,
            call,
            callee,
            method,
            narrowed,
            dataType,
        );
    }
    if (dataType?.kind === "set") {
        return compileSetDataMethod(
            lowerer,
            call,
            callee,
            method,
            narrowed,
            dataType,
        );
    }
    if (dataType?.kind === "string") {
        const result = compileStringDataMethod(lowerer, call, method, narrowed);
        if (result) return result;
    }
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
        lowerer.context.emit({
            kind: "declaration",
            type: "auto",
            name: values,
            initializer: narrowed.cpp,
        });
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
    // A constant numeric array is a one-dimensional table; arrays and
    // readonly spans search in the array-method tail below.
    if (
        (method === "indexOf" || method === "includes") &&
        dataType?.kind === "table" &&
        dataType.dimensions.length === 1
    )
        return lowerer.compileArraySearch(
            call,
            narrowed,
            { kind: "number" },
            method,
        );
    if (isTypedArrayType(dataType) && method === "fill") {
        if (call.arguments.length < 1 || call.arguments.length > 3) {
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
        const stored = typedArrayStoreExpression(dataType.kind, number);
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
    if (isTypedArrayType(dataType) && method === "copyWithin") {
        if (call.arguments.length < 2 || call.arguments.length > 3) {
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
    if (isTypedArrayType(dataType) && method === "set") {
        return lowerer.compileTypedArraySet(call, narrowed, dataType.kind);
    }
    if (
        isTypedArrayType(dataType) &&
        (method === "slice" || method === "subarray")
    ) {
        if (call.arguments.length > 2) {
            lowerer.context.fail(
                call,
                `TypedArray.${method} expects up to two arguments.`,
            );
        }
        const begin = call.arguments[0]
            ? lowerer.context.compileNumber(call.arguments[0], "double")
            : "0.0";
        const end = call.arguments[1]
            ? lowerer.context.compileNumber(call.arguments[1], "double")
            : `static_cast<double>(${narrowed.cpp}.size())`;
        lowerer.context.reachJsData();
        // `slice` copies the range; `subarray` is a view sharing the
        // receiver's bytes, so writes through it reach the source. Both
        // endpoints are relative indices.
        return {
            kind: "data",
            cpp:
                `bbl::js::typed_array_${method}(${narrowed.cpp}, ` +
                `${begin}, ${end})`,
            dataType,
        };
    }
    if (dataType?.kind === "arraybuffer" && method === "slice") {
        if (call.arguments.length > 2)
            lowerer.context.fail(
                call,
                "ArrayBuffer.slice expects up to two arguments.",
            );
        const begin = call.arguments[0]
            ? lowerer.context.compileNumber(call.arguments[0], "double")
            : "0.0";
        const end = call.arguments[1]
            ? lowerer.context.compileNumber(call.arguments[1], "double")
            : "std::numeric_limits<double>::infinity()";
        lowerer.context.reachJsData();
        return {
            kind: "data",
            cpp: `bbl::js::array_buffer_slice(${narrowed.cpp}, ${begin}, ${end})`,
            dataType,
        };
    }
    if (dataType?.kind === "dataview") {
        const accessor = DATA_VIEW_ACCESSORS.get(method);
        if (accessor) {
            return compileDataViewAccessor(
                lowerer,
                call,
                narrowed,
                method,
                accessor,
            );
        }
    }
    if (isTypedArrayType(dataType)) {
        if (method === "sort")
            return compileTypedArraySort(lowerer, call, narrowed, dataType);
        if (method === "reverse") {
            if (call.arguments.length !== 0)
                lowerer.context.fail(
                    call,
                    "TypedArray.reverse expects no arguments.",
                );
            lowerer.context.reachJsData();
            return {
                kind: "data",
                cpp: `bbl::js::typed_array_reverse(${narrowed.cpp})`,
                dataType,
            };
        }
        if (!typedArrayReadMethods.has(method)) return undefined;
        return compileArrayMethodTail(
            {
                lowerer,
                call,
                narrowed: typedArrayReader(
                    lowerer,
                    call,
                    method,
                    narrowed,
                    dataType,
                ),
                dataType: typedArrayNumbers,
                dynamicOwner,
                expectedResult: undefined,
                typedResult: dataType,
            },
            method,
        );
    }
    // A numeric tuple's length-preserving writers act on its own storage
    // and return the same tuple.
    if (
        dataType?.kind === "tuple" &&
        (method === "fill" || method === "copyWithin")
    ) {
        const written = compileArrayValueMethod(
            lowerer,
            call,
            method,
            narrowed,
            {
                kind: "vector",
                element: { kind: "number" },
            },
        );
        return written && { ...written, dataType };
    }
    if (dataType?.kind !== "vector" && dataType?.kind !== "span") {
        return undefined;
    }
    return (
        compileArrayMethodTail(
            {
                lowerer,
                call,
                narrowed,
                dataType,
                dynamicOwner,
                expectedResult,
            },
            method,
        ) ??
        lowerer.context.fail(
            callee.name,
            `Array method '${method}' is not supported.`,
        )
    );
}

interface ArrayMethodState {
    lowerer: DataLowerer;
    call: ts.CallExpression;
    narrowed: Value;
    dataType: DataType & { kind: "vector" | "span" };
    dynamicOwner: Value | undefined;
    expectedResult: DataType<"vector"> | undefined;
    /** A typed array's `map`/`filter` collect into the receiver's own kind. */
    typedResult?: DataType<TypedArrayKind>;
}

/** The method lowering an array, a readonly span and a typed array's numbers share. */
function compileArrayMethodTail(
    state: ArrayMethodState,
    method: string,
): Value | undefined {
    const { lowerer, call, narrowed, dataType } = state;
    lowerer.invalidateRecordArrayFacts(narrowed);
    if (method === "indexOf" || method === "includes")
        return lowerer.compileArraySearch(
            call,
            narrowed,
            dataType.element,
            method,
        );
    const arrayValue = compileArrayValueMethod(
        lowerer,
        call,
        method,
        narrowed,
        dataType,
    );
    if (arrayValue) return arrayValue;
    // A readonly array parameter is a span. Its observing methods share the
    // vector loop; mutating/copy-producing methods keep requiring owning storage.
    if (dataType.kind === "span" && !readOnlyDataMethods.has(method))
        return undefined;
    lowerer.context.reachJsData();
    return arrayMethodHandlers.get(method)?.(state);
}

/** A map or filter collector: the array type, or a fill of the typed result. */
function collectorCppType(
    state: ArrayMethodState,
    arrayType: DataType<"vector">,
): string {
    const types = state.lowerer.context.dataTypes;
    return state.typedResult
        ? `bbl::js::TypedArrayFill<${types.cppType(state.typedResult)}>`
        : types.cppType(arrayType);
}

/** The collected array; a typed result is taken from its fill once the walk ends. */
function collectedArray(
    state: ArrayMethodState,
    output: string,
    arrayType: DataType<"vector">,
): Value {
    const lowerer = state.lowerer;
    if (!state.typedResult) {
        lowerer.registerLocal(output, "owned");
        return { kind: "data", cpp: output, dataType: arrayType };
    }
    const typed = lowerer.context.allocateTemporaryCppName("typed_result");
    lowerer.context.emit({
        kind: "declaration",
        type: "auto",
        name: typed,
        initializer: `${output}.take()`,
    });
    lowerer.registerLocal(typed, "owned");
    return { kind: "data", cpp: typed, dataType: state.typedResult };
}

const typedArrayNumbers: DataType<"span"> = {
    kind: "span",
    element: { kind: "number" },
};

/** The array methods a typed array shares, read through `TypedArrayNumbers`. */
const typedArrayReadMethods: ReadonlySet<string> = new EmissionSet([
    "at",
    "every",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "forEach",
    "includes",
    "indexOf",
    "join",
    "lastIndexOf",
    "map",
    "reduce",
    "reduceRight",
    "some",
]);

/**
 * A typed array as the array-method tail reads it: its elements as numbers
 * (`bbl::js::TypedArrayNumbers`), each read the element at that moment,
 * through a view's bytes as through owned storage. `map` and `filter` fill
 * the receiver's own kind (`typedResult`), converting each number as a
 * store does.
 */
function typedArrayReader(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    method: string,
    narrowed: Value,
    dataType: DataType<TypedArrayKind>,
): Value {
    const callback = call.arguments[0];
    const arrayParameter =
        method === "reduce" || method === "reduceRight" ? 3 : 2;
    if (
        callback &&
        lowerer.context.checker
            .getTypeAtLocation(callback)
            .getCallSignatures()
            .some((signature) => signature.parameters.length > arrayParameter)
    )
        lowerer.context.fail(
            callback,
            `A typed array's ${method} callback takes no array parameter here.`,
        );
    lowerer.context.reachJsData();
    const cppType = lowerer.context.dataTypes.cppType(dataType);
    return {
        kind: "data",
        cpp: `bbl::js::typed_array_numbers(${narrowed.cpp})`,
        dataType: typedArrayNumbers,
        nativeCollectionCppType: `bbl::js::TypedArrayNumbers<${cppType}>`,
    };
}

function compileTypedArraySort(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    narrowed: Value,
    dataType: DataType<TypedArrayKind>,
): Value {
    lowerer.context.reachJsData();
    if (call.arguments.length === 0)
        return {
            kind: "data",
            cpp: `bbl::js::typed_array_sort(${narrowed.cpp})`,
            dataType,
        };
    const receiver = lowerer.context.bindings.pinValueToTemporary(
        narrowed,
        "sort_receiver",
    );
    const list = lowerer.context.allocateTemporaryCppName("sort_numbers");
    const numbers: DataType<"vector"> = {
        kind: "vector",
        element: { kind: "number" },
    };
    lowerer.context.emit({
        kind: "declaration",
        type: "auto",
        name: list,
        initializer: `bbl::js::typed_array_number_list(${receiver.cpp})`,
    });
    lowerer.registerLocal(list, "owned");
    const sorted = compileArraySort({
        lowerer,
        call,
        narrowed: { kind: "data", cpp: list, dataType: numbers },
        dataType: numbers,
        dynamicOwner: undefined,
        expectedResult: undefined,
    });
    lowerer.context.emit({
        kind: "expression",
        code: `bbl::js::typed_array_store_numbers(${receiver.cpp}, ${sorted.cpp});`,
    });
    return receiver;
}

function compileArrayFlat({
    lowerer,
    call,
    narrowed,
    dataType,
}: ArrayMethodState): Value {
    if (call.arguments.length > 1)
        lowerer.context.fail(
            call,
            "Array.flat expects at most one depth argument.",
        );
    const requested = call.arguments[0]
        ? staticNumberValue(lowerer.context, call.arguments[0])
        : 1;
    if (requested === undefined)
        return lowerer.context.fail(
            call,
            "Array.flat requires a generation-known depth.",
        );
    const depth = Number.isNaN(requested)
        ? 0
        : Math.max(0, Math.trunc(requested));
    const resultType =
        lowerer.dataTypeAt(call) ??
        (dataType.element.kind === "json"
            ? { kind: "vector" as const, element: { kind: "json" as const } }
            : undefined);
    if (resultType?.kind !== "vector")
        return lowerer.context.fail(
            call,
            "Array.flat result must belong to the native data model.",
        );
    const output = lowerer.context.allocateTemporaryCppName("flat_result");
    lowerer.context.emit({
        kind: "declaration",
        type: lowerer.context.dataTypes.cppType(resultType),
        name: output,
        initializer: "{}",
    });
    const append = (cpp: string, type: DataType, levels: number): void => {
        if (
            levels > 0 &&
            type.kind === "json" &&
            resultType.element.kind === "json"
        ) {
            lowerer.context.emit({
                kind: "expression",
                code: `bbl::js::json_flatten_into(${output}, ${cpp}, ${numberConstantValue(levels).cpp});`,
            });
        } else if (
            levels > 0 &&
            (type.kind === "vector" ||
                type.kind === "span" ||
                type.kind === "tuple")
        ) {
            const item = lowerer.context.allocateTemporaryCppName("flat_item");
            lowerer.context.emit({
                kind: "open",
                code: `for (const auto& ${item} : ${cpp}) {`,
                iteration: true,
            });
            lowerer.context.increaseIndent();
            append(
                item,
                type.kind === "tuple" ? { kind: "number" } : type.element,
                levels - 1,
            );
            lowerer.context.decreaseIndent();
            lowerer.context.emit({ kind: "close", code: "}" });
        } else {
            const value = lowerer.compileKnownValueForSink(
                lowerer.leafValue(cpp, type),
                resultType.element,
                call,
            );
            lowerer.context.emit({
                kind: "expression",
                code: `${output}.push_back(${value});`,
            });
        }
    };
    append(narrowed.cpp, dataType, depth + 1);
    lowerer.registerLocal(output, "owned");
    return { kind: "data", cpp: output, dataType: resultType, freshData: true };
}

function compileArrayJoin(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (
        !["string", "enum", "number", "boolean", "json"].includes(
            dataType.element.kind,
        ) ||
        call.arguments.length > 1
    ) {
        lowerer.context.fail(
            call,
            "Array.join supports scalar arrays with at most one separator.",
        );
    }
    const separator = call.arguments[0]
        ? lowerer.context.compileValue(argumentAt(call, 0))
        : undefined;
    if (separator && !isStringValue(separator)) {
        lowerer.context.fail(
            argumentAt(call, 0),
            "Array.join separator must be a string.",
        );
    }
    return {
        kind: "string",
        cpp: `bbl::js::array_join(${narrowed.cpp}, ${
            separator ? separator.cpp : lowerer.context.cppString(",")
        }${
            dataType.element.kind === "json"
                ? ", [](const auto& value) { return value.is_null() || value.is_undefined() ? std::string{} : value.to_string(); }"
                : dataType.element.kind === "enum"
                  ? `, [](const auto& value) { return ${lowerer.context.dataTypes.enumToStringCpp(dataType.element, "value", call)}; }`
                  : dataType.element.kind === "number"
                    ? ", [](double value) { return bbl::js::number_to_string(value); }"
                    : dataType.element.kind === "boolean"
                      ? ', [](bool value) { return value ? "true" : "false"; }'
                      : ""
        })`,
        dataType: { kind: "string" },
    };
}

function compileArraySlice(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length > 2) {
        lowerer.context.fail(
            call,
            "Array.slice expects zero, one, or two arguments.",
        );
    }
    const begin = call.arguments[0]
        ? lowerer.context.compileNumber(call.arguments[0], "double")
        : "0.0";
    const end = call.arguments[1]
        ? lowerer.context.compileNumber(call.arguments[1], "double")
        : `static_cast<double>(${narrowed.cpp}.size())`;
    // The copy is a new array the program owns, even of a readonly view.
    return {
        kind: "data",
        cpp: `bbl::js::array_slice(${narrowed.cpp}, ${begin}, ${end})`,
        dataType: { kind: "vector", element: dataType.element },
    };
}

/**
 * `sort` orders the receiver in place; `toSorted` orders a fresh copy of
 * the elements it holds once the comparator argument is evaluated.
 */
function compileArraySort(
    state: ArrayMethodState,
    method: "sort" | "toSorted" = "sort",
): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length > 1) {
        lowerer.context.fail(
            call,
            `Array.${method} expects at most one comparator callback.`,
        );
    }
    const copy = method === "toSorted";
    const resultType: DataType<"vector"> | typeof dataType = copy
        ? { kind: "vector", element: dataType.element }
        : dataType;
    const result = lowerer.context.allocateTemporaryCppName("sort_result");
    const receiver = copy
        ? lowerer.context.allocateTemporaryCppName("sort_receiver")
        : result;
    lowerer.context.emit({
        kind: "declaration",
        type: copy ? "auto&&" : "auto",
        name: receiver,
        initializer: narrowed.cpp,
    });
    const argument = call.arguments[0]
        ? lowerer.context.unwrap(call.arguments[0])
        : undefined;
    // Another comparator expression (a class field, a property, a call
    // result) is evaluated once, before the sort: a compile-time callback
    // keeps its owner's scopes, a function value is held in a temporary.
    const evaluated =
        argument &&
        !ts.isIdentifier(argument) &&
        !ts.isArrowFunction(argument) &&
        !ts.isFunctionExpression(argument)
            ? lowerer.context.compileValue(argument)
            : undefined;
    const storedCallback =
        evaluated?.kind === "callback" ? evaluated : undefined;
    if (
        evaluated &&
        !storedCallback?.callbackDeclaration &&
        evaluated.dataType?.kind !== "function"
    ) {
        lowerer.context.fail(
            argument!,
            `Array.${method} requires a function comparator.`,
        );
    }
    const comparatorValue =
        evaluated && !storedCallback
            ? lowerer.context.bindings.pinValueToTemporary(
                  evaluated,
                  "sort_comparator",
              )
            : undefined;
    if (copy)
        lowerer.context.emit({
            kind: "declaration",
            type: lowerer.context.dataTypes.cppType(resultType),
            name: result,
            initializer: `${receiver}.begin(), ${receiver}.end()`,
            initialization: "direct",
        });
    const callback =
        argument &&
        (ts.isIdentifier(argument) ||
            ts.isArrowFunction(argument) ||
            ts.isFunctionExpression(argument))
            ? argument
            : storedCallback?.callbackDeclaration;
    const left = lowerer.context.allocateTemporaryCppName("sort_left");
    const right = lowerer.context.allocateTemporaryCppName("sort_right");
    lowerer.context.emit(
        `std::stable_sort(${result}.begin(), ${result}.end(), [&](const auto& ${left}, const auto& ${right}) {`,
    );
    lowerer.context.increaseIndent();
    lowerer.context.bindings.pushScope(lowerer.context.allocateBlockPrefix());
    try {
        lowerer.context.enterRuntimeIteration();
        try {
            if (!callback && !comparatorValue) {
                const text = (name: string): string => {
                    if (dataType.element.kind === "string") return name;
                    if (
                        !["number", "boolean", "enum"].includes(
                            dataType.element.kind,
                        )
                    )
                        return lowerer.context.fail(
                            call,
                            `Default Array.${method} requires scalar string, number, boolean or enum elements.`,
                        );
                    return `bbl::js::concat(${stringConcatPart(lowerer.context, lowerer.leafValue(name, dataType.element), call)})`;
                };
                lowerer.context.emit({
                    kind: "control",
                    code: `return bbl::js::string_code_units(${text(left)}) < bbl::js::string_code_units(${text(right)});`,
                    transfer: "return",
                });
            } else {
                // The comparator's operands are const references, which an
                // environment borrowing them must name as such.
                const element = `const ${lowerer.context.dataTypes.cppType(dataType.element)}`;
                lowerer.context.registerNativeBindingType(left, element);
                lowerer.context.registerNativeBindingType(right, element);
                const operands = [
                    {
                        ...lowerer.leafValue(left, dataType.element),
                        nativeCaptures: [
                            lowerer.context.registerNativeBinding(left),
                        ],
                    },
                    {
                        ...lowerer.leafValue(right, dataType.element),
                        nativeCaptures: [
                            lowerer.context.registerNativeBinding(right),
                        ],
                    },
                ];
                const owner = storedCallback?.callbackRecordOwner;
                const compare = (): Value =>
                    callback
                        ? lowerer.context.compileCallbackWithValues(
                              callback,
                              operands,
                              call,
                          )
                        : lowerer.compileFunctionValueCall(
                              comparatorValue!,
                              operands,
                              call,
                          );
                const compared = owner
                    ? lowerer.context.withRecordScopes(owner, compare)
                    : compare();
                if (compared.kind !== "number") {
                    lowerer.context.fail(
                        argument!,
                        `Array.${method} comparator must return a number.`,
                    );
                }
                lowerer.context.emit({
                    kind: "control",
                    code: `return ${compared.cpp} < 0.0;`,
                    transfer: "return",
                });
            }
        } finally {
            lowerer.context.leaveRuntimeIteration();
        }
    } finally {
        lowerer.context.bindings.popScope();
        lowerer.context.decreaseIndent();
    }
    lowerer.context.emit("});");
    if (!copy) lowerer.invalidateStaticElements(narrowed, true);
    lowerer.registerLocal(result, "owned");
    return { kind: "data", cpp: result, dataType: resultType };
}

function compileArrayFind(
    state: ArrayMethodState,
    method: "find" | "findLast",
): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    // The checked program's ES2022 library does not declare `findLast`:
    // its result is the receiver's element or undefined.
    const resultType =
        (method === "find" ? lowerer.dataTypeAt(call) : undefined) ??
        (method === "findLast"
            ? lowerer.context.dataTypes.nullableType(dataType.element, true)
            : { kind: "optional" as const, inner: dataType.element });
    const result = lowerer.context.allocateTemporaryCppName("find_result");
    lowerer.emitArrayCallbackLoop(
        call,
        method,
        narrowed,
        dataType,
        false,
        () =>
            lowerer.context.emit({
                kind: "declaration",
                type: lowerer.context.dataTypes.cppType(resultType),
                name: result,
                initializer: "",
                initialization: "default",
            }),
        (matched, callback, source, index) => {
            if (matched.kind !== "boolean") {
                lowerer.context.fail(
                    callback,
                    `Array.${method} callback must return a boolean value.`,
                );
            }
            lowerer.context.emit({
                kind: "open",
                code: `if (${matched.cpp}) {`,
            });
            lowerer.context.increaseIndent();
            const selected = lowerer.leafValue(
                `${source}[${index}]`,
                dataType.element,
            );
            const stored = lowerer.compileKnownValueForSink(
                selected,
                resultType,
                call,
            );
            lowerer.context.emit({
                kind: "expression",
                code: `${result} = ${stored};`,
            });
            lowerer.context.emit({
                kind: "control",
                code: "break;",
                transfer: "break",
            });
            lowerer.context.decreaseIndent();
            lowerer.context.emit({ kind: "close", code: "}" });
        },
    );
    lowerer.registerLocal(result, "owned");
    lowerer.context.registerNativeTemporary(result, resultType);
    return lowerer.leafValue(result, resultType);
}

function compileArrayFindIndex(
    state: ArrayMethodState,
    method: "findIndex" | "findLastIndex",
): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    const result =
        lowerer.context.allocateTemporaryCppName("find_index_result");
    lowerer.emitArrayCallbackLoop(
        call,
        method,
        narrowed,
        dataType,
        false,
        () =>
            lowerer.context.emit({
                kind: "declaration",
                type: "double",
                name: result,
                initializer: "-1.0",
            }),
        (matched, callback, _source, index) => {
            if (matched.kind !== "boolean") {
                lowerer.context.fail(
                    callback,
                    `Array.${method} callback must return a boolean value.`,
                );
            }
            lowerer.context.emit({
                kind: "open",
                code: `if (${matched.cpp}) {`,
            });
            lowerer.context.increaseIndent();
            lowerer.context.emit({
                kind: "expression",
                code: `${result} = static_cast<double>(${index});`,
            });
            lowerer.context.emit({
                kind: "control",
                code: "break;",
                transfer: "break",
            });
            lowerer.context.decreaseIndent();
            lowerer.context.emit({ kind: "close", code: "}" });
        },
    );
    return {
        kind: "number",
        cpp: result,
        dataType: { kind: "number" },
    };
}

/** A fresh array can choose its contextual string storage before any aliases exist. */
function arrayResultType(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    fallback?: DataType<"vector">,
): DataType<"vector"> | undefined {
    const callType = lowerer.dataTypeAt(call);
    // Optional-chain dispatch invokes the method only in the present arm.
    const inferred = callType?.kind === "optional" ? callType.inner : callType;
    const result = fallback
        ? fallback.element.kind === "optional" &&
          inferred?.kind === "vector" &&
          dataTypesEqual(fallback.element.inner, inferred.element)
            ? inferred
            : fallback
        : inferred?.kind === "vector"
          ? inferred
          : undefined;
    if (!result) return undefined;
    const contextual = lowerer.context.checker.getContextualType(call);
    const destination = contextual
        ? lowerer.context.dataTypes.fromTsType(contextual, call)
        : undefined;
    return (destination?.kind === "vector" || destination?.kind === "span") &&
        destination.element.kind === "string" &&
        result.element.kind === "enum"
        ? { kind: "vector", element: destination.element }
        : result;
}

/**
 * A type predicate narrowing string tags (`(f: Failure) => f is Candidate`)
 * makes the filtered array one of the narrower tags: each element it keeps
 * converts to that tag, which refuses at run time if the predicate lied.
 */
function narrowedTagFilter(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    element: DataType,
): DataType<"vector"> | undefined {
    const result = lowerer.dataTypeAt(call);
    if (
        element.kind !== "enum" ||
        result?.kind !== "vector" ||
        result.element.kind !== "enum" ||
        result.element.name === element.name
    )
        return undefined;
    // Only a destination expecting the narrower tags takes them: the
    // contextual type, unless a generic call inferred it from this very
    // argument (`Object.freeze(tags.filter(isCandidate))`), which then names
    // no destination.
    const contextual = declaredContextualType(lowerer.context.checker, call);
    const destination =
        contextual && lowerer.context.dataTypes.fromTsType(contextual, call);
    if (
        (destination?.kind !== "vector" && destination?.kind !== "span") ||
        !dataTypesEqual(destination.element, result.element)
    )
        return undefined;
    const members = lowerer.context.dataTypes.enumMembers(element.name);
    return lowerer.context.dataTypes
        .enumMembers(result.element.name)
        .every((member) => members.includes(member))
        ? result
        : undefined;
}

function compileArrayFilter(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    const filteredType =
        narrowedTagFilter(lowerer, call, dataType.element) ??
        arrayResultType(lowerer, call, {
            kind: "vector" as const,
            element: dataType.element,
        })!;
    const output = lowerer.context.allocateTemporaryCppName("filter_result");
    lowerer.emitArrayCallbackLoop(
        call,
        "filter",
        narrowed,
        dataType,
        false,
        (source) => {
            lowerer.context.emit(
                `${collectorCppType(state, filteredType)} ${output};`,
            );
            lowerer.context.emit({
                kind: "expression",
                code: `${output}.reserve(${source}.size());`,
            });
        },
        (matched, callback, source, index) => {
            if (matched.kind !== "boolean") {
                lowerer.context.fail(
                    callback,
                    "Array.filter callback must return a boolean value.",
                );
            }
            lowerer.context.emit({
                kind: "open",
                code: `if (${matched.cpp}) {`,
            });
            lowerer.context.increaseIndent();
            const cpp = `${source}[${index}]`;
            const selected =
                dataType.element.kind === "optional" &&
                filteredType.element.kind !== "optional"
                    ? lowerer.leafValue(`(*${cpp})`, dataType.element.inner)
                    : lowerer.leafValue(cpp, dataType.element);
            lowerer.context.emit({
                kind: "expression",
                code: `${output}.push_back(${lowerer.compileKnownValueForSink(selected, filteredType.element, call)});`,
            });
            lowerer.context.decreaseIndent();
            lowerer.context.emit({ kind: "close", code: "}" });
        },
    );
    return collectedArray(state, output, filteredType);
}

/**
 * `reduce`/`reduceRight` walk the length read at the call; an index the
 * callback removed is skipped as JavaScript skips an absent element.
 * Without an initial value the first visited element seeds the
 * accumulator, and an empty receiver throws.
 */
function compileArrayReduce(
    state: ArrayMethodState,
    method: "reduce" | "reduceRight" = "reduce",
): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length !== 1 && call.arguments.length !== 2) {
        lowerer.context.fail(
            call,
            `Array.${method} requires a callback and an optional initial value.`,
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
            `Array.${method} requires a local function or function literal callback.`,
        );
    }
    const resultType = lowerer.dataTypeAt(call);
    if (!resultType) {
        lowerer.context.fail(
            call,
            `Array.${method} accumulator must belong to the native data model.`,
        );
    }
    const initial = call.arguments[1];
    const right = method === "reduceRight";
    const source = lowerer.context.allocateTemporaryCppName("reduce_source");
    const count = lowerer.context.allocateTemporaryCppName("reduce_count");
    const index = lowerer.context.allocateTemporaryCppName("reduce_index");
    const accumulator =
        lowerer.context.allocateTemporaryCppName("reduce_result");
    lowerer.context.emit({
        kind: "declaration",
        type: "auto&&",
        name: source,
        initializer: narrowed.cpp,
    });
    const storedCallback = lowerer.prepareCallbackValue(callback, "reduce");
    lowerer.context.emit({
        kind: "declaration",
        type: "const std::size_t",
        name: count,
        initializer: `${source}.size()`,
    });
    if (!initial)
        lowerer.context.emit(
            `if (${count} == 0) bbl::js::throw_empty_reduce();`,
        );
    lowerer.context.emit({
        kind: "declaration",
        type: lowerer.context.dataTypes.cppType(resultType),
        name: accumulator,
        initializer: initial
            ? lowerer.compileForSink(initial, resultType)
            : lowerer.compileKnownValueForSink(
                  lowerer.leafValue(
                      `${source}[${right ? `${count} - 1` : "0"}]`,
                      dataType.element,
                  ),
                  resultType,
                  call,
              ),
    });
    const first = initial ? count : `${count} - 1`;
    lowerer.context.emit({
        kind: "open",
        code: right
            ? `for (std::size_t ${index} = ${first}; ${index}-- > 0;) {`
            : `for (std::size_t ${index} = ${initial ? "0" : "1"}; ${index} < ${count}; ++${index}) {`,
        iteration: true,
    });
    lowerer.context.increaseIndent();
    if (right || !initial)
        lowerer.context.emit(`if (${index} >= ${source}.size()) continue;`);
    lowerer.context.bindings.pushScope(lowerer.context.allocateBlockPrefix());
    try {
        lowerer.context.enterRuntimeIteration();
        try {
            const arguments_: Value[] = [
                {
                    ...lowerer.leafValue(accumulator, resultType),
                    nativeCaptures: [
                        lowerer.context.registerNativeBinding(accumulator),
                    ],
                },
                {
                    ...lowerer.leafValue(
                        `${source}[${index}]`,
                        dataType.element,
                    ),
                    nativeCaptures: [
                        lowerer.context.registerNativeBinding(source),
                        lowerer.context.registerNativeBinding(index),
                    ],
                },
                {
                    kind: "number",
                    cpp: `static_cast<double>(${index})`,
                    dataType: { kind: "number" },
                    nativeCaptures: [
                        lowerer.context.registerNativeBinding(index),
                    ],
                },
                {
                    ...nativeDataMetadata(narrowed),
                    kind: "data",
                    cpp: source,
                    dataType,
                    nativeCaptures: [
                        lowerer.context.registerNativeBinding(source),
                    ],
                },
            ];
            const reduced = storedCallback
                ? lowerer.compileFunctionValueCall(
                      storedCallback,
                      arguments_,
                      call,
                  )
                : lowerer.context.compileCallbackWithValues(
                      callback,
                      arguments_,
                      call,
                  );
            lowerer.context.emit({
                kind: "expression",
                code: `${accumulator} = ${lowerer.compileKnownValueForSink(reduced, resultType, callback)};`,
            });
        } finally {
            lowerer.context.leaveRuntimeIteration();
        }
    } finally {
        lowerer.context.bindings.popScope();
        lowerer.context.decreaseIndent();
    }
    lowerer.context.emit({ kind: "close", code: "}" });
    lowerer.registerLocal(accumulator, "owned");
    return lowerer.leafValue(accumulator, resultType);
}

function compileArraySome(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    const result = lowerer.context.allocateTemporaryCppName("some_result");
    lowerer.emitArrayCallbackLoop(
        call,
        "some",
        narrowed,
        dataType,
        false,
        () =>
            lowerer.context.emit({
                kind: "declaration",
                type: "bool",
                name: result,
                initializer: "false",
            }),
        (matched, callback) => {
            if (matched.kind !== "boolean") {
                lowerer.context.fail(
                    callback,
                    "Array.some callback must return a boolean value.",
                );
            }
            lowerer.context.emit({
                kind: "open",
                code: `if (${matched.cpp}) {`,
            });
            lowerer.context.increaseIndent();
            lowerer.context.emit({
                kind: "expression",
                code: `${result} = true;`,
            });
            lowerer.context.emit({
                kind: "control",
                code: "break;",
                transfer: "break",
            });
            lowerer.context.decreaseIndent();
            lowerer.context.emit({ kind: "close", code: "}" });
        },
    );
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
    lowerer.emitArrayCallbackLoop(
        call,
        "every",
        narrowed,
        dataType,
        false,
        () =>
            lowerer.context.emit({
                kind: "declaration",
                type: "bool",
                name: result,
                initializer: "true",
            }),
        (matched, callback) => {
            if (matched.kind !== "boolean") {
                lowerer.context.fail(
                    callback,
                    "Array.every callback must return a boolean value.",
                );
            }
            lowerer.context.emit({
                kind: "open",
                code: `if (!(${matched.cpp})) {`,
            });
            lowerer.context.increaseIndent();
            lowerer.context.emit({
                kind: "expression",
                code: `${result} = false;`,
            });
            lowerer.context.emit({
                kind: "control",
                code: "break;",
                transfer: "break",
            });
            lowerer.context.decreaseIndent();
            lowerer.context.emit({ kind: "close", code: "}" });
        },
    );
    return {
        kind: "boolean",
        cpp: result,
        dataType: { kind: "boolean" },
    };
}

function compileArrayMap(
    state: ArrayMethodState,
    method: "map" | "flatMap",
): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    const callback = call.arguments[0]
        ? lowerer.context.unwrap(call.arguments[0])
        : undefined;
    const identity =
        method === "map" &&
        callback &&
        isObjectIdentityFunction(callback, (expression) =>
            lowerer.context.libraryGlobal(expression),
        );
    const requested: DataType<"vector"> | undefined = state.typedResult
        ? { kind: "vector", element: { kind: "number" } }
        : (state.expectedResult ??
          arrayResultType(lowerer, call) ??
          (identity
              ? { kind: "vector", element: dataType.element }
              : undefined));
    if (requested?.kind !== "vector") {
        lowerer.context.fail(
            call,
            `Array.${method} callback results must belong to the native data model.`,
        );
    }
    let mappedType = requested;
    if (
        method === "map" &&
        call.arguments.length === 1 &&
        callback &&
        lowerer.context.libraryGlobal(callback) === "Number" &&
        mappedType.element.kind === "number" &&
        (dataType.element.kind === "string" ||
            dataType.element.kind === "number")
    ) {
        const source = lowerer.context.allocateTemporaryCppName("map_source");
        const index = lowerer.context.allocateTemporaryCppName("map_index");
        const output = lowerer.context.allocateTemporaryCppName("map_result");
        lowerer.context.emit({
            kind: "declaration",
            type: "auto&&",
            name: source,
            initializer: narrowed.cpp,
        });
        lowerer.context.emit(
            `${collectorCppType(state, mappedType)} ${output};`,
        );
        lowerer.context.emit({
            kind: "expression",
            code: `${output}.reserve(${source}.size());`,
        });
        lowerer.context.emit({
            kind: "open",
            code: `for (std::size_t ${index} = 0; ${index} < ${source}.size(); ++${index}) {`,
            iteration: true,
        });
        lowerer.context.increaseIndent();
        const converted =
            dataType.element.kind === "string"
                ? `bbl::js::number_from_string(${source}[${index}])`
                : `static_cast<double>(${source}[${index}])`;
        lowerer.context.emit({
            kind: "expression",
            code: `${output}.push_back(${converted});`,
        });
        lowerer.context.decreaseIndent();
        lowerer.context.emit({ kind: "close", code: "}" });
        return collectedArray(state, output, mappedType);
    }
    const output = lowerer.context.allocateTemporaryCppName("map_result");
    const lines = lowerer.context.captureEmittedLines(() =>
        lowerer.emitArrayCallbackLoop(
            call,
            method,
            narrowed,
            dataType,
            true,
            (source) => {
                lowerer.context.emit({
                    kind: "expression",
                    code: `${output}.reserve(${source}.size());`,
                });
            },
            (result, callback) => {
                if (method === "map")
                    mappedType = {
                        ...mappedType,
                        element: lowerer.retainedResultType(
                            result,
                            mappedType.element,
                            callback,
                        ),
                    };
                if (
                    method === "flatMap" &&
                    (result.kind === "tuple" ||
                        result.dataType?.kind === "tuple" ||
                        result.dataType?.kind === "vector" ||
                        result.dataType?.kind === "span")
                ) {
                    if (
                        lowerer.context.dataTypes.carriesBorrowedPlatformEvent(
                            mappedType.element,
                        )
                    )
                        lowerer.context.refuseBorrowedPlatformEventEscape(
                            result,
                            callback,
                            "Array.flatMap result",
                        );
                    const values = lowerer.compileKnownValueForSink(
                        result,
                        mappedType,
                        callback,
                    );
                    lowerer.context.emit({
                        kind: "expression",
                        code: `bbl::js::array_append(${output}, ${values});`,
                    });
                    return;
                }
                let value: string;
                if (
                    result.kind === "void" &&
                    mappedType.element.kind === "boolean"
                ) {
                    // Promise<void> is represented by its synchronous
                    // settlement token. The callback body has already
                    // run; preserve a concise call expression too, then
                    // store the fulfilled token consumed by Promise.all.
                    if (result.cpp.length > 0) {
                        lowerer.context.emit({
                            kind: "expression",
                            code: `${result.cpp};`,
                        });
                    }
                    value = "true";
                } else {
                    if (
                        lowerer.context.dataTypes.carriesBorrowedPlatformEvent(
                            mappedType.element,
                        )
                    ) {
                        lowerer.context.refuseBorrowedPlatformEventEscape(
                            result,
                            callback,
                            "Array.map result",
                        );
                    }
                    value = lowerer.compileKnownValueForSink(
                        result,
                        mappedType.element,
                        callback,
                    );
                }
                lowerer.context.emit({
                    kind: "expression",
                    code: `${output}.push_back(${value});`,
                });
            },
        ),
    );
    lowerer.context.emit(`${collectorCppType(state, mappedType)} ${output};`);
    for (const line of lines) lowerer.context.emit(line);
    return collectedArray(state, output, mappedType);
}

function compileArrayForEach(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    lowerer.emitArrayCallbackLoop(
        call,
        "forEach",
        narrowed,
        dataType,
        true,
        () => undefined,
        (result) => lowerer.context.emitDiscardedValue(result),
    );
    return { kind: "void", cpp: "" };
}

function compileArrayPush(state: ArrayMethodState): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType, dynamicOwner } = state;
    let lastEffect = call.arguments.length - 1;
    while (
        lastEffect >= 0 &&
        !expressionMayRunCode(call.arguments[lastEffect]!)
    )
        --lastEffect;
    const captureArguments = lastEffect >= 0;
    const capturedInitializer = (cpp: string, type: DataType): string => {
        const ownsReference =
            type.kind === "string" ||
            type.kind === "struct" ||
            type.kind === "arraybuffer" ||
            type.kind === "dataview" ||
            type.kind === "bufferview" ||
            type.kind === "json" ||
            type.kind === "optional" ||
            type.kind === "union" ||
            type.kind === "vector" ||
            type.kind === "map" ||
            type.kind === "set" ||
            type.kind === "iterator" ||
            type.kind === "tuple" ||
            type.kind === "product" ||
            type.kind === "enummap" ||
            isTypedArrayType(type);
        return ownsReference ? `bbl::js::snapshot_value(${cpp})` : cpp;
    };
    const callee = lowerer.context.unwrap(call.expression);
    const receiver =
        captureArguments ||
        (ts.isPropertyAccessExpression(callee) &&
            expressionMayRunCode(callee.expression))
            ? captureArrayReceiver(lowerer, narrowed)
            : narrowed.cpp;
    if (call.arguments.length === 0)
        return lowerer.leafValue(`static_cast<double>(${receiver}.size())`, {
            kind: "number",
        });
    lowerer.invalidateAliases(narrowed.cpp);
    const pushedHandleKind =
        dataType.element.kind === "handle"
            ? dataType.element.handle
            : undefined;
    const hasSpread = call.arguments.some((argument) =>
        ts.isSpreadElement(argument),
    );
    const staticElements =
        narrowed.staticElementsOwner?.staticElements ?? narrowed.staticElements;
    const preparedValues: string[] = [];
    const pushedValues =
        (pushedHandleKind || staticElements) && !hasSpread
            ? call.arguments.map((argument, index) => {
                  const boundary = lowerer.context.nativeBindingCheckpoint();
                  const value = lowerer.context.compileValue(argument);
                  lowerer.context.refuseBorrowedPlatformEventEscape(
                      value,
                      argument,
                      "Array.push",
                  );
                  const cpp = lowerer.compileKnownValueForSink(
                      value,
                      dataType.element,
                      argument,
                  );
                  let prepared = cpp;
                  if (index < lastEffect) {
                      prepared =
                          lowerer.context.allocateTemporaryCppName(
                              "push_argument",
                          );
                      const selected = lowerer.context.takeNativeTemporary(
                          cpp,
                          boundary,
                      );
                      lowerer.context.emit({
                          kind: "declaration",
                          type: "const auto",
                          name: prepared,
                          initializer:
                              selected === cpp
                                  ? capturedInitializer(cpp, dataType.element)
                                  : selected,
                      });
                  }
                  preparedValues.push(prepared);
                  // A static snapshot owns the value selected at push, including
                  // creation calls and a mutable source handle that is rebound later.
                  if (!pushedHandleKind || !staticElements) return value;
                  const snapshot = {
                      ...value,
                      ...(index < lastEffect ? { cpp: prepared } : {}),
                  };
                  delete snapshot.nativeBinding;
                  const pinned = lowerer.context.bindings.pinValueToTemporary(
                      snapshot,
                      "array_handle",
                      argument,
                  );
                  preparedValues[preparedValues.length - 1] = pinned.cpp;
                  return pinned;
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
    if (
        knownPush &&
        !lowerer.context.isInRuntimeControlFlow() &&
        staticElements &&
        pushedValues?.every(
            (value) =>
                (!pushedHandleKind || value.kind === pushedHandleKind) &&
                !value.runtimeIteration,
        )
    ) {
        const firstIndex = staticElements.length;
        const snapshotCpp = (narrowed.staticElementsOwner ?? narrowed).cpp;
        writable(staticElements).push(
            ...pushedValues.map((value, index) => {
                if (pushedHandleKind) return value;
                // A pushed object literal is a compile-time record,
                // but the array stores a native element. Keep the
                // record's static facts while rebasing its identity
                // and every later writable path to that stored slot.
                return withNativeMetadata(
                    lowerer.leafValue(
                        `${snapshotCpp}[${firstIndex + index}]`,
                        dataType.element,
                    ),
                    value,
                );
            }),
        );
    } else {
        if (pushedHandleKind && pushedValues?.length) {
            const snapshotOwner = writable(
                narrowed.staticElementsOwner ?? narrowed,
            );
            snapshotOwner.runtimeElementTemplate ??=
                staticElements?.[0] ?? pushedValues[0]!;
            if (pushedHandleKind === "mesh") {
                const candidates = [
                    snapshotOwner.runtimeElementTemplate,
                    ...(staticElements ?? []),
                    ...pushedValues,
                ];
                snapshotOwner.runtimeElementTemplate = commonResourceValue(
                    runtimeMeshValue(snapshotOwner.runtimeElementTemplate),
                    candidates,
                );
            } else if (pushedHandleKind === "material") {
                snapshotOwner.runtimeElementTemplate = commonResourceValue(
                    snapshotOwner.runtimeElementTemplate,
                    [
                        snapshotOwner.runtimeElementTemplate,
                        ...(staticElements ?? []),
                        ...pushedValues,
                    ],
                );
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
            if (
                lowerer.context.dataTypes.carriesBorrowedPlatformEvent(
                    dataType.element,
                )
            ) {
                lowerer.context.refuseBorrowedPlatformEventEscape(
                    spread,
                    argument,
                    "Array.push spread",
                );
            }
            if (spread.kind === "tuple" && spread.tupleElements) {
                const values = spread.tupleElements.map((value) =>
                    lowerer.compileKnownValueForSink(
                        value,
                        dataType.element,
                        argument,
                    ),
                );
                const source =
                    lowerer.context.allocateTemporaryCppName("push_spread");
                lowerer.context.emit({
                    kind: "declaration",
                    type: lowerer.context.dataTypes.cppType(dataType),
                    name: source,
                    initializer: values.join(", "),
                    initialization: "direct",
                });
                return `${receiver}.insert(${receiver}.end(), ${source}.begin(), ${source}.end())`;
            }
            let source: string;
            if (isJsonValue(spread) && dataType.element.kind === "json") {
                source = `${spread.cpp}.elements()`;
            } else if (
                spread.kind === "handle-collection" &&
                spread.handleCollection &&
                dataType.element.kind === "handle" &&
                spread.handleCollection.elementKind === dataType.element.handle
            ) {
                source = spread.handleCollection.containerCpp;
            } else if (
                spread.kind === "data" &&
                (((spread.dataType?.kind === "vector" ||
                    spread.dataType?.kind === "span") &&
                    dataTypesEqual(
                        spread.dataType.element,
                        dataType.element,
                    )) ||
                    (spread.dataType?.kind === "tuple" &&
                        dataType.element.kind === "number"))
            ) {
                source = spread.cpp;
            } else {
                lowerer.context.fail(
                    argument,
                    `Array.push spread must contain values of the destination element type ${JSON.stringify(dataType.element)}; received ${spread.kind} ${spread.dataType ? JSON.stringify(spread.dataType) : "without a data type"}.`,
                );
            }
            const copy =
                lowerer.context.allocateTemporaryCppName("push_spread");
            lowerer.context.emit({
                kind: "declaration",
                type: "auto",
                name: copy,
                initializer: `bbl::js::array_from_iterable<${lowerer.context.dataTypes.cppType(dataType.element)}>(${source})`,
            });
            return `${receiver}.insert(${receiver}.end(), ${copy}.begin(), ${copy}.end())`;
        }
        if (
            pushedValues &&
            lowerer.context.dataTypes.carriesBorrowedPlatformEvent(
                dataType.element,
            )
        ) {
            lowerer.context.refuseBorrowedPlatformEventEscape(
                pushedValues[index]!,
                argument,
                "Array.push",
            );
        }
        let value = preparedValues[index];
        if (value === undefined) {
            const boundary = lowerer.context.nativeBindingCheckpoint();
            const cpp = lowerer.compileForRetainedSink(
                argument,
                dataType.element,
                "Array.push",
            );
            value = cpp;
            if (index < lastEffect) {
                value =
                    lowerer.context.allocateTemporaryCppName("push_argument");
                const selected = lowerer.context.takeNativeTemporary(
                    cpp,
                    boundary,
                );
                lowerer.context.emit({
                    kind: "declaration",
                    type: "const auto",
                    name: value,
                    initializer:
                        selected === cpp
                            ? capturedInitializer(cpp, dataType.element)
                            : selected,
                });
            }
        }
        return `${receiver}.push_back(${value})`;
    });
    return lowerer.leafValue(
        `(${pushes.join(", ")}, static_cast<double>(${receiver}.size()))`,
        { kind: "number" },
    );
}

/**
 * `array.pop()` / `array.shift()`. JavaScript yields `undefined` for an
 * empty array, so the result is the element or absent. Only a non-null
 * assertion (`pop()!`, `pop() as T`) states presence; that keeps the
 * element type and an empty array refuses by name at run time.
 */
function compileArrayRemoval(
    state: ArrayMethodState,
    method: "pop" | "shift",
): Value {
    const lowerer: DataLowerer = state.lowerer;
    const { call, narrowed, dataType } = state;
    if (call.arguments.length !== 0) {
        lowerer.context.fail(call, `Array.${method} expects no arguments.`);
    }
    lowerer.invalidateAliases(narrowed.cpp);
    let parent = call.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    if (
        ts.isNonNullExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent)
    ) {
        return lowerer.leafValue(
            `bbl::js::array_${method}(${narrowed.cpp})`,
            dataType.element,
        );
    }
    // A nullable element is its own absent state, and a shared object is
    // absent as the empty reference, as `Map.get` reads them.
    const element = dataType.element;
    const resultType: DataType =
        element.kind === "optional" ||
        (element.kind === "struct" &&
            lowerer.context.dataTypes.isReferenceStruct(element.name))
            ? element
            : { kind: "optional", inner: element };
    const removal = `bbl::js::array_${method}_or_absent(${narrowed.cpp})`;
    // An element that may itself be `null` is `undefined` only when the
    // array was empty: take that fact with the removal (`Value.slotFoundCpp`).
    const callee = lowerer.context.unwrap(call.expression);
    const elementType = ts.isPropertyAccessExpression(callee)
        ? arrayElementType(
              lowerer.context.checker,
              lowerer.context.checker.getTypeAtLocation(callee.expression),
          )
        : undefined;
    if (!elementType || !slotHoldsOnlyNull(elementType))
        return lowerer.leafValue(removal, resultType);
    const found = lowerer.context.allocateTemporaryCppName("removal_found");
    lowerer.context.emit({
        kind: "declaration",
        type: "const bool",
        name: found,
        initializer: `!${narrowed.cpp}.empty()`,
        attributes: "[[maybe_unused]] ",
    });
    const removed = lowerer.context.allocateTemporaryCppName("removed");
    lowerer.context.emit({
        kind: "declaration",
        type: "auto",
        name: removed,
        initializer: removal,
        attributes: "[[maybe_unused]] ",
    });
    return { ...lowerer.leafValue(removed, resultType), slotFoundCpp: found };
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
    const receiver = captureArrayReceiver(lowerer, narrowed);
    let lastEffect = call.arguments.length - 1;
    while (
        lastEffect >= 0 &&
        !expressionMayRunCode(call.arguments[lastEffect]!)
    )
        --lastEffect;
    const values = call.arguments.map((argument, index) => {
        const cpp = lowerer.compileForRetainedSink(
            argument,
            dataType.element,
            "Array.unshift",
        );
        const name =
            lowerer.context.allocateTemporaryCppName("unshift_argument");
        lowerer.context.emit({
            kind: "declaration",
            type: index < lastEffect ? "const auto" : "const auto&",
            name,
            initializer:
                index < lastEffect ? `bbl::js::snapshot_value(${cpp})` : cpp,
        });
        return name;
    });
    return {
        kind: "number",
        cpp: `bbl::js::array_unshift(${receiver}, ` + `{${values.join(", ")}})`,
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

function compileArrayToReversed(state: ArrayMethodState): Value {
    const { lowerer, call, narrowed, dataType } = state;
    if (call.arguments.length !== 0)
        lowerer.context.fail(call, "Array.toReversed expects no arguments.");
    return {
        kind: "data",
        cpp: `bbl::js::array_to_reversed(${narrowed.cpp})`,
        dataType: { kind: "vector", element: dataType.element },
        freshData: true,
    };
}

/** `with(index, value)`: the receiver, then each argument, evaluated once. */
function compileArrayWith(state: ArrayMethodState): Value {
    const { lowerer, call, narrowed, dataType } = state;
    if (call.arguments.length !== 2)
        lowerer.context.fail(call, "Array.with expects an index and a value.");
    const receiver = captureArrayReceiver(lowerer, narrowed);
    const index = lowerer.compileNumberArgument(call.arguments[0], "0.0");
    const value = lowerer.compileForRetainedSink(
        argumentAt(call, 1),
        dataType.element,
        "Array.with",
    );
    return {
        kind: "data",
        cpp: `bbl::js::array_with(${receiver}, ${index}, ${value})`,
        dataType: { kind: "vector", element: dataType.element },
        freshData: true,
    };
}

function compileMapDataMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    method: string,
    narrowed: Value,
    dataType: DataType & { kind: "map" },
): Value | undefined {
    if (dataType.weak && !["get", "set", "has", "delete"].includes(method))
        lowerer.context.fail(call, `WeakMap.${method} is not represented.`);
    if (method === "forEach")
        return compileCollectionForEach(lowerer, call, narrowed, dataType);
    lowerer.context.reachJsData();
    if (method === "clear") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(call, "Map.clear expects no arguments.");
        }
        lowerer.context.recordCollectionClear(narrowed);
        if (lowerer.context.isInRuntimeControlFlow()) {
            lowerer.context.bindings.invalidateRecordProperties(narrowed);
        } else if (narrowed.recordProperties) {
            for (const key of Object.keys(narrowed.recordProperties)) {
                delete writable(narrowed.recordProperties)[key];
            }
        }
        return {
            kind: "void",
            cpp: `${narrowed.cpp}.clear()`,
        };
    }
    if (method === "has" || method === "get" || method === "delete") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(
                call,
                `Map.${method} expects exactly one key.`,
            );
        }
        const keyValue = lowerer.context.compileValue(argumentAt(call, 0));
        let key = lowerer.compileLookupKey(
            keyValue,
            dataType.key,
            argumentAt(call, 0),
        );
        // A lookup among values that may be `null` records whether its key
        // was there (`Value.slotFoundCpp`), reading the key once for both.
        let slotFoundCpp: string | undefined;
        const mapType = lowerer.context.checker.getNonNullableType(
            lowerer.context.checker.getTypeAtLocation(callee.expression),
        );
        const storedType =
            method === "get" && isTypeReference(mapType)
                ? lowerer.context.checker.getTypeArguments(mapType)[1]
                : undefined;
        if (storedType && slotHoldsOnlyNull(storedType)) {
            // The test reads the key again, so a key that is not a name or
            // a literal is read once, first.
            if (!cppIdentifierPattern.test(key) && !/^"[^"\\]*"$/.test(key)) {
                const pinned =
                    lowerer.context.allocateTemporaryCppName("map_key");
                lowerer.context.emit({
                    kind: "declaration",
                    type: "const auto",
                    name: pinned,
                    initializer: key,
                });
                key = pinned;
            }
            slotFoundCpp = `${narrowed.cpp}.has(${key})`;
        }
        const staticKey =
            keyValue.staticString ??
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
                lowerer.context.bindings.invalidateRecordProperties(narrowed);
            } else if (staticKey !== undefined && narrowed.recordProperties) {
                delete writable(narrowed.recordProperties)[staticKey];
            } else if (staticKey === undefined) {
                lowerer.context.bindings.invalidateRecordProperties(narrowed);
            }
            return {
                kind: "boolean",
                cpp: `${narrowed.cpp}.erase(${key})`,
                requiresExplicitDiscard: true,
            };
        }
        if (dataType.value.kind === "handle") {
            const result = lowerer.context.allocateTemporaryCppName("map_get");
            lowerer.context.emit({
                kind: "declaration",
                type: "const auto",
                name: result,
                initializer: `${narrowed.cpp}.get(${key})`,
            });
            const known =
                staticKey === undefined
                    ? undefined
                    : narrowed.recordProperties?.[staticKey];
            return {
                ...withNativeMetadata(
                    lowerer.leafValue(`(*${result})`, dataType.value),
                    known,
                ),
                optionalFoundCpp: optionalPresentCpp(result),
                optionalStorageCpp: `${result}.to_optional()`,
                ...(slotFoundCpp ? { slotFoundCpp } : {}),
            };
        }
        return {
            // Map.get declares its absence, so source guards may narrow it.
            ...lowerer.mapPropertyValue(
                narrowed.cpp,
                key,
                dataType.value,
                false,
            ),
            ...(slotFoundCpp ? { slotFoundCpp } : {}),
        };
    }
    if (method === "set") {
        if (call.arguments.length !== 2) {
            lowerer.context.fail(
                call,
                "Map.set expects exactly one key and one value.",
            );
        }
        const keyValue = lowerer.context.compileValue(argumentAt(call, 0));
        const assignedValue = lowerer.context.compileValue(argumentAt(call, 1));
        lowerer.context.recordCollectionKey(narrowed, keyValue);
        if (
            lowerer.context.dataTypes.carriesBorrowedPlatformEvent(dataType.key)
        ) {
            lowerer.context.refuseBorrowedPlatformEventEscape(
                keyValue,
                argumentAt(call, 0),
                "Map.set key",
            );
        }
        if (
            lowerer.context.dataTypes.carriesBorrowedPlatformEvent(
                dataType.value,
            )
        ) {
            lowerer.context.refuseBorrowedPlatformEventEscape(
                assignedValue,
                argumentAt(call, 1),
                "Map.set value",
            );
        }
        const key = lowerer.compileKnownValueForSink(
            keyValue,
            dataType.key,
            argumentAt(call, 0),
        );
        const value = lowerer.compileKnownValueForSink(
            assignedValue,
            dataType.value,
            argumentAt(call, 1),
        );
        const staticKey =
            keyValue.staticString ??
            (keyValue.staticNumber !== undefined
                ? String(keyValue.staticNumber)
                : undefined);
        if (lowerer.context.isInRuntimeControlFlow()) {
            lowerer.context.bindings.invalidateRecordProperties(narrowed);
        } else if (staticKey !== undefined && narrowed.recordProperties) {
            writable(narrowed.recordProperties)[staticKey] = assignedValue;
        } else if (staticKey === undefined) {
            lowerer.context.bindings.invalidateRecordProperties(narrowed);
        }
        return {
            kind: "data",
            cpp: `${narrowed.cpp}.set(${key}, ${value})`,
            dataType,
            ...(narrowed.collectionCardinality
                ? { collectionCardinality: narrowed.collectionCardinality }
                : {}),
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
                element: method === "values" ? dataType.value : dataType.key,
            },
            freshData: true,
        };
    }
    lowerer.context.fail(
        callee.name,
        `Map method '${method}' is not supported.`,
    );
}

function compileSetDataMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    method: string,
    narrowed: Value,
    dataType: DataType & { kind: "set" },
): Value | undefined {
    if (method === "entries" || method === "values" || method === "keys") {
        lowerer.context.expectArgumentCount(call, 0, 0);
        lowerer.context.reachJsData();
        const entries = method === "entries";
        const element = entries
            ? lowerer.context.dataTypes.tupleStorage([
                  dataType.element,
                  dataType.element,
              ])
            : dataType.element;
        return lowerer.leafValue(
            `bbl::js::set_iterator<${lowerer.context.dataTypes.cppType(element)}, ${entries}>(${narrowed.cpp})`,
            { kind: "iterator", element, traced: true },
        );
    }
    if (method === "forEach")
        return compileCollectionForEach(lowerer, call, narrowed, dataType);
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
            lowerer.context.fail(
                call,
                `Set.${method} expects exactly one value.`,
            );
        }
        const member = lowerer.context.compileValue(argumentAt(call, 0));
        const value = lowerer.compileLookupKey(
            member,
            dataType.element,
            argumentAt(call, 0),
        );
        if (method === "delete")
            lowerer.context.recordCollectionKey(narrowed, member, true);
        return {
            kind: "boolean",
            cpp:
                method === "has"
                    ? `${narrowed.cpp}.has(${value})`
                    : `${narrowed.cpp}.erase(${value})`,
            ...(method === "delete" ? { requiresExplicitDiscard: true } : {}),
        };
    }
    if (method === "add") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(call, "Set.add expects exactly one value.");
        }
        const member = lowerer.context.compileValue(argumentAt(call, 0));
        if (
            lowerer.context.dataTypes.carriesBorrowedPlatformEvent(
                dataType.element,
            ) ||
            (dataType.element.kind === "handle" &&
                dataType.element.handle === "dom-event-identity")
        ) {
            lowerer.context.refuseBorrowedPlatformEventEscape(
                member,
                argumentAt(call, 0),
                "Set.add",
            );
        }
        const value = lowerer.compileKnownValueForSink(
            member,
            dataType.element,
            argumentAt(call, 0),
        );
        lowerer.context.recordCollectionKey(narrowed, member);
        return {
            kind: "data",
            cpp: `${narrowed.cpp}.add(${value})`,
            dataType,
            ...(narrowed.collectionCardinality
                ? { collectionCardinality: narrowed.collectionCardinality }
                : {}),
        };
    }
    lowerer.context.fail(
        callee.name,
        `Set method '${method}' is not supported.`,
    );
}

/**
 * The string searches that take a UTF-16 position, at every arity: the
 * runtime helper, its result, the position an absent (undefined) argument
 * stands for -- also the helper's default when the call passes none -- and,
 * where one exists, the generation-time answer over a known receiver and
 * needle with no position.
 */
interface StringPositionSearch {
    readonly helper: string;
    readonly result: "number" | "boolean";
    readonly absent: "start" | "end";
    readonly fold?: (receiver: string, search: string) => boolean;
}

const STRING_POSITION_SEARCHES: ReadonlyMap<string, StringPositionSearch> =
    new EmissionMap<string, StringPositionSearch>([
        [
            "indexOf",
            { helper: "string_index_of", result: "number", absent: "start" },
        ],
        [
            "includes",
            { helper: "string_includes", result: "boolean", absent: "start" },
        ],
        [
            "lastIndexOf",
            { helper: "string_last_index_of", result: "number", absent: "end" },
        ],
        [
            "startsWith",
            {
                helper: "string_starts_with",
                result: "boolean",
                absent: "start",
                fold: (receiver, search) => receiver.startsWith(search),
            },
        ],
        [
            "endsWith",
            { helper: "string_ends_with", result: "boolean", absent: "end" },
        ],
    ]);

/**
 * `s.indexOf(search, position)` and its siblings: the receiver, the search
 * string and the position evaluate once, in order. The position is a UTF-16
 * index read through ToNumber (`null` is 0); undefined reads as the absent
 * position, which for `lastIndexOf`/`endsWith` is the end and so needs
 * storage telling it from `null`.
 */
function compileStringPositionSearch(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    method: string,
    search: StringPositionSearch,
    narrowed: Value,
): Value {
    const context = lowerer.context;
    if (call.arguments.length < 1 || call.arguments.length > 2)
        context.fail(
            call,
            `String.${method} expects a search string and an optional position.`,
        );
    const callee = context.unwrap(call.expression);
    const operands = [
        ts.isPropertyAccessExpression(callee) ? callee.expression : callee,
        ...call.arguments,
    ];
    const pins = context.evaluationOrder.operandsToPin(operands);
    const receiver = pins[0]
        ? pinOperand(context, narrowed, operands[0]!, "search_receiver")
        : narrowed;
    const searchNode = argumentAt(call, 0);
    const searchValue = context.compileValue(searchNode);
    const positionNode = call.arguments[1];
    if (
        search.fold &&
        !positionNode &&
        narrowed.staticString !== undefined &&
        searchValue.staticString !== undefined
    ) {
        const value = search.fold(
            narrowed.staticString,
            searchValue.staticString,
        );
        return {
            kind: "boolean",
            cpp: value ? "true" : "false",
            staticBoolean: value,
            dataType: { kind: "boolean" },
        };
    }
    const searchText = lowerer.compileKnownValueForSink(
        pins[1]
            ? pinOperand(context, searchValue, searchNode, "search_text")
            : searchValue,
        { kind: "string" },
        searchNode,
    );
    const position = positionNode
        ? compileSearchPosition(lowerer, positionNode, method, search)
        : undefined;
    return lowerer.leafValue(
        `bbl::js::${search.helper}(${receiver.cpp}, ${searchText}${position === undefined ? "" : `, ${position}`})`,
        { kind: search.result },
    );
}

/** A passed search position as a double: see `compileStringPositionSearch`. */
function compileSearchPosition(
    lowerer: DataLowerer,
    node: ts.Expression,
    method: string,
    search: StringPositionSearch,
): string {
    const context = lowerer.context;
    const admitted = nullability(context.checker.getTypeAtLocation(node));
    if (!admitted.null && !admitted.undefined)
        return context.compileNumber(node, "double");
    const value = context.compileValue(node);
    const absence = absenceKind(context.checker, value, node);
    const fallback =
        search.absent === "start"
            ? "0.0"
            : absence === "null"
              ? "0.0"
              : typeof absence === "object"
                ? `(${absence.slotFoundCpp} ? 0.0 : std::numeric_limits<double>::infinity())`
                : absence === "either"
                  ? context.fail(
                        node,
                        `String.${method} reads a null position as 0 and an undefined one as the end; this position's storage cannot tell them apart.`,
                    )
                  : "std::numeric_limits<double>::infinity()";
    const optional = lowerer.compileKnownValueForSink(
        value,
        { kind: "optional", inner: { kind: "number" } },
        node,
    );
    return `bbl::js::number_from_optional(${optional}, ${fallback})`;
}

function compileStringDataMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    method: string,
    narrowed: Value,
): Value | undefined {
    lowerer.context.reachJsData();
    const stringValue = compileStringValueMethod(
        lowerer,
        call,
        method,
        narrowed,
    );
    if (stringValue) return stringValue;
    if (method === "match" || method === "matchAll") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(
                call,
                `String.${method} expects one RegExp argument.`,
            );
        }
        const pattern = lowerer.context.compileValue(argumentAt(call, 0));
        if (pattern.kind !== "regexp") {
            lowerer.context.fail(
                argumentAt(call, 0),
                `Reached String.${method} uses a RegExp pattern.`,
            );
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
    const positionedSearch = STRING_POSITION_SEARCHES.get(method);
    if (positionedSearch)
        return compileStringPositionSearch(
            lowerer,
            call,
            method,
            positionedSearch,
            narrowed,
        );
    if (method === "toUpperCase") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(
                call,
                "String.toUpperCase takes no arguments.",
            );
        }
        return {
            kind: "data",
            cpp: `bbl::js::string_upper(${narrowed.cpp})`,
            dataType: { kind: "string" },
        };
    }
    if (method === "toLowerCase") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(
                call,
                "String.toLowerCase takes no arguments.",
            );
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
            lowerer.context.fail(
                call,
                "String.slice expects one or two arguments.",
            );
        }
        const staticBegin = lowerer.context.compileValue(argumentAt(call, 0));
        const staticEnd = call.arguments[1]
            ? lowerer.context.compileValue(call.arguments[1])
            : undefined;
        if (
            narrowed.staticString !== undefined &&
            staticBegin.kind === "number" &&
            staticBegin.staticNumber !== undefined &&
            !staticBegin.parameterBinding &&
            (staticEnd === undefined ||
                (staticEnd.kind === "number" &&
                    staticEnd.staticNumber !== undefined &&
                    !staticEnd.parameterBinding))
        ) {
            const value = narrowed.staticString.slice(
                staticBegin.staticNumber,
                staticEnd?.staticNumber,
            );
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
        const separatorValue = lowerer.context.compileValue(
            argumentAt(call, 0),
        );
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
        const separator = lowerer.compileForSink(argumentAt(call, 0), {
            kind: "string",
        });
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
            lowerer.context.fail(
                call,
                "String.replace expects a pattern and replacement.",
            );
        }
        const replacementType = lowerer.context.checker.getTypeAtLocation(
            argumentAt(call, 1),
        );
        const callbackReplacement = (
            replacementType.isUnion()
                ? replacementType.types
                : [replacementType]
        ).some((type) => type.getCallSignatures().length !== 0);
        const replacementMayChange =
            callbackReplacement || expressionMayRunCode(argumentAt(call, 1));
        const argumentsMayChange =
            replacementMayChange || expressionMayRunCode(argumentAt(call, 0));
        const snapshot = (
            value: Value,
            label: string,
            mayChange: boolean,
        ): string => {
            if (!mayChange && cppIdentifierPattern.test(value.cpp))
                return value.cpp;
            if (
                value.staticString !== undefined &&
                value.cpp !== lowerer.context.cppString(value.staticString)
            ) {
                value = { ...value };
                delete writable(value).staticString;
            }
            return lowerer.context.bindings.pinValueToTemporary(value, label)
                .cpp;
        };
        const source = snapshot(narrowed, "replace_source", argumentsMayChange);
        const pattern = lowerer.context.compileValue(argumentAt(call, 0));
        if (pattern.kind === "string" || pattern.dataType?.kind === "string") {
            const search = snapshot(
                pattern,
                "replace_search",
                replacementMayChange,
            );
            const replacementValue = lowerer.context.compileValue(
                argumentAt(call, 1),
            );
            if (
                replacementValue.kind === "callback" ||
                replacementValue.dataType?.kind === "function"
            ) {
                const adapter = replacementCallback(
                    lowerer,
                    call,
                    replacementValue,
                );
                return lowerer.leafValue(
                    `bbl::js::string_replace_with(${source}, ${search}, ${adapter}, ${method === "replaceAll"})`,
                    { kind: "string" },
                );
            }
            if (
                narrowed.staticString !== undefined &&
                pattern.staticString !== undefined &&
                replacementValue.staticString !== undefined
            ) {
                const value =
                    method === "replaceAll"
                        ? narrowed.staticString.replaceAll(
                              pattern.staticString,
                              replacementValue.staticString,
                          )
                        : narrowed.staticString.replace(
                              pattern.staticString,
                              replacementValue.staticString,
                          );
                return {
                    ...lowerer.leafValue(lowerer.context.cppString(value), {
                        kind: "string",
                    }),
                    staticString: value,
                };
            }
            const replacement = lowerer.compileKnownValueForSink(
                replacementValue,
                { kind: "string" },
                argumentAt(call, 1),
            );
            return lowerer.leafValue(
                `bbl::js::string_replace(${source}, ${search}, ${replacement}, ${method === "replaceAll"})`,
                { kind: "string" },
            );
        }
        if (pattern.kind !== "regexp") {
            lowerer.context.fail(
                argumentAt(call, 0),
                "Reached String.replace uses a RegExp pattern.",
            );
        }
        const regex =
            lowerer.context.allocateTemporaryCppName("replace_pattern");
        lowerer.context.emit({
            kind: "declaration",
            type: "const auto",
            name: regex,
            initializer: pattern.cpp,
            attributes: "[[maybe_unused]] ",
        });
        const replacementValue = lowerer.context.compileValue(
            argumentAt(call, 1),
        );
        if (
            replacementValue.kind === "callback" ||
            replacementValue.dataType?.kind === "function"
        ) {
            const adapter = replacementCallback(
                lowerer,
                call,
                replacementValue,
                pattern,
            );
            return lowerer.leafValue(
                `${regex}.replace_with(${source}, ${adapter}, ${method === "replaceAll"})`,
                { kind: "string" },
            );
        }
        if (method === "replaceAll")
            lowerer.context.fail(
                call,
                "String.replaceAll currently requires a string pattern or RegExp callback.",
            );
        const patternExpression = lowerer.context.unwrap(argumentAt(call, 0));
        if (
            narrowed.staticString !== undefined &&
            replacementValue.staticString !== undefined &&
            ts.isRegularExpressionLiteral(patternExpression)
        ) {
            const { pattern: source, flags } =
                regularExpressionParts(patternExpression)!;
            const value = narrowed.staticString.replace(
                new RegExp(source, flags),
                replacementValue.staticString,
            );
            return {
                kind: "string",
                cpp: lowerer.context.cppString(value),
                staticString: value,
                dataType: { kind: "string" },
            };
        }
        if (!isStringValue(replacementValue)) {
            lowerer.context.fail(
                argumentAt(call, 1),
                "String.replace expects a string replacement.",
            );
        }
        const replacement = replacementValue.cpp;
        return {
            kind: "data",
            cpp: `${regex}.replace(${source}, ${replacement})`,
            dataType: { kind: "string" },
        };
    }
    if (method === "charCodeAt") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(
                call,
                "String.charCodeAt expects one argument.",
            );
        }
        return {
            kind: "number",
            cpp: `bbl::js::string_char_code_at(${lowerer.stringIndexReceiver(narrowed, call)}, ${lowerer.context.compileNumber(argumentAt(call, 0), "double")})`,
            dataType: { kind: "number" },
        };
    }
    if (method === "padStart" || method === "padEnd") {
        if (call.arguments.length < 1 || call.arguments.length > 2) {
            lowerer.context.fail(
                call,
                `String.${method} expects one or two arguments.`,
            );
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
            lowerer.context.fail(
                call,
                "String.charAt expects at most one index.",
            );
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

const DATA_VIEW_ACCESSORS: ReadonlyMap<string, DataViewAccessor> =
    new EmissionMap(
        [
            "Int8",
            "Uint8",
            "Int16",
            "Uint16",
            "Int32",
            "Uint32",
            "Float32",
            "Float64",
        ].flatMap((lane): Array<[string, DataViewAccessor]> => {
            const native = lane.toLowerCase();
            const wide = !lane.endsWith("8");
            return [
                [
                    `get${lane}`,
                    { native: `get_${native}`, setter: false, wide },
                ],
                [`set${lane}`, { native: `set_${native}`, setter: true, wide }],
            ];
        }),
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
        ? [
              call.arguments[fixed]
                  ? lowerer.context.conditions.compileCondition(
                        call.arguments[fixed],
                    )
                  : "false",
          ]
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
function compileArrayKeys({
    lowerer,
    call,
    narrowed,
}: ArrayMethodState): Value {
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

const arrayMethodHandlers = new EmissionMap<
    string,
    (state: ArrayMethodState) => Value
>([
    ["flat", compileArrayFlat],
    ["join", compileArrayJoin],
    ["slice", compileArraySlice],
    ["sort", (state) => compileArraySort(state, "sort")],
    ["toSorted", (state) => compileArraySort(state, "toSorted")],
    ["toReversed", compileArrayToReversed],
    ["with", compileArrayWith],
    ["find", (state) => compileArrayFind(state, "find")],
    ["findIndex", (state) => compileArrayFindIndex(state, "findIndex")],
    ["findLast", (state) => compileArrayFind(state, "findLast")],
    ["findLastIndex", (state) => compileArrayFindIndex(state, "findLastIndex")],
    ["filter", compileArrayFilter],
    ["reduce", (state) => compileArrayReduce(state, "reduce")],
    ["reduceRight", (state) => compileArrayReduce(state, "reduceRight")],
    ["some", compileArraySome],
    ["every", compileArrayEvery],
    ["map", (state) => compileArrayMap(state, "map")],
    ["flatMap", (state) => compileArrayMap(state, "flatMap")],
    ["forEach", compileArrayForEach],
    // The iterator methods outside a for...of range (which walks the
    // array itself): keys is a fresh index list, values the array.
    ["keys", compileArrayKeys],
    ["values", ({ narrowed }) => narrowed],
    ["push", compileArrayPush],
    ["pop", (state) => compileArrayRemoval(state, "pop")],
    ["shift", (state) => compileArrayRemoval(state, "shift")],
    ["unshift", compileArrayUnshift],
    ["reverse", compileArrayReverse],
]);
