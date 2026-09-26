import ts from "typescript";
import { type LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

/** Scalar writes use the numeric arm of the pin's actual input accessor. */
export function lowerNodeInputScalarSetter(context: LoweringContext): string {
    const path = "src/material/node/node-material.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "parseNodeMaterialFromSnippet",
    );
    const setters: ts.SetAccessorDeclaration[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isSetAccessorDeclaration(node) &&
            node.name.getText(file) === "value"
        )
            setters.push(node);
        ts.forEachChild(node, visit);
    };
    visit(declaration);
    const setter = setters[0];
    if (setters.length !== 1 || !setter?.body)
        return context.contractError(
            declaration,
            "Expected one numeric node input value setter.",
        );
    const body = lowerPinnedBody(file, setter.body.statements, {
        bindings: new Map<string, PinnedBinding>([
            ["v", { cpp: "value", type: "scalar" }],
            ["slot._values", { cpp: "input->values", type: "f32" }],
        ]),
        calls: new Map([["setDirty", () => "input->uniforms->mark_dirty()"]]),
    });
    return `// ${context.provenance(path, "parseNodeMaterialFromSnippet")}
double set_node_input_scalar(const NodeInputHandle& input, double value) {
    if (!input || input->values.empty())
        throw std::runtime_error("Numeric node input writes require a retained uniform slot.");
${body}
    return value;
}`;
}
