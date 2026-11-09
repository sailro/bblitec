import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

const modulePath = "src/shadow/enable-morph-target-shadows.ts";

/** The pinned provider over the native cache's ranges, narrowing only at the fit's storage boundary. */
export function lowerMorphShadowBounds(context: LoweringContext): string {
    const file = context.sourceFile(modulePath);
    const provider = context.objectInitializer(file, "morphBoundsProvider");
    const method = context.objectMethod(provider, "getLocalBounds");
    // The caller has a morph set and its cached base/ranges. These two
    // declarations name that storage; the provider still owns all arithmetic,
    // weight selection, falsiness and iteration.
    context.assertExpressionShape(
        context.variableInitializer(method, "morphTargets"),
        "mesh.morphTargets",
        "Morph bounds source targets",
    );
    context.assertExpressionShape(
        context.variableInitializer(method, "cache"),
        "getCache(mesh, morphTargets)",
        "Morph bounds cache",
    );
    const body = lowerPinnedBody(file, method.body.statements, {
        bindings: new Map<string, PinnedBinding>([
            [
                "morphTargets",
                { cpp: "true", type: "bool", staticBoolean: true },
            ],
            [
                "morphTargets.count",
                {
                    cpp: "static_cast<double>(target_ranges.size())",
                    type: "scalar",
                },
            ],
            ["cache", { cpp: "true", type: "opaque" }],
            ["cache.base", { cpp: "true", type: "bool", staticBoolean: true }],
            ["cache.base[0]", { cpp: "bounds_min", type: "f64-buffer" }],
            ["cache.base[1]", { cpp: "bounds_max", type: "f64-buffer" }],
            ["cache.result[0]", { cpp: "result[0]", type: "f64-buffer" }],
            ["cache.result[1]", { cpp: "result[1]", type: "f64-buffer" }],
        ]),
        calls: new Map(),
        foldConditions: true,
        statement(statement, lowerer, indent) {
            if (ts.isReturnStatement(statement)) {
                if (
                    !statement.expression ||
                    !context.expressionMatchesShape(
                        statement.expression,
                        "cache.result",
                    )
                )
                    context.contractError(
                        statement,
                        "Expected the morph provider's cached result.",
                    );
                return [
                    `${indent}for (std::size_t axis = 0; axis < bounds_min.size(); ++axis) {`,
                    `${indent}    bounds_min[axis] = static_cast<float>(result[0][axis]);`,
                    `${indent}    bounds_max[axis] = static_cast<float>(result[1][axis]);`,
                    `${indent}}`,
                    `${indent}return;`,
                ];
            }
            if (!ts.isVariableStatement(statement)) return undefined;
            const declarations = statement.declarationList.declarations;
            for (const declaration of declarations) {
                const initializer = declaration.initializer;
                if (
                    initializer &&
                    ts.isElementAccessExpression(initializer) &&
                    context.expressionMatchesShape(
                        initializer.expression,
                        "cache.targetRanges",
                    )
                ) {
                    if (
                        declarations.length !== 1 ||
                        !ts.isIdentifier(declaration.name)
                    )
                        context.contractError(
                            declaration,
                            "Expected one morph range binding.",
                        );
                    const index = lowerer.expression(
                        initializer.argumentExpression,
                    );
                    lowerer.bindLocal(declaration.name, {
                        cpp: "range",
                        type: "f64-list-2d",
                        absentCpp: "false",
                    });
                    return [
                        `${indent}const auto& stored_range = target_ranges[static_cast<std::size_t>(${index})];`,
                        `${indent}const std::array<std::array<double, 3>, 2> range{{`,
                        `${indent}    {stored_range[0].x, stored_range[0].y, stored_range[0].z},`,
                        `${indent}    {stored_range[1].x, stored_range[1].y, stored_range[1].z}}};`,
                    ];
                }
                // A missing native weight is an absent indexed read, not NaN.
                // The source's ?? and ! decide the fallback and falsiness.
                if (initializer)
                    for (const access of context.findNodes(
                        initializer,
                        ts.isElementAccessExpression,
                    )) {
                        if (
                            !context.expressionMatchesShape(
                                access.expression,
                                "morphTargets.weights",
                            )
                        )
                            continue;
                        const index = lowerer.expression(
                            access.argumentExpression,
                        );
                        lowerer.bindLocal(access, {
                            cpp: `static_cast<double>(weights[static_cast<std::size_t>(${index})])`,
                            type: "scalar",
                            nullish: `(${index} < 0 || static_cast<std::size_t>(${index}) >= weight_count)`,
                        });
                    }
            }
            return undefined;
        },
    });
    return `
// ${context.provenance(modulePath, "morphBoundsProvider.getLocalBounds")}
inline void expand_morph_caster_bounds(
    const std::vector<std::array<Vec3, 2>>& target_ranges,
    const float* weights,
    std::size_t weight_count,
    std::array<float, 3>& bounds_min,
    std::array<float, 3>& bounds_max) {
    std::array<std::array<double, 3>, 2> result{};
${body}
}
`;
}
