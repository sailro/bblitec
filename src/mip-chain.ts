/** Tightly packed GPU bake payloads, level-major then layer-major. */
function* mipLayerBytes(
    width: number,
    height: number,
    levels: number,
    bytesPerTexel: number,
): Generator<number> {
    for (let level = 0; level < levels; level++)
        yield Math.max(1, width >> level) *
            Math.max(1, height >> level) *
            bytesPerTexel;
}

export function mipChainBytes(
    width: number,
    height: number,
    levels: number,
    bytesPerTexel: number,
    layers = 1,
): number {
    let bytes = 0;
    for (const size of mipLayerBytes(width, height, levels, bytesPerTexel))
        bytes += size * layers;
    return bytes;
}

/** Views into a header-free payload; neither copies nor changes its bytes. */
export function mipChainViews(
    payload: Uint8Array,
    width: number,
    height: number,
    levels: number,
    bytesPerTexel: number,
    layers = 1,
): Uint8Array[][] {
    const result: Uint8Array[][] = [];
    let offset = 0;
    for (const size of mipLayerBytes(width, height, levels, bytesPerTexel)) {
        const views: Uint8Array[] = [];
        for (let layer = 0; layer < layers; layer++) {
            views.push(
                new Uint8Array(
                    payload.buffer,
                    payload.byteOffset + offset,
                    size,
                ),
            );
            offset += size;
        }
        result.push(views);
    }
    return result;
}
