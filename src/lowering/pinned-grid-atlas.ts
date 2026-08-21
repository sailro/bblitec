// `createGridSpriteAtlas`, emitted once.
//
// Two loaders partition a texture into frames: `loadSpriteAtlas`, which the
// sprite and billboard families reach, and the particle bridge, whose atlas
// `createParticleBillboard` builds over a `loadTexture2D` texture instead.
// They differ only in how the texture arrived and which sampler it carries,
// so the partition itself -- the pin's own row-major grid, its two defaulted
// margins, its floor-and-max column count and its four frame fields -- is
// emitted from one place and asserted against the pinned declaration here.
import ts from "typescript";
import type { LoweringContext } from "./context.js";

const atlasModule = "src/sprite/shared/sprite-atlas.ts";

/**
 * The statements that decode `path` into a `SpriteAtlasRecord atlas`.
 *
 * Both atlas loaders begin here: `loadSpriteAtlas` and the grid a particle
 * graph's `loadTexture2D` texture is partitioned into. The pin decodes
 * before it grids in both, because the frame table is derived from the
 * texture's own size.
 */
export function decodeAtlasImageCpp(): string {
    return `    SpriteAtlasRecord atlas;
    // loadTexture2D fetches, decodes and uploads before the grid is
    // built, so the decode has to happen here too: the frame table is
    // derived from the texture's own size.
    const std::vector<std::uint8_t> file_bytes =
        pal::read_binary_file(path);
    const pal::DecodedImage image =
        pal::decode_image(ts::ArrayBuffer(file_bytes));
    atlas.rgba = image.rgba;
    atlas.width = static_cast<std::uint32_t>(image.width);
    atlas.height = static_cast<std::uint32_t>(image.height);`;
}

/** The statements that hand the filled `atlas` back as its handle. */
export function pushAtlasHandleCpp(): string {
    return `    engine.sprite_atlases.push_back(std::move(atlas));
    return SpriteAtlasHandle{
        static_cast<std::uint32_t>(
            engine.sprite_atlases.size() - 1u)};`;
}

/**
 * The statements that fill `atlas.frames`, given `cell_w` and `cell_h`
 * doubles already in scope and an `atlas` whose width and height are set.
 */
export function gridSpriteAtlasFramesCpp(
    context: LoweringContext,
): string {
    assertGridRule(context);
    return `    const double margin = 0.0;
    const double spacing = 0.0;
    const double tw = static_cast<double>(atlas.width);
    const double th = static_cast<double>(atlas.height);
    const double columns = std::max(
        1.0,
        std::floor((tw - margin * 2.0 + spacing) / (cell_w + spacing)));
    const double rows = std::max(
        1.0,
        std::floor((th - margin * 2.0 + spacing) / (cell_h + spacing)));
    const double pivot_x = 0.5;
    const double pivot_y = 0.5;
    for (double r = 0.0; r < rows; r += 1.0) {
        for (double c = 0.0; c < columns; c += 1.0) {
            const double x = margin + c * (cell_w + spacing);
            const double y = margin + r * (cell_h + spacing);
            SpriteFrame frame;
            frame.uv_min = Vec2{
                static_cast<float>(x / tw),
                static_cast<float>(y / th)};
            frame.uv_max = Vec2{
                static_cast<float>((x + cell_w) / tw),
                static_cast<float>((y + cell_h) / th)};
            frame.source_size_px = Vec2{
                static_cast<float>(cell_w),
                static_cast<float>(cell_h)};
            frame.pivot = Vec2{
                static_cast<float>(pivot_x),
                static_cast<float>(pivot_y)};
            atlas.frames.push_back(frame);
        }
    }`;
}

/**
 * The pinned partition, asserted term by term.
 *
 * Everything the emitted C++ folds -- the two zero defaults, the half-pivot,
 * both dimension formulas and the four fields a frame carries -- is stated
 * once in the pin and checked once here, so a pin that adds a margin or
 * moves a pivot fails generation rather than partitioning differently.
 */
function assertGridRule(context: LoweringContext): void {
    const { declaration } = context.functionDeclaration(
        atlasModule,
        "createGridSpriteAtlas",
    );
    const initializer = (name: string): ts.Expression => {
        const found = context
            .findNodes(declaration.body!, ts.isVariableDeclaration)
            .find(
                (candidate) =>
                    ts.isIdentifier(candidate.name) &&
                    candidate.name.text === name,
            );
        if (!found?.initializer) {
            context.contractError(
                declaration,
                `createGridSpriteAtlas no longer declares '${name}'.`,
            );
        }
        return found.initializer;
    };
    context.assertExpressionShape(
        initializer("cellW"),
        "options.cellWidthPx",
        "grid atlas cell width",
    );
    context.assertExpressionShape(
        initializer("cellH"),
        "options.cellHeightPx",
        "grid atlas cell height",
    );
    context.assertExpressionShape(
        initializer("margin"),
        "options.marginPx ?? 0",
        "grid atlas margin",
    );
    context.assertExpressionShape(
        initializer("spacing"),
        "options.spacingPx ?? 0",
        "grid atlas spacing",
    );
    context.assertExpressionShape(
        initializer("cols"),
        "options.columns ?? Math.max(1, Math.floor((texture.width - margin * 2 + spacing) / (cellW + spacing)))",
        "grid atlas columns",
    );
    context.assertExpressionShape(
        initializer("rows"),
        "options.rows ?? Math.max(1, Math.floor((texture.height - margin * 2 + spacing) / (cellH + spacing)))",
        "grid atlas rows",
    );
    context.assertExpressionShape(
        initializer("pivot"),
        "options.pivot ?? [0.5, 0.5]",
        "grid atlas pivot",
    );
    const frame = context
        .findNodes(declaration.body!, ts.isObjectLiteralExpression)
        .find((candidate) =>
            candidate.properties.some(
                (property) =>
                    property.name !== undefined &&
                    context.propertyName(property.name) === "uvMin",
            ),
        );
    if (!frame) {
        context.contractError(
            declaration,
            "createGridSpriteAtlas no longer builds frame records.",
        );
    }
    const expected: ReadonlyArray<readonly [string, string]> = [
        ["uvMin", "[x / tw, y / th]"],
        ["uvMax", "[(x + cellW) / tw, (y + cellH) / th]"],
        ["sourceSizePx", "[cellW, cellH]"],
        ["pivot", "[pivot[0], pivot[1]]"],
    ];
    if (frame.properties.length !== expected.length) {
        context.contractError(
            frame,
            `A grid atlas frame carries ${frame.properties.length} ` +
                `fields; ${expected.length} are lowered.`,
        );
    }
    for (const [name, shape] of expected) {
        context.assertExpressionShape(
            context.propertyInitializer(frame, name),
            shape,
            `grid atlas frame ${name}`,
        );
    }
}
