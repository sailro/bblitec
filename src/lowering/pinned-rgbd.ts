import type { LoweringContext } from "./context.js";
import ts from "typescript";
import { parseWgslComputeModule, parseWgslExpression, type ShaderExpression } from "../shader-ir.js";
import { emitShaderCppExpression } from "../shader-cpp-emitter.js";

export function pinnedRgbdHeader(context: LoweringContext): string {
    const module = "src/loader-env/rgbd-decode.ts";
    const file = context.sourceFile(module);
    for (const symbol of ["decodeBrdfPng", "uploadCubemapRGBD"]) {
        const { declaration } = context.functionDeclaration(module, symbol);
        const input = context.unwrapExpression(context.variableInitializer(declaration, "inputTex"));
        if (!ts.isCallExpression(input) || !ts.isPropertyAccessExpression(input.expression) ||
            input.expression.name.text !== "createTexture" || input.arguments.length !== 1 ||
            !ts.isObjectLiteralExpression(input.arguments[0]!) ||
            context.stringValue(context.propertyInitializer(input.arguments[0]!, "format"), file) !== "rgba8unorm") {
            context.contractError(input, "RGBD CPU projection requires an rgba8unorm input texture.");
        }
    }
    const shader = context.stringValue(context.variableInitializer(file, "WGSL"), file);
    const kernel = parseWgslComputeModule(shader);
    const fail = (): never => context.contractError(file, "RGBD CPU projection requires the pinned texel mapping and unconditional output.");
    const [dimensions, guard, load, store] = kernel.statements;
    const [invocation] = kernel.parameters, [flip] = kernel.overrides;
    const input = kernel.bindings.find(binding => binding.type === "texture_2d<f32>");
    const output = kernel.bindings.find(binding => binding.type === "texture_storage_2d<rgba16float,write>");
    if (kernel.statements.length !== 4 || dimensions?.kind !== "let" || guard?.kind !== "if" ||
        load?.kind !== "let" || store?.kind !== "expression" || store.value.kind !== "call" ||
        store.value.name !== "textureStore" || store.value.arguments.length !== 3 ||
        kernel.parameters.length !== 1 || invocation?.attribute?.value !== "global_invocation_id" ||
        !["vec3u", "vec3<u32>"].includes(invocation.type) || kernel.overrides.length !== 1 ||
        flip?.type !== "bool" || !input || !output || kernel.bindings.length !== 2 ||
        guard.statements.length !== 1 || guard.statements[0]?.kind !== "return" || guard.statements[0].value) return fail();
    const expect = (expression: ShaderExpression, expected: string): void => {
        if (JSON.stringify(expression) !== JSON.stringify(parseWgslExpression(expected))) fail();
    };
    expect(flip.value, "false");
    expect(dimensions.value, `textureDimensions(${input.name})`);
    expect(guard.condition, `any(${invocation.name}.xy >= ${dimensions.name})`);
    // Resource addressing is adapted by the image-upload caller; validate the
    // pin's optional Y flip and same-texel write before lowering its arithmetic.
    expect(load.value, `textureLoad(${input.name}, vec2u(${invocation.name}.x, select(${invocation.name}.y, ${dimensions.name}.y - 1u - ${invocation.name}.y, ${flip.name})), 0)`);
    expect(store.value.arguments[0]!, output.name);
    expect(store.value.arguments[1]!, `${invocation.name}.xy`);
    const result = emitShaderCppExpression(store.value.arguments[2]!, new Map([
        [load.name, Array.from({ length: 4 }, (_, i) => ({ cpp: `static_cast<float>(rgba[${i}]) / 255.0f`, unorm8: `rgba[${i}]` }))],
    ]), { tabulateUnorm8: true });
    if (result.components.length !== 4) context.contractError(file, "RGBD output must have four float lanes.");
    return `#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace bbl::upstream {
// ${context.provenance(module, "WGSL")}
inline std::array<float, 4> decode_rgbd_pixel(const std::uint8_t* rgba) {
${result.declarations.join("\n")}
    return {${result.components.join(", ")}};
}
}
`;
}
