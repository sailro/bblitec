/**
 * Native fixture builds, reused across test runs.
 *
 * A fixture compile is keyed in two stages. The first covers what the
 * command names: the compiler, the environment variables that add inputs or
 * flags (`INCLUDE`, `LIB`, `CL`, `_CL_`, `LINK`, `_LINK_`), the arguments
 * with output paths set aside, and the identity of every source, object and
 * library it reads. The second covers what the compile found through its
 * include search, as `/showIncludes` reported it on the run that stored the
 * outputs; each such header must keep its identity. Only a successful build
 * is stored, so a fixture expected to fail compiles every time and reports
 * its own diagnostics. Paths inside the checkout enter keys relative to it,
 * so worktrees sharing the cache share builds.
 *
 * A command whose inputs or outputs the cache cannot name (response files,
 * `/Tp`/`/Tc` sources, precompiled headers, preprocessor output) always runs
 * the compiler, as does every command when `BBLITE_FIXTURE_CACHE=0`.
 */
import { execFileSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
} from "node:path";
import { environmentValue } from "../src/development-tools.js";
import { pruneResultCacheDaily } from "../src/native-cache-clean.js";
import { artifactDirectory } from "../src/tooling/artifacts.js";
import {
    hashEntries,
    inputIdentity,
    toolIdentity,
    withoutRepositoryRoot,
} from "../src/tooling/records.js";

/** Bumped when the key's composition changes, retiring every stored build. */
const fixtureCacheSchema = 3;

/** Every source the compiler driver compiles. */
const sourcePattern = /\.(?:c|cc|cpp|cxx|mm)$/i;

/** One compiler invocation's inputs and outputs, when the cache can name them. */
export interface FixtureCompilePlan {
    /** Sources the command compiles. */
    readonly sources: readonly string[];
    /** Sources, objects, libraries and forced includes the command names. */
    readonly inputs: readonly string[];
    /** The files the command writes. */
    readonly outputs: readonly string[];
    /** The arguments with each output path replaced by its role. */
    readonly normalized: readonly string[];
}

/**
 * The inputs and outputs of `arguments_`, resolved against `cwd`, or
 * undefined when the command reads or writes files the plan cannot name.
 * A linking command's objects are intermediates; only its executable is an
 * output. A compile-only command's objects are what later steps link.
 */
export function fixtureCompilePlan(
    arguments_: readonly string[],
    cwd: string,
): FixtureCompilePlan | undefined {
    const inputs: string[] = [];
    const normalized: string[] = [];
    const sources: string[] = [];
    const libraryFolders: string[] = [];
    const libraries: string[] = [];
    let executable: string | undefined;
    let objectOutput: string | undefined;
    let compileOnly = false;
    let linking = false;
    for (const argument of arguments_) {
        if (argument.startsWith("@")) return undefined;
        if (linking) {
            normalized.push(argument);
            const folder = /^[/-]LIBPATH:(.+)$/i.exec(argument);
            if (folder) libraryFolders.push(resolve(cwd, folder[1]!));
            else if (!/^[/-]/.test(argument) && /\.lib$/i.test(argument))
                libraries.push(argument);
            continue;
        }
        if (/^[/-]link$/i.test(argument)) {
            linking = true;
            normalized.push(argument);
            continue;
        }
        const fe = /^[/-]Fe:?(.+)$/.exec(argument);
        if (fe) {
            executable = resolve(cwd, fe[1]!);
            normalized.push("/Fe:<executable>");
            continue;
        }
        const fo = /^[/-]Fo:?(.+)$/.exec(argument);
        if (fo) {
            objectOutput = fo[1]!;
            normalized.push("/Fo:<objects>");
            continue;
        }
        if (/^[/-](?:T[pc].|Yc|Yu|Fp|P$|E$|EP$)/.test(argument))
            return undefined;
        if (/^[/-]c$/.test(argument)) compileOnly = true;
        const forced = /^[/-]FI(.+)$/.exec(argument);
        if (forced) inputs.push(resolve(cwd, forced[1]!));
        if (!/^[/-]/.test(argument)) {
            const input = resolve(cwd, argument);
            if (sourcePattern.test(argument)) sources.push(input);
            if (
                sourcePattern.test(argument) ||
                /\.(?:obj|lib)$/i.test(argument)
            )
                inputs.push(input);
        }
        normalized.push(argument);
    }
    // A library the linker finds in a `/LIBPATH:` folder is an input; one it
    // finds through `LIB` is a system library, which the key's `LIB` names.
    for (const library of libraries) {
        const found = [cwd, ...libraryFolders]
            .map((folder) => resolve(folder, library))
            .find((path) => existsSync(path));
        if (found) inputs.push(found);
    }
    if (!compileOnly)
        return executable
            ? { sources, inputs, outputs: [executable], normalized }
            : undefined;
    if (sources.length === 0 || objectOutput === undefined) return undefined;
    const folder = /[\\/]$/.test(objectOutput);
    if (!folder && sources.length !== 1) return undefined;
    const outputs = sources.map((source) =>
        folder
            ? resolve(
                  cwd,
                  objectOutput,
                  `${basename(source).replace(sourcePattern, "")}.obj`,
              )
            : resolve(cwd, objectOutput),
    );
    return { sources, inputs, outputs, normalized };
}

/** The headers `/showIncludes` reported, and the output with those notes removed. */
export function includeNotes(output: string): {
    includes: string[];
    rest: string;
} {
    const includes: string[] = [];
    const rest: string[] = [];
    for (const line of output.split(/\r?\n/)) {
        const note = /^Note: including file:\s+(.+?)\s*$/.exec(line);
        if (note) includes.push(note[1]!);
        else rest.push(line);
    }
    return { includes, rest: rest.join("\n") };
}

/** A header a stored build read: its path, identity, and the size and time it was identified at. */
type StoredInclude = [
    path: string,
    identity: string,
    size: number,
    mtimeMs: number,
];

/** Stored fixture builds under `directory`, read and written by every test process. */
export class FixtureBuildCache {
    public constructor(
        private readonly directory: string,
        private readonly root: string,
    ) {
        pruneResultCacheDaily(directory);
    }

    /** A path as keys and manifests spell it: relative inside the checkout. */
    private spelled(path: string): string {
        const inside = relative(this.root, path);
        return inside.startsWith("..") || isAbsolute(inside)
            ? path
            : inside.replaceAll("\\", "/");
    }

    /** The first-stage key: the compiler, its environment, the command and its named inputs. */
    public commandKey(
        compiler: string,
        environment: NodeJS.ProcessEnv,
        plan: FixtureCompilePlan,
    ): string {
        return hashEntries([
            String(fixtureCacheSchema),
            toolIdentity(compiler),
            ...["INCLUDE", "LIB", "CL", "_CL_", "LINK", "_LINK_"].map(
                (name) =>
                    `${name}=${environmentValue(environment, name) ?? ""}`,
            ),
            ...plan.normalized.map((argument) =>
                withoutRepositoryRoot(argument, this.root),
            ),
            ...plan.inputs.map(
                (input) =>
                    `${this.spelled(input)}\t${inputIdentity(input, this.root)}`,
            ),
        ]);
    }

    /** Whether a stored header still has the identity it was stored with. */
    private unchanged([path, identity, size, mtimeMs]: StoredInclude): boolean {
        const absolute = resolve(this.root, path);
        const stat = statSync(absolute, { throwIfNoEntry: false });
        if (!stat) return false;
        // Unmoved size and time keep the identity without rereading it.
        if (stat.size === size && stat.mtimeMs === mtimeMs) return true;
        return inputIdentity(absolute, this.root) === identity;
    }

    /**
     * Copies a stored build's outputs into place; false when none matches,
     * or when pruning removed it while it was read.
     */
    public restore(key: string, plan: FixtureCompilePlan): boolean {
        const folder = join(this.directory, key);
        try {
            for (const variant of readdirSync(folder)) {
                const manifest = join(folder, variant, "build.json");
                if (!existsSync(manifest)) continue;
                const includes = JSON.parse(
                    readFileSync(manifest, "utf8"),
                ) as StoredInclude[];
                if (!includes.every((include) => this.unchanged(include)))
                    continue;
                plan.outputs.forEach((output, index) => {
                    mkdirSync(dirname(output), { recursive: true });
                    copyFileSync(join(folder, variant, String(index)), output);
                });
                // Restoring marks the build used, so pruning keeps it.
                const now = new Date();
                utimesSync(folder, now, now);
                return true;
            }
        } catch {
            return false;
        }
        return false;
    }

    /**
     * Stores a successful build's outputs with the headers it read, replacing
     * the variants older headers produced under the same command.
     */
    public store(
        key: string,
        plan: FixtureCompilePlan,
        includes: readonly string[],
    ): void {
        const identities: StoredInclude[] = [
            ...new Set(includes.map((include) => resolve(include))),
        ]
            .sort()
            .map((path) => {
                const stat = statSync(path);
                return [
                    this.spelled(path),
                    inputIdentity(path, this.root),
                    stat.size,
                    stat.mtimeMs,
                ];
            });
        const variant = hashEntries(
            identities.map(([path, identity]) => `${path}\t${identity}`),
        );
        const folder = join(this.directory, key);
        const target = join(folder, variant);
        if (existsSync(join(target, "build.json"))) return;
        const staging = `${target}.${process.pid}.partial`;
        try {
            rmSync(staging, { recursive: true, force: true });
            mkdirSync(staging, { recursive: true });
            plan.outputs.forEach((output, index) =>
                copyFileSync(output, join(staging, String(index))),
            );
            writeFileSync(
                join(staging, "build.json"),
                JSON.stringify(identities),
            );
            renameSync(staging, target);
            for (const sibling of readdirSync(folder))
                if (sibling !== variant && !sibling.endsWith(".partial"))
                    rmSync(join(folder, sibling), {
                        recursive: true,
                        force: true,
                    });
        } catch {
            // Another test process stored the same build first, or an
            // output the plan named was not written; nothing is stored.
            rmSync(staging, { recursive: true, force: true });
        }
    }
}

let fixtureBuilds: FixtureBuildCache | undefined;

/**
 * Runs `compiler` with `args` in `cwd`, restoring a stored build whose
 * command and every input it read are unchanged, and storing a successful
 * one. A failure throws the compiler's diagnostics without include notes.
 */
export function runFixtureCompiler(
    compiler: string,
    environment: NodeJS.ProcessEnv,
    args: readonly string[],
    cwd: string,
): void {
    const plan =
        process.env.BBLITE_FIXTURE_CACHE === "0"
            ? undefined
            : fixtureCompilePlan(args, cwd);
    const cache = plan
        ? (fixtureBuilds ??= new FixtureBuildCache(
              resolve(cwd, artifactDirectory("native-fixture-cache")),
              cwd,
          ))
        : undefined;
    const key = plan && cache?.commandKey(compiler, environment, plan);
    if (plan && key && cache!.restore(key, plan)) return;
    // The include notes name every header the build read, in English. The
    // flag leads the command: everything after `/link` goes to the linker.
    const reportsIncludes = key !== undefined && plan!.sources.length > 0;
    let output: string;
    try {
        output = execFileSync(
            compiler,
            reportsIncludes ? ["/showIncludes", ...args] : args,
            {
                cwd,
                env: reportsIncludes
                    ? { ...environment, VSLANG: "1033" }
                    : environment,
                stdio: "pipe",
                windowsHide: true,
                encoding: "utf8",
                maxBuffer: 256 * 1024 * 1024,
            },
        );
    } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        throw new Error(
            `${failure.message}\n${includeNotes(failure.stdout ?? "").rest}\n${failure.stderr ?? ""}`,
            { cause: error },
        );
    }
    if (!plan || !key) return;
    const { includes } = includeNotes(output);
    // A compile that reported no header cannot prove what it read.
    if (!reportsIncludes || includes.length > 0)
        cache!.store(key, plan, includes);
}
