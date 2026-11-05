import type ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import { argumentAt } from "../syntax.js";
import type { Value } from "../types.js";
import { absenceOf } from "../values/model.js";
import type { IntrinsicCallContext } from "./context.js";
import { sharedPinnedContext } from "../../lowering/context.js";
import {
    gpuSamplerDescriptorCpp,
    gpuSamplerDescriptorMembers,
} from "../../lowering/gpu-schema.js";
import { pinnedSamplerKey } from "../../lowering/sampler-pool.js";

export interface SamplerIntrinsicContext
    extends IntrinsicCallContext, Pick<LoweringServices, "fail"> {}

type SamplerDescriptorContext = Pick<LoweringServices, "compileValue" | "fail">;

/**
 * `getOrCreateSampler(engine, descriptor?)`: the pool's sampler for the
 * descriptor's key (`resource/sampler-pool.ts`), natively the device and
 * the state of the key itself, each member the key reads given or the
 * pool's default, so equal keys are one sampler as upstream.
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
    const given = samplerDescriptor(context, call.arguments[1]);
    const key = new Map<string, string | number>();
    for (const [name, fallback] of pinnedSamplerKey(sharedPinnedContext())
        .members) {
        const value = given.get(name) ?? fallback;
        if (value !== undefined) key.set(name, value);
    }
    return {
        kind: "gpu-sampler",
        cpp: `bbl::GpuSampler{bbl::gpu_device_identity(${engine.cpp}), bbl::texture_sampler_state(${gpuSamplerDescriptorCpp(key)})}`,
        engineCpp: engine.cpp,
        dataType: { kind: "handle", handle: "gpu-sampler" },
    };
}

/**
 * `device.createSampler(descriptor?)` on the engine's device: a new sampler
 * object each call, its state the descriptor as WebGPU resolves it.
 */
export function compileDeviceSampler(
    context: SamplerDescriptorContext &
        Pick<LoweringServices, "expectArgumentCount" | "requireEngine">,
    call: ts.CallExpression,
    device: Value,
): Value {
    context.expectArgumentCount(call, 0, 1);
    const descriptor = gpuSamplerDescriptorCpp(
        samplerDescriptor(context, call.arguments[0]),
    );
    return {
        kind: "gpu-sampler",
        cpp: `bbl::create_device_sampler(${device.cpp}, ${descriptor})`,
        engineCpp: context.requireEngine(device, call),
        dataType: { kind: "handle", handle: "gpu-sampler" },
    };
}

/**
 * A `GPUSamplerDescriptor`'s present members, each known at generation;
 * the native sampler applies WebGPU's defaults and validation.
 */
function samplerDescriptor(
    context: SamplerDescriptorContext,
    descriptor: ts.Expression | undefined,
): Map<string, string | number> {
    const given = new Map<string, string | number>();
    if (!descriptor) return given;
    const value = context.compileValue(descriptor);
    if (value.kind !== "record" || !value.recordProperties)
        return context.fail(
            descriptor,
            "A sampler descriptor must be known at generation.",
        );
    for (const [name, field] of Object.entries(value.recordProperties)) {
        if (absenceOf(field) === "undefined") continue;
        const member = gpuSamplerDescriptorMembers.get(name);
        if (!member)
            return context.fail(
                descriptor,
                `'${name}' is not a GPUSamplerDescriptor member.`,
            );
        const known =
            member.kind === "string" ? field.staticString : field.staticNumber;
        if (known === undefined)
            return context.fail(
                descriptor,
                `A sampler descriptor's '${name}' must be a ${member.kind} known at generation.`,
            );
        given.set(name, known);
    }
    return given;
}
