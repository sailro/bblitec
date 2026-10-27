import ts from "typescript";
import { jsToUint32Call } from "./pinned-operators.js";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { absentBinding, type PinnedBinding } from "./pinned-numeric-lowerer.js";

const module = "src/material/mesh-features.ts";

/** The mesh as `_meshTangentFeature` reads it: whether its geometry carries tangents. */
const tangentPort: PinnedBinding = { cpp: "tangents", type: "bool" };

/** A call of the lowered `_meshTangentFeature` over a mesh's tangent port. */
export function meshTangentFeatureCall(tangents: string): string {
    return `upstream::pinned_mesh_tangent_feature(${tangents})`;
}

/**
 * `pinned_mesh_features.hpp`: `_meshTangentFeature` and
 * `_computeMeshFeatures`, lowered once over the mesh's attribute and
 * thin-instance ports. The variant key, the thin binding capture and the
 * PBR lazy-capability read all call these.
 */
export function meshFeaturesHeader(context: LoweringContext): string {
    return `#pragma once
#include <bblite/runtime.hpp>
#include <cstdint>

${meshFeaturesNamespace(context)}`;
}

/** The lowered mesh features in `bbl::upstream`, where generated code calls them. */
export function meshFeaturesNamespace(context: LoweringContext): string {
    return `namespace bbl::upstream {
${lowerMeshFeatures(context)}
} // namespace bbl::upstream
`;
}

export function lowerMeshFeatures(context: LoweringContext): string {
    const tangent = lowerPinnedFunction(
        context,
        module,
        "_meshTangentFeature",
        [
            {
                pinned: "mesh",
                kind: "record",
                annotation: "Mesh",
                cpp: tangentPort.cpp,
                cppType: "bool",
                binding: tangentPort,
            },
        ],
        {
            cppName: "pinned_mesh_tangent_feature",
            returns: "double",
            inline: true,
            memberBindings: new Map([["mesh._gpu.tangentBuffer", tangentPort]]),
        },
    );
    const { file, declaration } = context.functionDeclaration(
        module,
        "_computeMeshFeatures",
    );
    const bindings = new Map<string, PinnedBinding>([
        ...[
            "mesh.vat",
            "mesh.skeleton",
            "mesh.morphTargets",
            "mesh._flatNormal",
            "_meshFeatureExtra",
        ].map((name) => [name, absentBinding()] as const),
        [
            "receiveShadows",
            { cpp: "false", type: "bool", staticBoolean: false },
        ],
        ["gpu.colorBuffer", { cpp: "colors", type: "bool" }],
        ["gpu.uv2Buffer", { cpp: "uv2", type: "bool" }],
        ["mesh.thinInstances", { cpp: "thin_pool", type: "bool" }],
        ["mesh.thinInstances.colors", { cpp: "thin_colors", type: "bool" }],
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map(),
        foldConditions: true,
        // The mesh reaches the tangent helper as its tangent port.
        expression(node) {
            if (
                !ts.isCallExpression(node) ||
                !context.expressionMatchesShape(
                    node,
                    "_meshTangentFeature(mesh)",
                )
            )
                return undefined;
            return meshTangentFeatureCall(tangentPort.cpp);
        },
        returnValue(expression, numeric) {
            if (!expression)
                return context.contractError(
                    declaration,
                    "Expected a mesh feature word.",
                );
            return jsToUint32Call(numeric.expression(expression));
        },
        statement(node) {
            if (
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.length === 1
            ) {
                const variable = node.declarationList.declarations[0]!;
                if (
                    ts.isIdentifier(variable.name) &&
                    variable.name.text === "gpu" &&
                    variable.initializer
                ) {
                    context.assertExpressionShape(
                        variable.initializer,
                        "mesh._gpu",
                        "Mesh GPU attribute source",
                    );
                    return [];
                }
            }
            return undefined;
        },
    });
    return `${tangent}
// ${context.provenance(module, "_computeMeshFeatures")}
inline std::uint32_t pinned_mesh_features(bool ${tangentPort.cpp}, bool colors, bool uv2, bool thin_pool, bool thin_colors) {
${body}
}
`;
}
