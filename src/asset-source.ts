import { dirname, resolve } from "node:path";

import { isDataUrl } from "./data-url.js";

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
