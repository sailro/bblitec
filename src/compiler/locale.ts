import type ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { Value } from "./types.js";

const collationOptionNames = ["numeric", "sensitivity", "usage", "localeMatcher", "collation", "caseFirst", "ignorePunctuation"] as const;

/** Unicode operations use the platform's ICU implementation. */
export function compileLocaleStringMethod(lowerer: DataLowerer, call: ts.CallExpression, method: string, owner: Value): Value | undefined {
    if (method !== "normalize" && method !== "localeCompare") return undefined;
    const context = lowerer.context;
    context.expectArgumentCount(call, method === "normalize" ? 0 : 1, method === "normalize" ? 1 : 3);
    context.reachFeature("data:locale", call);
    const snapshot = (value: Value, type: DataType, site: ts.Node, name: string): string => {
        const cpp = context.allocateTemporaryCppName(name);
        context.emit(`const ${context.dataTypes.cppType(type)} ${cpp} = ${lowerer.compileKnownValueForSink(value, type, site)};`);
        return cpp;
    };
    const source = snapshot(owner, {kind:"string"}, call.expression, "locale_source");
    if (method === "normalize") {
        const value = call.arguments[0] ? context.compileValue(call.arguments[0]) : undefined;
        const form = !value || (value.kind === "json-null" && value.cpp === "std::nullopt") ? '"NFC"'
            : snapshot(value, {kind:"string"}, call.arguments[0]!, "normalization_form");
        return lowerer.leafValue(`bbl::pal::normalize_string(${source}, ${form})`, {kind:"string"});
    }
    const other = snapshot(context.compileValue(call.arguments[0]!), {kind:"string"}, call.arguments[0]!, "locale_other");
    const optional = (value: Value | undefined, inner: DataType, site: ts.Node, name: string): string => {
        if (!value || (value.kind === "json-null" && value.cpp === "std::nullopt")) return "std::nullopt";
        if (value.dataType?.kind !== "optional") return snapshot(value, inner, site, name);
        const cpp = snapshot(value, {kind:"optional", inner}, site, name);
        return `${cpp}.to_optional()`;
    };
    const localeValue = call.arguments[1] ? context.compileValue(call.arguments[1]) : undefined;
    const localeType = localeValue?.dataType?.kind === "optional" ? localeValue.dataType.inner : localeValue?.dataType;
    const list = localeValue?.kind === "tuple" || localeType?.kind === "vector" || localeType?.kind === "span";
    const locale = optional(localeValue, list ? {kind:"vector", element:{kind:"string"}} : {kind:"string"},
        call.arguments[1] ?? call, "collation_locale");
    const locales = context.allocateTemporaryCppName("collation_locales");
    const optionsNode = call.arguments[2];
    const options = optionsNode ? context.compileValue(optionsNode) : undefined;
    context.emit(`const auto ${locales} = bbl::pal::collation_locales(${locale});`);
    let fields: Readonly<Record<string, Value>> = {};
    if (options && !(options.kind === "json-null" && options.cpp === "std::nullopt")) {
        if (options.kind === "record" && !Object.keys(options.recordGetters ?? {}).length && !Object.keys(options.recordMethods ?? {}).length) {
            fields = options.recordProperties ?? {};
        } else if (options.dataType?.kind === "struct") {
            const type = options.dataType;
            const cpp = context.pinValueToTemporary(options, "collation_options").cpp;
            const access = context.dataTypes.isReferenceStruct(type.name) ? "->" : ".";
            fields = Object.fromEntries(context.dataTypes.structFields(type.name, optionsNode!).map(field =>
                [field.sourceName, lowerer.leafValue(`${cpp}${access}${field.name}`, field.type)]));
        } else context.fail(optionsNode!, "String.localeCompare options require a record of collation options.");
        for (const key of Object.keys(fields)) if (!collationOptionNames.some(name => name === key))
            context.fail(optionsNode!, `String.localeCompare option '${key}' is not lowered.`);
    }
    const optionsCpp = collationOptionNames.map(key =>
        optional(fields[key], {kind: key === "numeric" || key === "ignorePunctuation" ? "boolean" : "string"}, optionsNode ?? call, `collation_${key}`));
    return lowerer.leafValue(`bbl::pal::compare_strings(${source}, ${other}, ${locales}, bbl::pal::CollationOptions{${optionsCpp.join(", ")}})`, {kind:"number"});
}
