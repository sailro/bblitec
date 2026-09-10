import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { babylonTextureProperties } from "./babylon-textures.js";
import {materialGroupIdentity} from "./material-group-identity.js";

/** Material property guards and assignments come from the pinned loader. */
export function lowerBabylonMaterialProperties(context: LoweringContext): string {
    const module = "src/loader-babylon/load-babylon.ts";
    const { file, declaration } = context.functionDeclaration(module, "loadBabylon");
    const loops = context.findNodes(declaration, (node): node is ts.ForOfStatement =>
        ts.isForOfStatement(node) && context.findNodes(node, (child): child is ts.CallExpression =>
            ts.isCallExpression(child) && context.expressionMatchesShape(child.expression, "materialMap.set")).length > 0);
    const loop = loops[0];
    if (loops.length !== 1 || !loop || !ts.isBlock(loop.statement) ||
        !ts.isVariableDeclarationList(loop.initializer) || loop.initializer.declarations.length !== 1 ||
        !ts.isIdentifier(loop.initializer.declarations[0]!.name)) {
        context.contractError(declaration, "Expected one Babylon material construction loop.");
    }
    const row = loop.initializer.declarations[0]!.name.text;
    const statements = loop.statement.statements;
    const first = statements[0];
    if (!first || !ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1) {
        context.contractError(loop, "Expected the material factory before its property assignments.");
    }
    const created = first.declarationList.declarations[0]!;
    if (!ts.isIdentifier(created.name) || !created.initializer ||
        !context.expressionMatchesShape(created.initializer, "createStandardMaterial()")) {
        context.contractError(first, "Expected the Standard material factory.");
    }
    const material = created.name.text;
    const textures = statements.findIndex(statement => context.hasCall(statement, "loadTexture2D"));
    if (textures < 1) context.contractError(loop, "Expected texture loading after material properties.");
    const colors = new Map([
        ["diffuseColor", "source_diffuse_color"], ["specularColor", "specular_color"],
        ["emissiveColor", "emissive_factor"], ["ambientColor", "ambient_color"],
    ]);
    const scalars = new Map([
        ["specularPower", "specular_power"], ["alpha", "alpha"], ["alphaCutOff", "alpha_cutoff"],
    ]);
    const factory = context.functionDeclaration("src/material/standard/create-standard-material.ts", "createStandardMaterial");
    const defaults = context.returnObject(factory.declaration);
    const initializers = [...colors].map(([name, field]) => {
        const lanes = context.numericTuple(context.propertyInitializer(defaults, name), factory.file);
        return name === "diffuseColor"
            ? `    material.${field} = std::make_shared<std::vector<double>>(std::initializer_list<double>{${lanes.map(value => context.doubleLiteral(value)).join(", ")}});`
            : `    material.${field} = ${context.cppColor3(lanes)};`;
    });
    initializers.unshift(`    material.source_group_builder = ${materialGroupIdentity(context, "standard")};`);
    for (const [name, field] of scalars) {
        initializers.push(`    material.${field} = ${context.floatLiteral(context.numericValue(context.propertyInitializer(defaults, name), factory.file))};`);
    }
    const culling = context.propertyInitializer(defaults, "backFaceCulling");
    if (culling.kind !== ts.SyntaxKind.TrueKeyword && culling.kind !== ts.SyntaxKind.FalseKeyword)
        context.contractError(culling, "Standard material culling default must be boolean.");
    initializers.push(`    material.double_sided = ${culling.kind === ts.SyntaxKind.FalseKeyword};`);
    for (const [name, property] of babylonTextureProperties) {
        const value = context.propertyInitializer(defaults, name);
        if (property.type === "bool" && value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword)
            context.contractError(value, "Expected a boolean Standard texture default.");
        const literal = property.type === "bool" ? String(value.kind === ts.SyntaxKind.TrueKeyword)
            : context.doubleLiteral(context.numericValue(value, factory.file));
        initializers.push(`    material.${property.field} = static_cast<${property.type}>(${literal});`);
    }
    const scale = context.unwrapExpression(context.propertyInitializer(defaults, "uvScale"));
    if (!ts.isArrayLiteralExpression(scale) || scale.elements.length !== 2)
        context.contractError(scale, "Expected two Standard texture scale defaults.");
    scale.elements.forEach((value, index) => initializers.push(
        `    material.diffuse_${index === 0 ? "u" : "v"}_scale = ${context.floatLiteral(context.numericValue(value, factory.file))};`));
    const arrays = new Set(["diffuse", "specular", "emissive", "ambient"]);
    const bindings = new Map<string, PinnedBinding>();
    for (const name of arrays) bindings.set(`${row}.${name}`, { cpp: `source.at("${name}")`, type: "f64-buffer" });
    bindings.set("sceneAmbient", { cpp: "scene_ambient", type: "opaque" });
    const body = lowerPinnedBody(file, statements.slice(1, textures), {
        bindings, calls: new Map(),
        expression(expression, lowerer) {
            const unwrapped = context.unwrapExpression(expression);
            if (ts.isElementAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "sceneAmbient") {
                return `scene_ambient[static_cast<std::size_t>(${lowerer.expression(unwrapped.argumentExpression)})]`;
            }
            if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.expression) && unwrapped.expression.text === row) {
                const name = unwrapped.name.text;
                if (arrays.has(name)) return `(source.contains("${name}") && !source.at("${name}").is_null())`;
                if ([...scalars.keys()].includes(name)) return `source.at("${name}").get<double>()`;
            }
            if (!ts.isBinaryExpression(unwrapped)) return undefined;
            const left = context.unwrapExpression(unwrapped.left);
            if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.expression) || left.expression.text !== row) return undefined;
            const name = left.name.text;
            if (unwrapped.right.kind === ts.SyntaxKind.NullKeyword) {
                const present = `(source.contains("${name}") && !source.at("${name}").is_null())`;
                if (unwrapped.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken) return present;
                if (unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) return `!${present}`;
            }
            if (name === "backFaceCulling" && unwrapped.right.kind === ts.SyntaxKind.FalseKeyword &&
                unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
                return `(source.contains("${name}") && source.at("${name}") == false)`;
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (!ts.isExpressionStatement(statement)) return undefined;
            const assignment = context.unwrapExpression(statement.expression);
            if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
            const target = context.unwrapExpression(assignment.left);
            if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.expression) || target.expression.text !== material) return undefined;
            const name = target.name.text;
            const color = colors.get(name);
            if (color) {
                const value = context.unwrapExpression(assignment.right);
                if (!ts.isArrayLiteralExpression(value) || value.elements.length !== 3) {
                    context.contractError(value, "A material RGB assignment requires three channels.");
                }
                const lanes = value.elements.map(element => lowerer.expression(element));
                return [name === "diffuseColor"
                    ? `${indent}material.${color} = std::make_shared<std::vector<double>>(std::initializer_list<double>{${lanes.join(", ")}});`
                    : `${indent}material.${color} = Color3{${lanes.map(lane => `static_cast<float>(${lane})`).join(", ")}};`];
            }
            const scalar = scalars.get(name);
            if (scalar) return [`${indent}material.${scalar} = static_cast<float>(${lowerer.expression(assignment.right)});`];
            if (name === "backFaceCulling") return [`${indent}material.double_sided = !(${lowerer.expression(assignment.right)});`];
            context.contractError(target, `Unsupported Babylon material property '${name}'.`);
        },
    });
    return `// ${context.provenance(module, "loadBabylon")}\nvoid apply_babylon_material_properties(MaterialRecord& material, const Json& source, const std::array<double, 3>& scene_ambient) {\n${initializers.join("\n")}\n${body}\n}`;
}
