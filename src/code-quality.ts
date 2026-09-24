import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import {
    canonicalCompiledBackend,
    compiledBuildDirectory,
} from "./build-options.js";
import {
    cachePathKey as pathKey,
    readCacheConfiguration,
    sameCachePath,
} from "./build-stamp.js";
import {
    discoverClangTool,
    discoverWindowsBuildTools,
    clangToolsMajor,
} from "./development-tools.js";
import { holdDistLock } from "./dist-lock.js";
import { findRepositoryRoot } from "./repository-root.js";
import { runConcurrently } from "./run-concurrently.js";
import { scenes } from "./scene-registry.js";
import { flagNumber, isMainModule, parseFlags } from "./tooling/flags.js";
import { runLoggedProcess } from "./tooling/logged-process.js";
import { writeJsonRecord } from "./tooling/records.js";

interface LintUnit {
    build: string;
    file: string;
    headerFilter: string;
    scene: string | undefined;
    log: string;
    fixes: string;
    exitCode: number | undefined;
}

export function nativeFormatFiles(paths: readonly string[]): string[] {
    return [...new Set(paths)]
        .filter((path) =>
            /^(?:native\/(?:include|src)\/|test\/fixtures\/).*\.(?:cpp|hpp|h|m|mm)$/.test(
                path,
            ),
        )
        .sort();
}

export function nativeCompilationFiles(
    database: unknown,
    buildDirectory: string,
    root: string,
    ownedFiles: readonly string[],
    generatedDirectory?: string,
): string[] {
    if (!Array.isArray(database)) {
        throw new Error("compile_commands.json must contain an array.");
    }
    const owned = new Set(
        ownedFiles
            .filter((path) => /^native\/src\/.*\.(?:cpp|m|mm)$/.test(path))
            .map((path) => pathKey(resolve(root, path))),
    );
    const files = new Set<string>();
    const generatedRoot =
        generatedDirectory === undefined
            ? undefined
            : `${pathKey(generatedDirectory)}${sep}`;
    const entries: readonly unknown[] = database;
    for (const [index, entry] of entries.entries()) {
        if (
            entry === null ||
            typeof entry !== "object" ||
            !("directory" in entry) ||
            typeof entry.directory !== "string" ||
            !("file" in entry) ||
            typeof entry.file !== "string" ||
            entry.directory === "" ||
            entry.file === "" ||
            !(
                ("command" in entry &&
                    typeof entry.command === "string" &&
                    entry.command !== "") ||
                ("arguments" in entry &&
                    Array.isArray(entry.arguments) &&
                    entry.arguments.length > 0 &&
                    entry.arguments.every(
                        (argument: unknown) => typeof argument === "string",
                    ))
            )
        ) {
            throw new Error(`Invalid compilation database entry ${index}.`);
        }
        const file = resolve(buildDirectory, entry.directory, entry.file);
        if (
            owned.has(pathKey(file)) ||
            (generatedRoot !== undefined &&
                pathKey(file).startsWith(generatedRoot) &&
                /\.(?:cpp|cc|cxx)$/.test(file))
        ) {
            files.add(file);
        }
    }
    return [...files].sort();
}

/** Ninja spells a build-relative path with forward slashes. */
const ninjaPath = (path: string): string => path.split(sep).join("/");

/** A compilation database entry's arguments, from `arguments` or its quoted `command`. */
function commandArguments(entry: object): string[] {
    if ("arguments" in entry && Array.isArray(entry.arguments))
        return entry.arguments.filter(
            (argument): argument is string => typeof argument === "string",
        );
    if (!("command" in entry) || typeof entry.command !== "string") return [];
    return [...entry.command.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(
        (match) => match[1] ?? match[2]!,
    );
}

/**
 * The precompiled headers a build creates: the build target Ninja records
 * dependencies for and the header file it writes. MSVC-style drivers create
 * one with `/Yc` (`/Fo` the object, `/Fp` the header); GNU-style drivers
 * with `-emit-pch`, whose `-o` output is both.
 */
export function precompiledHeaderOutputs(
    database: unknown,
    buildDirectory: string,
): { target: string; header: string }[] {
    if (!Array.isArray(database)) {
        throw new Error("compile_commands.json must contain an array.");
    }
    const outputs: { target: string; header: string }[] = [];
    const entries: readonly unknown[] = database;
    for (const entry of entries) {
        if (entry === null || typeof entry !== "object") continue;
        const directory =
            "directory" in entry && typeof entry.directory === "string"
                ? resolve(buildDirectory, entry.directory)
                : buildDirectory;
        const argumentsList = commandArguments(entry);
        const flag = (prefix: string): string | undefined =>
            argumentsList
                .find(
                    (argument) =>
                        argument.startsWith(`/${prefix}`) ||
                        argument.startsWith(`-${prefix}`),
                )
                ?.slice(prefix.length + 1);
        if (argumentsList.some((argument) => /^[/-]Yc/.test(argument))) {
            const object = flag("Fo");
            const header = flag("Fp");
            if (object && header)
                outputs.push({
                    target: ninjaPath(
                        relative(buildDirectory, resolve(directory, object)),
                    ),
                    header: resolve(directory, header),
                });
            continue;
        }
        if (argumentsList.includes("-emit-pch")) {
            const index = argumentsList.indexOf("-o");
            const header = argumentsList[index + 1];
            if (index >= 0 && header)
                outputs.push({
                    target: ninjaPath(
                        relative(buildDirectory, resolve(directory, header)),
                    ),
                    header: resolve(directory, header),
                });
        }
    }
    return outputs;
}

/** The first input newer than its precompiled header, if any. */
export function newerPrecompiledHeaderInput(
    headerModified: number,
    inputs: readonly { path: string; modified: number | undefined }[],
): string | undefined {
    return inputs.find(
        ({ modified }) => modified === undefined || modified > headerModified,
    )?.path;
}

/**
 * Refuses a build whose precompiled header predates one of its inputs.
 * The builds pass `-fno-pch-timestamp`, so clang-tidy reuses such a header
 * whenever the input's size is unchanged and reports against the old
 * declarations. Ninja's dependency log names each header's inputs.
 */
function requireCurrentPrecompiledHeaders(
    build: string,
    database: unknown,
    ninja: string | undefined,
): void {
    const outputs = precompiledHeaderOutputs(database, build);
    if (outputs.length === 0) return;
    if (!ninja)
        throw new Error(
            `${build} has precompiled headers but no CMAKE_MAKE_PROGRAM to read their dependencies.`,
        );
    for (const { target, header } of outputs) {
        const modified = statSync(header, { throwIfNoEntry: false })?.mtimeMs;
        if (modified === undefined)
            throw new Error(
                `${build} has not built ${header}; build the scene first.`,
            );
        const log = execFileSync(ninja, ["-C", build, "-t", "deps", target], {
            encoding: "utf8",
            windowsHide: true,
        });
        const inputs = log
            .split(/\r?\n/)
            .filter((line) => /^\s+\S/.test(line))
            .map((line) => {
                const path = resolve(build, line.trim());
                return {
                    path,
                    modified: statSync(path, { throwIfNoEntry: false })
                        ?.mtimeMs,
                };
            });
        if (inputs.length === 0)
            throw new Error(
                `Ninja records no dependencies for ${target} in ${build}; build the scene first.`,
            );
        const newer = newerPrecompiledHeaderInput(modified, inputs);
        if (newer)
            throw new Error(
                `${header} is older than ${newer}; rebuild ${build} before linting it.`,
            );
    }
}

function clangTool(command: "clang-format" | "clang-tidy"): string {
    const tool = discoverClangTool(command);
    const override = command === "clang-format" ? "CLANG_FORMAT" : "CLANG_TIDY";
    if (!tool) {
        throw new Error(
            `${command} was not found. Install LLVM ${clangToolsMajor} or set ${override} to its executable.`,
        );
    }
    const version = execFileSync(tool, ["--version"], { encoding: "utf8" });
    if (!new RegExp(`\\bversion ${clangToolsMajor}\\.`, "i").test(version)) {
        throw new Error(
            `${command} requires LLVM ${clangToolsMajor} for reproducible checks; set ${override}. Found: ${version.trim()}`,
        );
    }
    return tool;
}

function trackedNativeFiles(root: string): string[] {
    return nativeFormatFiles(
        execFileSync(
            "git",
            [
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                "native/src",
                "native/include",
                "test/fixtures",
            ],
            { cwd: root, encoding: "utf8" },
        ).split("\0"),
    );
}

function formatCommand(args: readonly string[]): void {
    const parsed = parseFlags(
        args,
        {
            boolean: ["--write", "--help"],
            value: ["--file"],
            positionals: 0,
        },
        "code-quality format",
    );
    if (parsed.flags.has("--help")) {
        console.log("code-quality format [--write] [--file <owned-source>]");
        return;
    }
    const root = findRepositoryRoot();
    const files = trackedNativeFiles(root);
    const selected = parsed.values.get("--file");
    const selectedKey =
        selected === undefined ? undefined : pathKey(resolve(selected));
    if (
        selectedKey !== undefined &&
        !files.some((file) => pathKey(resolve(root, file)) === selectedKey)
    ) {
        throw new Error(`Not a maintained native source: ${selected}.`);
    }
    holdDistLock("code-quality format");
    const tool = clangTool("clang-format");
    const inputs = files.filter(
        (file) =>
            selectedKey === undefined ||
            pathKey(resolve(root, file)) === selectedKey,
    );
    if (inputs.length === 0)
        throw new Error("No maintained C++ files to format.");
    for (let offset = 0; offset < inputs.length; offset += 64) {
        execFileSync(
            tool,
            [
                "--style=file",
                ...(parsed.flags.has("--write")
                    ? ["-i"]
                    : ["--dry-run", "--Werror"]),
                ...inputs.slice(offset, offset + 64),
            ],
            { cwd: root, stdio: "inherit", windowsHide: true },
        );
    }
    console.log(
        `clang-format: ${inputs.length} maintained source files ${parsed.flags.has("--write") ? "formatted" : "checked"}.`,
    );
}

async function lintCommand(args: readonly string[]): Promise<void> {
    const parsed = parseFlags(
        args,
        {
            boolean: ["--help", "--generated"],
            value: ["--file", "--jobs", "--backend"],
            positionals: Number.MAX_SAFE_INTEGER,
        },
        "code-quality lint",
    );
    if (parsed.flags.has("--help")) {
        console.log(
            "code-quality lint <scene|build-directory|all> [...] [--generated] [--backend sdl_gpu|dawn|both] [--file <source>] [--jobs <count>]",
        );
        return;
    }
    if (parsed.positionals.length === 0) {
        throw new Error(
            "Pass a configured native build directory containing compile_commands.json, " +
                "for example: npm run lint:cpp -- native/build-scene1-release. " +
                "Build with Ninja first; pass additional build directories for other feature/backend configurations.",
        );
    }
    if (parsed.positionals.includes("all") && parsed.positionals.length !== 1) {
        throw new Error(
            "'all' cannot be combined with individual lint targets.",
        );
    }
    const jobs =
        flagNumber(parsed, "--jobs", "code-quality lint") ??
        Math.min(4, availableParallelism());
    if (!Number.isSafeInteger(jobs) || jobs < 1) {
        throw new Error("--jobs must be a positive integer.");
    }
    const backendValue = parsed.values.get("--backend");
    const backend =
        backendValue === undefined
            ? undefined
            : canonicalCompiledBackend(backendValue, "code-quality lint");
    holdDistLock("code-quality lint");
    const tool = clangTool("clang-tidy");
    const environment =
        process.platform === "win32"
            ? discoverWindowsBuildTools("auto").environment
            : process.env;
    const root = findRepositoryRoot();
    const files = trackedNativeFiles(root);
    const selected = parsed.values.get("--file");
    const selectedKey =
        selected === undefined ? undefined : pathKey(resolve(selected));
    const targets = parsed.positionals.includes("all")
        ? scenes
        : parsed.positionals.map(
              (target) => scenes.find((scene) => scene.id === target) ?? target,
          );
    const includeGenerated = parsed.flags.has("--generated");
    const batches = targets.map((target) => {
        const directory =
            typeof target === "string"
                ? target
                : compiledBuildDirectory(target.buildDirectory, backend);
        const build = resolve(directory);
        const cache = readCacheConfiguration(build);
        if (backend !== undefined && cache?.BBLITE_BACKEND !== backend) {
            throw new Error(
                `${directory} is not configured for ${backend}; build that backend first.`,
            );
        }
        if (
            typeof target !== "string" &&
            (!cache?.BBLITE_GENERATED_DIR ||
                !sameCachePath(
                    cache.BBLITE_GENERATED_DIR,
                    resolve(root, target.output),
                ))
        ) {
            throw new Error(
                `${directory} does not contain the configured output for ${target.id}; build the scene first.`,
            );
        }
        const generatedDirectory = includeGenerated
            ? cache?.BBLITE_GENERATED_DIR
            : undefined;
        if (includeGenerated && !generatedDirectory) {
            throw new Error(
                `${directory} has no BBLITE_GENERATED_DIR in CMakeCache.txt.`,
            );
        }
        const databasePath = join(build, "compile_commands.json");
        let contents: string;
        try {
            contents = readFileSync(databasePath, "utf8");
        } catch (error) {
            throw new Error(
                `Cannot read ${databasePath}; configure the native build with Ninja first.`,
                { cause: error },
            );
        }
        const database: unknown = JSON.parse(contents);
        requireCurrentPrecompiledHeaders(
            build,
            database,
            cache?.CMAKE_MAKE_PROGRAM,
        );
        const sources = nativeCompilationFiles(
            database,
            build,
            root,
            files,
            generatedDirectory,
        ).filter(
            (file) =>
                selectedKey === undefined || pathKey(file) === selectedKey,
        );
        if (sources.length === 0) {
            throw new Error(
                `${directory} contains no matching ${includeGenerated ? "native or generated" : "maintained native"} translation units.`,
            );
        }
        const headerRoots = [
            resolve(root, "native", "include"),
            resolve(root, "native", "src"),
            ...(generatedDirectory
                ? [
                      resolve(generatedDirectory),
                      resolve(
                          cache?.BBLITE_NATIVE_CACHE_DIR ??
                              join(root, "artifacts", "native-cache"),
                          "headers",
                      ),
                  ]
                : []),
        ];
        const headerFilter = `^(${headerRoots
            .map((path) =>
                path
                    .split(/[\\/]/)
                    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                    .join("[/\\\\]"),
            )
            .join("|")})[/\\\\]`;
        return {
            build,
            sources,
            headerFilter,
            scene: typeof target === "string" ? undefined : target.id,
        };
    });
    const logs = join(
        root,
        "artifacts",
        "code-quality",
        `${Date.now()}-${process.pid}`,
    );
    mkdirSync(logs, { recursive: true });
    const work: LintUnit[] = batches.flatMap(
        ({ build, sources, headerFilter, scene }, batch) => {
            console.log(
                `clang-tidy: ${relative(root, build)} (${sources.length} translation units).`,
            );
            return sources.map((file, index) => ({
                build,
                file,
                headerFilter,
                scene,
                log: join(logs, `${batch}-${index}-${basename(file)}.log`),
                fixes: join(logs, `${batch}-${index}-${basename(file)}.yaml`),
                exitCode: undefined,
            }));
        },
    );
    try {
        await runConcurrently(
            work,
            jobs,
            ({ build, file }) =>
                `${relative(root, build)}: ${relative(root, file)}`,
            async (item) => {
                const { build, file, log, fixes, headerFilter } = item;
                const code = await runLoggedProcess(
                    tool,
                    [
                        "--quiet",
                        `--config-file=${join(root, ".clang-tidy")}`,
                        `--header-filter=${headerFilter}`,
                        `--export-fixes=${fixes}`,
                        "-p",
                        build,
                        file,
                    ],
                    log,
                    { cwd: root, env: environment },
                );
                item.exitCode = code;
                if (code !== 0) {
                    throw new Error(
                        `clang-tidy exited ${code}; ${relative(root, log)}`,
                    );
                }
            },
        );
    } finally {
        writeJsonRecord(join(logs, "report.json"), {
            tool,
            generated: includeGenerated,
            passed: work.filter((item) => item.exitCode === 0).length,
            failed: work.filter(
                (item) => item.exitCode !== undefined && item.exitCode !== 0,
            ).length,
            incomplete: work.filter((item) => item.exitCode === undefined)
                .length,
            units: work.map(({ build, file, log, fixes, scene, exitCode }) => ({
                scene,
                build: relative(root, build),
                file: relative(root, file),
                log: relative(root, log),
                fixes: relative(root, fixes),
                exitCode: exitCode ?? null,
            })),
        });
        console.log(
            `clang-tidy report: ${relative(root, join(logs, "report.json"))}`,
        );
    }
    console.log(
        `clang-tidy: ${work.length} translation units checked; logs in ${relative(root, logs).split(sep).join("/")}.`,
    );
}

async function main(args: readonly string[]): Promise<void> {
    const [command, ...rest] = args;
    if (command === "format") {
        formatCommand(rest);
    } else if (command === "lint") {
        await lintCommand(rest);
    } else {
        throw new Error(
            "Expected code-quality format [--write] or lint <scene|build-directory|all> [...].",
        );
    }
}

if (isMainModule(import.meta.url)) {
    main(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
