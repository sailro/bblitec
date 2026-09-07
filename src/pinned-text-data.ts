/** Executes the pin's font/shaper and transports its immutable initial text buffers. */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";
import { runGenerationChild } from "./compiler/generation-child.js";
import { importPinnedModule, readPinnedLibraryModule } from "./pinned-shader-composer.js";
import { moduleSpecifiers } from "./typescript-module-specifiers.js";
import { readUpstreamPin } from "./upstream-source.js";

export interface StaticTextLayout {
    fontSizePx: number;
    text: string;
    color?: readonly number[];
    options?: {
        maxWidth?: number;
        lineHeight?: number;
        align?: "left" | "center" | "right";
        letterSpacing?: number;
        tabSize?: number;
    };
}

export interface TextBlob {
    assetOutput: string;
    sha256: string;
    byteLength: number;
}

export interface TextFontSource {
    source: string;
    assetOutput: string;
    sha256: string;
}

interface TextAtlas<Blob> {
    curveSetId: string;
    version: number;
    /** Full padded CPU rows, distinct from the used texel range. */
    curves: { width: number; height: number; usedTexels: number; bytes: Blob };
    bands: { width: number; height: number; usedTexels: number; bytes: Blob };
    metadata: { count: number; strideBytes: number; capacityBytes: number; bytes: Blob };
}

/** Capacity fields describe pin CPU storage, not later GPU allocation sizes. */
interface TextStorage<Blob> {
    width: number;
    height: number;
    versions: { data: number; style: number; layout: number };
    dirtyRange: { start: number; end: number };
    instances: { count: number; strideBytes: number; capacityBytes: number; bytes: Blob };
    styles: { count: number; strideBytes: number; capacityBytes: number; bytes: Blob };
    atlases: TextAtlas<Blob>[];
    groups: { atlasIndex: number; groupKey: string; slotStart: number; slotCount: number; liveCount: number }[];
}

export interface TextProvenance {
    pin: { package: string; version: string; sourceVersion: string };
    modules: { path: string; sha256: string }[];
    /** Hash of the actual font bytes and the complete ordered argument payload. */
    argumentsSha256: string;
}

export interface CompiledTextData extends TextStorage<TextBlob> {
    /** Construction identity; identical payloads never merge source objects. */
    id: number;
    font: TextFontSource;
    layout: StaticTextLayout;
    provenance: TextProvenance;
}

export interface BakedTextData extends TextStorage<string> {
    provenance: TextProvenance;
}

export function textSha256(bytes: string | Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** The loaded package closure includes its vendored shaper, not just wrapper modules. */
function textModuleClosure(layout: boolean): { path: string; source: string }[] {
    const modules = new Map<string, string>();
    const visit = (path: string): void => {
        if (modules.has(path)) return;
        const source = readPinnedLibraryModule(path);
        modules.set(path, source);
        const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        for (const specifier of moduleSpecifiers(file)) {
            if (!specifier.text.startsWith(".")) {
                throw new Error(`Pinned text dependency '${specifier.text}' is not packaged locally.`);
            }
            visit(posix.normalize(posix.join(posix.dirname(path), specifier.text)));
        }
    };
    visit("text/font.js");
    if (layout) visit("text/default-text-data.js");
    return [...modules].sort(([a], [b]) => a.localeCompare(b)).map(([path, source]) => ({ path, source }));
}

/** Synchronous entry-walk bridge. Cache keys include every byte the pin executes. */
export function materializePinnedText(fontBytes: Uint8Array, layout?: StaticTextLayout): BakedTextData | undefined {
    const modules = textModuleClosure(layout !== undefined);
    const request = JSON.stringify({ font: Buffer.from(fontBytes).toString("base64"), layout }, (_key, value: unknown) => {
        if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
            throw new Error("Static text arguments must be finite and not negative zero.");
        }
        return value;
    });
    const result = cachedBakeSync({
        kind: "pinned-text-data",
        version: "2",
        module: moduleIdentity(import.meta.url),
        browser: false,
        parameters: { requestSha256: textSha256(request), modules: modules.map(({ path }) => path) },
        inputs: [fontBytes, ...modules.map(({ source }) => Buffer.from(source))],
    }, () => Buffer.from(runGenerationChild({
        label: "Pinned static font/text data",
        input: request,
        script: `import { readFileSync } from 'node:fs';
import { executePinnedText } from ${JSON.stringify(import.meta.url)};
const request = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(await executePinnedText(Buffer.from(request.font, 'base64'), request.layout)));`,
    })));
    const storage = JSON.parse(Buffer.from(result).toString("utf8")) as TextStorage<string> | null;
    if (!storage) return undefined;
    const pin = readUpstreamPin();
    return {
        ...storage,
        provenance: {
            pin: { package: pin.package, version: pin.version, sourceVersion: pin.sourceVersion },
            modules: modules.map(({ path, source }) => ({ path, sha256: textSha256(source) })),
            argumentsSha256: textSha256(request),
        },
    };
}

interface PinnedAtlas {
    _version: number;
    _curveTexData: Float32Array; _curveTexelsUsed: number;
    _bandTexData: Float32Array; _bandTexelsUsed: number;
    _metaData: Float32Array; _slotCount: number;
}

/** Exported only for the generation child; no shaper or allocator logic is reproduced. */
export async function executePinnedText(fontBytes: Uint8Array, layout?: StaticTextLayout): Promise<TextStorage<string> | null> {
    const { createFontFromBuffer } = await importPinnedModule<{
        createFontFromBuffer(bytes: ArrayBuffer): unknown;
    }>("text/font.js");
    const font = createFontFromBuffer(Uint8Array.from(fontBytes).buffer);
    if (!layout) return null;
    const { createDefaultTextData } = await importPinnedModule<{
        createDefaultTextData(font: unknown, size: number, text: string, color?: readonly number[], options?: StaticTextLayout["options"]): {
            width: number; height: number;
            _version: number; _styleVersion: number; _layoutVersion: number;
            _dirtyStart: number; _dirtyEnd: number;
            _instances: Float32Array; _instanceCount: number;
            _styles: Float32Array; _styleCount: number;
            _groups: { _curveSetId: string; _curveSet: { _atlas: PinnedAtlas }; _groupKey: unknown; _slotStart: number; _slotCount: number; _liveCount: number }[];
        };
    }>("text/default-text-data.js");
    const constants = await importPinnedModule<{ TEXT_INSTANCE_BYTES: number; TEXT_STYLE_BYTES: number }>("text/text-data.js");
    const atlasConstants = await importPinnedModule<{ TEX_WIDTH: number; GLYPH_METADATA_FLOATS: number }>("text/glyph-storage.js");
    const data = createDefaultTextData(font, layout.fontSizePx, layout.text, layout.color, layout.options);
    if (![data.width, data.height].every((value) => Number.isFinite(value) && !Object.is(value, -0))) {
        throw new Error("Pinned text dimensions must be finite and not negative zero for static materialization.");
    }
    const bytes = (array: Float32Array, length = array.byteLength): string =>
        Buffer.from(array.buffer, array.byteOffset, length).toString("base64");
    const stream = (array: Float32Array, count: number, strideBytes: number) => ({
        count, strideBytes, capacityBytes: array.byteLength, bytes: bytes(array, count * strideBytes),
    });
    const texture = (array: Float32Array, usedTexels: number) => ({
        width: atlasConstants.TEX_WIDTH,
        height: array.length / (atlasConstants.TEX_WIDTH * 4),
        usedTexels,
        bytes: bytes(array),
    });
    const atlases: TextAtlas<string>[] = [];
    const indices = new Map<PinnedAtlas, number>();
    const groups = data._groups.map((group) => {
        if (typeof group._groupKey !== "string" || group._groupKey !== group._curveSetId) {
            throw new Error("Static default text data cannot materialize styled draw-group identities.");
        }
        const atlas = group._curveSet._atlas;
        let atlasIndex = indices.get(atlas);
        if (atlasIndex === undefined) {
            atlasIndex = atlases.length;
            indices.set(atlas, atlasIndex);
            atlases.push({
                curveSetId: group._curveSetId,
                version: atlas._version,
                curves: texture(atlas._curveTexData, atlas._curveTexelsUsed),
                bands: texture(atlas._bandTexData, atlas._bandTexelsUsed),
                metadata: stream(atlas._metaData, atlas._slotCount, atlasConstants.GLYPH_METADATA_FLOATS * Float32Array.BYTES_PER_ELEMENT),
            });
        }
        return { atlasIndex, groupKey: group._groupKey, slotStart: group._slotStart, slotCount: group._slotCount, liveCount: group._liveCount };
    });
    return {
        width: data.width, height: data.height,
        versions: {data: data._version, style: data._styleVersion, layout: data._layoutVersion},
        dirtyRange: {start: data._dirtyStart, end: data._dirtyEnd},
        // The third instance word is packed u32. Copy its bytes, never its JS float value.
        instances: stream(data._instances, data._instanceCount, constants.TEXT_INSTANCE_BYTES),
        styles: stream(data._styles, data._styleCount, constants.TEXT_STYLE_BYTES),
        atlases, groups,
    };
}
