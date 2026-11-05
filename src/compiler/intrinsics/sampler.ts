import type ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import { argumentAt } from "../syntax.js";
import type { Value } from "../types.js";
import { absenceOf } from "../values/model.js";
import type { IntrinsicCallContext } from "./context.js";
import { sharedPinnedContext } from "../../lowering/context.js";
import { pinnedSamplerKey } from "../../lowering/sampler-pool.js";
import { floatLiteral } from "../../cpp-literals.js";

export interface SamplerIntrinsicContext
    extends IntrinsicCallContext, Pick<LoweringServices, "fail"> {}

const FILTERS: Readonly<Record<string, string>> = {
    nearest: "nearest",
    linear: "linear",
};
const ADDRESS_MODES: Readonly<Record<string, string>> = {
    "clamp-to-edge": "clamp",
    repeat: "repeat",
    "mirror-repeat": "mirror",
};

/**
 * `getOrCreateSampler(engine, descriptor?)`: the pool's sampler for the
 * descriptor's key (`resource/sampler-pool.ts`), natively the device and
 * the canonical state, so equal keys are one sampler as upstream. Every
 * field takes the pool's own default; the fields both backends cannot
 * represent (a comparison, a LOD floor, a W address mode) refuse.
 */
export function compileSamplerIntrinsic(
    context: SamplerIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    if (importedName !== "getOrCreateSampler") return undefined;
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const key = pinnedSamplerKey(sharedPinnedContext());
    const fields = new Map<string, string | number>(key.defaults);
    let lodMinClamp = key.lodMinClamp;
    let lodMaxClamp = key.lodMaxClamp;
    const descriptor = call.arguments[1];
    if (descriptor) {
        const value = context.compileValue(descriptor);
        if (value.kind !== "record" || !value.recordProperties)
            return context.fail(
                descriptor,
                "getOrCreateSampler takes a descriptor generation knows.",
            );
        for (const [name, field] of Object.entries(value.recordProperties)) {
            // The label names the GPU object; the pool does not key it.
            if (name === "label" || absenceOf(field) === "undefined") continue;
            const known = field.staticString ?? field.staticNumber;
            if (known === undefined)
                return context.fail(
                    descriptor,
                    `A sampler descriptor's '${name}' must be known at generation.`,
                );
            if (name === "lodMinClamp" && typeof known === "number")
                lodMinClamp = known;
            else if (name === "lodMaxClamp" && typeof known === "number")
                lodMaxClamp = known;
            else if (fields.has(name)) fields.set(name, known);
            else
                return context.fail(
                    descriptor,
                    `A sampler descriptor's '${name}' is not lowered.`,
                );
        }
    }
    const text = (name: string): string => String(fields.get(name));
    const filter = (name: string): string => {
        const mode = FILTERS[text(name)];
        if (!mode)
            context.fail(call, `Unknown sampler ${name} '${text(name)}'.`);
        return mode;
    };
    const address = (name: string): string => {
        const mode = ADDRESS_MODES[text(name)];
        if (!mode)
            context.fail(call, `Unknown sampler ${name} '${text(name)}'.`);
        return mode;
    };
    if (lodMinClamp !== key.lodMinClamp || address("addressModeW") !== "clamp")
        context.fail(
            call,
            "A sampler with a LOD floor or a W address mode other than clamp-to-edge is not lowered.",
        );
    const anisotropy = Number(fields.get("maxAnisotropy"));
    if (
        !Number.isInteger(anisotropy) ||
        anisotropy < 1 ||
        anisotropy > 16 ||
        (anisotropy > 1 &&
            [
                filter("minFilter"),
                filter("magFilter"),
                filter("mipmapFilter"),
            ].some((mode) => mode !== "linear"))
    )
        context.fail(
            call,
            "A sampler's maxAnisotropy is an integer in [1, 16], above 1 only with linear filters.",
        );
    const state =
        `bbl::TextureSamplerState{` +
        `bbl::TextureFilter::${filter("minFilter")}, ` +
        `bbl::TextureFilter::${filter("magFilter")}, ` +
        `bbl::TextureMipmapMode::${filter("mipmapFilter")}, ` +
        `bbl::TextureAddressMode::${address("addressModeU")}, ` +
        `bbl::TextureAddressMode::${address("addressModeV")}, ` +
        `${floatLiteral(anisotropy)}, ${floatLiteral(lodMaxClamp)}}`;
    return {
        kind: "gpu-sampler",
        cpp: `bbl::GpuSampler{bbl::gpu_device_identity(${engine.cpp}), ${state}}`,
        engineCpp: engine.cpp,
        dataType: { kind: "handle", handle: "gpu-sampler" },
    };
}
