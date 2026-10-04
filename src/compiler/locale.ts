import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import { isPresentValue, presenceCpp, type Value } from "./types.js";
import { isNullable } from "./type-facts.js";
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
 * The `locales` and `options` arguments the Intl operations share, evaluated
 * in order: the requested tags as a `std::vector<std::string>`, read after
 * the options ran as the operation reads them, and the options' fields (a
 * plain record's properties or a struct's fields by source name). Absent or
 * undefined options have none; a field outside `names` refuses.
 */
function compileLocalesAndOptions(
    lowerer: DataLowerer,
    api: string,
    kind: string,
    localeNode: ts.Expression | undefined,
    optionsNode: ts.Expression | undefined,
    names: readonly string[],
    site: ts.Node,
): { locales: string; fields: Readonly<Record<string, Value>> } {
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
        "requested_locale",
    );
    const options = optionsNode ? context.compileValue(optionsNode) : undefined;
    const locales = context.allocateTemporaryCppName("requested_locales");
    context.emit({
        kind: "declaration",
        type: "const auto",
        name: locales,
        initializer: `bbl::pal::requested_locales(${locale})`,
    });
    if (
        !optionsNode ||
        !options ||
        (options.kind === "json-null" && options.cpp === "std::nullopt")
    )
        return { locales, fields: {} };
    const unsupportedOption = (
        key: string,
        optional: boolean,
        present: string,
    ): void => {
        if (!optional)
            context.fail(optionsNode, `${api} option '${key}' is not lowered.`);
        context.emit({
            kind: "expression",
            code: `if (${present}) throw std::runtime_error(${context.cppString(`${api} option '${key}' is not supported natively.`)});`,
        });
    };
    if (
        options.kind === "record" &&
        !Object.keys(options.recordGetters ?? {}).length &&
        !Object.keys(options.recordMethods ?? {}).length
    ) {
        const fields = options.recordProperties ?? {};
        for (const [key, value] of Object.entries(fields))
            if (!names.includes(key)) {
                const property = context.checker.getPropertyOfType(
                    context.checker.getNonNullableType(
                        context.checker.getTypeAtLocation(optionsNode),
                    ),
                    key,
                );
                unsupportedOption(
                    key,
                    property !== undefined &&
                        (property.flags & ts.SymbolFlags.Optional) !== 0,
                    presenceCpp(value) ?? String(isPresentValue(value)),
                );
            }
        return { locales, fields };
    }
    // A struct, or an optional one whose absence leaves every field absent.
    const optional = options.dataType?.kind === "optional";
    const type =
        options.dataType?.kind === "optional"
            ? options.dataType.inner
            : options.dataType;
    if (type?.kind !== "struct")
        return context.fail(
            optionsNode,
            `${api} options require a record of ${kind}.`,
        );
    const bound = context.bindings.pinValueToTemporary(
        options,
        "locale_options",
    );
    const cpp = bound.cpp;
    const present =
        optional || isNullable(context.checker.getTypeAtLocation(optionsNode))
            ? presenceCpp(bound)
            : undefined;
    const access =
        optional || context.dataTypes.isReferenceStruct(type.name) ? "->" : ".";
    const fields: Record<string, Value> = {};
    for (const field of context.dataTypes.structFields(
        type.name,
        optionsNode,
    )) {
        const read = `${cpp}${access}${field.name}`;
        const fieldType: DataType =
            !present || field.type.kind === "optional"
                ? field.type
                : { kind: "optional", inner: field.type };
        const fieldCpp = context.dataTypes.cppType(fieldType);
        const value = present
            ? `(${present} ? ${fieldCpp}(${read}) : ${fieldCpp}{})`
            : read;
        if (names.includes(field.sourceName)) {
            fields[field.sourceName] = lowerer.leafValue(value, fieldType);
            continue;
        }
        // The declared type names an option this lowering does not
        // implement: the program may leave it absent, never set it.
        unsupportedOption(
            field.sourceName,
            fieldType.kind === "optional",
            value,
        );
    }
    return { locales, fields };
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
    const { locales, fields } = compileLocalesAndOptions(
        lowerer,
        api,
        "collation options",
        localeNode,
        optionsNode,
        collationOptionNames,
        site,
    );
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

/** The `Intl.NumberFormat` options lowered, in `bbl::pal::NumberFormatOptions` order. */
const numberFormatOptions = [
    ["localeMatcher", "string"],
    ["style", "string"],
    ["minimumIntegerDigits", "number"],
    ["minimumFractionDigits", "number"],
    ["maximumFractionDigits", "number"],
    ["minimumSignificantDigits", "number"],
    ["maximumSignificantDigits", "number"],
    ["useGrouping", "grouping"],
] as const;

/**
 * `number.toLocaleString(locales?, options?)`: the number as the platform's
 * ICU number format renders it once `Intl.NumberFormat` resolves the locales
 * and options. Currency and unit styles refuse.
 */
export function compileNumberLocaleString(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
): Value {
    const context = lowerer.context;
    context.expectArgumentCount(call, 0, 2);
    context.reachFeature("data:locale", call);
    const value = snapshot(
        lowerer,
        owner,
        { kind: "number" },
        call.expression,
        "formatted_number",
    );
    const optionsNode = call.arguments[1];
    const { locales, fields } = compileLocalesAndOptions(
        lowerer,
        "Number.toLocaleString",
        "number format options",
        call.arguments[0],
        optionsNode,
        numberFormatOptions.map(([name]) => name),
        call,
    );
    const style = fields.style?.staticString;
    if (style === "currency" || style === "unit")
        context.fail(
            optionsNode ?? call,
            `Number.toLocaleString style '${style}' is not lowered.`,
        );
    const options = numberFormatOptions.map(([key, kind]) => {
        const field = fields[key];
        if (kind !== "grouping")
            return optionalArgument(
                lowerer,
                field,
                { kind },
                optionsNode ?? call,
                `number_format_${key}`,
            );
        // A boolean selects "always" or no grouping; a string names a strategy.
        const type =
            field?.dataType?.kind === "optional"
                ? field.dataType.inner
                : field?.dataType;
        const boolean = field?.kind === "boolean" || type?.kind === "boolean";
        return `bbl::pal::grouping_option(${optionalArgument(
            lowerer,
            field,
            { kind: boolean ? "boolean" : "string" },
            optionsNode ?? call,
            `number_format_${key}`,
        )})`;
    });
    return lowerer.leafValue(
        `bbl::pal::format_number(${value}, ${locales}, bbl::pal::NumberFormatOptions{${options.join(", ")}})`,
        { kind: "string" },
    );
}

/** Unicode operations use the platform's ICU implementation. */
export function compileLocaleStringMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    method: string,
    owner: Value,
): Value | undefined {
    const casing =
        method === "toLocaleLowerCase" || method === "toLocaleUpperCase";
    if (method !== "normalize" && method !== "localeCompare" && !casing)
        return undefined;
    const context = lowerer.context;
    context.expectArgumentCount(
        call,
        method === "localeCompare" ? 1 : 0,
        method === "localeCompare" ? 3 : 1,
    );
    context.reachFeature("data:locale", call);
    const source = snapshot(
        lowerer,
        owner,
        { kind: "string" },
        call.expression,
        "locale_source",
    );
    if (casing) {
        const { locales } = compileLocalesAndOptions(
            lowerer,
            `String.${method}`,
            "case mapping",
            call.arguments[0],
            undefined,
            [],
            call,
        );
        return lowerer.leafValue(
            `bbl::pal::locale_string_case(${source}, ${locales}, ${method === "toLocaleUpperCase"})`,
            { kind: "string" },
        );
    }
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
