import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource, surveySource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { EmissionTransaction } from "../src/compiler/emission-transaction.js";
import { CompileError } from "../src/compiler/compile-error.js";
import {
    SourceCoverage,
    SourceSiteRegistry,
    coverSourceRealm,
    coverSourceStatement,
} from "../src/compiler/source-coverage.js";
import { jsonArray, jsonObject } from "./json.js";

test("source coverage preserves output and distinguishes unvisited source from lowered statements", () => {
    const source = `
        let count = 0;
        function used(value: number): void { count += value; }
        function unused(): void { const item = new Proxy({}, {}); }
        used(2);
        if (false) { count += 100; }
        localStorage.setItem("count", String(count));
    `;
    const options = { fileName: resolve("coverage-entry.ts") };
    const normal = compileSource(source, options);
    const collector = new SourceCoverage();
    assert.deepEqual(
        collector.run(() => compileSource(source, options)),
        normal,
    );
    const report = collector.report();
    assert.equal(report.measure, "statement-lowering");
    assert.equal(report.realms.length, 1);
    const realm = report.realms[0]!;
    assert.equal(realm.complete, true);
    assert.ok(realm.sites.some((site) => site.owner?.name === "used"));
    assert.ok(realm.sites.every((site) => site.owner?.name !== "unused"));
    assert.ok(
        realm.sites.every(
            (site) => source.slice(site.start, site.end) !== "count += 100;",
        ),
    );
    assert.ok(realm.sites.every((site) => site.state === "lowered"));
    assert.equal(
        realm.files.find((file) => file.file === options.fileName)?.sha256,
        createHash("sha256").update(source).digest("hex"),
    );
});

test("survey coverage exposes refused and incomplete containing statements", () => {
    const source = `
        let count = 0;
        if (Date.now() > 0) {
            const item = new Proxy({}, {});
            count += 1;
        }
        localStorage.setItem("count", String(count));
    `;
    const collector = new SourceCoverage();
    const outcome = collector.run(() =>
        surveySource(source, { fileName: resolve("coverage-survey.ts") }),
    );
    assert.equal(outcome.report.complete, true);
    assert.ok(outcome.report.refusals.length > 0);
    const realm = collector.report().realms[0]!;
    assert.equal(
        realm.complete,
        false,
        "finishing a census is not successful lowering",
    );
    assert.ok(
        realm.sites.some(
            (site) =>
                site.state === "refused" &&
                source.slice(site.start, site.end).includes("new Proxy"),
        ),
    );
    assert.ok(
        realm.sites.some(
            (site) => site.kind === "IfStatement" && site.state === "partial",
        ),
    );
    assert.ok(
        realm.sites.some(
            (site) =>
                source.slice(site.start, site.end).startsWith("localStorage") &&
                site.state === "lowered",
        ),
    );
});

test("coverage honors transactions, failed probes, realm replay and nested collectors", () => {
    const frontend = createCompilerProgram(
        "let first = 1; let second = 2; let third = 3;",
        resolve("coverage-transactions.ts"),
    );
    const [first, second, third] = frontend.sourceFile.statements;
    assert.ok(first && second && third);
    const collector = new SourceCoverage();
    const nested = new SourceCoverage();
    const fail = () => {
        throw new CompileError(
            frontend.sourceFile.fileName,
            1,
            1,
            "unsupported fixture",
        );
    };
    collector.run(() => {
        assert.throws(() =>
            coverSourceRealm(
                frontend.program,
                "coverage-transactions.ts",
                () => {
                    coverSourceStatement(third, false, () => {});
                    throw new Error("storage replay");
                },
            ),
        );
        coverSourceRealm(frontend.program, "coverage-transactions.ts", () => {
            coverSourceStatement(first, false, () => {});
            new EmissionTransaction().run(
                () => {
                    coverSourceStatement(second, false, () => {});
                    return false;
                },
                (accepted) => accepted,
            );
            assert.throws(() =>
                new EmissionTransaction().run(
                    () => {
                        coverSourceStatement(third, true, fail);
                    },
                    () => true,
                ),
            );
            nested.run(() =>
                coverSourceRealm(frontend.program, "nested.ts", () => {
                    coverSourceStatement(third, false, () => {});
                }),
            );
            coverSourceStatement(first, false, () => {});
        });
        coverSourceRealm(frontend.program, "worker.ts", () => {
            coverSourceStatement(third, false, () => {});
        });
    });
    const report = collector.report();
    assert.equal(report.realms.length, 2);
    const main = report.realms[0]!;
    assert.equal(main.complete, true);
    assert.deepEqual(
        main.sites.map((site) => [site.state, site.attempts]),
        [
            ["lowered", 2],
            ["rolled-back", 1],
        ],
    );
    assert.equal(nested.report().realms[0]?.entry, resolve("nested.ts"));
    assert.equal(report.realms[1]?.entry, resolve("worker.ts"));
});

test("source identities distinguish nested calls sharing a start and preserve original nodes", () => {
    const file = ts.createSourceFile(
        "coverage-spans.ts",
        "first().second();",
        ts.ScriptTarget.Latest,
        true,
    );
    const statement = file.statements[0];
    assert.ok(statement && ts.isExpressionStatement(statement));
    const outer = statement.expression;
    assert.ok(
        ts.isCallExpression(outer) &&
            ts.isPropertyAccessExpression(outer.expression),
    );
    const inner = outer.expression.expression;
    assert.ok(ts.isCallExpression(inner));
    const registry = new SourceSiteRegistry();
    const outerSite = registry.site(outer);
    const innerSite = registry.site(inner);
    assert.equal(outerSite.start, innerSite.start);
    assert.notEqual(outerSite.end, innerSite.end);
    const synthetic = ts.setOriginalNode(
        ts.factory.createExpressionStatement(inner),
        statement,
    );
    assert.deepEqual(registry.site(synthetic), registry.site(statement));
});

test("CLI writes coverage on a strict compile refusal without producing a buildable program", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-coverage-"));
    const input = join(directory, "entry.ts");
    const output = join(directory, "coverage.json");
    writeFileSync(
        input,
        `let value = 1; const missing = new Proxy({}, {}); value++;`,
    );
    const result = spawnSync(
        process.execPath,
        [
            resolve("dist/src/cli.js"),
            input,
            "--out",
            join(directory, "generated"),
            "--coverage",
            output,
        ],
        {
            encoding: "utf8",
            env: { ...process.env, BBLITE_DIST_LOCK_HELD: "1" },
            windowsHide: true,
        },
    );
    assert.notEqual(result.status, 0);
    const report = jsonObject(JSON.parse(readFileSync(output, "utf8")));
    assert.equal(report.measure, "statement-lowering");
    const realm = jsonObject(jsonArray(report.realms)[0]);
    assert.equal(realm.complete, false);
    assert.equal(typeof realm.terminal, "string");
    const sites = jsonArray(realm.sites).map(jsonObject);
    assert.ok(sites.some((site) => site.state === "lowered"));
    assert.ok(sites.some((site) => site.state === "refused"));
});
