import { emitShaderCppExpression } from "../shader-cpp-emitter.js";
import { mapShaderExpression, type ShaderExpression } from "../shader-ir.js";
import { pinnedPbrVertexOutputs } from "../pinned-material-vertex.js";
import type { LoweringContext } from "./context.js";

export const bakedDirectionMinimumLength = 1e-6;

/** Project the pin's common normal/tangent normalization into the f32 CPU bake. */
export function pinnedVertexNormalization(context: LoweringContext): string {
    const module = "src/material/pbr/pbr-template.ts";
    const template = pinnedPbrVertexOutputs(context);
    const { declaration } = template;
    const isPath = (value: ShaderExpression, ...parts: string[]): boolean =>
        value.kind === "path" && value.parts.length === parts.length && value.parts.every((part, index) => part === parts[index]);
    const fail = (): never => context.contractError(declaration, "Pinned vertex normal/tangent normalization contract changed.");
    const direction = (output: string, input: string[]): ShaderExpression => {
        const world = template.outputs.get(output);
        if (world?.kind !== "member" || world.member !== "xyz" ||
            world.expression.kind !== "binary" || world.expression.operator !== "*" ||
            !isPath(world.expression.left, "mesh", "world")) return fail();
        const homogeneous = world.expression.right;
        if (homogeneous.kind !== "construct" || homogeneous.type !== "vec4<f32>" ||
            homogeneous.arguments.length !== 2 || homogeneous.arguments[1]?.kind !== "number" ||
            Number(homogeneous.arguments[1].value) !== 0) return fail();
        const value = homogeneous.arguments[0]!;
        if (value.kind !== "call" || value.name !== "normalize" || value.arguments.length !== 1) return fail();
        return mapShaderExpression(value, expression =>
            isPath(expression, ...input) ? { kind: "path", parts: ["bakedDirection"] } : expression);
    };
    const normal = direction("worldNormal", [template.normal]);
    const tangent = direction("worldTangent", ["tangent", "xyz"]);
    if (JSON.stringify(normal) !== JSON.stringify(tangent)) return fail();
    const projected = emitShaderCppExpression(normal, new Map([
        ["bakedDirection", ["x", "y", "z"].map(component => ({ cpp: `value.${component}` }))],
    ]), { minimumNormalizeLength: bakedDirectionMinimumLength });
    if (projected.components.length !== 3) return fail();
    return `// ${context.provenance(module, "createPbrTemplate")}
// CPU-bake normalization keeps its explicit degenerate-vector adaptation.
inline Vec3 normalize_baked_direction(Vec3 value) {
${projected.declarations.map(line => `    ${line}`).join("\n")}
    return Vec3{${projected.components.join(", ")}};
}`;
}
