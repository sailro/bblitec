import ts from "typescript";
import type { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";

/** Native map ownership adapts the pin's retained Float32Array world overrides. */
export function lowerGltfBoneWorldPose(context: LoweringContext): string {
    const module = "src/skeleton/bone-control.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "setBoneWorldPoseDeferred",
    );
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map<string, PinnedBinding>([
            ...["px", "py", "pz", "rx", "ry", "rz", "rw"].map(
                (name) =>
                    [name, { cpp: name, type: "scalar" as const }] as const,
            ),
            ["world", { cpp: "(*world)", type: "f32", absentCpp: "!world" }],
            ["bone._nodeIndex", { cpp: "node", type: "scalar" }],
        ]),
        calls: new Map([
            [
                "composeMat4IntoBuffer",
                (args: readonly string[]) => `compose(${args.join(", ")})`,
            ],
            ["skeleton._worldOverrides.set", () => "(void)0"],
        ]),
        statement(node, numeric, indent) {
            if (ts.isVariableStatement(node)) {
                const variable = node.declarationList.declarations[0];
                if (
                    !variable?.initializer ||
                    !ts.isIdentifier(variable.name) ||
                    variable.name.text !== "world"
                )
                    return undefined;
                context.assertExpressionShape(
                    variable.initializer,
                    "skeleton._worldOverrides.get(bone._nodeIndex)",
                    "Bone world override lookup",
                );
                return [
                    `${indent}auto found = entries.find(node);`,
                    `${indent}auto* world = found == entries.end() ? nullptr : &found->second;`,
                ];
            }
            if (
                ts.isExpressionStatement(node) &&
                ts.isBinaryExpression(node.expression) &&
                context.expressionMatchesShape(node.expression.left, "world")
            ) {
                context.assertExpressionShape(
                    node.expression,
                    "world = new F32(16)",
                    "Bone world override allocation",
                );
                const allocation = node.expression.right;
                if (
                    !ts.isNewExpression(allocation) ||
                    !allocation.arguments?.[0]
                )
                    return undefined;
                return [
                    `${indent}world = &entries.try_emplace(node, static_cast<std::size_t>(${numeric.expression(allocation.arguments[0])})).first->second;`,
                ];
            }
            return undefined;
        },
    });
    const bake = context.functionDeclaration(module, "bakeSkeleton");
    const bakeBody = lowerPinnedBody(
        bake.file,
        bake.declaration.body!.statements,
        {
            bindings: new Map(),
            calls: new Map([["skeleton._bake", () => "bake()"]]),
        },
    );
    return `// ${context.provenance(module, "setBoneWorldPoseDeferred")}
template<class Entries, class Compose>
void gltf_set_bone_world_pose(Entries& entries, std::size_t node,
    double px, double py, double pz, double rx, double ry, double rz, double rw, Compose compose) {
${body}
}
// ${context.provenance(module, "bakeSkeleton")}
template<class Bake> void gltf_bake_controlled_skeleton(Bake bake) {
${bakeBody}
}
`;
}
