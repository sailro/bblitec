// Definite assignment of one function-scoped binding at a read in its own
// scope, decided from syntax: whether every path from the scope's start to
// the read assigns it. Paths join as JavaScript runs them -- branches,
// short-circuits, loops (a body first runs with the state before it),
// switch fall-through, labeled and loop jumps, try/catch/finally (a catch
// or finally may start before any of the try ran). Code past a jump, a
// return or a throw is unreachable and assigns everything. A statement or
// expression form outside the walk answers with that node, never a guess.
import ts from "typescript";
import { valueSymbolOf } from "./symbols.js";
import {
    guardsOperands,
    isAssignmentExpression,
    operandYield,
    unwrapExpression,
    writeSites,
    type EvaluationContainer,
} from "./syntax.js";

/** Assigned on every path, not, or the form the walk does not follow. */
export type DefiniteAssignment = boolean | { readonly unsupported: ts.Node };

/** Ends the walk at the read. */
class Reached extends Error {
    constructor(readonly assigned: boolean) {
        super("The read is reached.");
    }
}

/** Ends the walk at a form it does not follow. */
class Unsupported extends Error {
    constructor(readonly node: ts.Node) {
        super("The walk does not follow this form.");
    }
}

/** A statement a `break` or `continue` leaves to, with the states they carry. */
interface JumpTarget {
    readonly labels: readonly string[];
    readonly loop: boolean;
    readonly switches: boolean;
    readonly breaks: boolean[];
    readonly continues: boolean[];
}

const every = (states: readonly boolean[]): boolean =>
    states.every((state) => state);

/** Whether `symbol` is assigned on every path from `scope`'s start to `read`. */
export function definitelyAssignedAt(
    checker: ts.TypeChecker,
    scope: EvaluationContainer,
    symbol: ts.Symbol,
    read: ts.Identifier,
): DefiniteAssignment {
    const walk = new AssignmentWalk(checker, symbol, read);
    try {
        walk.scope(scope);
    } catch (end) {
        if (end instanceof Reached) return end.assigned;
        if (end instanceof Unsupported) return { unsupported: end.node };
        throw end;
    }
    return { unsupported: read };
}

class AssignmentWalk {
    private readonly targets: JumpTarget[] = [];

    constructor(
        private readonly checker: ts.TypeChecker,
        private readonly symbol: ts.Symbol,
        private readonly read: ts.Identifier,
    ) {}

    public scope(scope: EvaluationContainer): void {
        if (ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
            this.statements(scope.statements, false);
            return;
        }
        if (ts.isClassStaticBlockDeclaration(scope)) {
            this.statements(scope.body.statements, false);
            return;
        }
        const body = "body" in scope ? scope.body : undefined;
        if (!body || !ts.isBlock(body) || this.contains(scope.parameters))
            throw new Unsupported(scope);
        this.statements(body.statements, false);
    }

    private contains(node: ts.Node | ts.NodeArray<ts.Node>): boolean {
        return (
            this.read.pos >= node.pos &&
            this.read.end <= node.end &&
            (!("kind" in node) ||
                node.getSourceFile() === this.read.getSourceFile())
        );
    }

    private assigns(name: ts.Identifier): boolean {
        return valueSymbolOf(this.checker, name) === this.symbol;
    }

    private statements(list: readonly ts.Statement[], state: boolean): boolean {
        for (const statement of list) state = this.statement(statement, state);
        return state;
    }

    private statement(
        node: ts.Statement,
        state: boolean,
        labels: readonly string[] = [],
    ): boolean {
        if (ts.isBlock(node)) return this.statements(node.statements, state);
        if (ts.isVariableStatement(node))
            return this.declarations(node.declarationList, state);
        if (ts.isExpressionStatement(node))
            return this.expression(node.expression, state);
        if (ts.isIfStatement(node)) {
            const condition = this.expression(node.expression, state);
            const then = this.statement(node.thenStatement, condition);
            return node.elseStatement
                ? then && this.statement(node.elseStatement, condition)
                : then && condition;
        }
        if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
            if (node.expression) this.expression(node.expression, state);
            return true;
        }
        if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
            this.jump(node, state);
            return true;
        }
        if (ts.isLabeledStatement(node)) {
            const named = [...labels, node.label.text];
            if (ts.isIterationStatement(node.statement, false))
                return this.statement(node.statement, state, named);
            if (ts.isLabeledStatement(node.statement))
                return this.statement(node.statement, state, named);
            return this.within(named, false, false, (target) => {
                const end = this.statement(node.statement, state);
                return end && every(target.breaks);
            });
        }
        if (ts.isWhileStatement(node))
            return this.within(labels, true, false, (target) => {
                const condition = this.expression(node.expression, state);
                this.statement(node.statement, condition);
                return isTrue(node.expression)
                    ? every(target.breaks)
                    : condition;
            });
        if (ts.isDoStatement(node))
            return this.within(labels, true, false, (target) => {
                const body = this.statement(node.statement, state);
                const condition = this.expression(
                    node.expression,
                    body && every(target.continues),
                );
                return (
                    (isTrue(node.expression) || condition) &&
                    every(target.breaks)
                );
            });
        if (ts.isForStatement(node))
            return this.within(labels, true, false, (target) => {
                const initializer = node.initializer;
                const start = !initializer
                    ? state
                    : ts.isVariableDeclarationList(initializer)
                      ? this.declarations(initializer, state)
                      : this.expression(initializer, state);
                const condition = node.condition
                    ? this.expression(node.condition, start)
                    : start;
                const body = this.statement(node.statement, condition);
                if (node.incrementor)
                    this.expression(
                        node.incrementor,
                        body && every(target.continues),
                    );
                return !node.condition || isTrue(node.condition)
                    ? every(target.breaks)
                    : condition;
            });
        if (ts.isForInStatement(node) || ts.isForOfStatement(node))
            return this.within(labels, true, false, () => {
                const source = this.expression(node.expression, state);
                const head = node.initializer;
                const each = ts.isVariableDeclarationList(head)
                    ? head.declarations.reduce(
                          (current, declaration) =>
                              this.bindingName(declaration.name, current),
                          source,
                      )
                    : this.loopTarget(node, source);
                this.statement(node.statement, each);
                return source;
            });
        if (ts.isSwitchStatement(node))
            return this.within(labels, false, true, (target) => {
                const subject = this.expression(node.expression, state);
                let previous: boolean | undefined;
                let otherwise = false;
                for (const clause of node.caseBlock.clauses) {
                    if (ts.isCaseClause(clause))
                        this.expression(clause.expression, subject);
                    else otherwise = true;
                    previous = this.statements(
                        clause.statements,
                        previous === undefined ? subject : subject && previous,
                    );
                }
                return (
                    (previous ?? subject) &&
                    (otherwise || subject) &&
                    every(target.breaks)
                );
            });
        if (ts.isTryStatement(node)) {
            const attempted = this.statement(node.tryBlock, state);
            const caught = node.catchClause
                ? attempted && this.statement(node.catchClause.block, state)
                : attempted;
            return node.finallyBlock
                ? caught || this.statement(node.finallyBlock, state)
                : caught;
        }
        if (ts.isExportAssignment(node))
            return this.expression(node.expression, state);
        if (
            ts.isEmptyStatement(node) ||
            ts.isDebuggerStatement(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isImportDeclaration(node) ||
            ts.isImportEqualsDeclaration(node) ||
            ts.isExportDeclaration(node) ||
            ts.isModuleDeclaration(node)
        )
            return state;
        // A class or enum evaluates code of its own at its declaration:
        // the walk leaves its assignments out, and a read inside it.
        if (ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
            if (this.contains(node)) throw new Unsupported(node);
            return state;
        }
        throw new Unsupported(node);
    }

    /** Runs `body` as a jump target; its result is the state after it. */
    private within(
        labels: readonly string[],
        loop: boolean,
        switches: boolean,
        body: (target: JumpTarget) => boolean,
    ): boolean {
        const target: JumpTarget = {
            labels,
            loop,
            switches,
            breaks: [],
            continues: [],
        };
        this.targets.push(target);
        try {
            return body(target);
        } finally {
            this.targets.pop();
        }
    }

    private jump(
        node: ts.BreakStatement | ts.ContinueStatement,
        state: boolean,
    ): void {
        const label = node.label?.text;
        const continues = ts.isContinueStatement(node);
        for (let index = this.targets.length - 1; index >= 0; index--) {
            const target = this.targets[index]!;
            const matches =
                label !== undefined
                    ? target.labels.includes(label)
                    : target.loop || (!continues && target.switches);
            if (!matches) continue;
            if (continues && !target.loop) break;
            (continues ? target.continues : target.breaks).push(state);
            return;
        }
        throw new Unsupported(node);
    }

    private declarations(
        list: ts.VariableDeclarationList,
        state: boolean,
    ): boolean {
        for (const declaration of list.declarations) {
            if (!declaration.initializer) continue;
            state = this.expression(declaration.initializer, state);
            state = this.bindingName(declaration.name, state);
        }
        return state;
    }

    /** A binding name or pattern takes its value: defaults may not run. */
    private bindingName(name: ts.BindingName, state: boolean): boolean {
        if (ts.isIdentifier(name)) return state || this.assigns(name);
        for (const element of name.elements) {
            if (ts.isOmittedExpression(element)) continue;
            if (
                element.propertyName &&
                ts.isComputedPropertyName(element.propertyName)
            )
                state = this.expression(element.propertyName.expression, state);
            if (element.initializer)
                this.expression(element.initializer, state);
            state = this.bindingName(element.name, state);
        }
        return state;
    }

    /** An assignment target takes its value: defaults may not run. */
    /**
     * The state after evaluating `node` in JavaScript's order: its operands
     * in source order, then what it writes. A guarded operand (a choice's
     * branch, a short-circuit's right side, past a `?.`) may not run, and a
     * pattern's defaults may not either.
     */
    private expression(node: ts.Node, state: boolean): boolean {
        if (node === this.read) throw new Reached(state);
        // A function's body does not run here, and no read in it is this scope's.
        if (ts.isFunctionLike(node) || ts.isTypeNode(node)) return state;
        if (ts.isClassLike(node)) {
            if (this.contains(node)) throw new Unsupported(node);
            return state;
        }
        if (guardsOperands(node)) return this.guarded(node, state);
        if (isAssignmentExpression(node)) {
            const pattern = unwrapExpression(node.left);
            if (
                ts.isArrayLiteralExpression(pattern) ||
                ts.isObjectLiteralExpression(pattern)
            ) {
                const value = this.expression(node.right, state);
                if (this.contains(pattern)) throw new Unsupported(pattern);
                return this.written(node, value);
            }
        }
        let current = state;
        ts.forEachChild(node, (child) => {
            current = this.expression(child, current);
        });
        return this.written(node, current);
    }

    /** The first operand always runs; a choice runs exactly one of its branches. */
    private guarded(node: ts.Node, state: boolean): boolean {
        const operands: ts.Expression[] = [];
        ts.forEachChild(node, (child) => {
            if (ts.isExpression(child)) operands.push(child);
        });
        const [first, ...rest] = operands;
        const start = first ? this.expression(first, state) : state;
        const branches = rest.map((operand) => this.expression(operand, start));
        const exclusive =
            rest.length > 1 &&
            rest.every((operand) => operandYield(node, operand) !== undefined);
        return this.written(
            node,
            exclusive ? branches.every((branch) => branch) : start,
        );
    }

    /** A loop head's target takes each element. */
    private loopTarget(
        loop: ts.ForInStatement | ts.ForOfStatement,
        state: boolean,
    ): boolean {
        if (this.contains(loop.initializer))
            throw new Unsupported(loop.initializer);
        return this.written(loop, state);
    }

    /**
     * After `node`'s own writes: `=`, a compound assignment, `++`/`--` and a
     * loop target assign; a logical assignment may not.
     */
    private written(node: ts.Node, state: boolean): boolean {
        return (
            state ||
            writeSites(node).some(
                (site) =>
                    site.kind !== "logical" &&
                    site.kind !== "delete" &&
                    ts.isIdentifier(site.target) &&
                    this.assigns(site.target),
            )
        );
    }
}

function isTrue(node: ts.Expression): boolean {
    return unwrapExpression(node).kind === ts.SyntaxKind.TrueKeyword;
}
