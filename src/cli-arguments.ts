/**
 * The compiler command line. Parsing it loads nothing of the compiler, so
 * `bblitec` reads the conditions a run builds under before starting it.
 */
import type { CompileOptions } from "./compiler/types.js";

/** What a run produces: a generated tree, or a survey's census in its place. */
export type CliTarget =
    | { kind: "generate"; output: string }
    | { kind: "survey"; census: string; passes?: number; entryOnly?: true };

export interface CliOptions {
    input: string;
    target: CliTarget;
    title?: string;
    width?: number;
    height?: number;
    search?: string;
    initialSearch?: string;
    publicDir?: string;
    publicUrl?: string;
    siteUrl?: string;
    environment: Record<string, string>;
    siteRoot?: string;
    /** An HTML page's site public directory, when not `publicDir`. */
    sitePublicDir?: string;
    /** The module an HTML page's module script loads in place of its URL. */
    pageEntry?: string;
    idDiagnostics: boolean;
    sourceProfile?: string[];
    coverage?: string;
    deferredCapabilities?: CompileOptions["deferredCapabilities"];
    /** The bundler conditions the run builds under (`compiler-node-flags.ts`). */
    conditions: string[];
}

/**
 * Every option `parseArguments` accepts, with its value placeholder. The
 * usage text is generated from this table, and a test holds the table and
 * the parser's cases to the same set, so neither can grow alone.
 */
const TARGET_FLAGS = [
    { flag: "--out", value: "<directory>" },
    { flag: "--survey", value: "<census.json>" },
] as const;
const OPTION_FLAGS: ReadonlyArray<{ flag: string; value?: string }> = [
    { flag: "--title", value: "<text>" },
    { flag: "--width", value: "<pixels>" },
    { flag: "--height", value: "<pixels>" },
    { flag: "--search", value: "<query>" },
    { flag: "--initial-search", value: "<query>" },
    { flag: "--public-dir", value: "<directory>" },
    { flag: "--public-url", value: "<url>" },
    { flag: "--site-url", value: "<url>" },
    { flag: "--env", value: "<NAME=value>" },
    { flag: "--site-root", value: "<directory>" },
    { flag: "--site-public-dir", value: "<directory>" },
    { flag: "--page-entry", value: "<module.ts>" },
    { flag: "--id-diagnostics" },
    { flag: "--source-profile", value: "<function,...>" },
    { flag: "--coverage", value: "<coverage.json>" },
    { flag: "--survey-passes", value: "<count>" },
    { flag: "--survey-entry-only" },
    { flag: "--deferred-capabilities", value: "runtime-throw" },
    { flag: "--condition", value: "<name>" },
];

function usage(): never {
    const spell = (option: { flag: string; value?: string }): string =>
        option.value === undefined
            ? option.flag
            : `${option.flag} ${option.value}`;
    console.error(
        `Usage: bblitec <entry.ts | page.html> (${TARGET_FLAGS.map(spell).join(" | ")}) ` +
            OPTION_FLAGS.map((option) => `[${spell(option)}]`).join(" "),
    );
    process.exit(2);
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} expects a positive integer.`);
    }
    return parsed;
}

export function parseArguments(arguments_: readonly string[]): CliOptions {
    const input = arguments_[0];
    if (!input || input.startsWith("--")) {
        usage();
    }

    let output: string | undefined;
    let survey: string | undefined;
    let title: string | undefined;
    let width: number | undefined;
    let height: number | undefined;
    let search: string | undefined;
    let initialSearch: string | undefined;
    let publicDir: string | undefined;
    let publicUrl: string | undefined;
    let siteUrl: string | undefined;
    const environment = new Map<string, string>();
    let siteRoot: string | undefined;
    let sitePublicDir: string | undefined;
    let pageEntry: string | undefined;
    let idDiagnostics = false;
    let sourceProfile: string[] | undefined;
    let coverage: string | undefined;
    let surveyPasses: number | undefined;
    let surveyEntryOnly = false;
    let deferredCapabilities: CompileOptions["deferredCapabilities"];
    const conditions: string[] = [];

    for (let index = 1; index < arguments_.length; index += 1) {
        const flag = arguments_[index];
        const value = arguments_[index + 1];
        switch (flag) {
            case "--out":
                if (!value) usage();
                output = value;
                index += 1;
                break;
            case "--survey":
                if (!value) usage();
                survey = value;
                index += 1;
                break;
            case "--coverage":
                if (!value || value.startsWith("--")) usage();
                coverage = value;
                index += 1;
                break;
            case "--survey-passes":
                surveyPasses = parsePositiveInteger(value, flag);
                index += 1;
                break;
            case "--survey-entry-only":
                surveyEntryOnly = true;
                break;
            case "--deferred-capabilities":
                if (value !== "runtime-throw")
                    throw new Error(
                        "--deferred-capabilities expects runtime-throw.",
                    );
                deferredCapabilities = value;
                index += 1;
                break;
            case "--title":
                if (!value) usage();
                title = value;
                index += 1;
                break;
            case "--width":
                width = parsePositiveInteger(value, flag);
                index += 1;
                break;
            case "--height":
                height = parsePositiveInteger(value, flag);
                index += 1;
                break;
            case "--search":
                if (!value) usage();
                search = value;
                index += 1;
                break;
            case "--initial-search":
                if (value === undefined) usage();
                initialSearch = value;
                index += 1;
                break;
            case "--site-root":
                if (!value) usage();
                siteRoot = value;
                index += 1;
                break;
            case "--site-public-dir":
                if (!value) usage();
                sitePublicDir = value;
                index += 1;
                break;
            case "--page-entry":
                if (!value) usage();
                pageEntry = value;
                index += 1;
                break;
            case "--public-dir":
                if (!value) usage();
                publicDir = value;
                index += 1;
                break;
            case "--condition":
                if (!value) usage();
                conditions.push(value);
                index += 1;
                break;
            case "--public-url":
                if (!value) usage();
                publicUrl = value;
                index += 1;
                break;
            case "--site-url":
                if (!value) usage();
                siteUrl = value;
                index += 1;
                break;
            case "--env": {
                const equals = value?.indexOf("=") ?? -1;
                if (!value || equals <= 0)
                    throw new Error("--env expects NAME=value.");
                environment.set(
                    value.slice(0, equals),
                    value.slice(equals + 1),
                );
                index += 1;
                break;
            }
            case "--id-diagnostics":
                idDiagnostics = true;
                break;
            case "--source-profile": {
                const names = value
                    ?.split(",")
                    .map((name) => name.trim())
                    .filter(Boolean);
                if (!names?.length)
                    throw new Error(
                        "--source-profile expects comma-separated source function names.",
                    );
                sourceProfile = names;
                index += 1;
                break;
            }
            default:
                throw new Error(`Unknown argument '${flag}'.`);
        }
    }

    const target: CliTarget = survey
        ? {
              kind: "survey",
              census: survey,
              ...(surveyPasses ? { passes: surveyPasses } : {}),
              ...(surveyEntryOnly ? { entryOnly: true as const } : {}),
          }
        : output
          ? { kind: "generate", output }
          : usage();

    return {
        input,
        target,
        idDiagnostics,
        environment: Object.fromEntries(environment),
        ...(title ? { title } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(search ? { search } : {}),
        ...(initialSearch !== undefined ? { initialSearch } : {}),
        ...(publicDir ? { publicDir } : {}),
        ...(publicUrl ? { publicUrl } : {}),
        ...(siteUrl ? { siteUrl } : {}),
        ...(siteRoot ? { siteRoot } : {}),
        ...(sitePublicDir ? { sitePublicDir } : {}),
        ...(pageEntry ? { pageEntry } : {}),
        ...(sourceProfile ? { sourceProfile } : {}),
        ...(coverage ? { coverage } : {}),
        ...(deferredCapabilities ? { deferredCapabilities } : {}),
        conditions,
    };
}
