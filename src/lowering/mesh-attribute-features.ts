import ts from "typescript";
import { jsToUint32Call } from "./pinned-operators.js";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { absentBinding, type PinnedBinding } from "./pinned-numeric-lowerer.js";

/** The attribute-only source predicate supplies runtime PBR keys for owned geometry. */
export function lowerMeshAttributeFeatures(context: LoweringContext): string {
    return lowerSelectedMeshFeatures(
        context,
        "pinned_mesh_attribute_features(bool tangents, bool colors, bool uv2)",
        new Map([
            ["gpu.tangentBuffer", { cpp: "tangents", type: "bool" }],
            ["gpu.colorBuffer", { cpp: "colors", type: "bool" }],
            ["gpu.uv2Buffer", { cpp: "uv2", type: "bool" }],
        ]),
    );
}

/** Binding captures need the source's thin bits, independently of GPU row lifetime. */
export function lowerThinMeshFeatures(context: LoweringContext): string {
    return lowerSelectedMeshFeatures(
        context,
        "thin_mesh_features(bool has_pool, bool has_colors)",
        new Map([
            ["mesh.thinInstances", { cpp: "has_pool", type: "bool" }],
            ["mesh.thinInstances.colors", { cpp: "has_colors", type: "bool" }],
        ]),
    );
}

function lowerSelectedMeshFeatures(
    context: LoweringContext,
    signature: string,
    selected: ReadonlyMap<string, PinnedBinding>,
): string {
    const module = "src/material/mesh-features.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "_computeMeshFeatures",
    );
    const bindings = new Map<string, PinnedBinding>([
        ...[
            "gpu.tangentBuffer",
            "gpu.colorBuffer",
            "gpu.uv2Buffer",
            "mesh.vat",
            "mesh.skeleton",
            "mesh.morphTargets",
            "mesh.thinInstances",
            "mesh._flatNormal",
            "_meshFeatureExtra",
        ].map((name) => [name, absentBinding()] as const),
        [
            "receiveShadows",
            { cpp: "false", type: "bool", staticBoolean: false },
        ],
        ...selected,
    ]);
    for (const statement of file.statements)
        if (ts.isVariableStatement(statement))
            for (const variable of statement.declarationList.declarations)
                if (
                    ts.isIdentifier(variable.name) &&
                    variable.name.text.startsWith("MSH_")
                )
                    bindings.set(variable.name.text, {
                        cpp: String(
                            context.pinnedNumber(module, variable.name.text),
                        ),
                        type: "scalar",
                    });
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map(),
        foldConditions: true,
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
    return `// ${context.provenance(module, "_computeMeshFeatures")}
inline std::uint32_t ${signature} {
${body}
}
`;
}
