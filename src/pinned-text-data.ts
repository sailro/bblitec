/**
 * Executes the pin's font, shaper and text data at generation and transports
 * the records it built.
 *
 * Static text crosses as the pin's own `DefaultTextData`; live text crosses
 * as the font's packaged repertoire (a `GlyphStorage` holding every outline),
 * from which the native `createDefaultTextData` builds each text at run time.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";
import { runGenerationChild } from "./compiler/generation-child.js";
import {
    importPinnedModule,
    readPinnedLibraryModule,
} from "./pinned-shader-composer.js";
import {
    transportGraph,
    type TransportedGraph,
    type TransportSchema,
} from "./pinned-record-transport.js";
import { moduleSpecifiers } from "./typescript-module-specifiers.js";
import { readUpstreamPin } from "./upstream-source.js";

export interface StaticTextLayout {
    /** Package the pinned font repertoire for later native layout updates. */
    live?: true;
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

export interface TextProvenance {
    pin: { package: string; version: string; sourceVersion: string };
    modules: { path: string; sha256: string }[];
    /** Hash of the actual font bytes and the complete ordered argument payload. */
    argumentsSha256: string;
}

/** What the pin built, before its buffers are packaged. */
export interface BakedText {
    /** Static text: the pin's `DefaultTextData`. */
    data?: TransportedGraph;
    /** Live text: the font's family curve-set id and packaged repertoire. */
    repertoire?: { curveSetId: string; storage: TransportedGraph };
    provenance: TextProvenance;
}

export interface CompiledTextData {
    /** Construction identity; identical payloads never merge source objects. */
    readonly id: number;
    readonly font: TextFontSource;
    readonly layout: StaticTextLayout;
    readonly provenance: TextProvenance;
    readonly data?: TransportedGraph;
    readonly repertoire?: { curveSetId: string; storage: TransportedGraph };
    /** The transported buffers of `data` or `repertoire.storage`, packaged. */
    readonly buffers: readonly TextBlob[];
}

export function textSha256(bytes: string | Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** The loaded package closure includes its vendored shaper, not just wrapper modules. */
function textModuleClosure(
    layout: boolean,
): { path: string; source: string }[] {
    const modules = new Map<string, string>();
    const visit = (path: string): void => {
        if (modules.has(path)) return;
        const source = readPinnedLibraryModule(path);
        modules.set(path, source);
        const file = ts.createSourceFile(
            path,
            source,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.JS,
        );
        for (const specifier of moduleSpecifiers(file)) {
            if (!specifier.text.startsWith(".")) {
                throw new Error(
                    `Pinned text dependency '${specifier.text}' is not packaged locally.`,
                );
            }
            visit(
                posix.normalize(
                    posix.join(posix.dirname(path), specifier.text),
                ),
            );
        }
    };
    visit("text/font.js");
    if (layout) visit("text/default-text-data.js");
    return [...modules]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, source]) => ({ path, source }));
}

/** Synchronous entry-walk bridge. Cache keys include every byte the pin executes. */
export function materializePinnedText(
    fontBytes: Uint8Array,
    layout?: StaticTextLayout,
    schema?: TransportSchema,
): BakedText | undefined {
    const modules = textModuleClosure(layout !== undefined);
    const request = JSON.stringify(
        { font: Buffer.from(fontBytes).toString("base64"), layout, schema },
        (_key, value: unknown) => {
            if (
                typeof value === "number" &&
                (!Number.isFinite(value) || Object.is(value, -0))
            ) {
                throw new Error(
                    "Static text arguments must be finite and not negative zero.",
                );
            }
            return value;
        },
    );
    const result = cachedBakeSync(
        {
            kind: "pinned-text-data",
            version: "3",
            module: moduleIdentity(import.meta.url),
            browser: false,
            parameters: {
                requestSha256: textSha256(request),
                modules: modules.map(({ path }) => path),
            },
            inputs: [
                fontBytes,
                ...modules.map(({ source }) => Buffer.from(source)),
            ],
        },
        () =>
            Buffer.from(
                runGenerationChild({
                    label: "Pinned static font/text data",
                    input: request,
                    script: `import { readFileSync } from 'node:fs';
import { executePinnedText } from ${JSON.stringify(import.meta.url)};
const request = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(await executePinnedText(Buffer.from(request.font, 'base64'), request.layout, request.schema)));`,
                }),
            ),
    );
    const baked = JSON.parse(Buffer.from(result).toString("utf8")) as Omit<
        BakedText,
        "provenance"
    > | null;
    if (!baked) return undefined;
    const pin = readUpstreamPin();
    return {
        ...baked,
        provenance: {
            pin: {
                package: pin.package,
                version: pin.version,
                sourceVersion: pin.sourceVersion,
            },
            modules: modules.map(({ path, source }) => ({
                path,
                sha256: textSha256(source),
            })),
            argumentsSha256: textSha256(request),
        },
    };
}

/** Exported only for the generation child; no shaper or allocator logic is reproduced. */
export async function executePinnedText(
    fontBytes: Uint8Array,
    layout?: StaticTextLayout,
    schema?: TransportSchema,
): Promise<Omit<BakedText, "provenance"> | null> {
    const { createFontFromBuffer } = await importPinnedModule<{
        createFontFromBuffer(
            this: void,
            bytes: ArrayBuffer,
        ): { _font: { numGlyphs: number } };
    }>("text/font.js");
    const font = createFontFromBuffer(Uint8Array.from(fontBytes).buffer);
    if (!layout || !schema) return null;
    const { createDefaultTextData } = await importPinnedModule<{
        createDefaultTextData(
            this: void,
            font: unknown,
            size: number,
            text: string,
            color?: readonly number[],
            options?: StaticTextLayout["options"],
        ): { _storage: unknown; _curveSetId: string };
    }>("text/default-text-data.js");
    if (!layout.live) {
        const data = createDefaultTextData(
            font,
            layout.fontSizePx,
            layout.text,
            layout.color,
            layout.options,
        );
        return {
            data: transportGraph(
                data,
                { kind: "record", name: "DefaultTextData" },
                schema,
            ),
        };
    }
    // The packaged repertoire: the storage an empty text owns, with every
    // glyph the font carries extracted into it by the pin's own extractor.
    const { extractGlyphCurves } = await importPinnedModule<{
        extractGlyphCurves(
            this: void,
            font: unknown,
            ids: Set<number>,
            curves: Map<number, unknown>,
        ): void;
    }>("text/glyph-extraction.js");
    const { updateGlyphStorage } = await importPinnedModule<{
        updateGlyphStorage(
            this: void,
            storage: unknown,
            id: string,
            curves: Map<number, unknown>,
        ): void;
    }>("text/glyph-storage.js");
    const data = createDefaultTextData(font, layout.fontSizePx, "");
    const curves = new Map<number, unknown>();
    extractGlyphCurves(
        font,
        new Set(Array.from({ length: font._font.numGlyphs }, (_, id) => id)),
        curves,
    );
    updateGlyphStorage(data._storage, data._curveSetId, curves);
    return {
        repertoire: {
            curveSetId: data._curveSetId,
            storage: transportGraph(
                data._storage,
                { kind: "record", name: "GlyphStorage" },
                schema,
            ),
        },
    };
}
