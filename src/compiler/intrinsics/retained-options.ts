import type ts from "typescript";
import type { DataType } from "../data-types.js";
import type { LoweringServices } from "../lowering-services.js";
import { optionalPresentCpp, type Value } from "../types.js";

export interface RetainedOption {
    name: string;
    cpp: string;
    type: DataType | undefined;
    value?: Value;
    present?: string;
    optionalProperty?: true;
}

export type RetainedOptionsContext = Pick<
    LoweringServices,
    "fail" | "bindings" | "dataTypes" | "emit"
>;

/** Project named options from a closed record or an owned typed record. */
export function retainedOptions(
    context: RetainedOptionsContext,
    value: Value,
    site: ts.Expression,
): RetainedOption[] {
    if (
        value.kind === "record" &&
        !Object.keys(value.recordGetters ?? {}).length &&
        !Object.keys(value.recordMethods ?? {}).length
    ) {
        return Object.entries(value.recordProperties ?? {}).map(
            ([name, member]) => ({
                name,
                cpp: member.cpp,
                value: member,
                type:
                    member.kind === "number"
                        ? { kind: "number" }
                        : member.kind === "string"
                          ? { kind: "string" }
                          : member.kind === "boolean"
                            ? { kind: "boolean" }
                            : member.dataType,
            }),
        );
    }
    if (value.kind !== "data" || value.dataType?.kind !== "struct")
        return context.fail(site, "Options require a retained record.");
    const type = value.dataType;
    const owner = context.bindings.pinValueToTemporary(
        value,
        "options_owner",
        site,
    );
    const access = context.dataTypes.isReferenceStruct(type.name) ? "->" : ".";
    return context.dataTypes
        .structFields(type.name, site)
        .filter(
            (field) =>
                !field.optionalProperty ||
                !owner.recordOwnKeys ||
                owner.recordOwnKeys.includes(field.sourceName),
        )
        .map((field) => {
            const cpp = `${owner.cpp}${access}${field.name}`;
            const fact =
                !field.optionalProperty ||
                owner.recordOwnKeys?.includes(field.sourceName)
                    ? owner.recordProperties?.[field.sourceName]
                    : undefined;
            return {
                name: field.sourceName,
                cpp,
                type: field.type,
                // Facts select generation-time programs; runtime reads still use the
                // retained owner, including collections whose contents may have changed.
                value: {
                    kind: "data",
                    cpp,
                    dataType: field.type,
                    ...(fact?.staticString !== undefined
                        ? { staticString: fact.staticString }
                        : {}),
                    ...(fact?.staticNumber !== undefined
                        ? { staticNumber: fact.staticNumber }
                        : {}),
                    ...(fact?.staticBoolean !== undefined
                        ? { staticBoolean: fact.staticBoolean }
                        : {}),
                },
                ...(field.optionalProperty
                    ? { optionalProperty: true as const }
                    : {}),
                ...(field.optionalProperty &&
                field.type.kind === "struct" &&
                context.dataTypes.isReferenceStruct(field.type.name)
                    ? {
                          present: `static_cast<bool>(${cpp})`,
                      }
                    : {}),
            };
        });
}

/** Preserve absence so the source factory owns default application. */
export function emitPresentOption(
    context: RetainedOptionsContext,
    member: RetainedOption,
    emit: (member: RetainedOption) => void,
): void {
    let { cpp, type } = member;
    const guard =
        type?.kind === "optional" ? optionalPresentCpp(cpp) : member.present;
    if (type?.kind === "optional") {
        cpp = `${cpp}.value()`;
        type = type.inner;
    }
    if (guard) context.emit({ kind: "open", code: `if (${guard}) {` });
    emit({ ...member, cpp, ...(type ? { type } : {}) });
    if (guard) context.emit({ kind: "close", code: "}" });
}

export function emitScalarOption(
    context: RetainedOptionsContext,
    member: RetainedOption,
    kind: "number" | "boolean" | "string",
    destination: string,
    site: ts.Node,
): void {
    if (kind === "string" && member.type?.kind === "enum") {
        context.emit({
            kind: "expression",
            code: `${destination} = ${context.dataTypes.enumToStringCpp(member.type, member.cpp, site)};`,
        });
        return;
    }
    if (member.type?.kind !== kind)
        context.fail(site, `Option ${member.name} requires ${kind}.`);
    context.emit({
        kind: "expression",
        code: `${destination} = ${member.cpp};`,
    });
}
