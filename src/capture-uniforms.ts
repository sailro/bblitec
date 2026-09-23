import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
    parseWgslType,
    reflectWgslModule,
    wgslStructLayout,
} from "./shader-ir.js";
import {
    captureBuffersPath,
    captureShadersDirectory,
} from "./tooling/artifacts.js";
import {
    fieldOffsets as wgslFieldOffsets,
    layoutOf as wgslLayoutOf,
    type WgslLayout,
} from "./wgsl-layout.js";

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

/**
 * A declared type's uniform-address-space size and alignment, under the one
 * layout rule (`wgsl-layout.ts`) generation mirrors blocks through too.
 * Anything the rule does not know is reported as unknown rather than
 * guessed, because a wrong stride silently shifts every later field.
 */
export function layoutOf(type: string): WgslLayout | undefined {
    return wgslLayoutOf(parseWgslType(type).shape);
}

export function fieldOffsets(
    fields: WgslField[],
): { offsets: number[]; size: number } | undefined {
    const layout = wgslFieldOffsets(
        fields.map(({ type }) => ({ type: parseWgslType(type).shape })),
    );
    return layout && { offsets: layout.offsets, size: layout.size };
}

/**
 * The uniform-shaped structs a captured module declares: every member
 * attribute-free and of known layout. Interface structs (`@location`,
 * `@builtin` members) describe stage IO, not buffer contents.
 */
export function parseWgslStructs(source: string, module: string): WgslStruct[] {
    return reflectWgslModule(source).declarations.flatMap((declaration) => {
        if (
            declaration.kind !== "struct" ||
            declaration.members.length === 0 ||
            declaration.members.some(({ attributes }) => attributes.length > 0)
        ) {
            return [];
        }
        const layout = wgslStructLayout(declaration.members);
        if (!layout) return [];
        return [
            {
                name: declaration.name,
                module,
                fields: declaration.members.map(({ name, type }) => ({
                    name,
                    type: type.source,
                })),
                size: layout.size,
            },
        ];
    });
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
 * through as well, so the two diagnostics agree about which buffers hold
 * bytes.
 */
export function lastWriteBytes(buffer: {
    writes?: unknown;
    mappedWrites?: unknown;
}): Buffer | undefined {
    const writes = Array.isArray(buffer.writes) ? buffer.writes : [];
    for (let index = writes.length - 1; index >= 0; index--) {
        const write = writes[index] as
            string | { bytes?: string; data?: string } | undefined;
        const base64 =
            typeof write === "string" ? write : (write?.bytes ?? write?.data);
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
        const bytes = lastWriteBytes(entry);
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
        const id = entry.id ?? entry.index ?? "?";
        if (typeof id !== "string" && typeof id !== "number") {
            throw new Error(
                "Uniform capture buffer identity must be a string or number.",
            );
        }
        result.push({
            id: String(id),
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
        const names = [...new Set(buffer.candidates.map((c) => c.struct.name))];
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
                lines.push(
                    `  as ${candidate.struct.name} (${candidate.struct.module})`,
                );
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
