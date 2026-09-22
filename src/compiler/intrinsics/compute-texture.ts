import ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { argumentAt } from "../syntax.js";
import {
    compileStaticNumber,
    validateObjectProperties,
    type PositiveIntegerContext,
} from "../option-helpers.js";
import { stringLiteral } from "../../cpp-literals.js";
import { compileRetainedComputeTextureOptions } from "./compute-texture-options.js";

export interface ComputeTextureIntrinsicContext
    extends
        IntrinsicCallContext,
        PositiveIntegerContext,
        Pick<
            LoweringServices,
            | "fail"
            | "emit"
            | "allocateTemporaryCppName"
            | "expectObjectLiteral"
            | "objectProperty"
            | "propertyName"
            | "compileStringLiteral"
            | "compileNumber"
            | "compileBoolean"
            | "dataTypes"
            | "pinValueToTemporary"
        > {}

export function compileComputeTextureIntrinsic(
    context: ComputeTextureIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (name === "createComputeStorageTextureMipmapsTask") {
        context.expectArgumentCount(call, 2, 2);
        context.reachFeature("compute:texture-mipmaps", call);
        const label = context.compileValue(argumentAt(call, 0));
        context.expectKind(label, "string", call);
        const site = argumentAt(call, 1);
        const resources = context.compileValue(site);
        let values: string;
        if (resources.kind === "tuple" && resources.tupleElements) {
            values = `{${resources.tupleElements
                .map((value) => {
                    context.expectKind(value, "compute-storage-texture", site);
                    return context.pinValueToTemporary(
                        value,
                        "mipmap_texture",
                        site,
                    ).cpp;
                })
                .join(", ")}}`;
        } else {
            const type = resources.dataType;
            if (
                type?.kind !== "vector" ||
                type.element.kind !== "handle" ||
                type.element.handle !== "compute-storage-texture"
            )
                return context.fail(
                    site,
                    "Mipmap tasks require a retained array of compute storage textures.",
                );
            const array = context.pinValueToTemporary(
                resources,
                "mipmap_textures",
                site,
            );
            values = `bbl::js::array_to_vector(${array.cpp})`;
        }
        return {
            kind: "compute-task",
            dataType: { kind: "handle", handle: "compute-task" },
            cpp: `bbl::create_compute_storage_texture_mipmaps_task(${label.cpp}, ${values})`,
        };
    }
    if (name === "disposeComputeStorageTexture") {
        context.expectArgumentCount(call, 1, 1);
        const resource = context.compileValue(argumentAt(call, 0));
        context.expectKind(resource, "compute-storage-texture", call);
        return {
            kind: "void",
            cpp: `bbl::dispose_compute_storage_texture(${resource.cpp})`,
        };
    }
    if (name !== "createComputeStorageTexture") return undefined;
    context.expectArgumentCount(call, 2, 2);
    context.reachFeature("compute:storage-texture", call);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", call);
    if (!engine.ownedEngineCpp)
        return context.fail(
            call,
            "Compute textures require a realm-owned engine.",
        );
    const optionExpression = argumentAt(call, 1);
    const target = ts.isObjectLiteralExpression(
        context.resolveStaticExpression(optionExpression),
    )
        ? compileLiteralComputeTextureOptions(context, optionExpression)
        : compileRetainedComputeTextureOptions(context, optionExpression);
    return {
        kind: "promise",
        cpp: `bbl::create_compute_storage_texture(${engine.ownedEngineCpp}, std::move(${target}))`,
        promiseType: "std::shared_ptr<bbl::ComputeStorageTexture>",
        promiseResult: {
            kind: "compute-storage-texture",
            dataType: { kind: "handle", handle: "compute-storage-texture" },
            cpp: "",
            engineCpp: engine.cpp,
        },
    };
}

function compileLiteralComputeTextureOptions(
    context: ComputeTextureIntrinsicContext,
    optionExpression: ts.Expression,
): string {
    const options = context.expectObjectLiteral(optionExpression);
    validateObjectProperties(
        context,
        options,
        [
            "width",
            "height",
            "depthOrArrayLayers",
            "viewDimension",
            "format",
            "access",
            "sampled",
            "sampler",
            "mipMaps",
            "label",
            "invertY",
        ],
        "Unrepresented compute texture option.",
    );
    for (const required of ["width", "viewDimension", "format"])
        if (!context.objectProperty(options, required))
            context.fail(
                options,
                `Compute texture options require ${required}.`,
            );
    const target = context.allocateTemporaryCppName("compute_texture_options");
    context.emit(`bbl::ComputeStorageTextureOptions ${target};`);
    for (const property of options.properties) {
        if (
            !ts.isPropertyAssignment(property) &&
            !ts.isShorthandPropertyAssignment(property)
        )
            return context.fail(
                property,
                "Compute texture options require named values.",
            );
        const key = context.propertyName(property.name);
        const value = ts.isPropertyAssignment(property)
            ? property.initializer
            : property.name;
        if (key === "sampler") {
            const sampler = context.expectObjectLiteral(value);
            const fields: Record<string, string> = {
                addressModeU: "address_u",
                addressModeV: "address_v",
                addressModeW: "address_w",
                minFilter: "min_filter",
                magFilter: "mag_filter",
                mipmapFilter: "mip_filter",
                maxAnisotropy: "anisotropy",
            };
            validateObjectProperties(
                context,
                sampler,
                Object.keys(fields),
                "Unrepresented compute sampler option.",
            );
            for (const entry of sampler.properties) {
                if (
                    !ts.isPropertyAssignment(entry) &&
                    !ts.isShorthandPropertyAssignment(entry)
                )
                    return context.fail(
                        entry,
                        "Compute samplers require named values.",
                    );
                const field = context.propertyName(entry.name)!;
                const expression = ts.isPropertyAssignment(entry)
                    ? entry.initializer
                    : entry.name;
                let cpp: string;
                if (field === "maxAnisotropy") {
                    const number = compileStaticNumber(
                        context,
                        expression,
                        "Compute sampler anisotropy",
                    );
                    if (!Number.isInteger(number) || number < 1 || number > 16)
                        return context.fail(
                            expression,
                            "Compute sampler anisotropy requires an integer in [1,16].",
                        );
                    cpp = String(number);
                } else {
                    const literal = context.compileStringLiteral(expression);
                    const accepted = field.startsWith("addressMode")
                        ? ["repeat", "mirror-repeat", "clamp-to-edge"]
                        : ["nearest", "linear"];
                    if (!accepted.includes(literal))
                        return context.fail(
                            expression,
                            "Unrepresented compute sampler mode.",
                        );
                    cpp = stringLiteral(literal);
                }
                context.emit(
                    `${target}.descriptor.sampler.${fields[field]} = ${cpp};`,
                );
            }
            continue;
        }
        if (
            key === "width" ||
            key === "height" ||
            key === "depthOrArrayLayers"
        ) {
            context.emit(
                `${target}.${key === "depthOrArrayLayers" ? "depth" : key} = ${context.compileNumber(value)};`,
            );
        } else if (
            key === "mipMaps" ||
            key === "sampled" ||
            key === "invertY"
        ) {
            const member =
                key === "mipMaps"
                    ? "mip_maps"
                    : key === "invertY"
                      ? "invert_y"
                      : "sampled";
            context.emit(
                `${target}.${member} = ${context.compileBoolean(value)};`,
            );
        } else if (key === "label") {
            const label = context.compileValue(value);
            context.expectKind(label, "string", value);
            context.emit(`${target}.descriptor.label = ${label.cpp};`);
        } else {
            const literal = context.compileStringLiteral(value);
            const accepted =
                key === "viewDimension"
                    ? ["2d"]
                    : key === "access"
                      ? ["write-only", "read-only", "read-write"]
                      : [
                            "rgba8unorm",
                            "rgba8snorm",
                            "rgba16float",
                            "r32float",
                            "rg32float",
                            "rgba32float",
                        ];
            if (!accepted.includes(literal))
                return context.fail(
                    value,
                    `Unrepresented compute texture ${key}: ${literal}.`,
                );
            const member =
                key === "viewDimension"
                    ? "dimension"
                    : key === "access"
                      ? "accesses"
                      : "format";
            context.emit(
                `${target}.descriptor.${member} = ${key === "access" ? `{${stringLiteral(literal)}}` : stringLiteral(literal)};`,
            );
            if (key === "access")
                context.emit(`${target}.access_supplied = true;`);
        }
    }
    return target;
}
