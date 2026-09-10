import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findRepositoryRoot(start = process.cwd()): string {
    let current = resolve(start);
    while (true) {
        if (existsSync(join(current, "upstream", "babylon-lite.json")) &&
            existsSync(join(current, "package.json"))) return current;
        const parent = dirname(current);
        if (parent === current) {
            throw new Error(`Unable to locate the bblitec repository from '${start}'.`);
        }
        current = parent;
    }
}
