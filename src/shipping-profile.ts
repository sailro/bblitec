/**
 * A generated scene's shipping profile: the vcpkg manifest features its
 * trimmed build installs, the image codecs its assets reach and its runtime
 * features, as `tools/shipping-profile.cmake` derives them from the scene's
 * `features.cmake` through `native/dependency-features.cmake`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepositoryRoot } from "./repository-root.js";

export interface ShippingFeatures {
    features: string[];
    codecs: string[];
    runtime: string[];
}

export function readShippingFeatures(text: string): ShippingFeatures {
    const values = new Map(
        text
            .trim()
            .split(/\r?\n/)
            .map((line) => {
                const split = line.indexOf("=");
                if (split < 0)
                    throw new Error(
                        "Malformed shipping profile; regenerate it.",
                    );
                return [line.slice(0, split), line.slice(split + 1)] as const;
            }),
    );
    const list = (key: string): string[] => {
        const value = values.get(key);
        if (
            value === undefined ||
            (value !== "" && !/^[a-z0-9:-]+(?:;[a-z0-9:-]+)*$/.test(value))
        ) {
            throw new Error(`Invalid shipping profile ${key}.`);
        }
        return [...new Set(value === "" ? [] : value.split(";"))].sort();
    };
    return {
        features: list("features"),
        codecs: list("codecs"),
        runtime: list("runtime"),
    };
}

/** The profile of the generated tree at `generatedDirectory`, written to `output`. */
export function writeShippingProfile(
    cmake: string,
    generatedDirectory: string,
    output: string,
): ShippingFeatures {
    const result = spawnSync(
        cmake,
        [
            `-DBBLITE_GENERATED_DIR=${resolve(generatedDirectory)}`,
            `-DBBLITE_PROFILE_OUTPUT=${output}`,
            "-P",
            join(
                findRepositoryRoot(dirname(fileURLToPath(import.meta.url))),
                "tools",
                "shipping-profile.cmake",
            ),
        ],
        { encoding: "utf8", windowsHide: true },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(
            `tools/shipping-profile.cmake failed for ${generatedDirectory}: ${result.stdout}${result.stderr}`,
        );
    return readShippingFeatures(readFileSync(output, "utf8"));
}

/** The profile of the generated tree at `generatedDirectory`. */
export function readShippingProfile(
    cmake: string,
    generatedDirectory: string,
): ShippingFeatures {
    const directory = mkdtempSync(join(tmpdir(), "bblite-profile-"));
    try {
        return writeShippingProfile(
            cmake,
            generatedDirectory,
            join(directory, "profile.txt"),
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
