import type ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    retainedOptions,
    type RetainedOptionsContext,
} from "./retained-options.js";

export interface ProceduralSkyIntrinsicContext
    extends
        IntrinsicCallContext,
        RetainedOptionsContext,
        Pick<
            LoweringServices,
            | "allocateTemporaryCppName"
            | "assetRegistry"
            | "cppString"
            | "castNumber"
            | "reachJsData"
        > {}

const atmosphereFields = [
    "luminance",
    "turbidity",
    "rayleigh",
    "mieCoefficient",
    "mieDirectionalG",
];

/** Snapshot source options at each call; the pinned functions own atmosphere validation. */
function compileOptions(
    context: ProceduralSkyIntrinsicContext,
    site: ts.Expression,
    load: boolean,
): { cpp: string; brdfPath?: string } {
    const fields = retainedOptions(context, context.compileValue(site), site);
    const names = new Set(fields.map((field) => field.name));
    for (const name of [
        "sunDirection",
        ...atmosphereFields,
        ...(load ? ["brdfUrl"] : []),
    ])
        if (!names.has(name))
            context.fail(site, `Procedural sky requires option ${name}.`);
    const target = context.allocateTemporaryCppName("sky_options");
    context.emit(`bbl::ProceduralSkyOptions ${target};`);
    let brdfPath: string | undefined;
    for (const field of fields) {
        if (
            field.optionalProperty ||
            field.present ||
            field.type?.kind === "optional"
        )
            context.fail(
                site,
                `Procedural sky option ${field.name} must be present.`,
            );
        if (atmosphereFields.includes(field.name)) {
            if (field.type?.kind !== "number")
                context.fail(
                    site,
                    `Procedural sky option ${field.name} requires a number.`,
                );
            context.emit(
                `${target}.${field.name} = ${field.value ? context.castNumber(field.value, "double") : field.cpp};`,
            );
        } else if (field.name === "sunDirection") {
            let components: string[];
            if (
                field.value?.kind === "tuple" &&
                field.value.tupleElements?.length === 3
            ) {
                components = field.value.tupleElements.map((value) => {
                    context.expectKind(value, "number", site);
                    return context.castNumber(value, "double");
                });
            } else if (field.type?.kind === "tuple" && field.type.arity === 3) {
                const direction =
                    context.allocateTemporaryCppName("sky_direction");
                context.emit(`const auto ${direction} = ${field.cpp};`);
                components = [0, 1, 2].map((index) => `${direction}[${index}]`);
            } else
                return context.fail(
                    site,
                    "Procedural sky sunDirection requires a numeric tuple of three components.",
                );
            context.emit(
                `${target}.sunDirection = {${components.join(", ")}};`,
            );
        } else if (field.name === "brdfUrl" && load) {
            const source = field.value?.staticString;
            if (source === undefined)
                context.fail(
                    site,
                    "Procedural sky brdfUrl requires a packaged static asset URL.",
                );
            const asset = context.assetRegistry.registerAsset(
                source,
                "texture",
            );
            brdfPath = `bbl::asset_path(${context.cppString(asset.output)})`;
        } else
            context.fail(
                site,
                `Unrepresented procedural sky option ${field.name}.`,
            );
    }
    return { cpp: target, ...(brdfPath ? { brdfPath } : {}) };
}

export function compileProceduralSkyIntrinsic(
    context: ProceduralSkyIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (
        ![
            "loadProceduralSkyEnvironment",
            "updateProceduralSkyEnvironment",
            "computeProceduralSkySunColor",
        ].includes(name)
    )
        return undefined;
    const sun = name === "computeProceduralSkySunColor",
        load = name === "loadProceduralSkyEnvironment";
    context.expectArgumentCount(call, sun ? 1 : 2, sun ? 1 : 2);
    context.reachFeature(
        sun ? "environment:sky-atmosphere" : "environment:procedural-sky",
        call,
    );
    const owner = sun
        ? undefined
        : context.bindings.pinValueToTemporary(
              context.compileValue(argumentAt(call, 0)),
              "sky_owner",
              call,
          );
    if (owner)
        context.expectKind(
            owner,
            load ? "scene" : "procedural-sky-environment",
            call,
        );
    const options = compileOptions(
        context,
        argumentAt(call, sun ? 0 : 1),
        load,
    );
    if (sun) {
        context.reachJsData();
        const color = context.allocateTemporaryCppName("sky_sun_color");
        context.emit(
            `const auto ${color} = bbl::compute_procedural_sky_sun_color(${options.cpp});`,
        );
        return {
            kind: "data",
            dataType: { kind: "tuple", arity: 3 },
            cpp: `bbl::js::Tuple<3>{${[0, 1, 2].map((index) => `${color}[${index}]`).join(", ")}}`,
        };
    }
    if (load)
        return {
            kind: "promise",
            cpp: `bbl::load_procedural_sky_environment(${owner!.cpp}, ${options.cpp}, ${options.brdfPath!})`,
            promiseType: "std::shared_ptr<bbl::ProceduralSkyEnvironment>",
            promiseResult: {
                kind: "procedural-sky-environment",
                cpp: "",
                dataType: {
                    kind: "handle",
                    handle: "procedural-sky-environment",
                },
                ...(owner!.engineCpp ? { engineCpp: owner!.engineCpp } : {}),
            },
        };
    return {
        kind: "promise",
        cpp: `bbl::update_procedural_sky_environment(${owner!.cpp}, ${options.cpp})`,
        promiseType: "bool",
        promiseResult: {
            kind: "boolean",
            cpp: "",
            dataType: { kind: "boolean" },
        },
    };
}
