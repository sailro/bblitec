import ts from "typescript";
import type {LoweringContext} from "./context.js";

/** Native keys represent pinned function identity, including per-instance node closures. */
export function materialGroupIdentity(context: LoweringContext, family: "standard" | "shader" | "node"): string {
    if (family === "node") {
        const {declaration} = context.functionDeclaration("src/material/node/node-material.ts", "parseNodeMaterialFromSnippet");
        const initializer = context.variableInitializer(declaration, "_buildGroup");
        if (!ts.isArrowFunction(initializer) || initializer.parent.parent.parent.parent !== declaration.body)
            context.contractError(initializer, "Expected a fresh node material builder closure.");
        const families = declaration.body!.statements.filter(node => ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) &&
            context.expressionMatchesShape(node.expression.left, "_buildGroup._materialFamily"));
        context.assertStatementShapes(declaration, families, '_buildGroup._materialFamily = "node";', "Node builder family identity");
        context.assertExpressionShape(context.propertyInitializer(context.objectInitializer(declaration, "material"), "_buildGroup"),
            "_buildGroup", "Node material builder identity");
        return "static_cast<std::uint64_t>(engine.materials.size()) + 4";
    }
    const title = family === "standard" ? "Standard" : "Shader";
    const factoryModule = family === "standard" ? "src/material/standard/create-standard-material.ts" : "src/material/shader/shader-material.ts";
    const factory = context.functionDeclaration(factoryModule, `create${title}Material`).declaration;
    const properties = context.findNodes(factory, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) && node.name.text === "_buildGroup");
    if (properties.length !== 1) context.contractError(factory, "Expected one material group builder identity.");
    context.assertExpressionShape(properties[0]!.initializer, `get${title}GroupBuilder()`, "Material builder singleton selection");
    const getter = context.functionDeclaration(`src/material/${family}/${family}-group-builder.ts`, `get${title}GroupBuilder`).declaration;
    const statements = getter.body!.statements;
    context.assertStatementShapes(getter, [statements[0]!, ...statements.slice(-2)], `
        if (_${family}GroupBuilder) { return _${family}GroupBuilder; }
        builder._materialFamily = "${family}";
        return (_${family}GroupBuilder = builder);`, "Material builder singleton lifetime");
    return family === "standard" ? "2" : "3";
}
