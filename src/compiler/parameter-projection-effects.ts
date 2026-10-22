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
    calledDeclaration,
} from "./symbols.js";
import {
    isAssignmentExpression,
    isOperandSelection,
    objectProperty,
    propertyKey,
    unwrapExpression,
    valueOperands,
    writeSites,
    ANY_KEY,
    accessKey,
    aliasKey,
    keysMayMatch,
    arrayLiteralSlots,
    patternSlots,
    plainDataMembers,
    parameterForArgument,
    isSuspensionPoint,
    isSupportedFunction,
    isFunctionWithBody,
} from "./syntax.js";
import { typeCanCarryReference, arrayElementType } from "./type-facts.js";
import { concreteArgumentIdentityPaths } from "./concrete-argument-identities.js";

type Path = readonly string[];

/** A reference at `at` in a local value aliases `from` in the parameter. */
interface Projection {
    readonly at: Path;
    readonly from: Path;
}

function overlaps(left: Path, right: Path): boolean {
    return left
        .slice(0, right.length)
        .every((key, i) => keysMayMatch(key, right[i]!));
}

function project(values: readonly Projection[], key: string): Projection[] {
    return values.flatMap((value) =>
        value.at.length > 0
            ? keysMayMatch(value.at[0]!, key)
                ? [{ at: value.at.slice(1), from: value.from }]
                : []
            : [{ at: [], from: [...value.from, key] }],
    );
}

/** The projections of a container holding a value with `values` at `key`. */
function nest(values: readonly Projection[], key: string): Projection[] {
    return values.map((value) => ({
        at: [key, ...value.at],
        from: value.from,
    }));
}

const results = new EmissionWeakMap<
    ts.TypeChecker,
    WeakMap<ts.FunctionLikeDeclaration, Map<string, boolean>>
>();

// AST shape is immutable; every scalar projection shares this call-name census.
const optionalCallNames = new WeakMap<
    ts.FunctionLikeDeclaration,
    ReadonlySet<string>
>();

function optionalCalls(
    declaration: ts.FunctionLikeDeclaration,
): ReadonlySet<string> {
    const cached = optionalCallNames.get(declaration);
    if (cached) return cached;
    const names = new Set<string>();
    forEachAnalysisNode(
        declaration,
        (node) => {
            if (!ts.isCallExpression(node) || !node.questionDotToken) return;
            const callee = unwrapExpression(node.expression);
            if (ts.isPropertyAccessExpression(callee))
                names.add(callee.name.text);
        },
        { types: "skip" },
    );
    optionalCallNames.set(declaration, names);
    return names;
}

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

/** Visit argument references whose concrete consumer projection can mutate or retain them. */
export function visitMutableArgumentReferences(
    checker: ts.TypeChecker,
    node: ts.CallExpression,
    index: number,
    reference: (value: ts.Expression) => void,
    selectedIdentity?: (value: ts.Expression) => boolean,
    selectedRecordKeys?: ReadonlySet<string>,
): void {
    const argument = node.arguments[index];
    if (!argument) return;
    const concreteIdentities = new Map<
        ts.Expression,
        readonly Path[] | undefined
    >();
    const visit = (
        value: ts.Expression,
        path: readonly string[],
        consumer: ts.CallExpression = node,
        parameterIndex = index,
    ): void => {
        if (!typeCanCarryReference(checker.getTypeAtLocation(value))) return;
        const source = consumer.arguments[parameterIndex]!;
        if (selectedIdentity && !concreteIdentities.has(source))
            concreteIdentities.set(
                source,
                concreteArgumentIdentityPaths(
                    checker,
                    source,
                    selectedIdentity,
                    selectedRecordKeys,
                ),
            );
        const identityPaths = concreteIdentities.get(source);
        if (identityPaths?.length === 0) return;
        if (
            callProjection(
                checker,
                consumer,
                parameterIndex,
                path,
                new Set(),
                identityPaths,
            )
        )
            return;
        const current = unwrapExpression(value);
        if (
            ts.isObjectLiteralExpression(current) &&
            plainDataMembers(current) !== undefined
        ) {
            for (const property of current.properties) {
                if (
                    ts.isPropertyAssignment(property) ||
                    ts.isShorthandPropertyAssignment(property)
                )
                    visit(
                        ts.isPropertyAssignment(property)
                            ? property.initializer
                            : property.name,
                        [...path, propertyKey(property.name)!],
                        consumer,
                        parameterIndex,
                    );
            }
            return;
        }
        if (
            ts.isArrayLiteralExpression(current) &&
            !current.elements.some(ts.isSpreadElement)
        ) {
            current.elements.forEach((element, i) => {
                if (!ts.isOmittedExpression(element))
                    visit(
                        element,
                        [...path, String(i)],
                        consumer,
                        parameterIndex,
                    );
            });
            return;
        }
        const collect = (part: ts.Node): "skip" | undefined => {
            // A copied scalar cannot carry its containing object's
            // identity. Nested calls still receive their own analysis.
            if (
                ts.isExpression(part) &&
                !typeCanCarryReference(checker.getTypeAtLocation(part))
            )
                return "skip";
            if (ts.isCallExpression(part)) {
                // The outer consumer receives this call's result, not
                // every reference used to compute it. Only inputs the
                // nested call can retain propagate to that result.
                part.arguments.forEach((argument, argumentIndex) =>
                    visit(argument, [], part, argumentIndex),
                );
                forEachAnalysisNode(part.expression, collect, {
                    functions: "skip",
                });
                return "skip";
            }
            if (
                ts.isIdentifier(part) ||
                ts.isPropertyAccessExpression(part) ||
                ts.isElementAccessExpression(part)
            ) {
                reference(part);
            }
            return undefined;
        };
        forEachAnalysisNode(value, collect, { functions: "skip" });
    };
    visit(argument, []);
}

export function parameterProjectionIsReadOnly(
    checker: ts.TypeChecker,
    declaration: ts.Node,
    index: number,
    path: Path,
    independentFields = false,
    argument?: ts.Expression,
    capturedScalarFacts = false,
): boolean {
    const literal = argument && unwrapExpression(argument);
    // A fresh wrapper may still contain a caller-owned child. Captured
    // scalar facts require a literal owner at every enclosing projection.
    let freshOwner = literal;
    for (const key of path.slice(0, -1)) {
        if (
            !freshOwner ||
            !ts.isObjectLiteralExpression(freshOwner) ||
            plainDataMembers(freshOwner) === undefined
        ) {
            freshOwner = undefined;
            break;
        }
        const child = objectProperty(freshOwner, key);
        freshOwner = child && unwrapExpression(child);
    }
    const keys =
        independentFields &&
        literal &&
        ts.isObjectLiteralExpression(literal) &&
        plainDataMembers(literal) !== undefined
            ? literal.properties.map((property) => propertyKey(property.name!)!)
            : undefined;
    return parameterProjection(
        checker,
        declaration,
        index,
        path,
        new Set(),
        independentFields,
        undefined,
        keys,
        capturedScalarFacts &&
            independentFields &&
            freshOwner !== undefined &&
            ts.isObjectLiteralExpression(freshOwner),
    );
}

function callProjection(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    index: number,
    path: Path,
    active: Set<ts.FunctionLikeDeclaration>,
    identityPaths?: readonly Path[],
): boolean {
    const declaration = calledDeclaration(checker, call);
    if (!declaration) return false;
    const engine = isEngineDeclaration(declaration)
        ? engineBodies()
        : undefined;
    const bodies = engine ? engine.bodies(declaration) : [declaration];
    return (
        bodies !== undefined &&
        bodies.length > 0 &&
        bodies.every((body) => {
            // An argument a spread shifts, or a rest collects, binds no
            // one parameter to prove.
            if (!isSupportedFunction(body)) return false;
            const bound = parameterForArgument(call, body, index);
            return (
                bound !== undefined &&
                bound !== "unknown" &&
                !bound.rest &&
                parameterProjection(
                    engine ? engine.checkerFor(body) : checker,
                    body,
                    index,
                    path,
                    active,
                    false,
                    identityPaths,
                )
            );
        })
    );
}

function parameterProjection(
    checker: ts.TypeChecker,
    declaration: ts.Node,
    index: number,
    path: Path,
    active: Set<ts.FunctionLikeDeclaration>,
    independentFields = false,
    identityPaths?: readonly Path[],
    ownKeys?: readonly string[],
    freshScalarCapture = false,
): boolean {
    if (!isFunctionWithBody(declaration)) return false;
    const parameter = declaration.parameters[index];
    if (
        !parameter ||
        parameter.dotDotDotToken ||
        !ts.isIdentifier(parameter.name)
    )
        return false;
    const symbol = declaredSymbol(checker, parameter.name);
    if (!symbol || active.has(declaration)) return false;
    const cacheKey = JSON.stringify([
        index,
        path,
        independentFields,
        identityPaths,
        ownKeys,
        freshScalarCapture,
    ]);
    let functions = results.get(checker);
    let known = functions?.get(declaration);
    const cached = known?.get(cacheKey);
    if (cached !== undefined) return cached;
    const typeAt = (selected: Path): ts.Type | undefined => {
        let projectedType: ts.Type | undefined = checker.getTypeAtLocation(
            parameter.name,
        );
        for (const key of selected) {
            projectedType =
                projectedType && checker.getNonNullableType(projectedType);
            const property: ts.Symbol | undefined =
                projectedType && checker.getPropertyOfType(projectedType, key);
            projectedType = property
                ? checker.getTypeOfSymbolAtLocation(property, parameter.name)
                : projectedType && arrayElementType(checker, projectedType);
        }
        return projectedType;
    };
    const absent = ownKeys
        ? checker
              .getPropertiesOfType(checker.getTypeAtLocation(parameter.name))
              .filter(
                  (property) =>
                      (property.flags & ts.SymbolFlags.Optional) !== 0 &&
                      !ownKeys.includes(property.name) &&
                      !Object.hasOwn(Object.prototype, property.name),
              )
              .map((property) => property.name)
        : [];
    // Only absence used to prune an optional call is a dependency. Other
    // missing reference fields do not alias the scalar projection being proved.
    const optionalCallAbsence = absent.length
        ? absent.filter((key) => optionalCalls(declaration).has(key))
        : [];
    const selected = (
        identityPaths ?? [path, ...optionalCallAbsence.map((key) => [key])]
    ).map((selectedPath) => {
        const type = typeAt(selectedPath);
        return {
            path: selectedPath,
            type,
            scalar: type !== undefined && !typeCanCarryReference(type),
        };
    });
    // A fresh literal's scalar field has no caller-held owner to mutate later.
    // Follow captures through their bodies instead of treating retention alone
    // as a write. Reference escapes, aliases and writes still use the same proof.
    const inspectCaptures = freshScalarCapture && selected[0]?.scalar === true;
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
    // Every consumer must keep the same conservative alias relation: a
    // sibling retained here cannot be discarded later by a path-only check.
    const mayAffectSelection = (
        from: Path,
        entry: (typeof selected)[number],
    ): boolean => {
        if (overlaps(from, entry.path)) return true;
        if (independentFields || identityPaths) return false;
        const divergent = from.findIndex(
            (key, i) => !keysMayMatch(key, entry.path[i]!),
        );
        const sibling = typeAt(from.slice(0, divergent + 1));
        if (!sibling || typeCanCarryReference(sibling)) {
            // Nominal native handles cannot alias an authored data object.
            // Other reference fields may share children or point back to
            // their parent, despite having different source access paths.
            const siblingHandle = sibling && nativeHandle(sibling);
            const selectedHandle = entry.type && nativeHandle(entry.type);
            return !siblingHandle || selectedHandle !== undefined;
        }
        return false;
    };
    const relevant = (values: readonly Projection[]): Projection[] =>
        values.filter((value) =>
            selected.some((entry) => mayAffectSelection(value.from, entry)),
        );
    const receiver = (node: ts.CallExpression): ts.Expression | undefined => {
        const callee = unwrapExpression(node.expression);
        return ts.isPropertyAccessExpression(callee)
            ? callee.expression
            : undefined;
    };
    const arrayMethod = (node: ts.CallExpression): string | undefined => {
        const called = calledDeclaration(checker, node);
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
        if (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        )
            return project(flow(node.expression), aliasKey(accessKey(node)));
        if (isOperandSelection(node)) return valueOperands(node).flatMap(flow);
        if (ts.isObjectLiteralExpression(node))
            return node.properties.flatMap((property): Projection[] => {
                if (ts.isSpreadAssignment(property)) {
                    const source = flow(property.expression);
                    const type = checker.getNonNullableType(
                        checker.getTypeAtLocation(property.expression),
                    );
                    const properties = checker.getPropertiesOfType(type);
                    if (
                        (type.flags &
                            (ts.TypeFlags.Any |
                                ts.TypeFlags.Unknown |
                                ts.TypeFlags.TypeParameter)) !==
                            0 ||
                        properties.some((member) =>
                            member.declarations?.some(
                                ts.isGetAccessorDeclaration,
                            ),
                        )
                    )
                        return [...source];
                    // A shallow copy carries reference-valued children, not
                    // its source object or copied scalar fields.
                    const keys = properties
                        .filter((member) =>
                            typeCanCarryReference(
                                checker.getTypeOfSymbolAtLocation(
                                    member,
                                    property.expression,
                                ),
                            ),
                        )
                        .map((member) => member.name);
                    if (
                        checker
                            .getIndexInfosOfType(type)
                            .some((index) => typeCanCarryReference(index.type))
                    )
                        keys.push(ANY_KEY);
                    return keys.flatMap((key) =>
                        project(source, key).map((entry) => ({
                            at: [key, ...entry.at],
                            from: entry.from,
                        })),
                    );
                }
                if (
                    !ts.isPropertyAssignment(property) &&
                    !ts.isShorthandPropertyAssignment(property)
                )
                    return [];
                const value = ts.isPropertyAssignment(property)
                    ? property.initializer
                    : property.name;
                return flow(value).map((entry) => ({
                    at: [aliasKey(propertyKey(property.name)), ...entry.at],
                    from: entry.from,
                }));
            });
        if (ts.isArrayLiteralExpression(node))
            return arrayLiteralSlots(node).flatMap(
                ({ element, index }): Projection[] => {
                    if (ts.isOmittedExpression(element)) return [];
                    const values = ts.isSpreadElement(element)
                        ? project(flow(element.expression), ANY_KEY)
                        : flow(element);
                    const elementType = ts.isSpreadElement(element)
                        ? arrayElementType(
                              checker,
                              checker.getTypeAtLocation(element.expression),
                          )
                        : undefined;
                    if (elementType && !typeCanCarryReference(elementType))
                        return [];
                    return values.map((entry) => ({
                        at: [
                            aliasKey(
                                index === undefined ? undefined : String(index),
                            ),
                            ...entry.at,
                        ],
                        from: entry.from,
                    }));
                },
            );
        if (ts.isCallExpression(node) && arrayMethod(node) === "slice") {
            const owner = receiver(node)!;
            const element = arrayElementType(
                checker,
                checker.getTypeAtLocation(owner),
            );
            return element && !typeCanCarryReference(element)
                ? []
                : nest(project(flow(owner), ANY_KEY), ANY_KEY);
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
        // A rest is a new collection of the remaining members.
        for (const { target, read, fallback } of patternSlots(name))
            bind(target, [
                ...(read.kind === "member"
                    ? project(values, aliasKey(read.key))
                    : nest(project(values, ANY_KEY), ANY_KEY)),
                ...(fallback ? flow(fallback) : []),
            ]);
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
            {
                ...(inspectCaptures ? {} : { functions: "skip" as const }),
                types: "skip",
            },
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
                                project(flow(node.expression), ANY_KEY),
                            );
                },
                {
                    ...(inspectCaptures ? {} : { functions: "skip" as const }),
                    types: "skip",
                },
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
        return project(flow(node.expression), aliasKey(accessKey(node))).some(
            (value) =>
                selected.some(
                    (entry) =>
                        mayAffectSelection(value.from, entry) &&
                        (value.from.length > entry.path.length || entry.scalar),
                ),
        );
    };
    const captures = (identifier: ts.Identifier): boolean => {
        let values = aliases.get(declaredSymbol(checker, identifier)!) ?? [];
        if (values.length === 0) return false;
        let expression: ts.Expression = identifier;
        while (
            (ts.isPropertyAccessExpression(expression.parent) ||
                ts.isElementAccessExpression(expression.parent)) &&
            expression.parent.expression === expression
        ) {
            const access = expression.parent;
            const property = accessedPropertySymbol(checker, access);
            if (
                property?.declarations?.some(
                    (item) =>
                        ts.isGetAccessorDeclaration(item) ||
                        ts.isSetAccessorDeclaration(item),
                ) ||
                (!independentFields &&
                    ts.isCallExpression(access.parent) &&
                    access.parent.expression === access)
            )
                return relevant(values).length > 0;
            values = project(values, aliasKey(accessKey(access)));
            expression = access;
        }
        return relevant(values).length > 0;
    };
    const absentOptionalCall = (node: ts.Node): boolean => {
        if (!ts.isCallExpression(node) || !node.questionDotToken) return false;
        const callee = unwrapExpression(node.expression);
        if (!ts.isPropertyAccessExpression(callee)) return false;
        const owners = flow(callee.expression);
        return (
            absent.includes(callee.name.text) &&
            owners.length > 0 &&
            owners.every(
                (owner) => owner.at.length === 0 && owner.from.length === 0,
            )
        );
    };
    /** An argument carrying the selection the callee's proof cannot keep. */
    const argumentsAffectSelection = (
        node: ts.CallExpression | ts.NewExpression,
    ): boolean =>
        (node.arguments ?? []).some((argument, argumentIndex) =>
            flow(argument).some((value) =>
                selected.some(
                    (entry) =>
                        mayAffectSelection(value.from, entry) &&
                        !callProjection(
                            checker,
                            node,
                            argumentIndex,
                            [
                                ...value.at,
                                ...(value.from.length < entry.path.length
                                    ? entry.path.slice(value.from.length)
                                    : []),
                            ],
                            active,
                        ),
                ),
            ),
        );
    const unsafe =
        changed ||
        (!ts.isBlock(declaration.body) && uses(declaration.body)) ||
        roots.some((root) =>
            someAnalysisNode(
                root,
                (node) => {
                    if (absentOptionalCall(node)) return "skip";
                    if (ts.isFunctionLike(node)) {
                        const capturesSelection = someAnalysisNode(
                            node,
                            (part) =>
                                absentOptionalCall(part)
                                    ? "skip"
                                    : ts.isIdentifier(part) && captures(part),
                            { types: "skip" },
                        );
                        if (!capturesSelection) return "skip";
                        if (!inspectCaptures) return true;
                    }
                    // A pattern default's value flows into its leaf too.
                    const writes = writeSites(node);
                    if (writes.length > 0 || isAssignmentExpression(node))
                        return (
                            writes.some(({ target }) => stores(target)) ||
                            (isAssignmentExpression(node) && uses(node.right))
                        );
                    if (
                        (ts.isReturnStatement(node) ||
                            ts.isThrowStatement(node)) &&
                        node.expression &&
                        uses(node.expression)
                    )
                        return true;
                    // A fresh scalar projection has no external owner alias;
                    // captured writes and escapes are checked throughout the body.
                    if (
                        (isSuspensionPoint(node) && !inspectCaptures) ||
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
                    // Independent fields reach a constructor as they reach a
                    // call: only an argument the selection flows into needs
                    // the constructor's own proof.
                    if (ts.isNewExpression(node))
                        return independentFields || identityPaths
                            ? argumentsAffectSelection(node)
                            : (node.arguments?.some(
                                  (argument) => flow(argument).length > 0,
                              ) ?? false);
                    if (!ts.isCallExpression(node)) return false;
                    const owner = receiver(node);
                    if (!owner && uses(node.expression)) return true;
                    if (
                        !independentFields &&
                        !identityPaths &&
                        node.arguments.some(
                            (argument) =>
                                flow(argument).length > 0 && !uses(argument),
                        )
                    )
                        return true;
                    // Unrelated receivers still need a resolved nonreentrant
                    // read: an opaque method can call back into the owner.
                    if (
                        owner &&
                        flow(owner).length > 0 &&
                        ((!independentFields && !identityPaths) || uses(owner))
                    ) {
                        const method = arrayMethod(node);
                        const element = arrayElementType(
                            checker,
                            checker.getTypeAtLocation(owner),
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
                                (!uses(owner) ||
                                    !element ||
                                    typeCanCarryReference(element)))
                        )
                            return true;
                    }
                    return argumentsAffectSelection(node);
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
