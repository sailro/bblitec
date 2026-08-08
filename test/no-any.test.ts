import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";
import ts from "typescript";

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return extname(path) === ".ts" ? [path] : [];
    });
}

test("contains no explicit TypeScript any", () => {
    const violations: string[] = [];
    for (const path of ["src", "test", "examples"].flatMap(sourceFiles)) {
        const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
            if (node.kind === ts.SyntaxKind.AnyKeyword) {
                const position = file.getLineAndCharacterOfPosition(node.getStart(file));
                violations.push(`${path}:${position.line + 1}:${position.character + 1}`);
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
    }
    assert.deepEqual(violations, []);
});
