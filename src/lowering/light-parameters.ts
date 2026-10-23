import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { stringLiteral } from "../cpp-literals.js";
import { sameSource } from "../compiler/syntax.js";

export function lightVersionBumpBody(
    context: LoweringContext,
    target: string,
): string {
    const module = "src/light/light-base.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "createLightBase",
    );
    const { declaration: apply } = context.functionDeclaration(
        module,
        "applyLightBase",
    );
    context.expectShapeCount(
        apply,
        "node._bumpLightVersion = lvs.b",
        "Light version callback publication",
    );
    const state = context.unwrapExpression(
        context.variableInitializer(declaration, "lvs"),
    );
    if (!ts.isObjectLiteralExpression(state))
        context.contractError(state, "Expected light version state.");
    context.assertExpressionShape(
        context.propertyInitializer(state, "_lightVersion"),
        "0",
        "Initial light version",
    );
    const bump = state.properties.find(
        (node): node is ts.MethodDeclaration =>
            ts.isMethodDeclaration(node) && sameSource(node.name, "b"),
    );
    if (!bump?.body)
        context.contractError(state, "Expected light version callback.");
    return lowerPinnedBody(file, bump.body.statements, {
        bindings: new Map([
            ["lvs._lightVersion", { cpp: target, type: "scalar" }],
        ]),
        calls: new Map(),
    });
}

/** Public setters retain their source validation and no-change branches. */
export function lightParameterHeader(context: LoweringContext): string {
    const module = "src/light/light-base.ts";
    const bumpBody = lightVersionBumpBody(context, "light.parameter_version");
    const observableModule = "src/math/observable-vec3.ts";
    const { file: observableFile, declaration: observable } =
        context.classDeclaration(observableModule, "ObservableVec3");
    const components = ["position", "direction"]
        .map((vector) => {
            const scope = {
                bindings: new Map<string, PinnedBinding>([
                    ["v", { cpp: "value", type: "scalar" }],
                    ...["x", "y", "z"].map((lane): [string, PinnedBinding] => [
                        `this._${lane}`,
                        { cpp: `record.${vector}.${lane}`, type: "scalar" },
                    ]),
                ]),
                calls: new Map([
                    ["this._onDirty", () => "bump_light_version(record)"],
                ]),
            };
            const cases = ["x", "y", "z"]
                .map((lane, index) => {
                    const setter = observable.members.find(
                        (node): node is ts.SetAccessorDeclaration =>
                            ts.isSetAccessorDeclaration(node) &&
                            sameSource(node.name, lane),
                    );
                    if (!setter?.body)
                        context.contractError(
                            observable,
                            "Expected observable component setter.",
                        );
                    return `case ${index}: {\n${new PinnedNumericLowerer(observableFile, scope).statements(setter.body.statements, "    ").join("\n")}\nreturn;\n}`;
                })
                .join("\n");
            return `// ${context.provenance(observableModule, "ObservableVec3")}\ninline void set_light_${vector}_component(Engine& engine, LightHandle light, std::size_t component, float value) {\n auto& record = handle_at(engine.lights, light);\n switch(component) {\n${cases}\ndefault: throw std::out_of_range("Light vector component");\n}\n}`;
        })
        .join("\n");
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
                [
                    "light._bumpLightVersion",
                    () => "(bump ? bump() : bump_light_version(light))",
                ],
            ]),

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
    return `#pragma once\n#include <bblite/runtime.hpp>\n#include <bblite/js_data.hpp>\n#include <cmath>\nnamespace bbl {\n// ${context.provenance(module, "createLightBase")}\ninline void bump_light_version(LightRecord& light) {\n${bumpBody}\n}\ninline std::function<void()> light_version_callback(Engine& engine, LightHandle light) {\n    return [&engine, light]() { bump_light_version(handle_at(engine.lights, light)); };\n}\n${components}\n${functions.join("\n")}\n}\n`;
}
