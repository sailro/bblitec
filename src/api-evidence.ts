import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "node:test";
import { apiHash, isRecord, type ApiSnapshot } from "./api-surface.js";

export interface ApiCase {
    id: string;
    level: "generation" | "native" | "parity" | "refusal";
    /** A scoped claim: a passing test does not establish every value/ownership combination. */
    scope: string;
    limitations: string;
    test: { file: string; name: string };
    targets: { id: string; fingerprint: string }[];
}

export interface ApiReceipt {
    schemaVersion: 1;
    inputs: string;
    cases: {
        id: string;
        definition: string;
        status: "passed" | "failed" | "skipped" | "missing";
    }[];
}

function requiredString(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || !value.trim())
        throw new Error(`API coverage requires a nonempty ${key}.`);
    return value;
}

export function readApiCases(path: string): ApiCase[] {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        !Array.isArray(value.cases)
    )
        throw new Error(`Invalid API cases: ${path}`);
    const seen = new Set<string>();
    return value.cases.map((row: unknown) => {
        if (
            !isRecord(row) ||
            !isRecord(row.test) ||
            !Array.isArray(row.targets) ||
            !row.targets.length
        ) {
            throw new Error(`Invalid API case in ${path}`);
        }
        const id = requiredString(row, "id");
        if (seen.has(id)) throw new Error(`Duplicate API case: ${id}`);
        seen.add(id);
        const level = row.level;
        if (
            level !== "generation" &&
            level !== "native" &&
            level !== "parity" &&
            level !== "refusal"
        )
            throw new Error(`Invalid level: ${id}`);
        const file = requiredString(row.test, "file");
        if (!/^test\/[\w/-]+\.test\.ts$/.test(file))
            throw new Error(
                `API case must select a repository test file: ${id}`,
            );
        const targets = row.targets.map((target: unknown) => {
            if (!isRecord(target)) throw new Error(`Invalid target: ${id}`);
            return {
                id: requiredString(target, "id"),
                fingerprint: requiredString(target, "fingerprint"),
            };
        });
        if (new Set(targets.map((target) => target.id)).size !== targets.length)
            throw new Error(`Duplicate targets: ${id}`);
        return {
            id,
            level,
            scope: requiredString(row, "scope"),
            limitations: requiredString(row, "limitations"),
            test: { file, name: requiredString(row.test, "name") },
            targets,
        };
    });
}

export function staleApiCases(
    cases: readonly ApiCase[],
    snapshot: ApiSnapshot,
): string[] {
    const items = new Map(
        snapshot.items.map((item) => [item.id, item.fingerprint]),
    );
    return cases
        .filter((entry) =>
            entry.targets.some(
                (target) => items.get(target.id) !== target.fingerprint,
            ),
        )
        .map((entry) => entry.id);
}

/** Conservative source identity. Documentation and generated outputs do not invalidate tests. */
export function apiEvidenceInputs(root: string, snapshot: ApiSnapshot): string {
    const paths = execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    )
        .split("\0")
        .filter(
            (path) =>
                /^(src|test|checks|tools|upstream)\//.test(path) ||
                /^corpus\/.*\.(?:ts|js|json|html|css)$/.test(path) ||
                /^native\/.*\.(?:cpp|hpp|h|c|cmake|json|patch|txt)$/.test(
                    path,
                ) ||
                path === "package-lock.json" ||
                path === "package.json" ||
                path === "tsconfig.json",
        );
    const hashes = [...new Set(paths)]
        .sort()
        .map((path) => [
            path,
            existsSync(join(root, path))
                ? apiHash(readFileSync(join(root, path)))
                : "missing",
        ]);
    return apiHash(
        JSON.stringify([
            snapshot.pin,
            snapshot.declarationsSha256,
            process.version,
            process.platform,
            process.arch,
            hashes,
        ]),
    );
}

export async function runApiCases(
    root: string,
    cases: readonly ApiCase[],
    inputs: string,
): Promise<ApiReceipt> {
    const results: ApiReceipt["cases"] = [];
    const files = [...new Set(cases.map((entry) => entry.test.file))];
    for (const file of files) {
        const selected = cases.filter((entry) => entry.test.file === file);
        const statuses = new Map<
            string,
            ApiReceipt["cases"][number]["status"]
        >();
        let fileFailed = false;
        const escaped = (text: string): string =>
            text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const stream = run({
            files: [join(root, "dist", file.replace(/\.ts$/, ".js"))],
            execArgv: [],
            testNamePatterns: selected.map(
                (entry) => new RegExp(`^${escaped(entry.test.name)}$`),
            ),
            concurrency: 1,
            timeout: 300_000,
        });
        // Test events are object-mode stream records. Consume through teardown so a
        // passing assertion cannot hide a later file-level failure.
        for await (const event of stream) {
            const value: unknown = event;
            if (
                !isRecord(value) ||
                !isRecord(value.data) ||
                typeof value.data.name !== "string"
            )
                continue;
            const data = value.data;
            const name = value.data.name;
            if (value.type === "test:pass")
                statuses.set(
                    name,
                    data.skip || data.todo ? "skipped" : "passed",
                );
            if (value.type === "test:fail") {
                statuses.set(name, "failed");
                fileFailed = true;
            }
        }
        for (const entry of selected)
            results.push({
                id: entry.id,
                definition: apiHash(JSON.stringify(entry)),
                status: fileFailed
                    ? "failed"
                    : (statuses.get(entry.test.name) ?? "missing"),
            });
    }
    return { schemaVersion: 1, inputs, cases: results };
}

export function readApiReceipt(path: string): ApiReceipt | undefined {
    if (!existsSync(path)) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.inputs !== "string" ||
        !Array.isArray(value.cases)
    ) {
        throw new Error(`Invalid API receipt: ${path}`);
    }
    const cases: ApiReceipt["cases"] = value.cases.map(
        (row: unknown): ApiReceipt["cases"][number] => {
            if (!isRecord(row))
                throw new Error(`Invalid API receipt case: ${path}`);
            const status = row.status;
            if (
                status !== "passed" &&
                status !== "failed" &&
                status !== "skipped" &&
                status !== "missing"
            )
                throw new Error(`Invalid API verdict: ${path}`);
            return {
                id: requiredString(row, "id"),
                definition: requiredString(row, "definition"),
                status,
            };
        },
    );
    return { schemaVersion: 1, inputs: value.inputs, cases };
}

export function assessApiCases(
    cases: readonly ApiCase[],
    snapshot: ApiSnapshot,
    receipt: ApiReceipt | undefined,
    inputs: string,
) {
    const stale = new Set(staleApiCases(cases, snapshot));
    const results = new Map(
        receipt?.cases.map((result) => [result.id, result]),
    );
    return cases.map((entry) => {
        const result = results.get(entry.id);
        const status = stale.has(entry.id)
            ? "declaration-changed"
            : !result
              ? "unrun"
              : receipt?.inputs !== inputs ||
                  result.definition !== apiHash(JSON.stringify(entry))
                ? "stale"
                : result.status;
        return { ...entry, status };
    });
}
