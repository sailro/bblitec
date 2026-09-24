import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { DoctoredStore } from "./doctored-store.js";

const module = "src/mesh/create-tube.ts";
const anchor = "export const CAP_NONE = 0;";
const probe = `${anchor}
import { LIGHT_ENTRY_FLOATS as ProbeFloats } from "../light/types.js";
export const PROBE_RENAMED = ProbeFloats * 2;
export function probeShadow(): number { const CAP_NONE = 7; return CAP_NONE; }`;

function returned(file: ts.SourceFile): ts.Identifier {
    const shadow = file.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === "probeShadow",
    );
    const last = shadow?.body?.statements.at(-1);
    assert.ok(last && ts.isReturnStatement(last) && last.expression);
    assert.ok(ts.isIdentifier(last.expression));
    return last.expression;
}

test("pinned names resolve through the typed program, not their spelling", () => {
    const context = new LoweringContext(
        new DoctoredStore().withEdits(new Map([[module, [anchor, probe]]])),
    );
    const file = context.sourceFile(module);
    // A renamed import is followed to the constant it names.
    assert.equal(context.pinnedNumber(module, "PROBE_RENAMED"), 32);
    // A local that shadows a module constant is the local.
    const shadowed = returned(file);
    const declaration = context.declarationOf(shadowed);
    assert.ok(declaration && ts.isVariableDeclaration(declaration));
    assert.equal(declaration.initializer?.getText(file), "7");
    assert.equal(context.constantOf(shadowed), undefined);
    assert.throws(
        () => context.numericValue(shadowed, file),
        /Expected numeric constant/,
    );
    // The checker types pinned nodes too.
    assert.equal(
        context.program.checker.typeToString(context.program.typeOf(shadowed)),
        "7",
    );
});

test("a module served again as another tree resolves in an overlay of the program", () => {
    class FreshStore extends UpstreamSourceStore {
        public override getSourceFile(path: string): ts.SourceFile {
            return path === module
                ? ts.createSourceFile(
                      path,
                      super.getSource(path).replace(anchor, probe),
                      ts.ScriptTarget.Latest,
                      true,
                  )
                : super.getSourceFile(path);
        }
    }
    const context = new LoweringContext(new FreshStore());
    const first = context.sourceFile(module);
    const second = context.sourceFile(module);
    assert.notEqual(first, second);
    for (const file of [first, second]) {
        const renamed = file.statements
            .flatMap((statement) =>
                ts.isVariableStatement(statement)
                    ? [...statement.declarationList.declarations]
                    : [],
            )
            .find(
                (declaration) =>
                    declaration.name.getText(file) === "PROBE_RENAMED",
            );
        assert.ok(renamed?.initializer);
        assert.equal(context.numericValue(renamed.initializer, file), 32);
    }
    assert.notEqual(
        context.program.checkerFor(first),
        context.program.checkerFor(second),
    );
});

test("a node of no pinned module refuses", () => {
    const file = ts.createSourceFile(
        "src/mesh/create-tube.ts",
        "const CAP_NONE = 1; CAP_NONE;",
        ts.ScriptTarget.Latest,
        true,
    );
    const statement = file.statements[1];
    assert.ok(statement && ts.isExpressionStatement(statement));
    assert.ok(ts.isIdentifier(statement.expression));
    const context = new LoweringContext();
    // Unowned by any store, the file resolves only its own names.
    assert.equal(context.numericValue(statement.expression, file), 1);
    const outside = ts.createSourceFile(
        "src/no-such-module.ts",
        "export const A = 1;",
        ts.ScriptTarget.Latest,
        true,
    );
    assert.throws(
        () => context.program.checkerFor(outside),
        /not part of the typed pinned program/,
    );
});
