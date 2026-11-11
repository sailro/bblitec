import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let compilerRoot: string | undefined;

/** The checkout this compiler runs from, whatever the working directory. */
export function compilerRepositoryRoot(): string {
    return (compilerRoot ??= findRepositoryRoot(
        dirname(fileURLToPath(import.meta.url)),
    ));
}

/** The emitted compiler (`<dist>/src`) this process runs, whatever the working directory. */
export function compilerDistSource(): string {
    return dirname(fileURLToPath(import.meta.url));
}

export function findRepositoryRoot(start = process.cwd()): string {
    const root = enclosingRepositoryRoot(start);
    if (root === undefined)
        throw new Error(
            `Unable to locate the bblitec repository from '${start}'.`,
        );
    return root;
}

/** The bblitec checkout `start` lies in; undefined outside every checkout. */
export function enclosingRepositoryRoot(start: string): string | undefined {
    for (let current = resolve(start); ;) {
        if (
            existsSync(join(current, "upstream", "babylon-lite.json")) &&
            existsSync(join(current, "package.json"))
        )
            return current;
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}
