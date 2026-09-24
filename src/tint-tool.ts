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
import { readPatchManifest } from "./patch-inventory.js";
import { listFiles } from "./tooling/records.js";

/** The command that builds this checkout's bblite-tint. */
export const tintToolBuildCommand = "pwsh -File tools/build-tint.ps1";

function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Every source a bblite-tint build of the checkout at `root` reads, keyed by
 * repository-relative POSIX path, with its SHA-256; a source the checkout
 * lacks is absent.
 */
export function tintToolSources(root: string): Map<string, string> {
    const manifest = join(root, "native", "patches", "manifest.json");
    // Dawn's `tint` series, as native/patch-identity.cmake selects it.
    const patches = existsSync(manifest)
        ? readPatchManifest(root)
              .patches.filter(
                  (patch) =>
                      patch.library === "dawn" &&
                      (patch.variants.includes("tint") ||
                          patch.variants.includes("all")),
              )
              .map((patch) => join(root, patch.file))
        : [];
    const files = [
        join(root, "tools", "build-tint.ps1"),
        join(root, "upstream", "tint.json"),
        ...listFiles(join(root, "tools", "tint-sdl")),
        ...patches,
    ].filter((path) => existsSync(path));
    return new Map(
        files.map((path) => [
            relative(root, path).split(sep).join("/"),
            sha256(path),
        ]),
    );
}

/** One digest of every source a bblite-tint build of the checkout at `root` reads. */
export function tintToolSourceDigest(root: string): string {
    return createHash("sha256")
        .update(
            [...tintToolSources(root)]
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
): string | undefined {
    const recorded = recordedSources(tool);
    if (typeof recorded === "string") return recorded;
    const expected = tintToolSources(root);
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
    platform: NodeJS.Platform = process.platform,
): string | undefined {
    const tool = findTintTool(root, platform);
    const command =
        tool && join(dirname(tool), platform === "win32" ? "tint.exe" : "tint");
    return command && existsSync(command) ? command : undefined;
}

/** The bblite-tint built from the checkout at `root`'s own sources, if any. */
export function findTintTool(
    root: string,
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
                existsSync(tool) && tintToolMismatch(tool, root) === undefined,
        );
}
