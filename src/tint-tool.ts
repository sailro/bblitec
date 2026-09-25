/**
 * bblite-tint's source identity. `tools/build-tint.ps1` records every source a
 * build of the tool reads -- itself, the Tint pin, `tools/tint-sdl` and Dawn's
 * `tint` patch series -- by repository-relative path and SHA-256 in the
 * `provenance.json` beside the tool, and builds each distinct set into its
 * own `artifacts/tools/tint/<identity>` directory, so checkouts with other
 * tool sources never overwrite this one's. A checkout uses only a tool that
 * records exactly its own sources.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { runPatchIdentity } from "./patch-inventory.js";
import { contentDigest, listFiles } from "./tooling/records.js";

/** The command that builds this checkout's bblite-tint. */
export const tintToolBuildCommand = "pwsh -File tools/build-tint.ps1";

/** Dawn's `tint` series per checkout, CMake and manifest/owner content. */
const tintSeries = new Map<string, readonly string[]>();

/**
 * Dawn's `tint` patch series of the checkout at `root`, as
 * native/patch-identity.cmake selects it (none without a manifest).
 */
function tintPatchSeries(
    root: string,
    cmake: string | undefined,
): readonly string[] {
    const manifest = join(root, "native", "patches", "manifest.json");
    if (!existsSync(manifest)) return [];
    if (cmake === undefined)
        throw new Error(
            "Reading bblite-tint's sources needs CMake for Dawn's tint patch series (native/patch-identity.cmake); run npm run doctor.",
        );
    const owner = join(root, "native", "patch-identity.cmake");
    const key = [
        root,
        cmake,
        contentDigest(manifest),
        contentDigest(owner),
    ].join("\n");
    let series = tintSeries.get(key);
    if (series === undefined) {
        series = runPatchIdentity(
            cmake,
            "series",
            "dawn",
            { variants: ["tint"] },
            root,
        )
            .split("\n")
            .filter(Boolean);
        tintSeries.set(key, series);
    }
    return series;
}

/**
 * Every source a bblite-tint build of the checkout at `root` reads, keyed by
 * repository-relative POSIX path, with its SHA-256; a source the checkout
 * lacks is absent. `cmake` reads Dawn's `tint` patch series.
 */
export function tintToolSources(
    root: string,
    cmake: string | undefined,
): Map<string, string> {
    const files = [
        join(root, "tools", "build-tint.ps1"),
        join(root, "upstream", "tint.json"),
        ...listFiles(join(root, "tools", "tint-sdl")),
        ...tintPatchSeries(root, cmake),
    ].filter((path) => existsSync(path));
    return new Map(
        files.map((path) => [
            relative(root, path).split(sep).join("/"),
            contentDigest(path),
        ]),
    );
}

/** One digest of every source a bblite-tint build of the checkout at `root` reads. */
export function tintToolSourceDigest(
    root: string,
    cmake: string | undefined,
): string {
    return createHash("sha256")
        .update(
            [...tintToolSources(root, cmake)]
                .map(([source, digest]) => `${source}:${digest}`)
                .sort()
                .join("\n"),
        )
        .digest("hex");
}

/** The sources a tool's `provenance.json` records, or why it records none. */
function recordedSources(tool: string): Map<string, string> | string {
    const path = join(dirname(tool), "provenance.json");
    if (!existsSync(path)) return `${path} does not exist`;
    let provenance: unknown;
    try {
        provenance = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return `${path} is not JSON`;
    }
    if (
        typeof provenance !== "object" ||
        provenance === null ||
        !("sources" in provenance) ||
        typeof provenance.sources !== "object" ||
        provenance.sources === null
    )
        return `${path} records no sources`;
    const sources = new Map<string, string>();
    for (const [source, digest] of Object.entries(provenance.sources)) {
        if (typeof digest !== "string")
            return `${path} records no digest for ${source}`;
        sources.set(source, digest);
    }
    return sources;
}

/**
 * Why the bblite-tint at `tool` is not this checkout's -- its provenance
 * records other sources than those of the checkout at `root` -- or
 * undefined when it is.
 */
export function tintToolMismatch(
    tool: string,
    root: string,
    cmake: string | undefined,
): string | undefined {
    const recorded = recordedSources(tool);
    if (typeof recorded === "string") return recorded;
    let expected: Map<string, string>;
    try {
        expected = tintToolSources(root, cmake);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    const differences = [
        ...[...expected]
            .filter(([source, digest]) => recorded.get(source) !== digest)
            .map(([source]) =>
                recorded.has(source)
                    ? `${source} differs`
                    : `${source} was not among its sources`,
            ),
        ...[...recorded.keys()]
            .filter((source) => !expected.has(source))
            .map((source) => `${source} is not in this checkout`),
    ];
    return differences.length === 0
        ? undefined
        : `it was built from other sources than this checkout's (${differences.join("; ")})`;
}

/** The pinned `tint` command built beside the checkout at `root`'s bblite-tint, if any. */
export function findPinnedTint(
    root: string,
    cmake: string | undefined,
    platform: NodeJS.Platform = process.platform,
): string | undefined {
    const tool = findTintTool(root, cmake, platform);
    const command =
        tool && join(dirname(tool), platform === "win32" ? "tint.exe" : "tint");
    return command && existsSync(command) ? command : undefined;
}

/** The bblite-tint built from the checkout at `root`'s own sources, if any. */
export function findTintTool(
    root: string,
    cmake: string | undefined,
    platform: NodeJS.Platform = process.platform,
): string | undefined {
    const directory = join(root, "artifacts", "tools", "tint");
    if (!existsSync(directory)) return undefined;
    const executable = platform === "win32" ? "bblite-tint.exe" : "bblite-tint";
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(directory, entry.name, executable))
        .find(
            (tool) =>
                existsSync(tool) &&
                tintToolMismatch(tool, root, cmake) === undefined,
        );
}
