import type ts from "typescript";
import type { DataType } from "../data-types.js";
import type { Value } from "../types.js";
import type { ComputeTextureIntrinsicContext } from "./compute-texture.js";
import { stringLiteral } from "../../cpp-literals.js";

import {
    retainedOptions,
    emitPresentOption,
    emitScalarOption,
    type RetainedOption as Member,
} from "./retained-options.js";

/** A retained options bag keeps absent fields absent until the source factory applies defaults. */
export function compileRetainedComputeTextureOptions(
    context: ComputeTextureIntrinsicContext,
    expression: ts.Expression,
): string {
    const target = context.allocateTemporaryCppName("compute_texture_options");
    context.emit(`bbl::ComputeStorageTextureOptions ${target};`);
    const members = (value: Value): Member[] =>
        retainedOptions(context, value, expression);
    const present = (member: Member, emit: (value: Member) => void): void =>
        emitPresentOption(context, member, emit);
    const scalar = (
        member: Member,
        kind: "number" | "boolean" | "string",
        destination: string,
    ): void => emitScalarOption(context, member, kind, destination, expression);
    const samplerFields: Record<string, string> = {
        addressModeU: "address_u",
        addressModeV: "address_v",
        addressModeW: "address_w",
        minFilter: "min_filter",
        magFilter: "mag_filter",
        mipmapFilter: "mip_filter",
    };
    const emitSampler = (member: Member): void => {
        const value: Value =
            member.value?.kind === "record"
                ? member.value
                : {
                      kind: "data",
                      cpp: member.cpp,
                      ...(member.type ? { dataType: member.type } : {}),
                  };
        for (const entry of members(value))
            present(entry, (field) => {
                const destination = `${target}.descriptor.sampler.${samplerFields[field.name]}`;
                if (samplerFields[field.name])
                    scalar(field, "string", destination);
                else if (
                    field.name === "maxAnisotropy" &&
                    field.type?.kind === "number"
                )
                    context.emit(
                        `${target}.descriptor.sampler.anisotropy = bbl::pal::compute_sampler_anisotropy(${field.cpp});`,
                    );
                else
                    context.emit(
                        `throw std::runtime_error(${stringLiteral(`Unrepresented compute sampler option: ${field.name}.`)});`,
                    );
            });
    };
    const emitAccess = (member: Member): void => {
        const append = (type: DataType, cpp: string): string => {
            if (type.kind === "string" || type.kind === "enum")
                return `${target}.descriptor.accesses.push_back(${type.kind === "enum" ? context.dataTypes.enumToStringCpp(type, cpp, expression) : cpp});`;
            if (type.kind === "vector")
                return `for (const auto& access : ${cpp}) { ${append(type.element, "access")} }`;
            return context.fail(
                expression,
                "Compute texture access requires a string or string array.",
            );
        };
        if (!member.type)
            context.fail(
                expression,
                "Compute texture access requires a represented value.",
            );
        if (member.type.kind === "union")
            context.emit(
                `std::visit([&](const auto& accesses) { ${member.type.members.map((type, index) => `${index ? "else " : ""}if constexpr (std::is_same_v<std::decay_t<decltype(accesses)>, ${context.dataTypes.cppType(type)}>) { ${append(type, "accesses")} }`).join(" ")} }, ${member.cpp});`,
            );
        else context.emit(append(member.type, member.cpp));
        context.emit(`${target}.access_supplied = true;`);
    };
    const fields = members(context.compileValue(expression));
    for (const key of ["width", "viewDimension", "format"])
        if (!fields.some((field) => field.name === key))
            context.fail(expression, `Compute texture options require ${key}.`);
    for (const entry of fields)
        present(entry, (field) => {
            if (
                field.name === "width" ||
                field.name === "height" ||
                field.name === "depthOrArrayLayers"
            )
                scalar(
                    field,
                    "number",
                    `${target}.${field.name === "depthOrArrayLayers" ? "depth" : field.name}`,
                );
            else if (
                field.name === "mipMaps" ||
                field.name === "sampled" ||
                field.name === "invertY"
            )
                scalar(
                    field,
                    "boolean",
                    `${target}.${field.name === "mipMaps" ? "mip_maps" : field.name === "invertY" ? "invert_y" : "sampled"}`,
                );
            else if (
                field.name === "format" ||
                field.name === "viewDimension" ||
                field.name === "label"
            )
                scalar(
                    field,
                    "string",
                    `${target}.descriptor.${field.name === "viewDimension" ? "dimension" : field.name}`,
                );
            else if (field.name === "sampler") emitSampler(field);
            else if (field.name === "access") emitAccess(field);
            else
                context.fail(
                    expression,
                    `Unrepresented compute texture option: ${field.name}.`,
                );
        });
    return target;
}
