/**
 * The name bytes package under where a program selects them by content at run
 * time: their 64-bit FNV-1a hash as sixteen hexadecimal digits, then their
 * length. `bbl::content_key` (runtime.hpp) computes the same text.
 */
export function contentKey(bytes: Uint8Array): string {
    // The hash as two 32-bit halves. The prime is 2^40 + 0x1b3, so a product
    // is the low half times 0x1b3, carried into the high half beside its own
    // product and the low half shifted eight bits.
    let low = 0x84222325;
    let high = 0xcbf29ce4;
    for (const byte of bytes) {
        low = (low ^ byte) >>> 0;
        const product = low * 0x1b3;
        high =
            (high * 0x1b3 +
                Math.floor(product / 0x100000000) +
                ((low << 8) >>> 0)) >>>
            0;
        low = product >>> 0;
    }
    const hex = (half: number): string => half.toString(16).padStart(8, "0");
    return `${hex(high)}${hex(low)}-${bytes.length}`;
}
