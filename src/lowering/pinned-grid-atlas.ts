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
import { type LoweringContext } from "./context.js";
import { PinnedRecordModel } from "./pinned-record-lowerer.js";

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
            .has_premultiplied_alpha = true,
            .premultiplied_alpha = ${premultipliedAlpha}`
            }});`;
}

/** Lower the complete pinned grid factory, with texture and renderer adapters. */
export function gridSpriteAtlasCpp(context: LoweringContext): string {
    const model = new PinnedRecordModel(
        context,
        context.program.modules([atlasModule]),
        {
            records: [
                {
                    pinned: ["Texture2D"],
                    cpp: "GridAtlasTextureView",
                    reference: false,
                    native: true,
                    members: new Map(
                        ["width", "height"].map((field) => [
                            field,
                            { shape: { kind: "number" as const } },
                        ]),
                    ),
                },
                {
                    pinned: ["GridAtlasOptions"],
                    cpp: "PinnedGridAtlasOptions",
                    reference: false,
                },
                {
                    pinned: ["SpriteFrame"],
                    cpp: "PinnedGridSpriteFrame",
                    reference: false,
                },
                {
                    pinned: ["SpriteAtlas"],
                    cpp: "PinnedGridSpriteAtlas",
                    reference: false,
                    omit: new Map([
                        [
                            "_packState",
                            "Grid atlases do not carry shelf-packer state.",
                        ],
                        [
                            "_frames",
                            "Grid atlases expose their frames through the readonly list.",
                        ],
                    ]),
                },
            ],
            values: new Map(),
            adapters: new Map(),
        },
    );
    const lowered = model.lower([
        model.functionDeclaration(atlasModule, "createGridSpriteAtlas"),
    ]);
    const optionalFields = [
        "columns",
        "rows",
        "margin_px",
        "spacing_px",
        "premultiplied_alpha",
    ];
    return `namespace bbl {
struct GridAtlasTextureView { double width; double height; };
${model.structs(["GridAtlasOptions", "SpriteFrame", "SpriteAtlas"])}
${lowered.declarations}
${lowered.definitions}
namespace upstream {
inline void create_grid_sprite_atlas_frames(
    SpriteAtlasRecord& atlas, const GridSpriteAtlasOptions& options) {
    PinnedGridAtlasOptions input;
    input.cell_width_px = options.cell_width_px;
    input.cell_height_px = options.cell_height_px;
${optionalFields.map((field) => `    if (options.has_${field}) input.${field} = options.${field};`).join("\n")}
    if (options.has_pivot) input.pivot = js::Tuple<2>{options.pivot.x, options.pivot.y};
    const auto result = create_grid_sprite_atlas(
        GridAtlasTextureView{static_cast<double>(atlas.width), static_cast<double>(atlas.height)}, input);
    const auto vector = [](const js::Tuple<2>& pair) {
        return Vec2{static_cast<float>(pair[0]), static_cast<float>(pair[1])};
    };
    atlas.frames.clear();
    atlas.frames.reserve(result.frames.size());
    for (const auto& frame : result.frames) {
        atlas.frames.push_back(SpriteFrame{vector(frame.uv_min), vector(frame.uv_max),
            vector(frame.source_size_px), vector(frame.pivot)});
    }
    atlas.premultiplied_alpha = result.premultiplied_alpha;
}
} // namespace upstream
} // namespace bbl`;
}
