import { isRecord } from "./json-fields.js";
import {
    createReadStream,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { apiHash, type ApiSnapshot } from "./api-surface.js";
import { type ApiUse } from "./api-usage.js";
import { contentDigest, writeJsonRecord } from "./tooling/records.js";
import { scenes } from "./scene-registry.js";
import { runLoggedProcess } from "./tooling/logged-process.js";
import { sharedUpstreamStore } from "./upstream-source.js";

export interface ApiTranslation {
    suite: string;
    modulePath: string;
    symbolName: string;
    source: string;
    extent: "function" | "specialization" | "selected-body";
    adapters: string[];
    requests: string[];
    owners: string[];
}

export interface ApiBaseline {
    schemaVersion: 2;
    inputs: string;
    compilations: number;
    testsPassed: number;
    suites: string[];
    files: { path: string; sha256: string }[];
    uses: (ApiUse & { suite: string; source: string })[];
    translations: ApiTranslation[];
}

function readFiles(value: unknown): ApiBaseline["files"] {
    if (!Array.isArray(value)) throw new Error("Invalid API source hashes.");
    return value.map((file: unknown) => {
        if (
            !isRecord(file) ||
            typeof file.path !== "string" ||
            typeof file.sha256 !== "string"
        )
            throw new Error("Invalid API source hash.");
        return { path: file.path, sha256: file.sha256 };
    });
}

function readUses(value: unknown): ApiBaseline["uses"] {
    if (!Array.isArray(value)) throw new Error("Invalid API sites.");
    return value.map((use: unknown): ApiBaseline["uses"][number] => {
        if (
            !isRecord(use) ||
            typeof use.id !== "string" ||
            typeof use.file !== "string" ||
            typeof use.line !== "number" ||
            typeof use.column !== "number" ||
            typeof use.shape !== "string" ||
            typeof use.suite !== "string" ||
            typeof use.source !== "string"
        )
            throw new Error("Invalid API baseline site.");
        const operation = use.operation;
        if (
            operation !== "call" &&
            operation !== "construct" &&
            operation !== "read" &&
            operation !== "write" &&
            operation !== "read-write" &&
            operation !== "provide" &&
            operation !== "reference"
        )
            throw new Error("Invalid API operation.");
        return {
            id: use.id,
            file: use.file,
            line: use.line,
            column: use.column,
            shape: use.shape,
            suite: use.suite,
            source: use.source,
            operation,
        };
    });
}

function readTranslation(value: unknown): ApiTranslation {
    if (
        !isRecord(value) ||
        typeof value.suite !== "string" ||
        typeof value.modulePath !== "string" ||
        typeof value.symbolName !== "string" ||
        typeof value.source !== "string" ||
        !Array.isArray(value.adapters) ||
        !value.adapters.every((entry: unknown) => typeof entry === "string") ||
        !Array.isArray(value.owners) ||
        !Array.isArray(value.requests) ||
        !value.requests.every((entry: unknown) => typeof entry === "string") ||
        !value.owners.every((entry: unknown) => typeof entry === "string") ||
        (value.extent !== "function" &&
            value.extent !== "specialization" &&
            value.extent !== "selected-body")
    )
        throw new Error("Invalid API translation.");
    return {
        suite: value.suite,
        modulePath: value.modulePath,
        symbolName: value.symbolName,
        source: value.source,
        extent: value.extent,
        adapters: value.adapters,
        requests: value.requests,
        owners: value.owners,
    };
}

function baselineValue(value: unknown): ApiBaseline {
    if (
        !isRecord(value) ||
        value.schemaVersion !== 2 ||
        typeof value.inputs !== "string" ||
        typeof value.compilations !== "number" ||
        typeof value.testsPassed !== "number" ||
        !Array.isArray(value.suites) ||
        !value.suites.every((suite: unknown) => typeof suite === "string") ||
        !Array.isArray(value.translations)
    )
        throw new Error("Invalid API baseline.");
    return {
        schemaVersion: 2,
        inputs: value.inputs,
        compilations: value.compilations,
        testsPassed: value.testsPassed,
        suites: value.suites,
        files: readFiles(value.files),
        uses: readUses(value.uses),
        translations: value.translations.map(readTranslation),
    };
}

export function readApiBaseline(path: string): ApiBaseline | undefined {
    if (!existsSync(path)) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    // Version 1 did not collect translated bodies and cannot qualify this report.
    return isRecord(value) && value.schemaVersion === 1
        ? undefined
        : baselineValue(value);
}

export function apiBaselineCurrent(
    baseline: ApiBaseline | undefined,
    inputs: string,
    root: string,
): boolean {
    return (
        baseline !== undefined &&
        baseline.inputs === inputs &&
        baseline.files.every(
            (file) =>
                existsSync(join(root, file.path)) &&
                apiHash(readFileSync(join(root, file.path))) === file.sha256,
        )
    );
}

async function runBaselineStep(
    root: string,
    args: string[],
    directory: string,
    logName: string,
): Promise<void> {
    const log = join(directory, logName);
    const code = await runLoggedProcess(process.execPath, args, log, {
        cwd: root,
        env: {
            ...process.env,
            BBLITE_API_TRACE_DIR: join(directory, "traces"),
        },
    });
    if (code !== 0)
        throw new Error(`API baseline failed (${code}); see ${log}.`);
}

export async function runApiBaseline(
    root: string,
    output: string,
    inputs: string,
    snapshot: ApiSnapshot,
): Promise<ApiBaseline> {
    // Every run owns an immutable directory: failed runs never mix with old evidence.
    const directory = join(output, `run-${Date.now()}-${process.pid}`);
    mkdirSync(directory, { recursive: true });
    const preload = pathToFileURL(join(root, "dist/src/api-collect.js")).href;
    console.log(
        `Collecting the complete test suite; log: ${join(directory, "tests.log")}`,
    );
    await runBaselineStep(
        root,
        [
            "--import",
            preload,
            "--test",
            "--test-reporter=tap",
            "dist/test/*.test.js",
        ],
        directory,
        "tests.log",
    );
    const testLog = readFileSync(join(directory, "tests.log"), "utf8");
    const summary = (name: string): number => {
        const matches = [
            ...testLog.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm")),
        ];
        return matches.length === 1 ? Number(matches[0]![1]) : -1;
    };
    const testsPassed = summary("pass");
    if (
        testsPassed <= 0 ||
        summary("tests") !== testsPassed ||
        ["fail", "cancelled", "skipped", "todo"].some(
            (name) => summary(name) !== 0,
        )
    ) {
        throw new Error(
            `API baseline requires a complete passing suite; see ${join(directory, "tests.log")}.`,
        );
    }
    console.log(
        `Collecting every registered scene; log: ${join(directory, "scenes.log")}`,
    );
    await runBaselineStep(
        root,
        ["--import", preload, "dist/src/api-scenes.js"],
        directory,
        "scenes.log",
    );
    const suites = new Set<string>();
    const uses = new Map<string, ApiBaseline["uses"][number]>();
    const files = new Map<string, string>();
    const translations = new Map<string, ApiTranslation>();
    const publicFunctions = new Set(
        snapshot.items
            .filter((item) => item.kind === "function")
            .map((item) => item.owner),
    );
    const exportsBySource = new Map<string, string[]>();
    const store = sharedUpstreamStore();
    for (const [name, owner] of Object.entries(snapshot.exports))
        if (publicFunctions.has(owner)) {
            const source = store.resolvePublicExport(name);
            const key = `${source.modulePath}#${source.importedName}`;
            exportsBySource.set(key, [
                ...new Set([...(exportsBySource.get(key) ?? []), owner]),
            ]);
        }
    let compilations = 0;
    for (const name of readdirSync(join(directory, "traces")).sort()) {
        const lines = createInterface({
            input: createReadStream(join(directory, "traces", name)),
            crlfDelay: Infinity,
        });
        for await (const line of lines) {
            const row: unknown = JSON.parse(line);
            if (isRecord(row) && row.kind === "translation") {
                const translation = readTranslation({ ...row, owners: [] });
                translation.owners =
                    exportsBySource.get(
                        `${translation.modulePath}#${translation.symbolName}`,
                    ) ?? [];
                translations.set(JSON.stringify(translation), translation);
                continue;
            }
            if (
                !isRecord(row) ||
                typeof row.suite !== "string" ||
                typeof row.source !== "string" ||
                !Array.isArray(row.uses)
            )
                throw new Error(`Invalid API trace: ${name}`);
            const traceUses = readUses(
                row.uses.map((use: unknown) => {
                    if (!isRecord(use))
                        throw new Error(`Invalid API use: ${name}`);
                    return { ...use, suite: row.suite, source: row.source };
                }),
            );
            compilations++;
            suites.add(row.suite);
            for (const use of traceUses) uses.set(JSON.stringify(use), use);
            // Virtual test roots are preserved by source digest; repository files
            // additionally invalidate the receipt when their bytes change.
            for (const file of readFiles(row.files))
                if (existsSync(join(root, file.path))) {
                    const previous = files.get(file.path);
                    const diskHash = contentDigest(join(root, file.path));
                    if (diskHash !== file.sha256) continue;
                    if (previous && previous !== file.sha256)
                        throw new Error(
                            `API source changed during collection: ${file.path}`,
                        );
                    files.set(file.path, file.sha256);
                }
        }
    }
    const missing = scenes.filter((scene) => !suites.has(`scene:${scene.id}`));
    if (missing.length)
        throw new Error(
            `Missing API scene receipts: ${missing.map((scene) => scene.id).join(", ")}`,
        );
    const baseline: ApiBaseline = {
        schemaVersion: 2,
        inputs,
        compilations,
        testsPassed,
        suites: [...suites].sort(),
        files: [...files].map(([path, sha256]) => ({ path, sha256 })),
        uses: [...uses.values()],
        translations: [...translations.values()],
    };
    writeJsonRecord(join(directory, "baseline.json"), baseline);
    return baseline;
}
