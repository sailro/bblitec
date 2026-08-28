import ts from "typescript";
import type { LoweringContext } from "./context.js";

const packerModule = "src/sprite/shared/sprite-atlas-packer.ts";

function initializer(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
    name: string,
): ts.Expression {
    const variable = context
        .findNodes(declaration.body!, ts.isVariableDeclaration)
        .find(
            (candidate) =>
                ts.isIdentifier(candidate.name) &&
                candidate.name.text === name,
        );
    if (!variable?.initializer) {
        context.contractError(
            declaration,
            `${declaration.name?.text ?? "Pinned atlas function"} no longer declares '${name}'.`,
        );
    }
    return variable.initializer;
}

/**
 * Assert the shelf placement and texture/frame construction that the native
 * runtime port emits for `createSpriteAtlasFromFrames`.
 *
 * The C++ implementation is deliberately direct because its inputs are
 * borrowed native pixel spans, but every formula it restates remains owned by
 * the pinned Babylon Lite implementation. A pin change therefore fails
 * generation instead of silently changing only the browser side.
 */
export function assertFrameAtlasRule(context: LoweringContext): void {
    const { declaration: shelf } = context.functionDeclaration(
        packerModule,
        "shelfPack",
    );
    const shelfExpressions: ReadonlyArray<readonly [string, string]> = [
        ["xs", "new Array<number>(sources.length)"],
        ["ys", "new Array<number>(sources.length)"],
        ["penX", "startPenX"],
        ["penY", "startPenY"],
        ["shelfHeight", "startShelfHeight"],
        ["contentWidth", "0"],
        ["srcX", "s.srcX ?? 0"],
        ["srcY", "s.srcY ?? 0"],
        ["srcStride", "s.srcStrideBytes ?? s.width * 4"],
        [
            "requiredBytes",
            "(srcY + s.height - 1) * srcStride + (srcX + s.width) * 4",
        ],
        ["rightEdge", "penX + s.width"],
        [
            "contentHeight",
            "sources.length === 0 ? startPenY : penY + shelfHeight",
        ],
    ];
    for (const [name, shape] of shelfExpressions) {
        context.assertExpressionShape(
            initializer(context, shelf, name),
            shape,
            `sprite frame-atlas shelf '${name}'`,
        );
    }

    const { declaration: create } = context.functionDeclaration(
        packerModule,
        "createSpriteAtlasFromFrames",
    );
    const createExpressions: ReadonlyArray<readonly [string, string]> = [
        ["padding", "options.paddingPx ?? 1"],
        ["requestedMaxWidth", "options.maxWidthPx ?? 1024"],
        [
            "maxWidth",
            "options.capacityPx ? Math.min(requestedMaxWidth, options.capacityPx[0]) : requestedMaxWidth",
        ],
        [
            "placement",
            'shelfPack(sources, padding, maxWidth, Number.MAX_SAFE_INTEGER, 0, 0, 0, "createSpriteAtlasFromFrames")',
        ],
        [
            "atlasWidth",
            "options.capacityPx ? options.capacityPx[0] : Math.max(1, placement.contentWidth)",
        ],
        [
            "atlasHeight",
            "options.capacityPx ? options.capacityPx[1] : Math.max(1, placement.contentHeight)",
        ],
        ["data", "new U8(atlasWidth * atlasHeight * 4)"],
        ["srcX", "s.srcX ?? 0"],
        ["srcY", "s.srcY ?? 0"],
        ["srcStride", "s.srcStrideBytes ?? s.width * 4"],
        ["rowBytes", "s.width * 4"],
        [
            "srcOffset",
            "(srcY + row) * srcStride + srcX * 4",
        ],
        [
            "dstOffset",
            "((placement.ys[i] + row) * atlasWidth + placement.xs[i]) * 4",
        ],
        ["sampling", 'options.sampling ?? "nearest"'],
        [
            "texture",
            "createTexture2DFromPixels(engine, data, atlasWidth, atlasHeight, { minFilter: sampling, magFilter: sampling, srgb: options.srgb ?? false })",
        ],
        ["frames", "new Array<SpriteFrame>(sources.length)"],
    ];
    for (const [name, shape] of createExpressions) {
        context.assertExpressionShape(
            initializer(context, create, name),
            shape,
            `sprite frame-atlas creation '${name}'`,
        );
    }

    const frameAssignment = context
        .findNodes(create.body!, ts.isBinaryExpression)
        .find(
            (candidate) =>
                candidate.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                candidate.left.getText().replace(/\s+/g, " ") ===
                    "frames[i]",
        );
    if (!frameAssignment) {
        context.contractError(
            create,
            "createSpriteAtlasFromFrames no longer assigns frames in source order.",
        );
    }
    context.assertExpressionShape(
        frameAssignment.right,
        "{ name: s.name, uvMin: [placement.xs[i] / atlasWidth, placement.ys[i] / atlasHeight], uvMax: [(placement.xs[i] + s.width) / atlasWidth, (placement.ys[i] + s.height) / atlasHeight], sourceSizePx: [s.width, s.height], pivot: s.pivot ?? [0.5, 0.5] }",
        "sprite frame-atlas frame record",
    );
}
