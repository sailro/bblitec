import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

const TASK = "src/frame-graph/render-task-base.ts";

/**
 * `transparent_order.hpp`: the pin's transparent comparator and sort
 * distance, which `pal_transparent_order.hpp` applies to a scene pass's
 * transparent meshes, billboards and external renderables as one bucket.
 * A binding whose renderable has no `_worldCenter` sorts at distance 0.
 */
export function transparentOrderHeader(context: LoweringContext): string {
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    const comparator = context.functionDeclaration(
        TASK,
        "compareTransparentBindings",
    );
    const compare = lowerPinnedBody(
        comparator.file,
        comparator.declaration.body!.statements,
        {
            calls: new Map(),
            returnValue: (expression, lowerer) =>
                lowerer.expression(expression!),
            bindings: new Map([
                ["a._sortDistance", scalar("a.distance")],
                ["b._sortDistance", scalar("b.distance")],
                ["a.renderable.order", scalar("a.order")],
                ["b.renderable.order", scalar("b.order")],
            ]),
        },
    );
    const sort = context.functionDeclaration(TASK, "sortTransparentBindings");
    const assignments = context.findNodes(
        sort.declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(node.left) &&
            node.left.name.text === "_sortDistance",
    );
    if (assignments.length !== 1)
        context.contractError(
            sort.declaration,
            "Expected one transparent sort distance assignment.",
        );
    const distance = new PinnedNumericLowerer(sort.file, {
        calls: new Map(),
        bindings: new Map<string, PinnedBinding>([
            [
                "wc",
                {
                    cpp: "(*center)",
                    type: "f64-buffer",
                    absentCpp: "center == nullptr",
                },
            ],
            ["v", { cpp: "view", type: "f64-buffer" }],
        ]),
    }).expression(assignments[0]!.right);
    return `#pragma once
#include <bblite/js_data.hpp>
#include <array>

namespace bbl::upstream {
// ${context.provenance(TASK, "compareTransparentBindings, sortTransparentBindings")}
template<class Binding> inline double compare_transparent_order(const Binding& a, const Binding& b) {
${compare}
}
/** \`_sortDistance\` from a renderable's \`_worldCenter\`; \`center\` is null where it has none. */
template<class View> inline double transparent_sort_distance(const std::array<double, 3>* center, const View& view) {
    return ${distance};
}
} // namespace bbl::upstream
`;
}
