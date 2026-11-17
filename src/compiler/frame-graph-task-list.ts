/**
 * A program's own removal of a task from a graph's private `_tasks` list:
 *
 *     const tasks = (graph as unknown as { _tasks: Task[] })._tasks;
 *     const i = tasks.indexOf(task);
 *     if (i >= 0) tasks.splice(i, 1);
 *
 * The pin's list also holds its shadow and transmission tasks, which the
 * native list does not, so their positions differ. A position the program
 * uses only to splice the same list, at once, names the same registration
 * in both: the first one of `task`. Every other use of `_tasks` refuses.
 */
import ts from "typescript";
import { bindingReferences } from "./binding-references.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    declaredSymbol,
    namedMember,
    resolvedSymbol,
    type NamedMember,
} from "./symbols.js";
import { argumentAt, unwrapExpression, variableKind } from "./syntax.js";
import type { Value } from "./types.js";

/** The idiom's three statements, by the nodes lowering reads. */
interface TaskListRemoval {
    readonly lookup: ts.CallExpression;
    readonly splice: ts.CallExpression;
}

type TaskListContext = Pick<LoweringServices, "program" | "checker">;

/** The one `const` declaration a statement makes of a name. */
function constDeclaration(
    statement: ts.Statement | undefined,
): ts.VariableDeclaration | undefined {
    if (!statement || !ts.isVariableStatement(statement)) return undefined;
    const [declaration, ...others] = statement.declarationList.declarations;
    return declaration &&
        others.length === 0 &&
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        variableKind(declaration) === "const"
        ? declaration
        : undefined;
}

/** `<receiver>.<method>(...)` whose receiver is a read of `symbol`, with that read. */
function memberCall(
    context: TaskListContext,
    expression: ts.Expression,
    method: string,
    symbol: ts.Symbol,
): { call: ts.CallExpression; receiver: ts.Identifier } | undefined {
    const call = unwrapExpression(expression);
    const member = ts.isCallExpression(call)
        ? namedMember(context.checker, call.expression)
        : undefined;
    const receiver = member && unwrapExpression(member.expression);
    return ts.isCallExpression(call) &&
        member?.name === method &&
        receiver &&
        ts.isIdentifier(receiver) &&
        resolvedSymbol(context.checker, receiver) === symbol
        ? { call, receiver }
        : undefined;
}

/** Whether every read of `symbol` is one of `sites`. */
function readOnlyAt(
    context: TaskListContext,
    symbol: ts.Symbol,
    sites: readonly ts.Node[],
): boolean {
    const reads = bindingReferences(context.program, context.checker, symbol);
    return (
        reads.length === sites.length &&
        reads.every((read) => sites.includes(read))
    );
}

/** The removal idiom the `_tasks` read `read` begins, if it is one. */
export function taskListRemoval(
    context: TaskListContext,
    read: ts.PropertyAccessExpression,
): TaskListRemoval | undefined {
    const list = read.parent;
    if (
        !ts.isVariableDeclaration(list) ||
        !list.initializer ||
        unwrapExpression(list.initializer) !== read
    )
        return undefined;
    const statement = list.parent.parent;
    const block = statement.parent;
    if (
        !ts.isVariableStatement(statement) ||
        constDeclaration(statement) !== list ||
        !(ts.isBlock(block) || ts.isSourceFile(block))
    )
        return undefined;
    const position = block.statements.indexOf(statement);
    const tasks = declaredSymbol(context.checker, list.name);
    const indexDeclaration = constDeclaration(block.statements[position + 1]);
    const index =
        indexDeclaration &&
        declaredSymbol(context.checker, indexDeclaration.name);
    const lookup =
        tasks &&
        indexDeclaration &&
        memberCall(context, indexDeclaration.initializer!, "indexOf", tasks);
    const guard = block.statements[position + 2];
    if (
        !tasks ||
        !index ||
        !lookup ||
        lookup.call.arguments.length !== 1 ||
        ts.isSpreadElement(lookup.call.arguments[0]!) ||
        !guard ||
        !ts.isIfStatement(guard) ||
        guard.elseStatement
    )
        return undefined;
    const test = unwrapExpression(guard.expression);
    const body = ts.isBlock(guard.thenStatement)
        ? guard.thenStatement.statements.length === 1
            ? guard.thenStatement.statements[0]
            : undefined
        : guard.thenStatement;
    const splice =
        body && ts.isExpressionStatement(body)
            ? memberCall(context, body.expression, "splice", tasks)
            : undefined;
    const spliced =
        splice?.call.arguments.length === 2
            ? unwrapExpression(argumentAt(splice.call, 0))
            : undefined;
    const count = splice && unwrapExpression(argumentAt(splice.call, 1));
    const compared = ts.isBinaryExpression(test)
        ? unwrapExpression(test.left)
        : undefined;
    const bound = ts.isBinaryExpression(test)
        ? unwrapExpression(test.right)
        : undefined;
    if (
        !splice ||
        !spliced ||
        !ts.isIdentifier(spliced) ||
        resolvedSymbol(context.checker, spliced) !== index ||
        !count ||
        !ts.isNumericLiteral(count) ||
        count.text !== "1" ||
        !ts.isBinaryExpression(test) ||
        test.operatorToken.kind !== ts.SyntaxKind.GreaterThanEqualsToken ||
        !compared ||
        !ts.isIdentifier(compared) ||
        resolvedSymbol(context.checker, compared) !== index ||
        !bound ||
        !ts.isNumericLiteral(bound) ||
        bound.text !== "0" ||
        !readOnlyAt(context, tasks, [lookup.receiver, splice.receiver]) ||
        !readOnlyAt(context, index, [compared, spliced])
    )
        return undefined;
    return { lookup: lookup.call, splice: splice.call };
}

/**
 * `tasks.indexOf(task)` and `tasks.splice(i, 1)` of a removal idiom, over
 * the native list of the graph `tasks` holds.
 */
export function compileTaskListRemovalCall(
    context: TaskListContext &
        Pick<
            LoweringServices,
            | "compileValue"
            | "compileNumber"
            | "expectKind"
            | "expectSameEngine"
            | "reachFeature"
            | "reachJsData"
        >,
    call: ts.CallExpression,
    member: NamedMember,
): Value | undefined {
    if (member.name !== "indexOf" && member.name !== "splice") return undefined;
    const receiver = unwrapExpression(member.expression);
    const declaration = ts.isIdentifier(receiver)
        ? resolvedSymbol(context.checker, receiver)?.valueDeclaration
        : undefined;
    const read =
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer
            ? unwrapExpression(declaration.initializer)
            : undefined;
    const removal =
        read &&
        ts.isPropertyAccessExpression(read) &&
        read.name.text === "_tasks"
            ? taskListRemoval(context, read)
            : undefined;
    if (!removal || (call !== removal.lookup && call !== removal.splice))
        return undefined;
    const graph = context.compileValue(receiver);
    context.reachJsData();
    if (call === removal.lookup) {
        const task = context.compileValue(argumentAt(call, 0));
        if (task.kind !== "compute-task")
            context.expectKind(task, "task", argumentAt(call, 0));
        context.expectSameEngine(graph, task, call);
        return {
            kind: "number",
            cpp: `bbl::js::array_index_of(${graph.cpp}.tasks, ${task.cpp})`,
            dataType: { kind: "number" },
        };
    }
    context.reachFeature("frame-graph:task-removal", call);
    return {
        kind: "void",
        cpp: `bbl::js::array_splice_one(${graph.cpp}.tasks, ${context.compileNumber(argumentAt(call, 0), "double")})`,
    };
}
