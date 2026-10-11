import { type LoweringContext } from "./context.js";
import { spriteAtlasFramesCpp } from "./pinned-grid-atlas.js";
import { PinnedRecordModel } from "./pinned-record-lowerer.js";
import { textureFilterByPin } from "../pinned-address-modes.js";
import { stringLiteral } from "../cpp-literals.js";

const packerModule = "src/sprite/shared/sprite-atlas-packer.ts";

/** Lower the complete shelf packer and factory; native code only transports pixels and records. */
export function frameSpriteAtlasCpp(context: LoweringContext): string {
    const records = [
        "SpriteAtlasFrameSource",
        "SpriteAtlasPackOptions",
        "SpriteFrame",
        "SpriteAtlasPackState",
        "SpriteAtlas",
        "ShelfPackResult",
        "PixelsTexture2DOptions",
    ];
    const model = new PinnedRecordModel(
        context,
        context.program.modules([packerModule]),
        {
            records: records.map((pinned) => ({
                pinned: [pinned],
                cpp: `Packed${pinned}`,
                reference: false,
            })),
            values: new Map([
                ["EngineContext", { kind: "native", cpp: "bbl::Engine&" }],
                ["Texture2D", { kind: "native", cpp: "PackedAtlasTexture" }],
            ]),
            adapters: new Map([
                [
                    "src/texture/pixels-texture.ts#createTexture2DFromPixels",
                    {
                        cpp: (argument) =>
                            `pack_atlas_texture(${argument(0)}, ${argument(1)}, ${argument(2)}, ${argument(3)}, ${argument(4)})`,
                    },
                ],
            ]),
        },
    );
    const lowered = model.lower([
        model.functionDeclaration(packerModule, "createSpriteAtlasFromFrames"),
    ]);
    return `namespace bbl {
struct PackedAtlasTexture {
    js::TypedArray<std::uint8_t> pixels;
    double width;
    double height;
    TextureFilter min_filter;
    TextureFilter mag_filter;
};
${model.structs(records)}
inline TextureFilter packed_atlas_filter(const std::string& name) {
${Object.entries(textureFilterByPin)
    .map(
        ([name, cpp]) =>
            `    if (name == ${stringLiteral(name)}) return ${cpp};`,
    )
    .join("\n")}
    throw std::runtime_error("Unsupported atlas texture filter.");
}
inline PackedAtlasTexture pack_atlas_texture([[maybe_unused]] Engine& engine, js::TypedArray<std::uint8_t> pixels,
    double width, double height, const PackedPixelsTexture2DOptions& options) {
    if (options.address_mode_u || options.address_mode_v ||
        (options.srgb && *options.srgb)) {
        throw std::runtime_error("Unsupported packed atlas texture options.");
    }
    return {std::move(pixels), width, height,
        packed_atlas_filter(js::present(options.min_filter)),
        packed_atlas_filter(js::present(options.mag_filter))};
}
${lowered.declarations}
${lowered.definitions}
namespace upstream {
inline void pack_sprite_atlas(SpriteAtlasRecord& atlas, Engine& engine,
    const std::vector<SpriteAtlasFramePixelsView>& sources, const SpriteAtlasPackOptions& options) {
    js::Array<PackedSpriteAtlasFrameSource> inputs;
    inputs.reserve(sources.size());
    for (const auto& source : sources) {
        PackedSpriteAtlasFrameSource input;
        input.pixels = js::TypedArray<std::uint8_t>(source.pixels->buffer(),
            static_cast<double>(source.pixels->byte_offset()), static_cast<double>(source.pixels->size()));
        input.width = source.width;
        input.height = source.height;
        if (source.src_x) input.src_x = *source.src_x;
        if (source.src_y) input.src_y = *source.src_y;
        if (source.src_stride_bytes) input.src_stride_bytes = *source.src_stride_bytes;
        if (source.pivot) input.pivot = js::Tuple<2>{source.pivot->x, source.pivot->y};
        inputs.push_back(std::move(input));
    }
    PackedSpriteAtlasPackOptions named;
    if (options.padding_px) named.padding_px = *options.padding_px;
    if (options.max_width_px) named.max_width_px = *options.max_width_px;
    if (options.sampling) named.sampling = *options.sampling;
    if (options.premultiplied_alpha) named.premultiplied_alpha = *options.premultiplied_alpha;
    if (options.capacity_px) named.capacity_px = js::Tuple<2>{options.capacity_px->x, options.capacity_px->y};
    const auto result = create_sprite_atlas_from_frames(engine, inputs, named);
    atlas.width = js::to_uint32(result.texture.width);
    atlas.height = js::to_uint32(result.texture.height);
    atlas.rgba = result.texture.pixels.storage();
    atlas.premultiplied_alpha = result.premultiplied_alpha;
    atlas.mip_maps = false;
    atlas.sampler.min_filter = result.texture.min_filter;
    atlas.sampler.mag_filter = result.texture.mag_filter;
    atlas.sampler.mipmap_mode = TextureMipmapMode::nearest;
    atlas.sampler.address_u = TextureAddressMode::clamp;
    atlas.sampler.address_v = TextureAddressMode::clamp;
    atlas.sampler.max_anisotropy = 1.0f;
    atlas.sampler.max_lod = 0.0f;
${spriteAtlasFramesCpp("atlas.frames", "result.frames")}
}
} // namespace upstream
} // namespace bbl`;
}
