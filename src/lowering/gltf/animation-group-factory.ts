import ts from "typescript";
import {stringLiteral} from "../../cpp-literals.js";
import type {LoweringContext} from "../context.js";
import {PinnedNumericLowerer, type PinnedBinding} from "../pinned-numeric-lowerer.js";

/** Source group initializers; controller and targeted-animation identities arrive separately. */
export function lowerGltfAnimationGroupFactory(context: LoweringContext): string {
    const module = "src/animation/animation-group.ts";
    const {file, declaration} = context.functionDeclaration(module, "createAnimationGroups");
    const value = context.unwrapExpression(context.variableInitializer(declaration, "group"));
    if (!ts.isObjectLiteralExpression(value)) context.contractError(value, "Expected the source animation group object.");
    const properties = new Map(value.properties.filter(ts.isPropertyAssignment).map(property => {
        const name = context.propertyName(property.name);
        if (name === undefined) context.contractError(property, "Expected a named animation group field.");
        return [name, property.initializer] as const;
    }));
    const names = new Map([
        ["name", "name"], ["duration", "duration"], ["frameRate", "frame_rate"],
        ["isPlaying", "playing"], ["currentTime", "time"], ["speedRatio", "speed_ratio"],
        ["loopAnimation", "loop"], ["weight", "weight"], ["_stopped", "stopped"],
    ]);
    for (const key of properties.keys()) {
        if (!names.has(key) && key !== "_ctrl" && key !== "targetedAnimations")
            context.contractError(properties.get(key)!, `Unbound animation group factory field ${key}.`);
    }
    const bindings = new Map<string, PinnedBinding>([
        ["clipIndex", {cpp: "clip_index", type: "scalar"}],
        ["clip.duration", {cpp: "clip_duration", type: "scalar"}],
        ["clip.frameRate", {cpp: "clip_frame_rate", type: "scalar"}],
        ["started", {cpp: "started", type: "bool"}],
    ]);
    const lowerer = new PinnedNumericLowerer(file, {
        bindings, calls: new Map(),
        expression(node, numeric) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
                context.expressionMatchesShape(node.left, "clip.frameRate"))
                return `bbl::js::or_number(${numeric.expression(node.left)}, ${numeric.expression(node.right)})`;
            return undefined;
        },
    });
    const text = (node: ts.Expression): string => {
        node = context.unwrapExpression(node);
        if (context.expressionMatchesShape(node, "clip.name")) return "clip_name";
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return `std::string{${stringLiteral(node.text)}}`;
        if (ts.isTemplateExpression(node)) {
            const parts = [`std::string{${stringLiteral(node.head.text)}}`];
            for (const span of node.templateSpans) {
                context.assertExpressionShape(span.expression, "clipIndex", "Animation fallback name index");
                parts.push("std::to_string(static_cast<std::size_t>(clip_index))", `std::string{${stringLiteral(span.literal.text)}}`);
            }
            return `(${parts.join(" + ")})`;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
            const left = text(node.left);
            return `(!${left}.empty() ? ${left} : ${text(node.right)})`;
        }
        context.contractError(node, "Unsupported source animation group name expression.");
    };
    const started = lowerer.expression(context.variableInitializer(declaration, "started"));
    const stores = [...names].map(([source, field]) => {
        const initializer = properties.get(source);
        if (!initializer) context.contractError(value, `Missing animation group field ${source}.`);
        return `    group.${field} = ${source === "name" ? text(initializer) : lowerer.expression(initializer)};`;
    }).join("\n");
    return `// ${context.provenance(module, "createAnimationGroups")}
template<class Group>
void gltf_initialize_animation_group(Group& group, const std::string& clip_name,
    double clip_duration, double clip_frame_rate, double clip_index) {
    const bool started = ${started};
${stores}
}
`;
}
