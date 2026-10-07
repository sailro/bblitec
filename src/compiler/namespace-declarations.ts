// `namespace N { ... }`: the body's statements run where the declaration
// evaluates, and `N.member` names the member's own binding, as every
// reference inside the body does. Declarations merging into one namespace
// add their members to the same object. The namespace object itself has no
// native representation beyond those member reads and writes.
import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import { resolvedSymbol } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";

type NamespaceContext = Pick<
    LoweringServices,
    "bindings" | "allocateBlockPrefix" | "emitStatement"
>;

/**
 * `N.member = value` from outside the body: the member's binding is written
 * through its own name only, where the body declares it.
 */
export function refuseNamespaceMemberWrite(
    context: Pick<LoweringServices, "fail">,
    member: ts.Identifier,
): never {
    return context.fail(
        member,
        `Namespace member '${member.text}' is written through its own name inside the namespace body; writes through the namespace object refuse.`,
    );
}

/** A namespace JavaScript creates an object for: one declaring a value. */
export function isInstantiatedNamespace(
    declaration: ts.ModuleDeclaration,
): boolean {
    if (
        !ts.isIdentifier(declaration.name) ||
        (ts.getCombinedModifierFlags(declaration) &
            ts.ModifierFlags.Ambient) !==
            0
    )
        return false;
    const body = declaration.body;
    if (!body) return false;
    if (ts.isModuleDeclaration(body)) return isInstantiatedNamespace(body);
    return (
        ts.isModuleBlock(body) &&
        body.statements.some((statement) =>
            ts.isModuleDeclaration(statement)
                ? isInstantiatedNamespace(statement)
                : !(
                      ts.isInterfaceDeclaration(statement) ||
                      ts.isTypeAliasDeclaration(statement) ||
                      (ts.isEnumDeclaration(statement) &&
                          (ts.getCombinedModifierFlags(statement) &
                              ts.ModifierFlags.Const) !==
                              0)
                  ),
        )
    );
}

/** The namespace a name refers to, when it names one. */
export function namespaceSymbol(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): ts.Symbol | undefined {
    const owner = unwrapExpression(expression);
    if (!ts.isIdentifier(owner) && !ts.isPropertyAccessExpression(owner))
        return undefined;
    const symbol = resolvedSymbol(checker, owner);
    return symbol &&
        (symbol.flags & ts.SymbolFlags.ValueModule) !== 0 &&
        symbol.declarations?.some(ts.isModuleDeclaration)
        ? symbol
        : undefined;
}

/** `N.member`: the member's name, which binds as it does inside the body. */
export function namespaceMemberName(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): ts.Identifier | undefined {
    return ts.isPropertyAccessExpression(expression) &&
        !expression.questionDotToken &&
        ts.isIdentifier(expression.name) &&
        namespaceSymbol(checker, expression.expression)
        ? expression.name
        : undefined;
}

/**
 * Runs a namespace body in place. Its bindings keep their own C++ names
 * (the body's scope prefix) but stay visible after it, as module bindings
 * do: functions of the namespace lower where they are called and read them
 * there.
 */
export function emitNamespaceDeclaration(
    context: NamespaceContext,
    declaration: ts.ModuleDeclaration,
): void {
    const body = declaration.body;
    if (!isInstantiatedNamespace(declaration) || !body) return;
    if (ts.isModuleDeclaration(body)) {
        emitNamespaceDeclaration(context, body);
        return;
    }
    if (!ts.isModuleBlock(body)) return;
    context.bindings.pushScope(context.allocateBlockPrefix());
    const scope = context.bindings.variableScopes.at(-1)!;
    try {
        for (const statement of body.statements)
            context.emitStatement(statement);
    } finally {
        context.bindings.popScope();
        const outer = context.bindings.variableScopes.at(-1)!;
        for (const [symbol, binding] of scope) outer.set(symbol, binding);
    }
}
