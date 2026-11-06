import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { pinnedBuildConditions } from "./compiler-node-flags.js";
import {
    choosesOperand,
    conditionalExpression,
    declarationNamed,
    equalityOperator,
    hasExportModifier,
    isBlockScopedVariable,
    isGroupingParentheses,
    isValueReference,
    jsonScalarLiteral,
    type JsonScalar,
    notJson,
    operandYield,
    selectionArms,
    specifierSourceName,
    type ValueClass,
    variableKind,
} from "./compiler/syntax.js";
import { applyTextEdits, type TextEdit } from "./text-edits.js";
import { isPackageImportSpecifier } from "./typescript-module-specifiers.js";

/**
 * The bundler conditions a program is built under, and what they decide in
 * the pin.
 *
 * The pin's package resolves its private `#` imports per bundler condition
 * (`package.json` `imports`): `#coordinate-system` names the left-handed
 * constants by default and the right-handed ones under `babylon-lite-rh`.
 * An application's bundler selects one target, inlines the constants it
 * exports and folds every test of them. The compiler is that bundler: an
 * executed pinned module imports the target the conditions select
 * (`packageImportTarget`), and the TypeScript the compiler reads has those
 * constants folded as the bundler folds them
 * (`foldPackageImportConstants`), so a left-handed program reads the pin's
 * left-handed bodies.
 *
 * The conditions are the process's (`pinnedBuildConditions`): one
 * compilation builds one program, and every pinned read caches the text
 * the conditions decided.
 */

/** Vite's production client conditions, which every lab bundle resolves under. */
const CLIENT_CONDITIONS = ["import", "module", "browser", "production"];

type ImportTarget =
    string | null | { readonly [condition: string]: ImportTarget };

const packageImports = new Map<
    string,
    Readonly<Record<string, ImportTarget>>
>();

function importsOf(
    packageRoot: string,
): Readonly<Record<string, ImportTarget>> {
    let imports = packageImports.get(packageRoot);
    if (!imports) {
        const metadata = JSON.parse(
            readFileSync(join(packageRoot, "package.json"), "utf8"),
        ) as { imports?: Record<string, ImportTarget> };
        imports = metadata.imports ?? {};
        packageImports.set(packageRoot, imports);
    }
    return imports;
}

/** Every `#` import the package declares, with the target the conditions select. */
export function packageImportTargets(
    packageRoot: string,
    conditions: readonly string[] = pinnedBuildConditions(),
): ReadonlyMap<string, string> {
    return new Map(
        Object.keys(importsOf(packageRoot)).map((specifier) => [
            specifier,
            packageImportTarget(packageRoot, specifier, conditions),
        ]),
    );
}

/**
 * The package-relative path (`./lib/...`) a `#` import resolves to under
 * the active conditions, or a refusal naming the specifier.
 */
export function packageImportTarget(
    packageRoot: string,
    specifier: string,
    conditions: readonly string[] = pinnedBuildConditions(),
): string {
    const imports = importsOf(packageRoot);
    const active = [...CLIENT_CONDITIONS, ...conditions];
    const target = Object.hasOwn(imports, specifier)
        ? selectedTarget(imports[specifier]!, active)
        : undefined;
    if (typeof target !== "string" || !target.startsWith("./"))
        throw new Error(
            `The pinned package resolves no '${specifier}' import under [${active.join(", ")}].`,
        );
    return target;
}

/** Node's conditional target: the first key the build matches, in the object's order. */
function selectedTarget(
    target: ImportTarget,
    active: readonly string[],
): string | null | undefined {
    if (typeof target === "string" || target === null) return target;
    for (const [condition, nested] of Object.entries(target)) {
        if (condition !== "default" && !active.includes(condition)) continue;
        const selected = selectedTarget(nested, active);
        if (selected !== undefined) return selected;
    }
    return undefined;
}

/**
 * A module's exports when it is nothing but constants a bundler inlines
 * (`export const name = <literal>`), else undefined.
 */
export function literalConstantExports(
    file: ts.SourceFile,
): ReadonlyMap<string, JsonScalar> | undefined {
    const constants = new Map<string, JsonScalar>();
    for (const statement of file.statements) {
        if (
            !ts.isVariableStatement(statement) ||
            variableKind(statement.declarationList) !== "const" ||
            !hasExportModifier(statement)
        )
            return undefined;
        for (const declaration of statement.declarationList.declarations) {
            const value = declaration.initializer
                ? literalConstant(declaration.initializer)
                : undefined;
            if (!ts.isIdentifier(declaration.name) || value === undefined)
                return undefined;
            constants.set(declaration.name.text, value.value);
        }
    }
    return constants;
}

function literalConstant(
    node: ts.Expression,
): { value: JsonScalar } | undefined {
    const value = jsonScalarLiteral(node);
    return value === notJson ? undefined : { value };
}

interface Folded {
    value: JsonScalar;
    /** Whether an imported constant decided the value. */
    imported: boolean;
}

/**
 * Module text with every binding imported from a constants module folded
 * the way a bundler folds an inlined constant: a test the constants decide
 * keeps only the branch they select (an `if`, a conditional, `&&`, `||`, an
 * object spread of a falsy value), any other read becomes the literal, and
 * the import goes. Only tests an imported constant decides fold, so the
 * pin's own literal tests read as written. A construct the fold cannot
 * keep whole refuses rather than reading as the other variant.
 */
export function foldPackageImportConstants(
    text: string,
    fileName: string,
    constantsOf: (
        specifier: string,
    ) => ReadonlyMap<string, JsonScalar> | undefined,
): string {
    if (!/\bfrom\s*["']#/.test(text)) return text;
    const file = ts.createSourceFile(
        fileName,
        text,
        ts.ScriptTarget.Latest,
        true,
        fileName.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const bound = new Map<string, JsonScalar>();
    const imports: ts.ImportDeclaration[] = [];
    for (const statement of file.statements) {
        if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier) ||
            !isPackageImportSpecifier(statement.moduleSpecifier.text)
        )
            continue;
        const constants = constantsOf(statement.moduleSpecifier.text);
        if (!constants) continue;
        const clause = statement.importClause;
        const named = clause?.namedBindings;
        if (!clause || clause.name || !named || !ts.isNamedImports(named))
            throw refusal(
                file,
                statement,
                "imports a constants module other than by name",
            );
        for (const element of named.elements) {
            const name = specifierSourceName(element);
            if (!constants.has(name))
                throw refusal(
                    file,
                    element,
                    `imports '${name}', which the constants module does not export`,
                );
            bound.set(element.name.text, constants.get(name)!);
        }
        imports.push(statement);
    }
    if (bound.size === 0) return text;
    return new ConstantFold(
        file,
        bound,
        imports,
        boundReferences(file, bound, imports),
    ).text();
}

function refusal(file: ts.SourceFile, node: ts.Node, reason: string): Error {
    const { line, character } = file.getLineAndCharacterOfPosition(
        node.getStart(file),
    );
    return new Error(
        `${file.fileName}:${line + 1}:${character + 1}: the build-constant fold ${reason}.`,
    );
}

/**
 * Where the module names an imported constant outside its imports, in
 * source order: every fold sits around one of them. A local declaration
 * reusing the name would fold a different binding, so it refuses.
 */
function boundReferences(
    file: ts.SourceFile,
    bound: ReadonlyMap<string, JsonScalar>,
    imports: readonly ts.ImportDeclaration[],
): number[] {
    const positions: number[] = [];
    const visit = (node: ts.Node): void => {
        if (imports.includes(node as ts.ImportDeclaration)) return;
        if (ts.isIdentifier(node) && bound.has(node.text)) {
            if (declarationNamed(node) !== undefined)
                throw refusal(
                    file,
                    node,
                    `meets a local '${node.text}' shadowing the imported constant`,
                );
            positions.push(node.end);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return positions;
}

const STATEMENT_LISTS = new Set([
    ts.SyntaxKind.Block,
    ts.SyntaxKind.SourceFile,
    ts.SyntaxKind.CaseClause,
    ts.SyntaxKind.DefaultClause,
    ts.SyntaxKind.ModuleBlock,
]);

class ConstantFold {
    private readonly source: string;

    public constructor(
        private readonly file: ts.SourceFile,
        private readonly bound: ReadonlyMap<string, JsonScalar>,
        private readonly imports: readonly ts.ImportDeclaration[],
        /** The ends of the module's names of its constants, ascending. */
        private readonly references: readonly number[],
    ) {
        this.source = file.text;
    }

    public text(): string {
        const edits = [
            ...this.imports.map((statement) => this.removal(statement)),
            ...this.file.statements.flatMap((statement) =>
                this.imports.includes(statement as ts.ImportDeclaration)
                    ? []
                    : this.editsIn(statement),
            ),
        ];
        return applyTextEdits(this.source, edits);
    }

    /** Whether a node names an imported constant: a node that does not folds nothing. */
    private mentionsConstant(node: ts.Node): boolean {
        let low = 0;
        let high = this.references.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (this.references[middle]! <= node.pos) low = middle + 1;
            else high = middle;
        }
        return (
            low < this.references.length && this.references[low]! <= node.end
        );
    }

    /** The edits inside a node: its own when it folds, else its children's. */
    private editsIn(node: ts.Node): TextEdit[] {
        if (!this.mentionsConstant(node)) return [];
        const own = this.editOf(node);
        if (own) return [own];
        const edits: TextEdit[] = [];
        ts.forEachChild(node, (child) => {
            edits.push(...this.editsIn(child));
        });
        return edits;
    }

    /** The source in `[start, end)` with `edits` inside it applied. */
    private spliced(
        start: number,
        end: number,
        edits: readonly TextEdit[],
    ): string {
        return applyTextEdits(
            this.source.slice(start, end),
            edits.map((edit) => ({
                ...edit,
                start: edit.start - start,
                end: edit.end - start,
            })),
        );
    }

    /** A node's text with its folds applied, its own included. */
    private rendered(node: ts.Node): string {
        return this.spliced(
            node.getStart(this.file),
            node.getEnd(),
            this.editsIn(node),
        );
    }

    private constant(node: ts.Expression): Folded | undefined {
        if (isGroupingParentheses(node)) return this.constant(node.expression);
        if (ts.isIdentifier(node)) {
            return this.bound.has(node.text) && isValueReference(node)
                ? { value: this.bound.get(node.text)!, imported: true }
                : undefined;
        }
        const literal = literalConstant(node);
        if (literal) return { value: literal.value, imported: false };
        if (
            ts.isPrefixUnaryExpression(node) &&
            node.operator === ts.SyntaxKind.ExclamationToken
        ) {
            const operand = this.constant(node.operand);
            return (
                operand && { value: !operand.value, imported: operand.imported }
            );
        }
        const selected = this.selectedOperand(node);
        if (selected) {
            if (typeof selected.kept === "string") return selected.decider;
            const kept = this.constant(selected.kept);
            return (
                kept && {
                    value: kept.value,
                    imported: selected.decider.imported || kept.imported,
                }
            );
        }
        if (!ts.isBinaryExpression(node)) return undefined;
        const equality = equalityOperator(node.operatorToken.kind);
        const left = equality && this.constant(node.left);
        const right = left && this.constant(node.right);
        if (!equality || !left || !right) return undefined;
        const equal = equality.loose
            ? left.value == right.value
            : left.value === right.value;
        return {
            value: equality.negated ? !equal : equal,
            imported: left.imported || right.imported,
        };
    }

    /**
     * The operand a selection (`?:`, `&&`, `||`, `??`) yields once a
     * constant decides it, with that constant: the selected operand, or the
     * deciding operand's own literal when the selection yields it.
     */
    private selectedOperand(
        node: ts.Expression,
    ): { kept: ts.Expression | string; decider: Folded } | undefined {
        const selection = conditionalExpression(node);
        if (selection === node) {
            const decider = this.constant(selection.condition);
            const [whenTrue, whenFalse] = selectionArms(selection);
            return (
                decider && {
                    kept: decider.value ? whenTrue : whenFalse,
                    decider,
                }
            );
        }
        if (!ts.isBinaryExpression(node) || !choosesOperand(node))
            return undefined;
        const decider = this.constant(node.left);
        if (!decider) return undefined;
        return operandYield(node, node.left)!.has(valueClass(decider.value))
            ? { kept: constantText(decider.value), decider }
            : { kept: node.right, decider };
    }

    private editOf(node: ts.Node): TextEdit | undefined {
        if (ts.isIfStatement(node)) {
            const condition = this.constant(node.expression);
            return condition?.imported
                ? this.foldedIf(node, Boolean(condition.value))
                : undefined;
        }
        if (ts.isSpreadAssignment(node)) {
            const spread = this.constant(node.expression);
            if (!spread?.imported) return undefined;
            if (typeof spread.value === "string" && spread.value !== "")
                throw refusal(this.file, node, "spreads a string constant");
            return this.listElementRemoval(node);
        }
        if (
            ts.isShorthandPropertyAssignment(node) &&
            this.bound.has(node.name.text)
        )
            return this.replacement(
                node,
                `${node.name.text}: ${constantText(this.bound.get(node.name.text)!)}`,
            );
        if (!ts.isExpression(node)) return undefined;
        // The fold takes the place of the outermost parentheses around what
        // it folds, so a kept operand reads as the source spells it there.
        if (
            ts.isIdentifier(node) &&
            this.bound.has(node.text) &&
            ts.isExportSpecifier(node.parent)
        )
            throw refusal(this.file, node, "meets a re-exported constant");
        const kept = this.keptOperand(skipParentheses(node));
        if (kept === undefined) return undefined;
        if (typeof kept === "string") return this.replacement(node, kept);
        const text = this.rendered(kept);
        return this.replacement(
            node,
            needsParentheses(node, kept) ? `(${text})` : text,
        );
    }

    /**
     * What a decided expression keeps: the operand a selection yields, or
     * the literal a fully decided expression reads.
     */
    private keptOperand(
        node: ts.Expression,
    ): ts.Expression | string | undefined {
        const selected = this.selectedOperand(node);
        if (selected?.decider.imported) return selected.kept;
        const folded = this.constant(node);
        return folded?.imported ? constantText(folded.value) : undefined;
    }

    private replacement(node: ts.Node, text: string): TextEdit {
        return { start: node.getStart(this.file), end: node.getEnd(), text };
    }

    /** An `if` whose test the constants decide, kept as its selected branch. */
    private foldedIf(node: ts.IfStatement, truthy: boolean): TextEdit {
        const chosen = truthy ? node.thenStatement : node.elseStatement;
        const parent = node.parent;
        if (STATEMENT_LISTS.has(parent.kind)) {
            if (!chosen) return this.removal(node);
            if (ts.isBlock(chosen) && !declaresLexically(chosen)) {
                const span = this.lineSpan(
                    node.getStart(this.file),
                    node.getEnd(),
                );
                return {
                    ...span,
                    text: this.unwrappedBlock(chosen, span.start, span.whole),
                };
            }
            return this.replacement(node, this.rendered(chosen));
        }
        if (ts.isIfStatement(parent) && parent.elseStatement === node)
            return chosen
                ? this.replacement(node, this.rendered(chosen))
                : {
                      start: parent.thenStatement.getEnd(),
                      end: node.getEnd(),
                      text: "",
                  };
        throw refusal(
            this.file,
            node,
            "meets a decided test outside a statement list",
        );
    }

    /**
     * A block's statements in place of the statement holding it, dedented
     * to that statement's own indentation when it stood on its own lines.
     */
    private unwrappedBlock(
        block: ts.Block,
        lineStart: number,
        whole: boolean,
    ): string {
        const edits = block.statements.flatMap((statement) =>
            this.editsIn(statement),
        );
        const inner = this.spliced(
            block.getStart(this.file) + 1,
            block.getEnd() - 1,
            edits,
        );
        const lines = inner.split("\n");
        while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
        while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
        if (lines.length === 0) return "";
        if (!whole) return lines.map((line) => line.trim()).join(" ");
        const indentation = (line: string): number =>
            line.length - line.trimStart().length;
        const own = indentation(
            this.source.slice(lineStart, this.source.indexOf("\n", lineStart)),
        );
        const inset =
            Math.min(
                ...lines.filter((line) => line.trim() !== "").map(indentation),
            ) - own;
        return (
            lines
                .map((line) =>
                    inset > 0 && indentation(line) >= inset
                        ? line.slice(inset)
                        : line,
                )
                .join("\n") + "\n"
        );
    }

    /** A statement deleted with its own lines and the comments directly above it. */
    private removal(node: ts.Node): TextEdit {
        let start = node.getStart(this.file);
        for (const comment of (
            ts.getLeadingCommentRanges(this.source, node.getFullStart()) ?? []
        ).reverse()) {
            const between = this.source.slice(comment.end, start);
            const ownLine =
                this.source
                    .slice(this.lineStartOf(comment.pos), comment.pos)
                    .trim() === "";
            if (!ownLine || between.split("\n").length > 2) break;
            start = comment.pos;
        }
        return { ...this.lineSpan(start, node.getEnd()), text: "" };
    }

    private lineStartOf(position: number): number {
        return this.source.lastIndexOf("\n", position - 1) + 1;
    }

    /** A span widened to whole lines when nothing else shares them. */
    private lineSpan(
        start: number,
        end: number,
    ): { start: number; end: number; whole: boolean } {
        const lineStart = this.lineStartOf(start);
        const newline = this.source.indexOf("\n", end);
        const lineEnd = newline < 0 ? this.source.length : newline + 1;
        const whole =
            this.source.slice(lineStart, start).trim() === "" &&
            this.source.slice(end, lineEnd).trim() === "";
        return whole
            ? { start: lineStart, end: lineEnd, whole }
            : { start, end, whole };
    }

    /** An object-literal element deleted with the comma that separates it. */
    private listElementRemoval(node: ts.ObjectLiteralElementLike): TextEdit {
        const list = (node.parent as ts.ObjectLiteralExpression).properties;
        const index = list.indexOf(node);
        const next = list[index + 1];
        if (next)
            return {
                start: node.getStart(this.file),
                end: next.getStart(this.file),
                text: "",
            };
        const previous = list[index - 1];
        return {
            start: previous ? previous.getEnd() : node.getStart(this.file),
            end: list.hasTrailingComma
                ? this.source.indexOf(",", node.getEnd()) + 1
                : node.getEnd(),
            text: "",
        };
    }
}

function constantText(value: JsonScalar): string {
    if (typeof value === "string") return JSON.stringify(value);
    // A negative literal stands as one operand wherever the constant stood.
    if (typeof value === "number" && (value < 0 || Object.is(value, -0)))
        return `(-${String(-value)})`;
    return String(value);
}

/** Whether a block's own statements declare names its enclosing list would gain. */
function declaresLexically(block: ts.Block): boolean {
    return block.statements.some(
        (statement) =>
            (ts.isVariableStatement(statement) &&
                isBlockScopedVariable(statement.declarationList)) ||
            ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement),
    );
}

function skipParentheses(node: ts.Expression): ts.Expression {
    return isGroupingParentheses(node)
        ? skipParentheses(node.expression)
        : node;
}

/** The class of value a constant passes on through a selection. */
function valueClass(value: JsonScalar): ValueClass {
    if (value === null) return "nullish";
    return value ? "truthy" : "falsy";
}

/** Whether `node` is one of the arms a conditional `parent` selects between. */
function isSelectedArm(parent: ts.Node, node: ts.Expression): boolean {
    const selection = ts.isExpression(parent)
        ? conditionalExpression(parent)
        : undefined;
    return selection === parent && selectionArms(selection).includes(node);
}

/** Whether an operand taking a low-precedence expression's place needs parentheses there. */
function needsParentheses(
    node: ts.Expression,
    operand: ts.Expression,
): boolean {
    if (
        ts.isBinaryExpression(operand) &&
        operand.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
        return true;
    if (
        ts.isIdentifier(operand) ||
        ts.isLiteralExpression(operand) ||
        isGroupingParentheses(operand) ||
        ts.isCallExpression(operand) ||
        ts.isPropertyAccessExpression(operand) ||
        ts.isElementAccessExpression(operand) ||
        ts.isNewExpression(operand) ||
        ts.isArrayLiteralExpression(operand) ||
        ts.isTemplateExpression(operand) ||
        operand.kind === ts.SyntaxKind.NullKeyword ||
        operand.kind === ts.SyntaxKind.TrueKeyword ||
        operand.kind === ts.SyntaxKind.FalseKeyword ||
        operand.kind === ts.SyntaxKind.ThisKeyword
    )
        return false;
    const parent = node.parent;
    if (ts.isObjectLiteralExpression(operand))
        return ts.isArrowFunction(parent) || ts.isExpressionStatement(parent);
    return !(
        ts.isVariableDeclaration(parent) ||
        ts.isReturnStatement(parent) ||
        ts.isExpressionStatement(parent) ||
        ts.isCallExpression(parent) ||
        ts.isNewExpression(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        isGroupingParentheses(parent) ||
        isSelectedArm(parent, node) ||
        ts.isSpreadElement(parent) ||
        ts.isSpreadAssignment(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isTemplateSpan(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isParameter(parent) ||
        (ts.isBinaryExpression(parent) &&
            parent.right === node &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    );
}
