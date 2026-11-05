import type ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import { argumentAt } from "../syntax.js";
import type { Value } from "../types.js";
import { absenceOf } from "../values/model.js";
import type { IntrinsicCallContext } from "./context.js";
import { sharedPinnedContext } from "../../lowering/context.js";
import {
    pinnedSamplerKey,
    type PinnedSamplerKey,
} from "../../lowering/sampler-pool.js";
import { floatLiteral } from "../../cpp-literals.js";
import {
    addressModeCppByPin,
    mipmapModeByPin,
    textureFilterCppByPin,
} from "../../pinned-address-modes.js";

export interface SamplerIntrinsicContext
    extends IntrinsicCallContext, Pick<LoweringServices, "fail"> {}

type SamplerDescriptorContext = Pick<LoweringServices, "compileValue" | "fail">;

/**
 * WebGPU's own `GPUSamplerDescriptor` defaults, which `device.createSampler`
 * applies: nearest filters, clamp-to-edge, LOD 0 to 32, no anisotropy.
 */
const DEVICE_SAMPLER_DEFAULTS: PinnedSamplerKey = {
    defaults: new Map<string, string | number>([
        ["addressModeU", "clamp-to-edge"],
        ["addressModeV", "clamp-to-edge"],
        ["addressModeW", "clamp-to-edge"],
        ["magFilter", "nearest"],
        ["minFilter", "nearest"],
        ["mipmapFilter", "nearest"],
        ["maxAnisotropy", 1],
    ]),
    lodMinClamp: 0,
    lodMaxClamp: 32,
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
    const state = samplerState(
        context,
        call,
        call.arguments[1],
        pinnedSamplerKey(sharedPinnedContext()),
    );
    return {
        kind: "gpu-sampler",
        cpp: `bbl::GpuSampler{bbl::gpu_device_identity(${engine.cpp}), ${state}}`,
        engineCpp: engine.cpp,
        dataType: { kind: "handle", handle: "gpu-sampler" },
    };
}

/**
 * `device.createSampler(descriptor?)` on the engine's device: a new sampler
 * object each call, its state WebGPU's defaults under the fields given.
 */
export function compileDeviceSampler(
    context: SamplerDescriptorContext &
        Pick<LoweringServices, "expectArgumentCount" | "requireEngine">,
    call: ts.CallExpression,
    device: Value,
): Value {
    context.expectArgumentCount(call, 0, 1);
    const state = samplerState(
        context,
        call,
        call.arguments[0],
        DEVICE_SAMPLER_DEFAULTS,
    );
    return {
        kind: "gpu-sampler",
        cpp: `bbl::create_device_sampler(${device.cpp}, ${state})`,
        engineCpp: context.requireEngine(device, call),
        dataType: { kind: "handle", handle: "gpu-sampler" },
    };
}

/**
 * A descriptor's native sampler state over its defaults. Every field must
 * be known at generation; the fields both backends cannot represent (a
 * comparison, a LOD floor, a W address mode other than clamp-to-edge)
 * refuse.
 */
function samplerState(
    context: SamplerDescriptorContext,
    call: ts.CallExpression,
    descriptor: ts.Expression | undefined,
    defaults: PinnedSamplerKey,
): string {
    const fields = new Map<string, string | number>(defaults.defaults);
    let lodMinClamp = defaults.lodMinClamp;
    let lodMaxClamp = defaults.lodMaxClamp;
    if (descriptor) {
        const value = context.compileValue(descriptor);
        if (value.kind !== "record" || !value.recordProperties)
            return context.fail(
                descriptor,
                "A sampler descriptor must be known at generation.",
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
    // The field's native spelling, refused unless `table` has a row for it.
    const spelled = (
        name: string,
        table: Readonly<Record<string, string>>,
    ): string => {
        const text = String(fields.get(name));
        const cpp = table[text];
        if (cpp === undefined)
            context.fail(call, `Unknown sampler ${name} '${text}'.`);
        return cpp;
    };
    const minFilter = spelled("minFilter", textureFilterCppByPin);
    const magFilter = spelled("magFilter", textureFilterCppByPin);
    const mipmapFilter = `bbl::${spelled("mipmapFilter", mipmapModeByPin)}`;
    if (
        lodMinClamp !== defaults.lodMinClamp ||
        spelled("addressModeW", addressModeCppByPin) !==
            addressModeCppByPin["clamp-to-edge"]
    )
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
            ["minFilter", "magFilter", "mipmapFilter"].some(
                (name) => fields.get(name) !== "linear",
            ))
    )
        context.fail(
            call,
            "A sampler's maxAnisotropy is an integer in [1, 16], above 1 only with linear filters.",
        );
    return (
        `bbl::TextureSamplerState{${minFilter}, ${magFilter}, ${mipmapFilter}, ` +
        `${spelled("addressModeU", addressModeCppByPin)}, ` +
        `${spelled("addressModeV", addressModeCppByPin)}, ` +
        `${floatLiteral(anisotropy)}, ${floatLiteral(lodMaxClamp)}}`
    );
}
