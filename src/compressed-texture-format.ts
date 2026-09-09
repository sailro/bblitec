/** Private little-endian payload: fixed header, mip descriptors, GPU blocks. */
export const compressedTextureFormat = {
    magic: "BBLBC001",
    mimeType: "application/x-bblite-compressed-texture",
    headerBytes: 24,
    glFormat: 8,
    width: 12,
    height: 16,
    mipCount: 20,
    mipBytes: 16,
    mipWidth: 0,
    mipHeight: 4,
    mipOffset: 8,
    mipLength: 12,
} as const;
