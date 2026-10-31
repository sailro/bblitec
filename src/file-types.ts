import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compilerRepositoryRoot } from "./repository-root.js";

interface FileTypeDescriptor {
    readonly mime: string;
    readonly extension: string;
    readonly label: string;
}

/** The same descriptor rows included by the native File API. */
export const fileTypes: readonly FileTypeDescriptor[] = readFileSync(
    join(compilerRepositoryRoot(), "native/include/bblite/file_types.inc"),
    "utf8",
)
    .split(/\r?\n/)
    .flatMap((line) => {
        if (!line.trim() || line.trimStart().startsWith("//")) return [];
        const match =
            /^BBLITE_FILE_TYPE\("([a-z/]+)", "([a-z]+)", "([A-Za-z ]+)"\)$/.exec(
                line,
            );
        if (!match) throw new Error(`Invalid file-type descriptor: ${line}`);
        return [{ mime: match[1]!, extension: match[2]!, label: match[3]! }];
    });
