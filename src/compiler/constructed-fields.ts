import ts from "typescript";
import { forEachReturn } from "./loop-control.js";
import {
    localSyncFunction,
    unwrapExpression,
    outermostWrapper,
    writeSiteOf,
} from "./syntax.js";
import type { CompilerSymbols } from "./symbols.js";
import { isNullable } from "./type-facts.js";

interface ConstructedFieldContext {
    readonly checker: ts.TypeChecker;
    readonly symbols: Pick<CompilerSymbols, "valueSymbol">;
}

/**
 * Whether `record.field` reads a value its construction stored present,
 * although the record type declares the field optional.
 *
 * `record` is a const the checker has narrowed to non-null, bound to a call
 * of a local function whose every returned record is a fresh object literal
 * setting `field` from an expression typed without null or undefined. The
 * literal is the only reference to its object, so it stays unchanged when
 * every use of `record` in its scope is a property read or a presence test.
 */
export function constructedFieldPresent(
    context: ConstructedFieldContext,
    expression: ts.Expression,
): boolean {
    const read = unwrapExpression(expression);
    if (!ts.isPropertyAccessExpression(read)) return false;
    const owner = unwrapExpression(read.expression);
    if (
        !ts.isIdentifier(owner) ||
        isNullable(context.checker.getTypeAtLocation(owner))
    ) {
        return false;
    }
    const declaration = context.symbols.valueSymbol(owner)?.valueDeclaration;
    if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name) ||
        (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0 ||
        !declaration.initializer
    ) {
        return false;
    }
    const call = unwrapExpression(declaration.initializer);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
        return false;
    }
    const factory = localSyncFunction(
        context.symbols.valueSymbol(call.expression)?.valueDeclaration,
    );
    return (
        factory !== undefined &&
        returnedRecords(factory).every((returned) =>
            setsPresentField(context, returned, read.name.text),
        ) &&
        onlyReadsFields(context, declaration)
    );
}

type LocalFunction =
    ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Every expression the function returns; a bare `return` reads as absent. */
function returnedRecords(fn: LocalFunction): (ts.Expression | undefined)[] {
    if (!ts.isBlock(fn.body!)) return [fn.body];
    const returned: (ts.Expression | undefined)[] = [];
    forEachReturn([fn.body], (node) => returned.push(node.expression));
    return returned;
}

function setsPresentField(
    context: ConstructedFieldContext,
    returned: ts.Expression | undefined,
    field: string,
): boolean {
    if (!returned) return true;
    const value = unwrapExpression(returned);
    if (
        value.kind === ts.SyntaxKind.NullKeyword ||
        ts.isVoidExpression(value) ||
        (ts.isIdentifier(value) && value.text === "undefined")
    ) {
        return true;
    }
    if (
        !ts.isObjectLiteralExpression(value) ||
        value.properties.some(
            (property) =>
                !ts.isPropertyAssignment(property) &&
                !ts.isShorthandPropertyAssignment(property),
        )
    ) {
        return false;
    }
    const property = value.properties.find(
        (candidate) =>
            candidate.name !== undefined &&
            (ts.isIdentifier(candidate.name) ||
                ts.isStringLiteral(candidate.name)) &&
            candidate.name.text === field,
    );
    if (!property) return false;
    const stored = ts.isPropertyAssignment(property)
        ? property.initializer
        : (property as ts.ShorthandPropertyAssignment).name;
    return !isNullable(context.checker.getTypeAtLocation(stored));
}

/** Every use of the binding reads one of its fields or tests its presence. */
function onlyReadsFields(
    context: ConstructedFieldContext,
    declaration: ts.VariableDeclaration,
): boolean {
    const name = declaration.name as ts.Identifier;
    const symbol = context.symbols.valueSymbol(name);
    const scope = ts.findAncestor(
        declaration,
        (node) => ts.isBlock(node) || ts.isSourceFile(node),
    );
    if (!scope || !symbol) return false;
    let escapes = false;
    const visit = (node: ts.Node): void => {
        if (escapes) return;
        if (
            ts.isIdentifier(node) &&
            node !== name &&
            context.symbols.valueSymbol(node) === symbol &&
            !isFieldReadOrTest(node)
        ) {
            escapes = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(scope);
    return !escapes;
}

function isFieldReadOrTest(identifier: ts.Identifier): boolean {
    const use = outermostWrapper(identifier);
    const parent = use.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === use) {
        const access = outermostWrapper(parent);
        const target = access.parent;
        // A method call may write its receiver; a write names the field.
        return !(
            (ts.isCallExpression(target) && target.expression === access) ||
            writeSiteOf(parent) !== undefined
        );
    }
    // `x && ...` yields x only when it is falsy, so no reference escapes.
    return (
        (ts.isPrefixUnaryExpression(parent) &&
            parent.operator === ts.SyntaxKind.ExclamationToken) ||
        ((ts.isIfStatement(parent) || ts.isWhileStatement(parent)) &&
            parent.expression === use) ||
        (ts.isConditionalExpression(parent) && parent.condition === use) ||
        (ts.isBinaryExpression(parent) &&
            parent.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken &&
            parent.left === use)
    );
}
