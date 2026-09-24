import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import ts from "typescript";
import { listFiles } from "../src/tooling/records.js";

// The plain-JavaScript tools and check plugins import the compiled
// `dist/src` modules, which neither the TypeScript build nor ts-prune sees
// as consumers: a renamed or removed export fails only when someone runs
// the tool. Every name they import must still be exported by the source
// module it compiles from.

const distSource = resolve("dist", "src");

interface ToolImport {
    consumer: string;
    module: string;
    names: string[];
}

/** The `dist/src` module a specifier names, as its `src/*.ts` source. */
function sourceOf(consumer: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const target = resolve(dirname(consumer), specifier);
    if (!target.startsWith(`${distSource}${sep}`)) return undefined;
    return join("src", relative(distSource, target)).replace(/\.js$/, ".ts");
}

function toolImports(consumer: string): ToolImport[] {
    const source = ts.createSourceFile(
        consumer,
        readFileSync(consumer, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    const found: ToolImport[] = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier !== undefined &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            const module = sourceOf(consumer, node.moduleSpecifier.text);
            if (module !== undefined) {
                const bindings = ts.isImportDeclaration(node)
                    ? node.importClause?.namedBindings
                    : node.exportClause;
                const names =
                    bindings !== undefined &&
                    (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
                        ? bindings.elements.map(
                              (element) =>
                                  (element.propertyName ?? element.name).text,
                          )
                        : [];
                found.push({ consumer, module, names });
            }
        }
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] !== undefined &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            const module = sourceOf(consumer, node.arguments[0].text);
            if (module !== undefined) {
                // `const { a, b } = await import("...")`
                const declaration = ts.isAwaitExpression(node.parent)
                    ? node.parent.parent
                    : undefined;
                const names =
                    declaration !== undefined &&
                    ts.isVariableDeclaration(declaration) &&
                    ts.isObjectBindingPattern(declaration.name)
                        ? declaration.name.elements.map((element) =>
                              element.propertyName !== undefined &&
                              ts.isIdentifier(element.propertyName)
                                  ? element.propertyName.text
                                  : ts.isIdentifier(element.name)
                                    ? element.name.text
                                    : "",
                          )
                        : [];
                found.push({ consumer, module, names });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

test("every dist/src name a tool or check plugin imports is exported by its source", () => {
    const consumers = [
        ...listFiles("tools"),
        ...listFiles(join("checks", "plugins")),
    ].filter((file) => /\.(mjs|js)$/.test(file));
    const imports = consumers.flatMap(toolImports);
    assert.ok(imports.length > 20, "the scan finds the tool imports");
    const missingModules = imports
        .filter((entry) => !existsSync(entry.module))
        .map((entry) => `${entry.consumer}: ${entry.module}`);
    assert.deepEqual(missingModules, []);
    const modules = [...new Set(imports.map((entry) => entry.module))];
    const program = ts.createProgram(modules, {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
    });
    const checker = program.getTypeChecker();
    const exportsOf = new Map(
        modules.map((module) => {
            const file = program.getSourceFile(module);
            const symbol =
                file === undefined
                    ? undefined
                    : checker.getSymbolAtLocation(file);
            return [
                module,
                new Set(
                    symbol === undefined
                        ? []
                        : checker
                              .getExportsOfModule(symbol)
                              .map((exported) => exported.name),
                ),
            ] as const;
        }),
    );
    const missingNames = imports.flatMap((entry) =>
        entry.names
            .filter((name) => !exportsOf.get(entry.module)?.has(name))
            .map((name) => `${entry.consumer}: ${name} from ${entry.module}`),
    );
    assert.deepEqual(missingNames, []);
});
