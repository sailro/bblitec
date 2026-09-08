import ts from "typescript";
import { PinnedNumericLowerer } from "../pinned-numeric-lowerer.js";
import { findNodes, refuseModule, topLevelFunction, unwrapExpression } from "./shared.js";

/** The pinned loader retains the original factor only in this conditional prop. */
export function lowerGltfMaterialColorPresence(builderFile: ts.SourceFile, propsName = "assemblePbrProps"): string {
    const symbol = builderFile.fileName;
    const defaultFactor = topLevelFunction(builderFile, "isDefaultBaseColorFactor");
    const defaultReturn = defaultFactor.body.statements[0];
    const props = topLevelFunction(builderFile, propsName);
    const factorSpreads = findNodes(props.body, (node): node is ts.SpreadAssignment => {
        if (!ts.isSpreadAssignment(node)) return false;
        const expression = unwrapExpression(node.expression);
        if (!ts.isConditionalExpression(expression)) return false;
        const present = unwrapExpression(expression.whenTrue);
        return ts.isObjectLiteralExpression(present) && present.properties.some(property =>
            ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "baseColorFactor");
    });
    if (defaultFactor.body.statements.length !== 1 || !defaultReturn ||
        !ts.isReturnStatement(defaultReturn) || !defaultReturn.expression || factorSpreads.length !== 1) {
        refuseModule(symbol, "no longer conditionally retains one public baseColorFactor array");
    }
    const factorSpread = unwrapExpression(factorSpreads[0]!.expression) as ts.ConditionalExpression;
    const factorFields = unwrapExpression(factorSpread.whenTrue) as ts.ObjectLiteralExpression;
    const factorField = factorFields.properties[0];
    if (factorFields.properties.length !== 1 || !factorField || !ts.isPropertyAssignment(factorField) ||
        factorField.initializer.getText(builderFile) !== "mat._baseColorFactor" ||
        factorSpread.whenFalse.getText(builderFile) !== "undefined") {
        refuseModule(symbol, "no longer retains the original factor array in its present arm");
    }
    const factorDefault = new PinnedNumericLowerer(builderFile, {booleanAnd: true, bindings: new Map([
        ["f", {cpp: "factor", type: "f64-buffer"}],
    ]), calls: new Map()}).expression(defaultReturn.expression);
    const factorPresence = new PinnedNumericLowerer(builderFile, {booleanAnd: true, bindings: new Map([
        ["mat._baseColorImage", {cpp: "has_image", type: "bool"}],
        ["mat._baseColorFactor", {cpp: "factor", type: "f64-buffer"}],
    ]), calls: new Map([["isDefaultBaseColorFactor", args => `gltf_default_base_color_factor(${args.join(", ")})`]])})
        .expression(factorSpread.condition);
    return [
        "bool gltf_default_base_color_factor(const std::vector<double>& factor) {",
        `    return ${factorDefault};`,
        "}",
        "bool gltf_has_base_color_factor(bool has_image, const std::vector<double>& factor) {",
        `    return ${factorPresence};`,
        "}",
        "",
    ].join("\n");
}
