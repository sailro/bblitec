/**
 * A Basis Universal texture, transcoded at generation.
 *
 * Two containers reach the same transcoder: a `.basis` file through
 * `basis-loader.ts`, and a `.ktx2` image through `ktx2-loader.ts` — which is
 * what `KHR_texture_basisu` redirects a glTF texture to. Neither can be a
 * load-time fold: the transcoder is a JavaScript+WebAssembly module the page fetches
 * from a CDN and injects with a `<script>` tag, so the native runtime would
 * have to carry a decompressor it has no other use for — the reason Draco
 * and meshopt are decoded at generation too. And the format it transcodes
 * INTO is a device question: the pin walks its priority list and takes the
 * first the adapter reports, which is BC7 on any D3D12 adapter and
 * therefore on both the browser reference and both compiled backends.
 *
 * So generation runs the pin's own loader in the engine the golden runs it
 * in, and bakes what the transcoder produced. What lands beside the
 * executable is a KTX1 container, because the port already reads one: the
 * transcoded mip chain is exactly what `parseKtx1` returns, so wrapping it
 * gives the runtime one compressed-texture reader rather than two. The
 * tradeoff is the drawn atlas's and the HDR prefilter's — the baked bytes
 * depend on the Chrome that compiled them — and it is recorded per scene as
 * the `executed-basis-transcode` adaptation.
 */
import {
    createSuiteSceneServer,
    pinnedBrowserEntryUrl,
} from "./capture-suite-reference.js";
import type { KtxHeaderLayout } from "./lowering/compressed-texture-lowerer.js";
import {
    pageBase64Script,
    runPageGlobal,
    webgpuComputeBrowserArgs,
} from "./browser-harness.js";
import { cachedJsonBake, moduleIdentity } from "./bake-cache.js";

/** One transcoded level, as the pin's own `writeTexture` call carried it. */
export interface TranscodedMipLevel {
    width: number;
    height: number;
    bytes: Uint8Array;
}

/** What the pinned loader created and uploaded, for one `.basis` file. */
export interface TranscodedBasisTexture {
    /** The WebGPU format the pin's own priority list selected. */
    gpuFormat: string;
    width: number;
    height: number;
    mips: TranscodedMipLevel[];
}

interface CapturedTranscode {
    gpuFormat: string;
    width: number;
    height: number;
    mips: { width: number; height: number; base64: string }[];
}

/**
 * One pinned entry point that ends at a transcode, and how the page calls it.
 *
 * The two differ only in which container the pin reads: everything after the
 * call — the transcoder it injects, the priority list it walks, and the
 * blocks it writes — is the same code, so the capture, the bake key and the
 * KTX1 packaging are shared and only this row is per format.
 */
interface PinnedTranscodeLoader {
    /** The pinned index-module export the page imports. */
    entryExport: string;
    /** The call, as the pin's own signature spells it. */
    call: (servedPath: string) => string;
    /** The bake-cache kind, and the name refusals use. */
    kind: string;
    /** The served path the page fetches, extension included. */
    servedPath: string;
}

const basisLoader: PinnedTranscodeLoader = {
    entryExport: "loadBasisTexture2D",
    call: (path) => `loadBasisTexture2D(engine, ${JSON.stringify(path)})`,
    kind: "basis-transcode",
    servedPath: "/basis-source.basis",
};

/**
 * The KTX2 arm, which `KHR_texture_basisu` redirects a glTF texture to.
 *
 * `sRGB` is passed false because it is not a transcode input at all:
 * `uploadKtx2Texture2D` decodes the same blocks either way and uses the flag
 * only to pick `srgbFormat(...)` over the row `getCompressedFormat` returned.
 * So one bake serves both, and which of the two GL enums the packaged
 * container states follows the slot that reached the image.
 */
const ktx2Loader: PinnedTranscodeLoader = {
    entryExport: "loadKtx2Texture2D",
    call: (path) =>
        `loadKtx2Texture2D(engine, ${JSON.stringify(path)}, false)`,
    kind: "ktx2-transcode",
    servedPath: "/ktx2-source.ktx2",
};

/**
 * The page module: create the pin's own engine, watch the one texture the
 * loader creates, and hand back its descriptor and every level it wrote.
 *
 * The hooks are installed around the call and removed after it, so the
 * texture they see is the loader's rather than whichever the engine made
 * first. Bytes cross as base64 for the reason the executed-module runner
 * gives: a number per byte turns a megabyte into ten seconds of JSON.
 */
function transcodeModule(loader: PinnedTranscodeLoader, url: string): string {
    return `import { createEngine, ${loader.entryExport} } from ${JSON.stringify(pinnedBrowserEntryUrl)};

${pageBase64Script}
window.__transcodeBasis = async () => {
    const canvas = document.getElementById("renderCanvas");
    const engine = await createEngine(canvas);
    const device = engine._device;
    const queue = device.queue;
    const createTexture = device.createTexture.bind(device);
    const writeTexture = queue.writeTexture.bind(queue);
    let descriptor = null;
    let created = null;
    const writes = [];
    device.createTexture = (options) => {
        const texture = createTexture(options);
        descriptor = options;
        created = texture;
        return texture;
    };
    queue.writeTexture = (destination, data, layout, size) => {
        if (destination.texture === created) {
            writes.push({
                level: destination.mipLevel ?? 0,
                width: size.width,
                height: size.height,
                base64: bblBase64(new Uint8Array(
                    data.buffer, data.byteOffset, data.byteLength)),
            });
        }
        return writeTexture(destination, data, layout, size);
    };
    try {
        await ${loader.call(url)};
    } finally {
        device.createTexture = createTexture;
        queue.writeTexture = writeTexture;
    }
    if (!descriptor) throw new Error("Basis: the loader created no texture.");
    writes.sort((left, right) => left.level - right.level);
    return {
        gpuFormat: descriptor.format,
        width: descriptor.size.width,
        height: descriptor.size.height,
        mips: writes.map((write) => ({
            width: write.width,
            height: write.height,
            base64: write.base64,
        })),
    };
};
`;
}

async function transcodeTexture(
    loader: PinnedTranscodeLoader,
    url: string,
    bytes: Uint8Array,
): Promise<TranscodedBasisTexture> {
    // Deterministic in (asset bytes, pin, browser) — the transcoder the
    // pin injects and the format its priority list selects are the
    // browser's — so a repeat compile replays the captured transcode
    // from the bake cache instead of launching Chromium. The cached
    // payload is exactly the JSON that crossed the page boundary.
    const captured = await cachedJsonBake<CapturedTranscode>(
        {
            kind: loader.kind,
            version: "1",
            module: moduleIdentity(import.meta.url),
            browser: true,
            parameters: {},
            inputs: [bytes],
        },
        async () => {
            // The pin fetches the file itself, so it is served back from
            // the loopback origin: the bytes come from the same download
            // cache every other asset uses, and the CDN is asked only
            // for the transcoder.
            const server = createSuiteSceneServer(
                transcodeModule(loader, loader.servedPath),
                {
                    virtualAssets: { [loader.servedPath]: bytes },
                },
            );
            return (await runPageGlobal(server, "__transcodeBasis", {
                serverName: "basis transcode server",
                browserRequirement:
                    "Transcoding a Basis Universal texture requires Chrome or Edge.",
                browserArgs: webgpuComputeBrowserArgs,
            })) as CapturedTranscode;
        },
    );
    if (captured.mips.length === 0) {
        throw new Error(
            `Basis: the pinned loader uploaded no level for '${url}'.`,
        );
    }
    return {
        gpuFormat: captured.gpuFormat,
        width: captured.width,
        height: captured.height,
        mips: captured.mips.map((mip) => ({
            width: mip.width,
            height: mip.height,
            bytes: new Uint8Array(Buffer.from(mip.base64, "base64")),
        })),
    };
}

/** A `.basis` file, through `basis-loader.ts`. */
export async function transcodeBasisTexture(
    url: string,
    bytes: Uint8Array,
): Promise<TranscodedBasisTexture> {
    return transcodeTexture(basisLoader, url, bytes);
}

/** A `.ktx2` image, through `ktx2-loader.ts`. */
export async function transcodeKtx2Texture(
    url: string,
    bytes: Uint8Array,
): Promise<TranscodedBasisTexture> {
    return transcodeTexture(ktx2Loader, url, bytes);
}

/**
 * The transcoded chain as a KTX1 container.
 *
 * Every offset is the one the pinned parser reads, taken from the same
 * derivation the emitted parser is built from: a layout stated twice is a
 * layout that can disagree with itself, and the disagreement would surface
 * as the generated parser misreading its own generated file. The two
 * fields the parser validates without binding — `glType` and `glFormat` —
 * are written from the values it demands there, and the two it neither
 * reads nor validates (`glTypeSize`, `glBaseInternalFormat`) carry what a
 * block-compressed RGBA container states.
 */
export function writeKtx1(
    texture: TranscodedBasisTexture,
    magic: readonly number[],
    glInternalFormat: number,
    header: KtxHeaderLayout,
    blockSize?: { width: number; height: number },
): Uint8Array {
    // KTX1 stores no per-level size, so a reader recovers each level by
    // halving — which is what the pin's own parser does. Checking the
    // transcode against that here is what keeps the container expressible.
    //
    // What each level's captured extent IS differs by loader, so the
    // expectation follows the one that produced it: `basis-loader.ts`
    // passes the level's own size to `writeTexture`, while both KTX
    // loaders pass the block-padded copy extent, where a 2x2 tail mip
    // occupies one whole 4x4 block. A block size is therefore given for a
    // capture of the padded arm and withheld for the other, rather than
    // the check weakening to accept either.
    const padExtent = (size: number, block: number): number =>
        blockSize ? Math.ceil(size / block) * block : size;
    let expectedWidth = texture.width;
    let expectedHeight = texture.height;
    for (const [level, mip] of texture.mips.entries()) {
        const width = padExtent(expectedWidth, blockSize?.width ?? 1);
        const height = padExtent(expectedHeight, blockSize?.height ?? 1);
        if (mip.width !== width || mip.height !== height) {
            throw new Error(
                `Basis: transcoded level ${level} is ${mip.width}x` +
                    `${mip.height}, where a KTX1 chain halving from ` +
                    `${texture.width}x${texture.height} reaches ` +
                    `${width}x${height}.`,
            );
        }
        expectedWidth = Math.max(1, expectedWidth >> 1);
        expectedHeight = Math.max(1, expectedHeight >> 1);
    }
    const padded = texture.mips.map((mip) => (mip.bytes.length + 3) & ~3);
    const out = new Uint8Array(
        header.headerSize +
            padded.reduce((sum, size) => sum + 4 + size, 0),
    );
    const view = new DataView(out.buffer);
    const field = (offset: number, value: number): void =>
        view.setUint32(offset, value, true);
    out.set(magic, 0);
    field(header.endianness.offset, header.endianness.expected);
    field(header.glType.offset, header.glType.expected);
    field(20, 1); // glTypeSize: unread by the parser
    field(header.glFormat.offset, header.glFormat.expected);
    field(header.glInternalFormat, glInternalFormat);
    field(32, 0x1908); // glBaseInternalFormat: GL_RGBA, likewise unread
    field(header.width, texture.width);
    field(header.height, texture.height);
    field(header.pixelDepth, 0);
    field(header.arrayElements, 0);
    field(header.faces, 1);
    field(header.mipLevels, texture.mips.length);
    field(header.keyValueBytes, 0);
    let offset = header.headerSize;
    for (const [level, mip] of texture.mips.entries()) {
        field(offset, mip.bytes.length);
        offset += 4;
        out.set(mip.bytes, offset);
        offset += padded[level]!;
    }
    return out;
}
