import ts from "typescript";
import type { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";

/**
 * Complete source sampling over native Float32 storage, including arbitrary
 * morph arity. `prefix` names the emitted templates: the glTF loader and the
 * property-animation unit each carry the one translation in their own unit.
 */
export function lowerGltfAnimationEvaluator(
    context: LoweringContext,
    prefix: "gltf" | "property" = "gltf",
): string {
    const module = "src/animation/evaluate.ts";
    const types = context.sourceFile("src/animation/types.ts");
    const functions = [
        [
            "findKeyframe",
            `${prefix}_find_animation_key`,
            "double",
            "const Input& input, double t",
            "class Input",
        ],
        [
            "normalizeQuat4",
            `${prefix}_normalize_animation_quaternion`,
            "void",
            "Output& buf, double o",
            "class Output",
        ],
        [
            "quatSlerp",
            `${prefix}_slerp_animation_quaternion`,
            "void",
            "Output& out, double ax, double ay, double az, double aw, double bx, double by, double bz, double bw, double t",
            "class Output",
        ],
        [
            "evaluateSampler",
            `${prefix}_evaluate_animation_sampler`,
            "void",
            "const Sampler& sampler, double t, double stride, bool isQuat, Output& dst, double dstOffset",
            "class Sampler, class Output",
        ],
    ] as const;
    return functions
        .map(([symbol, cpp, result, parameters, templates]) => {
            const { file, declaration } = context.functionDeclaration(
                module,
                symbol,
            );
            const bindings = new Map<string, PinnedBinding>();
            for (const parameter of declaration.parameters) {
                if (!ts.isIdentifier(parameter.name))
                    context.contractError(
                        parameter,
                        "Expected named sampler parameters.",
                    );
                const name = parameter.name.text;
                bindings.set(name, {
                    cpp: name,
                    type: ["input", "buf", "out", "dst"].includes(name)
                        ? "f32"
                        : name === "sampler"
                          ? "opaque"
                          : name === "isQuat"
                            ? "bool"
                            : "scalar",
                });
            }
            bindings.set("_quat", { cpp: "quaternion", type: "f32" });
            for (const name of ["INTERP_STEP", "INTERP_CUBICSPLINE"])
                bindings.set(name, {
                    cpp: context.doubleLiteral(
                        context.pinnedNumber(types, name),
                    ),
                    type: "scalar",
                });
            const body = lowerPinnedBody(file, declaration.body!.statements, {
                bindings,

                returnValue: (expression, lowerer) =>
                    expression ? lowerer.expression(expression) : "",
                calls: new Map([
                    ...functions.map(
                        ([name, target]) =>
                            [
                                name,
                                (args: readonly string[]) =>
                                    `${target}(${args.join(", ")})`,
                            ] as const,
                    ),
                ]),
                statement(statement, _lowerer, indent) {
                    if (
                        !ts.isVariableStatement(statement) ||
                        statement.declarationList.declarations.length !== 1
                    )
                        return undefined;
                    const variable = statement.declarationList.declarations[0]!;
                    if (!ts.isObjectBindingPattern(variable.name))
                        return undefined;
                    context.assertStatementShapes(
                        statement,
                        [statement],
                        "const { input, output, interpolation } = sampler;",
                        "Animation sampler storage",
                    );
                    bindings.set("input", { cpp: "input", type: "f32" });
                    bindings.set("output", { cpp: "output", type: "f32" });
                    bindings.set("interpolation", {
                        cpp: "interpolation",
                        type: "scalar",
                    });
                    return [
                        `${indent}const auto& input = sampler.input;`,
                        `${indent}const auto& output = sampler.output;`,
                        `${indent}const double interpolation = sampler.interpolation;`,
                    ];
                },
            });
            return `// ${context.provenance(module, symbol)}
template<${templates}>
${result} ${cpp}(${parameters}) {
${symbol === "evaluateSampler" ? "    std::array<float, 4> quaternion{};\n" : ""}${body}
}`;
        })
        .join("\n\n");
}
