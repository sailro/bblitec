import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding} from "../pinned-numeric-lowerer.js";
import {pinnedNumericMathCalls} from "../pinned-operators.js";

const module = "src/animation/weighted-gltf-mixer.ts";

/** Source weighted/additive TRS arithmetic, bone phases, world composition and palette publication. */
export function lowerGltfWeightedAnimationRuntime(context: LoweringContext): string {
    const file = context.sourceFile(module);
    if (context.numericValue(ts.factory.createIdentifier("GLTF_CLIP"), file) !== 0)
        context.contractError(file, "Weighted clip tuple slot changed; establish its native identity transport.");
    const quaternionNames = ["normalizeQuaternionAt", "quatSlerpInto", "quatRefInverseTimesSample", "applyAdditiveQuaternion"];
    const quaternionCpp = new Map(quaternionNames.map(name => [name, `gltf_weighted_${name}`]));
    const quaternionBodies = quaternionNames.map(name => {
        const {declaration} = context.functionDeclaration(module, name);
        const bindings = new Map<string, PinnedBinding>();
        const parameters = declaration.parameters.map(parameter => {
            if (!ts.isIdentifier(parameter.name) || !parameter.type) context.contractError(parameter, "Expected typed quaternion helper parameters.");
            const array = ts.isTypeReferenceNode(parameter.type) && ts.isIdentifier(parameter.type.typeName) && parameter.type.typeName.text === "Float32Array";
            if (!array && parameter.type.kind !== ts.SyntaxKind.NumberKeyword) context.contractError(parameter, "Unsupported weighted quaternion transport.");
            const cpp = parameter.name.text; bindings.set(cpp, {cpp, type: array ? "f32" : "scalar"});
            return `${array ? "std::vector<float>&" : "double"} ${cpp}`;
        });
        return `void ${quaternionCpp.get(name)}(${parameters.join(", ")}) {
${lowerPinnedBody(file, declaration.body!.statements, {bindings,
            calls: new Map([...pinnedNumericMathCalls(), ...[...quaternionCpp].map(([source, cpp]) =>
                [source, (args: readonly string[]) => `${cpp}(${args.join(", ")})`] as const)])})}
}`;
    });
    const bindingScope = (): Map<string, PinnedBinding> => {
        const result = new Map<string, PinnedBinding>();
        const bind = (name: string, cpp: string, type: PinnedBinding["type"] = "scalar") => result.set(name, {cpp, type});
        const types = context.sourceFile("src/animation/types.ts");
        for (const name of ["PATH_TRANSLATION", "PATH_ROTATION", "PATH_SCALE"])
            bind(name, context.doubleLiteral(context.numericValue(ts.factory.createIdentifier(name), types)));
        for (const name of ["target", "group", "clip", "scratch", "n", "ch", "node", "skel", "sampler"])
            bind(name, name, "opaque");
        for (const [name, cpp] of [["trs", "target.currentTRS"], ["target.trs", "target.currentTRS"],
            ["localMat", "target.localMat"], ["worldMat", "target.worldMat"], ["_boneTmp", "target._boneTmp"], ["RH_TO_LH", "target.RH_TO_LH"],
            ["scratch.sample", "scratch.sample"], ["scratch.reference", "scratch.reference"], ["scratch.delta", "scratch.delta"],
            ["target.tWeight", "target.tWeight"], ["target.rWeight", "target.rWeight"], ["target.sWeight", "target.sWeight"],
            ["boneData", "boneData"], ["skel.invMeshWorld", "skel.invMeshWorld"], ["skel.inverseBindMatrices", "skel.inverseBindMatrices"]])
            bind(name!, cpp!, "f32");
        for (const name of ["baseRot", "target.baseRot"])
            result.set(name, {cpp: "(*target.baseRot)", type: "f32", absentCpp: "!target.baseRot"});
        for (const name of ["target.nodes.length", "nodes.length"]) bind(name, "static_cast<double>(target.nodes.size())");
        bind("target.skeletons.length", "static_cast<double>(target.skeletons.size())");
        bind("clip.channels.length", "static_cast<double>(clip.channels.size())");
        bind("manager.engine", "engine", "bool");
        bind("target.active", "target.active", "bool");
        bind("target.overrides", "target.has_bone_overrides", "bool");
        bind("overrides", "target.has_bone_overrides", "bool");
        bind("overrides.size", "target.bone_override_count");
        bind("deltaMs", "delta_ms");
        bind("group.currentTime", "group.time");
        bind("group.weight", "group.weight");
        bind("group._additive", "group.additive", "bool");
        bind("additive", "group.additive", "bool");
        bind("additive.referenceTime", "group.additive_reference_time");
        for (const name of ["n", "node"])
            for (const member of ["tx", "ty", "tz", "rx", "ry", "rz", "rw", "sx", "sy", "sz", "parentIdx"])
                bind(`${name}.${member}`, `${name}.${member}`);
        for (const member of ["nodeIdx", "samplerIdx", "path"]) bind(`ch.${member}`, `ch.${member}`);
        bind("skel.boneCount", "skel.boneCount");
        return result;
    };
    const lower = (name: string): string => {
        const {declaration} = context.functionDeclaration(module, name);
        let loweringSwitch = false;
        const arrays = new Map([
            ["nodes", "target.nodes"], ["target.nodes", "target.nodes"], ["target.topoOrder", "target.topo_order"],
            ["clip.channels", "clip.channels"], ["clip.samplers", "clip.samplers"],
            ["target.skeletons", "target.skeletons"], ["skel.jointNodes", "skel.jointNodes"],
        ]);
        const aliases = new Set(["n", "ch", "sampler", "target", "node", "skel", "boneData"]);
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: bindingScope(), booleanAnd: true, booleanOr: true,
            methods: new Map([["fill", (receiver, args, binding) => {
                if (args.length !== 1 || binding.type !== "f32") context.contractError(declaration, "Unsupported weighted scratch fill.");
                return `std::fill(${receiver}.begin(), ${receiver}.end(), static_cast<float>(${args[0]}))`;
            }]]),
            calls: new Map([...pinnedNumericMathCalls(),
                ...[...quaternionCpp].map(([source, cpp]) => [source, (args: readonly string[]) => `${cpp}(${args.join(", ")})`] as const),
                ["resetTarget", () => "gltf_reset_weighted_rest(target)"],
                ["evaluateSampler", (args: readonly string[]) => `evaluate_sampler(${args.join(", ")})`],
                ["mat4ComposeInto", (args: readonly string[]) => `compose_matrix(${args.join(", ")})`],
                ["mat4MultiplyInto", (args: readonly string[]) => `multiply_matrix(${args.join(", ")})`],
            ]),
            expression(node, lowerer) {
                if (ts.isConditionalExpression(node) && context.expressionMatchesShape(node.condition, "baseRot"))
                    return `(target.baseRot.has_value() ? ${lowerer.expression(node.whenTrue)} : ${lowerer.expression(node.whenFalse)})`;
                if (ts.isElementAccessExpression(node)) {
                    const array = [...arrays].find(([source]) => context.expressionMatchesShape(context.unwrapExpression(node.expression), source))?.[1];
                    if (array) return `${array}.at(static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)}))`;
                }
                if (context.expressionMatchesShape(node, "overrides !== undefined")) return "target.has_bone_overrides";
                if (context.expressionMatchesShape(node, "node._matrix")) return "node.matrix.has_value()";
                if (context.expressionMatchesShape(node, "skel.runtimeSkeleton?._disposed")) return "skel.disposed";
                if (context.expressionMatchesShape(node, "skel.boneMatrices")) return "(*skel.boneMatrices)";
                if (!ts.isCallExpression(node)) return undefined;
                if (context.expressionMatchesShape(node.expression, "getTarget")) {
                    context.assertExpressionShape(node, "getTarget(scratch, mixer)", "Weighted target storage identity");
                    return "get_target()";
                }
                if (context.expressionMatchesShape(node.expression, "advanceGroupTime")) {
                    if (node.arguments.length !== 3) context.contractError(node, "Expected weighted group advancement arguments.");
                    context.assertExpressionShape(node.arguments[0]!, "group", "Weighted group identity");
                    context.assertExpressionShape(node.arguments[1]!, "mixer", "Weighted clip identity");
                    return `gltf_advance_weighted_animation(group, ${lowerer.expression(node.arguments[2]!)}, speed_ratio)`;
                }
                if (context.expressionMatchesShape(node.expression, "channelMaskedOut")) {
                    if (node.arguments.length !== 3) context.contractError(node, "Expected weighted mask lookup arguments.");
                    context.assertExpressionShape(node.arguments[0]!, "group", "Weighted mask group identity");
                    return `gltf_weighted_channel_masked_out(group, static_cast<double>(${lowerer.expression(node.arguments[1]!)}), ${lowerer.expression(node.arguments[2]!)})`;
                }
                return undefined;
            },
            statement(statement, lowerer, indent) {
                if (ts.isSwitchStatement(statement) && !loweringSwitch) {
                    if (context.findNodes(statement, ts.isContinueStatement).length)
                        context.contractError(statement, "Weighted switch continuation needs its outer-loop identity preserved.");
                    loweringSwitch = true;
                    try { return [`${indent}do {`, ...lowerer.statement(statement, indent + "    "), `${indent}} while (false);`]; }
                    finally { loweringSwitch = false; }
                }
                if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                    const variable = statement.declarationList.declarations[0]!;
                    if (ts.isObjectBindingPattern(variable.name)) {
                        if (!variable.initializer) context.contractError(variable, "Expected weighted target destructuring.");
                        context.assertExpressionShape(variable.initializer, "target", "Weighted target storage owner");
                        const allowed = new Set(["nodes", "trs", "localMat", "worldMat"]);
                        for (const element of variable.name.elements)
                            if (!ts.isIdentifier(element.name) || element.propertyName || !allowed.has(element.name.text))
                                context.contractError(element, "Unsupported weighted target destructuring.");
                        return [];
                    }
                    if (ts.isIdentifier(variable.name) && variable.initializer) {
                        const name = variable.name.text;
                        if (aliases.has(name)) return [`${indent}auto& ${name} = ${lowerer.expression(variable.initializer)};`];
                        if (["baseRot", "trs", "overrides", "additive"].includes(name)) {
                            context.assertExpressionShape(variable.initializer, name === "additive" ? "group._additive"
                                : name === "trs" ? "target.trs" : `target.${name}`, "Weighted target alias");
                            return [];
                        }
                        if (name === "clip") {
                            context.assertExpressionShape(variable.initializer, "mixer[GLTF_CLIP]", "Weighted clip source slot"); return [];
                        }
                        if (name === "device") {
                            context.assertExpressionShape(variable.initializer, "manager.engine._device", "Weighted device transport"); return [];
                        }
                    }
                }
                if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return undefined;
                const call = statement.expression;
                if (context.expressionMatchesShape(call.expression, "_boneApplier")) {
                    if (call.arguments.length < 3 || call.arguments.length > 4) context.contractError(call, "Expected weighted bone override phases.");
                    context.assertExpressionShape(call.arguments[0]!, "overrides as ReadonlyMap<number, BoneOverride>", "Weighted override identity");
                    return [`${indent}apply_bone_overrides(${call.arguments.slice(1).map(argument => lowerer.expression(argument)).join(", ")}${call.arguments.length === 3 ? ", false" : ""});`];
                }
                if (context.expressionMatchesShape(call.expression, "device.queue.writeTexture")) {
                    context.assertExpressionShape(call, "device.queue.writeTexture({ texture: skel.boneTexture }, boneData.buffer, { bytesPerRow: texWidth * 16 }, { width: texWidth, height: 1 })", "Weighted bone GPU upload transport");
                    return [`${indent}upload_bones(skel, boneData, texWidth);`];
                }
                if (context.expressionMatchesShape(call.expression, "localMat.set")) {
                    if (call.arguments.length !== 2) context.contractError(call, "Expected authored matrix storage copy.");
                    context.assertExpressionShape(call.arguments[0]!, "node._matrix", "Weighted authored matrix identity");
                    return [`${indent}std::copy(node.matrix->begin(), node.matrix->end(), target.localMat.begin() + static_cast<std::size_t>(${lowerer.expression(call.arguments[1]!)}));`];
                }
                return undefined;
            },
        });
    };
    return `// ${context.provenance(module, "weighted quaternion helpers")}
${quaternionBodies.join("\n")}
${lowerWeightedMask(context)}
// ${context.provenance(module, "resetTarget")}
template<class Target> void gltf_reset_weighted_rest(Target& target) {
${lower("resetTarget")}
}
// ${context.provenance(module, "resetWeightedGltfTarget")}
template<class Target, class BoneOverrides> void gltf_reset_weighted_target(Target& target, BoneOverrides apply_bone_overrides) {
${lower("resetWeightedGltfTarget")}
}
// ${context.provenance(module, "accumulateGroup")}
template<class Scratch, class Group, class Clip, class GetTarget, class EvaluateSampler>
void gltf_accumulate_weighted_group(Scratch& scratch, Group& group, const Clip& clip,
    double delta_ms, double speed_ratio, bool engine, GetTarget get_target, EvaluateSampler evaluate_sampler) {
${lower("accumulateGroup")}
}
// ${context.provenance(module, "accumulateAdditiveGroup")}
template<class Scratch, class Group, class Clip, class GetTarget, class EvaluateSampler>
void gltf_accumulate_additive_group(Scratch& scratch, Group& group, const Clip& clip,
    GetTarget get_target, EvaluateSampler evaluate_sampler) {
${lower("accumulateAdditiveGroup")}
}
// ${context.provenance(module, "uploadTarget")}
template<class Target, class BoneOverrides, class ComposeMatrix, class MultiplyMatrix, class UploadBones>
void gltf_upload_weighted_target(Target& target, bool engine, BoneOverrides apply_bone_overrides,
    ComposeMatrix compose_matrix, MultiplyMatrix multiply_matrix, UploadBones upload_bones) {
${lower("uploadTarget")}
}`;
}

function lowerWeightedMask(context: LoweringContext): string {
    const {file, declaration} = context.functionDeclaration(module, "channelMaskedOut");
    const bindings = new Map<string, PinnedBinding>([
        ["group.mask", {cpp: "group.mask", type: "opaque", absentCpp: "!group.mask"}],
        ["mask", {cpp: "mask", type: "opaque", absentCpp: "!mask"}],
        ["mask.disabled", {cpp: "mask->disabled", type: "bool"}], ["mask.mode", {cpp: "mask->mode", type: "scalar"}],
        ["nodeIdx", {cpp: "node_index", type: "scalar"}], ["channelIndex", {cpp: "channel_index", type: "scalar"}],
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        expression(node) {
            if (context.expressionMatchesShape(node, "group.targetedAnimations[channelIndex]!.targetName ?? \"\""))
                return 'group.target_names.at(static_cast<std::size_t>(channel_index)).value_or("")';
            if (context.expressionMatchesShape(node, "mask.names.indexOf(name)"))
                return "weighted_mask_name_index(mask->names, name)";
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
            const variable = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
            if (variable.name.text === "mask") return [`${indent}const auto mask = ${lowerer.expression(variable.initializer)};`];
            if (variable.name.text === "name") return [`${indent}const auto name = ${lowerer.expression(variable.initializer)};`];
            return undefined;
        },
        returnValue: (expression, lowerer) => lowerer.expression(expression!),
    });
    return `double weighted_mask_name_index(const std::vector<std::string>& names, const std::string& name) {
    const auto found = std::find(names.begin(), names.end(), name);
    return found == names.end() ? -1.0 : static_cast<double>(found - names.begin());
}
// ${context.provenance(module, "channelMaskedOut")}
template<class Group> bool gltf_weighted_channel_masked_out(const Group& group, double channel_index, double node_index) {
${body}
}`;
}
