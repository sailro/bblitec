import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

/** Property groups use the source clock and public controls within mixed manager traversal. */
export function lowerPropertyAnimationPlayback(
    context: LoweringContext,
): string {
    const module = "src/animation/property-animation.ts",
        groupModule = "src/animation/animation-group.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "createPointerAnimationGroup",
    );
    const controller = context.unwrapExpression(
        context.variableInitializer(declaration, "ctrl"),
    );
    if (!ts.isObjectLiteralExpression(controller))
        context.contractError(
            controller,
            "Expected source property controller.",
        );
    const tick = controller.properties.find(
        (property) =>
            ts.isMethodDeclaration(property) &&
            context.propertyName(property.name) === "tick",
    );
    if (!tick || !ts.isMethodDeclaration(tick) || !tick.body)
        context.contractError(
            controller,
            "Expected source property controller tick.",
        );
    const bindings = new Map<string, PinnedBinding>([
        ["ctrl.time", { cpp: "time", type: "scalar" }],
        ["ctrl.playing", { cpp: "group.playing", type: "bool" }],
        ["ctrl.speedRatio", { cpp: "group.speed_ratio", type: "scalar" }],
        ["ctrl.loop", { cpp: "group.loop", type: "bool" }],
        ["deltaMs", { cpp: "delta_ms", type: "scalar" }],
        ["fromTime", { cpp: "group.from_time", type: "scalar" }],
        ["toTime", { cpp: "group.to_time", type: "scalar" }],
        ["group.isPlaying", { cpp: "group.playing", type: "bool" }],
        ["group._stopped", { cpp: "group.stopped", type: "bool" }],
    ]);
    const clock = lowerPinnedBody(file, tick.body.statements, {
        bindings,
        calls: new Map([
            ["applyAt", (args) => `apply_pose(${args.join(", ")})`],
        ]),
    });
    const controls = ["playAnimation", "pauseAnimation", "stopAnimation"]
        .map((name) => {
            const source = context.functionDeclaration(groupModule, name);
            return `template<class Group> void property_${name}(Group& group) {
${lowerPinnedBody(source.file, source.declaration.body!.statements, {
    bindings: new Map<string, PinnedBinding>([
        ["group.isPlaying", { cpp: "group.playing", type: "bool" }],
        ["group._stopped", { cpp: "group.stopped", type: "bool" }],
        ["group.currentTime", { cpp: "group.current_time", type: "scalar" }],
        ["group._startTime", { cpp: "group.from_time", type: "scalar" }],
    ]),
    calls: new Map(),
    expression(node) {
        if (context.expressionMatchesShape(node, "group._startTime ?? 0"))
            return "group.from_time";
        return undefined;
    },
})}
}`;
        })
        .join("\n");
    const core = context.functionDeclaration(groupModule, "tickAnimationCore");
    const coreBody = lowerPinnedBody(
        core.file,
        core.declaration.body!.statements,
        {
            bindings: new Map<string, PinnedBinding>([
                ["group._stopped", { cpp: "group.stopped", type: "bool" }],
                [
                    "group._ctrl",
                    { cpp: "true", type: "bool", staticBoolean: true },
                ],
                [
                    "group.currentTime",
                    { cpp: "group.current_time", type: "scalar" },
                ],
                ["group._ctrl.time", { cpp: "time", type: "scalar" }],
                ["deltaMs", { cpp: "delta_ms", type: "scalar" }],
                ["engine", { cpp: "true", type: "bool" }],
            ]),
            calls: new Map(),

            statement(statement, _lowerer, indent) {
                if (
                    !ts.isExpressionStatement(statement) ||
                    !ts.isCallExpression(statement.expression)
                )
                    return undefined;
                const call = statement.expression;
                if (
                    context.expressionMatchesShape(
                        call.expression,
                        "syncControllerFromGroup",
                    )
                ) {
                    context.assertExpressionShape(
                        call,
                        "syncControllerFromGroup(group, group._ctrl)",
                        "Property playback source state sync",
                    );
                    return [`${indent}double time = group.current_time;`];
                }
                if (
                    context.expressionMatchesShape(
                        call.expression,
                        "group._ctrl.tick",
                    )
                ) {
                    context.assertExpressionShape(
                        call,
                        "group._ctrl.tick(deltaMs, engine)",
                        "Property playback controller invocation",
                    );
                    return [
                        `${indent}property_controller_tick(group,time,delta_ms,apply_pose);`,
                    ];
                }
                return undefined;
            },
        },
    );
    const groupValue = context.unwrapExpression(
        context.variableInitializer(declaration, "group"),
    );
    if (!ts.isObjectLiteralExpression(groupValue))
        context.contractError(groupValue, "Expected property group record.");
    const evaluate = groupValue.properties.find(
        (property) =>
            ts.isPropertyAssignment(property) &&
            context.propertyName(property.name) === "_evaluate",
    );
    if (
        !evaluate ||
        !ts.isPropertyAssignment(evaluate) ||
        !ts.isArrowFunction(evaluate.initializer) ||
        !ts.isBlock(evaluate.initializer.body)
    )
        context.contractError(
            groupValue,
            "Expected explicit property pose evaluator.",
        );
    const seekBindings = new Map<string, PinnedBinding>([
        ["group.currentTime", { cpp: "group.current_time", type: "scalar" }],
        ["group.isPlaying", { cpp: "group.playing", type: "bool" }],
        ["group.frameRate", { cpp: "group.clip.frame_rate", type: "scalar" }],
        ["ctrl", { cpp: "true", type: "bool", staticBoolean: true }],
        ["ctrl.time", { cpp: "time", type: "scalar" }],
        ["group._evaluate", { cpp: "true", type: "bool", staticBoolean: true }],
        ["duration", { cpp: "group.clip.duration", type: "scalar" }],
        ["frame", { cpp: "frame", type: "scalar" }],
    ]);
    const evaluateBody = lowerPinnedBody(
        file,
        evaluate.initializer.body.statements,
        {
            bindings: seekBindings,
            calls: new Map([
                ["applyAt", (args) => `apply_pose(${args.join(", ")})`],
            ]),
        },
    );
    const seek = context.functionDeclaration(groupModule, "goToFrame");
    const seekBody = lowerPinnedBody(
        seek.file,
        seek.declaration.body!.statements,
        {
            bindings: seekBindings,
            calls: new Map(),
            expression(node, lowerer) {
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
                    context.expressionMatchesShape(node.left, "group.frameRate")
                )
                    return `bbl::js::or_number(${lowerer.expression(node.left)}, ${lowerer.expression(node.right)})`;
                return undefined;
            },
            statement(statement, _lowerer, indent) {
                if (ts.isVariableStatement(statement)) {
                    context.assertStatementShapes(
                        statement,
                        [statement],
                        "const ctrl = group._ctrl;",
                        "Property seek controller identity",
                    );
                    return [];
                }
                if (ts.isExpressionStatement(statement)) {
                    if (
                        context.expressionMatchesShape(
                            statement.expression,
                            "syncControllerFromGroup(group, ctrl)",
                        )
                    )
                        return [`${indent}double time = group.current_time;`];
                    if (
                        context.expressionMatchesShape(
                            statement.expression,
                            "group._evaluate(engine)",
                        )
                    )
                        return evaluateBody
                            .split("\n")
                            .map((line) => indent + line);
                }
                return undefined;
            },
        },
    );
    return `// ${context.provenance(groupModule, "playAnimation,pauseAnimation,stopAnimation")}
${controls}
// ${context.provenance(module, "createPointerAnimationGroup.tick")}
template<class Group,class Apply> void property_controller_tick(Group& group,double& time,double delta_ms,Apply apply_pose) {
${clock}
}
// ${context.provenance(groupModule, "tickAnimationCore")}
template<class Group,class Apply> void tick_property_animation_group(Group& group,double delta_ms,Apply apply_pose) {
${coreBody}
}
// ${context.provenance(groupModule, "goToFrame")}
template<class Group,class Apply> void property_go_to_frame(Group& group,double frame,Apply apply_pose) {
${seekBody}
}`;
}
