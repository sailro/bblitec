import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixtureDirectory() {
    const root = resolve("artifacts/project-audit-tests");
    mkdirSync(root, { recursive: true });
    return mkdtempSync(resolve(root, "case-"));
}

test("acceptance progress requires evidence, complete scope and final integration gates", async t => {
    const directory = fixtureDirectory();
    const evidence = { path: "pass.log", sha256: hash("native checks passed\n") };
    const inventory = JSON.stringify({ requirements: [{ id: "required-api" }] });
    writeFileSync(resolve(directory, evidence.path), "native checks passed\n");
    writeFileSync(resolve(directory, "inventory.json"), inventory);
    const ids = ["feature", "generate", "build", "run", "validate"];
    const original = {
        schemaVersion: 1, baseline: "neutral-fixture",
        baselinePackageIds: ids, integrationGateIds: ids.slice(1),
        endToEnd: { generate: "generate", build: "build", run: "run", validate: "validate" },
        inventory: { path: "inventory.json", sha256: hash(inventory) },
        scopeChanges: [],
        packages: ids.map((id, index) => ({
            id, title: id, status: index === 0 ? "complete" : "open",
            dependencies: index ? [ids[index - 1]!] : [], blockers: [] as string[],
            requirementIds: index === 0 ? ["required-api"] : [],
            acceptance: [{ text: `Verify ${id}`, status: "passed", evidence: [evidence] }],
        })),
    };
    const ledgerPath = resolve(directory, "ledger.json");
    const reportPath = resolve(directory, "report.md");
    const run = (ledger: typeof original) => {
        writeFileSync(ledgerPath, JSON.stringify(ledger));
        return spawnSync(process.execPath, ["tools/project-progress.mjs", ledgerPath, reportPath], { encoding: "utf8" });
    };
    const baseline = run(original);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).percent, 20);
    assert.match(readFileSync(reportPath, "utf8"), /1\/5 acceptance groups complete/);
    const partial = structuredClone(original);
    partial.packages[0]!.status = "open";
    assert.equal(JSON.parse(run(partial).stdout).percent, 0, "passing partial checks cannot close a group");
    const complete = structuredClone(original);
    complete.packages.forEach(item => { item.status = "complete"; });
    assert.equal(JSON.parse(run(complete).stdout).percent, 100);

    const rejects: [string, (ledger: typeof original) => void, RegExp][] = [
        ["missing evidence", ledger => { ledger.packages[0]!.acceptance[0]!.evidence = []; }, /lacks passing evidence/],
        ["failed acceptance", ledger => { ledger.packages[0]!.acceptance[0]!.status = "failed"; }, /lacks passing evidence/],
        ["changed evidence", ledger => { ledger.packages[0]!.acceptance[0]!.evidence[0]!.sha256 = "invalid"; }, /evidence changed/],
        ["open blocker", ledger => { ledger.packages[0]!.blockers.push("required case fails"); }, /open blockers/],
        ["removed scope", ledger => { ledger.packages.shift(); }, /baseline package\/gate removed/],
        ["missing launch gate", ledger => { ledger.endToEnd.run = ""; }, /missing run integration gate/],
        ["merged final gates", ledger => { ledger.endToEnd.run = "build"; }, /distinct gates/],
        ["open dependency", ledger => { ledger.packages[2]!.status = "complete"; }, /dependency generate remains open/],
        ["changed inventory", ledger => { ledger.inventory.sha256 = "invalid"; }, /inventory changed/],
        ["omitted requirement", ledger => { ledger.packages[0]!.requirementIds = []; }, /not fully assigned/],
        ["duplicate requirement", ledger => { ledger.packages[1]!.requirementIds = ["required-api"]; }, /assigned twice/],
        ["dependency cycle", ledger => { ledger.packages[1]!.dependencies = ["build"]; }, /dependency cycle/],
        ["undocumented addition", ledger => { ledger.packages.push({ ...structuredClone(ledger.packages[0]!), id: "extra" }); }, /undocumented scope addition/],
    ];
    for (const [name, mutate, expected] of rejects) await t.test(name, () => {
        const ledger = structuredClone(original);
        mutate(ledger);
        const result = run(ledger);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
    });
});

test("source inventory distinguishes runtime syntax and standard APIs from type-only and local forms", () => {
    const directory = fixtureDirectory();
    writeFileSync(resolve(directory, "helper.ts"), "export interface Shape { value: number }\nexport const value = 1;\n");
    const source = `
import { type Shape } from './helper.js';
import { type Shape as Alias, value } from './helper.js';
export { type Shape } from './helper.js';
interface Extended extends Shape { extra: number }
class Base { value = 1; }
class Derived extends Base { #own = 2; static { void value; } get own() { return this.#own; } }
async function lifecycle() {
    try { await Promise.resolve(); }
    catch { await Promise.resolve(); const nested = async () => await Promise.resolve(); void nested; }
    finally { await Promise.resolve(); const nested = async () => await Promise.resolve(); void nested; }
}
function* sequence() { yield 1; }
async function consume() { for await (const item of sequence()) { void item; } }
new Worker('./worker.js');
function localWorker() { class Worker { constructor(path: string) { void path; } } new Worker('local'); }
const local = { addEventListener(name: string) { void name; } };
local.addEventListener('local');
document.addEventListener('pointermove', () => {}, true);
const pair: [string, number] = ['value', 1]; const index = Number('1'); pair[index] = 3;
const [head, ...tail] = pair;
const record: Record<string, unknown> = {}; void record.dynamic;
const dynamic = import('./helper.js');
`;
    const entry = resolve(directory, "entry.ts"), output = resolve(directory, "report.json");
    writeFileSync(entry, source);
    execFileSync(process.execPath, ["tools/project-requirements.mjs", entry, output], { stdio: "pipe" });
    const report = JSON.parse(readFileSync(output, "utf8"));
    const entryDetails = report.files.find((file: { path: string }) => file.path === "entry.ts");
    const sites = (id: string) => report.requirements.find((row: { id: string }) => row.id === id)?.sites ?? [];
    assert.equal(report.totals.files, 2);
    assert.equal(entryDetails.sha256, hash(source));
    assert.deepEqual(entryDetails.imports.map((item: { typeOnly: boolean }) => item.typeOnly), [true, false, true]);
    assert.ok(entryDetails.imports.every((item: { target: string }) => item.target === "helper.ts"));
    assert.equal(entryDetails.workers.length, 1, "local Worker classes are not platform entries");
    assert.equal(entryDetails.dynamicImports.length, 1);
    for (const id of ["syntax:class-extends", "syntax:class-static-block", "syntax:generator", "syntax:for-await",
        "syntax:await-in-catch", "syntax:await-in-finally", "tuple:dynamic-write", "syntax:rest-binding", "unresolved:property"]) {
        assert.equal(sites(id).length, 1, id);
    }
    const listeners = report.requirements.filter((row: { id: string }) => row.id.endsWith(".addEventListener"))
        .flatMap((row: { sites: { detail: { event: string; arguments: string[] } }[] }) => row.sites);
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].detail.event, "pointermove");
    assert.deepEqual(listeners[0].detail.arguments, ["StringLiteral", "callback", "true"]);
});
