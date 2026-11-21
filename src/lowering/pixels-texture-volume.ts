import ts from "typescript";
import {
    addressModeByPin,
    textureFilterByPin,
} from "../pinned-address-modes.js";
import type { LoweringContext } from "./context.js";
import { pinnedErrorCode, pinnedErrorMessageCpp } from "./pinned-error.js";
import { jsToUint32Call } from "./pinned-operators.js";

const pixelsTextureModule = "src/texture/pixels-texture.ts";

/**
 * `createTexture3DFromPixels` (pixels-texture.ts): the pin's two refusals,
 * its byte count, its format, and the sampler its two options resolve, read
 * off the pinned body. The texels stay the caller's, `width` x `height` x
 * `depth` RGBA8 with x fastest then y then z, and each backend uploads them as
 * one `dimension: "3d"` texture of one level viewed `dimension: "3d"`.
 */
export function lowerPixelsTexture3DFactory(context: LoweringContext): string {
    const name = "createTexture3DFromPixels";
    const { declaration } = context.functionDeclaration(
        pixelsTextureModule,
        name,
    );
    const pinnedDefault = (
        variable: string,
        option: string,
        table: Readonly<Record<string, string>>,
    ): string => {
        const initializer = context.variableInitializer(declaration, variable);
        const fallback =
            ts.isBinaryExpression(initializer) &&
            ts.isStringLiteral(initializer.right)
                ? initializer.right.text
                : "";
        context.assertExpressionShape(
            initializer,
            `options.${option} ?? "${fallback}"`,
            `${name} ${option}`,
        );
        const enumerator = table[fallback];
        if (!enumerator) {
            context.contractError(
                initializer,
                `Pinned ${name} defaults ${option} to '${fallback}', which has no runtime enumerator.`,
            );
        }
        return enumerator;
    };
    const address = pinnedDefault("address", "addressMode", addressModeByPin);
    const filter = pinnedDefault("filter", "filter", textureFilterByPin);
    context.assertExpressionShape(
        context.variableInitializer(declaration, "expected"),
        "width * height * depth * 4",
        `${name} expected byte count`,
    );
    context.assertExpressionShape(
        context.variableInitializer(declaration, "format"),
        'options.srgb ? "rgba8unorm-srgb" : "rgba8unorm"',
        `${name} format`,
    );
    const texture = context.callObjectArgument(declaration, "createTexture");
    context.assertExpressionShape(
        context.propertyInitializer(texture, "dimension"),
        '"3d"',
        `${name} texture dimension`,
    );
    context.assertExpressionShape(
        context.propertyInitializer(texture, "size"),
        "{ width, height, depthOrArrayLayers: depth }",
        `${name} texture size`,
    );
    // No mipLevelCount: one level, which the zero LOD clamp below selects.
    // No mipmapFilter: the WebGPU default, nearest.
    context.assertExpressionShape(
        context.callExpression(declaration, "getOrCreateSampler").arguments[1]!,
        "{ addressModeU: address, addressModeV: address, addressModeW: address, minFilter: filter, magFilter: filter }",
        `${name} sampler`,
    );
    context.assertExpressionShape(
        context.callExpression(declaration, "createView").arguments[0]!,
        '{ dimension: "3d" }',
        `${name} view`,
    );
    const number = (value: string): { cpp: string } => ({
        cpp: `js::number_to_string(${value})`,
    });
    const extentMessage = pinnedErrorMessageCpp(
        context,
        pinnedErrorCode(context, declaration, 3),
        [number("width"), number("height"), number("depth")],
    );
    const lengthMessage = pinnedErrorMessageCpp(
        context,
        pinnedErrorCode(context, declaration, 5),
        [
            number("static_cast<double>(expected)"),
            number("width"),
            number("height"),
            number("depth"),
            number("static_cast<double>(bytes.size())"),
        ],
    );
    return `// ${context.provenance(pixelsTextureModule, name)}
namespace {

PixelsTexture create_texture_3d_from_bytes(
    Engine& engine,
    std::vector<std::uint8_t> bytes,
    double width,
    double height,
    double depth,
    PixelsTexture3DOptions options) {
    if (width < 1.0 || height < 1.0 || depth < 1.0)
        throw std::runtime_error(${extentMessage});
    const std::size_t expected = static_cast<std::size_t>(width) *
        static_cast<std::size_t>(height) * static_cast<std::size_t>(depth) * 4u;
    if (bytes.size() < expected)
        throw std::runtime_error(${lengthMessage});
    PixelsTexture texture;
    texture.rgba = std::move(bytes);
    texture.width = ${jsToUint32Call("width")};
    texture.height = ${jsToUint32Call("height")};
    texture.depth = ${jsToUint32Call("depth")};
    texture.srgb = options.srgb;
    texture.identity = engine.next_pixels_texture_identity++;
    const TextureAddressMode address =
        options.has_address_mode ? options.address_mode : ${address};
    const TextureFilter filter = options.has_filter ? options.filter : ${filter};
    texture.sampler.min_filter = filter;
    texture.sampler.mag_filter = filter;
    texture.sampler.mipmap_mode = TextureMipmapMode::nearest;
    texture.sampler.address_u = address;
    texture.sampler.address_v = address;
    texture.sampler.address_w = address;
    texture.sampler.max_anisotropy = 1.0f;
    texture.sampler.max_lod = 0.0f;
    return texture;
}

} // namespace

PixelsTexture create_texture_3d_from_pixels(
    Engine& engine,
    const std::string& path,
    double width,
    double height,
    double depth,
    PixelsTexture3DOptions options) {
    return create_texture_3d_from_bytes(
        engine, pal::read_binary_file(path), width, height, depth, options);
}

PixelsTexture create_texture_3d_from_pixels(
    Engine& engine,
    const js::U8Array& pixels,
    double width,
    double height,
    double depth,
    PixelsTexture3DOptions options) {
    return create_texture_3d_from_bytes(
        engine, pixels.to_vector(), width, height, depth, options);
}
`;
}
