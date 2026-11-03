import { dirname, resolve } from "node:path";

import { isDataUrl } from "./data-url.js";

/** The file a URL names: a static host serves its path, whatever its query or fragment. */
export function urlFilePath(url: string): string {
    return url.split(/[?#]/, 1)[0]!;
}

/** Repository file named by an asset source, excluding produced/embedded/remote forms. */
export function localAssetPath(
    source: string,
    inputPath: string,
): string | undefined {
    if (
        /^https?:\/\//i.test(source) ||
        source.startsWith("generated:") ||
        isDataUrl(source)
    ) {
        return undefined;
    }
    return resolve(dirname(inputPath), source);
}
