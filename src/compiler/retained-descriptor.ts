import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import type { LoweringServices } from "./lowering-services.js";
import { callArgumentProjectionIsReadOnly } from "./parameter-projection-effects.js";
import { accessedPropertySymbol } from "./symbols.js";
import {
    isAssignmentExpression,
    propertyNameText,
    rootIdentifier,
    unwrapExpression,
} from "./syntax.js";
import { typeCanCarryReference } from "./type-facts.js";
import type { Value } from "./types.js";
import {
    type AliasedMutationScan,
    aliasedMutationScan,
    writesThroughTrackedRoot,
} from "./user-functions.js";

type DescriptorContext = Pick<LoweringServices, "checker" | "symbols" | "fail">;

// Source-only proof, separated by the exact call allowed to retain the owner.
const stabilityByConsumer = new WeakMap<
    ts.TypeChecker,
    WeakMap<
        ts.CallExpression,
        WeakMap<ts.Symbol, Partial<Record<"aliased" | "opaque", boolean>>>
    >
>();

/** Read evaluated descriptor metadata; never reconstruct an initializer's values. */
export function knownDescriptorProperties(
    context: Pick<LoweringServices, "fail">,
    value: Value,
    site: ts.Node,
): Readonly<Record<string, Value>> {
    if (
        !value.recordProperties ||
        Object.keys(value.recordGetters ?? {}).length ||
        Object.keys(value.recordSetters ?? {}).length ||
        Object.keys(value.recordMethods ?? {}).length
    )
        return context.fail(
            site,
            "Retained descriptors require known plain properties.",
        );
    return value.recordProperties;
}

export function knownDescriptorElements(
    value: Value,
): readonly Value[] | undefined {
    return value.kind === "tuple"
        ? value.tupleElements
        : (value.staticElementsOwner ?? value).staticElements;
}

/**
 * A generation descriptor retained by this particular reader must stay stable.
 * The source walk proves ownership only; all descriptor values come from the
 * already evaluated metadata. Other readers/escapes require the shared no-escape
 * proof. Exported storage, getters and unrepresented provenance decline.
 */
export function requireStableRetainedDescriptor(
    context: DescriptorContext,
    value: Value,
    expression: ts.Expression,
    consumer: ts.CallExpression,
    opaque: (value: Value) => boolean = () => false,
    result: "aliased" | "opaque" = "aliased",
): void {
    const { checker, symbols } = context;
    const active = new Set<ts.Symbol>();
    const checked = new Set<ts.Symbol>();
    let consumers = stabilityByConsumer.get(checker);
    if (!consumers) {
        consumers = new WeakMap();
        stabilityByConsumer.set(checker, consumers);
    }
    let stability = consumers.get(consumer);
    if (!stability) {
        stability = new WeakMap();
        consumers.set(consumer, stability);
    }
    function fail(site: ts.Node): never {
        return context.fail(
            site,
            "A retained generation descriptor requires stable, nonescaping source storage.",
        );
    }
    const references = (node: ts.Expression): boolean =>
        typeCanCarryReference(checker.getTypeAtLocation(node));
    // Opaque native results cannot expose descriptor storage. Their supported
    // consumers own that boundary; property reads or structural erasure refuse.
    const containsAlias = (
        node: ts.Node,
        scan: AliasedMutationScan,
    ): boolean =>
        result === "opaque"
            ? someAnalysisNode(node, scan.namesAlias, {
                  skip: (candidate) => candidate === consumer,
              })
            : scan.containsAlias(node);
    const stable = (identifier: ts.Identifier, symbol: ts.Symbol): boolean => {
        const previous = stability.get(symbol)?.[result];
        if (previous !== undefined) return previous;
        const stableResult = !aliasedMutationScan(
            identifier,
            (name) => symbols.valueSymbol(name),
            {
                aliasingInitializer: (initializer, scan) =>
                    references(initializer) && containsAlias(initializer, scan),
                mutates: (node, scan) => {
                    if (node === consumer) return false;
                    const namesRoot = (expression: ts.Expression): boolean => {
                        const root = rootIdentifier(
                            unwrapExpression(expression),
                        );
                        return root !== undefined && scan.namesAlias(root);
                    };
                    if (
                        (ts.isExportDeclaration(node) ||
                            ts.isExportAssignment(node)) &&
                        containsAlias(node, scan)
                    )
                        return true;
                    if (
                        ts.isForOfStatement(node) &&
                        references(node.expression) &&
                        containsAlias(node.expression, scan)
                    )
                        return true;
                    if (
                        writesThroughTrackedRoot(
                            node,
                            namesRoot,
                            undefined,
                            checker,
                        ) ||
                        (ts.isDeleteExpression(node) &&
                            namesRoot(node.expression))
                    )
                        return true;
                    if (
                        ts.isVariableDeclaration(node) &&
                        node.initializer &&
                        references(node.initializer) &&
                        containsAlias(node.initializer, scan) &&
                        (!ts.isIdentifier(node.name) ||
                            (ts.getCombinedModifierFlags(node) &
                                ts.ModifierFlags.Export) !==
                                0)
                    )
                        return true;
                    if (
                        isAssignmentExpression(node) &&
                        references(node.right) &&
                        containsAlias(node.right, scan) &&
                        !ts.isIdentifier(node.left)
                    )
                        return true;
                    if (
                        (ts.isReturnStatement(node) ||
                            ts.isThrowStatement(node)) &&
                        node.expression &&
                        references(node.expression) &&
                        containsAlias(node.expression, scan)
                    )
                        return true;
                    if (
                        ts.isArrowFunction(node) &&
                        !ts.isBlock(node.body) &&
                        references(node.body) &&
                        containsAlias(node.body, scan)
                    )
                        return true;
                    if (
                        (ts.isPropertyAccessExpression(node) ||
                            ts.isElementAccessExpression(node)) &&
                        namesRoot(node)
                    ) {
                        const property = accessedPropertySymbol(checker, node);
                        if (
                            property?.declarations?.some(
                                (declaration) =>
                                    ts.isGetAccessorDeclaration(declaration) ||
                                    ts.isSetAccessorDeclaration(declaration),
                            )
                        )
                            return true;
                    }
                    if (ts.isNewExpression(node))
                        return (
                            node.arguments?.some(
                                (argument) =>
                                    references(argument) &&
                                    containsAlias(argument, scan),
                            ) ?? false
                        );
                    if (!ts.isCallExpression(node)) return false;
                    return node.arguments.some(
                        (argument, index) =>
                            containsAlias(argument, scan) &&
                            references(argument) &&
                            !callArgumentProjectionIsReadOnly(
                                checker,
                                node,
                                index,
                                [],
                            ),
                    );
                },
            },
        );
        stability.set(symbol, {
            ...stability.get(symbol),
            [result]: stableResult,
        });
        return stableResult;
    };
    const visit = (value: Value, source: ts.Expression): void => {
        if (opaque(value) || !references(source)) return;
        const node = unwrapExpression(source);
        if (ts.isIdentifier(node)) {
            const symbol = symbols.valueSymbol(node);
            const declaration = symbol?.valueDeclaration;
            if (
                !symbol ||
                !declaration ||
                !ts.isVariableDeclaration(declaration) ||
                !ts.isIdentifier(declaration.name) ||
                !declaration.initializer ||
                declaration.getSourceFile() !== consumer.getSourceFile() ||
                (ts.getCombinedModifierFlags(declaration) &
                    ts.ModifierFlags.Export) !==
                    0 ||
                (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
                active.has(symbol)
            )
                fail(node);
            if (checked.has(symbol)) return;
            if (!stable(declaration.name, symbol)) fail(node);
            active.add(symbol);
            visit(value, declaration.initializer);
            active.delete(symbol);
            checked.add(symbol);
            return;
        }
        if (ts.isObjectLiteralExpression(node)) {
            const properties = knownDescriptorProperties(context, value, node);
            const names: string[] = [];
            for (const property of node.properties) {
                if (
                    !ts.isPropertyAssignment(property) &&
                    !ts.isShorthandPropertyAssignment(property)
                )
                    fail(property);
                const name = propertyNameText(property.name);
                const member =
                    name === undefined ? undefined : properties[name];
                if (!name || !member) fail(property);
                names.push(name);
                visit(
                    member,
                    ts.isPropertyAssignment(property)
                        ? property.initializer
                        : property.name,
                );
            }
            if (Object.keys(properties).some((name) => !names.includes(name)))
                fail(node);
            return;
        }
        if (ts.isArrayLiteralExpression(node)) {
            const elements = knownDescriptorElements(value);
            if (!elements || elements.length !== node.elements.length)
                fail(node);
            node.elements.forEach((element, index) => {
                if (
                    ts.isSpreadElement(element) ||
                    ts.isOmittedExpression(element)
                )
                    fail(element);
                visit(elements[index]!, element);
            });
            return;
        }
        fail(node);
    };
    visit(value, expression);
}
