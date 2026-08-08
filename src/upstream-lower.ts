import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { UpstreamSourceStore } from "./upstream-source.js";

export interface LoweredSource {
    header: string;
    source: string;
    modulePath: string;
    symbolName: string;
}

interface HemisphericDefaults {
    direction: [number, number, number];
    intensity: number;
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    groundColor: [number, number, number];
}

function floatLiteral(value: string): string {
    return value.includes(".") || /e/i.test(value) ? `${value}f` : `${value}.0f`;
}

function emitExpression(expression: ts.Expression, file: ts.SourceFile): string {
    if (
        ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression) ||
        ts.isNonNullExpression(expression)
    ) {
        return emitExpression(expression.expression, file);
    }
    if (ts.isNumericLiteral(expression)) return floatLiteral(expression.text);
    if (ts.isIdentifier(expression)) {
        if (expression.text === "out4") return "out";
        return expression.text;
    }
    if (ts.isPrefixUnaryExpression(expression)) {
        const operator = expression.operator === ts.SyntaxKind.MinusToken ? "-" : "+";
        return `(${operator}${emitExpression(expression.operand, file)})`;
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
        const index = ts.isNumericLiteral(expression.argumentExpression)
            ? expression.argumentExpression.text
            : emitExpression(expression.argumentExpression, file);
        return `${emitExpression(expression.expression, file)}[${index}]`;
    }
    if (ts.isCallExpression(expression)) {
        if (
            ts.isPropertyAccessExpression(expression.expression) &&
            ts.isIdentifier(expression.expression.expression) &&
            expression.expression.expression.text === "Math" &&
            expression.expression.name.text === "sqrt"
        ) {
            return `std::sqrt(${expression.arguments.map((argument) => emitExpression(argument, file)).join(", ")})`;
        }
        throw new Error(`Unsupported upstream call: ${expression.getText(file)}.`);
    }
    if (ts.isBinaryExpression(expression)) {
        if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
            return `nonzero_or(${emitExpression(expression.left, file)}, ${emitExpression(expression.right, file)})`;
        }
        const operators = new Map<ts.SyntaxKind, string>([
            [ts.SyntaxKind.PlusToken, "+"],
            [ts.SyntaxKind.MinusToken, "-"],
            [ts.SyntaxKind.AsteriskToken, "*"],
            [ts.SyntaxKind.SlashToken, "/"],
        ]);
        const operator = operators.get(expression.operatorToken.kind);
        if (!operator) throw new Error(`Unsupported upstream operator: ${expression.operatorToken.getText(file)}.`);
        return `(${emitExpression(expression.left, file)} ${operator} ${emitExpression(expression.right, file)})`;
    }
    throw new Error(`Unsupported upstream expression: ${ts.SyntaxKind[expression.kind]} (${expression.getText(file)}).`);
}

function emitStatement(statement: ts.Statement, file: ts.SourceFile): string[] {
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
                `    ${isConst ? "const " : ""}float ${declaration.name.text} = ${emitExpression(declaration.initializer, file)};`,
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
            `    ${emitExpression(expression.left, file)} ${operator} ${emitExpression(expression.right, file)};`,
        ];
    }
    if (ts.isReturnStatement(statement) && statement.expression) {
        return [`    return ${emitExpression(statement.expression, file)};`];
    }
    throw new Error(`Unsupported upstream statement: ${ts.SyntaxKind[statement.kind]} (${statement.getText(file)}).`);
}

export function lowerLightMatrix(store = new UpstreamSourceStore()): LoweredSource {
    const modulePath = "src/light/light-matrix.ts";
    const symbolName = "localMatrixFromDirection";
    const source = store.getSource(modulePath);
    const file = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = file.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === symbolName && statement.body !== undefined,
    );
    if (!declaration?.body) throw new Error(`${modulePath} does not export ${symbolName}.`);
    const body = declaration.body.statements.flatMap((statement) => emitStatement(statement, file)).join("\n");
    const provenance =
        `Generated from ${store.pin.package}@${store.pin.version} ` +
        `(${store.pin.sourceVersion}) ${modulePath}#${symbolName}.`;

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
        source: `// ${provenance}
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

function unwrapExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

function numericValue(expression: ts.Expression, file: ts.SourceFile): number {
    const unwrapped = unwrapExpression(expression);
    if (ts.isNumericLiteral(unwrapped)) return Number(unwrapped.text);
    if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.MinusToken) {
        return -numericValue(unwrapped.operand, file);
    }
    throw new Error(`Expected numeric upstream constant, found ${unwrapped.getText(file)}.`);
}

function numericTuple(expression: ts.Expression, file: ts.SourceFile): [number, number, number] {
    const unwrapped = unwrapExpression(expression);
    if (!ts.isArrayLiteralExpression(unwrapped) || unwrapped.elements.length !== 3) {
        throw new Error(`Expected three-element upstream tuple, found ${unwrapped.getText(file)}.`);
    }
    return [
        numericValue(unwrapped.elements[0]!, file),
        numericValue(unwrapped.elements[1]!, file),
        numericValue(unwrapped.elements[2]!, file),
    ];
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike {
    const property = object.properties.find((candidate) => {
        if (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) {
            return ts.isIdentifier(candidate.name) && candidate.name.text === name;
        }
        return false;
    });
    if (!property) throw new Error(`Upstream hemispheric light is missing '${name}'.`);
    return property;
}

function propertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression {
    const property = objectProperty(object, name);
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
    throw new Error(`Unsupported upstream property '${name}'.`);
}

function extractHemisphericDefaults(store: UpstreamSourceStore): HemisphericDefaults {
    const modulePath = "src/light/hemispheric.ts";
    const source = store.getSource(modulePath);
    const file = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = file.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === "createHemisphericLight" &&
            statement.body !== undefined,
    );
    if (!declaration?.body) throw new Error("Upstream createHemisphericLight was not found.");
    const directionParameter = declaration.parameters[0];
    const intensityParameter = declaration.parameters[1];
    if (!directionParameter?.initializer || !intensityParameter?.initializer) {
        throw new Error("Upstream hemispheric defaults are unavailable.");
    }

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
    visit(declaration.body);
    if (!lightObject) throw new Error("Upstream hemispheric light object literal was not found.");

    return {
        direction: numericTuple(directionParameter.initializer, file),
        intensity: numericValue(intensityParameter.initializer, file),
        diffuseColor: numericTuple(propertyInitializer(lightObject, "diffuseColor"), file),
        specularColor: numericTuple(propertyInitializer(lightObject, "specularColor"), file),
        groundColor: numericTuple(propertyInitializer(lightObject, "groundColor"), file),
    };
}

function cppVec3(values: [number, number, number]): string {
    return `Color3{${values.map((value) => floatLiteral(String(value))).join(", ")}}`;
}

export function lowerHemisphericFactory(store = new UpstreamSourceStore()): LoweredSource {
    const modulePath = "src/light/hemispheric.ts";
    const symbolName = "createHemisphericLight";
    const defaults = extractHemisphericDefaults(store);
    const provenance =
        `Generated from ${store.pin.package}@${store.pin.version} ` +
        `(${store.pin.sourceVersion}) ${modulePath}#${symbolName}.`;
    return {
        modulePath,
        symbolName,
        header: "",
        source: `// ${provenance}
#include <bblite/runtime.hpp>
#include <bblite/upstream/light_matrix.hpp>

namespace bbl {

LightHandle create_hemispheric_light(Engine& engine, Vec3 direction, float intensity) {
    LightRecord light;
    light.direction = direction;
    light.intensity = intensity;
    light.diffuse_color = ${cppVec3(defaults.diffuseColor)};
    light.specular_color = ${cppVec3(defaults.specularColor)};
    light.ground_color = ${cppVec3(defaults.groundColor)};
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

export function emitUpstreamGenerated(outputRoot: string, features: string[]): void {
    if (!features.includes("light:hemispheric")) return;
    const store = new UpstreamSourceStore();
    const lowered = lowerLightMatrix(store);
    const factory = lowerHemisphericFactory(store);
    const headerPath = resolve(outputRoot, "upstream/include/bblite/upstream/light_matrix.hpp");
    const sourcePath = resolve(outputRoot, "upstream/src/light_matrix.cpp");
    const factoryPath = resolve(outputRoot, "upstream/src/light_hemispheric.cpp");
    mkdirSync(dirname(headerPath), { recursive: true });
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(headerPath, lowered.header);
    writeFileSync(sourcePath, lowered.source);
    writeFileSync(factoryPath, factory.source);
    writeFileSync(
        resolve(outputRoot, "upstream/provenance.json"),
        `${JSON.stringify(
            {
                package: store.pin,
                generated: [
                    { modulePath: lowered.modulePath, symbolName: lowered.symbolName },
                    { modulePath: factory.modulePath, symbolName: factory.symbolName },
                ],
            },
            null,
            2,
        )}\n`,
    );
}
