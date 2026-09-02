import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
    captureBuffersPath,
    captureShadersDirectory,
} from "./parity-scene.js";

/**
 * Reading an instrumented capture's uniform buffers.
 *
 * `scene -- capture` records every buffer the browser uploads, but the bytes
 * land in `buffers.json` as base64 and nothing says what they mean. The
 * capture also records the browser's own composed shader modules, and those
 * declare the structs those bytes are written from — so the layouts needed to
 * read them are already in the directory, and pairing the two turns a wall of
 * base64 into named values that can be compared against the native records
 * that produced our side.
 *
 * A buffer is matched to a struct by size. That is a heuristic rather than a
 * proof, so every struct whose layout is the same size is reported rather than
 * one being guessed at, and the caller decides.
 */

interface WgslField {
    name: string;
    type: string;
}

export interface WgslStruct {
    name: string;
    module: string;
    fields: WgslField[];
    size: number;
}

interface DecodedField {
    name: string;
    type: string;
    values: number[];
}

export interface DecodedBuffer {
    id: string;
    size: number;
    writes: number;
    candidates: Array<{ struct: WgslStruct; fields: DecodedField[] }>;
}

/** WGSL uniform-address-space size and alignment for the types a composed
 *  Babylon Lite fragment declares. Anything else is reported as unknown rather
 *  than guessed, because a wrong stride silently shifts every later field.
 *  This is the one copy: `render-diff` decodes through it too, so a stride
 *  fix reaches both diagnostics at once. */
export function layoutOf(type: string): { size: number; align: number } | undefined {
    const scalar = /^(f32|i32|u32)$/.exec(type);
    if (scalar) return { size: 4, align: 4 };
    const vector = /^vec([234])<(f32|i32|u32)>$/.exec(type);
    if (vector) {
        const count = Number(vector[1]);
        return count === 3
            ? { size: 12, align: 16 }
            : { size: count * 4, align: count * 4 };
    }
    const matrix = /^mat([234])x([234])<f32>$/.exec(type);
    if (matrix) {
        const columns = Number(matrix[1]);
        const rows = Number(matrix[2]);
        const columnStride = rows === 3 ? 16 : rows * 4;
        return { size: columns * columnStride, align: 16 };
    }
    const array = /^array<(.+),\s*(\d+)u?>$/.exec(type);
    if (array) {
        const element = layoutOf(array[1]!.trim());
        if (!element) return undefined;
        // Uniform arrays round their stride up to 16.
        const stride = roundUp(Math.max(element.align, 16), element.size);
        return { size: stride * Number(array[2]), align: Math.max(element.align, 16) };
    }
    return undefined;
}

export function roundUp(alignment: number, value: number): number {
    return Math.ceil(value / alignment) * alignment;
}

export function fieldOffsets(
    fields: WgslField[],
): { offsets: number[]; size: number } | undefined {
    let offset = 0;
    let maxAlign = 1;
    const offsets: number[] = [];
    for (const field of fields) {
        const layout = layoutOf(field.type);
        if (!layout) return undefined;
        offset = roundUp(layout.align, offset);
        offsets.push(offset);
        offset += layout.size;
        maxAlign = Math.max(maxAlign, layout.align);
    }
    return { offsets, size: roundUp(maxAlign, offset) };
}

export function parseWgslStructs(source: string, module: string): WgslStruct[] {
    const result: WgslStruct[] = [];
    // Composed fragments write their structs without spaces around braces, so
    // the opening brace may sit on the declaration line or its own.
    const pattern = /struct\s+(\w+)\s*\{([^}]*)\}/g;
    for (const match of source.matchAll(pattern)) {
        const fields: WgslField[] = [];
        for (const line of match[2]!.split(/[,\n]/)) {
            const field = /^\s*(\w+)\s*:\s*([^,]+?)\s*$/.exec(line);
            if (field) fields.push({ name: field[1]!, type: field[2]!.trim() });
        }
        const layout = fieldOffsets(fields);
        if (!layout || fields.length === 0) continue;
        result.push({ name: match[1]!, module, fields, size: layout.size });
    }
    return result;
}

function decodeStruct(
    bytes: Buffer,
    struct: WgslStruct,
): DecodedField[] | undefined {
    const layout = fieldOffsets(struct.fields);
    if (!layout) return undefined;
    return struct.fields.map((field, index) => {
        const offset = layout.offsets[index]!;
        const info = layoutOf(field.type)!;
        const count = Math.min(info.size / 4, (bytes.length - offset) / 4);
        const values: number[] = [];
        for (let i = 0; i < count; i++) {
            values.push(bytes.readFloatLE(offset + i * 4));
        }
        return { name: field.name, type: field.type, values };
    });
}

/**
 * The last bytes a captured buffer holds, from the newest recorded write —
 * accepting both the `bytes` and `data` key spellings — and falling back to
 * the mapped-at-creation range, which is the only content a buffer filled
 * through `mappedAtCreation` ever has. The one copy `render-diff` reads
 * through as well: the two diagnostics used to disagree about which buffers
 * even had bytes.
 */
export function lastWriteBytes(buffer: {
    writes?: unknown;
    mappedWrites?: unknown;
}): Buffer | undefined {
    const writes = Array.isArray(buffer.writes) ? buffer.writes : [];
    for (let index = writes.length - 1; index >= 0; index--) {
        const write = writes[index] as
            | string
            | { bytes?: string; data?: string }
            | undefined;
        const base64 =
            typeof write === "string" ? write : write?.bytes ?? write?.data;
        if (base64) return Buffer.from(base64, "base64");
    }
    const mapped = Array.isArray(buffer.mappedWrites)
        ? buffer.mappedWrites
        : [];
    for (const write of mapped as Array<{ bytes?: string; data?: string }>) {
        const base64 = write?.bytes ?? write?.data;
        if (base64) return Buffer.from(base64, "base64");
    }
    return undefined;
}

/** GPUBufferUsage.UNIFORM and .STORAGE. */
export const uniformUsage = 0x40;
export const storageUsage = 0x80;

/**
 * How large a non-uniform buffer may be and still be read for values.
 * Babylon Lite keeps some per-frame state the fragments read — light lists,
 * for one — in storage buffers rather than uniform blocks; vertex and index
 * buffers are storage-sized too and hold nothing worth decoding, so the cap
 * admits the state and excludes the geometry.
 */
export const storageValueCap = 4096;

export function decodeCapturedUniforms(
    captureDirectory: string,
    options: { sizes?: number[]; module?: string } = {},
): DecodedBuffer[] {
    const buffersPath = captureBuffersPath(captureDirectory);
    if (!existsSync(buffersPath)) {
        throw new Error(
            `No capture buffers at ${buffersPath}. Run 'scene -- capture <id>' first.`,
        );
    }
    const shaderDirectory = captureShadersDirectory(captureDirectory);
    const structs: WgslStruct[] = [];
    if (existsSync(shaderDirectory)) {
        for (const name of readdirSync(shaderDirectory)) {
            if (!name.endsWith(".wgsl")) continue;
            structs.push(
                ...parseWgslStructs(
                    readFileSync(join(shaderDirectory, name), "utf8"),
                    name,
                ),
            );
        }
    }
    const parsed: unknown = JSON.parse(readFileSync(buffersPath, "utf8"));
    const buffers = Array.isArray(parsed)
        ? parsed
        : ((parsed as { buffers?: unknown[] }).buffers ?? []);
    const result: DecodedBuffer[] = [];
    for (const entry of buffers as Array<Record<string, unknown>>) {
        const size = Number(entry.size ?? entry.byteLength ?? 0);
        const usage = Number(entry.usage ?? 0);
        // Uniform blocks, plus the small storage buffers the fragments read
        // (the light lists) — the same admission `scene -- diff` uses, so a
        // buffer one rung reports is never invisible to the next.
        const admitted =
            (usage & uniformUsage) !== 0 ||
            ((usage & storageUsage) !== 0 && size <= storageValueCap);
        if (!admitted) continue;
        if (options.sizes && !options.sizes.includes(size)) continue;
        const bytes = lastWriteBytes(
            entry as { writes?: unknown; mappedWrites?: unknown },
        );
        if (!bytes) continue;
        const candidates = structs
            .filter((struct) => struct.size === size)
            .filter(
                (struct) =>
                    options.module === undefined ||
                    struct.module.includes(options.module),
            )
            .map((struct) => ({
                struct,
                fields: decodeStruct(bytes, struct) ?? [],
            }))
            .filter((candidate) => candidate.fields.length > 0);
        result.push({
            id: String(entry.id ?? entry.index ?? "?"),
            size,
            writes: Array.isArray(entry.writes) ? entry.writes.length : 1,
            candidates,
        });
    }
    return result;
}

export function formatDecodedUniforms(decoded: DecodedBuffer[]): string {
    const lines: string[] = [];
    for (const buffer of decoded) {
        const names = [
            ...new Set(buffer.candidates.map((c) => c.struct.name)),
        ];
        lines.push(
            `buffer ${buffer.id}  ${buffer.size} bytes  ${buffer.writes} write(s)  ` +
                (names.length > 0
                    ? `matches ${names.join(", ")}`
                    : "no struct of this size in the captured shaders"),
        );
        // A composed fragment declares one struct per material feature set, so
        // several unrelated layouts can share a size — the base-colour UV
        // transform pair and the reflectance slice both occupy 32 bytes, for
        // one. Decoding under every candidate and naming the module each came
        // from is the honest report: picking one would read plausible values
        // out of the wrong layout. `--module` narrows it once the right
        // fragment is known.
        for (const candidate of buffer.candidates) {
            if (buffer.candidates.length > 1) {
                lines.push(`  as ${candidate.struct.name} (${candidate.struct.module})`);
            }
            for (const field of candidate.fields) {
                const value = field.values
                    .map((v) => (Number.isFinite(v) ? v.toFixed(5) : String(v)))
                    .join(", ");
                lines.push(`    ${field.name.padEnd(28)} ${value}`);
            }
        }
    }
    return lines.join("\n");
}
