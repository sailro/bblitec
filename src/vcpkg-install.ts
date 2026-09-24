import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runChecked } from "./tooling/logged-process.js";
import {
    contentFingerprint,
    hashEntries,
    toolIdentity,
} from "./tooling/records.js";

export interface VcpkgManifestInstall {
    installedDirectory: string;
    triplet: string;
    features: readonly string[];
}

/** Reconcile one manifest install when its manifest, overlays, features, triplet
 * or tool identity changes. Complete this before parallel consumer builds. */
export function installVcpkgManifest(
    vcpkgExecutable: string,
    install: VcpkgManifestInstall,
    environment: NodeJS.ProcessEnv,
): void {
    const stampPath = join(install.installedDirectory, ".bblite-install-stamp");
    const manifest = contentFingerprint(
        ["vcpkg.json", "vcpkg-configuration.json", "vcpkg-overlay-ports"].map(
            (name) => resolve("native", name),
        ),
    );
    const stamp = hashEntries([
        "vcpkg-install v3",
        `triplet ${install.triplet}`,
        `features ${install.features.join(";")}`,
        `vcpkg ${toolIdentity(vcpkgExecutable)}`,
        `manifest ${manifest}`,
    ]);
    if (
        existsSync(stampPath) &&
        readFileSync(stampPath, "utf8").trim() === stamp
    ) {
        return;
    }
    runChecked(
        vcpkgExecutable,
        [
            "install",
            `--x-manifest-root=${resolve("native")}`,
            `--x-install-root=${install.installedDirectory}`,
            `--triplet=${install.triplet}`,
            ...install.features.map((feature) => `--x-feature=${feature}`),
        ],
        environment,
    );
    writeFileSync(stampPath, `${stamp}\n`);
}
