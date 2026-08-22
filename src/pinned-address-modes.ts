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
    return (
        `bbl::PixelsTextureOptions{${field("minFilter", textureFilterByPin)}, ` +
        `${field("magFilter", textureFilterByPin)}, ` +
        `${field("addressModeU", addressModeByPin)}, ` +
        `${field("addressModeV", addressModeByPin)}}`
    );
}

export const mipmapModeByPin: Readonly<Record<string, string>> = {
    nearest: "TextureMipmapMode::nearest",
    linear: "TextureMipmapMode::linear",
};
