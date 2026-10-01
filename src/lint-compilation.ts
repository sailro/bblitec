import { basename, delimiter, isAbsolute, resolve } from "node:path";
import { sameCachePath } from "./build-stamp.js";

export interface CompilationCommand {
    directory: string;
    file: string;
    command?: string;
    arguments?: string[];
}

export const commandTokens = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;

/** Read the database's arguments without changing the command used for execution. */
export function commandArguments(entry: CompilationCommand): string[] {
    if (entry.arguments !== undefined) return entry.arguments;
    return [...entry.command!.matchAll(commandTokens)].map(
        (match) => match[1] ?? match[2] ?? match[3]!,
    );
}

/** Windows rooted paths without a drive still depend on the working directory. */
function absoluteInput(path: string): boolean {
    return process.platform === "win32"
        ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(path)
        : isAbsolute(path);
}

/** Implicit relative search paths and injected flags keep each build independent. */
export function lintEnvironmentAllowsDedup(
    environment: NodeJS.ProcessEnv,
): boolean {
    const values = new Map(
        Object.entries(environment).map(([name, value]) => [
            name.toUpperCase(),
            value,
        ]),
    );
    for (const name of [
        "CL",
        "_CL_",
        "CCC_OVERRIDE_OPTIONS",
        "GCC_EXEC_PREFIX",
        "COMPILER_PATH",
    ])
        if (values.get(name)) return false;
    for (const name of [
        "INCLUDE",
        "CPATH",
        "C_INCLUDE_PATH",
        "CPLUS_INCLUDE_PATH",
        "OBJC_INCLUDE_PATH",
    ]) {
        const value = values.get(name);
        if (value !== undefined && !value.split(delimiter).every(absoluteInput))
            return false;
    }
    const sdk = values.get("SDKROOT");
    return !sdk || absoluteInput(sdk);
}

/**
 * Equal keys mean the same source, ordered frontend flags and header search.
 * Only output destinations and identical PCH binaries may differ. Unknown
 * options, relative inputs and response files deliberately have no shared key.
 */
export function lintCompilationKey(
    entry: CompilationCommand,
    pchDigest: (absolutePath: string) => string,
): string | undefined {
    // The legacy reader accepts shell single quotes; Windows drivers do not.
    if (
        process.platform === "win32" &&
        entry.arguments === undefined &&
        entry.command?.includes("'")
    )
        return undefined;
    const args = commandArguments(entry);
    const compiler = args[0];
    if (
        !compiler ||
        !absoluteInput(compiler) ||
        !absoluteInput(entry.directory) ||
        !absoluteInput(entry.file) ||
        args.some((argument) => argument.startsWith("@"))
    )
        return undefined;
    const driver = basename(compiler).toLowerCase();
    const cl = driver === "clang-cl.exe" || driver === "clang-cl";
    if (
        !cl &&
        !/^(?:clang(?:\+\+)?|gcc|g\+\+)(?:-\d+)?(?:\.exe)?$/.test(driver)
    )
        return undefined;
    const normalized: string[] = [compiler];
    const pchInputs: number[] = [];
    const inputOptions = [
        "-isystem",
        "-iquote",
        "-idirafter",
        "-include",
        "-imacros",
        "-isysroot",
        "--sysroot=",
        "-resource-dir=",
        "-imsvc",
        "-I",
        ...(cl ? ["/external:I", "-external:I", "/FI", "-FI", "/I"] : []),
    ];
    const common =
        /^(?:-c|-g(?:\d|line-tables-only)?|-O[0-3szg]|-std=[A-Za-z0-9+]+|-W[\w=-]+|-m(?:32|64)|-pthread|-f(?:no-)?(?:exceptions|rtti|PIC|PIE|strict-aliasing)|-fno-pch-timestamp)$/;
    const clangCl =
        /^[/-](?:nologo|T[CP]|EHsc|O[12]|Ob[012]|[M][DT]d?|W[0-4]|WX|permissive-|bigobj|external:W[0-4]|we\d+|Gw|Zc:inline|FS|std:c\+\+\w+)$/;
    let source = false;
    for (let index = 1; index < args.length; ++index) {
        const argument = args[index]!;
        if (
            absoluteInput(argument) &&
            sameCachePath(resolve(argument), resolve(entry.file))
        ) {
            normalized.push(argument);
            source = true;
            continue;
        }
        if (argument === "--") {
            if (index !== args.length - 2) return undefined;
            normalized.push(argument);
            continue;
        }
        // Do not reinterpret partially quoted shell tokens as compiler options.
        if (argument.includes('"') && !/^[/-][DU]/.test(argument))
            return undefined;
        if (
            argument === "-o" ||
            (!cl && ["-MF", "-MT", "-MQ"].includes(argument))
        ) {
            if (!args[++index]) return undefined;
            continue;
        }
        if (cl && /^[/-]F[ode]/.test(argument)) {
            if (argument.length === 3 && !args[++index]) return undefined;
            continue;
        }
        if (argument === "-include-pch") {
            const path = args[++index];
            if (!path || !absoluteInput(path)) return undefined;
            normalized.push(argument, path);
            pchInputs.push(normalized.length - 1);
            continue;
        }
        if (argument === "-Xclang") {
            const option = args[++index];
            if (option === "-include-pch") {
                if (args[++index] !== "-Xclang") return undefined;
                const path = args[++index];
                if (!path || !absoluteInput(path)) return undefined;
                normalized.push(argument, option, "-Xclang", path);
                pchInputs.push(normalized.length - 1);
            } else if (option === "-fno-pch-timestamp")
                normalized.push(argument, option);
            else return undefined;
            continue;
        }
        const input = inputOptions.find((option) =>
            argument.startsWith(option),
        );
        if (input) {
            const path = argument.slice(input.length) || args[++index];
            if (!path || !absoluteInput(path)) return undefined;
            normalized.push(input, path);
            continue;
        }
        if (
            /^(?:-[DU]|\/[DU])/.test(argument) &&
            (cl || argument.startsWith("-"))
        ) {
            normalized.push(argument);
            if (argument.length === 2) {
                const value = args[++index];
                if (!value) return undefined;
                normalized.push(value);
            }
            continue;
        }
        if (argument === "-x") {
            const language = args[++index];
            if (
                !language ||
                !["c", "c++", "objective-c", "objective-c++"].includes(language)
            )
                return undefined;
            normalized.push(argument, language);
            continue;
        }
        if (
            common.test(argument) ||
            (cl && clangCl.test(argument)) ||
            (!cl && ["-MD", "-MMD", "-MP"].includes(argument))
        ) {
            normalized.push(argument);
            continue;
        }
        return undefined;
    }
    if (!source) return undefined;
    // PCHs are large; unknown contexts must not read them just to refuse sharing.
    for (const index of pchInputs)
        normalized[index] = pchDigest(normalized[index]!);
    return JSON.stringify([entry.file, normalized]);
}

/** Indices retain every original build context, including commands we cannot compare. */
export function lintCompilationGroups(
    entries: readonly (CompilationCommand | undefined)[],
    pchDigest: (absolutePath: string) => string,
): number[][] {
    const groups: number[][] = [];
    const byKey = new Map<string, number[]>();
    entries.forEach((entry, index) => {
        const key = entry && lintCompilationKey(entry, pchDigest);
        const existing = key === undefined ? undefined : byKey.get(key);
        if (existing) existing.push(index);
        else {
            const group = [index];
            groups.push(group);
            if (key !== undefined) byKey.set(key, group);
        }
    });
    return groups;
}
