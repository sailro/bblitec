/**
 * The pin's WebGPU address-mode spellings, as this runtime's enumerators.
 *
 * Shared because every loader that reads a sampler needs the same three
 * rows: the glTF sampler wrap modes, the `.babylon` loader's, and the
 * `textureOptions` a sprite atlas spreads over its defaults. A mode the pin
 * starts using that has no row here fails generation naming it, rather than
 * silently picking a neighbour.
 */
export const addressModeByPin: Readonly<Record<string, string>> = {
    "clamp-to-edge": "TextureAddressMode::clamp",
    "mirror-repeat": "TextureAddressMode::mirror",
    repeat: "TextureAddressMode::repeat",
};

/**
 * The pin's filter names, as the runtime enumerators. Same rule as the
 * address modes: a filter the pin starts using that has no row here fails
 * generation naming it.
 */
export const textureFilterByPin: Readonly<Record<string, string>> = {
    nearest: "TextureFilter::nearest",
    linear: "TextureFilter::linear",
};

export const pixelsTexture2DOptionFields: readonly string[] = [
    "addressModeU",
    "addressModeV",
    "magFilter",
    "minFilter",
    "srgb",
];

/**
 * The `PixelsTextureOptions` a `createTexture2DFromPixels` call named, as
 * the native aggregate.
 *
 * Two places write it — the call site, and the generated node-particle atlas
 * builder that rebuilds the same call against its own engine parameter — so
 * the mapping from the pin's own literals to this runtime's enumerators
 * lives here once. A literal with no row fails naming it, rather than
 * silently picking a neighbour.
 */
export function pixelsTextureOptionsCpp(
    named: Readonly<Record<string, string>>,
    fail: (message: string) => never,
): string {
    if (Object.keys(named).length === 0) return "";
    const field = (
        name: string,
        table: Readonly<Record<string, string>>,
    ): string => {
        const literal = named[name];
        if (literal === undefined) return "{}, false";
        const mapped = table[literal];
        if (!mapped) {
            fail(
                `createTexture2DFromPixels ${name} '${literal}' is not one ` +
                    `of the pinned literals: ${Object.keys(table).join(", ")}.`,
            );
        }
        return `bbl::${mapped}, true`;
    };
    const srgb = named.srgb ?? "false";
    if (srgb !== "true" && srgb !== "false") {
        fail(
            `createTexture2DFromPixels srgb '${srgb}' is not a boolean literal.`,
        );
    }
    return (
        `bbl::PixelsTextureOptions{${field("minFilter", textureFilterByPin)}, ` +
        `${field("magFilter", textureFilterByPin)}, ` +
        `${field("addressModeU", addressModeByPin)}, ` +
        `${field("addressModeV", addressModeByPin)}, ${srgb}}`
    );
}

export const mipmapModeByPin: Readonly<Record<string, string>> = {
    nearest: "TextureMipmapMode::nearest",
    linear: "TextureMipmapMode::linear",
};

/**
 * `Texture2DOptions`' own defaults (src/texture/texture-2d.ts): linear
 * filters, repeat addressing, mips on, upload flip on, sRGB and
 * premultiplication off.
 *
 * Two producers resolve a `loadTexture2D` call against them — the call site,
 * reading an AST, and the generation-time browser texture bake, reading the
 * literals a recorded call passed — so the defaults are stated once rather
 * than restated per reader.
 */
export const loadTexture2DDefaults = {
    minFilter: "linear",
    magFilter: "linear",
    mipMaps: true,
    invertY: true,
    srgb: false,
    premultiplyAlpha: false,
    addressModeU: "repeat",
    addressModeV: "repeat",
} as const;

export const loadTexture2DOptionFields: readonly string[] =
    Object.keys(loadTexture2DDefaults);

/**
 * The `Texture2DOptions` a `loadTexture2D` call resolved, as the native
 * sampler aggregate.
 *
 * Two producers write it — the call site, and the generation-time browser
 * texture bake that replays a call the scene made against an object URL —
 * so the pin's own rules live here once. The one that is easy to restate
 * wrongly is the anisotropy: `maxAnisotropy: allLinear ? 4 : 1` folds the
 * mip filter (`mipMaps ? "linear" : "nearest"`) into its test, so turning
 * mips off turns anisotropy off with them.
 *
 * The address modes arrive already spelled as native expressions because a
 * call site may name one conditionally; the filters arrive as the pin's own
 * literals so the anisotropy test can read them.
 */
export function loadTexture2DSamplerCpp(sampler: {
    minFilter: string;
    magFilter: string;
    mipMaps: boolean;
    addressModeUCpp: string;
    addressModeVCpp: string;
}): string {
    const allLinear =
        sampler.minFilter === "linear" &&
        sampler.magFilter === "linear" &&
        sampler.mipMaps;
    return (
        `bbl::TextureSamplerState{` +
        `bbl::TextureFilter::${sampler.minFilter}, ` +
        `bbl::TextureFilter::${sampler.magFilter}, ` +
        `bbl::TextureMipmapMode::${sampler.mipMaps ? "linear" : "nearest"}, ` +
        `${sampler.addressModeUCpp}, ` +
        `${sampler.addressModeVCpp}, ` +
        `${allLinear ? "4.0f" : "1.0f"}, ` +
        `${sampler.mipMaps ? "1000.0f" : "0.0f"}}`
    );
}

/** Everything `bbl::load_file_texture` takes past the path. */
export interface LoadTexture2DUpload {
    sampler: string;
    invertY: boolean;
    srgb: boolean;
    premultiplyAlpha: boolean;
}

/**
 * A `loadTexture2D` call whose every option is a settled literal, resolved
 * against the pin's defaults.
 *
 * This is the browser bake's reader: it holds what the call actually passed
 * rather than an AST, so unlike the call-site path it has no conditional
 * spelling to preserve and can map every field through the tables above. A
 * literal with no row fails naming it, the way every other sampler reader
 * here does.
 */
export function loadTexture2DUploadCpp(
    named: Readonly<Record<string, string>>,
    fail: (message: string) => never,
): LoadTexture2DUpload {
    const literal = (field: keyof typeof loadTexture2DDefaults): string =>
        named[field] ?? String(loadTexture2DDefaults[field]);
    const mapped = (
        field: "minFilter" | "magFilter" | "addressModeU" | "addressModeV",
        table: Readonly<Record<string, string>>,
    ): string => {
        const name = literal(field);
        if (!table[name]) {
            fail(
                `loadTexture2D ${field} '${name}' is not one of the pinned ` +
                    `literals: ${Object.keys(table).join(", ")}.`,
            );
        }
        return name;
    };
    const flag = (
        field: "mipMaps" | "invertY" | "srgb" | "premultiplyAlpha",
    ): boolean => {
        const name = literal(field);
        if (name !== "true" && name !== "false") {
            fail(`loadTexture2D ${field} '${name}' is not a boolean literal.`);
        }
        return name === "true";
    };
    const mipMaps = flag("mipMaps");
    return {
        sampler: loadTexture2DSamplerCpp({
            minFilter: mapped("minFilter", textureFilterByPin),
            magFilter: mapped("magFilter", textureFilterByPin),
            mipMaps,
            addressModeUCpp: `bbl::${
                addressModeByPin[mapped("addressModeU", addressModeByPin)]
            }`,
            addressModeVCpp: `bbl::${
                addressModeByPin[mapped("addressModeV", addressModeByPin)]
            }`,
        }),
        invertY: flag("invertY"),
        srgb: flag("srgb"),
        premultiplyAlpha: flag("premultiplyAlpha"),
    };
}
