import { resolve, sep } from "node:path";
import ts from "typescript";
import { EmissionMap } from "./compiler/emission-transaction.js";

let libraryFiles: Map<string, ts.SourceFile> | undefined;

/**
 * Whether a path is a declaration file this process parses once: one under
 * `node_modules`, TypeScript's own libraries and the installed packages'
 * typings.
 */
export function isLibraryTyping(path: string): boolean {
    return resolve(path).includes(`${sep}node_modules${sep}`);
}

/**
 * A library typing file, parsed on its first reader and handed to every
 * later program that reads it: a scene's own program and the typed pinned
 * program then share TypeScript's libraries and the WebGPU typings, parsed
 * and bound once.
 */
export function libraryTypingFile(
    path: string,
    load: () => ts.SourceFile | undefined,
): ts.SourceFile | undefined {
    libraryFiles ??= new EmissionMap();
    const key = resolve(path);
    const cached = libraryFiles.get(key);
    if (cached) {
        return cached;
    }
    const sourceFile = load();
    if (sourceFile) {
        libraryFiles.set(key, sourceFile);
    }
    return sourceFile;
}
