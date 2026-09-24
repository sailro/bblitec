// `createGridSpriteAtlas`, lowered once.
//
// Two loaders partition a texture into frames: `loadSpriteAtlas`, which the
// sprite and billboard families reach, and the particle bridge, whose atlas
// `createParticleBillboard` builds over a `loadTexture2D` texture instead --
// and scene code reaches the factory itself over a file, pixel or render
// texture. They differ only in how the texture arrived and which sampler it
// carries, so the partition -- the pin's own row-major grid, its defaulted
// margins, its floor-and-max column count and its four frame fields -- is
// translated from the pinned declaration into one function every caller
// shares.
import ts from "typescript";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

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
        pal::decode_image(js::ArrayBuffer(file_bytes));
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
 * The call a grid loader makes once `atlas` holds the decoded texture, with
 * `cell_w` and `cell_h` doubles in scope: the pin's own loaders name the two
 * cell sizes (and `loadSpriteAtlas` its premultiplied flag) and leave every
 * other option to the factory's defaults, so the options record names only
 * those and its omitted members are the absent ones.
 */
export function gridSpriteAtlasFramesCpp(premultipliedAlpha?: string): string {
    return `    // createGridSpriteAtlas(texture, { cellWidthPx, cellHeightPx${
        premultipliedAlpha === undefined ? "" : ", premultipliedAlpha"
    } }).
    bbl::upstream::create_grid_sprite_atlas_frames(
        atlas,
        bbl::GridSpriteAtlasOptions{
            .cell_width_px = cell_w,
            .cell_height_px = cell_h${
                premultipliedAlpha === undefined
                    ? ""
                    : `,
            .premultiplied_alpha = ${premultipliedAlpha}`
            }});`;
}

/**
 * The options `GridSpriteAtlasOptions` carries on its own members: each
 * pinned read, and the member the value lands in. The native record keeps
 * every one of them, so a read here takes the record's value -- the
 * record's member default is what an omitted option holds, which is why
 * `nullishOptions` below checks that default against the pin's own `??`.
 */
const optionMembers: ReadonlyArray<
    readonly [string, string, "scalar" | "bool"]
> = [
    ["options.cellWidthPx", "options.cell_width_px", "scalar"],
    ["options.cellHeightPx", "options.cell_height_px", "scalar"],
    ["options.marginPx", "options.margin_px", "scalar"],
    ["options.spacingPx", "options.spacing_px", "scalar"],
    ["options.premultipliedAlpha", "options.premultiplied_alpha", "bool"],
];

/**
 * The `?? <literal>` fallbacks the native record resolves through its member
 * defaults, and the default it declares. A pin that moves one fails here by
 * name rather than partitioning with the record's stale default.
 */
const nullishOptions: ReadonlyMap<string, string> = new Map([
    ["options.marginPx", "0"],
    ["options.spacingPx", "0"],
    ["options.premultipliedAlpha", "false"],
]);

/**
 * The options the native record carries with an explicit presence flag, so
 * the pin's own `??` right side is what an absent one takes.
 */
const presenceOptions: ReadonlyMap<string, { present: string; cpp: string }> =
    new Map([
        [
            "options.columns",
            { present: "options.has_columns", cpp: "options.columns" },
        ],
        ["options.rows", { present: "options.has_rows", cpp: "options.rows" }],
    ]);

/** `SpriteFrame`'s members, in the order the native aggregate declares them. */
const frameFields: readonly string[] = [
    "uvMin",
    "uvMax",
    "sourceSizePx",
    "pivot",
];

/**
 * `createGridSpriteAtlas`, translated from its declaration into
 * `create_grid_sprite_atlas_frames(atlas, options)`.
 *
 * The native atlas record is filled in place rather than returned: its
 * texture has already arrived (decoded, uploaded or rendered) by the time
 * any caller partitions it, so the pin's `texture` is that record and the
 * record literal the pin returns is those same fields -- `frames` pushed
 * into, `textureSizePx` the width and height already on it, and the one
 * value the literal computes, `premultipliedAlpha`, stored.
 */
export function gridSpriteAtlasCpp(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        atlasModule,
        "createGridSpriteAtlas",
    );
    const [texture, options] = declaration.parameters;
    if (
        declaration.parameters.length !== 2 ||
        !texture ||
        !options ||
        texture.name.getText(file) !== "texture" ||
        texture.type?.getText(file) !== "Texture2D" ||
        options.name.getText(file) !== "options" ||
        options.type?.getText(file) !== "GridAtlasOptions"
    ) {
        context.contractError(
            declaration,
            "Expected pinned createGridSpriteAtlas(texture: Texture2D, options: GridAtlasOptions).",
        );
    }
    const bindings = new Map<string, PinnedBinding>([
        [
            "texture.width",
            { cpp: "static_cast<double>(atlas.width)", type: "scalar" },
        ],
        [
            "texture.height",
            { cpp: "static_cast<double>(atlas.height)", type: "scalar" },
        ],
        ...optionMembers.map(([pinned, cpp, type]): [string, PinnedBinding] => [
            pinned,
            { cpp, type },
        ]),
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: pinnedNumericMathCalls(),
        expression: (node, lowerer) => {
            if (
                !ts.isBinaryExpression(node) ||
                node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
            ) {
                return undefined;
            }
            const read = unwrapExpression(node.left).getText(file);
            const presence = presenceOptions.get(read);
            if (presence) {
                return `(${presence.present} ? ${presence.cpp} : ${lowerer.expression(node.right)})`;
            }
            const fallback = nullishOptions.get(read);
            if (fallback !== undefined) {
                context.assertExpressionShape(
                    node.right,
                    fallback,
                    `createGridSpriteAtlas ${read} default (GridSpriteAtlasOptions' own)`,
                );
                return bindings.get(read)!.cpp;
            }
            return undefined;
        },
        statement: (statement, lowerer, indent) =>
            gridAtlasStatement(context, statement, lowerer, indent, bindings),
    });
    return `// ${context.provenance(atlasModule, "createGridSpriteAtlas")}
inline void create_grid_sprite_atlas_frames(
    SpriteAtlasRecord& atlas,
    const GridSpriteAtlasOptions& options) {
${body}
}`;
}

/**
 * The statements of the pinned body that build JavaScript records rather
 * than numbers: the pivot pair, the growing frame list, each frame literal
 * and the returned atlas. Everything else -- the cell sizes, the defaulted
 * margins, the column and row counts and the per-cell arithmetic -- goes
 * through the ordinary translator.
 */
function gridAtlasStatement(
    context: LoweringContext,
    statement: ts.Statement,
    lowerer: PinnedNumericLowerer,
    indent: string,
    bindings: Map<string, PinnedBinding>,
): readonly string[] | undefined {
    if (ts.isVariableStatement(statement)) {
        const [local] = statement.declarationList.declarations;
        if (
            statement.declarationList.declarations.length !== 1 ||
            !local ||
            !ts.isIdentifier(local.name) ||
            !local.initializer
        ) {
            return undefined;
        }
        if (local.name.text === "pivot") {
            // `options.pivot ?? [0.5, 0.5]`: the native record's `pivot`
            // member holds the caller's pair or that default.
            context.assertExpressionShape(
                local.initializer,
                "options.pivot ?? [0.5, 0.5]",
                "createGridSpriteAtlas pivot (GridSpriteAtlasOptions' own default)",
            );
            bindings.set("pivot[0]", {
                cpp: "static_cast<double>(options.pivot.x)",
                type: "scalar",
            });
            bindings.set("pivot[1]", {
                cpp: "static_cast<double>(options.pivot.y)",
                type: "scalar",
            });
            return [];
        }
        if (local.name.text === "frames") {
            context.assertExpressionShape(
                local.initializer,
                "[]",
                "createGridSpriteAtlas frame list",
            );
            return [];
        }
        return undefined;
    }
    if (ts.isExpressionStatement(statement)) {
        const call = unwrapExpression(statement.expression);
        if (
            !ts.isCallExpression(call) ||
            call.expression.getText() !== "frames.push"
        ) {
            return undefined;
        }
        const frame = call.arguments[0]
            ? unwrapExpression(call.arguments[0])
            : undefined;
        if (
            call.arguments.length !== 1 ||
            !frame ||
            !ts.isObjectLiteralExpression(frame) ||
            frame.properties.length !== frameFields.length
        ) {
            return context.contractError(
                call,
                `Expected pinned createGridSpriteAtlas to push one ${frameFields.length}-field frame literal.`,
            );
        }
        const pairs = frameFields.map((name) => {
            const pair = unwrapExpression(
                context.propertyInitializer(frame, name),
            );
            if (
                !ts.isArrayLiteralExpression(pair) ||
                pair.elements.length !== 2
            ) {
                return context.contractError(
                    pair,
                    `Expected pinned grid frame ${name} to be a pair.`,
                );
            }
            return `Vec2{${pair.elements
                .map(
                    (element) =>
                        `static_cast<float>(${lowerer.expression(element)})`,
                )
                .join(", ")}}`;
        });
        return [
            `${indent}atlas.frames.push_back(SpriteFrame{`,
            ...pairs.map(
                (pair, index) =>
                    `${indent}    ${pair}${index + 1 < pairs.length ? "," : "});"}`,
            ),
        ];
    }
    if (ts.isReturnStatement(statement)) {
        const record = statement.expression
            ? unwrapExpression(statement.expression)
            : undefined;
        if (!record || !ts.isObjectLiteralExpression(record)) {
            return context.contractError(
                statement,
                "Expected pinned createGridSpriteAtlas to return an atlas literal.",
            );
        }
        // The three fields the native record already holds, and the one
        // the literal computes, stored below.
        const held: ReadonlyArray<readonly [string, string]> = [
            ["texture", "texture"],
            ["textureSizePx", "[tw, th]"],
            ["frames", "frames"],
        ];
        if (record.properties.length !== held.length + 1) {
            context.contractError(
                record,
                `A grid atlas carries ${record.properties.length} fields; ${held.length + 1} are lowered.`,
            );
        }
        for (const [name, shape] of held) {
            context.assertExpressionShape(
                context.propertyInitializer(record, name),
                shape,
                `createGridSpriteAtlas ${name}`,
            );
        }
        return [
            `${indent}atlas.premultiplied_alpha = ${lowerer.expression(
                context.propertyInitializer(record, "premultipliedAlpha"),
            )};`,
        ];
    }
    return undefined;
}
