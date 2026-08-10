import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

interface HemisphericDefaults {
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    groundColor: [number, number, number];
}

export class LightLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerMatrix(): LoweredSource {
        const modulePath = "src/light/light-matrix.ts";
        const symbolName = "localMatrixFromDirection";
        const { file, declaration } = this.context.functionDeclaration(modulePath, symbolName);
        const body = declaration.body!.statements
            .flatMap((statement) => this.emitStatement(statement, file))
            .join("\n");
        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <array>

namespace bbl::upstream {

std::array<float, 16>& local_matrix_from_direction(
    float dx,
    float dy,
    float dz,
    float px,
    float py,
    float pz,
    std::array<float, 16>& out);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/light_matrix.hpp>

#include <cmath>

namespace bbl::upstream {
namespace {

float nonzero_or(float value, float fallback) {
    return value != 0.0f ? value : fallback;
}

} // namespace

std::array<float, 16>& local_matrix_from_direction(
    float dx,
    float dy,
    float dz,
    float px,
    float py,
    float pz,
    std::array<float, 16>& out) {
${body}
}

} // namespace bbl::upstream
`,
        };
    }

    public lowerFactory(): LoweredSource {
        const modulePath = "src/light/hemispheric.ts";
        const symbolName = "createHemisphericLight";
        const defaults = this.extractHemisphericDefaults(modulePath, symbolName);
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
#include <bblite/upstream/light_matrix.hpp>

namespace bbl {

LightHandle create_hemispheric_light(Engine& engine, Vec3 direction, float intensity) {
    LightRecord light;
    light.kind = LightKind::hemispheric;
    light.direction = direction;
    light.intensity = intensity;
    light.diffuse_color = ${this.context.cppColor3(defaults.diffuseColor)};
    light.specular_color = ${this.context.cppColor3(defaults.specularColor)};
    light.ground_color = ${this.context.cppColor3(defaults.groundColor)};
    upstream::local_matrix_from_direction(
        direction.x,
        direction.y,
        direction.z,
        0.0f,
        0.0f,
        0.0f,
        light.local_matrix);
    engine.lights.push_back(light);
    return LightHandle{static_cast<std::uint32_t>(engine.lights.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerPointFactory(): LoweredSource {
        const modulePath = "src/light/point-light.ts";
        const symbolName = "createPointLight";
        const source = this.context.store.getSource(modulePath);
        for (const marker of [
            'lightType: "point" as const',
            "diffuse: [1, 1, 1]",
            "specular: [1, 1, 1]",
            "range: Number.MAX_VALUE",
        ]) {
            if (!source.includes(marker)) {
                throw new Error(`Pinned point-light factory changed: ${marker}.`);
            }
        }
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>

namespace bbl {

LightHandle create_point_light(
    Engine& engine,
    Vec3 position,
    float intensity) {
    LightRecord light;
    light.kind = LightKind::point;
    light.position = position;
    light.intensity = intensity;
    light.diffuse_color = Color3{1.0f, 1.0f, 1.0f};
    light.specular_color = Color3{1.0f, 1.0f, 1.0f};
    light.range = std::numeric_limits<float>::max();
    light.local_matrix[0] = 1.0f;
    light.local_matrix[5] = 1.0f;
    light.local_matrix[10] = 1.0f;
    light.local_matrix[12] = position.x;
    light.local_matrix[13] = position.y;
    light.local_matrix[14] = position.z;
    light.local_matrix[15] = 1.0f;
    engine.lights.push_back(light);
    return LightHandle{
        static_cast<std::uint32_t>(engine.lights.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerDirectionalFactory(): LoweredSource {
        const modulePath = "src/light/directional-light.ts";
        const symbolName = "createDirectionalLight";
        const source = this.context.store.getSource(modulePath);
        for (const marker of [
            'lightType: "directional" as const',
            "diffuse: [1, 1, 1]",
            "specular: [1, 1, 1]",
            "localMatrixFromDirection",
        ]) {
            if (!source.includes(marker)) {
                throw new Error(
                    `Pinned directional-light factory changed: ${marker}.`,
                );
            }
        }
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
#include <bblite/upstream/light_matrix.hpp>

namespace bbl {

LightHandle create_directional_light(
    Engine& engine,
    Vec3 direction,
    float intensity) {
    LightRecord light;
    light.kind = LightKind::directional;
    light.direction = direction;
    light.intensity = intensity;
    light.diffuse_color = Color3{1.0f, 1.0f, 1.0f};
    light.specular_color = Color3{1.0f, 1.0f, 1.0f};
    light.range = std::numeric_limits<float>::max();
    upstream::local_matrix_from_direction(
        direction.x,
        direction.y,
        direction.z,
        0.0f,
        0.0f,
        0.0f,
        light.local_matrix);
    engine.lights.push_back(light);
    return LightHandle{
        static_cast<std::uint32_t>(engine.lights.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    private extractHemisphericDefaults(modulePath: string, symbolName: string): HemisphericDefaults {
        const { file, declaration } = this.context.functionDeclaration(modulePath, symbolName);
        let lightObject: ts.ObjectLiteralExpression | undefined;
        const visit = (node: ts.Node): void => {
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === "light" &&
                node.initializer &&
                ts.isCallExpression(node.initializer)
            ) {
                const firstArgument = node.initializer.arguments[0];
                if (firstArgument && ts.isObjectLiteralExpression(firstArgument)) lightObject = firstArgument;
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (!lightObject) throw new Error("Upstream hemispheric light object literal was not found.");
        return {
            diffuseColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "diffuseColor"),
                file,
            ),
            specularColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "specularColor"),
                file,
            ),
            groundColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "groundColor"),
                file,
            ),
        };
    }

    private emitStatement(statement: ts.Statement, file: ts.SourceFile): string[] {
        if (ts.isVariableStatement(statement)) {
            const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
            const lines: string[] = [];
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
                    throw new Error(`Unsupported upstream declaration: ${declaration.getText(file)}.`);
                }
                if (declaration.name.text === "out4") continue;
                if (declaration.name.text === "m") {
                    lines.push("    auto& m = out;");
                    continue;
                }
                lines.push(
                    `    ${isConst ? "const " : ""}float ${declaration.name.text} = ` +
                        `${this.emitExpression(declaration.initializer, file)};`,
                );
            }
            return lines;
        }
        if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
            const expression = statement.expression;
            const operators = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.EqualsToken, "="],
                [ts.SyntaxKind.SlashEqualsToken, "/="],
                [ts.SyntaxKind.AsteriskEqualsToken, "*="],
                [ts.SyntaxKind.PlusEqualsToken, "+="],
                [ts.SyntaxKind.MinusEqualsToken, "-="],
            ]);
            const operator = operators.get(expression.operatorToken.kind);
            if (!operator) throw new Error(`Unsupported upstream assignment: ${statement.getText(file)}.`);
            return [
                `    ${this.emitExpression(expression.left, file)} ${operator} ` +
                    `${this.emitExpression(expression.right, file)};`,
            ];
        }
        if (ts.isReturnStatement(statement) && statement.expression) {
            return [`    return ${this.emitExpression(statement.expression, file)};`];
        }
        throw new Error(`Unsupported upstream statement: ${statement.getText(file)}.`);
    }

    private emitExpression(expression: ts.Expression, file: ts.SourceFile): string {
        if (
            ts.isParenthesizedExpression(expression) ||
            ts.isAsExpression(expression) ||
            ts.isTypeAssertionExpression(expression) ||
            ts.isNonNullExpression(expression)
        ) {
            return this.emitExpression(expression.expression, file);
        }
        if (ts.isNumericLiteral(expression)) return this.context.floatLiteral(Number(expression.text));
        if (ts.isIdentifier(expression)) return expression.text === "out4" ? "out" : expression.text;
        if (ts.isPrefixUnaryExpression(expression)) {
            const operator = expression.operator === ts.SyntaxKind.MinusToken ? "-" : "+";
            return `(${operator}${this.emitExpression(expression.operand, file)})`;
        }
        if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
            const index = ts.isNumericLiteral(expression.argumentExpression)
                ? expression.argumentExpression.text
                : this.emitExpression(expression.argumentExpression, file);
            return `${this.emitExpression(expression.expression, file)}[${index}]`;
        }
        if (
            ts.isCallExpression(expression) &&
            ts.isPropertyAccessExpression(expression.expression) &&
            ts.isIdentifier(expression.expression.expression) &&
            expression.expression.expression.text === "Math" &&
            expression.expression.name.text === "sqrt"
        ) {
            return `std::sqrt(${expression.arguments.map((argument) => this.emitExpression(argument, file)).join(", ")})`;
        }
        if (ts.isBinaryExpression(expression)) {
            if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                return `nonzero_or(${this.emitExpression(expression.left, file)}, ` +
                    `${this.emitExpression(expression.right, file)})`;
            }
            const operators = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.PlusToken, "+"],
                [ts.SyntaxKind.MinusToken, "-"],
                [ts.SyntaxKind.AsteriskToken, "*"],
                [ts.SyntaxKind.SlashToken, "/"],
            ]);
            const operator = operators.get(expression.operatorToken.kind);
            if (operator) {
                return `(${this.emitExpression(expression.left, file)} ${operator} ` +
                    `${this.emitExpression(expression.right, file)})`;
            }
        }
        throw new Error(`Unsupported upstream expression: ${expression.getText(file)}.`);
    }
}
