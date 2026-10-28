import ts from "typescript";
import { cppIdentifier, snakeCase } from "../../cpp-literals.js";
import type { DataType } from "../data-types.js";
import type { LoweringServices } from "../lowering-services.js";
import { optionalPresentCpp, type Value } from "../types.js";
import type { RecordShape } from "../../lowering/record-shapes.js";
import { webPlatformGlobalValues } from "../../lowering/web-platform-schema.js";
import {
    internalMember,
    loweredRecordModel,
} from "../lowered-record-surface.js";
import type { PinnedRecordModel } from "../../lowering/pinned-record-lowerer.js";

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

/**
 * Whether a retained member is present, where that is a run-time fact: an
 * optional member's value, an optional reference record's pointer.
 */
export function retainedOptionPresent(
    member: RetainedOption,
): string | undefined {
    return member.type?.kind === "optional"
        ? optionalPresentCpp(member.cpp)
        : member.present;
}

/** Preserve absence so the source factory owns default application. */
export function emitPresentOption(
    context: RetainedOptionsContext,
    member: RetainedOption,
    emit: (member: RetainedOption) => void,
): void {
    let { cpp, type } = member;
    const guard = retainedOptionPresent(member);
    if (type?.kind === "optional") {
        cpp = `${cpp}.value()`;
        type = type.inner;
    }
    if (guard) context.emit({ kind: "open", code: `if (${guard}) {` });
    emit({
        ...member,
        cpp,
        ...(type ? { type } : {}),
        ...(member.value
            ? {
                  value: {
                      ...member.value,
                      cpp,
                      ...(type ? { dataType: type } : {}),
                  },
              }
            : {}),
    });
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

export type LibraryOptionsContext = RetainedOptionsContext &
    Pick<
        LoweringServices,
        "allocateTemporaryCppName" | "checker" | "compileValue" | "dataLowerer"
    >;

/** The program's function of `typeof fetch`'s signature, as the application stores it. */
const PROGRAM_FETCH: DataType = {
    kind: "function",
    parameters: [
        { kind: "string" },
        { kind: "optional", inner: { kind: "request-init" } },
    ],
    result: { kind: "promise", result: { kind: "http-response" } },
};

/**
 * A function option the lowered library calls, of the record shape its
 * model gives the member: the platform's `fetch` itself, or the program's
 * function of that signature, whose responses the web platform seam hands
 * the library as its own (`web_platform::fetch_function`).
 */
function libraryFunctionOption(
    context: LibraryOptionsContext,
    model: PinnedRecordModel,
    value: Value,
    shape: RecordShape,
    site: ts.Node,
): string {
    const platformFetch = webPlatformGlobalValues.get("fetch")!;
    const present = shape.kind === "optional" ? shape.value : shape;
    if (model.cppType(present) !== model.cppType(platformFetch.shape))
        return context.fail(
            site,
            "A library function option other than a fetch is not lowered.",
        );
    if (value.hostFunction === "fetch") return platformFetch.cpp;
    return `bbl::web_platform::fetch_function(${context.dataLowerer.compileKnownValueForSink(value, PROGRAM_FETCH, site)})`;
}

/**
 * A lowered library's options record from a closed or typed record at the
 * call: each public member (none `@internal`) of the interface the callee's
 * parameter `index` declares, into its record field (the pinned name in
 * snake case), absent ones left to the library's normalization. A signal is
 * the runtime's own object; numbers, booleans and strings are scalars; a
 * nested options record is filled the same way, and a function member is
 * one the library's record model admits (`libraryFunctionOption`).
 */
export function libraryOptions(
    context: LibraryOptionsContext,
    call: ts.CallExpression,
    site: ts.Expression | undefined,
    struct: string,
    index: number,
): string {
    const target = context.allocateTemporaryCppName("library_options");
    context.emit({
        kind: "declaration",
        type: struct,
        name: target,
        initializer: "{}",
    });
    if (!site) return target;
    const parameter = context.checker
        .getResolvedSignature(call)
        ?.getParameters()[index];
    if (!parameter)
        return context.fail(site, `${struct} has no pinned parameter.`);
    const pinned = context.checker.getNonNullableType(
        context.checker.getTypeOfSymbolAtLocation(parameter, call),
    );
    fillLibraryOptions(
        context,
        target,
        pinned,
        context.checker.typeToString(pinned),
        context.compileValue(site),
        site,
    );
    return target;
}

function fillLibraryOptions(
    context: LibraryOptionsContext,
    target: string,
    pinned: ts.Type,
    owner: string,
    value: Value,
    site: ts.Expression,
): void {
    const model = loweredRecordModel(owner);
    for (const option of retainedOptions(context, value, site)) {
        const property = pinned.getProperty(option.name);
        const declaration = property?.declarations?.find(
            ts.isPropertySignature,
        );
        if (!property || !declaration || internalMember(declaration))
            context.fail(
                site,
                `${owner}.${option.name} is not a public option.`,
            );
        const field = `${target}.${cppIdentifier(snakeCase(option.name))}`;
        emitPresentOption(context, option, (present) => {
            const kind = present.type?.kind;
            if (kind === "abort-signal")
                context.emit({
                    kind: "expression",
                    code: `${field} = ${present.cpp};`,
                });
            else if (
                kind === "number" ||
                kind === "boolean" ||
                kind === "string" ||
                kind === "enum"
            )
                emitScalarOption(
                    context,
                    present,
                    kind === "enum" ? "string" : kind,
                    field,
                    site,
                );
            else if (model && present.value?.kind === "record") {
                // A nested options record, filled member by member.
                const nested = context.checker.getNonNullableType(
                    context.checker.getTypeOfSymbolAtLocation(property, site),
                );
                const name = context.checker.typeToString(nested);
                const record =
                    context.allocateTemporaryCppName("library_options");
                context.emit({
                    kind: "declaration",
                    type: model.cppType({ kind: "record", name }),
                    name: record,
                    initializer: "{}",
                });
                fillLibraryOptions(
                    context,
                    record,
                    nested,
                    name,
                    present.value,
                    site,
                );
                context.emit({
                    kind: "expression",
                    code: `${field} = std::move(${record});`,
                });
            } else if (model && present.value?.kind === "callback")
                context.emit({
                    kind: "expression",
                    code: `${field} = ${libraryFunctionOption(context, model, present.value, model.memberShape(owner, option.name), site)};`,
                });
            else
                context.fail(
                    site,
                    `${owner}.${option.name} of this value is not lowered.`,
                );
        });
    }
}
