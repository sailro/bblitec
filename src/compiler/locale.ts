import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { Value } from "./types.js";
import { argumentAt, expressionMayRunCode } from "./syntax.js";

const collationOptionNames = [
    "numeric",
    "sensitivity",
    "usage",
    "localeMatcher",
    "collation",
    "caseFirst",
    "ignorePunctuation",
] as const;

/** `value` converted to `type` in a named constant, evaluated here. */
function snapshot(
    lowerer: DataLowerer,
    value: Value,
    type: DataType,
    site: ts.Node,
    name: string,
): string {
    const context = lowerer.context;
    const cpp = context.allocateTemporaryCppName(name);
    context.emit({
        kind: "declaration",
        type: `const ${context.dataTypes.cppType(type)}`,
        name: cpp,
        initializer: lowerer.compileKnownValueForSink(value, type, site),
    });
    return cpp;
}

/** An optional argument as a `std::optional` of `inner`; absent or undefined is nullopt. */
function optionalArgument(
    lowerer: DataLowerer,
    value: Value | undefined,
    inner: DataType,
    site: ts.Node,
    name: string,
): string {
    if (!value || (value.kind === "json-null" && value.cpp === "std::nullopt"))
        return "std::nullopt";
    if (value.dataType?.kind !== "optional")
        return snapshot(lowerer, value, inner, site, name);
    const cpp = snapshot(
        lowerer,
        value,
        { kind: "optional", inner },
        site,
        name,
    );
    return `${cpp}.to_optional()`;
}

/**
 * The `locales` and `options` arguments `localeCompare` and `Intl.Collator`
 * share, evaluated in order: the requested locale list and the
 * `bbl::pal::CollationOptions` C++ expressions.
 */
function compileCollation(
    lowerer: DataLowerer,
    api: string,
    localeNode: ts.Expression | undefined,
    optionsNode: ts.Expression | undefined,
    site: ts.Node,
): { locales: string; options: string } {
    const context = lowerer.context;
    const localeValue = localeNode
        ? context.compileValue(localeNode)
        : undefined;
    const localeType =
        localeValue?.dataType?.kind === "optional"
            ? localeValue.dataType.inner
            : localeValue?.dataType;
    const list =
        localeValue?.kind === "tuple" ||
        localeType?.kind === "vector" ||
        localeType?.kind === "span";
    const locale = optionalArgument(
        lowerer,
        localeValue,
        list
            ? { kind: "vector", element: { kind: "string" } }
            : { kind: "string" },
        localeNode ?? site,
        "collation_locale",
    );
    const locales = context.allocateTemporaryCppName("collation_locales");
    const options = optionsNode ? context.compileValue(optionsNode) : undefined;
    context.emit({
        kind: "declaration",
        type: "const auto",
        name: locales,
        initializer: `bbl::pal::collation_locales(${locale})`,
    });
    let fields: Readonly<Record<string, Value>> = {};
    if (
        optionsNode &&
        options &&
        !(options.kind === "json-null" && options.cpp === "std::nullopt")
    ) {
        if (
            options.kind === "record" &&
            !Object.keys(options.recordGetters ?? {}).length &&
            !Object.keys(options.recordMethods ?? {}).length
        ) {
            fields = options.recordProperties ?? {};
        } else if (options.dataType?.kind === "struct") {
            const type = options.dataType;
            const cpp = context.bindings.pinValueToTemporary(
                options,
                "collation_options",
            ).cpp;
            const access = context.dataTypes.isReferenceStruct(type.name)
                ? "->"
                : ".";
            fields = Object.fromEntries(
                context.dataTypes
                    .structFields(type.name, optionsNode)
                    .map((field) => [
                        field.sourceName,
                        lowerer.leafValue(
                            `${cpp}${access}${field.name}`,
                            field.type,
                        ),
                    ]),
            );
        } else
            context.fail(
                optionsNode,
                `${api} options require a record of collation options.`,
            );
        for (const key of Object.keys(fields))
            if (!collationOptionNames.some((name) => name === key))
                context.fail(
                    optionsNode,
                    `${api} option '${key}' is not lowered.`,
                );
    }
    const optionsCpp = collationOptionNames.map((key) =>
        optionalArgument(
            lowerer,
            fields[key],
            {
                kind:
                    key === "numeric" || key === "ignorePunctuation"
                        ? "boolean"
                        : "string",
            },
            optionsNode ?? site,
            `collation_${key}`,
        ),
    );
    return {
        locales,
        options: `bbl::pal::CollationOptions{${optionsCpp.join(", ")}}`,
    };
}

/** Unicode operations use the platform's ICU implementation. */
export function compileLocaleStringMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    method: string,
    owner: Value,
): Value | undefined {
    if (method !== "normalize" && method !== "localeCompare") return undefined;
    const context = lowerer.context;
    context.expectArgumentCount(
        call,
        method === "normalize" ? 0 : 1,
        method === "normalize" ? 1 : 3,
    );
    context.reachFeature("data:locale", call);
    const source = snapshot(
        lowerer,
        owner,
        { kind: "string" },
        call.expression,
        "locale_source",
    );
    if (method === "normalize") {
        const value = call.arguments[0]
            ? context.compileValue(call.arguments[0])
            : undefined;
        const form =
            !value ||
            (value.kind === "json-null" && value.cpp === "std::nullopt")
                ? '"NFC"'
                : snapshot(
                      lowerer,
                      value,
                      { kind: "string" },
                      call.arguments[0]!,
                      "normalization_form",
                  );
        return lowerer.leafValue(
            `bbl::pal::normalize_string(${source}, ${form})`,
            { kind: "string" },
        );
    }
    const other = snapshot(
        lowerer,
        context.compileValue(call.arguments[0]!),
        { kind: "string" },
        call.arguments[0]!,
        "locale_other",
    );
    const { locales, options } = compileCollation(
        lowerer,
        "String.localeCompare",
        call.arguments[1],
        call.arguments[2],
        call,
    );
    return lowerer.leafValue(
        `bbl::pal::compare_strings(${source}, ${other}, ${locales}, ${options})`,
        { kind: "number" },
    );
}

/**
 * `new Intl.Collator(locales?, options?)` (or without `new`): the locales
 * and options `localeCompare` takes, held for its `compare` calls.
 */
export function compileCollatorConstruction(
    lowerer: DataLowerer,
    expression: ts.CallExpression | ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    const callee = context.unwrap(expression.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        callee.name.text !== "Collator" ||
        context.libraryGlobal(callee.expression) !== "Intl"
    )
        return undefined;
    const arguments_ = expression.arguments ?? [];
    if (arguments_.length > 2)
        context.fail(expression, "Intl.Collator takes locales and options.");
    context.reachJsData();
    context.reachFeature("data:locale", expression);
    const { locales, options } = compileCollation(
        lowerer,
        "Intl.Collator",
        arguments_[0],
        arguments_[1],
        expression,
    );
    return {
        kind: "data",
        cpp: `bbl::pal::make_collator(${locales}, ${options})`,
        dataType: { kind: "collator" },
        impure: true,
    };
}

/** `collator.compare(left, right)`, the comparison `localeCompare` makes. */
export function compileCollatorMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    const context = lowerer.context;
    if (method !== "compare")
        context.fail(call, `Intl.Collator.${method} is not lowered.`);
    context.expectArgumentCount(call, 2, 2);
    const collator = context.bindings.pinValueToTemporary(
        owner,
        "collator_receiver",
    );
    const leftNode = argumentAt(call, 0);
    const rightNode = argumentAt(call, 1);
    // The left string is kept before the right one runs only when the
    // right one can run code; plain reads pass straight through.
    const leftValue = context.compileValue(leftNode);
    const left = expressionMayRunCode(rightNode)
        ? snapshot(
              lowerer,
              leftValue,
              { kind: "string" },
              leftNode,
              "collation_left",
          )
        : lowerer.compileKnownValueForSink(
              leftValue,
              { kind: "string" },
              leftNode,
          );
    const right = lowerer.compileKnownValueForSink(
        context.compileValue(rightNode),
        { kind: "string" },
        rightNode,
    );
    return lowerer.leafValue(
        `bbl::pal::collator_compare(${collator.cpp}, ${left}, ${right})`,
        { kind: "number" },
    );
}
