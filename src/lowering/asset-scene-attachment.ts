import ts from "typescript";
import type {LoweringContext} from "./context.js";
import {lowerPinnedBody} from "./pinned-body-lowerer.js";
import type {PinnedBinding} from "./pinned-numeric-lowerer.js";

/** Container field order and guards come from addToScene; records supply native storage. */
export function lowerAssetSceneAttachment(context: LoweringContext): string {
    const module = "src/scene/scene-core.ts";
    const {file, declaration} = context.functionDeclaration(module, "addToScene");
    const branch = declaration.body?.statements.find(statement => ts.isIfStatement(statement) &&
        context.expressionMatchesShape(statement.expression, '"entities" in entity'));
    if (!branch || !ts.isIfStatement(branch) || !ts.isBlock(branch.thenStatement))
        context.contractError(declaration, "Expected the source AssetContainer attachment arm.");
    const bindings = new Map<string, PinnedBinding>([
        ["entity", {cpp: "record", type: "opaque"}],
        ["result.clearColor", {cpp: "record.clear_color", type: "opaque", absentCpp: "!record.has_clear_color"}],
        ["ctx.clearColor", {cpp: "scene.clear_color", type: "opaque"}],
        ["result.camera", {cpp: "record.camera", type: "opaque", absentCpp: "!record.has_camera"}],
        ["ctx.camera", {cpp: "scene.camera", type: "opaque", absentCpp: "scene.camera.value == invalid_handle"}],
        ["result.animationGroups", {cpp: "record.animation_groups", type: "opaque"}],
        ["result.animationGroups?.length", {cpp: "record.animation_groups.size()", type: "scalar"}],
        ["result._beforeRenderHook", {cpp: "record.before_render_hook", type: "opaque"}],
        ["hook", {cpp: "hook", type: "opaque"}],
    ]);
    const body = lowerPinnedBody(file, branch.thenStatement.statements, {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        returnValue: expression => {
            if (expression) context.contractError(expression, "Expected void asset attachment.");
            return "";
        },
        statement(statement, lowerer, indent) {
            if (ts.isForOfStatement(statement) && context.expressionMatchesShape(statement.expression, "result.entities")) {
                // The glTF root/light walks already execute during packaging.
                if (!ts.isVariableDeclarationList(statement.initializer) || statement.initializer.declarations.length !== 1)
                    context.contractError(statement, "Expected one container entity binding.");
                const entity = statement.initializer.declarations[0]!;
                if (!ts.isIdentifier(entity.name) || entity.name.text !== "e" || entity.initializer)
                    context.contractError(entity, "Unrepresented container entity binding.");
                const calls = ts.isBlock(statement.statement) ? statement.statement.statements : [statement.statement];
                if (calls.length !== 1 || !ts.isExpressionStatement(calls[0]!))
                    context.contractError(statement, "Unrepresented container entity traversal.");
                context.assertExpressionShape(calls[0].expression, "addToScene(scene, e)", "Container entity attachment");
                return [`${indent}add_asset_meshes(scene, record);`,
                    `${indent}for (const LightHandle light : record.lights) add_to_scene(scene, light);`];
            }
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                const name = variable.name.text;
                if (name === "engine") {
                    context.assertExpressionShape(variable.initializer, "ctx.surface.engine", "Container animation engine");
                    return [];
                }
                if (name === "groups") {
                    context.assertExpressionShape(variable.initializer, "result.animationGroups", "Container animation groups");
                    bindings.set(name, {cpp: "groups", type: "opaque"});
                    return [`${indent}const auto& groups = record.animation_groups;`];
                }
                if (name === "hook") {
                    // The per-asset playback adapter still owns ticking (LW-1/L12).
                    // Refuse source changes inside that boundary until its per-group
                    // controller is lowered; surrounding publication/order is live.
                    context.assertExpressionShape(variable.initializer,
                        "(deltaMs: number): void => { for (const g of groups) { tickAnimation(g, deltaMs, engine); } }",
                        "Unrepresented change to the asset animation tick adapter");
                    return [`${indent}js::Callback<void(float)> hook = [tick = record.animation_tick](float delta_ms) { if (tick) tick(delta_ms); };`];
                }
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = context.unwrapExpression(statement.expression);
            if (!ts.isCallExpression(expression)) return undefined;
            if (context.expressionMatchesShape(expression.expression, "ctx.animationGroups.push")) {
                const spread = expression.arguments[0];
                if (expression.arguments.length !== 1 || !spread || !ts.isSpreadElement(spread))
                    context.contractError(expression, "Expected a container animation-group spread.");
                const groups = lowerer.expression(spread.expression);
                return [`${indent}scene.animation_groups.insert(scene.animation_groups.end(), ${groups}.begin(), ${groups}.end());`];
            }
            if (context.expressionMatchesShape(expression.expression, "ctx._beforeRender.push")) {
                if (expression.arguments.length !== 1) context.contractError(expression, "Expected one before-render hook.");
                return [`${indent}scene.before_render.push_back(${lowerer.expression(expression.arguments[0]!)});`];
            }
            if (context.expressionMatchesShape(expression.expression, "result._sceneSetup")) {
                context.assertExpressionShape(expression, "result._sceneSetup?.(ctx, result)", "Container scene setup call");
                return [`${indent}if (record.scene_setup) record.scene_setup(scene);`];
            }
            return undefined;
        },
    }, "        ");
    return `    // ${context.provenance(module, "addToScene")}\n    [&] {\n${body}\n    }();`;
}
