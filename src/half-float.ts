/**
 * The one float32 → float16 conversion in the tree.
 *
 * Bit-exact IEEE 754 round-to-nearest-even over the float32 bit pattern —
 * the rounding a GPU performs when a shader writes `rgba16float` — so bytes
 * baked at generation match what the pinned WebGPU passes would have
 * produced. Ties round to even (`+ ((mantissa >>> 13) & 1)`), overflow goes
 * to infinity, subnormals round from the normalized mantissa, NaN keeps a
 * quiet payload and -0 keeps its sign.
 *
 * There used to be two encoders: this one, and a `Math.round`-over-log2
 * transcription in the HDR packager that rounded halves away from zero and
 * clamped overflow to 65504. Both packagers now share this one.
 */
export function floatToHalf(value: number): number {
    const source = new Float32Array([value]);
    const bits = new Uint32Array(source.buffer)[0]!;
    const sign = (bits >>> 16) & 0x8000;
    const exponent = (bits >>> 23) & 0xff;
    const mantissa = bits & 0x7fffff;
    if (exponent === 0xff) {
        return sign | (mantissa === 0 ? 0x7c00 : 0x7e00);
    }
    const halfExponent = exponent - 127 + 15;
    if (halfExponent >= 0x1f) return sign | 0x7c00;
    if (halfExponent <= 0) {
        if (halfExponent < -10) return sign;
        const normalized = mantissa | 0x800000;
        const shift = 14 - halfExponent;
        const rounded =
            (normalized + (1 << (shift - 1)) - 1 +
                ((normalized >> shift) & 1)) >>
            shift;
        return sign | rounded;
    }
    const rounded =
        mantissa + 0xfff + ((mantissa >>> 13) & 1);
    if ((rounded & 0x800000) !== 0) {
        const nextExponent = halfExponent + 1;
        return nextExponent >= 0x1f
            ? sign | 0x7c00
            : sign | (nextExponent << 10);
    }
    return sign | (halfExponent << 10) | (rounded >>> 13);
}
