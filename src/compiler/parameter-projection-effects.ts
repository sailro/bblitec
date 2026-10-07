import ts from "typescript";
import { isPinnedSource } from "../pinned-program.js";
import { forEachAnalysisNode, someAnalysisNode } from "./analysis-walk.js";
import { readOnlyDataMethods } from "./receiver-methods.js";
import { pinnedSourceHandleKind } from "./data-types.js";
import { EmissionMap, EmissionWeakMap } from "./emission-transaction.js";
import { engineBodies, isEngineDeclaration } from "./engine-bodies.js";
import {
    accessedPropertySymbol,
    declarationInDefaultLibrary,
    declaredSymbol,
} from "./symbols.js";
import {
    assignmentTargets,
    isAssignmentExpression,
    isUpdateExpression,
    propertyNameText,
    unwrapExpression,
} from "./syntax.js";
import { typeCanCarryReference } from "./type-facts.js";
import { isSupportedFunction } from "./user-functions.js";

type Path = readonly string[];

/** A reference at `at` in a local value aliases `from` in the parameter. */
interface Projection {
    readonly at: Path;
    readonly from: Path;
}

function compatible(left: string, right: string): boolean {
    return left === right || left === "*" || right === "*";
}

function overlaps(left: Path, right: Path): boolean {
    return left
        .slice(0, right.length)
        .every((key, i) => compatible(key, right[i]!));
}

function project(values: readonly Projection[], key: string): Projection[] {
    return values.flatMap((value) =>
        value.at.length > 0
            ? compatible(value.at[0]!, key)
                ? [{ at: value.at.slice(1), from: value.from }]
                : []
            : [{ at: [], from: [...value.from, key] }],
    );
}

const results = new EmissionWeakMap<
    ts.TypeChecker,
    WeakMap<ts.FunctionLikeDeclaration, Map<string, boolean>>
>();

/**
 * Proves that a concrete argument projection is neither written through nor
 * retained. A copied container can still carry reference-valued children.
 * Unknown bodies, receivers, aliases and recursive proof cycles decline.
 */
export function callArgumentProjectionIsReadOnly(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
    index: number,
    path: Path,
): boolean {
    return callProjection(checker, call, index, path, new Set());
}

export function parameterProjectionIsReadOnly(
    checker: ts.TypeChecker,
    declaration: ts.Node,
    index: number,
    path: Path,
    independentFields = false,
): boolean {
    return parameterProjection(
        checker,
        declaration,
        index,
        path,
        new Set(),
        independentFields,
    );
}

function callProjection(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
    index: number,
    path: Path,
    active: Set<ts.FunctionLikeDeclaration>,
): boolean {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (!declaration) return false;
    const engine = isEngineDeclaration(declaration)
        ? engineBodies()
        : undefined;
    const bodies = engine ? engine.bodies(declaration) : [declaration];
    return (
        bodies !== undefined &&
        bodies.length > 0 &&
        bodies.every((body) =>
            parameterProjection(
                engine ? engine.checkerFor(body) : checker,
                body,
                index,
                path,
                active,
            ),
        )
    );
}

function parameterProjection(
    checker: ts.TypeChecker,
    declaration: ts.Node,
    index: number,
    path: Path,
    active: Set<ts.FunctionLikeDeclaration>,
    independentFields = false,
): boolean {
    if (!isSupportedFunction(declaration) || !declaration.body) return false;
    const parameter = declaration.parameters[index];
    if (
        !parameter ||
        parameter.dotDotDotToken ||
        !ts.isIdentifier(parameter.name)
    )
        return false;
    const symbol = declaredSymbol(checker, parameter.name);
    if (!symbol || active.has(declaration)) return false;
    const cacheKey = JSON.stringify([index, path, independentFields]);
    let functions = results.get(checker);
    let known = functions?.get(declaration);
    const cached = known?.get(cacheKey);
    if (cached !== undefined) return cached;
    const typeAt = (selected: Path): ts.Type | undefined => {
        let projectedType: ts.Type | undefined = checker.getTypeAtLocation(
            parameter.name,
        );
        for (const key of selected) {
            const property: ts.Symbol | undefined =
                projectedType && checker.getPropertyOfType(projectedType, key);
            projectedType = property
                ? checker.getTypeOfSymbolAtLocation(property, parameter.name)
                : projectedType &&
                  checker.getIndexTypeOfType(
                      projectedType,
                      ts.IndexKind.Number,
                  );
        }
        return projectedType;
    };
    const projectedType = typeAt(path);
    const scalarProjection =
        projectedType !== undefined && !typeCanCarryReference(projectedType);
    active.add(declaration);

    const nativeHandle = (
        type: ts.Type,
    ): ReturnType<typeof pinnedSourceHandleKind> => {
        const candidate = checker.getNonNullableType(type);
        const direct = pinnedSourceHandleKind(candidate);
        if (direct) return direct;
        if (
            !candidate.symbol?.declarations?.every(
                (item) =>
                    isEngineDeclaration(item) ||
                    isPinnedSource(item.getSourceFile()),
            )
        )
            return undefined;
        for (const base of candidate.getBaseTypes() ?? []) {
            const inherited = nativeHandle(base);
            if (inherited) return inherited;
        }
        return undefined;
    };

    const aliases = new Map<ts.Symbol, readonly Projection[]>([
        [symbol, [{ at: [], from: [] }]],
    ]);
    const roots = [
        ...declaration.parameters.flatMap((item) =>
            item.initializer ? [item.initializer] : [],
        ),
        declaration.body,
    ];
    const relevant = (values: readonly Projection[]): Projection[] =>
        values.filter((value) => {
            if (overlaps(value.from, path)) return true;
            if (independentFields) return false;
            const divergent = value.from.findIndex(
                (key, i) => !compatible(key, path[i]!),
            );
            const sibling = typeAt(value.from.slice(0, divergent + 1));
            if (!sibling || typeCanCarryReference(sibling)) {
                // Nominal native handles cannot alias an authored data object.
                // Other reference fields may share children or point back to
                // their parent, despite having different source access paths.
                const siblingHandle = sibling && nativeHandle(sibling);
                const selectedHandle =
                    projectedType && nativeHandle(projectedType);
                return !siblingHandle || selectedHandle !== undefined;
            }
            return false;
        });
    const receiver = (node: ts.CallExpression): ts.Expression | undefined => {
        const callee = unwrapExpression(node.expression);
        return ts.isPropertyAccessExpression(callee)
            ? callee.expression
            : undefined;
    };
    const arrayMethod = (node: ts.CallExpression): string | undefined => {
        const called = checker.getResolvedSignature(node)?.declaration;
        const owner = called?.parent;
        return called &&
            declarationInDefaultLibrary(called) &&
            owner &&
            ts.isInterfaceDeclaration(owner) &&
            (owner.name.text === "Array" ||
                owner.name.text === "ReadonlyArray") &&
            ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : undefined;
    };
    const carries = (node: ts.Expression): boolean =>
        typeCanCarryReference(checker.getTypeAtLocation(node));
    const flow = (expression: ts.Expression): readonly Projection[] => {
        const node = unwrapExpression(expression);
        if (!carries(node)) return [];
        if (ts.isIdentifier(node))
            return aliases.get(declaredSymbol(checker, node)!) ?? [];
        if (ts.isPropertyAccessExpression(node))
            return project(flow(node.expression), node.name.text);
        if (ts.isElementAccessExpression(node)) {
            const key = unwrapExpression(node.argumentExpression);
            return project(
                flow(node.expression),
                ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)
                    ? key.text
                    : "*",
            );
        }
        if (ts.isConditionalExpression(node))
            return [...flow(node.whenTrue), ...flow(node.whenFalse)];
        if (
            ts.isBinaryExpression(node) &&
            [
                ts.SyntaxKind.QuestionQuestionToken,
                ts.SyntaxKind.BarBarToken,
                ts.SyntaxKind.AmpersandAmpersandToken,
            ].includes(node.operatorToken.kind)
        )
            return [...flow(node.left), ...flow(node.right)];
        if (ts.isObjectLiteralExpression(node))
            return node.properties.flatMap((property): Projection[] => {
                if (ts.isSpreadAssignment(property))
                    return [...flow(property.expression)];
                if (
                    !ts.isPropertyAssignment(property) &&
                    !ts.isShorthandPropertyAssignment(property)
                )
                    return [];
                const value = ts.isPropertyAssignment(property)
                    ? property.initializer
                    : property.name;
                return flow(value).map((entry) => ({
                    at: [propertyNameText(property.name) ?? "*", ...entry.at],
                    from: entry.from,
                }));
            });
        if (ts.isArrayLiteralExpression(node))
            return node.elements.flatMap((element, i): Projection[] => {
                if (ts.isOmittedExpression(element)) return [];
                const values = ts.isSpreadElement(element)
                    ? project(flow(element.expression), "*")
                    : flow(element);
                const elementType = ts.isSpreadElement(element)
                    ? checker.getIndexTypeOfType(
                          checker.getTypeAtLocation(element.expression),
                          ts.IndexKind.Number,
                      )
                    : undefined;
                if (elementType && !typeCanCarryReference(elementType))
                    return [];
                return values.map((entry) => ({
                    at: [
                        ts.isSpreadElement(element) ? "*" : String(i),
                        ...entry.at,
                    ],
                    from: entry.from,
                }));
            });
        if (ts.isCallExpression(node) && arrayMethod(node) === "slice") {
            const owner = receiver(node)!;
            const element = checker.getIndexTypeOfType(
                checker.getTypeAtLocation(owner),
                ts.IndexKind.Number,
            );
            return element && !typeCanCarryReference(element)
                ? []
                : project(flow(owner), "*").map((entry) => ({
                      at: ["*", ...entry.at],
                      from: entry.from,
                  }));
        }
        // Calls with a relevant input must separately prove no escape. Their
        // result cannot alias that input when this proof succeeds.
        if (ts.isCallExpression(node)) return [];
        // An unmodelled reference expression may forward any of its operands.
        // Keep it opaque rather than dropping an await/comma/assignment alias.
        const opaque: Projection[] = [];
        ts.forEachChild(node, (child) => {
            if (ts.isExpression(child))
                opaque.push(
                    ...flow(child).map((value) => ({
                        at: [],
                        from: value.from,
                    })),
                );
        });
        return opaque;
    };
    let changed: boolean;
    const bind = (
        name: ts.BindingName,
        values: readonly Projection[],
    ): void => {
        if (ts.isIdentifier(name)) {
            const target = declaredSymbol(checker, name);
            if (!target || values.length === 0) return;
            const previous = aliases.get(target) ?? [];
            const keys = new Set(
                previous.map((value) => JSON.stringify(value)),
            );
            const added = values.filter(
                (value) => !keys.has(JSON.stringify(value)),
            );
            if (added.length > 0) {
                aliases.set(target, [...previous, ...added]);
                changed = true;
            }
            return;
        }
        name.elements.forEach((element, i) => {
            if (ts.isOmittedExpression(element)) return;
            const key = ts.isArrayBindingPattern(name)
                ? String(i)
                : element.propertyName
                  ? (propertyNameText(element.propertyName) ?? "*")
                  : ts.isIdentifier(element.name)
                    ? element.name.text
                    : "*";
            bind(element.name, [
                ...(element.dotDotDotToken ? values : project(values, key)),
                ...(element.initializer ? flow(element.initializer) : []),
            ]);
        });
    };
    // Alias declarations form a finite graph. A repeated declaration or
    // self-referential projection cannot establish a finite source path.
    let remaining = 1;
    for (const root of roots)
        forEachAnalysisNode(
            root,
            (node) => {
                if (ts.isVariableDeclaration(node) || ts.isBindingElement(node))
                    remaining++;
            },
            { functions: "skip", types: "skip" },
        );
    do {
        changed = false;
        for (const root of roots)
            forEachAnalysisNode(
                root,
                (node) => {
                    if (ts.isVariableDeclaration(node) && node.initializer)
                        bind(node.name, flow(node.initializer));
                    if (
                        ts.isForOfStatement(node) &&
                        ts.isVariableDeclarationList(node.initializer)
                    )
                        for (const item of node.initializer.declarations)
                            bind(
                                item.name,
                                project(flow(node.expression), "*"),
                            );
                },
                { functions: "skip", types: "skip" },
            );
    } while (changed && --remaining > 0);

    const uses = (node: ts.Expression): boolean =>
        relevant(flow(node)).length > 0;
    const stores = (target: ts.Expression): boolean => {
        const node = unwrapExpression(target);
        if (ts.isIdentifier(node)) return uses(node);
        if (
            !ts.isPropertyAccessExpression(node) &&
            !ts.isElementAccessExpression(node)
        )
            return false;
        const key = ts.isPropertyAccessExpression(node)
            ? node.name.text
            : ts.isStringLiteralLike(node.argumentExpression) ||
                ts.isNumericLiteral(node.argumentExpression)
              ? node.argumentExpression.text
              : "*";
        return relevant(project(flow(node.expression), key)).some(
            (value) =>
                value.from.length > path.length ||
                (scalarProjection && value.from.length === path.length),
        );
    };
    const unsafe =
        changed ||
        (!ts.isBlock(declaration.body) && uses(declaration.body)) ||
        roots.some((root) =>
            someAnalysisNode(
                root,
                (node) => {
                    if (ts.isFunctionLike(node)) {
                        return (
                            someAnalysisNode(
                                node,
                                (part) =>
                                    ts.isIdentifier(part) &&
                                    relevant(
                                        aliases.get(
                                            declaredSymbol(checker, part)!,
                                        ) ?? [],
                                    ).length > 0,
                                { types: "skip" },
                            ) || "skip"
                        );
                    }
                    if (isAssignmentExpression(node)) {
                        return (
                            assignmentTargets(node.left).some(stores) ||
                            uses(node.right)
                        );
                    }
                    if (isUpdateExpression(node)) return stores(node.operand);
                    if (ts.isDeleteExpression(node))
                        return stores(node.expression);
                    if (
                        (ts.isReturnStatement(node) ||
                            ts.isThrowStatement(node)) &&
                        node.expression &&
                        uses(node.expression)
                    )
                        return true;
                    if (
                        ts.isAwaitExpression(node) ||
                        ts.isYieldExpression(node)
                    )
                        return true;
                    if (ts.isForOfStatement(node) && uses(node.expression)) {
                        const iterable = checker.getNonNullableType(
                            checker.getTypeAtLocation(node.expression),
                        );
                        if (
                            !checker.isArrayType(iterable) &&
                            !checker.isTupleType(iterable)
                        )
                            return true;
                    }
                    if (
                        (ts.isPropertyAccessExpression(node) ||
                            ts.isElementAccessExpression(node)) &&
                        flow(node.expression).length > 0
                    ) {
                        const property = accessedPropertySymbol(checker, node);
                        if (
                            property?.declarations?.some(
                                (item) =>
                                    ts.isGetAccessorDeclaration(item) ||
                                    ts.isSetAccessorDeclaration(item),
                            )
                        )
                            return true;
                    }
                    if (ts.isNewExpression(node))
                        return (
                            node.arguments?.some(
                                (argument) => flow(argument).length > 0,
                            ) ?? false
                        );
                    if (!ts.isCallExpression(node)) return false;
                    const owner = receiver(node);
                    if (!owner && uses(node.expression)) return true;
                    // Distinct native identity rules out aliasing, not effects:
                    // an opaque method can invoke a callback into the caller.
                    if (owner && flow(owner).length > 0 && !uses(owner))
                        return true;
                    if (
                        !independentFields &&
                        node.arguments.some(
                            (argument) =>
                                flow(argument).length > 0 && !uses(argument),
                        )
                    )
                        return true;
                    if (owner && uses(owner)) {
                        const method = arrayMethod(node);
                        const element = checker.getIndexTypeOfType(
                            checker.getTypeAtLocation(owner),
                            ts.IndexKind.Number,
                        );
                        if (
                            !method ||
                            !readOnlyDataMethods.has(method) ||
                            (carries(node) && method !== "slice") ||
                            (node.arguments.some(
                                (argument) =>
                                    checker
                                        .getTypeAtLocation(argument)
                                        .getCallSignatures().length > 0,
                            ) &&
                                (!element || typeCanCarryReference(element)))
                        )
                            return true;
                    }
                    return node.arguments.some((argument, argumentIndex) =>
                        relevant(flow(argument)).some((value) => {
                            const suffix =
                                value.from.length < path.length
                                    ? path.slice(value.from.length)
                                    : [];
                            return !callProjection(
                                checker,
                                node,
                                argumentIndex,
                                [...value.at, ...suffix],
                                active,
                            );
                        }),
                    );
                },
                { types: "skip" },
            ),
        );
    active.delete(declaration);
    if (!functions) results.set(checker, (functions = new EmissionWeakMap()));
    if (!known) functions.set(declaration, (known = new EmissionMap()));
    known.set(cacheKey, !unsafe);
    return !unsafe;
}
