// The data-container method knowledge: the method-name sets every
// mutation walk consults, and the dispatcher that lowers a data-method
// call (invoked through `DataLowerer.compileDataMethodCall`).
import ts from "typescript";

import {
    dataTypesEqual,
    isTypedArrayType,
    typedArrayStoreExpression,
    type DataType,
} from "./data-types.js";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";

/** Data-container methods whose receiver is not mutated. */
export const readOnlyDataMethods: ReadonlySet<string> = new Set([
    "at",
    "concat",
    "entries",
    "every",
    "filter",
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

/** Array methods that can change its length and invalidate element aliases. */
export const resizingArrayMethods: ReadonlySet<string> = new Set([
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
]);

/** Array methods that mutate the receiver even when its length is unchanged. */
export const mutatingArrayMethods: ReadonlySet<string> = new Set([
    ...resizingArrayMethods,
    "copyWithin",
    "fill",
    "reverse",
    "sort",
]);

/** Methods that retain argument identity without mutating the argument itself. */
export const storingDataMethods: ReadonlySet<string> = new Set([
    "add",
    "push",
    "set",
    "splice",
    "unshift",
]);

/**
 * Compiles data-container method calls (`push`, `pop`, `fill`) and the
 * `new Array(n).fill(v)` chain.
 */
export function compileDataMethodCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
): Value | undefined {
    const callee = lowerer.context.unwrap(
        call.expression,
    );
    if (!ts.isPropertyAccessExpression(callee)) {
        return undefined;
    }
    const method = callee.name.text;
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
            const value = lowerer.compileForSink(
                call.arguments[0]!,
                created.element,
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
            const number = lowerer.context.compileNumber(
                call.arguments[0]!,
                "double",
            );
            const value = typedArrayStoreExpression(
                typed.dataType.kind,
                number,
            );
            lowerer.context.emit(
                `auto ${temporary} = ${typed.cpp};`,
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
        ts.isConditionalExpression(ownerExpression)
            ? lowerer.context.compileValue(ownerExpression)
            : ts.isIdentifier(ownerExpression)
              ? (lowerer.context.lookupIdentifierValue(ownerExpression) ??
                lowerer.compileStaticContainer(ownerExpression))
              : ts.isPropertyAccessExpression(ownerExpression) &&
                  ts.isIdentifier(
                      lowerer.context.unwrap(ownerExpression.expression),
                  ) &&
                  lowerer.context.lookupOptional(
                      lowerer.context.unwrap(
                          ownerExpression.expression,
                      ) as ts.Identifier,
                  )?.kind === "record"
                ? lowerer.context.compileValue(ownerExpression)
              : ts.isStringLiteralLike(ownerExpression) ||
                  ts.isTemplateExpression(ownerExpression)
                ? lowerer.context.compileValue(ownerExpression)
                : undefined;
    const owner =
        lowerer.compileDataPath(
            callee.expression,
            method === "pop" ||
                method === "shift" ||
                method === "push" ||
            method === "unshift" ||
                method === "reverse" ||
                method === "fill" ||
                method === "splice" ||
                method === "set" ||
                method === "add" ||
                method === "clear" ||
                method === "delete"
                ? "write"
                : "read",
        ) ??
        (dynamicOwner?.kind === "data" ||
        dynamicOwner?.kind === "string"
            ? dynamicOwner
            : undefined) ??
        // A constant array is a compile-time tuple with nothing to
        // search, so searching one materializes it exactly as a
        // runtime index into it does.
        ([
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
        ].includes(method)
            ? (lowerer.materializeConstantArray(
                  callee.expression,
              ) ??
              (!lowerer.namesHandleCollection(callee.expression)
                  ? lowerer.materializeKnownTuple(
                        callee.expression,
                    )
                  : undefined))
            : undefined);
    if (
        !owner ||
        (owner.kind !== "data" && owner.kind !== "string")
    ) {
        return undefined;
    }
    const narrowed = lowerer.narrowOptional(
        owner,
        callee.expression,
    );
    if (
        ["pop", "shift", "unshift", "reverse", "fill", "splice", "set", "clear", "delete"].includes(
            method,
        )
    ) {
        lowerer.invalidateStaticElements(narrowed);
    }
    const dataType =
        narrowed.dataType ??
        (narrowed.kind === "string"
            ? ({ kind: "string" } as const)
            : undefined);
    if (dataType?.kind === "struct") {
        const field = lowerer.context.dataTypes
            .structFields(dataType.name, callee.name)
            .find((candidate) => candidate.name === method);
        const functionType = field?.type;
        if (functionType?.kind === "function") {
            const argumentsCpp = lowerer.compileFunctionArguments(
                call,
                functionType,
                `Stored function '${method}'`,
            );
            const member = lowerer.context.dataTypes.isReferenceStruct(
                dataType.name,
            )
                ? "->"
                : ".";
            const cpp = `${narrowed.cpp}${member}${field!.name}(${argumentsCpp.join(", ")})`;
            return functionType.result
                ? lowerer.leafValue(cpp, functionType.result)
                : { kind: "void", cpp };
        }
    }
    if (dataType?.kind === "map") {
        lowerer.context.reachJsData();
        if (method === "has" || method === "get" || method === "delete") {
            if (call.arguments.length !== 1) {
                lowerer.context.fail(
                    call,
                    `Map.${method} expects exactly one key.`,
                );
            }
            const key = lowerer.compileForSink(
                call.arguments[0]!,
                dataType.key,
            );
            if (method === "has") {
                return {
                    kind: "boolean",
                    cpp: `${narrowed.cpp}.has(${key})`,
                };
            }
            if (method === "delete") {
                return {
                    kind: "boolean",
                    cpp: `${narrowed.cpp}.erase(${key})`,
                    requiresExplicitDiscard: true,
                };
            }
            if (
                dataType.value.kind === "struct" &&
                lowerer.context.dataTypes.isReferenceStruct(
                    dataType.value.name,
                )
            ) {
                // Shared object handles carry absence themselves. Do
                // not wrap and immediately dereference Map.get: a miss
                // must remain an empty handle for the source guard.
                return lowerer.leafValue(
                    `${narrowed.cpp}.get(${key})`,
                    dataType.value,
                );
            }
            return {
                kind: "data",
                cpp: `${narrowed.cpp}.get(${key})`,
                // TypeScript flattens `(T | null) | undefined` to one
                // nullable union. Preserve that shape so a single
                // source guard narrows a Map whose value is nullable.
                dataType:
                    dataType.value.kind === "optional"
                        ? dataType.value
                        : {
                              kind: "optional",
                              inner: dataType.value,
                          },
            };
        }
        if (method === "set") {
            if (call.arguments.length !== 2) {
                lowerer.context.fail(
                    call,
                    "Map.set expects exactly one key and one value.",
                );
            }
            const key = lowerer.compileForSink(
                call.arguments[0]!,
                dataType.key,
            );
            const value = lowerer.compileForSink(
                call.arguments[1]!,
                dataType.value,
            );
            return {
                kind: "data",
                cpp: `${narrowed.cpp}.set(${key}, ${value})`,
                dataType,
            };
        }
        if (method === "values" || method === "keys") {
            if (call.arguments.length !== 0) {
                lowerer.context.fail(
                    call,
                    `Map.${method} expects no arguments.`,
                );
            }
            return {
                kind: "data",
                cpp: `bbl::js::map_${method}(${narrowed.cpp})`,
                dataType: {
                    kind: "vector",
                    element:
                        method === "values"
                            ? dataType.value
                            : dataType.key,
                },
                freshData: true,
            };
        }
        lowerer.context.fail(
            callee.name,
            `Map method '${method}' is not supported.`,
        );
    }
    if (dataType?.kind === "set") {
        lowerer.context.reachJsData();
        if (method === "clear") {
            if (call.arguments.length !== 0) {
                lowerer.context.fail(
                    call,
                    "Set.clear expects no arguments.",
                );
            }
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
            const value = lowerer.compileForSink(
                call.arguments[0]!,
                dataType.element,
            );
            return {
                kind: "boolean",
                cpp:
                    method === "has"
                        ? `${narrowed.cpp}.has(${value})`
                        : `${narrowed.cpp}.erase(${value})`,
                ...(method === "delete"
                    ? { requiresExplicitDiscard: true }
                    : {}),
            };
        }
        if (method === "add") {
            if (call.arguments.length !== 1) {
                lowerer.context.fail(
                    call,
                    "Set.add expects exactly one value.",
                );
            }
            const value = lowerer.compileForSink(
                call.arguments[0]!,
                dataType.element,
            );
            return {
                kind: "data",
                cpp: `${narrowed.cpp}.add(${value})`,
                dataType,
            };
        }
        lowerer.context.fail(
            callee.name,
            `Set method '${method}' is not supported.`,
        );
    }
    if (dataType?.kind === "string") {
        lowerer.context.reachJsData();
        if (method === "match" || method === "matchAll") {
            if (call.arguments.length !== 1) {
                lowerer.context.fail(
                    call,
                    `String.${method} expects one RegExp argument.`,
                );
            }
            const pattern = lowerer.context.compileValue(
                call.arguments[0]!,
            );
            if (pattern.kind !== "regexp") {
                lowerer.context.fail(
                    call.arguments[0]!,
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
        if (method === "indexOf" || method === "includes") {
            if (call.arguments.length !== 1) {
                lowerer.context.fail(
                    call,
                    `String.${method} expects one argument; the fromIndex form is outside the supported subset.`,
                );
            }
            const search = lowerer.compileForSink(
                call.arguments[0]!,
                { kind: "string" },
            );
            const index =
                `bbl::js::string_index_of(${narrowed.cpp}, ${search})`;
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
            const staticBegin = lowerer.context.compileValue(
                call.arguments[0]!,
            );
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
                lowerer.context.fail(
                    call,
                    "String.split expects one separator.",
                );
            }
            const separatorValue = lowerer.context.compileValue(
                call.arguments[0]!,
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
            const separator = lowerer.compileForSink(
                call.arguments[0]!,
                { kind: "string" },
            );
            return {
                kind: "data",
                cpp: `bbl::js::string_split(${narrowed.cpp}, ${separator})`,
                dataType: {
                    kind: "vector",
                    element: { kind: "string" },
                },
            };
        }
        if (method === "replace") {
            if (call.arguments.length !== 2) {
                lowerer.context.fail(
                    call,
                    "String.replace expects a pattern and replacement.",
                );
            }
            const pattern = lowerer.context.compileValue(
                call.arguments[0]!,
            );
            if (pattern.kind !== "regexp") {
                lowerer.context.fail(
                    call.arguments[0]!,
                    "Reached String.replace uses a RegExp pattern.",
                );
            }
            const replacementValue = lowerer.context.compileValue(
                call.arguments[1]!,
            );
            const patternExpression = lowerer.context.unwrap(
                call.arguments[0]!,
            );
            if (
                narrowed.staticString !== undefined &&
                replacementValue.staticString !== undefined &&
                ts.isRegularExpressionLiteral(patternExpression)
            ) {
                const literal = patternExpression.text;
                const delimiter = literal.lastIndexOf("/");
                const flags = literal.slice(delimiter + 1);
                const source = literal
                    .slice(1, delimiter)
                    .replaceAll("\\/", "/");
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
            if (
                replacementValue.kind !== "string" &&
                !(
                    replacementValue.kind === "data" &&
                    replacementValue.dataType?.kind === "string"
                )
            ) {
                lowerer.context.fail(
                    call.arguments[1]!,
                    "String.replace expects a string replacement.",
                );
            }
            const replacement = replacementValue.cpp;
            return {
                kind: "data",
                cpp: `${pattern.cpp}.replace(${narrowed.cpp}, ${replacement})`,
                dataType: { kind: "string" },
            };
        }
        if (method === "startsWith") {
            if (call.arguments.length !== 1) {
                lowerer.context.fail(call, "String.startsWith expects one argument.");
            }
            const prefixValue = lowerer.context.compileValue(
                call.arguments[0]!,
            );
            if (
                narrowed.staticString !== undefined &&
                prefixValue.staticString !== undefined
            ) {
                const value = narrowed.staticString.startsWith(
                    prefixValue.staticString,
                );
                return {
                    kind: "boolean",
                    cpp: value ? "true" : "false",
                    staticBoolean: value,
                    dataType: { kind: "boolean" },
                };
            }
            if (
                prefixValue.kind !== "string" &&
                !(
                    prefixValue.kind === "data" &&
                    prefixValue.dataType?.kind === "string"
                )
            ) {
                lowerer.context.fail(
                    call.arguments[0]!,
                    "String.startsWith expects a string argument.",
                );
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
            const suffix = lowerer.compileForSink(
                call.arguments[0]!,
                { kind: "string" },
            );
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
                cpp: `bbl::js::string_char_code_at(${narrowed.cpp}, ${lowerer.context.compileNumber(call.arguments[0]!, "double")})`,
                dataType: { kind: "number" },
            };
        }
        if (method === "padStart") {
            if (call.arguments.length < 1 || call.arguments.length > 2) {
                lowerer.context.fail(call, "String.padStart expects one or two arguments.");
            }
            const fill = call.arguments[1]
                ? lowerer.compileForSink(call.arguments[1], { kind: "string" })
                : lowerer.context.cppString(" ");
            return {
                kind: "data",
                cpp: `bbl::js::string_pad_start(${narrowed.cpp}, ${lowerer.context.compileNumber(call.arguments[0]!, "double")}, ${fill})`,
                dataType: { kind: "string" },
            };
        }
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
        if (call.arguments.length !== 1) {
            lowerer.context.fail(
                call,
                "TypedArray.fill expects one argument.",
            );
        }
        lowerer.context.reachJsData();
        const number = lowerer.context.compileNumber(
            call.arguments[0]!,
            "double",
        );
        const stored = typedArrayStoreExpression(
            dataType.kind,
            number,
        );
        return {
            kind: "void",
            cpp: `bbl::js::array_fill(${narrowed.cpp}, ${stored})`,
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
        method === "slice"
    ) {
        if (call.arguments.length > 2) {
            lowerer.context.fail(
                call,
                "TypedArray.slice expects up to two arguments.",
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
        return {
            kind: "data",
            cpp:
                `bbl::js::typed_array_slice(${narrowed.cpp}, ` +
                `${begin}, ${end})`,
            dataType,
        };
    }
    if (
        dataType?.kind === "dataview" &&
        (method === "getInt8" || method === "getUint8")
    ) {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(
                call,
                `DataView.${method} expects one argument.`,
            );
        }
        const offset = lowerer.context.compileNumber(
            call.arguments[0]!,
            "double",
        );
        const nativeMethod = method
            .replace(/^get/, "get_")
            .replace(/([a-z])([A-Z])/g, "$1_$2")
            .toLowerCase();
        return {
            kind: "number",
            cpp:
                `static_cast<double>(${narrowed.cpp}.${nativeMethod}(` +
                `bbl::js::array_index(${offset})))`,
            dataType: { kind: "number" },
        };
    }
    if (
        dataType?.kind === "dataview" &&
        ["getInt16", "getUint16", "getInt32", "getUint32", "getFloat32"].includes(method)
    ) {
        if (call.arguments.length < 1 || call.arguments.length > 2) {
            lowerer.context.fail(
                call,
                `DataView.${method} expects one or two arguments.`,
            );
        }
        const offset = lowerer.context.compileNumber(
            call.arguments[0]!,
            "double",
        );
        const littleEndian = call.arguments[1]
            ? lowerer.context.compileCondition(call.arguments[1])
            : "false";
        const nativeMethod = method
            .replace(/^get/, "get_")
            .replace(/([a-z])([A-Z])/g, "$1_$2")
            .toLowerCase();
        return {
            kind: "number",
            cpp:
                `static_cast<double>(${narrowed.cpp}.${nativeMethod}(` +
                `bbl::js::array_index(${offset}), ${littleEndian}))`,
            dataType: { kind: "number" },
        };
    }
    if (
        dataType?.kind !== "vector" &&
        dataType?.kind !== "span"
    ) {
        return undefined;
    }
    if (
        dataType.kind === "span" &&
        ![
            "find",
            "findIndex",
            "filter",
            "reduce",
            "some",
            "every",
            "map",
            "forEach",
        ].includes(method)
    ) {
        // A readonly array parameter is a span. Its observing methods
        // share the vector loop below; mutating/copy-producing methods
        // keep requiring owning storage.
        return undefined;
    }
    lowerer.context.reachJsData();
    if (method === "join") {
        if (
            !["string", "enum"].includes(
                dataType.element.kind,
            ) ||
            call.arguments.length > 1
        ) {
            lowerer.context.fail(
                call,
                "Array.join supports string arrays with at most one separator.",
            );
        }
        const separator = call.arguments[0]
            ? lowerer.context.compileValue(call.arguments[0]!)
            : undefined;
        if (
            separator &&
            separator.kind !== "string" &&
            !(
                separator.kind === "data" &&
                separator.dataType?.kind === "string"
            )
        ) {
            lowerer.context.fail(
                call.arguments[0]!,
                "Array.join separator must be a string.",
            );
        }
        return {
            kind: "string",
            cpp: `bbl::js::array_join(${narrowed.cpp}, ${
                separator
                    ? separator.cpp
                    : lowerer.context.cppString(",")
            }${
                dataType.element.kind === "enum"
                    ? `, [](const auto& value) { return ${lowerer.context.dataTypes.enumToStringCpp(
                          dataType.element,
                          "value",
                          call,
                      )}; }`
                    : ""
            })`,
            dataType: { kind: "string" },
        };
    }
    if (method === "slice") {
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
        return {
            kind: "data",
            cpp: `bbl::js::array_slice(${narrowed.cpp}, ${begin}, ${end})`,
            dataType,
        };
    }
    if (method === "sort") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(
                call,
                "Array.sort currently requires one comparator callback.",
            );
        }
        const callback = lowerer.context.unwrap(call.arguments[0]!);
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            lowerer.context.fail(
                callback,
                "Array.sort requires a local function or function literal comparator.",
            );
        }
        const result = lowerer.context.allocateTemporaryCppName(
            "sort_result",
        );
        const left = lowerer.context.allocateTemporaryCppName("sort_left");
        const right = lowerer.context.allocateTemporaryCppName("sort_right");
        lowerer.context.emit(`auto ${result} = ${narrowed.cpp};`);
        lowerer.context.emit(
            `std::sort(${result}.begin(), ${result}.end(), [&](const auto& ${left}, const auto& ${right}) {`,
        );
        lowerer.context.increaseIndent();
        lowerer.context.pushScope(lowerer.context.allocateBlockPrefix());
        try {
            const compared = lowerer.context.compileCallbackWithValues(
                callback,
                [
                    lowerer.leafValue(left, dataType.element),
                    lowerer.leafValue(right, dataType.element),
                ],
                call,
            );
            if (compared.kind !== "number") {
                lowerer.context.fail(
                    callback,
                    "Array.sort comparator must return a number.",
                );
            }
            lowerer.context.emit(`return ${compared.cpp} < 0.0;`);
        } finally {
            lowerer.context.popScope();
            lowerer.context.decreaseIndent();
        }
        lowerer.context.emit("});");
        lowerer.registerLocal(result, "owned");
        return { kind: "data", cpp: result, dataType };
    }
    if (method === "find") {
        const resultType = lowerer.dataTypeAt(call) ?? {
            kind: "optional" as const,
            inner: dataType.element,
        };
        const result = lowerer.context.allocateTemporaryCppName(
            "find_result",
        );
        lowerer.emitArrayCallbackLoop(
            call,
            "find",
            narrowed,
            dataType,
            false,
            () =>
                lowerer.context.emit(
                    `${lowerer.context.dataTypes.cppType(resultType)} ${result}{};`,
                ),
            (matched, callback, source, index) => {
                if (matched.kind !== "boolean") {
                    lowerer.context.fail(
                        callback,
                        "Array.find callback must return a boolean value.",
                    );
                }
                lowerer.context.emit(`if (${matched.cpp}) {`);
                lowerer.context.increaseIndent();
                lowerer.context.emit(
                    `${result} = ${source}[${index}];`,
                );
                lowerer.context.emit("break;");
                lowerer.context.decreaseIndent();
                lowerer.context.emit("}");
            },
        );
        lowerer.registerLocal(result, "owned");
        return lowerer.leafValue(result, resultType);
    }
    if (method === "findIndex") {
        const result =
            lowerer.context.allocateTemporaryCppName(
                "find_index_result",
            );
        lowerer.emitArrayCallbackLoop(
            call,
            "findIndex",
            narrowed,
            dataType,
            false,
            () => lowerer.context.emit(`double ${result} = -1.0;`),
            (matched, callback, _source, index) => {
                if (matched.kind !== "boolean") {
                    lowerer.context.fail(
                        callback,
                        "Array.findIndex callback must return a boolean value.",
                    );
                }
                lowerer.context.emit(`if (${matched.cpp}) {`);
                lowerer.context.increaseIndent();
                lowerer.context.emit(
                    `${result} = static_cast<double>(${index});`,
                );
                lowerer.context.emit("break;");
                lowerer.context.decreaseIndent();
                lowerer.context.emit("}");
            },
        );
        return {
            kind: "number",
            cpp: result,
            dataType: { kind: "number" },
        };
    }
    if (method === "filter") {
        const filteredType = {
            kind: "vector" as const,
            element: dataType.element,
        };
        const output =
            lowerer.context.allocateTemporaryCppName(
                "filter_result",
            );
        lowerer.emitArrayCallbackLoop(
            call,
            "filter",
            narrowed,
            dataType,
            false,
            (source) => {
                lowerer.context.emit(
                    `bbl::js::Array<${lowerer.context.dataTypes.cppType(dataType.element)}> ${output};`,
                );
                lowerer.context.emit(
                    `${output}.reserve(${source}.size());`,
                );
            },
            (matched, callback, source, index) => {
                if (matched.kind !== "boolean") {
                    lowerer.context.fail(
                        callback,
                        "Array.filter callback must return a boolean value.",
                    );
                }
                lowerer.context.emit(
                    `if (${matched.cpp}) ${output}.push_back(${source}[${index}]);`,
                );
            },
        );
        lowerer.registerLocal(output, "owned");
        return {
            kind: "data",
            cpp: output,
            dataType: filteredType,
        };
    }
    if (method === "reduce") {
        if (call.arguments.length !== 2) {
            lowerer.context.fail(
                call,
                "Array.reduce currently requires a callback and an initial value.",
            );
        }
        const callback = lowerer.context.unwrap(call.arguments[0]!);
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            lowerer.context.fail(
                callback,
                "Array.reduce requires a local function or function literal callback.",
            );
        }
        const resultType = lowerer.dataTypeAt(call);
        if (!resultType) {
            lowerer.context.fail(
                call,
                "Array.reduce accumulator must belong to the native data model.",
            );
        }
        const source =
            lowerer.context.allocateTemporaryCppName("reduce_source");
        const count =
            lowerer.context.allocateTemporaryCppName("reduce_count");
        const index =
            lowerer.context.allocateTemporaryCppName("reduce_index");
        const accumulator =
            lowerer.context.allocateTemporaryCppName("reduce_result");
        lowerer.context.emit(`auto&& ${source} = ${narrowed.cpp};`);
        lowerer.context.emit(
            `const std::size_t ${count} = ${source}.size();`,
        );
        lowerer.context.emit(
            `${lowerer.context.dataTypes.cppType(resultType)} ${accumulator} = ${lowerer.compileForSink(call.arguments[1]!, resultType)};`,
        );
        lowerer.context.emit(
            `for (std::size_t ${index} = 0; ${index} < ${count}; ++${index}) {`,
        );
        lowerer.context.increaseIndent();
        lowerer.context.pushScope(lowerer.context.allocateBlockPrefix());
        try {
            const reduced =
                lowerer.context.compileCallbackWithValues(
                    callback,
                    [
                        lowerer.leafValue(
                            accumulator,
                            resultType,
                        ),
                        lowerer.leafValue(
                            `${source}[${index}]`,
                            dataType.element,
                        ),
                        {
                            kind: "number",
                            cpp: `static_cast<double>(${index})`,
                            dataType: { kind: "number" },
                        },
                        {
                            ...narrowed,
                            kind: "data",
                            cpp: source,
                            dataType,
                        },
                    ],
                    call,
                );
            lowerer.context.emit(
                `${accumulator} = ${lowerer.compileKnownValueForSink(reduced, resultType, callback)};`,
            );
        } finally {
            lowerer.context.popScope();
            lowerer.context.decreaseIndent();
        }
        lowerer.context.emit("}");
        lowerer.registerLocal(accumulator, "owned");
        return lowerer.leafValue(accumulator, resultType);
    }
    if (method === "some") {
        const result =
            lowerer.context.allocateTemporaryCppName(
                "some_result",
            );
        lowerer.emitArrayCallbackLoop(
            call,
            "some",
            narrowed,
            dataType,
            false,
            () => lowerer.context.emit(`bool ${result} = false;`),
            (matched, callback) => {
                if (matched.kind !== "boolean") {
                    lowerer.context.fail(
                        callback,
                        "Array.some callback must return a boolean value.",
                    );
                }
                lowerer.context.emit(`if (${matched.cpp}) {`);
                lowerer.context.increaseIndent();
                lowerer.context.emit(`${result} = true;`);
                lowerer.context.emit("break;");
                lowerer.context.decreaseIndent();
                lowerer.context.emit("}");
            },
        );
        return {
            kind: "boolean",
            cpp: result,
            dataType: { kind: "boolean" },
        };
    }
    if (method === "every") {
        const result =
            lowerer.context.allocateTemporaryCppName(
                "every_result",
            );
        lowerer.emitArrayCallbackLoop(
            call,
            "every",
            narrowed,
            dataType,
            false,
            () => lowerer.context.emit(`bool ${result} = true;`),
            (matched, callback) => {
                if (matched.kind !== "boolean") {
                    lowerer.context.fail(
                        callback,
                        "Array.every callback must return a boolean value.",
                    );
                }
                lowerer.context.emit(`if (!(${matched.cpp})) {`);
                lowerer.context.increaseIndent();
                lowerer.context.emit(`${result} = false;`);
                lowerer.context.emit("break;");
                lowerer.context.decreaseIndent();
                lowerer.context.emit("}");
            },
        );
        return {
            kind: "boolean",
            cpp: result,
            dataType: { kind: "boolean" },
        };
    }
    if (method === "map") {
        const mappedType = lowerer.dataTypeAt(call);
        if (mappedType?.kind !== "vector") {
            lowerer.context.fail(
                call,
                "Array.map callback results must belong to the native data model.",
            );
        }
        const callback = call.arguments[0]
            ? lowerer.context.unwrap(call.arguments[0])
            : undefined;
        if (
            call.arguments.length === 1 &&
            callback &&
            ts.isIdentifier(callback) &&
            callback.text === "Number" &&
            !lowerer.context.lookupIdentifierValue(callback) &&
            mappedType.element.kind === "number" &&
            (dataType.element.kind === "string" ||
                dataType.element.kind === "number")
        ) {
            const source = lowerer.context.allocateTemporaryCppName(
                "map_source",
            );
            const index = lowerer.context.allocateTemporaryCppName(
                "map_index",
            );
            const output = lowerer.context.allocateTemporaryCppName(
                "map_result",
            );
            lowerer.context.emit(`auto&& ${source} = ${narrowed.cpp};`);
            lowerer.context.emit(`bbl::js::Array<double> ${output};`);
            lowerer.context.emit(`${output}.reserve(${source}.size());`);
            lowerer.context.emit(
                `for (std::size_t ${index} = 0; ${index} < ${source}.size(); ++${index}) {`,
            );
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
        const output =
            lowerer.context.allocateTemporaryCppName(
                "map_result",
            );
        lowerer.emitArrayCallbackLoop(
            call,
            "map",
            narrowed,
            dataType,
            true,
            (source) => {
                lowerer.context.emit(
                    `bbl::js::Array<${lowerer.context.dataTypes.cppType(mappedType.element)}> ${output};`,
                );
                lowerer.context.emit(
                    `${output}.reserve(${source}.size());`,
                );
            },
            (result, callback) => {
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
                        lowerer.context.emit(`${result.cpp};`);
                    }
                    value = "true";
                } else {
                    value = lowerer.compileKnownValueForSink(
                        result,
                        mappedType.element,
                        callback,
                    );
                }
                lowerer.context.emit(
                    `${output}.push_back(${value});`,
                );
            },
        );
        lowerer.registerLocal(output, "owned");
        return {
            kind: "data",
            cpp: output,
            dataType: mappedType,
        };
    }
    if (method === "forEach") {
        lowerer.emitArrayCallbackLoop(
            call,
            "forEach",
            narrowed,
            dataType,
            true,
            () => undefined,
            (result) => {
                if (result.cpp.length > 0) {
                    lowerer.context.emit(
                        result.requiresExplicitDiscard
                            ? `static_cast<void>(${result.cpp});`
                            : `${result.cpp};`,
                    );
                }
            },
        );
        return { kind: "void", cpp: "" };
    }
    if (method === "push") {
        if (call.arguments.length === 0) {
            lowerer.context.fail(
                call,
                "Array push requires at least one element.",
            );
        }
        lowerer.invalidateAliases(narrowed.cpp);
        const pushedHandleKind =
            dataType.element.kind === "handle"
                ? dataType.element.handle
                : undefined;
        const hasSpread = call.arguments.some((argument) =>
            ts.isSpreadElement(argument),
        );
        const staticElements =
            narrowed.staticElementsOwner?.staticElements ??
            narrowed.staticElements;
        const pushedValues =
            (pushedHandleKind || staticElements) && !hasSpread
                ? call.arguments.map((argument) =>
                      lowerer.context.compileValue(argument),
                  )
                : undefined;
        // A handle snapshot is also the generation-time reach set used
        // to retain identities such as shader variants and scene slots.
        // One reached handle can stand for every native instance created
        // by a runtime loop. Plain-data snapshots, in contrast, must be
        // path-complete before static iteration can consume them.
        if (
            (pushedHandleKind !== undefined ||
                !lowerer.context.isInRuntimeControlFlow()) &&
            staticElements &&
            pushedValues?.every(
                (value) =>
                    (!pushedHandleKind ||
                        value.kind === pushedHandleKind) &&
                    !value.runtimeIteration,
            )
        ) {
            const firstIndex = staticElements.length;
            const snapshotCpp =
                (narrowed.staticElementsOwner ?? narrowed).cpp;
            staticElements.push(
                ...pushedValues.map((value, index) => {
                    if (pushedHandleKind) return value;
                    // A pushed object literal is a compile-time record,
                    // but the array stores a native element. Keep the
                    // record's static facts while rebasing its identity
                    // and every later writable path to that stored slot.
                    return {
                        ...value,
                        ...lowerer.leafValue(
                            `${snapshotCpp}[${firstIndex + index}]`,
                            dataType.element,
                        ),
                    };
                }),
            );
        } else {
            lowerer.invalidateStaticElements(narrowed);
            // `compileDataPath(..., "write")` may return a leaf wrapper
            // around an identifier binding. Invalidate the binding too;
            // otherwise a later for-of still sees the initializer's
            // stale static snapshot (notably `[]`) and erases a spread
            // append of a loaded asset's meshes.
            if (dynamicOwner) {
                lowerer.invalidateStaticElements(dynamicOwner);
            }
        }
        const pushes = call.arguments.map((argument, index) => {
            if (ts.isSpreadElement(argument)) {
                const spread = lowerer.context.compileValue(
                    argument.expression,
                );
                if (
                    spread.kind === "tuple" &&
                    spread.tupleElements
                ) {
                    const values = spread.tupleElements.map(
                        (value) =>
                            lowerer.compileKnownValueForSink(
                                value,
                                dataType.element,
                                argument,
                            ),
                    );
                    return (
                        `${narrowed.cpp}.insert(${narrowed.cpp}.end(), ` +
                        `{${values.join(", ")}})`
                    );
                }
                let source: string;
                if (
                    spread.kind === "handle-collection" &&
                    spread.handleCollection &&
                    dataType.element.kind === "handle" &&
                    spread.handleCollection.elementKind ===
                        dataType.element.handle
                ) {
                    source = spread.handleCollection.containerCpp;
                } else if (
                    spread.kind === "data" &&
                    (spread.dataType?.kind === "vector" ||
                        spread.dataType?.kind === "span") &&
                    dataTypesEqual(
                        spread.dataType.element,
                        dataType.element,
                    )
                ) {
                    source = spread.cpp;
                } else {
                    lowerer.context.fail(
                        argument,
                        `Array.push spread must contain values of the destination element type ${JSON.stringify(dataType.element)}; received ${spread.kind} ${spread.dataType ? JSON.stringify(spread.dataType) : "without a data type"}.`,
                    );
                }
                return (
                    `${narrowed.cpp}.insert(${narrowed.cpp}.end(), ` +
                    `${source}.begin(), ${source}.end())`
                );
            }
            return `${narrowed.cpp}.push_back(${pushedValues
                ? lowerer.compileKnownValueForSink(
                      pushedValues[index]!,
                      dataType.element,
                      argument,
                  )
                : lowerer.compileForSink(argument, dataType.element)})`;
        });
        return {
            kind: "void",
            cpp:
                pushes.length === 1
                    ? pushes[0]!
                    : `(${pushes.join(", ")})`,
        };
    }
    if (method === "pop") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(
                call,
                "Array.pop expects no arguments.",
            );
        }
        lowerer.invalidateAliases(narrowed.cpp);
        const popped = `bbl::js::array_pop(${narrowed.cpp})`;
        return lowerer.leafValue(
            popped,
            dataType.element,
        );
    }
    if (method === "shift") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(
                call,
                "Array.shift expects no arguments.",
            );
        }
        lowerer.invalidateAliases(narrowed.cpp);
        return lowerer.leafValue(
            `bbl::js::array_shift(${narrowed.cpp})`,
            dataType.element,
        );
    }
    if (method === "unshift") {
        if (call.arguments.length === 0) {
            return {
                kind: "number",
                cpp: `static_cast<double>(${narrowed.cpp}.size())`,
            };
        }
        lowerer.invalidateAliases(narrowed.cpp);
        const values = call.arguments.map((argument) =>
            lowerer.compileForSink(argument, dataType.element),
        );
        return {
            kind: "number",
            cpp:
                `bbl::js::array_unshift(${narrowed.cpp}, ` +
                `{${values.join(", ")}})`,
        };
    }
    if (method === "reverse") {
        if (call.arguments.length !== 0) {
            lowerer.context.fail(
                call,
                "Array.reverse expects no arguments.",
            );
        }
        lowerer.invalidateAliases(narrowed.cpp);
        return {
            kind: "data",
            cpp: `bbl::js::array_reverse(${narrowed.cpp})`,
            dataType,
        };
    }
    if (method === "fill") {
        if (call.arguments.length !== 1) {
            lowerer.context.fail(
                call,
                "Array.fill expects one argument.",
            );
        }
        const value = lowerer.compileForSink(
            call.arguments[0]!,
            dataType.element,
        );
        return {
            kind: "void",
            cpp: `bbl::js::array_fill(${narrowed.cpp}, ${value})`,
        };
    }
    if (method === "splice") {
        // The reached removal form: splice(index, 1). Insertions
        // and multi-element removals stay unreached.
        const removalCount =
            call.arguments.length === 2
                ? lowerer.context.resolveStaticExpression(
                      call.arguments[1]!,
                  )
                : undefined;
        if (
            !removalCount ||
            !ts.isNumericLiteral(removalCount) ||
            Number(removalCount.text) !== 1
        ) {
            lowerer.context.fail(
                call,
                "Array.splice supports removing exactly one element.",
            );
        }
        lowerer.invalidateAliases(narrowed.cpp);
        return {
            kind: "void",
            cpp: `bbl::js::array_splice_one(${narrowed.cpp}, ${lowerer.context.compileNumber(call.arguments[0]!, "double")})`,
        };
    }
    lowerer.context.fail(
        callee.name,
        `Array method '${method}' is not supported.`,
    );
}
