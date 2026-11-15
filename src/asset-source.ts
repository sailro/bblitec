import { closeSync, openSync, readSync } from "node:fs";
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

/** A file's first `length` bytes, or all of a shorter file. */
export function readFilePrefix(path: string, length: number): Buffer {
    const prefix = Buffer.alloc(length);
    const file = openSync(path, "r");
    try {
        return prefix.subarray(0, readSync(file, prefix, 0, length, 0));
    } finally {
        closeSync(file);
    }
}
