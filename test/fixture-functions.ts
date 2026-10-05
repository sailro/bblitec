import assert from "node:assert/strict";

import ts from "typescript";

import { createCompilerProgram } from "../src/compiler/program.js";

/**
 * Top-level function declarations of the modules an entry imports, found by
 * module path suffix and name through a real program, so the checker
 * resolves them exactly as a compilation would.
 */
export function loadedFunctions(
    entrySource: string,
    entryFile: string,
): {
    checker: ts.TypeChecker;
    declaration(
        this: void,
        moduleSuffix: string,
        name: string,
    ): ts.FunctionDeclaration;
} {
    const frontend = createCompilerProgram(entrySource, entryFile);
    return {
        checker: frontend.checker,
        declaration(this: void, moduleSuffix, name) {
            const source = frontend.program
                .getSourceFiles()
                .find((candidate) => candidate.fileName.endsWith(moduleSuffix));
            assert.ok(source, `module ${moduleSuffix} was not loaded`);
            const found = source.statements.find(
                (statement): statement is ts.FunctionDeclaration =>
                    ts.isFunctionDeclaration(statement) &&
                    statement.name?.text === name,
            );
            assert.ok(
                found,
                `function ${name} was not found in ${moduleSuffix}`,
            );
            return found;
        },
    };
}
