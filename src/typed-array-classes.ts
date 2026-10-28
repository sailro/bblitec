/**
 * The typed-array classes by kind: the one list the compiler's typed-array
 * table, the record model and the generation transport key on.
 *
 * This module carries no dependency so the generation child can import it.
 */
export const TYPED_ARRAY_CLASSES = {
    u8array: Uint8Array,
    i8array: Int8Array,
    f64array: Float64Array,
    f32array: Float32Array,
    u16array: Uint16Array,
    i16array: Int16Array,
    u32array: Uint32Array,
    i32array: Int32Array,
    u8clampedarray: Uint8ClampedArray,
} as const;

export type TypedArrayKind = keyof typeof TYPED_ARRAY_CLASSES;
