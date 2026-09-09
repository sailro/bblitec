import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody, type PinnedBodyScope } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

export function lowerBabylonSceneData(context: LoweringContext, lightMeshLists: boolean): string {
    const module = "src/loader-babylon/load-babylon.ts";
    const { file, declaration } = context.functionDeclaration(module, "loadBabylon");
    const scope = (): PinnedBodyScope => {
        const bindings = new Map<string, PinnedBinding>([
            ["opts.loadCamera", { cpp: "load_camera", type: "bool" }],
            ["data.activeCameraID", { cpp: 'string_or(document, "activeCameraID")', type: "opaque", absentCpp: 'string_or(document, "activeCameraID").empty()' }],
            ["camData", { cpp: "camData", type: "opaque", absentCpp: "camData == nullptr" }],
            ["ld.type", { cpp: 'ld.value("type", Json{})', type: "opaque" }],
            ["pl", { cpp: "pl", type: "opaque" }],
        ]);
        for (const [root, cpp, fields] of [
            ["data", "document", ["clearColor", "ambientColor", "cameras", "lights"]],
            ["ld", "ld", ["position", "diffuse", "specular", "intensity", "range"]],
        ] as const) for (const field of fields) {
            bindings.set(`${root}.${field}`, { cpp: `${cpp}.at(${JSON.stringify(field)})`, type: "opaque",
                absentCpp: `!babylon_json_truthy(${cpp}, ${JSON.stringify(field)})` });
            bindings.set(`${root}.${field}?.length`, { cpp: `babylon_json_length(${cpp}, ${JSON.stringify(field)})`, type: "scalar" });
        }
        return {
            bindings, calls: new Map([["createPointLight", args => {
                if (args.length !== 2) context.contractError(declaration, "Expected the point-light position and intensity.");
                return `create_point_light(engine, babylon_vec3(${args[0]}), static_cast<float>(${args[1]}))`;
            }]]), booleanAnd: true,
            forOf(iterated, element) {
                if (iterated !== "data.lights") return undefined;
                return { range: 'document.at("lights")', bindings: new Map([[element, { cpp: element, type: "opaque" }]]) };
            },
            expression(node, lowerer) {
                if (node.kind === ts.SyntaxKind.NullKeyword) return "nullptr";
                if (ts.isIdentifier(node) && node.text === "undefined") return "std::nullopt";
                if (ts.isArrayLiteralExpression(node)) return `std::array<double, ${node.elements.length}>{${node.elements.map(value => lowerer.expression(value)).join(", ")}}`;
                if (ts.isObjectLiteralExpression(node)) {
                    const values = new Map<string, string>();
                    for (const property of node.properties) {
                        if (!ts.isPropertyAssignment(property)) context.contractError(property, "Expected clear-color channels.");
                        const name = context.propertyName(property.name);
                        if (!name || !["r", "g", "b", "a"].includes(name)) context.contractError(property, "Unrepresented clear-color channel.");
                        values.set(name, lowerer.expression(property.initializer));
                    }
                    return `Color4{${["r", "g", "b", "a"].map(name => {
                        const value = values.get(name);
                        if (!value) context.contractError(node, `Missing clear-color channel '${name}'.`);
                        return `static_cast<float>(${value})`;
                    }).join(", ")}}`;
                }
                if (ts.isConditionalExpression(node)) {
                    const condition = bindings.get(context.unwrapExpression(node.condition).getText(file));
                    if (condition?.absentCpp) return `(!(${condition.absentCpp}) ? ${lowerer.expression(node.whenTrue)} : ${lowerer.expression(node.whenFalse)})`;
                }
                if (ts.isElementAccessExpression(node)) {
                    if (context.expressionMatchesShape(node.expression, "data.cameras"))
                        return `&document.at("cameras").at(static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)}))`;
                    const binding = bindings.get(context.unwrapExpression(node.expression).getText(file));
                    if (binding) return `${binding.cpp}.at(static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)})).get<double>()`;
                }
                if (ts.isBinaryExpression(node)) {
                    const left = context.unwrapExpression(node.left), binding = bindings.get(left.getText(file));
                    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "ld" && binding) {
                        const present = `(ld.contains(${JSON.stringify(left.name.text)}) && !${binding.cpp}.is_null())`;
                        if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
                            return `(${present} ? ${binding.cpp}.get<double>() : ${lowerer.expression(node.right)})`;
                        if (node.right.kind === ts.SyntaxKind.NullKeyword) {
                            if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken) return present;
                            if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) return `!${present}`;
                        }
                    }
                    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
                        return `([&]() -> const Json* { const auto* value = ${lowerer.expression(node.left)}; return value ? value : ${lowerer.expression(node.right)}; }())`;
                }
                if (ts.isCallExpression(node)) {
                    if (context.expressionMatchesShape(node.expression, "data.cameras.find") && node.arguments.length === 1) {
                        const callback = context.unwrapExpression(node.arguments[0]!);
                        const parameter = ts.isArrowFunction(callback) && callback.parameters[0]?.name;
                        if (!ts.isArrowFunction(callback) || !parameter || !ts.isIdentifier(parameter) || ts.isBlock(callback.body))
                            context.contractError(node, "Expected a camera selection predicate.");
                        bindings.set(`${parameter.text}.id`, { cpp: `string_or(${parameter.text}, "id")`, type: "opaque" });
                        const condition = lowerer.expression(callback.body);
                        return `([&]() -> const Json* { for (const auto& ${parameter.text} : document.at("cameras")) if (${condition}) return &${parameter.text}; return nullptr; }())`;
                    }
                    const callee = context.unwrapExpression(node.expression);
                    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "parseBabylonCamera") {
                        context.assertExpressionShape(callee.expression, '(await import("./parse-camera.js"))', "Camera module boundary");
                        if (node.arguments.length !== 1) context.contractError(node, "Expected camera source data.");
                        return `std::optional<CameraHandle>{parse_babylon_camera(engine, *${lowerer.expression(node.arguments[0]!)})}`;
                    }
                }
                return undefined;
            },
            statement(statement, lowerer, indent) {
                if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                    const variable = statement.declarationList.declarations[0]!;
                    if (ts.isObjectBindingPattern(variable.name)) {
                        if (variable.initializer && context.expressionMatchesShape(variable.initializer, 'await import("../light/point-light.js")')) {
                            const imported = variable.name.elements[0];
                            if (variable.name.elements.length !== 1 || !imported || !ts.isIdentifier(imported.name) ||
                                imported.name.text !== "createPointLight" || imported.propertyName || imported.dotDotDotToken)
                                context.contractError(variable, "Expected the point-light factory import.");
                            return [];
                        }
                        if (!variable.initializer || !context.expressionMatchesShape(variable.initializer, "ld")) return undefined;
                        return variable.name.elements.map(element => {
                            if (!ts.isIdentifier(element.name)) context.contractError(element, "Expected a light mesh-ID name.");
                            const key = context.propertyName(element.propertyName ?? element.name);
                            if (!key || !["excludedMeshesIds", "includedOnlyMeshesIds"].includes(key))
                                context.contractError(element, "Unrepresented light mesh-ID binding.");
                            bindings.set(element.name.text, { cpp: `babylon_json_field(ld, ${JSON.stringify(key)})`, type: "opaque" });
                            bindings.set(`${element.name.text}?.length`, { cpp: `babylon_json_length(ld, ${JSON.stringify(key)})`, type: "scalar" });
                            return "";
                        }).filter(Boolean);
                    }
                    if (!ts.isIdentifier(variable.name)) return undefined;
                    const name = variable.name.text;
                    if (name === "clearColor" && !variable.initializer) {
                        bindings.set(name, { cpp: name, type: "opaque" });
                        return [`${indent}std::optional<Color4> clearColor;`];
                    }
                    if (variable.initializer && ["pl", "camData", "camera"].includes(name)) {
                        const type = name === "pl" ? "LightHandle" : name === "camData" ? "const Json*" : "std::optional<CameraHandle>";
                        return [`${indent}${type} ${name} = ${lowerer.expression(variable.initializer)};`];
                    }
                }
                if (!ts.isExpressionStatement(statement)) return undefined;
                const expression = context.unwrapExpression(statement.expression);
                if (ts.isCallExpression(expression) && context.expressionMatchesShape(expression.expression, "lights.push") && expression.arguments.length === 1)
                    return [`${indent}asset.lights.push_back(${lowerer.expression(expression.arguments[0]!)});`];
                if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
                    !ts.isPropertyAccessExpression(expression.left) || !context.expressionMatchesShape(expression.left.expression, "pl")) return undefined;
                const field = expression.left.name.text;
                if (field === "diffuse" || field === "specular")
                    return [`${indent}engine.lights.at(pl.value).${field}_color = babylon_color3(${lowerer.expression(expression.right)});`];
                if (field === "range") return [`${indent}engine.lights.at(pl.value).range = static_cast<float>(${lowerer.expression(expression.right)}.get<double>());`];
                if (field === "excludedMeshIds" || field === "includedOnlyMeshIds") {
                    const value = context.unwrapExpression(expression.right);
                    if (!ts.isNewExpression(value) || !context.expressionMatchesShape(value.expression, "Set") || value.arguments?.length !== 1)
                        context.contractError(value, "Expected a light mesh-ID set.");
                    return lightMeshLists ? [`${indent}engine.lights.at(pl.value).${field === "excludedMeshIds" ? "excluded_meshes" : "included_meshes"} = resolve_babylon_light_meshes(${lowerer.expression(value.arguments[0]!)}, meshes_by_id, nodes);`] : [];
                }
                return undefined;
            },
        };
    };
    const variableStatement = (name: string): ts.VariableStatement => {
        const variable = context.findNodes(declaration, (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)[0];
        const statement = variable?.parent.parent;
        if (!statement || !ts.isVariableStatement(statement)) context.contractError(declaration, `Expected scene property '${name}'.`);
        return statement;
    };
    const clear = variableStatement("clearColor");
    const clearIf = declaration.body!.statements[declaration.body!.statements.indexOf(clear) + 1];
    if (!clearIf || !ts.isIfStatement(clearIf)) context.contractError(clear, "Expected the clear-color guard.");
    const clearBody = lowerPinnedBody(file, [clear, clearIf], scope());
    const ambient = lowerPinnedBody(file, [ts.factory.createReturnStatement(context.variableInitializer(declaration, "sceneAmbient"))], {
        ...scope(), returnValue: (value, lowerer) => lowerer.expression(value!),
    });
    const lightStatement = declaration.body!.statements.find(statement => ts.isIfStatement(statement) && context.hasCall(statement, "createPointLight"));
    if (!lightStatement) context.contractError(declaration, "Expected the light construction branch.");
    const lights = lowerPinnedBody(file, [lightStatement], scope());
    const camera = lowerPinnedBody(file, [variableStatement("camData"), variableStatement("camera")], scope());
    return `// ${context.provenance(module, "loadBabylon")}
std::optional<Color4> babylon_clear_color(const Json& document) {
${clearBody}
    return clearColor;
}
std::array<double, 3> babylon_scene_ambient(const Json& document) {
${ambient}
}
void load_babylon_lights(Engine& engine, AssetRecord& asset, const Json& document${lightMeshLists ? ",\n    const std::unordered_map<std::string, std::vector<std::size_t>>& meshes_by_id, const std::vector<BabylonHierarchyNode>& nodes" : ""}) {
${lights}
}
std::optional<CameraHandle> select_babylon_camera(Engine& engine, const Json& document, bool load_camera) {
${camera}
    return camera;
}`;
}
