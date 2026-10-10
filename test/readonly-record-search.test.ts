import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { ClassHierarchy } from "../src/compiler/class-members.js";
import { DataTypeRegistry } from "../src/compiler/data-types.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("readonly tuple storage preserves heterogeneous lanes and own-key distinctions", () => {
    const frontend = createCompilerProgram(
        `type Mixed = readonly [number, {value:number}, string];
         type Distinct = readonly [{left:number}, {right:string}];
         type Empty = readonly [{left:null}, {right:string}];`,
        resolve("readonly-tuple-storage.ts"),
    );
    const registry = new DataTypeRegistry(
        frontend.checker,
        (_node, message) => {
            throw new Error(message);
        },
        new ClassHierarchy(frontend.checker, frontend.program),
    );
    const mapped = frontend.sourceFile.statements.map((node) => {
        assert.ok(ts.isTypeAliasDeclaration(node));
        return registry.fromStoredTsType(
            frontend.checker.getTypeAtLocation(node.name),
            node,
        );
    });
    const [mixed, distinct, empty] = mapped;
    assert.ok(mixed?.kind === "vector");
    assert.ok(mixed.element.kind === "optional");
    assert.ok(mixed.element.inner.kind === "union");
    assert.deepEqual(
        mixed.element.inner.members.map((member) => member.kind).sort(),
        ["number", "string", "struct"],
    );
    assert.ok(distinct?.kind === "vector");
    assert.ok(distinct.element.kind === "struct");
    const fields = registry.structFields(
        distinct.element.name,
        frontend.sourceFile,
        "accessors",
    );
    assert.deepEqual(
        fields.map((field) => field.sourceName),
        ["left", "right"],
    );
    for (const field of fields)
        assert.equal(
            registry.ownPropertyPresence(distinct.element.name, field),
            "stored",
        );
    // A lane whose field is only null keeps its own struct, holding null.
    assert.ok(empty?.kind === "vector");
    assert.ok(empty.element.kind === "optional");
    assert.ok(empty.element.inner.kind === "union");
    assert.deepEqual(
        empty.element.inner.members.map((member) =>
            member.kind === "struct"
                ? registry
                      .structFields(
                          member.name,
                          frontend.sourceFile,
                          "accessors",
                      )
                      .map((field) => `${field.sourceName}:${field.type.kind}`)
                : [member.kind],
        ),
        [["left:null"], ["right:string"]],
    );
});

test("readonly record tuple searches retain nullable fields and short-circuiting", (t) => {
    const result = compileSource(`
        interface Route { id: string; gate: string | null; cost: number; }
        const routes = [
            {id: "local", gate: null, cost: 2},
            {id: "express", gate: "ticket", cost: 5},
            {id: "night", gate: "pass", cost: 8},
        ] as const satisfies readonly Route[];
        type RouteId = (typeof routes)[number]["id"];
        function route(id: RouteId): (typeof routes)[number] {
            return routes.find(candidate => candidate.id === id) ?? routes[0];
        }
        let calls = 0;
        const wanted: string = Math.random() < 2 ? "express" : "absent";
        const found = routes.find((candidate, index, array) => {
            calls++;
            return candidate.id === wanted && index === 1 && array.length === 3;
        });
        if (!found || found.cost !== 5 || found.gate !== "ticket" || calls !== 2) throw new Error("search result and order");
        const missingId: string = Math.random() < 2 ? "absent" : "unknown";
        const missing = routes.find(candidate => candidate.id === missingId);
        if (missing !== undefined || route("local").gate !== null) throw new Error("absence and nullable fields");
        if (route("night").cost !== 8) throw new Error("runtime helper lookup");
        if (routes.some(candidate => candidate.gate === missingId || missingId === candidate.gate)) throw new Error("unknown optional tag");
        function available(entry: Pick<Route, "gate">, allow: (gate: string) => boolean): boolean {
            return entry.gate === null || allow(entry.gate);
        }
        if (!available(route("express"), gate => gate === "ticket") ||
            !available(route("local"), () => false)) throw new Error("narrowed nullable tag callback");
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/readonly-record-search");
    mkdirSync(directory, { recursive: true });
    const cpp = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        cpp,
    ]);
    assert.equal(
        execFileSync(executable, {
            encoding: "utf8",
            timeout: 10000,
            stdio: "pipe",
        }),
        "",
    );
});
