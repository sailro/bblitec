import {
    existsSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
    DEVELOPMENT_VCPKG_INSTALL,
    developmentTriplet,
    developmentVcpkgFeatures,
} from "./build-options.js";
import { discoverDevelopmentTools } from "./development-tools.js";
import { artifactDirectory } from "./tooling/artifacts.js";
import { isMainModule, parseFlags } from "./tooling/flags.js";
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

const stampName = ".bblite-install-stamp";

/** Installs kept per install name: the current manifest's and the two most recently used others. */
const keptInstalls = 3;

/** What vcpkg reads from this checkout: its manifest, configuration and overlay ports. */
function manifestIdentity(): string {
    return contentFingerprint(
        ["vcpkg.json", "vcpkg-configuration.json", "vcpkg-overlay-ports"].map(
            (name) => resolve("native", name),
        ),
    );
}

/**
 * `<installRoot>/<name>-<manifest key>`: checkouts of different manifests
 * (worktrees sharing one install root) each reconcile their own install
 * instead of reinstalling a shared one on every build.
 */
export function vcpkgInstallDirectory(
    installRoot: string,
    name: string,
): string {
    return resolve(installRoot, `${name}-${manifestIdentity().slice(0, 12)}`);
}

/** The shared install every development tree links against: the full manifest feature set. */
export function developmentVcpkgInstall(): VcpkgManifestInstall {
    return {
        installedDirectory: vcpkgInstallDirectory(
            process.env.BBLITE_VCPKG_INSTALLED_ROOT ??
                artifactDirectory("vcpkg-installed"),
            DEVELOPMENT_VCPKG_INSTALL,
        ),
        triplet: developmentTriplet(),
        features: developmentVcpkgFeatures(
            readFileSync(resolve("native", "vcpkg.json"), "utf8"),
        ),
    };
}

/**
 * Removes the installs of other manifests under the same name beyond the
 * `keptInstalls` most recently used (their stamps' times). The stamp goes
 * first, so an install that cannot be removed whole is reinstalled by its
 * next user rather than trusted.
 */
function pruneManifestInstalls(installedDirectory: string): void {
    const root = dirname(installedDirectory);
    const name = basename(installedDirectory).replace(/-[0-9a-f]{12}$/, "");
    const siblings = readdirSync(root, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isDirectory() &&
                entry.name.length === name.length + 13 &&
                entry.name.startsWith(`${name}-`) &&
                /^[0-9a-f]{12}$/.test(entry.name.slice(name.length + 1)),
        )
        .map((entry) => {
            const stamp = join(root, entry.name, stampName);
            return {
                path: join(root, entry.name),
                used: existsSync(stamp) ? statSync(stamp).mtimeMs : 0,
            };
        })
        .sort((left, right) => right.used - left.used);
    for (const stale of siblings.slice(keptInstalls)) {
        if (resolve(stale.path) === resolve(installedDirectory)) continue;
        try {
            rmSync(join(stale.path, stampName), { force: true });
            rmSync(stale.path, { recursive: true, force: true });
            console.log(`vcpkg: removed the unused install ${stale.path}`);
        } catch (error) {
            console.warn(
                `vcpkg: could not remove the unused install ${stale.path}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

/** Reconcile one manifest install when its features, triplet or tool identity
 * changes (its directory is keyed by the manifest, `vcpkgInstallDirectory`).
 * Complete this before parallel consumer builds. */
export function installVcpkgManifest(
    vcpkgExecutable: string,
    install: VcpkgManifestInstall,
    environment: NodeJS.ProcessEnv,
): void {
    const stampPath = join(install.installedDirectory, stampName);
    const stamp = hashEntries([
        "vcpkg-install v3",
        `triplet ${install.triplet}`,
        `features ${install.features.join(";")}`,
        `vcpkg ${toolIdentity(vcpkgExecutable)}`,
        `manifest ${manifestIdentity()}`,
    ]);
    if (
        !existsSync(stampPath) ||
        readFileSync(stampPath, "utf8").trim() !== stamp
    ) {
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
    } else {
        const now = new Date();
        utimesSync(stampPath, now, now);
    }
    pruneManifestInstalls(install.installedDirectory);
}

/**
 * The PowerShell builders' way to the same keyed installs:
 * `development` prints the development install directory; `install --name
 * <name> --triplet <triplet> [--features a,b]` reconciles that install and
 * prints its directory as the last line.
 */
function main(): void {
    const parsed = parseFlags(
        process.argv.slice(2),
        { value: ["--name", "--triplet", "--features"], positionals: 1 },
        "vcpkg-install",
    );
    const action = parsed.positionals[0];
    if (action === "development") {
        console.log(developmentVcpkgInstall().installedDirectory);
        return;
    }
    const name = parsed.values.get("--name");
    const triplet = parsed.values.get("--triplet");
    if (action !== "install" || !name || !triplet)
        throw new Error(
            "vcpkg-install: development | install --name <name> --triplet <triplet> [--features a,b]",
        );
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        throw new Error(`vcpkg-install: invalid install name '${name}'.`);
    const vcpkg = discoverDevelopmentTools().vcpkg;
    if (!vcpkg) throw new Error("vcpkg was not found; run npm run doctor.");
    const install: VcpkgManifestInstall = {
        installedDirectory: vcpkgInstallDirectory(
            process.env.BBLITE_VCPKG_INSTALLED_ROOT ??
                artifactDirectory("vcpkg-installed"),
            name,
        ),
        triplet,
        features: (parsed.values.get("--features") ?? "")
            .split(",")
            .filter(Boolean)
            .sort(),
    };
    installVcpkgManifest(vcpkg, install, process.env);
    console.log(install.installedDirectory);
}

if (isMainModule(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
