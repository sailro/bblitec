import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { type PinnedBinding, recordLiteralCpp } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

/** The complete pinned camera parser, with JSON reads and engine handles as native carriers. */
export function lowerBabylonCamera(context: LoweringContext): string {
    const module = "src/loader-babylon/parse-camera.ts";
    const symbol = "parseBabylonCamera";
    const { file, declaration } = context.functionDeclaration(module, symbol);
    const parameter = declaration.parameters[0]?.name;
    if (declaration.parameters.length !== 1 || !parameter || !ts.isIdentifier(parameter) || !declaration.body) {
        context.contractError(declaration, "Expected one Babylon camera data parameter and a body.");
    }
    const root = parameter.text;
    const bindings = new Map<string, PinnedBinding>([
        [`${root}.position`, { cpp: 'cd.at("position")', type: "f64-buffer" }],
    ]);
    const members = new Map([
        ["fov", "fov"], ["minZ", "near_plane"], ["maxZ", "far_plane"],
    ]);
    for (const key of members.keys()) {
        bindings.set(`${root}.${key}`, { cpp: `cd.at("${key}").get<double>()`, type: "scalar" });
    }
    const calls = pinnedNumericMathCalls();
    calls.set("createFreeCamera", args => {
        if (args.length !== 2) context.contractError(declaration, "Expected a FreeCamera position and target.");
        return `create_free_camera(engine, ${args.join(", ")})`;
    });
    const body = lowerPinnedBody(file, declaration.body.statements, {
        bindings, calls, recordLiteral: recordLiteralCpp,
        statement(statement, lowerer, indent) {
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
            const local = statement.declarationList.declarations[0]!;
            const initializer = local.initializer && context.unwrapExpression(local.initializer);
            if (!initializer || !ts.isCallExpression(initializer) ||
                !ts.isIdentifier(initializer.expression) || initializer.expression.text !== "createFreeCamera") return undefined;
            if (!ts.isIdentifier(local.name)) context.contractError(local, "A camera handle requires an identifier binding.");
            const name = local.name.text;
            bindings.set(name, { cpp: name, type: "opaque" });
            for (const [source, target] of [["fov", "fov"], ["nearPlane", "near_plane"], ["farPlane", "far_plane"]]) {
                bindings.set(`${name}.${source}`, { cpp: `handle_at(engine.cameras, ${name}).${target}`, type: "scalar" });
            }
            return [`${indent}CameraHandle ${name} = ${lowerer.expression(initializer)};`];
        },
        expression(expression, lowerer) {
            if (!ts.isBinaryExpression(expression)) return undefined;
            const left = context.unwrapExpression(expression.left);
            if (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
                ts.isElementAccessExpression(left) && left.questionDotToken &&
                ts.isPropertyAccessExpression(left.expression) &&
                ts.isIdentifier(left.expression.expression) && left.expression.expression.text === root &&
                left.expression.name.text === "rotation") {
                return `double_at(cd, "rotation", static_cast<std::size_t>(${lowerer.expression(left.argumentExpression)}), ${lowerer.expression(expression.right)})`;
            }
            if (expression.right.kind === ts.SyntaxKind.NullKeyword &&
                ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) &&
                left.expression.text === root && members.has(left.name.text)) {
                const key = left.name.text;
                const present = `(cd.contains("${key}") && !cd.at("${key}").is_null())`;
                if (expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken) return present;
                if (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) return `!${present}`;
            }
            return undefined;
        },
        returnValue(expression, lowerer) {
            if (!expression) context.contractError(declaration, "A camera parser must return its camera handle.");
            return lowerer.expression(expression);
        },
    });
    return `// ${context.provenance(module, symbol)}\nCameraHandle parse_babylon_camera(Engine& engine, const Json& cd) {\n${body}\n}`;
}
