import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompilerProgram } from "./compiler/program.js";
import { findRepositoryRoot, repositoryRelativePath } from "./upstream-source.js";
import { isMainModule, parseFlags, usageFromSpec, type FlagSpec } from "./tooling/flags.js";
import { diffApi, loadApiSurface, readApiSnapshot, type ApiSurface } from "./api-surface.js";
import { apiEvidenceInputs, assessApiCases, readApiCases, readApiReceipt, runApiCases, staleApiCases } from "./api-evidence.js";
import { scanApiUsage, type ApiUsage } from "./api-usage.js";
import { apiCoverageReport, apiReportHtml } from "./api-report.js";
import { scenes } from "./scene-registry.js";
import { writeJsonRecord } from "./validation-resume.js";
import { apiBaselineCurrent, readApiBaseline, runApiBaseline } from "./api-baseline.js";
import { inspectApiBindings } from "./api-bindings.js";

/** The parser and the help line read one table. */
const commands: Readonly<Record<string, FlagSpec>> = {
    snapshot: { boolean: ["--write"] },
    check: {},
    diff: { value: ["--baseline"] },
    report: { boolean: ["--run"], value: ["--filter", "--output", "--project"] },
};

function typescriptFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? typescriptFiles(path) : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
    });
}

/** Every registered scene, the corpus source graph and the TypeScript fixtures, as one discovery program. */
function repositoryUsage(root: string, surface: ApiSurface): ApiUsage {
    console.log("Resolving API references in registered scenes, the corpus source graph, and TypeScript fixtures.");
    const roots = [...new Set([...scenes.map(scene => resolve(root, scene.source)),
        ...typescriptFiles(join(root, "corpus/babylon-lite/lab/lite/src")), ...typescriptFiles(join(root, "test/fixtures"))])].sort();
    const source = roots.map(path => `import ${JSON.stringify(`./${repositoryRelativePath(root, path)}`)};`).join("\n");
    const { program } = createCompilerProgram(source, join(root, "__api_inventory__.ts"));
    const usage = scanApiUsage(program, surface, root);
    usage.files = usage.files.filter(file => file.path !== "__api_inventory__.ts");
    return usage;
}

/** One external entry and everything it imports, named relative to the entry's directory. */
function projectUsage(entry: string, surface: ApiSurface): ApiUsage {
    console.log(`Resolving API references reached from ${entry}.`);
    const { program } = createCompilerProgram(readFileSync(entry, "utf8"), entry);
    return scanApiUsage(program, surface, dirname(entry));
}

/** The owners of the exported functions a usage references: the only entry adapters a project report probes. */
function referencedFunctionOwners(surface: ApiSurface, usage: ApiUsage): ReadonlySet<string> {
    const owners = new Map(surface.snapshot.items.filter(item => item.kind === "function").map(item => [item.id, item.owner]));
    return new Set(usage.uses.flatMap(use => { const owner = owners.get(use.id); return owner === undefined ? [] : [owner]; }));
}

export async function apiCommand(args: readonly string[]): Promise<void> {
    const root = findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
    const [command = "help", ...rest] = args;
    if (command === "help") {
        console.log(`npm run api -- ${Object.entries(commands).map(([name, spec]) => [name, usageFromSpec(spec)].filter(part => part !== "").join(" ")).join(" | ")}`);
        return;
    }
    const spec = commands[command];
    if (!spec) throw new Error(`Unknown API command: ${command}`);
    const flags = parseFlags(rest, spec, `api ${command}`);
    const surface = loadApiSurface();
    const { snapshot } = surface;
    const baseline = resolve(root, flags.values.get("--baseline") ?? "upstream/babylon-lite-api.json");
    if (command === "snapshot") {
        if (flags.flags.has("--write")) {
            // One item per line keeps weekly declaration diffs reviewable.
            const { items, ...header } = snapshot;
            writeFileSync(baseline, `${JSON.stringify(header, null, 2).slice(0, -2)},\n  "items": [\n${items.map(item => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]\n}\n`);
            console.log(`Wrote ${baseline}`);
        }
        console.log(`${Object.keys(snapshot.exports).length} exports; ${snapshot.items.length} declaration items; ${snapshot.pin.package}@${snapshot.pin.version}`);
        return;
    }
    const cases = readApiCases(join(root, "upstream/api-coverage.json"));
    if (command === "diff" || command === "check") {
        const previous = readApiSnapshot(baseline);
        const delta = diffApi(previous, snapshot);
        const stale = staleApiCases(cases, snapshot);
        const pinChanged = JSON.stringify(previous.pin) !== JSON.stringify(snapshot.pin);
        const descriptorChanged = previous.declarationsSha256 !== snapshot.declarationsSha256 || previous.typescript !== snapshot.typescript;
        console.log(JSON.stringify({ ...delta, pinChanged, descriptorChanged, staleCases: stale }, null, 2));
        if (command === "check" && (pinChanged || descriptorChanged || delta.exportsChanged || delta.added.length || delta.removed.length || delta.changed.length || stale.length)) {
            throw new Error("API baseline or coverage targets changed. Review api diff, update affected cases, then write the snapshot explicitly.");
        }
        return;
    }
    const project = flags.values.get("--project");
    const entry = project === undefined ? undefined : resolve(root, project);
    if (entry !== undefined && flags.flags.has("--run")) throw new Error("A project report only reads collected evidence; run 'report --run' without --project first.");
    // Receipts live in the coverage directory; a project's report nests beside them.
    const coverage = resolve(root, flags.values.get("--output") ?? "artifacts/api-coverage");
    const output = entry === undefined ? coverage : join(coverage, "projects", `${basename(dirname(entry))}-${parse(entry).name}`);
    const receiptPath = join(coverage, "evidence.json");
    const inputs = apiEvidenceInputs(root, snapshot);
    let receipt = readApiReceipt(receiptPath);
    const baselinePath = join(coverage, "baseline.json");
    let collected = readApiBaseline(baselinePath);
    if (flags.flags.has("--run")) {
        const stale = staleApiCases(cases, snapshot);
        if (stale.length) throw new Error(`Review changed declarations before running evidence: ${stale.join(", ")}`);
        collected = await runApiBaseline(root, coverage, inputs, snapshot);
        if (apiEvidenceInputs(root, snapshot) !== inputs) throw new Error("API baseline inputs changed while collecting coverage.");
        writeJsonRecord(baselinePath, collected);
        console.log(`Running ${cases.length} scoped API evidence cases.`);
        receipt = await runApiCases(root, cases, inputs);
        if (apiEvidenceInputs(root, snapshot) !== inputs) throw new Error("API evidence inputs changed while tests were running.");
        writeJsonRecord(receiptPath, receipt);
    }
    const usage = entry === undefined ? repositoryUsage(root, surface) : projectUsage(entry, surface);
    const assessed = assessApiCases(cases, snapshot, receipt, inputs);
    const currentBaseline = apiBaselineCurrent(collected, inputs, root) ? collected : undefined;
    console.log("Inspecting exported function routes through the intrinsic registry.");
    const bindings = inspectApiBindings(snapshot, entry === undefined ? undefined : referencedFunctionOwners(surface, usage));
    const report = apiCoverageReport(snapshot, usage, assessed, flags.values.get("--filter"), currentBaseline, bindings, entry !== undefined);
    writeJsonRecord(join(output, "report.json"), report);
    writeFileSync(join(output, "report.html"), apiReportHtml(report));
    console.log(JSON.stringify({ total: report.total, counts: report.counts, adapters: report.adapters, automatic: report.automatic, exerciseMetrics: report.metrics,
        readiness: report.readiness,
        cases: assessed.map(entry => ({ id: entry.id, status: entry.status })), files: usage.files.length, diagnostics: usage.diagnostics.length }, null, 2));
    if (report.readiness?.evidence === "stale") console.log("Evidence is missing or stale for the current inputs; run 'report --run' to credit supported forms.");
    console.log(`Report: ${join(output, "report.html")}`);
    if (flags.flags.has("--run") && assessed.some(entry => entry.status !== "passed")) {
        throw new Error("API evidence is incomplete: failed, skipped, missing, or stale cases receive no coverage credit.");
    }
}

if (isMainModule(import.meta.url)) apiCommand(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
