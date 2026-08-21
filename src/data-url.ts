/**
 * A `data:` URL, read as the asset it already is.
 *
 * Every other reached asset URL names bytes somewhere else — a host to fetch
 * from, or a file beside the scene — so materialization is a download or a
 * read. A `data:` URL is neither: the bytes are in the source text, so the
 * URL *is* the asset and materializing it is a decode. Upstream draws no
 * distinction at all (`loadTexture2D` hands whatever it was given to
 * `fetch`, which serves a data URL from the string), which is why nothing in
 * the pinned loaders marks the case.
 *
 * Only the base64 form is read. A percent-encoded body is legal in the URL
 * syntax and no reached scene writes one, so it refuses by name rather than
 * decoding through a second path this repository would then have to keep
 * agreeing with the first.
 */

/** The media type and bytes a `data:` URL carries. */
export interface DataUrlPayload {
    /** The declared media type, lowercased, or an empty string when absent. */
    mediaType: string;
    bytes: Uint8Array;
}

/** Whether a reached asset source is a `data:` URL rather than a location. */
export function isDataUrl(source: string): boolean {
    return /^data:/i.test(source);
}

/**
 * The bytes a `data:` URL carries, or `undefined` when it is not one.
 *
 * A malformed data URL throws rather than returning undefined: "not a data
 * URL" and "a data URL this cannot read" are different answers, and only the
 * first has a fallback.
 */
export function parseDataUrl(source: string): DataUrlPayload | undefined {
    const header = parseDataUrlHeader(source);
    if (!header) return undefined;
    return {
        mediaType: header.mediaType,
        // A Buffer already IS a Uint8Array; wrapping its view avoids copying
        // the decoded payload a second time.
        bytes: Buffer.from(source.slice(header.bodyStart), "base64"),
    };
}

/**
 * The media type alone, without decoding the payload.
 *
 * Naming the packaged file needs the type and nothing else, and the body of
 * an inline texture is the whole image -- decoding it to pick an extension,
 * and again to write the file, is the whole payload twice.
 */
export function dataUrlMediaType(source: string): string | undefined {
    return parseDataUrlHeader(source)?.mediaType;
}

function parseDataUrlHeader(
    source: string,
): { mediaType: string; bodyStart: number } | undefined {
    if (!isDataUrl(source)) return undefined;
    const comma = source.indexOf(",");
    if (comma < 0) {
        throw new Error(`A data URL carries no payload: ${preview(source)}.`);
    }
    const parameters = source.slice("data:".length, comma).split(";");
    const base64 = parameters.some(
        (parameter) => parameter.trim().toLowerCase() === "base64",
    );
    if (!base64) {
        throw new Error(
            "Only base64 data URLs are materialized; " +
                `${preview(source)} is percent-encoded.`,
        );
    }
    return {
        mediaType: (parameters[0] ?? "").trim().toLowerCase(),
        bodyStart: comma + 1,
    };
}

/**
 * The file name a data URL's asset packages under.
 *
 * The URL text is the payload, so it names nothing: the packaged name comes
 * from the media type instead, which is what keeps the reached image codecs
 * derivable from the file that lands beside the executable.
 */
export function dataUrlAssetName(source: string): string {
    const subtype = (dataUrlMediaType(source) ?? "").split("/")[1] ?? "";
    const extension = /^[a-z0-9.+-]+$/.test(subtype) && subtype
        ? subtype.replace(/\+.*$/, "")
        : "bin";
    return `inline.${extension === "jpeg" ? "jpg" : extension}`;
}

/**
 * A JavaScript module as a `data:` URL, for importing text that was never
 * written to disk.
 *
 * Three places already needed this -- the pinned-module executor, the
 * material-input stubs and the graph runner -- and a fourth is where a
 * spelling starts to drift, so it is stated once beside the reader.
 */
export function javascriptModuleUrl(source: string): string {
    return `data:text/javascript;base64,${
        Buffer.from(source, "utf8").toString("base64")
    }`;
}

/** A data URL is unreadable in an error; its head identifies it. */
function preview(source: string): string {
    return source.length > 64 ? `${source.slice(0, 64)}...` : source;
}
