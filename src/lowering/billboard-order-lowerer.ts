import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

/** Billboard centers and mixed transparent ordering come from the renderable/task source. */
export function billboardOrderHelpers(context: LoweringContext): string {
    const path = "src/sprite/billboard-renderable.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "refreshBillboardWorldCenter",
    );
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        calls: new Map(),
        bindings: new Map<string, PinnedBinding>([
            ["system", { cpp: "record", type: "opaque" }],
            ["renderable._system", { cpp: "record", type: "opaque" }],
            ["renderable._centerVersion", scalar("record.center_version")],
            ["renderable._drawableCount", scalar("record.drawable_count")],
            [
                "renderable._worldCenter",
                {
                    cpp: "record.world_center",
                    type: "f64-buffer",
                    mutable: true,
                },
            ],
            [
                "system._version",
                scalar("static_cast<double>(record.instance_version)"),
            ],
            ["system.count", scalar("static_cast<double>(record.count)")],
            [
                "system._instanceData",
                { cpp: "record.instance_data", type: "f32" },
            ],
            [
                "system._instanceFloatsPerSprite",
                scalar(
                    "static_cast<double>(record.instance_floats_per_sprite)",
                ),
            ],
        ]),
        statement(node) {
            if (
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.length === 1 &&
                node.declarationList.declarations[0]!.name.getText(file) ===
                    "system"
            )
                return [];
            return undefined;
        },
    });
    const taskPath = "src/frame-graph/render-task-base.ts";
    const comparator = context.functionDeclaration(
        taskPath,
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
    const sort = context.functionDeclaration(
        taskPath,
        "sortTransparentBindings",
    );
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
            ["wc", { cpp: "center", type: "f64-buffer", absentCpp: "false" }],
            ["v", { cpp: "view", type: "f64-buffer" }],
        ]),
    }).expression(assignments[0]!.right);
    const factory = context.functionDeclaration(
        "src/sprite/billboard-sprite.ts",
        "createBillboardSystem",
    );
    const order = context.propertyInitializer(
        context.objectInitializer(factory.declaration, "system"),
        "order",
    );
    const orderCpp = new PinnedNumericLowerer(factory.file, {
        calls: new Map(),
        bindings: new Map<string, PinnedBinding>([
            [
                "opts.order",
                { ...scalar("options.order"), nullish: "!options.has_order" },
            ],
            ["depthMode", { cpp: "depth_mode", type: "string" }],
        ]),
    }).expression(order);
    return `// ${context.provenance(path, "refreshBillboardWorldCenter")}
inline void refresh_billboard_world_center(BillboardSystemRecord& record) {
${body}
}
struct BillboardOrderItem { std::size_t index; bool billboard; double distance; double order; };
// ${context.provenance(taskPath, "compareTransparentBindings, sortTransparentBindings")}
inline double compare_billboard_order(const BillboardOrderItem& a, const BillboardOrderItem& b) {
${compare}
}
template<class View> inline double billboard_sort_distance(const std::array<double, 3>& center, const View& view) {
    return ${distance};
}
// ${context.provenance("src/sprite/billboard-sprite.ts", "createBillboardSystem")}
inline double billboard_system_order(const BillboardSystemOptions& options, [[maybe_unused]] std::string_view depth_mode) {
    return ${orderCpp};
}
`;
}
