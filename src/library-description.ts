// A library description (`lite/library.json`): what the C++ library is
// generated from instead of a program (`src/library-manifest.ts`). Kept free
// of the compiler's modules, so the scene registry can classify an input
// without loading them.
import { extname } from "node:path";
import { arrayOf, asObject, isString, jsonValue } from "./json-fields.js";

export interface LibraryDescription {
    /** The runtime features the library bundles. */
    features: string[];
    /** The image codecs it bundles: its clients decode their own images. */
    imageCodecs: string[];
}

/** Whether `path` names a library description rather than a program. */
export function isLibraryDescription(path: string): boolean {
    return extname(path).toLowerCase() === ".json";
}

export function parseLibraryDescription(
    text: string,
    fileName: string,
): LibraryDescription {
    const description = asObject(JSON.parse(text));
    const list = (key: string): string[] =>
        jsonValue(
            description?.[key],
            (value): value is string[] => arrayOf(value, isString),
            `${fileName}: a library description lists its ${key} as an array of names.`,
        );
    return { features: list("features"), imageCodecs: list("imageCodecs") };
}
