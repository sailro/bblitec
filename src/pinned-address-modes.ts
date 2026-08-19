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
