import ts from "typescript";
import type {LoweringContext} from "./context.js";
import {lowerPinnedBody} from "./pinned-body-lowerer.js";
import type {PinnedBinding} from "./pinned-numeric-lowerer.js";

/** Native shaders precompose the linear-capable variants; no runtime feature cache exists. */
export function lowerPbrTransmissionTransaction(context: LoweringContext): string {
    const module = "src/frame-graph/transmission.ts";
    const {file, declaration} = context.functionDeclaration(module, "_t");
    const mark = context.functionDeclaration(module, "markPbrMaterialsLinear");
    context.assertStatementShapes(mark.declaration, mark.declaration.body!.statements,
        `for (const mesh of scene.meshes) {
            const mat = mesh.material as { _linearImageProcessing?: boolean; _renderFeatures?: unknown } | undefined;
            if (mat) { mat._linearImageProcessing = true; mat._renderFeatures = undefined; }
        }`, "Precomposed linear material/cache specialization");
    const states = context.variableInitializer(declaration, "states");
    context.assertExpressionShape(states, `scene.meshes.flatMap((mesh) => {
        const mat = mesh.material as { _linearImageProcessing?: boolean; _renderFeatures?: unknown } | null;
        return mat ? [[mat, mat._linearImageProcessing, mat._renderFeatures] as const] : [];
    })`, "Precomposed transmission material snapshot");
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map(), calls: new Map(),
        statement(statement) {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1 &&
                statement.declarationList.declarations[0]!.initializer === states) return [];
            if (ts.isExpressionStatement(statement)) {
                context.assertExpressionShape(statement.expression, "markPbrMaterialsLinear(scene)", "Precomposed linear transmission flags");
                return [];
            }
            return undefined;
        },
        returnValue(expression) {
            if (!expression || !ts.isArrayLiteralExpression(expression) || expression.elements.length !== 2)
                context.contractError(declaration, "Expected transmission commit and rollback callbacks.");
            const callbacks = expression.elements.map(callback => {
                if (!ts.isArrowFunction(callback) || callback.parameters.length)
                    context.contractError(callback, "Expected a closed transmission callback.");
                if (!ts.isBlock(callback.body)) {
                    context.assertExpressionShape(callback.body, "enableSceneTransmissionTasks(scene, engine)", "Transmission task commit");
                    return `js::Callback<void()>{[owner = std::weak_ptr<SceneState>(scene.state)] {
                        if (const auto state = owner.lock()) { auto target = Scene::from_state(state); enable_scene_transmission(target); }
                    }}`;
                }
                context.assertStatementShapes(callback, callback.body.statements,
                    `for (const [mat, linear, features] of states) {
                        mat._linearImageProcessing = linear; mat._renderFeatures = features;
                    }`, "Precomposed transmission cache rollback");
                return "js::Callback<void()>{[] {}}";
            });
            return `PbrTransmissionTransaction{${callbacks.join(", ")}}`;
        },
    });
    return `// ${context.provenance(module, "_t")}
PbrTransmissionTransaction make_pbr_transmission_transaction(Scene& scene) {
${body}
}
${lowerRebuildTransaction(context)}`;
}

/** Source commit/rollback order around the synchronous native group build boundary. */
function lowerRebuildTransaction(context: LoweringContext): string {
    const module = "src/scene/scene-rebuild.ts", file = context.sourceFile(module);
    const installs = context.findNodes(file, (node): node is ts.BinaryExpression => ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken && context.expressionMatchesShape(node.left, "ctx._p"));
    const install = installs[0];
    if (installs.length !== 1 || !install || !ts.isExpressionStatement(install.parent) || !ts.isBlock(install.parent.parent))
        context.contractError(file, "Expected one group-build transmission transaction receiver.");
    const statements = install.parent.parent.statements;
    const index = statements.indexOf(install.parent), attempt = statements[index + 1];
    if (!attempt || !ts.isTryStatement(attempt) || !attempt.catchClause || !attempt.finallyBlock)
        context.contractError(install, "Expected group-build transaction recovery.");
    const cancelled = statements[index + 2], commit = statements[index + 3];
    if (!cancelled || !ts.isIfStatement(cancelled) || !ts.isBlock(cancelled.thenStatement) || !commit)
        context.contractError(install, "Expected group-build transaction publication.");
    const receiver = context.unwrapExpression(install.right);
    if (!ts.isArrowFunction(receiver) || receiver.parameters.length !== 1 || receiver.parameters[0]!.name.getText(file) !== "value" || !ts.isBlock(receiver.body))
        context.contractError(install, "Expected a transmission transaction capture.");
    const bindings = new Map<string, PinnedBinding>([
        ["transmission", {cpp: "transmission", type: "opaque", absentCpp: "!transmission"}],
        ["value", {cpp: "value", type: "opaque"}],
        ["ctx._z", {cpp: "scene.disposed", type: "bool"}],
        ["runtime?._d()", {cpp: "false", type: "bool", staticallyAbsent: true}],
    ]);
    const scope = {
        bindings, calls: new Map(), booleanOr: true,
        statement(statement: ts.Statement, numeric: import("./pinned-numeric-lowerer.js").PinnedNumericLowerer, indent: string) {
            if (ts.isReturnStatement(statement) && !statement.expression) return [`${indent}return std::nullopt;`];
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = context.unwrapExpression(statement.expression);
            if (ts.isDeleteExpression(expression)) {
                context.assertExpressionShape(expression, "delete ctx._p", "Transmission receiver teardown");
                return [`${indent}scene.state->pbr_transmission_transaction = {};`];
            }
            if (ts.isCallExpression(expression) && ts.isElementAccessExpression(expression.expression)) {
                const member = expression.expression;
                if (!member.questionDotToken || !context.expressionMatchesShape(member.expression, "transmission") || expression.arguments.length)
                    context.contractError(expression, "Expected an optional transmission callback.");
                return [`${indent}if (transmission) (*transmission).at(static_cast<std::size_t>(${numeric.expression(member.argumentExpression)}))();`];
            }
            if (ts.isBinaryExpression(expression) && context.expressionMatchesShape(expression.left, "result")) {
                context.assertExpressionShape(expression.right, "await builder(ctx, groupMeshes)", "Native material group build boundary");
                return [`${indent}result = builder(scene, meshes);`];
            }
            return undefined;
        },
        returnValue: (expression: ts.Expression | undefined, numeric: import("./pinned-numeric-lowerer.js").PinnedNumericLowerer) =>
            expression ? numeric.expression(expression) : "std::nullopt",
    };
    const capture = lowerPinnedBody(file, receiver.body.statements, scope, "            ");
    const rollback = attempt.catchClause.block.statements[0];
    if (!rollback) context.contractError(attempt, "Expected transmission rollback before GPU cleanup.");
    const cancelledRollback = cancelled.thenStatement.statements[0];
    const cancelledReturn = cancelled.thenStatement.statements.at(-1);
    if (!cancelledRollback || !cancelledReturn || !ts.isReturnStatement(cancelledReturn))
        context.contractError(cancelled, "Expected cancelled transmission build rollback and return.");
    const cancelledProjection = ts.factory.updateIfStatement(cancelled, cancelled.expression,
        ts.factory.updateBlock(cancelled.thenStatement, [cancelledRollback, cancelledReturn]), undefined);
    return `// ${context.provenance(module, "rebuildSceneGroups")}
std::optional<bool> run_pbr_rebuild_transaction_impl(Scene& scene, const std::vector<MeshHandle>& meshes,
    bool (*builder)(Scene&, const std::vector<MeshHandle>&)) {
    std::optional<PbrTransmissionTransaction> transmission;
    bool result = false;
    {
        struct ReceiverTeardown {
            Scene& scene;
            ~ReceiverTeardown() {
${lowerPinnedBody(file, attempt.finallyBlock.statements, scope, "                ")}
            }
        } teardown{scene};
        scene.state->pbr_transmission_transaction = [&transmission](PbrTransmissionTransaction value) {
${capture}
        };
        try {
${lowerPinnedBody(file, attempt.tryBlock.statements, scope, "            ")}
        } catch (...) {
${lowerPinnedBody(file, [rollback], scope, "            ")}
            throw;
        }
    }
${lowerPinnedBody(file, [cancelledProjection, commit], scope)}
    return result;
}
`;
}
