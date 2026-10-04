import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { EmissionTransaction } from "../src/compiler/emission-transaction.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { sourceTypeRequiresReferenceStorage } from "../src/compiler/storage-demand-index.js";

test("immutable storage proofs retain structural equivalence and survive emission rollback", (t) => {
    const { checker, sourceFile } = createCompilerProgram(
        `interface Stored { x: number; }
        interface Equivalent { x: number; }
        interface Separate { y: string; }
        declare const items: Stored[];`,
        "test/storage-proof.ts",
    );
    const types = sourceFile.statements
        .filter(ts.isInterfaceDeclaration)
        .map((declaration) => checker.getTypeAtLocation(declaration.name));
    const [stored, equivalent, separate] = types;
    assert.ok(stored && equivalent && separate);
    assert.notEqual(stored.symbol, equivalent.symbol);
    const comparisons = t.mock.method(checker, "isTypeAssignableTo");
    new EmissionTransaction().run(() => {
        assert.equal(
            sourceTypeRequiresReferenceStorage(checker, [sourceFile], stored),
            true,
        );
        assert.equal(
            sourceTypeRequiresReferenceStorage(
                checker,
                [sourceFile],
                equivalent,
            ),
            true,
        );
        assert.equal(
            sourceTypeRequiresReferenceStorage(checker, [sourceFile], separate),
            false,
        );
        return false;
    }, Boolean);
    const calls = comparisons.mock.callCount();
    assert.ok(calls > 0);
    for (let repetition = 0; repetition < 10; repetition++) {
        assert.equal(
            sourceTypeRequiresReferenceStorage(
                checker,
                [sourceFile],
                equivalent,
            ),
            true,
        );
        assert.equal(
            sourceTypeRequiresReferenceStorage(checker, [sourceFile], separate),
            false,
        );
    }
    assert.equal(comparisons.mock.callCount(), calls);
    const other = createCompilerProgram(
        "interface Equivalent { x: number; }",
        "test/other-storage-proof.ts",
    );
    const declaration = other.sourceFile.statements[0];
    assert.ok(declaration && ts.isInterfaceDeclaration(declaration));
    assert.equal(
        sourceTypeRequiresReferenceStorage(
            other.checker,
            [other.sourceFile],
            other.checker.getTypeAtLocation(declaration.name),
        ),
        false,
    );
});
