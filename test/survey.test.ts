import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource, surveySource } from "../src/compiler.js";
import { refusalClass, type SurveyReport } from "../src/compiler/survey.js";
import { registrySceneCompileOptions } from "../src/native-host-ui.js";
import { getScene } from "../src/scene-registry.js";

// Three refusals in two functions, each followed by a statement that still
// lowers: the survey must reach all of them and continue past each.
const refusing = `
class Base { value = 1; }
let total = 0;
function first(): void {
    class Derived extends Base { }
    total += new Derived().value;
    total += 1;
}
function second(): void {
    const p = new Proxy({}, {});
    if (p) total += 2;
    total += 3;
}
function third(): void {
    total += 4;
}
first();
second();
third();
localStorage.setItem("total", String(total));
`;

const listed = (report: SurveyReport): string =>
    report.refusals.map(refusal => `${refusal.site.line}: ${refusal.message}`).join("\n");

test("a survey records every refusal it reaches and continues past each", () => {
    const { report, result } = surveySource(refusing, { fileName: resolve("survey-refusals.ts") });
    assert.equal(report.complete, true);
    assert.equal(report.terminal, undefined);
    assert.ok(result, "every realm lowered to the end");
    assert.equal(report.refusals.length, 3, listed(report));
    assert.equal(report.statements.refused, 3);
    assert.ok(report.statements.attempted > report.statements.refused);
    // The class refuses where it is declared; the statement rolled back is
    // the construction that reached it.
    const inheritance = report.refusals.find(refusal => /inheritance/i.test(refusal.message));
    assert.ok(inheritance, listed(report));
    assert.equal(inheritance.site.line, 5);
    assert.equal(inheritance.statement.line, 6);
    assert.equal(inheritance.statement.kind, "ExpressionStatement");
    assert.equal(inheritance.statement.function, "first");
    assert.equal(inheritance.cascade, undefined);
    const proxy = report.refusals.find(refusal => refusal.message === "Unsupported constructor expression.");
    assert.ok(proxy, listed(report));
    assert.equal(proxy.statement.function, "second");
    assert.equal(proxy.statement.kind, "VariableStatement");
    assert.equal(proxy.cascade, undefined);
    // `p` was declared by the refused statement: its later read is a cascade
    // of that refusal, not a gap of its own.
    const cascade = report.refusals.find(refusal => refusal.cascade !== undefined);
    assert.ok(cascade, listed(report));
    assert.match(cascade.message, /^Unknown or unsupported variable 'p'\./);
    assert.deepEqual(cascade.cascade, proxy.site);
    assert.equal(cascade.statement.line, 11);
    assert.equal(cascade.statement.kind, "IfStatement");
    assert.equal(cascade.class, refusalClass(cascade.message));
    // Classes group by message shape and count sites, not lowerings.
    const classes = Object.fromEntries(report.classes.map(entry => [entry.class, entry]));
    assert.equal(classes[proxy.class]?.sites, 1);
    assert.equal(classes[proxy.class]?.cascades, 0);
    assert.equal(classes[cascade.class]?.example, cascade.message);
    assert.equal(classes[cascade.class]?.cascades, 1);
    for (const refusal of report.refusals) assert.equal(refusal.occurrences, 1);
});

test("a refused value return is the calling statement's refusal", () => {
    // `pick` refuses inside its return; the survey must not hand `chosen` a
    // hole, so each declaration that calls it refuses at the one site inside
    // `pick`, and the reads reach that site again through the initializers.
    const { report } = surveySource(`
        function pick(name: string): number {
            const raw = new URLSearchParams(location.search).get(name);
            return raw !== null ? 1 : 0;
        }
        const chosen = pick("mode");
        const other = pick("other");
        localStorage.setItem("chosen", String(chosen + 1));
        localStorage.setItem("other", String(other + 1));
    `, { fileName: resolve("survey-return.ts") });
    assert.equal(report.complete, true);
    assert.equal(report.refusals.length, 1, listed(report));
    const [declaration] = report.refusals;
    assert.ok(declaration);
    assert.equal(declaration.statement.line, 6);
    assert.equal(declaration.statement.kind, "VariableStatement");
    assert.equal(declaration.site.line, 4);
    assert.equal(declaration.occurrences, 4);
    assert.equal(declaration.statements, 4);
    assert.equal(declaration.cascade, undefined);
    assert.deepEqual(report.statements, { attempted: 4, refused: 4 });
});

test("refusal classes elide names, numbers and parenthesised detail", () => {
    assert.equal(refusalClass("Unknown or unsupported variable 'p'."), "Unknown or unsupported variable '…'.");
    assert.equal(refusalClass("Expected 1 arguments, received 0."), "Expected N arguments, received N.");
    assert.equal(refusalClass("Static record has no property '__hook' (fields: none; getters: none; class: none)."),
        "Static record has no property '…' (…).");
    assert.equal(refusalClass("Immediate promise catch requires an inline callback."),
        "Immediate promise catch requires an inline callback.");
});

test("an error outside statement lowering ends the survey as incomplete", () => {
    // Built-in environment names refuse before any statement is lowered.
    const { report, result } = surveySource(`localStorage.setItem("mode", import.meta.env.MODE);`,
        { fileName: resolve("survey-terminal.ts"), environment: { DEV: "true" } });
    assert.equal(report.complete, false);
    assert.equal(result, undefined);
    assert.match(report.terminal ?? "", /built-in/);
    assert.deepEqual(report.refusals, []);
});

// The survey is a measurement of generation, never a change to it: scenes
// that generate produce the same bytes under a survey and no census entries,
// which also proves that refusals decided inside speculative probes are the
// probe's and not the survey's.
for (const id of ["scene2", "scene3", "scene240", "regression-compiler-state"]) {
    test(`a survey of ${id} generates identical bytes and records nothing`, () => {
        const scene = getScene(id);
        const options = registrySceneCompileOptions(scene);
        const source = readFileSync(scene.source, "utf8");
        const expected = compileSource(source, options);
        const { report, result } = surveySource(source, options);
        assert.equal(report.complete, true);
        assert.deepEqual(report.refusals, []);
        assert.equal(report.statements.refused, 0);
        assert.ok(report.statements.attempted > 0);
        assert.ok(result);
        assert.equal(result.cpp, expected.cpp);
        assert.equal(result.cmake, expected.cmake);
        assert.deepEqual(result.manifest.features, expected.manifest.features);
    });
}

test("the CLI writes the census in place of a tree and reports completion in its status", t => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-survey-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const entry = join(directory, "entry.ts");
    writeFileSync(entry, refusing);
    const census = join(directory, "out", "census.json");
    // The CLI locates the pinned library from the repository it runs in.
    const runCli = (...extra: string[]) => spawnSync(process.execPath,
        [resolve("dist/src/cli.js"), entry, "--survey", census, ...extra], { encoding: "utf8" });
    const complete = runCli();
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, /Survey: \d+ statement lowerings, 3 refused \(3 sites, 3 classes\)/);
    const report = JSON.parse(readFileSync(census, "utf8"));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.complete, true);
    assert.equal(report.refusals.length, 3);
    assert.equal(existsSync(join(directory, "out", "main.cpp")), false);
    const incomplete = runCli("--env", "DEV=true");
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /Survey incomplete:/);
    assert.equal(JSON.parse(readFileSync(census, "utf8")).complete, false);
});
