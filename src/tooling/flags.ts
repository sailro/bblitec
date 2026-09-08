/**
 * The strict argument parser every scene subcommand and standalone
 * entry point shares, and the main-module guard those entry points use.
 *
 * Strict because a lenient parser costs afternoons: a mistyped flag that
 * is silently dropped runs the tool with defaults and produces a
 * plausible answer to a question nobody asked. An unknown argument is an
 * error that names the valid set.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface FlagSpec {
    /** Flags that take a value, e.g. `--backend dawn`. */
    value?: readonly string[];
    /** Flags that stand alone, e.g. `--recapture`. */
    boolean?: readonly string[];
    /** Alternate spellings, alias -> canonical flag. */
    alias?: Readonly<Record<string, string>>;
    /** How many bare (non `--`) arguments are accepted. Default none. */
    positionals?: number;
}

export interface ParsedFlags {
    values: Map<string, string>;
    flags: Set<string>;
    positionals: string[];
}

export function parseFlags(
    rest: readonly string[],
    spec: FlagSpec,
    command: string,
): ParsedFlags {
    const parsed: ParsedFlags = {
        values: new Map(),
        flags: new Set(),
        positionals: [],
    };
    const known = [
        ...(spec.value ?? []),
        ...(spec.boolean ?? []),
        ...Object.keys(spec.alias ?? {}),
    ];
    for (let index = 0; index < rest.length; index += 1) {
        const argument = rest[index];
        if (argument === undefined || argument === "") continue;
        if (!argument.startsWith("--")) {
            if (parsed.positionals.length >= (spec.positionals ?? 0)) {
                throw new Error(
                    `Unexpected ${command} argument '${argument}'.`,
                );
            }
            parsed.positionals.push(argument);
            continue;
        }
        const name = spec.alias?.[argument] ?? argument;
        if (spec.value?.includes(name)) {
            const value = rest[index + 1];
            if (value === undefined) {
                throw new Error(
                    `${command}: ${argument} requires a value.`,
                );
            }
            index += 1;
            parsed.values.set(name, value);
            continue;
        }
        if (spec.boolean?.includes(name)) {
            parsed.flags.add(name);
            continue;
        }
        throw new Error(
            known.length > 0
                ? `Unknown ${command} argument '${argument}'. Valid flags: ${known.join(", ")}.`
                : `Unknown ${command} argument '${argument}'; ${command} takes no flags.`,
        );
    }
    return parsed;
}

/** A numeric flag value, rejected loudly when it does not parse. */
export function flagNumber(
    parsed: ParsedFlags,
    name: string,
    command: string,
): number | undefined {
    const value = parsed.values.get(name);
    if (value === undefined) return undefined;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        throw new Error(
            `${command}: ${name} must be a number (got '${value}').`,
        );
    }
    return numeric;
}

/** A `--background r,g,b` value: three 0-255 integers, rejected loudly. */
export function parseRgbTriple(
    value: string,
    flag: string,
    command: string,
): [number, number, number] {
    const parts = value.split(",").map((part) => Number(part.trim()));
    if (
        parts.length !== 3 ||
        parts.some(
            (part) => !Number.isInteger(part) || part < 0 || part > 255,
        )
    ) {
        throw new Error(
            `${command}: ${flag} must be three 0-255 integers 'r,g,b' (got '${value}').`,
        );
    }
    return [parts[0]!, parts[1]!, parts[2]!];
}

/**
 * The usage line a flag spec implies, so the help text and the parser
 * cannot disagree about which options a command takes.
 */
export function usageFromSpec(spec: FlagSpec): string {
    const parts: string[] = [];
    for (const name of spec.value ?? []) {
        const aliases = Object.entries(spec.alias ?? {})
            .filter(([, canonical]) => canonical === name)
            .map(([alias]) => alias);
        parts.push(`[${[name, ...aliases].join("|")} <value>]`);
    }
    for (const name of spec.boolean ?? []) parts.push(`[${name}]`);
    return parts.join(" ");
}

/**
 * Whether `moduleUrl` is the script Node was asked to run, so a module
 * that is both a library and an entry point runs its `main` only when
 * invoked directly. Compares file URLs, which normalises the Windows
 * backslash path `process.argv[1]` carries.
 */
export function isMainModule(moduleUrl: string): boolean {
    const entry = process.argv[1];
    return entry !== undefined && pathToFileURL(resolve(entry)).href === moduleUrl;
}
