import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    lowerPinnedBody,
    lowerPinnedStatements,
    type PinnedBodyScope,
} from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";

import {
    spriteFramesBinding,
    spritePropsBindings,
} from "./pinned-sprite-storage.js";

const modulePath = "src/sprite/billboard-sprite.ts";

/** Native record/view boundaries for the pin's complete instance writers. */
export function lowerBillboardInstances(context: LoweringContext): string {
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    const bindings = (): Map<string, PinnedBinding> =>
        new Map<string, PinnedBinding>([
            ["system", { cpp: "system", type: "opaque" }],
            ["system.atlas", { cpp: "atlas", type: "opaque" }],
            ["system.atlas.frames", spriteFramesBinding("atlas.frames")],
            [
                "system._instanceData",
                { cpp: "system.instance_data", type: "f32" },
            ],
            ["system._savedSize", { cpp: "system.saved_size", type: "f32" }],
            ["system._anchor", { cpp: "system.anchor", type: "f64-buffer" }],
            ["system.count", scalar("system.count")],
            ["system._capacity", scalar("system.capacity")],
        ]);
    const props = (
        target: Map<string, PinnedBinding>,
        source: string,
    ): void => {
        for (const [name, binding] of spritePropsBindings(source, "billboard"))
            target.set(name, binding);
    };
    const calls: PinnedNumericScope["calls"] = new Map([
        [
            "resolveSpriteFrame",
            (args) => `upstream::resolve_sprite_frame(${args.join(", ")})`,
        ],
        [
            "writeInstance",
            (args) =>
                `write_billboard_instance(${args[0]}, atlas, ${args[1]}, ${args[2]}, ${args[3] === "nullptr" ? "nullptr" : `&${args[3]}`})`,
        ],
        [
            "growCapacity",
            (args) => `grow_billboard_capacity(${args.join(", ")})`,
        ],
        [
            "setBillboardCount",
            (args) => `(${args[0]}.count = gpu_u32(gpu_size(${args[1]})))`,
        ],
        // Native uploads use a version stamp rather than the source's dirty range.
        ["markDirty", (args) => `(${args[0]}.instance_version += 1u)`],
    ]);
    const lower = (
        name: string,
        inputs: Map<string, PinnedBinding>,
        options: Partial<Omit<PinnedBodyScope, "bindings" | "calls">> = {},
    ): string => {
        const { file, declaration } = context.functionDeclaration(
            modulePath,
            name,
        );
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: inputs,
            calls,
            expression: (node) =>
                node.kind === ts.SyntaxKind.NullKeyword ? "nullptr" : undefined,
            ...options,
        });
    };
    const writeBindings = bindings();
    props(writeBindings, "props");
    writeBindings.set("slotIndex", scalar("index"));
    writeBindings.set("prev", {
        cpp: "(*prev)",
        type: "f32",
        absentCpp: "prev == nullptr",
        absentValue: "null",
    });
    const write = lower("writeInstance", writeBindings);
    const growthBindings = bindings();
    growthBindings.set("minCapacity", scalar("min_capacity"));
    const growth = context.functionDeclaration(modulePath, "growCapacity");
    const capacityStatements = growth.declaration.body!.statements;
    const allocation = capacityStatements.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (entry) =>
                    entry.initializer && ts.isNewExpression(entry.initializer),
            ),
    );
    if (allocation < 0)
        context.contractError(
            growth.declaration,
            "Expected billboard buffer allocation.",
        );
    const growthLowerer = new PinnedNumericLowerer(growth.file, {
        bindings: growthBindings,
        calls,
        statement: (statement, lowerer, indent) => {
            if (
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                context.expressionMatchesShape(
                    statement.expression.left,
                    "system._capacity",
                )
            ) {
                return [
                    `${indent}system.capacity = gpu_u32(gpu_size(${lowerer.expression(statement.expression.right)}));`,
                ];
            }
            return undefined;
        },
    });
    const growPrefix = lowerPinnedStatements(
        growthLowerer,
        capacityStatements.slice(0, allocation),
    );
    const capacityValue = context.variableInitializer(
        growth.declaration,
        "capacity",
    ).parent;
    if (
        !ts.isVariableDeclaration(capacityValue) ||
        !ts.isIdentifier(capacityValue.name)
    )
        context.contractError(
            capacityValue,
            "Expected the billboard capacity local.",
        );
    const checkedCapacity = growthLowerer.expression(capacityValue.name);
    const grow = `${growPrefix}
    (void)gpu_u32(gpu_size(${checkedCapacity}));
${lowerPinnedStatements(growthLowerer, capacityStatements.slice(allocation))}`;
    const addBindings = bindings();
    props(addBindings, "props");
    const add = lower("addBillboardSpriteIndex", addBindings, {
        returnValue: (expression, lowerer) => lowerer.expression(expression!),
    });
    const updateBindings = bindings();
    props(updateBindings, "patch");
    updateBindings.set("index", scalar("index"));
    const update = lower("updateBillboardSpriteIndex", updateBindings, {
        statement: (statement, lowerer, indent) => {
            if (
                !ts.isVariableStatement(statement) ||
                statement.declarationList.declarations.length !== 1
            )
                return undefined;
            const variable = statement.declarationList.declarations[0]!;
            if (
                !ts.isIdentifier(variable.name) ||
                variable.name.text !== "prev"
            )
                return undefined;
            const initializer = variable.initializer;
            if (
                !initializer ||
                !ts.isCallExpression(initializer) ||
                !ts.isPropertyAccessExpression(initializer.expression) ||
                initializer.expression.name.text !== "subarray" ||
                initializer.arguments.length !== 2
            )
                return context.contractError(
                    variable,
                    "Expected the previous billboard typed-array view.",
                );
            const owner = lowerer.expression(initializer.expression.expression);
            const start = lowerer.expression(initializer.arguments[0]!);
            const end = lowerer.expression(initializer.arguments[1]!);
            lowerer.bindLocal(variable.name, { cpp: "prev", type: "f32" });
            return [
                `${indent}const auto prev = std::span<const float>(${owner}).subspan(gpu_size(${start}), gpu_size(${end}) - gpu_size(${start}));`,
            ];
        },
    });
    const frameBindings = bindings();
    frameBindings.set("index", scalar("index"));
    frameBindings.set("frame", scalar("frame"));
    const frame = lower("setBillboardSpriteFrameIndex", frameBindings);
    return `// ${context.provenance(modulePath, "writeInstance, growCapacity, addBillboardSpriteIndex, updateBillboardSpriteIndex, setBillboardSpriteFrameIndex")}
static void resize_billboard_storage(BillboardSystemRecord& system, double value) {
    const std::uint32_t capacity = gpu_u32(gpu_size(value));
    const std::size_t instance_stride = system.instance_floats_per_sprite;
    constexpr std::size_t anchor_stride = upstream::billboard_anchor_floats_per_sprite;
    constexpr std::size_t saved_stride = upstream::billboard_saved_size_floats_per_sprite;
    if (capacity > system.instance_data.max_size() / instance_stride ||
        capacity > system.anchor.max_size() / anchor_stride ||
        capacity > system.saved_size.max_size() / saved_stride) {
        throw std::length_error("Billboard capacity exceeds native storage.");
    }
    system.instance_data.resize(static_cast<std::size_t>(capacity) * instance_stride);
    system.anchor.resize(static_cast<std::size_t>(capacity) * anchor_stride);
    system.saved_size.resize(static_cast<std::size_t>(capacity) * saved_stride);
    system.capacity = capacity;
}
static void grow_billboard_capacity(BillboardSystemRecord& system, double min_capacity) {
${grow}
}
static void write_billboard_instance(BillboardSystemRecord& system, const SpriteAtlasRecord& atlas,
    double index, const BillboardSpriteProps& props, const std::span<const float>* prev) {
${write}
}
static double append_billboard_instance(BillboardSystemRecord& system, const SpriteAtlasRecord& atlas,
    const BillboardSpriteProps& props) {
${add}
}
static void update_billboard_instance(BillboardSystemRecord& system, const SpriteAtlasRecord& atlas,
    double index, const BillboardSpriteProps& props) {
${update}
}
static void set_billboard_instance_frame(BillboardSystemRecord& system, const SpriteAtlasRecord& atlas,
    double index, double frame) {
${frame}
}
`;
}
