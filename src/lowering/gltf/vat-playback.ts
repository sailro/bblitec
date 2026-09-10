import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";

/** The VAT baker's CPU seek deliberately bypasses the public stopped-group gate. */
export function lowerGltfVatPlayback(context: LoweringContext): string {
    const module = "src/vat/vat-baker.ts";
    const {file, declaration} = context.functionDeclaration(module, "goToFrameCpu");
    const controller = context.functionDeclaration("src/skeleton/skeleton-updater.ts", "createAnimationController");
    const cpu = context.findNodes(controller.declaration, (node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) &&
        context.propertyName(node.name) === "_tickCpu");
    if (cpu.length !== 1) context.contractError(controller.declaration, "Expected one CPU animation controller entry.");
    context.assertStatementShapes(cpu[0]!, cpu[0]!.body!.statements, `
        const previous = uploadGpu;
        uploadGpu = false;
        try { ctrl.tick(deltaMs, engine); } finally { uploadGpu = previous; }
    `, "CPU controller upload lifetime");
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map([
            ["group.currentTime", {cpp: "group.time", type: "scalar"}],
            ["group.isPlaying", {cpp: "group.playing", type: "bool"}],
            ["group.speedRatio", {cpp: "group.speed_ratio", type: "scalar"}],
            ["group.loopAnimation", {cpp: "group.loop", type: "bool"}],
            ["group.frameRate", {cpp: "group.frame_rate", type: "scalar"}],
            ["frame", {cpp: "frame", type: "scalar"}],
            ["ctrl", {cpp: "group.controller", type: "opaque", staticBoolean: true}],
            ["ctrl._tickCpu", {cpp: "true", type: "bool", staticBoolean: true}],
            ["ctrl.time", {cpp: "group.controller.time", type: "scalar"}],
            ["ctrl.playing", {cpp: "group.controller.playing", type: "bool"}],
            ["ctrl.speedRatio", {cpp: "group.controller.speed_ratio", type: "scalar"}],
            ["ctrl.loop", {cpp: "group.controller.loop", type: "bool"}],
        ]),
        calls: new Map([["ctrl._tickCpu", args => `tick_cpu(${args.join(", ")})`]]),
        expression(node, numeric) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
                context.expressionMatchesShape(node.left, "group.frameRate"))
                return `bbl::js::or_number(${numeric.expression(node.left)}, ${numeric.expression(node.right)})`;
            return undefined;
        },
        statement(node, _numeric, indent) {
            if (ts.isVariableStatement(node)) {
                context.assertStatementShapes(node, [node], "const ctrl = group._ctrl;", "VAT group controller identity");
                return [];
            }
            if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
                context.expressionMatchesShape(node.expression.expression, "ctrl._setMask")) {
                context.assertExpressionShape(node.expression, "ctrl._setMask?.(group.mask ?? null)", "VAT controller mask synchronization");
                return [`${indent}sync_mask();`];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(module, "goToFrameCpu")}
template<class Group, class SyncMask, class TickCpu>
void gltf_vat_go_to_frame(Group& group, double frame, SyncMask sync_mask, TickCpu tick_cpu) {
${body}
}
`;
}
