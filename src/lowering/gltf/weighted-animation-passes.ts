import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding} from "../pinned-numeric-lowerer.js";

/** Source manager traversal; scratch identity and pose accumulation are supplied transports. */
export function lowerGltfWeightedAnimationPasses(context: LoweringContext): string {
    const module = "src/animation/weighted-gltf-mixer.ts";
    const {file, declaration} = context.functionDeclaration(module, "updateWeightedGltfAnimations");
    if (context.numericValue(ts.factory.createIdentifier("GLTF_NODES"), file) !== 1)
        context.contractError(file, "Weighted node tuple slot changed; establish its native identity transport.");
    const bindings = new Map<string, PinnedBinding>([
        ["scratch", {cpp: "scratch", type: "opaque"}], ["keys", {cpp: "keys", type: "opaque"}],
        ["keys.size", {cpp: "keys.size()", type: "scalar"}],
        ["groups", {cpp: "groups", type: "opaque"}], ["groups.length", {cpp: "static_cast<std::int64_t>(groups.size())", type: "scalar"}],
        ["group", {cpp: "group", type: "opaque"}],
        ["group._stopped", {cpp: "transport.stopped(group)", type: "bool"}],
        ["group._additive", {cpp: "transport.additive(group)", type: "bool"}],
        ["group.weight", {cpp: "transport.weight(group)", type: "scalar"}],
        ["group._gltfMixer", {cpp: "transport.mixer(group)", type: "opaque", absentCpp: "!transport.mixer(group)"}],
        ["mixer", {cpp: "mixer", type: "opaque", absentCpp: "!mixer"}],
        ["mixer[GLTF_NODES]", {cpp: "transport.nodes_key(mixer)", type: "opaque"}],
        ["getTarget(scratch, mixer).active", {cpp: "transport.get_target(mixer).active", type: "bool"}],
        ["target", {cpp: "target", type: "opaque"}], ["target.active", {cpp: "target.active", type: "bool"}],
        ["key", {cpp: "key", type: "opaque"}],
        ["manager", {cpp: "transport", type: "opaque"}], ["manager.engine", {cpp: "transport.engine()", type: "opaque"}],
        ["deltaMs", {cpp: "delta_ms", type: "scalar"}],
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        expression(node, lowerer) {
            if (!ts.isCallExpression(node)) return undefined;
            const callee = node.expression.getText(file);
            const args = node.arguments;
            const expected = (count: number, owners: ReadonlyArray<readonly [number, string]>) => {
                if (args.length !== count) context.contractError(node, "Changed weighted animation transport arity.");
                for (const [index, shape] of owners) context.assertExpressionShape(args[index]!, shape, "Weighted animation source identity");
            };
            if (callee === "keys.clear") { expected(0, []); return "keys.clear()"; }
            if (callee === "keys.add" || callee === "keys.has") {
                expected(1, []);
                return `keys.${callee.endsWith("add") ? "insert" : "contains"}(${lowerer.expression(args[0]!)})`;
            }
            if (callee === "getTarget") {
                expected(2, [[0, "scratch"], [1, "mixer"]]); return "transport.get_target(mixer)";
            }
            if (callee === "advanceGroupTime") {
                expected(3, [[0, "group"], [1, "mixer"]]); return `transport.advance_group_time(group, mixer, ${lowerer.expression(args[2]!)})`;
            }
            if (callee === "accumulateGroup") {
                expected(5, [[0, "manager"], [1, "scratch"], [2, "group"], [3, "mixer"]]);
                return `transport.accumulate_group(group, mixer, ${lowerer.expression(args[4]!)})`;
            }
            if (callee === "accumulateAdditiveGroup") {
                expected(3, [[0, "scratch"], [1, "group"], [2, "mixer"]]); return "transport.accumulate_additive_group(group, mixer)";
            }
            if (callee === "tickAnimationCore") {
                expected(3, [[0, "group"], [2, "manager.engine"]]); return `transport.tick_animation_core(group, ${lowerer.expression(args[1]!)})`;
            }
            if (callee === "uploadTarget") {
                expected(2, [[0, "manager"], [1, "target"]]); return "transport.upload_target(target)";
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                const adapters = new Map([
                    ["scratch", ["getScratch(manager)", "auto& scratch = transport;"]],
                    ["keys", ["scratch.keys", "auto& keys = scratch.keys;"]],
                    ["groups", ["getAnimationGroups(manager)", "const auto& groups = transport.groups;"]],
                    ["group", ["groups[groupIndex]!", "const auto group = groups.at(static_cast<std::size_t>(groupIndex));"]],
                    ["mixer", ["group._gltfMixer", "const auto mixer = transport.mixer(group);"]],
                ]);
                const adapter = adapters.get(variable.name.text);
                if (!adapter) return undefined;
                context.assertExpressionShape(variable.initializer, adapter[0]!, "Weighted animation transport alias");
                return [`${indent}${adapter[1]}`];
            }
            if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) ||
                !context.expressionMatchesShape(statement.expression.expression, "scratch.targets.forEach")) return undefined;
            const call = statement.expression, callback = call.arguments[0];
            if (call.arguments.length !== 1 || !callback) context.contractError(call, "Expected weighted target traversal.");
            if (ts.isIdentifier(callback)) {
                context.assertExpressionShape(callback, "resetWeightedGltfTarget", "Weighted target reset callback");
                return [`${indent}for (auto& entry : scratch.targets) transport.reset_target(entry.second);`];
            }
            if (!ts.isArrowFunction(callback) || callback.parameters.length !== 2 || callback.parameters[0]!.name.getText(file) !== "target" ||
                callback.parameters[1]!.name.getText(file) !== "key" || !ts.isBlock(callback.body))
                context.contractError(callback, "Expected weighted target publication callback.");
            return [`${indent}for (auto& [key, target] : scratch.targets) {`,
                ...lowerer.statements(callback.body.statements, indent + "    "), `${indent}}`];
        },
        returnValue: (expression, lowerer) => lowerer.expression(expression!),
    });
    return `// ${context.provenance(module, "updateWeightedGltfAnimations")}
template<class Transport>
bool gltf_update_weighted_animation_passes(Transport& transport, double delta_ms) {
${body}
}`;
}
