/**
 * The maintained upstream patches: one inventory (native/patches/manifest.json)
 * whose series and artifact records native/patch-identity.cmake alone
 * computes, for the builders, the portfiles, configure and this module.
 *
 * `checkPatchInventory` is `npm run patches:check`: every listed file exists,
 * every patch file under native/patches and the overlay ports is listed, each
 * patch this repository owns opens with its rationale, a library's patches
 * apply in manifest order and its script patches are numbered by their
 * position there, each overlay portfile takes its series from
 * the manifest and every patch in its directory applies to it, and no builder
 * or portfile names a patch file itself. `artifactPatchState` asks the CMake
 * owner whether an installed artifact's record is current.
 */
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepositoryRoot } from "./repository-root.js";
import { isMainModule, parseFlags } from "./tooling/flags.js";
import { listFiles } from "./tooling/records.js";

const upstreamStates = [
    "unsubmitted",
    "open",
    "merged",
    "closed",
    "vcpkg",
] as const;
type UpstreamState = (typeof upstreamStates)[number];

interface PatchLibrary {
    name: string;
    pin: { file: string; field: string };
    builder: string | undefined;
    port: string | undefined;
    record: { prefix: string; file: string } | undefined;
    variants: readonly string[];
}

/** One manifest entry; a library's entries are listed in application order. */
interface MaintainedPatch {
    library: string;
    file: string;
    purpose: string;
    upstream: { state: UpstreamState; link?: string; retire?: string };
    variants: readonly string[];
}

interface PatchManifest {
    libraries: ReadonlyMap<string, PatchLibrary>;
    patches: readonly MaintainedPatch[];
}

/** The checkout this module was built from. */
const moduleRepositoryRoot = (): string =>
    findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(
    value: Record<string, unknown>,
    key: string,
    where: string,
): unknown {
    if (!(key in value)) throw new Error(`${where} lacks '${key}'.`);
    return value[key];
}

function text(value: unknown, where: string): string {
    if (typeof value !== "string" || value.trim() === "")
        throw new Error(`${where} must be a non-empty string.`);
    return value;
}

function requiredText(
    value: Record<string, unknown>,
    key: string,
    where: string,
): string {
    return text(field(value, key, where), `${where}.${key}`);
}

function optionalText(
    value: Record<string, unknown>,
    key: string,
    where: string,
): string | undefined {
    return value[key] === undefined
        ? undefined
        : text(value[key], `${where}.${key}`);
}

function strings(value: unknown, where: string): string[] {
    if (!Array.isArray(value)) throw new Error(`${where} must be an array.`);
    return value.map((entry, index) => text(entry, `${where}[${index}]`));
}

function object(value: unknown, where: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`${where} must be an object.`);
    return value;
}

function isUpstreamState(value: string): value is UpstreamState {
    return upstreamStates.some((state) => state === value);
}

function parsePatchManifest(source: string): PatchManifest {
    const root = object(JSON.parse(source), "native/patches/manifest.json");
    const libraries = new Map<string, PatchLibrary>();
    for (const [name, definition] of Object.entries(
        object(field(root, "libraries", "manifest"), "libraries"),
    )) {
        const where = `libraries.${name}`;
        const library = object(definition, where);
        const pin = object(field(library, "pin", where), `${where}.pin`);
        const record =
            library.record === undefined
                ? undefined
                : object(library.record, `${where}.record`);
        libraries.set(name, {
            name,
            pin: {
                file: requiredText(pin, "file", `${where}.pin`),
                field: requiredText(pin, "field", `${where}.pin`),
            },
            builder: optionalText(library, "builder", where),
            port: optionalText(library, "port", where),
            record: record && {
                prefix: requiredText(record, "prefix", `${where}.record`),
                file: requiredText(record, "file", `${where}.record`),
            },
            variants: strings(
                field(library, "variants", where),
                `${where}.variants`,
            ),
        });
    }
    const list = field(root, "patches", "manifest");
    if (!Array.isArray(list)) throw new Error("patches must be an array.");
    const patches = list.map((entry: unknown, index): MaintainedPatch => {
        const where = `patches[${index}]`;
        const patch = object(entry, where);
        const upstream = object(
            field(patch, "upstream", where),
            `${where}.upstream`,
        );
        const state = requiredText(upstream, "state", `${where}.upstream`);
        if (!isUpstreamState(state))
            throw new Error(
                `${where}.upstream.state must be one of ${upstreamStates.join(", ")}.`,
            );
        const link = optionalText(upstream, "link", `${where}.upstream`);
        const retire = optionalText(upstream, "retire", `${where}.upstream`);
        return {
            library: requiredText(patch, "library", where),
            file: requiredText(patch, "file", where),
            purpose: requiredText(patch, "purpose", where),
            upstream: {
                state,
                ...(link === undefined ? {} : { link }),
                ...(retire === undefined ? {} : { retire }),
            },
            variants: strings(
                field(patch, "variants", where),
                `${where}.variants`,
            ),
        };
    });
    return { libraries, patches };
}

export function readPatchManifest(
    root = moduleRepositoryRoot(),
): PatchManifest {
    return parsePatchManifest(
        readFileSync(join(root, "native", "patches", "manifest.json"), "utf8"),
    );
}

function pinnedSource(root: string, library: PatchLibrary): string {
    const pin = object(
        JSON.parse(readFileSync(join(root, library.pin.file), "utf8")),
        library.pin.file,
    );
    return requiredText(pin, library.pin.field, library.pin.file);
}

/**
 * Runs native/patch-identity.cmake, the one owner of the maintained patch
 * series and of the record an artifact carries (the builders and configure
 * run the same script), and returns what it wrote.
 */
export function runPatchIdentity(
    cmake: string,
    action: "series" | "record" | "state",
    library: string,
    options: {
        variants?: readonly string[];
        artifact?: string;
        /** The variants a consumer needs; absent, the recorded ones stand. */
        require?: readonly string[];
    } = {},
    root = moduleRepositoryRoot(),
): string {
    const directory = mkdtempSync(join(tmpdir(), "bblite-patch-identity-"));
    const output = join(directory, "output.txt");
    try {
        const result = spawnSync(
            cmake,
            [
                `-DBBLITE_PATCH_ACTION=${action}`,
                `-DBBLITE_PATCH_LIBRARY=${library}`,
                `-DBBLITE_PATCH_VARIANTS=${(options.variants ?? []).join(";")}`,
                ...(options.artifact !== undefined
                    ? [`-DBBLITE_PATCH_ARTIFACT=${options.artifact}`]
                    : []),
                ...(options.require !== undefined
                    ? [`-DBBLITE_PATCH_REQUIRE=${options.require.join(";")}`]
                    : []),
                `-DBBLITE_PATCH_OUTPUT=${output}`,
                "-P",
                join(root, "native", "patch-identity.cmake"),
            ],
            { encoding: "utf8", windowsHide: true },
        );
        if (result.error) throw result.error;
        if (result.status !== 0)
            throw new Error(
                `native/patch-identity.cmake ${action} ${library} failed: ${result.stderr.trim()}`,
            );
        // CMake writes text-mode line endings on Windows.
        return readFileSync(output, "utf8").replaceAll("\r\n", "\n");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

export type ArtifactPatchState =
    { state: "current" } | { state: "unrecorded" | "stale"; detail: string };

/** Whether the artifact at `directory` records what the pin and the manifest select. */
export function artifactPatchState(
    cmake: string,
    library: string,
    directory: string,
    require?: readonly string[],
): ArtifactPatchState {
    const [state = "", detail = ""] = runPatchIdentity(
        cmake,
        "state",
        library,
        { artifact: directory, ...(require !== undefined ? { require } : {}) },
    ).split(/\r?\n/);
    if (state === "current") return { state };
    if (state === "unrecorded" || state === "stale") return { state, detail };
    throw new Error(
        `native/patch-identity.cmake reported an unknown state '${state}'.`,
    );
}

const diffStart = /^(diff --git |--- |Index: )/;

const reason = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const posix = (path: string): string => path.split(sep).join("/");

/** Everything wrong with the inventory; empty when it is consistent. */
export function checkPatchInventory(root = moduleRepositoryRoot()): string[] {
    let manifest: PatchManifest;
    try {
        manifest = readPatchManifest(root);
    } catch (error) {
        return [`native/patches/manifest.json: ${reason(error)}`];
    }
    const problems: string[] = [];
    const listed = new Set(manifest.patches.map((patch) => patch.file));
    if (listed.size !== manifest.patches.length)
        problems.push("A patch file is listed twice.");

    for (const library of manifest.libraries.values()) {
        const where = `library ${library.name}`;
        try {
            pinnedSource(root, library);
        } catch (error) {
            problems.push(
                `${where}: pin ${library.pin.file} ${library.pin.field}: ${reason(error)}`,
            );
        }
        for (const path of [library.builder, library.port]) {
            if (path !== undefined && !existsSync(join(root, path)))
                problems.push(`${where}: ${path} does not exist.`);
        }
        if (
            library.record &&
            (!/^BBLITE_[A-Z0-9_]+$/.test(library.record.prefix) ||
                !/^bblite-[a-z0-9-]+\.cmake$/.test(library.record.file))
        )
            problems.push(
                `${where}: malformed record ${library.record.prefix}/${library.record.file}.`,
            );
        if (library.record && !library.builder)
            problems.push(
                `${where}: a record needs the builder that writes it.`,
            );
        const patches = manifest.patches.filter(
            (patch) => patch.library === library.name,
        );
        const names = patches.map((patch) => basename(patch.file));
        if (new Set(names).size !== names.length)
            problems.push(`${where}: two patches share a file name.`);
        if (library.port !== undefined) {
            // The portfile reads its series from the manifest, but vcpkg keys
            // the port by its directory alone: every patch there must apply
            // under one of the port's selections (`vcpkg`, or a port feature
            // it passes), so dropping one from the port means removing its
            // file, which vcpkg sees.
            const portfile = join(root, library.port, "portfile.cmake");
            if (
                !existsSync(portfile) ||
                !readFileSync(portfile, "utf8").includes(
                    `bblite_patch_series(${library.name} `,
                )
            )
                problems.push(
                    `${library.port}/portfile.cmake does not take its series from bblite_patch_series(${library.name} ...).`,
                );
            let features: string[] = [];
            try {
                features = Object.keys(
                    object(
                        field(
                            object(
                                JSON.parse(
                                    readFileSync(
                                        join(root, library.port, "vcpkg.json"),
                                        "utf8",
                                    ),
                                ),
                                `${library.port}/vcpkg.json`,
                            ),
                            "features",
                            `${library.port}/vcpkg.json`,
                        ),
                        `${library.port}/vcpkg.json features`,
                    ),
                );
            } catch (error) {
                problems.push(`${library.port}/vcpkg.json: ${reason(error)}`);
            }
            for (const patch of patches) {
                if (
                    posix(patch.file).startsWith(`${library.port}/`) &&
                    !patch.variants.some(
                        (variant) =>
                            variant === "vcpkg" || features.includes(variant),
                    )
                )
                    problems.push(
                        `${patch.file}: a patch in the port directory must apply to the port (\`vcpkg\` or a port feature).`,
                    );
            }
        }
    }

    // A patch's position in its library's series (1-based), its application order.
    const positions = new Map<string, number>();
    for (const patch of manifest.patches) {
        const position = (positions.get(patch.library) ?? 0) + 1;
        positions.set(patch.library, position);
        const library = manifest.libraries.get(patch.library);
        if (!library) {
            problems.push(`${patch.file}: unknown library '${patch.library}'.`);
            continue;
        }
        const inherited = patch.upstream.state === "vcpkg";
        if (patch.variants.length === 0)
            problems.push(`${patch.file}: applies to no variant.`);
        for (const variant of patch.variants) {
            if (variant !== "all" && !library.variants.includes(variant))
                problems.push(
                    `${patch.file}: unknown ${library.name} variant '${variant}'.`,
                );
        }
        const inPort =
            library.port !== undefined &&
            posix(patch.file).startsWith(`${library.port}/`);
        const scriptFile =
            /^native\/patches\/([a-z0-9-]+)\/(\d{4})-[a-z0-9-]+\.patch$/.exec(
                patch.file,
            );
        if (!inPort) {
            if (!scriptFile || scriptFile[1] !== library.name)
                problems.push(
                    `${patch.file}: script patches live at native/patches/${library.name}/NNNN-slug.patch.`,
                );
            else if (Number(scriptFile[2]) !== position)
                problems.push(
                    `${patch.file}: its number is not its position ${position} in the ${library.name} series.`,
                );
        }
        if (inherited && !inPort)
            problems.push(
                `${patch.file}: an inherited vcpkg patch stays in its port directory.`,
            );
        if (
            ["open", "merged", "closed"].includes(patch.upstream.state) &&
            !/^https:\/\//.test(patch.upstream.link ?? "")
        )
            problems.push(
                `${patch.file}: upstream state ${patch.upstream.state} needs its link.`,
            );
        const path = join(root, patch.file);
        if (!existsSync(path) || !statSync(path).isFile()) {
            problems.push(`${patch.file}: listed but missing.`);
            continue;
        }
        const lines = readFileSync(path, "utf8").split(/\r?\n/);
        const first = lines.findIndex((line) => diffStart.test(line));
        if (first < 0) problems.push(`${patch.file}: holds no diff.`);
        else if (
            !inherited &&
            !lines.slice(0, first).some((line) => line.trim() !== "")
        )
            problems.push(
                `${patch.file}: opens with no header stating its purpose.`,
            );
    }

    for (const directory of ["native/patches", "native/vcpkg-overlay-ports"]) {
        for (const path of listFiles(join(root, directory))) {
            const file = posix(relative(root, path));
            if (/\.(patch|diff)$/.test(file) && !listed.has(file))
                problems.push(
                    `${file}: not listed in native/patches/manifest.json.`,
                );
        }
    }
    for (const entry of readdirSync(join(root, "native", "patches"), {
        withFileTypes: true,
    })) {
        if (entry.isDirectory() && !manifest.libraries.has(entry.name))
            problems.push(
                `native/patches/${entry.name}: no such library in the manifest.`,
            );
    }

    // Builders take their series from the manifest; a patch file named in a
    // script or CMake file is a second list that can drift from it.
    const topLevel = (directory: string, pattern: RegExp): string[] =>
        readdirSync(join(root, directory), { withFileTypes: true })
            .filter((entry) => entry.isFile() && pattern.test(entry.name))
            .map((entry) => join(root, directory, entry.name));
    const consumers = [
        ...topLevel("tools", /\.(ps1|psm1|mjs|cmake)$/),
        ...topLevel("native", /(\.cmake|^CMakeLists\.txt)$/),
        ...topLevel(join("native", "patches"), /\.cmake$/),
        ...[...manifest.libraries.values()].flatMap((library) =>
            library.port === undefined
                ? []
                : [join(root, library.port, "portfile.cmake")],
        ),
    ].filter((path) => existsSync(path));
    for (const path of consumers) {
        const names = readFileSync(path, "utf8").match(
            /[A-Za-z0-9_.-]+\.(?:patch|diff)\b/g,
        );
        if (names)
            problems.push(
                `${posix(relative(root, path))} names ${[...new Set(names)].join(", ")}; take the series from native/patches/manifest.json.`,
            );
    }
    return problems;
}

if (isMainModule(import.meta.url)) {
    parseFlags(process.argv.slice(2), {}, "patches:check");
    const problems = checkPatchInventory();
    for (const problem of problems) console.error(`patches:check: ${problem}`);
    if (problems.length > 0) {
        process.exitCode = 1;
    } else {
        const manifest = readPatchManifest();
        console.log(
            `patches:check: ${manifest.patches.length} patches over ${manifest.libraries.size} libraries are consistent.`,
        );
    }
}
