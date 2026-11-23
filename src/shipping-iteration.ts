import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
    deployedPayloads,
    generatorWouldReconfigure,
    incompatibleCacheEntries,
    payloadOrphans,
    readCacheSnapshot,
} from "./build-stamp.js";
import { assertPackageChild, packageFiles } from "./package-output.js";
import type { ShippingScene } from "./shipping-demos.js";
import {
    contentDigest,
    hashEntries,
    writeJsonRecord,
} from "./tooling/records.js";

const receipt = ".bblite-shipping-build.json";

/** Check the requested profile before allowing even a dependency install. Never
 * adopt a populated, unrecognized build directory (including a development build). */
export function shippingBuildState(
    root: string,
    scene: ShippingScene,
    args: readonly string[],
    toolchain: string,
    installFeatures: readonly string[],
) {
    const directory = scene.buildDirectory;
    const path = join(directory, receipt);
    assertPackageChild(root, path);
    const configuration = hashEntries([
        JSON.stringify(args),
        toolchain,
        JSON.stringify([
            scene.platform,
            scene.runtime,
            scene.features,
            scene.codecs,
            installFeatures,
        ]),
    ]);
    if (!existsSync(directory) || !readdirSync(directory).length)
        return { configuration, cache: undefined, dependencies: undefined };
    const record: unknown = existsSync(path)
        ? JSON.parse(readFileSync(path, "utf8"))
        : null;
    const cache = readCacheSnapshot(directory);
    if (
        typeof record !== "object" ||
        record === null ||
        !("configuration" in record) ||
        record.configuration !== configuration ||
        !("dependencies" in record) ||
        typeof record.dependencies !== "string" ||
        !("cache" in record) ||
        typeof record.cache !== "string" ||
        !cache ||
        incompatibleCacheEntries(cache.configuration, args).length ||
        cache.digest !== record.cache
    )
        throw new Error(
            `Refusing to reuse ${directory}: missing or mismatched shipping configuration. Move it aside first.`,
        );
    // Refuse, rather than guessing whether an orphan came from an older
    // deployment or belongs to the user. Let the build deploy new/changed files.
    for (const payload of deployedPayloads(
        directory,
        scene.output,
        directory,
        cache.configuration,
    )) {
        assertPackageChild(directory, payload.deployed);
        // Check links before letting CMake copy assets into this directory.
        const files = existsSync(payload.deployed)
            ? packageFiles(payload.deployed)
            : [];
        const [unexpected] = payloadOrphans(payload, files);
        if (unexpected)
            throw new Error(
                `Unexpected shipping payload: ${join(payload.deployed, unexpected)}. Move it aside first.`,
            );
    }
    const dll = readdirSync(directory).find((name) =>
        name.toLowerCase().endsWith(".dll"),
    );
    if (dll)
        throw new Error(
            `Unexpected DLL in static shipping directory: ${join(directory, dll)}.`,
        );
    return {
        configuration,
        cache: record.cache,
        dependencies: record.dependencies,
    };
}

export async function buildShippingTree(
    root: string,
    scene: ShippingScene,
    args: string[],
    state: ReturnType<typeof shippingBuildState>,
    dependencies: string,
    jobs: number,
    run: (stage: "configure" | "build", args: string[]) => Promise<void>,
): Promise<void> {
    const directory = scene.buildDirectory;
    if (state.dependencies !== undefined && state.dependencies !== dependencies)
        throw new Error(
            `Refusing to reuse ${directory}: shipping dependency identity changed. Move it aside first.`,
        );
    if (
        state.dependencies === undefined ||
        generatorWouldReconfigure(directory, scene.output, root)
    )
        await run("configure", args);
    await run("build", [
        "--build",
        directory,
        "--config",
        "Release",
        "--parallel",
        String(jobs),
    ]);
    const path = join(directory, receipt);
    const next = {
        configuration: state.configuration,
        dependencies,
        cache: contentDigest(join(directory, "CMakeCache.txt")),
    };
    if (next.cache !== state.cache) writeJsonRecord(path, next);
}
