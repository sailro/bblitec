import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";

/** Direct workgroup dimensions retain the pin's defaults and device-limit checks. */
export function computeDispatchDescriptorCpp(context: LoweringContext): string {
    const path = "src/compute/compute-dispatch.ts";
    const optionalSize: PinnedNumericScope["expression"] = (node, lowerer) => {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
            ts.isPropertyAccessExpression(node.left) &&
            node.left.expression.getText(node.getSourceFile()) === "size" &&
            ["y", "z"].includes(node.left.name.text)
        )
            return `${node.left.name.text}_input.value_or(${lowerer.expression(node.right)})`;
        return undefined;
    };
    const validation = context.functionDeclaration(path, "validateDimension");
    const checked = lowerPinnedBody(
        validation.file,
        validation.declaration.body!.statements,
        {
            bindings: new Map([
                ["name", { cpp: "name", type: "opaque" }],
                ["value", { cpp: "value", type: "scalar" }],
                ["max", { cpp: "maximum", type: "scalar" }],
                ["size.x", { cpp: "x", type: "scalar" }],
            ]),
            expression: optionalSize,
            calls: new Map([
                [
                    "Number.isInteger",
                    (args) => `js::number_is_integer(${args.join(", ")})`,
                ],
            ]),
            callShapes: new Map([["Number.isInteger", "bool"]]),
        },
    );
    const { file, declaration } = context.functionDeclaration(
        path,
        "setDirect",
    );
    const bindings = new Map<string, PinnedBinding>([
        [
            "Number.MAX_SAFE_INTEGER",
            { cpp: String(Number.MAX_SAFE_INTEGER), type: "scalar" },
        ],
        [
            "dispatch.shader._engine._device.limits.maxComputeWorkgroupsPerDimension",
            { cpp: "limit", type: "scalar" },
        ],
        ["size.x", { cpp: "x", type: "scalar" }],
        ...["x", "y", "z"].map(
            (name, index) =>
                [
                    `dispatch._${name}`,
                    { cpp: `result[${index}]`, type: "scalar" },
                ] as const,
        ),
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map([["Number", (args) => args.join(", ")]]),
        callShapes: new Map([["Number", "scalar"]]),
        expression: optionalSize,
        statement(node, lowerer, indent) {
            if (
                !ts.isExpressionStatement(node) ||
                !ts.isCallExpression(node.expression) ||
                node.expression.expression.getText(file) !== "validateDimension"
            )
                return undefined;
            const args = node.expression.arguments;
            if (args.length !== 4)
                return context.contractError(
                    node,
                    "Compute dimension validation arguments changed.",
                );
            context.assertExpressionShape(
                args[3]!,
                "size",
                "Compute dispatch diagnostics",
            );
            if (
                !ts.isStringLiteral(args[0]!) ||
                !["x", "y", "z"].includes(args[0].text)
            )
                return context.contractError(
                    node,
                    "Compute dimension name changed.",
                );
            return [
                `${indent}validate_compute_dimension(${stringLiteral(args[0].text)}, ${lowerer.expression(args[1]!)}, ${lowerer.expression(args[2]!)}, x, y_input, z_input);`,
            ];
        },
    });
    return `// ${context.provenance(path, "validateDimension")}
static void validate_compute_dimension(std::string_view name,double value,double maximum,double x,std::optional<double> y_input,std::optional<double> z_input) {
${checked}
}
// ${context.provenance(path, "setDirect")}
std::array<double,3> compute_dispatch_dimensions(double x,std::optional<double> y_input,std::optional<double> z_input,double limit) {
    std::array<double,3> result{};
${body}
    return result;
}
`;
}
