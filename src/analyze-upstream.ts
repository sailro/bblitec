#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { analyzeUpstreamGraph } from "./upstream-graph.js";
import { UpstreamSourceStore } from "./upstream-source.js";

function entryImports(path: string): string[] {
    const source = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const result: string[] = [];
    for (const statement of file.statements) {
        if (
            ts.isImportDeclaration(statement) &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            (statement.moduleSpecifier.text === "babylon-lite" || statement.moduleSpecifier.text === "@babylonjs/lite") &&
            statement.importClause?.namedBindings &&
            ts.isNamedImports(statement.importClause.namedBindings)
        ) {
            for (const element of statement.importClause.namedBindings.elements) {
                if (!element.isTypeOnly) result.push(element.propertyName?.text ?? element.name.text);
            }
        }
    }
    return result;
}

const entry = resolve(process.argv[2] ?? "examples/boombox.ts");
const output = resolve(process.argv[3] ?? "generated/boombox/upstream-graph.json");
const store = new UpstreamSourceStore();
const graph = analyzeUpstreamGraph(store, entryImports(entry));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(graph, null, 2)}\n`);

console.log(`Upstream: ${graph.package.name}@${graph.package.version} (${graph.package.sourceVersion})`);
console.log(`Roots: ${graph.roots.map((root) => root.exportName).join(", ")}`);
console.log(
    `Reachable modules: ${graph.summary.moduleCount}, source: ${Math.round(graph.summary.sourceBytes / 1024)} KiB, ` +
        `runtime edges: ${graph.summary.runtimeEdges}, dynamic edges: ${graph.summary.dynamicEdges}`,
);
console.log(
    `Unsupported pressure: async=${graph.summary.diagnostics.asyncFunctions}, ` +
        `await=${graph.summary.diagnostics.awaitExpressions}, closures=${graph.summary.diagnostics.closures}, ` +
        `classes=${graph.summary.diagnostics.classes}, defineProperty=${graph.summary.diagnostics.objectDefineProperty}`,
);
console.log(`PAL references: ${graph.summary.diagnostics.platformReferences.join(", ") || "none"}`);
console.log(`Report: ${output}`);
