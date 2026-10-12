/**
 * Names of the offline-compiled stages of WGSL a program creates at runtime
 * (`device.createShaderModule({code})`). SDL_GPU consumes compiled stages, so
 * generation compiles each reached module's entry points under a name its
 * text decides, and the native device (`wgsl_stage_stem`,
 * native/src/pal_webgpu_common.hpp) finds them by the same name.
 */

const multiplier = 0x9e3779b97f4a7c15n;
const mask = (1n << 64n) - 1n;

function absorb(hash: bigint, word: bigint): bigint {
    return ((hash ^ (hash >> 32n) ^ word) * multiplier) & mask;
}

function load(bytes: Uint8Array, offset: number, count: number): bigint {
    let word = 0n;
    for (let index = count - 1; index >= 0; index--)
        word = (word << 8n) | BigInt(bytes[offset + index]!);
    return word;
}

/** native/include/bblite/byte_hash.hpp `hash_bytes(data, size)` with a zero seed. */
export function hashBytes(bytes: Uint8Array): bigint {
    const size = bytes.length;
    let hash = absorb(0n, BigInt(size));
    if (size > 8) {
        const last = size - 8;
        for (let offset = 0; offset < last; offset += 8)
            hash = absorb(hash, load(bytes, offset, 8));
        hash = absorb(hash, load(bytes, last, 8));
    } else if (size >= 4) {
        hash = absorb(
            hash,
            (load(bytes, 0, 4) << 32n) | load(bytes, size - 4, 4),
        );
    } else if (size > 0) {
        hash = absorb(
            hash,
            (BigInt(bytes[0]!) << 16n) |
                (BigInt(bytes[size >> 1]!) << 8n) |
                BigInt(bytes[size - 1]!),
        );
    }
    return hash;
}

export type WgslStageKind = "comp" | "vert" | "frag";

/** `wgsl-<digest>.<entryPoint>.<stage>`: the compiled stage of one module entry point. */
export function wgslStageStem(
    code: string,
    entryPoint: string,
    stage: WgslStageKind,
): string {
    if (!/^[A-Za-z_]\w*$/.test(entryPoint))
        throw new Error(`Invalid WGSL entry point '${entryPoint}'.`);
    const digest = hashBytes(new TextEncoder().encode(code))
        .toString(16)
        .padStart(16, "0");
    return `wgsl-${digest}.${entryPoint}.${stage}`;
}
