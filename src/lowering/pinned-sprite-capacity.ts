import ts from "typescript";
import { type LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

const modulePath = "src/sprite/sprite-2d.ts";

/** Source capacity arithmetic and buffer copies, with checked native storage limits. */
export function lowerSpriteCapacity(context: LoweringContext): string {
    const factory = context.functionDeclaration(
        modulePath,
        "createSprite2DLayer",
    );
    const initializer = context.variableInitializer(
        factory.declaration,
        "capacity",
    );
    const capacity = new PinnedNumericLowerer(factory.file, {
        bindings: new Map([
            [
                "opts.capacity",
                { cpp: "value", type: "scalar", nullish: "false" },
            ],
        ]),
        calls: new Map(),
    }).expression(initializer);
    const growth = context.functionDeclaration(modulePath, "growCapacity");
    const body = lowerPinnedBody(
        growth.file,
        growth.declaration.body!.statements,
        {
            bindings: new Map<string, PinnedBinding>([
                ["layer._capacity", { cpp: "layer.capacity", type: "scalar" }],
                [
                    "layer._instanceFloatsPerSprite",
                    { cpp: "layer.instance_floats_per_sprite", type: "scalar" },
                ],
                [
                    "layer._instanceData",
                    { cpp: "layer.instance_data", type: "f32" },
                ],
                ["layer._savedSize", { cpp: "layer.saved_size", type: "f32" }],
                ["minCapacity", { cpp: "min_capacity", type: "scalar" }],
            ]),
            calls: new Map(),
            allocationSize: (count, element) => {
                if (element !== "float")
                    context.contractError(
                        growth.declaration,
                        "Sprite storage requires Float32Array allocations.",
                    );
                return `checked_sprite_floats(${count})`;
            },
            statement: (statement, lowerer, indent) => {
                if (
                    ts.isExpressionStatement(statement) &&
                    ts.isBinaryExpression(statement.expression) &&
                    statement.expression.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    context.expressionMatchesShape(
                        statement.expression.left,
                        "layer._capacity",
                    )
                )
                    return [
                        `${indent}layer.capacity = gpu_u32(gpu_size(${lowerer.expression(statement.expression.right)}));`,
                    ];
                return undefined;
            },
        },
    );
    return `std::size_t checked_sprite_floats(double value) {
    const std::size_t count = gpu_size(value);
    if (count > std::vector<float>{}.max_size() || count > std::numeric_limits<std::uint32_t>::max() / sizeof(float))
        throw std::length_error("Sprite buffer exceeds native storage limits.");
    return count;
}
std::uint32_t sprite_capacity(double value) {
    return gpu_u32(gpu_size(${capacity}));
}
void resize_sprite_storage(Sprite2DLayerRecord& layer, double value) {
    const std::uint32_t capacity = gpu_u32(gpu_size(value));
    const auto instances = checked_sprite_floats(static_cast<double>(capacity) * layer.instance_floats_per_sprite);
    const auto saved = checked_sprite_floats(static_cast<double>(capacity) * sprite_saved_size_floats);
    layer.instance_data.resize(instances);
    layer.saved_size.resize(saved);
    layer.capacity = capacity;
}
void grow_sprite_capacity(Sprite2DLayerRecord& layer, double min_capacity) {
    (void)gpu_size(min_capacity);
    if (layer.capacity == 0u) throw std::runtime_error("Sprite capacity must be positive before growth.");
${body}
    layer.dirty_sprite_begin = layer.count == 0u ? invalid_handle : 0u;
    layer.dirty_sprite_end = layer.count;
}
`;
}
