import { compressedTextureFormat as layout } from "./compressed-texture-format.js";
import { compressedTextureLowerer } from "./compiler/compressed-texture.js";
import { importPinnedModuleWithExports } from "./pinned-shader-composer.js";
import { uploadableCompressedFormats } from "./lowering/compressed-texture-lowerer.js";

interface ParsedKtx {
    format: { gpuFormat: string };
    width: number;
    height: number;
    mips: Array<{ width: number; height: number; data: Uint8Array }>;
}

/** Execute the pinned parser once; the native loader only views the recorded mips. */
export async function packageKtx1(bytes: Uint8Array): Promise<Uint8Array> {
    const { parseKtx1 } = await importPinnedModuleWithExports<{
        parseKtx1(buffer: ArrayBuffer): ParsedKtx;
    }>("texture/ktx-loader.js", ["parseKtx1"]);
    const buffer = Uint8Array.from(bytes).buffer;
    const parsed = parseKtx1(buffer);
    if (!uploadableCompressedFormats.includes(parsed.format.gpuFormat)) {
        throw new Error(`Compressed texture format '${parsed.format.gpuFormat}' is not uploadable.`);
    }
    const tableEnd = layout.headerBytes + parsed.mips.length * layout.mipBytes;
    const length = tableEnd + parsed.mips.reduce((sum, mip) => sum + mip.data.byteLength, 0);
    if (length > 0xffffffff) throw new Error("Compressed texture payload exceeds 32-bit offsets.");
    const output = new Uint8Array(length);
    output.set(new TextEncoder().encode(layout.magic));
    const view = new DataView(output.buffer);
    const write = (offset: number, value: number): void => view.setUint32(offset, value, true);
    write(layout.glFormat, new DataView(buffer).getUint32(compressedTextureLowerer().headerLayout().glInternalFormat, true));
    write(layout.width, parsed.width);
    write(layout.height, parsed.height);
    write(layout.mipCount, parsed.mips.length);
    let offset = tableEnd;
    for (const [index, mip] of parsed.mips.entries()) {
        const entry = layout.headerBytes + index * layout.mipBytes;
        write(entry + layout.mipWidth, mip.width);
        write(entry + layout.mipHeight, mip.height);
        write(entry + layout.mipOffset, offset);
        write(entry + layout.mipLength, mip.data.byteLength);
        output.set(mip.data, offset);
        offset += mip.data.byteLength;
    }
    return output;
}

let ktxMagic: readonly number[] | undefined;

export function isKtx1(bytes: Uint8Array): boolean {
    const magic = ktxMagic ??= compressedTextureLowerer().magicBytes();
    return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
}
