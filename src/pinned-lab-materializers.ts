/**
 * Lab public files the pin materializes instead of committing.
 *
 * The pinned lab runs `scripts/fetch-flight-helmet.ts` before it serves
 * (`lab/package.json`): the script downloads scene 112's KTX2 fixture from an
 * immutable revision into `lab/public/models/FlightHelmetKTX`, which the
 * pin's `.gitignore` keeps out of its repository. The corpus carries such
 * scripts as tooling rows, and EXECUTING a copy writes the same files
 * beneath the corpus `lab/public`, where generation and reference capture
 * read pinned assets first. The script verifies every file's Git blob
 * digest, cache hits included.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import ts from "typescript";
import { runCaptured } from "./tooling/logged-process.js";
import { readBabylonLiteCorpus } from "./upstream-corpus.js";

const CORPUS_ROOT = "corpus/babylon-lite";

/** A tooling script that writes beneath `lab/public`, and the directory it writes. */
interface Materializer {
    script: string;
    output: string;
}

/** The directory a script writes, relative to its root: `join(ROOT, "lab/public/<path>")`. */
function outputDirectory(path: string): string | undefined {
    const file = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const variable of statement.declarationList.declarations) {
            const call = variable.initializer;
            if (
                ts.isIdentifier(variable.name) &&
                variable.name.text === "OUTPUT_DIR" &&
                call &&
                ts.isCallExpression(call) &&
                ts.isIdentifier(call.expression) &&
                call.expression.text === "join" &&
                call.arguments.length === 2 &&
                ts.isIdentifier(call.arguments[0]!) &&
                call.arguments[0].text === "ROOT" &&
                ts.isStringLiteral(call.arguments[1]!) &&
                call.arguments[1].text.startsWith("lab/public/")
            )
                return call.arguments[1].text;
        }
    }
    return undefined;
}

const materializersByRoot = new Map<string, readonly Materializer[]>();

/** The catalog's tooling scripts that write beneath `lab/public`, read once. */
function materializers(repositoryRoot: string): readonly Materializer[] {
    const known = materializersByRoot.get(repositoryRoot);
    if (known) return known;
    const found = (readBabylonLiteCorpus(repositoryRoot).tooling ?? []).flatMap(
        ({ source }) => {
            const output = outputDirectory(resolve(repositoryRoot, source));
            return output ? [{ script: source, output }] : [];
        },
    );
    materializersByRoot.set(repositoryRoot, found);
    return found;
}

/** The corpus directories the pinned scripts write and verify. */
export function pinnedLabMaterializedDirectories(
    repositoryRoot: string,
): string[] {
    return materializers(repositoryRoot).map(
        ({ output }) => `${CORPUS_ROOT}/${output}`,
    );
}

const materialized = new Set<string>();

/**
 * Run, once per process, the pinned script that writes `publicPath` (a path
 * beneath `lab/public`), before the file is read.
 */
function materializePinnedLabPublic(
    repositoryRoot: string,
    publicPath: string,
): void {
    const path = `lab/public/${publicPath.replace(/^\/+/, "")}`;
    for (const { script, output } of materializers(repositoryRoot)) {
        if (materialized.has(script) || !path.startsWith(`${output}/`))
            continue;
        // Node strips the script's types; its ROOT is the corpus root.
        runCaptured(
            process.execPath,
            [
                "--experimental-strip-types",
                "--no-warnings",
                resolve(repositoryRoot, script),
            ],
            `Pinned ${script} failed to materialize ${path}`,
            { cwd: resolve(repositoryRoot, CORPUS_ROOT) },
        );
        materialized.add(script);
    }
}

/**
 * The pinned lab's own copy of a public file, beneath the corpus
 * `lab/public`, once any pinned script that writes it has run.
 */
export function pinnedLabPublicFile(
    repositoryRoot: string,
    publicPath: string,
): string | undefined {
    materializePinnedLabPublic(repositoryRoot, publicPath);
    const directory = resolve(repositoryRoot, CORPUS_ROOT, "lab/public");
    const path = resolve(directory, `./${publicPath.replace(/^\/+/, "")}`);
    return path.startsWith(`${directory}${sep}`) &&
        existsSync(path) &&
        statSync(path).isFile()
        ? path
        : undefined;
}
