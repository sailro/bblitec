/**
 * Where a release package is assembled and how it is published, for every
 * platform: a run stages its package under `<root>/.staging/<run>/`, and
 * only a qualified package is published, moving the one it replaces to
 * `<root>/.replaced/<run>/`. The desktop packager calls these directly; the
 * Android and iOS packaging scripts, which drive their platform SDK tools,
 * call the command line below for the same staging, archive, receipt and
 * publication.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    rmdirSync,
    statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { discoverDevelopmentTools } from "./development-tools.js";
import { isMainModule, parseFlags } from "./tooling/flags.js";
import { contentDigest, writeJsonRecord } from "./tooling/records.js";

interface PackageOutput {
    root: string;
    name: string;
    staging: string;
    previous: string;
}

const packageName =
    /^bblitec-[a-z0-9]+(?:-[a-z0-9]+)*-(?:(?:windows|linux|macos)-x64|macos-universal|android-(?:arm64-v8a|x86-64)|ios-arm64)$/;

const samePath = (left: string, right: string): boolean =>
    process.platform === "win32"
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;

/** Refuses a package path that leaves `root` or crosses a link or junction. */
export function assertPackageChild(root: string, path: string): void {
    const rootPath = resolve(root).replace(/[\\/]+$/, "");
    const child = resolve(path);
    const prefix = `${rootPath}${sep}`;
    if (
        !(process.platform === "win32"
            ? child.toLowerCase().startsWith(prefix.toLowerCase())
            : child.startsWith(prefix))
    )
        throw new Error(`Package path escapes output root: ${path}`);
    for (
        let cursor = child;
        !samePath(cursor, rootPath);
        cursor = dirname(cursor)
    ) {
        if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
            throw new Error(
                `Package path crosses a link or junction: ${cursor}`,
            );
    }
}

/** A new staging directory for the package `name` under `root`. */
export function newPackageOutput(root: string, name: string): PackageOutput {
    if (!packageName.test(name))
        throw new Error(`Invalid package name: ${name}`);
    const rootPath = resolve(root);
    const run = `${new Date().toISOString().replaceAll(/[-:.]/g, "")}-${randomUUID().replaceAll("-", "")}`;
    const plan = {
        root: rootPath,
        name,
        staging: join(rootPath, ".staging", run),
        previous: join(rootPath, ".replaced", run),
    };
    for (const path of [plan.staging, plan.previous])
        assertPackageChild(rootPath, path);
    mkdirSync(plan.staging, { recursive: true });
    return plan;
}

/** The plan of a staging directory `newPackageOutput` made. */
function stagedPackageOutput(
    root: string,
    name: string,
    staging: string,
): PackageOutput {
    const rootPath = resolve(root);
    const stagingPath = resolve(staging);
    if (!samePath(dirname(stagingPath), join(rootPath, ".staging")))
        throw new Error(`Not a staging directory of ${rootPath}: ${staging}`);
    if (!packageName.test(name))
        throw new Error(`Invalid package name: ${name}`);
    return {
        root: rootPath,
        name,
        staging: stagingPath,
        previous: join(rootPath, ".replaced", basename(stagingPath)),
    };
}

/** Bytes and upper-case SHA-256 of a package file, as receipts record them. */
export function fileIdentity(path: string): { bytes: number; sha256: string } {
    return {
        bytes: statSync(path).size,
        sha256: contentDigest(path).toUpperCase(),
    };
}

/** Every file under `directory`, as `/`-separated paths, sorted. */
export function packageFiles(directory: string): string[] {
    const files: string[] = [];
    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);
            if (entry.isSymbolicLink())
                throw new Error(`Package payload holds a link: ${path}`);
            if (entry.isDirectory()) walk(path);
            else files.push(relative(directory, path).split(sep).join("/"));
        }
    };
    walk(directory);
    return files.sort();
}

/**
 * Archives the staged package directory as `<staging>/<name>.zip`. libarchive
 * (CMake's tar) records Unix executable permissions in the ZIP metadata.
 */
export function archivePackage(plan: PackageOutput, cmake: string): string {
    const archive = join(plan.staging, `${plan.name}.zip`);
    const result = spawnSync(
        cmake,
        ["-E", "tar", "cf", archive, "--format=zip", "--", plan.name],
        { cwd: plan.staging, encoding: "utf8", windowsHide: true },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(
            `Package archive creation failed: ${result.stdout}${result.stderr}`,
        );
    return archive;
}

/** Writes the staged receipt `<staging>/<name>.json`. */
export function writePackageReceipt(
    plan: PackageOutput,
    receipt: Readonly<Record<string, unknown>>,
): void {
    writeJsonRecord(join(plan.staging, `${plan.name}.json`), receipt);
}

/**
 * Publishes a staged package once its qualification and archive succeeded:
 * the replaced package moves to `.replaced/<run>/`, nothing is deleted but the
 * published run's staging scratch. A failed run never reaches here and keeps
 * its staging for diagnosis.
 */
export function publishPackageOutput(plan: PackageOutput): void {
    const names = [plan.name, `${plan.name}.zip`, `${plan.name}.json`];
    for (const name of names) {
        for (const parent of [plan.staging, plan.root, plan.previous])
            assertPackageChild(plan.root, join(parent, name));
        if (!existsSync(join(plan.staging, name)))
            throw new Error(`Incomplete staged package: ${name}`);
    }
    for (const name of names) {
        const current = join(plan.root, name);
        if (existsSync(current)) {
            mkdirSync(plan.previous, { recursive: true });
            renameSync(current, join(plan.previous, name));
        }
    }
    for (const name of names)
        renameSync(join(plan.staging, name), join(plan.root, name));
    rmSync(plan.staging, { recursive: true, force: true });
    const stagingRoot = dirname(plan.staging);
    if (readdirSync(stagingRoot).length === 0) rmdirSync(stagingRoot);
}

/**
 * `node dist/src/package-output.js stage --root <r> --name <n>` prints a new
 * staging directory; `finish --root <r> --name <n> --staging <s> --receipt
 * <fields.json> [--artifact <key>=<path>] [--files <key>=<directory>]`
 * archives the staged package, adds the archive's (and the named artifact's)
 * bytes and SHA-256 -- and each file of the named tree with the tree's total
 * -- to the platform fields, writes the receipt and publishes the package.
 */
function main(): void {
    const parsed = parseFlags(
        process.argv.slice(2),
        {
            value: [
                "--root",
                "--name",
                "--staging",
                "--receipt",
                "--artifact",
                "--files",
            ],
            positionals: 1,
        },
        "package-output",
    );
    const action = parsed.positionals[0];
    const root = parsed.values.get("--root");
    const name = parsed.values.get("--name");
    if (!root || !name || (action !== "stage" && action !== "finish"))
        throw new Error(
            "package-output: stage --root <r> --name <n> | finish --root <r> --name <n> --staging <s> --receipt <fields.json> [--artifact <key>=<path>] [--files <key>=<directory>]",
        );
    if (action === "stage") {
        console.log(newPackageOutput(root, name).staging);
        return;
    }
    const staging = parsed.values.get("--staging");
    const fields = parsed.values.get("--receipt");
    if (!staging || !fields)
        throw new Error("package-output finish needs --staging and --receipt.");
    const plan = stagedPackageOutput(root, name, staging);
    const cmake = discoverDevelopmentTools().cmake;
    if (!cmake)
        throw new Error("Packaging requires CMake; run npm run doctor.");
    const receipt: unknown = JSON.parse(
        readFileSync(fields, "utf8").replace(/^\uFEFF/, ""),
    );
    if (
        typeof receipt !== "object" ||
        receipt === null ||
        Array.isArray(receipt)
    )
        throw new Error(`Package receipt fields must be an object: ${fields}`);
    const keyed = (flag: string): [string, string] | undefined => {
        const value = parsed.values.get(flag);
        if (value === undefined) return undefined;
        const match = /^([a-z]+)=(.+)$/.exec(value);
        if (!match) throw new Error(`${flag} takes <key>=<path>.`);
        return [match[1]!, match[2]!];
    };
    const computed: Record<string, unknown> = {};
    const artifact = keyed("--artifact");
    if (artifact) {
        const identity = fileIdentity(artifact[1]);
        computed[`${artifact[0]}Bytes`] = identity.bytes;
        computed[`${artifact[0]}Sha256`] = identity.sha256;
    }
    const tree = keyed("--files");
    if (tree) {
        const files = packageFiles(tree[1]).map((path) => ({
            path,
            ...fileIdentity(join(tree[1], path)),
        }));
        computed.files = files;
        computed[`${tree[0]}Bytes`] = files.reduce(
            (sum, file) => sum + file.bytes,
            0,
        );
    }
    const archive = fileIdentity(archivePackage(plan, cmake));
    writePackageReceipt(plan, {
        ...receipt,
        ...computed,
        zipBytes: archive.bytes,
        zipSha256: archive.sha256,
    });
    publishPackageOutput(plan);
    console.log(join(plan.root, `${plan.name}.zip`));
}

if (isMainModule(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
