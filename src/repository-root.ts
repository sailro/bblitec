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

export function findRepositoryRoot(start = process.cwd()): string {
    let current = resolve(start);
    while (true) {
        if (
            existsSync(join(current, "upstream", "babylon-lite.json")) &&
            existsSync(join(current, "package.json"))
        )
            return current;
        const parent = dirname(current);
        if (parent === current) {
            throw new Error(
                `Unable to locate the bblitec repository from '${start}'.`,
            );
        }
        current = parent;
    }
}
