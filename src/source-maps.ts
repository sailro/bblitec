import { readFileSync } from "node:fs";

/** One source a source map names, with the text it carries for it, if any. */
export interface SourceMapSource {
    readonly source: string;
    readonly content: string | undefined;
}

/** The sources a `.js.map` file names, in its order. */
export function sourceMapSources(mapPath: string): SourceMapSource[] {
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
        sources?: string[];
        sourcesContent?: Array<string | null>;
    };
    return (map.sources ?? []).map((source, index) => ({
        source,
        content: map.sourcesContent?.[index] ?? undefined,
    }));
}
