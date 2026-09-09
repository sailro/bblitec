import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding, PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";

/** Source material properties projected into the native record. */
export const babylonTextureProperties = new Map<string, { field: string; type: "float" | "std::uint32_t" | "bool" }>([
    ["diffuseCoordIndex", { field: "diffuse_coord_index", type: "std::uint32_t" }],
    ["specularCoordIndex", { field: "specular_coord_index", type: "std::uint32_t" }],
    ["ambientCoordIndex", { field: "ambient_coord_index", type: "std::uint32_t" }],
    ["lightmapCoordIndex", { field: "lightmap_coord_index", type: "float" }],
    ["bumpLevel", { field: "bump_scale", type: "float" }],
    ["ambientTexLevel", { field: "ambient_level", type: "float" }],
    ["lightmapLevel", { field: "lightmap_level", type: "float" }],
    ["opacityLevel", { field: "opacity_level", type: "float" }],
    ["reflectionLevel", { field: "reflection_level", type: "float" }],
    ["reflectionCoordMode", { field: "reflection_coord_mode", type: "float" }],
    ["opacityFromRGB", { field: "opacity_from_rgb", type: "bool" }],
    ["alphaCutOff", { field: "alpha_cutoff", type: "float" }],
]);

/** Specialize the pinned slot loop over its own constant descriptors. */
export function lowerBabylonTextureSlots(context: LoweringContext): string {
    const module = "src/loader-babylon/load-babylon.ts";
    const { file, declaration } = context.functionDeclaration(module, "loadBabylon");
    const table = context.unwrapExpression(context.variableInitializer(file, "TEX_SLOTS"));
    if (!ts.isArrayLiteralExpression(table)) context.contractError(table, "Expected the Babylon texture slot table.");
    const loops = context.findNodes(declaration, (node): node is ts.ForOfStatement =>
        ts.isForOfStatement(node) && context.expressionMatchesShape(node.expression, "TEX_SLOTS"));
    const loop = loops[0];
    if (loops.length !== 1 || !loop || !ts.isBlock(loop.statement))
        context.contractError(declaration, "Expected one Babylon texture slot loop.");
    if (!ts.isVariableDeclarationList(loop.initializer) || loop.initializer.declarations.length !== 1 ||
        !ts.isIdentifier(loop.initializer.declarations[0]!.name) || loop.initializer.declarations[0]!.name.text !== "slot")
        context.contractError(loop.initializer, "Expected the Babylon slot binding.");
    const fields = new Map([
        ["diffuseTexture", "base_color_texture"], ["_bumpTexture", "bump_texture"],
        ["_specularTexture", "specular_texture"], ["_ambientTexture", "ambient_texture"],
        ["_lightmapTexture", "lightmap_texture"], ["_opacityTexture", "opacity_texture"],
        ["_reflectionTexture", "reflection_texture"],
    ]);
    const optionalProperty = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
        const property = object.properties.find(property => ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) && property.name.text === name);
        return property && ts.isPropertyAssignment(property) ? context.unwrapExpression(property.initializer) : undefined;
    };
    const string = (expression: ts.Expression): string => {
        if (!ts.isStringLiteral(expression)) context.contractError(expression, "Expected a texture slot property name.");
        return expression.text;
    };
    const write = (name: string, value: string, node: ts.Node, indent: string): string[] => {
        const property = babylonTextureProperties.get(name);
        if (!property) context.contractError(node, `Unsupported Babylon texture property '${name}'.`);
        return [`${indent}material.${property.field} = static_cast<${property.type}>(${value});`];
    };
    const lowerJson = (expression: ts.Expression, lowerer: PinnedNumericLowerer): string | undefined => {
        const node = context.unwrapExpression(expression);
        const propertyName = (value: ts.Expression): string | undefined => {
            const property = context.unwrapExpression(value);
            return ts.isPropertyAccessExpression(property) && ts.isIdentifier(property.expression) &&
                property.expression.text === "t" ? property.name.text : undefined;
        };
        const name = ts.isBinaryExpression(node) ? propertyName(node.left) : propertyName(node);
        if (name === undefined) return undefined;
        const access = `texture.at(${JSON.stringify(name)})`;
        const present = `(texture.contains(${JSON.stringify(name)}) && !${access}.is_null())`;
        if (ts.isBinaryExpression(node)) {
            if (node.right.kind === ts.SyntaxKind.NullKeyword) {
                if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken) return present;
                if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) return `!${present}`;
            }
            if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
                return `(${present} ? ${access}.get<double>() : ${lowerer.expression(node.right)})`;
            if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
                (ts.isNumericLiteral(node.right) || node.right.kind === ts.SyntaxKind.TrueKeyword || node.right.kind === ts.SyntaxKind.FalseKeyword))
                return `(${present} && ${access} == ${lowerer.expression(node.right)})`;
            return undefined;
        }
        if (["hasAlpha", "getAlphaFromRGB", "isCube"].includes(name))
            return `(${present} && ${access} != false && ${access} != 0)`;
        if (name === "name") return `${access}.get<std::string>()`;
        return `${access}.get<double>()`;
    };
    const callbacks = (arrow: ts.Expression, kind: "skipIf" | "extra"): ts.ArrowFunction => {
        if (!ts.isArrowFunction(arrow)) context.contractError(arrow, "Expected a texture slot callback.");
        const expected = kind === "skipIf" ? ["t"] : ["t", "m"];
        if (arrow.parameters.length !== expected.length || arrow.parameters.some((parameter, index) =>
            !ts.isIdentifier(parameter.name) || parameter.name.text !== expected[index]))
            context.contractError(arrow, "Unexpected texture callback parameters.");
        return arrow;
    };
    const output: string[] = [];
    for (const entry of table.elements) {
        if (!ts.isObjectLiteralExpression(entry)) context.contractError(entry, "Expected a texture slot descriptor.");
        for (const property of entry.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) ||
                !["src", "set", "level", "coordIndex", "skipIf", "extra"].includes(property.name.text))
                context.contractError(property, "Unsupported Babylon texture slot descriptor.");
        }
        const source = string(context.propertyInitializer(entry, "src"));
        const setter = context.unwrapExpression(context.propertyInitializer(entry, "set"));
        if (!ts.isArrowFunction(setter)) context.contractError(setter, "Expected the texture setter callback.");
        let target: string;
        if (ts.isBlock(setter.body)) {
            context.assertExpressionShape(setter, "(m, tex) => { m.diffuseTexture = tex; }", "Babylon direct texture setter");
            target = "diffuseTexture";
        } else {
            const imports = context.findNodes(setter, (node): node is ts.CallExpression =>
                ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword);
            const calls = context.findNodes(setter, (node): node is ts.CallExpression =>
                ts.isCallExpression(node) && ts.isIdentifier(node.expression));
            const imported = imports[0], called = calls[0];
            if (imports.length !== 1 || calls.length !== 1 || !imported || !called || !ts.isIdentifier(called.expression))
                context.contractError(setter, "Expected one imported Standard texture setter.");
            const path = string(imported.arguments[0]!);
            const name = called.expression.text;
            context.assertExpressionShape(setter,
                `(m, tex) => import(${JSON.stringify(path)}).then(({ ${name} }) => ${name}(m, tex))`, "Babylon imported texture setter");
            const definition = context.functionDeclaration(`src/${path.slice(3).replace(/\.js$/, ".ts")}`, name).declaration;
            const statements = definition.body!.statements;
            const assignment = statements[0];
            if (!assignment || !ts.isExpressionStatement(assignment) || !ts.isBinaryExpression(assignment.expression) ||
                !ts.isPropertyAccessExpression(assignment.expression.left))
                context.contractError(definition, "Expected the Standard texture field assignment.");
            target = assignment.expression.left.name.text;
            context.assertExpressionShape(assignment.expression, `mat.${target} = texture`, "Standard texture projection");
            if (statements.length !== 2 || !context.hasCall(statements[1]!, "_registerStdExt"))
                context.contractError(definition, "Expected only texture assignment and extension registration.");
        }
        const nativeField = fields.get(target);
        if (!nativeField) context.contractError(setter, `Unsupported Babylon texture field '${target}'.`);
        const level = optionalProperty(entry, "level"), coord = optionalProperty(entry, "coordIndex");
        if (coord && !ts.isObjectLiteralExpression(coord)) context.contractError(coord, "Expected a coordinate selector.");
        const destination = coord ? string(context.propertyInitializer(coord, "dst")) : undefined;
        const onlyOne = coord ? optionalProperty(coord, "only1") : undefined;
        if (onlyOne && onlyOne.kind !== ts.SyntaxKind.TrueKeyword && onlyOne.kind !== ts.SyntaxKind.FalseKeyword)
            context.contractError(onlyOne, "Expected a boolean coordinate selector.");
        const skip = optionalProperty(entry, "skipIf"), extra = optionalProperty(entry, "extra");
        const bindings = new Map<string, PinnedBinding>([
            ["slot.level", { cpp: String(!!level), type: "bool", staticBoolean: !!level }],
            ["slot.coordIndex", { cpp: String(!!coord), type: "bool", staticBoolean: !!coord }],
            ["slot.coordIndex.only1", { cpp: String(onlyOne?.kind === ts.SyntaxKind.TrueKeyword), type: "bool", staticBoolean: onlyOne?.kind === ts.SyntaxKind.TrueKeyword }],
            ["t", { cpp: "texture", type: "opaque", absentCpp: "texture.is_null()" }],
        ]);
        const body = lowerPinnedBody(file, loop.statement.statements, {
            bindings, calls: new Map(),
            expression(node, lowerer) {
                if (context.expressionMatchesShape(node, "slot.skipIf?.(t)")) {
                    if (!skip) return "false";
                    const arrow = callbacks(skip, "skipIf");
                    const statements = ts.isBlock(arrow.body) ? arrow.body.statements : [ts.factory.createReturnStatement(arrow.body)];
                    return `([&]() {\n${lowerPinnedBody(file, statements, { bindings: new Map(), calls: new Map(), expression: lowerJson,
                        returnValue: (value, inner) => inner.expression(value!) })}\n}())`;
                }
                return lowerJson(node, lowerer);
            },
            statement(statement, lowerer, indent) {
                if (ts.isVariableStatement(statement)) {
                    const variable = statement.declarationList.declarations[0];
                    if (statement.declarationList.declarations.length === 1 && variable && ts.isIdentifier(variable.name)) {
                        if (variable.name.text === "t" && variable.initializer && context.expressionMatchesShape(variable.initializer, "md[slot.src]"))
                            return [`${indent}const auto texture = source.value(${JSON.stringify(source)}, Json{});`];
                        if (variable.name.text === "texUrl" && variable.initializer) {
                            context.assertExpressionShape(variable.initializer, "baseUrl + t.name", "Babylon texture URL join");
                            return [`${indent}const std::string tex_url = pal::join_path(base_path, ${lowerer.expression((context.unwrapExpression(variable.initializer) as ts.BinaryExpression).right)});`];
                        }
                    }
                }
                if (!ts.isExpressionStatement(statement)) return undefined;
                const expression = context.unwrapExpression(statement.expression);
                if (context.expressionMatchesShape(expression, "slot.extra?.(t, mat)")) {
                    if (!extra) return [];
                    const arrow = callbacks(extra, "extra");
                    if (!ts.isBlock(arrow.body)) context.contractError(arrow, "Expected texture side-effect statements.");
                    return lowerPinnedBody(file, arrow.body.statements, {
                        bindings: new Map(), calls: new Map(), expression: lowerJson,
                        statement(statement, inner, spacing) {
                            if (!ts.isExpressionStatement(statement)) return undefined;
                            const assignment = context.unwrapExpression(statement.expression);
                            if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
                                !ts.isPropertyAccessExpression(assignment.left) || !ts.isIdentifier(assignment.left.expression) ||
                                assignment.left.expression.text !== "m") return undefined;
                            if (assignment.left.name.text === "uvScale") {
                                const array = context.unwrapExpression(assignment.right);
                                if (!ts.isArrayLiteralExpression(array) || array.elements.length !== 2)
                                    context.contractError(array, "Expected two texture scale channels.");
                                return array.elements.map((element, index) => `${spacing}material.diffuse_${index === 0 ? "u" : "v"}_scale = static_cast<float>(${inner.expression(element)});`);
                            }
                            return write(assignment.left.name.text, inner.expression(assignment.right), assignment.left, spacing);
                        },
                    }, indent).split("\n");
                }
                if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                    const left = context.unwrapExpression(expression.left);
                    if (ts.isElementAccessExpression(left) && context.expressionMatchesShape(left.expression, "mat")) {
                        const name = context.expressionMatchesShape(left.argumentExpression, "slot.level") ? level && string(level)
                            : context.expressionMatchesShape(left.argumentExpression, "slot.coordIndex.dst") ? destination : undefined;
                        if (!name) context.contractError(left, "Unknown texture slot assignment.");
                        return write(name, lowerer.expression(expression.right), left, indent);
                    }
                }
                if (context.expressionMatchesShape(expression, "texturePromises.push(loadTexture2D(engine, texUrl).then((tex) => slot.set(mat, tex)))"))
                    return [`${indent}const auto loaded_texture = load_texture(${JSON.stringify(source)}, tex_url);`,
                        `${indent}material.${nativeField} = loaded_texture.data;`,
                        ...(target === "diffuseTexture" ? [`${indent}material.source_albedo_texture = loaded_texture;`] : [])];
                return undefined;
            },
        }, "        ");
        output.push(`    do {\n${body}\n    } while (false);`);
    }
    const guard = loop.parent.parent;
    if (!ts.isIfStatement(guard) || !ts.isBlock(guard.thenStatement) || guard.thenStatement.statements.length !== 1)
        context.contractError(loop, "Expected the texture-loading guard around the slot loop.");
    const body = lowerPinnedBody(file, [guard], {
        bindings: new Map([["opts.loadTextures", { cpp: "load_textures", type: "bool" }]]), calls: new Map(),
        statement(statement, _lowerer, indent) {
            if (statement !== loop) return undefined;
            return output.join("\n").split("\n").map(line => indent.slice(4) + line);
        },
    });
    return `// ${context.provenance(module, "loadBabylon")}\ntemplate <typename LoadTexture>\nvoid apply_babylon_texture_slots(MaterialRecord& material, const Json& source, const std::string& base_path, LoadTexture&& load_texture, bool load_textures = true) {\n${body}\n}`;
}
