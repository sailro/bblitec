/**
 * The maintained upstream patches: one inventory (native/patches/manifest.json)
 * read by the PowerShell builders, native/patch-identity.cmake and
 * this module.
 *
 * `checkPatchInventory` is `npm run patches:check`: every listed file exists,
 * every patch file under native/patches and the overlay ports is listed, each
 * patch this repository owns opens with its rationale, script patches are
 * numbered in application order, each overlay portfile applies exactly its
 * listed series, and no builder names a patch file itself.
 * `artifactPatchState` compares an installed artifact's record with the
 * series the manifest selects, as the CMake check does.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepositoryRoot } from "./repository-root.js";
import { isMainModule, parseFlags } from "./tooling/flags.js";
import { contentDigest, listFiles } from "./tooling/records.js";

const upstreamStates = [
    "unsubmitted",
    "open",
    "merged",
    "closed",
    "vcpkg",
] as const;
type UpstreamState = (typeof upstreamStates)[number];

export interface PatchLibrary {
    name: string;
    pin: { file: string; field: string };
    builder: string | undefined;
    port: string | undefined;
    record: { prefix: string; file: string } | undefined;
    variants: readonly string[];
}

export interface MaintainedPatch {
    library: string;
    order: number;
    file: string;
    purpose: string;
    upstream: { state: UpstreamState; link?: string; retire?: string };
    variants: readonly string[];
    inheritedFromVcpkg: boolean;
}

export interface PatchManifest {
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
        const order = field(patch, "order", where);
        if (typeof order !== "number" || !Number.isInteger(order) || order < 1)
            throw new Error(`${where}.order must be a positive integer.`);
        const inherited = field(patch, "inheritedFromVcpkg", where);
        if (typeof inherited !== "boolean")
            throw new Error(`${where}.inheritedFromVcpkg must be a boolean.`);
        const link = optionalText(upstream, "link", `${where}.upstream`);
        const retire = optionalText(upstream, "retire", `${where}.upstream`);
        return {
            library: requiredText(patch, "library", where),
            order,
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
            inheritedFromVcpkg: inherited,
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

function libraryDefinition(
    manifest: PatchManifest,
    library: string,
): PatchLibrary {
    const definition = manifest.libraries.get(library);
    if (!definition)
        throw new Error(
            `native/patches/manifest.json lists no library '${library}'.`,
        );
    return definition;
}

/** The patches of one library a build with these variant tokens applies, in order. */
export function selectPatches(
    manifest: PatchManifest,
    library: string,
    variants: readonly string[],
): MaintainedPatch[] {
    const definition = libraryDefinition(manifest, library);
    for (const variant of variants) {
        if (!definition.variants.includes(variant))
            throw new Error(
                `native/patches/manifest.json defines no ${library} variant '${variant}'.`,
            );
    }
    return manifest.patches
        .filter(
            (patch) =>
                patch.library === library &&
                patch.variants.some(
                    (variant) =>
                        variant === "all" || variants.includes(variant),
                ),
        )
        .sort((left, right) => left.order - right.order);
}

export interface PatchRecord {
    source: string;
    patches: string;
}

function pinnedSource(root: string, library: PatchLibrary): string {
    const pin = object(
        JSON.parse(readFileSync(join(root, library.pin.file), "utf8")),
        library.pin.file,
    );
    return requiredText(pin, library.pin.field, library.pin.file);
}

/** The record an artifact of `library` built for `variants` must carry. */
export function expectedPatchRecord(
    manifest: PatchManifest,
    library: string,
    variants: readonly string[],
    root = moduleRepositoryRoot(),
): PatchRecord {
    return {
        source: pinnedSource(root, libraryDefinition(manifest, library)),
        patches: selectPatches(manifest, library, variants)
            .map(
                (patch) =>
                    `${basename(patch.file)}=${contentDigest(join(root, patch.file))}`,
            )
            .join(";"),
    };
}

export type ArtifactPatchState =
    | { state: "current" }
    | { state: "unrecorded"; recordPath: string }
    | {
          state: "stale";
          recordPath: string;
          recorded: Partial<PatchRecord>;
          expected: PatchRecord;
      };

/** The CMake `set(NAME "value")` assignments of an artifact's record file. */
function recordAssignment(record: string, name: string): string | undefined {
    for (const line of record.split(/\r?\n/)) {
        const match = /^set\(([A-Z0-9_]+) "([^"]*)"\)$/.exec(line.trim());
        if (match?.[1] === name) return match[2];
    }
    return undefined;
}

/** Whether the artifact at `directory` records the source and patches the manifest selects. */
export function artifactPatchState(
    manifest: PatchManifest,
    library: string,
    directory: string,
    variants: readonly string[],
    root = moduleRepositoryRoot(),
): ArtifactPatchState {
    const record = manifest.libraries.get(library)?.record;
    if (!record)
        throw new Error(
            `native/patches/manifest.json names no record for '${library}'.`,
        );
    const recordPath = join(directory, record.file);
    const content = existsSync(recordPath)
        ? readFileSync(recordPath, "utf8")
        : "";
    const patches = recordAssignment(content, `${record.prefix}_PATCHES`);
    if (patches === undefined) return { state: "unrecorded", recordPath };
    const source = recordAssignment(content, `${record.prefix}_SOURCE`);
    const expected = expectedPatchRecord(manifest, library, variants, root);
    return source === expected.source && patches === expected.patches
        ? { state: "current" }
        : {
              state: "stale",
              recordPath,
              recorded: {
                  patches,
                  ...(source === undefined ? {} : { source }),
              },
              expected,
          };
}

const diffStart = /^(diff --git |--- |Index: )/;

const reason = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const posix = (path: string): string => path.split(sep).join("/");

/** The patch file names a vcpkg portfile passes to PATCHES, with `${VAR}` resolved. */
export function portfilePatches(portfile: string): string[] {
    const code = portfile
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*$/, ""))
        .join("\n");
    const start = /\bPATCHES\b/.exec(code);
    if (!start) return [];
    const variables = new Map(
        [
            ...code.matchAll(
                /\bset\(\s*([A-Za-z0-9_]+)\s+"?([^")\s]+)"?\s*\)/g,
            ),
        ].map((match) => [match[1] ?? "", match[2] ?? ""]),
    );
    const rest = code.slice(start.index + "PATCHES".length);
    const end = rest.indexOf(")");
    return rest
        .slice(0, end < 0 ? undefined : end)
        .split(/\s+/)
        .filter(Boolean)
        .map((token) =>
            token.replace(/^\$\{([A-Za-z0-9_]+)\}$/, (_, name: string) => {
                const value = variables.get(name);
                if (value === undefined)
                    throw new Error(`PATCHES entry ${token} is never set.`);
                return value;
            }),
        );
}

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
        patches.forEach((patch, index) => {
            if (patch.order !== index + 1)
                problems.push(
                    `${patch.file}: order ${patch.order} where its position in the ${library.name} series is ${index + 1}.`,
                );
        });
        const names = patches.map((patch) => basename(patch.file));
        if (new Set(names).size !== names.length)
            problems.push(`${where}: two patches share a file name.`);
        if (library.port !== undefined) {
            const portfilePath = join(root, library.port, "portfile.cmake");
            const expected = patches
                .filter((patch) => patch.variants.includes("vcpkg"))
                .map((patch) => basename(patch.file));
            try {
                const actual = portfilePatches(
                    readFileSync(portfilePath, "utf8"),
                );
                if (actual.join(";") !== expected.join(";"))
                    problems.push(
                        `${library.port}/portfile.cmake applies [${actual.join(", ")}] but the manifest lists [${expected.join(", ")}].`,
                    );
            } catch (error) {
                problems.push(
                    `${library.port}/portfile.cmake: ${reason(error)}`,
                );
            }
        }
    }

    for (const patch of manifest.patches) {
        const library = manifest.libraries.get(patch.library);
        if (!library) {
            problems.push(`${patch.file}: unknown library '${patch.library}'.`);
            continue;
        }
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
            else if (Number(scriptFile[2]) !== patch.order)
                problems.push(
                    `${patch.file}: its number is not its order ${patch.order}.`,
                );
        }
        if (patch.inheritedFromVcpkg !== (patch.upstream.state === "vcpkg"))
            problems.push(
                `${patch.file}: upstream state 'vcpkg' marks exactly the patches inherited from the vcpkg port.`,
            );
        if (patch.inheritedFromVcpkg && !inPort)
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
            !patch.inheritedFromVcpkg &&
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
    ];
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
