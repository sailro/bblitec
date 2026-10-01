import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
import {
    commandArguments,
    commandTokens,
    lintCompilationGroups,
    lintEnvironmentAllowsDedup,
    type CompilationCommand,
} from "./lint-compilation.js";
import { findRepositoryRoot } from "./repository-root.js";
import { runConcurrently } from "./run-concurrently.js";
import { sceneAggregateSources } from "./native-scene-sources.js";
import { scenes } from "./scene-registry.js";
import { flagNumber, isMainModule, parseFlags } from "./tooling/flags.js";
import { runLoggedProcess } from "./tooling/logged-process.js";
import { contentDigest, writeJsonRecord } from "./tooling/records.js";

interface LintUnit {
    build: string;
    database: string;
    file: string;
    headerRoots: string[];
    scene: string | undefined;
    log: string;
    fixes: string;
    exitCode: number | undefined;
    command: CompilationCommand | undefined;
}

function compilationCommands(database: unknown): CompilationCommand[] {
    if (!Array.isArray(database))
        throw new Error("compile_commands.json must contain an array.");
    const entries: readonly unknown[] = database;
    return entries.map((entry, index) => {
        const invalid = (): never => {
            throw new Error(`Invalid compilation database entry ${index}.`);
        };
        if (
            entry === null ||
            typeof entry !== "object" ||
            !("directory" in entry) ||
            typeof entry.directory !== "string" ||
            entry.directory === "" ||
            !("file" in entry) ||
            typeof entry.file !== "string" ||
            entry.file === ""
        )
            return invalid();
        const command = "command" in entry ? entry.command : undefined;
        const args = "arguments" in entry ? entry.arguments : undefined;
        if (
            command !== undefined &&
            (typeof command !== "string" || command === "")
        )
            return invalid();
        if (
            args !== undefined &&
            (!Array.isArray(args) ||
                args.length === 0 ||
                !args.every(
                    (argument: unknown) => typeof argument === "string",
                ))
        )
            return invalid();
        if (command === undefined && args === undefined) return invalid();
        return {
            directory: entry.directory,
            file: entry.file,
            ...(command === undefined ? {} : { command }),
            ...(args === undefined ? {} : { arguments: args }),
        };
    });
}

/** Keep the build's flags while compiling each scene implementation independently. */
export function standaloneSceneCommands(
    database: unknown,
    build: string,
): CompilationCommand[] {
    const commands: CompilationCommand[] = [];
    for (const entry of compilationCommands(database)) {
        const original: CompilationCommand = {
            ...entry,
            directory: resolve(build, entry.directory),
        };
        commands.push(original);
        const file = resolve(original.directory, original.file);
        if (!/^pal_(?:sdl_gpu|dawn)_scene_all\.cpp$/.test(basename(file)))
            continue;
        for (const source of sceneAggregateSources(file)) {
            let matched = false;
            const replace = (argument: string): string => {
                if (!sameCachePath(resolve(original.directory, argument), file))
                    return argument;
                matched = true;
                return (
                    argument.slice(0, -basename(file).length) +
                    relative(dirname(file), source).split(sep).join("/")
                );
            };
            const requireInput = (): void => {
                if (!matched)
                    throw new Error(
                        `Compilation command does not name its source: ${file}.`,
                    );
                matched = false;
            };
            let command = original.command;
            if (command !== undefined) {
                // Replace only the input token, retaining quoting, output paths and flags.
                for (const match of [
                    ...command.matchAll(commandTokens),
                ].reverse()) {
                    const argument = match[1] ?? match[2] ?? match[3]!;
                    const replacement = replace(argument);
                    if (replacement === argument) continue;
                    const token = match[0].replace(argument, replacement);
                    command =
                        command.slice(0, match.index) +
                        token +
                        command.slice(match.index + match[0].length);
                }
                requireInput();
            }
            const args = original.arguments?.map(replace);
            if (args !== undefined) requireInput();
            commands.push({
                directory: original.directory,
                file: source,
                ...(command === undefined ? {} : { command }),
                ...(args === undefined ? {} : { arguments: args }),
            });
        }
    }
    return commands;
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

/** Keep shared roots once when one invocation reports for several builds. */
export function nativeHeaderFilter(roots: readonly string[]): string {
    return `^(${[...new Set(roots)]
        .map((path) =>
            path
                .split(/[\\/]/)
                .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                .join("[/\\\\]"),
        )
        .join("|")})[/\\\\]`;
}

export function nativeCompilationFiles(
    database: unknown,
    buildDirectory: string,
    root: string,
    ownedFiles: readonly string[],
    generatedRoots: readonly string[] = [],
): string[] {
    const owned = new Set(
        ownedFiles
            .filter((path) => /^native\/src\/.*\.(?:cpp|m|mm)$/.test(path))
            .map((path) => pathKey(resolve(root, path))),
    );
    const files = new Set<string>();
    const generatedPrefixes = generatedRoots.map(
        (directory) => `${pathKey(directory)}${sep}`,
    );
    for (const entry of compilationCommands(database)) {
        const file = resolve(buildDirectory, entry.directory, entry.file);
        if (
            owned.has(pathKey(file)) ||
            (generatedPrefixes.some((prefix) =>
                pathKey(file).startsWith(prefix),
            ) &&
                /\.(?:cpp|cc|cxx)$/.test(file))
        ) {
            files.add(file);
        }
    }
    return [...files].sort();
}

/** Ninja spells a build-relative path with forward slashes. */
const ninjaPath = (path: string): string => path.split(sep).join("/");

/**
 * The precompiled headers a build creates: the build target Ninja records
 * dependencies for and the header file it writes. MSVC-style drivers create
 * one with `/Yc` (`/Fo` the object, `/Fp` the header); a compile with
 * `-emit-pch` writes one output that is both, `-o` for GNU-style drivers and
 * `/Fo` for clang-cl.
 */
export function precompiledHeaderOutputs(
    database: unknown,
    buildDirectory: string,
): { target: string; header: string }[] {
    const outputs: { target: string; header: string }[] = [];
    for (const entry of compilationCommands(database)) {
        const directory = resolve(buildDirectory, entry.directory);
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
            const header = index >= 0 ? argumentsList[index + 1] : flag("Fo");
            if (header)
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
    const version = execFileSync(tool, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
    });
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
            { cwd: root, encoding: "utf8", windowsHide: true },
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
    const logs = join(
        root,
        "artifacts",
        "code-quality",
        `${Date.now()}-${process.pid}`,
    );
    const batches = targets.map((target, batch) => {
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
        const commands = standaloneSceneCommands(database, build);
        const commandsByFile = new Map<string, CompilationCommand[]>();
        for (const command of commands) {
            const key = pathKey(resolve(command.directory, command.file));
            const existing = commandsByFile.get(key);
            if (existing) existing.push(command);
            else commandsByFile.set(key, [command]);
        }
        const lintDatabase = join(logs, String(batch));
        writeJsonRecord(join(lintDatabase, "compile_commands.json"), commands);
        const nativeCache = resolve(
            cache?.BBLITE_NATIVE_CACHE_DIR ??
                join(root, "artifacts", "native-cache"),
        );
        // Under the object cache the lowered modules compile from
        // content-addressed copies; this tree's database names only its own.
        const sources = nativeCompilationFiles(
            commands,
            build,
            root,
            files,
            generatedDirectory
                ? [generatedDirectory, join(nativeCache, "sources")]
                : [],
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
                ? [resolve(generatedDirectory), join(nativeCache, "headers")]
                : []),
        ];
        return {
            build,
            database: lintDatabase,
            sources,
            commandsByFile,
            headerRoots,
            scene: typeof target === "string" ? undefined : target.id,
        };
    });
    mkdirSync(logs, { recursive: true });
    const units: LintUnit[] = batches.flatMap(
        (
            { build, database, sources, commandsByFile, headerRoots, scene },
            batch,
        ) => {
            console.log(
                `clang-tidy: ${relative(root, build)} (${sources.length} translation units).`,
            );
            return sources.map((file, index) => ({
                build,
                database,
                file,
                headerRoots,
                scene,
                log: join(logs, `${batch}-${index}-${basename(file)}.log`),
                fixes: join(logs, `${batch}-${index}-${basename(file)}.yaml`),
                exitCode: undefined,
                // clang-tidy may run several commands for one source; keep such
                // database entries independent rather than choose one silently.
                command:
                    commandsByFile.get(pathKey(file))?.length === 1
                        ? commandsByFile.get(pathKey(file))![0]
                        : undefined,
            }));
        },
    );
    const digests = new Map<string, string>();
    const pchDigest = (file: string): string => {
        let digest = digests.get(file);
        if (digest === undefined) {
            digest = contentDigest(file);
            digests.set(file, digest);
        }
        return digest;
    };
    const canShare = lintEnvironmentAllowsDedup(environment);
    const work = lintCompilationGroups(
        units.map((unit) => (canShare ? unit.command : undefined)),
        pchDigest,
    ).map((indices) => {
        const members = indices.map((index) => units[index]!);
        const primary = members[0]!;
        for (const member of members) {
            member.log = primary.log;
            member.fixes = primary.fixes;
        }
        return {
            ...primary,
            members,
            headerFilter: nativeHeaderFilter(
                members.flatMap((unit) => unit.headerRoots),
            ),
        };
    });
    console.log(
        `clang-tidy: ${work.length} invocations cover ${units.length} compilation contexts.`,
    );
    try {
        await runConcurrently(
            work,
            jobs,
            ({ build, file }) =>
                `${relative(root, build)}: ${relative(root, file)}`,
            async (item) => {
                const { database, file, log, fixes, headerFilter } = item;
                const code = await runLoggedProcess(
                    tool,
                    [
                        "--quiet",
                        `--config-file=${join(root, ".clang-tidy")}`,
                        `--header-filter=${headerFilter}`,
                        `--export-fixes=${fixes}`,
                        "-p",
                        database,
                        file,
                    ],
                    log,
                    { cwd: root, env: environment },
                );
                for (const member of item.members) member.exitCode = code;
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
            invocations: work.length,
            passed: units.filter((item) => item.exitCode === 0).length,
            failed: units.filter(
                (item) => item.exitCode !== undefined && item.exitCode !== 0,
            ).length,
            incomplete: units.filter((item) => item.exitCode === undefined)
                .length,
            units: units.map(
                ({ build, file, log, fixes, scene, exitCode }) => ({
                    scene,
                    build: relative(root, build),
                    file: relative(root, file),
                    log: relative(root, log),
                    fixes: relative(root, fixes),
                    exitCode: exitCode ?? null,
                }),
            ),
        });
        console.log(
            `clang-tidy report: ${relative(root, join(logs, "report.json"))}`,
        );
    }
    console.log(
        `clang-tidy: ${work.length} invocations checked ${units.length} compilation contexts; logs in ${relative(root, logs).split(sep).join("/")}.`,
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
