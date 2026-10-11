import ts from "typescript";
import { doubleLiteral } from "../cpp-literals.js";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerTupleComponents } from "./pinned-function-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

import { spriteFramesBinding } from "./pinned-sprite-storage.js";

/** Shared native transport for the columns read by particle sprite renderers. */
export const particleRenderColumns = [
    ["posX", "pos_x"],
    ["posY", "pos_y"],
    ["posZ", "pos_z"],
    ["size", "size"],
    ["scaleX", "scale_x"],
    ["scaleY", "scale_y"],
    ["angle", "angle"],
    ["colorR", "color_r"],
    ["colorG", "color_g"],
    ["colorB", "color_b"],
    ["colorA", "color_a"],
] as const;

export function particleRenderColumnsCpp(state: string): string {
    return `ParticleRenderColumns{${particleRenderColumns.map(([, native]) => `${state}.${native}`).join(", ")}}`;
}

export function particleRenderColumnsDeclaration(): string {
    return `struct ParticleRenderColumns {
${particleRenderColumns.map(([, native]) => `    std::span<const float> ${native};`).join("\n")}
};

template<class Cells>
double particle_sprite_cell(const Cells& cells, std::size_t index) {
    if (index >= cells.size()) throw std::runtime_error("Particle sprite-sheet cell index is undefined.");
    return static_cast<double>(cells[index]);
}`;
}

/** The full pinned billboard sync; only sprite-props storage is adapted. */
export function particleBillboardSync(context: LoweringContext): string {
    const path = "src/particle/particle-billboard.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "syncParticleBillboard",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["billboard", { cpp: "billboard", type: "opaque" }],
        ["system.buffer", { cpp: "columns", type: "opaque" }],
        ["system.buffer.alive", { cpp: "alive_count", type: "scalar" }],
        ["system._spriteSheet", { cpp: "has_cells", type: "bool" }],
        [
            "system._spriteSheet.cellIndex",
            { cpp: "cells", type: "u16", absentCpp: "!has_cells" },
        ],
    ]);
    for (const [source, native] of particleRenderColumns)
        bindings.set(`system.buffer.${source}`, {
            cpp: `columns.${native}`,
            type: "f32",
        });
    const fields = new Map<string, { cpp: string; arity?: number }>([
        ["position", { cpp: "position", arity: 3 }],
        ["sizeWorld", { cpp: "size_world", arity: 2 }],
        ["frame", { cpp: "frame" }],
        ["rotation", { cpp: "rotation" }],
        ["pivot", { cpp: "pivot", arity: 2 }],
        ["color", { cpp: "color", arity: 4 }],
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map([
            [
                "clearBillboardSprites",
                ([billboard]) =>
                    `clear_billboard_sprites(engine, ${billboard})`,
            ],
            [
                "addBillboardSpriteIndex",
                ([billboard, props]) =>
                    `add_billboard_sprite_index(engine, ${billboard}, ${props})`,
            ],
        ]),
        statement(statement, lowerer, indent) {
            if (
                !ts.isVariableStatement(statement) ||
                statement.declarationList.declarations.length !== 1
            )
                return undefined;
            const local = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(local.name) || !local.initializer)
                return undefined;
            const value = context.unwrapExpression(local.initializer);
            if (
                !ts.isConditionalExpression(value) ||
                value.whenFalse.kind !== ts.SyntaxKind.NullKeyword
            )
                return undefined;
            const view = lowerer.binding(value.whenTrue);
            if (view?.type !== "u16") return undefined;
            const present = `${local.name.text}_present`;
            lowerer.bindLocal(local.name, {
                ...view,
                absentCpp: `!${present}`,
            });
            return [
                `${indent}const bool ${present} = ${lowerer.expression(value.condition)};`,
            ];
        },
        expression(expression, lowerer) {
            if (
                ts.isElementAccessExpression(expression) &&
                lowerer.binding(expression.expression)?.cpp === "cells"
            )
                return `particle_sprite_cell(cells, static_cast<std::size_t>(${lowerer.expression(expression.argumentExpression)}))`;
            if (!ts.isObjectLiteralExpression(expression)) return undefined;
            const call = expression.parent;
            if (
                !ts.isCallExpression(call) ||
                !context.expressionMatchesShape(
                    call.expression,
                    "addBillboardSpriteIndex",
                ) ||
                call.arguments[1] !== expression
            )
                return undefined;
            const writes = expression.properties.map((property) => {
                if (!ts.isPropertyAssignment(property))
                    context.contractError(
                        property,
                        "Particle billboard props require named values.",
                    );
                const name = context.propertyName(property.name);
                const field = name && fields.get(name);
                if (!field)
                    context.contractError(
                        property,
                        "Unsupported particle billboard property.",
                    );
                const value = field.arity
                    ? `Vec${field.arity}d{${lowerTupleComponents(context, lowerer, property.initializer, { at: property, arity: field.arity }).join(", ")}}`
                    : lowerer.expression(property.initializer);
                return `props.${field.cpp} = ${value}; props.has_${field.cpp} = true;`;
            });
            return `([&]() { BillboardSpriteProps props; ${writes.join(" ")} return props; }())`;
        },
    });
    return `// ${context.provenance(path, "syncParticleBillboard")}
template<class Cells>
void sync_particle_billboard(Engine& engine, BillboardSystemHandle billboard,
    double alive_count, const ParticleRenderColumns& columns, const Cells& cells, bool has_cells) {
${body}
}`;
}

/** One source-derived sync for baked, continued and live particle buffers. */
export function particleSpriteSync(context: LoweringContext): string {
    const path = "src/particle/particle-sprite-2d.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "syncParticleSprite2DBridge",
    );
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    const spriteFile = context.sourceFile("src/sprite/sprite-2d.ts");
    const bindings = new Map<string, PinnedBinding>([
        ["layer", { cpp: "layer", type: "opaque" }],
        [
            "layer._handleHooks",
            { cpp: "(layer.next_sprite_id != 1u)", type: "bool" },
        ],
        ["bridge.pixelsPerUnit", scalar("pixels_per_unit")],
        ["bridge.originPx", { cpp: "origin", type: "f64-buffer" }],
        ["bridge.invertY", { cpp: "invert_y", type: "bool" }],
        ["system.buffer", { cpp: "columns", type: "opaque" }],
        ["system.buffer.alive", scalar("alive_count")],
        ["layer.count", scalar("static_cast<double>(layer.count)")],
        [
            "layer._instanceFloatsPerSprite",
            scalar("static_cast<double>(layer.instance_floats_per_sprite)"),
        ],
        [
            "layer._instanceData",
            { cpp: "layer.instance_data", type: "f32", mutable: true },
        ],
        [
            "layer._savedSize",
            { cpp: "layer.saved_size", type: "f32", mutable: true },
        ],
        [
            "system._spriteSheet?.cellIndex",
            { cpp: "cells", type: "u16", absentCpp: "!has_cells" },
        ],
        ["layer.atlas", { cpp: "atlas", type: "opaque" }],
        ["layer.atlas.frames", spriteFramesBinding("atlas.frames")],
        [
            "SAVED_SIZE_FLOATS_PER_SPRITE",
            scalar(
                doubleLiteral(
                    context.numericValue(
                        context.moduleScopeConstant(
                            spriteFile,
                            "SAVED_SIZE_FLOATS_PER_SPRITE",
                        )!,
                        spriteFile,
                    ),
                ),
            ),
        ],
    ]);
    for (const [source, native] of particleRenderColumns)
        bindings.set(`system.buffer.${source}`, {
            cpp: `columns.${native}`,
            type: "f32",
        });
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map([
            [
                "resolveSpriteFrame",
                ([atlas, index]) =>
                    `static_cast<double>(resolve_sprite_frame(${atlas}, ${index}))`,
            ],
            [
                "_setSprite2DCount",
                ([layer, count]) =>
                    `set_sprite_2d_count(${layer}, static_cast<std::uint32_t>(${count}))`,
            ],
            [
                "_markSprite2DDirty",
                ([layer, begin, end]) =>
                    `mark_sprite_2d_dirty(${layer}, static_cast<std::uint32_t>(${begin}), static_cast<std::uint32_t>(${end}))`,
            ],
        ]),
        statement(statement) {
            if (!ts.isVariableStatement(statement)) return undefined;
            const [binding] = statement.declarationList.declarations;
            if (!binding || !ts.isObjectBindingPattern(binding.name))
                return undefined;
            context.assertStatementShapes(
                statement,
                [statement],
                "const { system, layer } = bridge;",
                "Particle bridge owner transport",
            );
            return [];
        },
        expression(expression, lowerer) {
            if (
                !ts.isElementAccessExpression(expression) ||
                lowerer.binding(expression.expression)?.cpp !== "cells"
            )
                return undefined;
            return `particle_sprite_cell(cells, static_cast<std::size_t>(${lowerer.expression(expression.argumentExpression)}))`;
        },
    });
    return `// ${context.provenance(path, "syncParticleSprite2DBridge")}
template<class Cells>
void sync_particle_sprite_2d_bridge(Sprite2DLayerRecord& layer, const SpriteAtlasRecord& atlas,
    double pixels_per_unit, const std::array<double, 2>& origin, bool invert_y,
    double alive_count, const ParticleRenderColumns& columns, const Cells& cells, bool has_cells) {
${body}
}
`;
}
