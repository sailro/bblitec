import ts from "typescript";
import { isInstalledPackageFile } from "../typescript-library-files.js";
import {
    aliasTarget,
    calledFunction,
    libraryStaticMember,
    resolvedSymbol,
} from "./symbols.js";
import { valueKindOf } from "./type-facts.js";
import type { EvaluationOrder } from "./evaluation-order.js";

/**
 * The module-level bindings of lazily imported modules that the program can
 * read, as a bundler's tree shaking keeps them: everything a statement that
 * runs names (an evaluated module's or one of the program's own files', and
 * a lazy module's effectful ones), and, transitively, everything a kept
 * declaration names, a function's body included. A namespace a reflective
 * operation reads (a spread, `for...in`, `Object.*`, `JSON.stringify`,
 * `Reflect.*`, a string key only the run time knows) keeps its module's
 * bindings, and an `any` operand there keeps every lazy module's. Any other module `const`/`let` binding an identifier
 * whose initializer has no effect is never evaluated: nothing could observe
 * its value or its absence.
 */
export function readableLazyBindings(
    program: ts.Program,
    checker: ts.TypeChecker,
    evaluationOrder: EvaluationOrder,
    lazy: ReadonlySet<ts.SourceFile>,
    evaluated: ReadonlySet<ts.SourceFile>,
): ReadonlySet<ts.VariableDeclaration> | "all" {
    const key = [...lazy]
        .map((file) => file.fileName)
        .sort()
        .join("\n");
    let byProgram = readable.get(program);
    if (!byProgram)
        readable.set(
            program,
            (byProgram = new Map<
                string,
                ReadonlySet<ts.VariableDeclaration> | "all"
            >()),
        );
    const known = byProgram.get(key);
    if (known) return known;
    const result = computeReadable(
        program,
        checker,
        evaluationOrder,
        lazy,
        evaluated,
    );
    byProgram.set(key, result);
    return result;
}

const readable = new WeakMap<
    ts.Program,
    Map<string, ReadonlySet<ts.VariableDeclaration> | "all">
>();

function computeReadable(
    program: ts.Program,
    checker: ts.TypeChecker,
    evaluationOrder: EvaluationOrder,
    lazy: ReadonlySet<ts.SourceFile>,
    evaluated: ReadonlySet<ts.SourceFile>,
): ReadonlySet<ts.VariableDeclaration> | "all" {
    const kept = new Set<ts.Node>();
    const pending: ts.Node[] = [];
    let everything = false;
    const keep = (declaration: ts.Node): void => {
        if (kept.has(declaration)) return;
        kept.add(declaration);
        pending.push(declaration);
    };
    const moduleDeclaration = (
        symbol: ts.Symbol | undefined,
    ): ts.Node | undefined => {
        for (const declaration of symbol?.declarations ?? []) {
            const statement = ts.isVariableDeclaration(declaration)
                ? declaration.parent.parent
                : declaration;
            if (
                statement.parent !== undefined &&
                ts.isSourceFile(statement.parent) &&
                !statement.parent.isDeclarationFile
            )
                return declaration;
        }
        return undefined;
    };
    /** A reflective read of `operand`: its module's bindings, or every lazy module's. */
    const readsWholesale = (operand: ts.Expression): void => {
        const type = checker.getTypeAtLocation(operand);
        if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
            everything = true;
            return;
        }
        const module = type.symbol?.valueDeclaration;
        if (module && ts.isSourceFile(module) && lazy.has(module))
            for (const statement of module.statements)
                if (ts.isVariableStatement(statement))
                    statement.declarationList.declarations.forEach(keep);
    };
    /** The operands a node reads reflectively, every own property at once. */
    const wholesaleOperands = (node: ts.Node): readonly ts.Expression[] => {
        if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node))
            return [node.expression];
        if (ts.isForInStatement(node)) return [node.expression];
        // A namespace destructured binds what its pattern names, or all.
        if (
            ts.isVariableDeclaration(node) &&
            ts.isObjectBindingPattern(node.name) &&
            node.initializer &&
            (checker.getTypeAtLocation(node.initializer).symbol?.flags ?? 0) &
                ts.SymbolFlags.ValueModule
        )
            return [node.initializer];
        if (
            ts.isElementAccessExpression(node) &&
            !ts.isStringLiteralLike(node.argumentExpression) &&
            // No export is named by a number.
            valueKindOf(checker.getTypeAtLocation(node.argumentExpression)) !==
                "number"
        )
            return [node.expression];
        if (ts.isCallExpression(node)) {
            const callee = libraryStaticMember(checker, node.expression);
            if (
                callee &&
                (callee.owner === "Object" ||
                    callee.owner === "Reflect" ||
                    (callee.owner === "JSON" && callee.name === "stringify"))
            )
                return node.arguments;
        }
        return [];
    };
    const visit = (node: ts.Node): void => {
        if (everything) return;
        if (
            ts.isElementAccessExpression(node) &&
            ts.isStringLiteralLike(node.argumentExpression)
        ) {
            const member = checker
                .getTypeAtLocation(node.expression)
                .getProperty(node.argumentExpression.text);
            const declaration =
                member && moduleDeclaration(aliasTarget(checker, member));
            if (declaration) keep(declaration);
        }
        if (
            ts.isTypeNode(node) ||
            ts.isImportDeclaration(node) ||
            ts.isExportDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node)
        )
            return;
        wholesaleOperands(node).forEach(readsWholesale);
        if (everything) return;
        // A shorthand `{ x }`'s name resolves to the value it reads.
        if (ts.isIdentifier(node)) {
            const declaration = moduleDeclaration(
                resolvedSymbol(checker, node),
            );
            if (declaration) keep(declaration);
        }
        ts.forEachChild(node, visit);
    };
    // A pattern's defaults run where it binds.
    const effectFree = (declaration: ts.VariableDeclaration): boolean =>
        ts.isIdentifier(declaration.name) &&
        (!declaration.initializer ||
            (!evaluationOrder.hasModuleEffects(declaration.initializer) &&
                !evaluationOrder.writesStorage(declaration.initializer) &&
                readsInitialized(declaration.initializer)));
    /**
     * The module-scope `const`/`let`/`var` and class statements a node
     * reads when it runs, through the bodies of the functions it calls (a
     * function it only creates runs nowhere). A body's reads are kept once
     * complete: a body still being read, reached through a cycle, leaves
     * the bodies between it and the call unkept, the outermost keeping
     * them all. Returns the depth of the shallowest open body reached.
     */
    const collectReads = (
        root: ts.Node,
        depth: number,
        statements: Set<ts.Node>,
    ): number => {
        let open = Infinity;
        const read = (node: ts.Node): void => {
            // A function's body runs when it is called, not where it is created.
            if (ts.isFunctionLike(node)) return;
            if (ts.isIdentifier(node))
                for (const declaration of resolvedSymbol(checker, node)
                    ?.declarations ?? []) {
                    const owner = ts.isVariableDeclaration(declaration)
                        ? declaration.parent.parent
                        : declaration;
                    if (
                        (ts.isVariableStatement(owner) ||
                            ts.isClassDeclaration(owner)) &&
                        ts.isSourceFile(owner.parent) &&
                        // A declared global exists before any module runs.
                        !owner.parent.isDeclarationFile
                    )
                        statements.add(owner);
                }
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                const body = calledFunction(checker, node)?.body;
                if (body) {
                    const called = bodyReads(body, depth + 1);
                    for (const statement of called.statements)
                        statements.add(statement);
                    open = Math.min(open, called.open);
                }
            }
            ts.forEachChild(node, read);
        };
        read(root);
        return open;
    };
    const keptReads = new Map<ts.Node, ReadonlySet<ts.Node>>();
    const openReads = new Map<
        ts.Node,
        { depth: number; statements: Set<ts.Node> }
    >();
    const bodyReads = (
        body: ts.Node,
        depth: number,
    ): { statements: ReadonlySet<ts.Node>; open: number } => {
        const kept = keptReads.get(body);
        if (kept) return { statements: kept, open: Infinity };
        const reading = openReads.get(body);
        if (reading)
            return { statements: reading.statements, open: reading.depth };
        const statements = new Set<ts.Node>();
        openReads.set(body, { depth, statements });
        const open = collectReads(body, depth, statements);
        openReads.delete(body);
        if (open < depth) return { statements, open };
        keptReads.set(body, statements);
        return { statements, open: Infinity };
    };
    /**
     * Whether evaluating `initializer` reads only module bindings that are
     * initialized by then, so it cannot throw a temporal-dead-zone error:
     * function declarations, an evaluated module's bindings and those its
     * own module declares before it, through the functions it calls.
     */
    const readsInitialized = (initializer: ts.Expression): boolean => {
        const statement = ts.findAncestor(initializer, ts.isVariableStatement)!;
        const file = statement.getSourceFile();
        const reads = new Set<ts.Node>();
        collectReads(initializer, 0, reads);
        for (const owner of reads) {
            const module = owner.getSourceFile();
            if (!(
                (evaluated.has(module) && !lazy.has(module)) ||
                (module === file && owner.end <= statement.pos)
            ))
                return false;
        }
        return true;
    };
    // What runs: the statements of every module that evaluates (a package
    // module nothing evaluates runs none), a lazy module's bindings with
    // effects and every other evaluated module's bindings; a function, in
    // any module, runs only where something names it.
    for (const file of program.getSourceFiles()) {
        if (
            file.isDeclarationFile ||
            !(
                lazy.has(file) ||
                evaluated.has(file) ||
                !isInstalledPackageFile(file.fileName)
            )
        )
            continue;
        for (const statement of file.statements) {
            if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList
                    .declarations)
                    if (!lazy.has(file) || !effectFree(declaration))
                        keep(declaration);
            } else if (
                !ts.isFunctionDeclaration(statement) &&
                !ts.isImportDeclaration(statement) &&
                !ts.isExportDeclaration(statement)
            )
                visit(statement);
        }
    }
    while (pending.length && !everything) visit(pending.pop()!);
    if (everything) return "all";
    return new Set(
        [...kept].filter((node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node),
        ),
    );
}
