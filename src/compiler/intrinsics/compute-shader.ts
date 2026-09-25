import type ts from "typescript";
import { createHash } from "node:crypto";
import type { Value } from "../types.js";
import type { LoweringServices } from "../lowering-services.js";
import { argumentAt } from "../syntax.js";
import { stringLiteral } from "../../cpp-literals.js";
import { computeShaderDefaultEntryPoint } from "../../lowering/compute-shader-lowerer.js";
import {
    retainedOptions,
    emitPresentOption,
    emitScalarOption,
} from "./retained-options.js";
import type { UniformBufferIntrinsicContext } from "./uniform-buffer.js";

export interface ComputeShaderIntrinsicContext
    extends
        UniformBufferIntrinsicContext,
        Pick<LoweringServices, "sceneManifest"> {}
export function compileComputeShaderIntrinsic(
    context: ComputeShaderIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (
        name !== "createComputeShader" &&
        name !== "disposeComputeShader" &&
        name !== "prepareComputeShader"
    )
        return undefined;
    if (name === "prepareComputeShader") {
        context.expectArgumentCount(call, 1, 1);
        const shader = context.compileValue(argumentAt(call, 0));
        context.expectKind(shader, "compute-shader", call);
        return {
            kind: "promise",
            cpp: `bbl::prepare_compute_shader(${shader.cpp})`,
            promiseType: "bbl::js::PromiseVoid",
            promiseResult: { kind: "void", cpp: "" },
        };
    }
    if (name === "disposeComputeShader") {
        context.expectArgumentCount(call, 1, 1);
        const shader = context.compileValue(argumentAt(call, 0));
        context.expectKind(shader, "compute-shader", call);
        return {
            kind: "void",
            cpp: `bbl::dispose_compute_shader(${shader.cpp})`,
        };
    }
    context.expectArgumentCount(call, 2, 2);
    context.reachFeature("compute:shader", call);
    context.reachFeature("compute:binding-decl", call);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", call);
    if (!engine.ownedEngineCpp)
        return context.fail(
            call,
            "Compute shaders require a realm-owned engine.",
        );
    const site = argumentAt(call, 1),
        value = context.compileValue(site),
        fields = retainedOptions(context, value, site);
    const source = fields.find((field) => field.name === "computeSource")?.value
        ?.staticString;
    const entryField = fields.find((field) => field.name === "entryPoint"),
        entry = entryField
            ? entryField.value?.staticString
            : computeShaderDefaultEntryPoint();
    if (source === undefined || entry === undefined)
        return context.fail(
            site,
            "Compute shaders require generation-known WGSL and entry points.",
        );
    const program = {
        name: `compute-${createHash("sha256")
            .update(JSON.stringify([source, entry]))
            .digest("hex")
            .slice(0, 24)}`,
        source,
        entryPoint: entry,
    };
    if (
        source.length > 0 &&
        entry.length > 0 &&
        !context.sceneManifest.reachedComputePrograms.some(
            (value) => value.name === program.name,
        )
    )
        context.sceneManifest.reachedComputePrograms.push(program);
    const target = context.allocateTemporaryCppName("compute_shader_options");
    context.emit(`bbl::ComputeShaderOptions ${target};`);
    for (const field of fields)
        emitPresentOption(context, field, (member) => {
            if (["computeSource", "name", "entryPoint"].includes(member.name)) {
                emitScalarOption(
                    context,
                    member,
                    "string",
                    `${target}.${member.name === "computeSource" ? "source" : member.name === "entryPoint" ? "entry_point" : "name"}`,
                    site,
                );
                return;
            }
            if (member.name !== "bindings")
                return context.fail(
                    site,
                    `Unrepresented compute shader option ${member.name}.`,
                );
            if (member.value?.kind === "tuple" && member.value.tupleElements) {
                for (const item of member.value.tupleElements) {
                    context.expectKind(item, "compute-binding-decl", site);
                    context.emit(`${target}.bindings.push_back(${item.cpp});`);
                }
                return;
            }
            if (
                member.type?.kind !== "vector" ||
                member.type.element.kind !== "handle" ||
                member.type.element.handle !== "compute-binding-decl"
            )
                return context.fail(
                    site,
                    "Compute shader bindings require retained declarations.",
                );
            context.emit(
                `${target}.bindings.assign(${member.cpp}.begin(), ${member.cpp}.end());`,
            );
        });
    const shader = context.allocateTemporaryCppName("compute_shader");
    context.emit(
        `const auto ${shader} = bbl::create_compute_shader(${engine.ownedEngineCpp}, ${target});`,
    );
    context.emit(
        `${shader}->artifact = ${stringLiteral(program.name + ".comp")};`,
    );
    return {
        kind: "compute-shader",
        dataType: { kind: "handle", handle: "compute-shader" },
        engineCpp: engine.cpp,
        cpp: shader,
    };
}
