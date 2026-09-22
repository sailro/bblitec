import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { stringLiteral } from "../cpp-literals.js";

/** Public setters retain their source validation and no-change branches. */
export function lightParameterHeader(context: LoweringContext): string {
    const functions = [
        [
            "src/light/set-light-intensity.ts",
            "setLightIntensity",
            "set_light_intensity",
            "double intensity",
        ],
        [
            "src/light/set-light-diffuse-color.ts",
            "setLightDiffuseColor",
            "set_light_diffuse_color",
            "Vec3d color",
        ],
    ].map(([module, name, cpp, parameter]) => {
        const { file, declaration } = context.functionDeclaration(
            module!,
            name!,
        );
        const bindings = new Map<string, PinnedBinding>([
            ["light.intensity", { cpp: "light.intensity", type: "scalar" }],
            ["intensity", { cpp: "intensity", type: "scalar" }],
        ]);
        for (const [index, component] of ["r", "g", "b"].entries()) {
            bindings.set(`light.diffuse[${index}]`, {
                cpp: `light.diffuse_color.${component}`,
                type: "scalar",
            });
            bindings.set(`color[${index}]`, {
                cpp: `color.${["x", "y", "z"][index]}`,
                type: "scalar",
            });
        }
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            bindings,
            calls: new Map([
                [
                    "Number.isFinite",
                    (args: readonly string[]) =>
                        `std::isfinite(${args.join(",")})`,
                ],
                [
                    "color.join",
                    (args: readonly string[]) =>
                        `js::number_to_string(color.x)+${args[0]}+js::number_to_string(color.y)+${args[0]}+js::number_to_string(color.z)`,
                ],
                ["light._bumpLightVersion", () => "(bump ? bump() : void())"],
            ]),
            booleanAnd: true,
            booleanOr: true,
            expression(node) {
                if (ts.isStringLiteralLike(node))
                    return `std::string{${stringLiteral(node.text)}}`;
                return undefined;
            },
            statement(node, lowerer, indent) {
                if (
                    ts.isExpressionStatement(node) &&
                    ts.isBinaryExpression(node.expression) &&
                    node.expression.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken
                ) {
                    const target = node.expression.left.getText(file);
                    if (
                        target === "light.intensity" ||
                        target.startsWith("light.diffuse[")
                    )
                        return [
                            `${indent}${lowerer.expression(node.expression.left)}=${lowerer.expression(node.expression.right)};`,
                        ];
                }
                return undefined;
            },
        });
        return `// ${context.provenance(module!, name!)}\ninline void ${cpp}(LightRecord& light, ${parameter},const std::function<void()>& bump={}) {\n${body}\n}`;
    });
    return `#pragma once\n#include <bblite/runtime.hpp>\n#include <bblite/js_data.hpp>\n#include <cmath>\nnamespace bbl {\n${functions.join("\n")}\n}\n`;
}
