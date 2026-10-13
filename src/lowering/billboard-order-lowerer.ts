import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

/** Billboard centers and system order come from the renderable and system source; their transparent order is `transparent_order.hpp`. */
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
// ${context.provenance("src/sprite/billboard-sprite.ts", "createBillboardSystem")}
inline double billboard_system_order(const BillboardSystemOptions& options, [[maybe_unused]] std::string_view depth_mode) {
    return ${orderCpp};
}
`;
}
