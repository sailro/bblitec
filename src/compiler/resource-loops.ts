import ts from "typescript";
import { declaredInDomLibrary, isPinnedType, pinnedHandleKind } from "./data-types.js";
import {
    staticNumberValue,
    type PositiveIntegerContext,
} from "./option-helpers.js";
import type { CompilerSymbols } from "./symbols.js";
import {
    aliasedMutationScan,
    callArgumentIsReadOnly,
    isSupportedFunction,
    rootIdentifier,
    tryResolveFunctionDeclaration,
    unwrapExpression,
    writesThroughTrackedRoot,
    type SupportedFunction,
} from "./user-functions.js";
import { nativeDataIterationIntrinsics, runtimeOnlyIntrinsics } from "./intrinsics/registry.js";
import { resizingArrayMethods } from "./data-methods.js";
import { sceneNodeTransformDescriptor } from "../scene-node-transform-descriptor.js";

export interface ResourceLoopContext extends PositiveIntegerContext {
    readonly checker: ts.TypeChecker;
    readonly symbols: CompilerSymbols;
    constArrayLiteral(expression: ts.Expression): ts.ArrayLiteralExpression | undefined;
    knownCollectionCardinality(expression: ts.Expression): number | undefined;
}

function resolvedLoopCallee(
    context: Pick<ResourceLoopContext, "checker"> & Partial<Pick<ResourceLoopContext, "lookupOptional">>,
    call: ts.CallExpression | ts.NewExpression,
): ts.Signature["declaration"] {
    const callee = unwrapExpression(call.expression);
    const value = ts.isIdentifier(callee) ? context.lookupOptional?.(callee) : undefined;
    if (value?.kind === "callback" && value.cpp.length === 0 && value.callbackDeclaration) {
        const declaration = value.callbackDeclaration;
        return ts.isIdentifier(declaration)
            ? tryResolveFunctionDeclaration(context.checker, declaration)
            : declaration;
    }
    return (ts.isIdentifier(callee)
        ? tryResolveFunctionDeclaration(context.checker, callee)
        : undefined) ?? context.checker.getResolvedSignature(call)?.declaration;
}

function expressionHandleKind(
    context: Pick<ResourceLoopContext, "checker">,
    expression: ts.Expression,
) {
    const type = context.checker.getNonNullableType(context.checker.getTypeAtLocation(expression));
    return pinnedHandleKind(type) ??
        (isPinnedType(type, ["StandardMaterialProps", "PbrMaterialProps"]) ? "material" : undefined);
}

function nativeSceneMembershipChange(
    context: Pick<ResourceLoopContext, "checker">,
    imported: string,
    call: ts.CallExpression,
): boolean {
    if (imported !== "addToScene" && imported !== "removeFromScene") return false;
    const kind = call.arguments[1] && expressionHandleKind(context, call.arguments[1]);
    return kind === "mesh" || kind === "transform-node";
}

function nativeTransformSet(context: Pick<ResourceLoopContext, "checker">, call: ts.CallExpression): boolean {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "set") return false;
    const owner = unwrapExpression(callee.expression);
    if (!ts.isPropertyAccessExpression(owner) || !sceneNodeTransformDescriptor(owner.name.text)) return false;
    const kind = expressionHandleKind(context, owner.expression);
    return kind === "mesh" || kind === "transform-node";
}

/** Follow executed local calls, not merely the source nesting around a loop. */
export function walkReachedLoopNodes(
    context: Pick<ResourceLoopContext, "checker" | "symbols">,
    root: ts.Node,
    visit: (node: ts.Node) => boolean | void,
): void {
    const functions = new Set<ts.Node>();
    const walkFunction = (node: ts.Node): void => {
        if (functions.has(node)) return;
        functions.add(node);
        if (
            (isSupportedFunction(node) || ts.isConstructorDeclaration(node) ||
                ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
            node.body
        ) {
            walk(node.body);
        }
    };
    const walk = (node: ts.Node): void => {
        if (visit(node) === false) return;
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const callee = unwrapExpression(node.expression);
            const imported = ts.isIdentifier(callee)
                ? context.symbols.importedName(callee)
                : undefined;
            if (!imported) {
                const called = resolvedLoopCallee(context, node);
                if (called) walkFunction(called);
            }
            if (ts.isNewExpression(node)) {
                const declaration = context.checker.getTypeAtLocation(callee)
                    .symbol?.valueDeclaration;
                if (declaration &&
                    (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) {
                    for (const member of declaration.members) {
                        if (ts.isPropertyDeclaration(member) && member.initializer) walk(member.initializer);
                    }
                }
            }
            for (const argument of node.arguments ?? []) {
                const unwrapped = unwrapExpression(argument);
                if (isSupportedFunction(unwrapped)) walkFunction(unwrapped);
            }
        }
        if (ts.isPropertyAccessExpression(node)) {
            for (const declaration of context.checker.getSymbolAtLocation(node.name)
                ?.declarations ?? []) {
                if (ts.isGetAccessorDeclaration(declaration) ||
                    ts.isSetAccessorDeclaration(declaration)) walkFunction(declaration);
            }
        }
        ts.forEachChild(node, (child) => {
            if (!ts.isFunctionLike(child)) walk(child);
        });
    };
    walk(root);
}

export function requiresStaticLoopIteration(
    context: Pick<ResourceLoopContext, "checker" | "symbols">,
    statement: ts.Statement,
): boolean {
    let required = false;
    walkReachedLoopNodes(context, statement, (node) => {
        if (required) return false;
        if (ts.isCallExpression(node)) {
            const callee = unwrapExpression(node.expression);
            const imported = ts.isIdentifier(callee)
                ? context.symbols.importedName(callee)
                : undefined;
            if (imported && !runtimeOnlyIntrinsics.has(imported)) {
                required = true;
                return false;
            }
        }
    });
    return required;
}

/** Plain-data iteration can update existing native resources, not specialize them. */
export function requiresStaticDataIteration(
    context: ResourceLoopContext,
    statement: ts.Statement,
): boolean {
    let required = false;
    walkReachedLoopNodes(context, statement, (node) => {
        if (required) return false;
        const symbol = ts.isPropertyAccessExpression(node)
            ? context.checker.getSymbolAtLocation(node.name)
            : ts.isCallExpression(node) && ts.isIdentifier(node.expression)
                ? context.checker.getSymbolAtLocation(node.expression)
                : undefined;
        if (symbol && declaredInDomLibrary(symbol)) {
            required = true;
            return false;
        }
        if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
            required = true;
            return false;
        }
        if (ts.isCallExpression(node)) {
            const callee = unwrapExpression(node.expression);
            const imported = ts.isIdentifier(callee)
                ? context.symbols.importedName(callee)
                : undefined;
            if (imported && !nativeDataIterationIntrinsics.has(imported) &&
                !nativeSceneMembershipChange(context, imported, node) &&
                !runtimeProfileCall(context, imported, node)) {
                required = true;
                return false;
            }
        }
        const target = ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            ? node.left
            : (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
                (node.operator === ts.SyntaxKind.PlusPlusToken ||
                    node.operator === ts.SyntaxKind.MinusMinusToken)
                ? node.operand
                : undefined;
        if (!target) return;
        let member = unwrapExpression(target);
        while (ts.isPropertyAccessExpression(member)) {
            const kind = expressionHandleKind(context, member.expression);
            if (kind) {
                const property = member.name.text;
                required = kind === "mesh" || kind === "transform-node"
                    ? !runtimeMeshProperties.has(property) &&
                        property !== "material" && property !== "receiveShadows"
                    : kind === "material"
                        ? !runtimeMaterialProperties.has(property)
                        : true;
                return !required;
            }
            member = unwrapExpression(member.expression);
        }
    });
    return required;
}

/** A folded bound must not be invalidated by the loop or its called helpers. */
export function loopBoundMayChange(
    context: Pick<ResourceLoopContext, "checker" | "symbols">,
    body: ts.Statement,
    bound: ts.Expression,
): boolean {
    const unwrapped = unwrapExpression(bound);
    const arrayLength = ts.isPropertyAccessExpression(unwrapped) &&
        unwrapped.name.text === "length" &&
        ts.isIdentifier(unwrapExpression(unwrapped.expression));
    const dependencies: ts.Identifier[] = [];
    const reads = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node)) {
            reads(node.expression);
        } else if (ts.isIdentifier(node)) {
            dependencies.push(node);
        } else {
            ts.forEachChild(node, reads);
        }
    };
    reads(bound);
    if (dependencies.length === 0) return false;
    const reached = new Set<ts.Node>();
    walkReachedLoopNodes(context, body, (node) => { reached.add(node); });
    return dependencies.some((identifier) => aliasedMutationScan(
        identifier,
        (name) => context.symbols.valueSymbol(name),
        {
            aliasingInitializer: (initializer, scan) => {
                if (arrayLength) return scan.namesAlias(unwrapExpression(initializer));
                const root = rootIdentifier(initializer);
                if (!root || !scan.namesAlias(root)) return false;
                const type = context.checker.getTypeAtLocation(initializer);
                return (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection | ts.TypeFlags.Union)) !== 0;
            },
            mutates: (node, scan) => {
                if (!reached.has(node)) return false;
                const namesAlias = (expression: ts.Expression): boolean => {
                    if (arrayLength) {
                        const target = unwrapExpression(expression);
                        return scan.namesAlias(target) ||
                            ((ts.isElementAccessExpression(target) ||
                                (ts.isPropertyAccessExpression(target) && target.name.text === "length")) &&
                                scan.namesAlias(unwrapExpression(target.expression)));
                    }
                    const root = rootIdentifier(expression);
                    return root !== undefined && scan.namesAlias(root);
                };
                return writesThroughTrackedRoot(node, namesAlias,
                    arrayLength ? (method) => resizingArrayMethods.has(method) : undefined) ||
                    (ts.isCallExpression(node) && node.arguments.some(
                        (argument, index) => (arrayLength
                            ? scan.namesAlias(unwrapExpression(argument))
                            : namesAlias(argument)) &&
                            !callArgumentIsReadOnly(context.checker, node, index),
                    ));
            },
        },
    ));
}

export interface StaticIndexLoop {
    indexBinding: ts.Identifier;
    start: number;
    end: ts.Expression;
    inclusive: boolean;
}

/** Count the admitted integer range without dropping an inclusive endpoint. */
export function staticIndexLoopIterations(
    shape: StaticIndexLoop,
    end: number,
): number | undefined {
    if (!Number.isSafeInteger(end)) return undefined;
    const count = Math.max(0, end - shape.start + Number(shape.inclusive));
    return Number.isSafeInteger(count) ? count : undefined;
}

/** The counted form shared by the static unroller and composition analysis. */
export function staticIndexLoopShape(
    symbols: CompilerSymbols,
    statement: ts.ForStatement,
): StaticIndexLoop | undefined {
    if (
        !statement.initializer ||
        !ts.isVariableDeclarationList(statement.initializer) ||
        statement.initializer.declarations.length !== 1 ||
        !statement.condition ||
        !ts.isBinaryExpression(statement.condition) ||
        (statement.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken &&
            statement.condition.operatorToken.kind !== ts.SyntaxKind.LessThanEqualsToken) ||
        !statement.incrementor
    ) {
        return undefined;
    }
    const declaration = statement.initializer.declarations[0]!;
    const incrementor = statement.incrementor;
    if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isNumericLiteral(declaration.initializer) ||
        !ts.isIdentifier(statement.condition.left) ||
        !(ts.isPostfixUnaryExpression(incrementor) || ts.isPrefixUnaryExpression(incrementor)) ||
        incrementor.operator !== ts.SyntaxKind.PlusPlusToken ||
        !ts.isIdentifier(incrementor.operand)
    ) {
        return undefined;
    }
    const symbol = symbols.valueSymbol(declaration.name);
    const start = Number(declaration.initializer.text);
    if (
        !symbol ||
        symbols.valueSymbol(statement.condition.left) !== symbol ||
        symbols.valueSymbol(incrementor.operand) !== symbol ||
        !Number.isSafeInteger(start) ||
        start < 0
    ) {
        return undefined;
    }
    return {
        indexBinding: declaration.name,
        start,
        end: statement.condition.right,
        inclusive: statement.condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken,
    };
}

export interface ParameterizedResourceLoop {
    iterations: number;
    /** Static bodies avoided, including nested loops and called helpers. */
    expansion: number;
}

export type ResourceLoop = ts.ForStatement | ts.ForOfStatement;

// These factories record only an attribute shape and emit native construction.
// Counts that the existing option lowerers require at generation stay invariant;
// dimensions and transforms remain ordinary runtime numeric expressions.
const meshFactories: ReadonlyMap<string, readonly string[]> = new Map([
    ["createBox", []],
    ["createPlane", []],
    ["createGround", ["subdivisions"]],
    ["createSphere", ["segments"]],
    ["createTorus", ["tessellation"]],
]);
/** These native factories have a closed call-site profile, not a baked body. */
export const runtimeProfileConstructionIntrinsics: ReadonlySet<string> = new Set([
    ...meshFactories.keys(),
    "createMeshFromData",
    "createStandardMaterial",
    "createShaderMaterial",
]);

function runtimeProfileCall(
    context: ResourceLoopContext,
    imported: string,
    call: ts.CallExpression,
): boolean {
    if (!runtimeProfileConstructionIntrinsics.has(imported)) return false;
    const options = meshFactories.get(imported);
    if (!options?.length || !call.arguments[1]) return true;
    const expression = context.resolveStaticExpression(call.arguments[1]);
    if (!ts.isObjectLiteralExpression(expression)) return false;
    return expression.properties.every((property) => {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
        const name = property.name;
        if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) return false;
        return !options.includes(name.text) ||
            staticNumberValue(context, ts.isPropertyAssignment(property) ? property.initializer : property.name) !== undefined;
    });
}
const runtimeMeshProperties = new Set([
    "position", "rotation", "rotationQuaternion", "scaling",
    "name", "visibility", "visible", "isVisible", "isPickable", "renderOrder",
    "boundMin", "boundMax",
]);
const runtimeMaterialProperties = new Set([
    "diffuseColor", "specularColor", "ambientColor", "emissiveColor", "specularPower",
]);

/**
 * Prove a fixed composition sequence without compiling speculative expressions.
 * This is not a second lowerer: native construction still uses the normal
 * statement/intrinsic paths, and only their composition records are repeated.
 */
export function parameterizedResourceLoop(
    context: ResourceLoopContext,
    statement: ResourceLoop,
    knownIterations?: number,
): ParameterizedResourceLoop | undefined {
    const active = new Set<SupportedFunction>();
    const indices = new Set<ts.Symbol>();
    const bindings = new Map<ts.Symbol, ts.Expression>();
    const mutated = new Set<ts.Symbol>();
    const rebound = new Set<ts.Symbol>();
    const markMutation = (expression: ts.Expression): false => {
        const root = rootIdentifier(expression);
        const symbol = root && context.symbols.valueSymbol(root);
        if (symbol) mutated.add(symbol);
        return false;
    };
    walkReachedLoopNodes(context, statement.statement, (node) => {
        writesThroughTrackedRoot(node, (target) => {
            if (!ts.isCallExpression(node) && ts.isIdentifier(target)) {
                const symbol = context.symbols.valueSymbol(target);
                if (symbol) rebound.add(symbol);
            }
            return markMutation(target);
        });
        if (ts.isCallExpression(node)) {
            const called = resolvedLoopCallee(context, node);
            if (isSupportedFunction(called) && called.body) {
                node.arguments.forEach((argument, index) => {
                    if (!callArgumentIsReadOnly(context.checker, node, index)) {
                        markMutation(argument);
                    }
                });
            }
        }
    });
    let safe = true;
    let reachesConstruction = false;
    const resolve = (expression: ts.Expression): ts.Expression => {
        let current = unwrapExpression(expression);
        const seen = new Set<ts.Symbol>();
        while (ts.isIdentifier(current)) {
            const symbol = context.symbols.valueSymbol(current);
            if (!symbol || seen.has(symbol) || indices.has(symbol)) break;
            seen.add(symbol);
            const bound = bindings.get(symbol);
            const next = bound ?? context.resolveStaticExpression(current);
            if (next === current) break;
            current = unwrapExpression(next);
        }
        return current;
    };
    const staticContext: PositiveIntegerContext = {
        resolveStaticExpression: resolve,
        lookup: (identifier) => context.lookup(identifier),
        lookupOptional: (identifier) =>
            indices.has(context.symbols.valueSymbol(identifier)!)
                ? undefined
                : context.lookupOptional(identifier),
        fail: (node, message) => context.fail(node, message),
    };
    const boundValue = (expression: ts.Expression): number | undefined => {
        const folded = staticNumberValue(staticContext, expression);
        if (folded !== undefined) return folded;
        const node = resolve(expression);
        return ts.isPropertyAccessExpression(node) &&
            (node.name.text === "length" || node.name.text === "size")
            ? context.knownCollectionCardinality(resolve(node.expression))
            : undefined;
    };
    const invariant = (
        expression: ts.Expression,
        seen = new Set<ts.Symbol>(),
    ): boolean => {
        const node = unwrapExpression(expression);
        if (ts.isIdentifier(node)) {
            const symbol = context.symbols.valueSymbol(node);
            if (!symbol || seen.has(symbol)) return false;
            if (indices.has(symbol) || rebound.has(symbol)) return false;
            const bound = bindings.get(symbol);
            const value = bound ? undefined : context.lookupOptional(node);
            if (value?.kind === "engine" || value?.kind === "scene" ||
                value?.kind === "material" || value?.kind === "texture") {
                return true;
            }
            const declaration = symbol.valueDeclaration;
            const initializer =
                bound ??
                (declaration && ts.isVariableDeclaration(declaration)
                    ? declaration.initializer
                    : undefined);
            const localStandard = initializer && ts.isCallExpression(initializer) &&
                ts.isIdentifier(initializer.expression) &&
                context.symbols.importedName(initializer.expression) === "createStandardMaterial";
            if (mutated.has(symbol) && !localStandard) return false;
            if (initializer) {
                return invariant(initializer, new Set([...seen, symbol]));
            }
            return context.lookupOptional(node) !== undefined;
        }
        if (ts.isPropertyAccessExpression(node)) {
            return invariant(node.expression, seen);
        }
        if (ts.isCallExpression(node)) {
            return ts.isIdentifier(node.expression) &&
                context.symbols.importedName(node.expression) ===
                    "createStandardMaterial";
        }
        if (ts.isObjectLiteralExpression(node)) {
            return node.properties.every((property) =>
                ts.isPropertyAssignment(property)
                    ? invariant(property.initializer, seen)
                    : ts.isShorthandPropertyAssignment(property) &&
                        invariant(property.name, seen),
            );
        }
        let answer = true;
        ts.forEachChild(node, (child) => {
            if (ts.isExpression(child) && !invariant(child, seen)) answer = false;
        });
        return answer;
    };
    const forOfCount = (loop: ts.ForOfStatement): number | undefined => {
        if (loop === statement && knownIterations !== undefined) return knownIterations;
        if (loop.awaitModifier ||
            !ts.isVariableDeclarationList(loop.initializer) ||
            loop.initializer.declarations.length !== 1) return undefined;
        const count = context.knownCollectionCardinality(loop.expression);
        if (count !== undefined && !loopBoundMayChange(context, loop.statement, loop.expression)) return count;
        if (!invariant(loop.expression)) return undefined;
        const resolved = resolve(loop.expression);
        const expression = context.constArrayLiteral(resolved) ?? resolved;
        if (ts.isArrayLiteralExpression(expression)) {
            let effect = false;
            const check = (node: ts.Node): void => {
                if (ts.isCallExpression(node) || ts.isNewExpression(node) ||
                    ts.isSpreadElement(node) || ts.isOmittedExpression(node)) {
                    effect = true;
                    return;
                }
                ts.forEachChild(node, check);
            };
            check(expression);
            return effect ? undefined : expression.elements.length;
        }
        const value = ts.isIdentifier(expression)
            ? context.lookupOptional(expression)
            : undefined;
        if (value?.collectionCardinality || value?.staticElementsOwner?.collectionCardinality) {
            return context.knownCollectionCardinality(loop.expression);
        }
        return (value?.tupleElements ??
            value?.staticElementsOwner?.staticElements ??
            value?.staticElements)?.length ?? context.knownCollectionCardinality(loop.expression);
    };
    const visitFunction = (
        call: ts.CallExpression,
        fn: SupportedFunction,
        conditional: boolean,
    ): number => {
        if (!fn.body || active.has(fn)) {
            safe = false;
            return 0;
        }
        active.add(fn);
        const previous = new Map(bindings);
        fn.parameters.forEach((parameter, index) => {
            const argument = call.arguments[index] ?? parameter.initializer;
            if (ts.isIdentifier(parameter.name) && argument) {
                bindings.set(context.symbols.valueSymbol(parameter.name)!, resolve(argument));
            }
        });
        let work = 0;
        if (ts.isBlock(fn.body)) {
            for (const [index, child] of fn.body.statements.entries()) {
                if (ts.isReturnStatement(child) && index === fn.body.statements.length - 1) {
                    if (child.expression) work += visit(child.expression, conditional);
                } else {
                    work += visit(child, conditional);
                }
            }
        } else {
            work += visit(fn.body, conditional);
        }
        bindings.clear();
        for (const [symbol, expression] of previous) bindings.set(symbol, expression);
        active.delete(fn);
        return work;
    };
    const visit = (node: ts.Node, conditional: boolean): number => {
        if (!safe || ts.isFunctionLike(node)) return 0;
        if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
            const condition = resolve(ts.isIfStatement(node) ? node.expression : node.condition);
            const fixed = condition.kind === ts.SyntaxKind.TrueKeyword
                ? true
                : condition.kind === ts.SyntaxKind.FalseKeyword
                    ? false
                    : ts.isIdentifier(condition) &&
                        !indices.has(context.symbols.valueSymbol(condition)!) &&
                        !mutated.has(context.symbols.valueSymbol(condition)!)
                        ? context.lookupOptional(condition)?.staticBoolean
                        : undefined;
            if (fixed !== undefined) {
                const selected = ts.isIfStatement(node)
                    ? fixed ? node.thenStatement : node.elseStatement
                    : fixed ? node.whenTrue : node.whenFalse;
                return selected ? visit(selected, conditional) : 0;
            }
        }
        if (ts.isForStatement(node)) {
            const shape = staticIndexLoopShape(context.symbols, node);
            const end = shape && !loopBoundMayChange(context, node.statement, shape.end)
                ? boundValue(shape.end)
                : undefined;
            const count = shape && end !== undefined
                ? staticIndexLoopIterations(shape, end) : undefined;
            if (!shape || count === undefined) {
                safe = false;
                return 0;
            }
            const symbol = context.symbols.valueSymbol(shape.indexBinding)!;
            indices.add(symbol);
            const work = count === 0 ? 0 : visit(node.statement, conditional);
            indices.delete(symbol);
            return Math.max(1, work) * count;
        }
        if (ts.isForOfStatement(node)) {
            const count = forOfCount(node);
            if (count === undefined || !ts.isVariableDeclarationList(node.initializer)) {
                safe = false;
                return 0;
            }
            const bound: ts.Symbol[] = [];
            const bind = (name: ts.BindingName): void => {
                if (ts.isIdentifier(name)) {
                    const symbol = context.symbols.valueSymbol(name);
                    if (symbol) {
                        indices.add(symbol);
                        bound.push(symbol);
                    }
                } else {
                    for (const element of name.elements) {
                        if (ts.isBindingElement(element)) bind(element.name);
                    }
                }
            };
            bind(node.initializer.declarations[0]!.name);
            const work = count === 0 ? 0 : visit(node.statement, conditional);
            for (const symbol of bound) indices.delete(symbol);
            return Math.max(1, work) * count;
        }
        if (
            ts.isWhileStatement(node) || ts.isDoStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isBreakStatement(node) || ts.isContinueStatement(node) ||
            ts.isReturnStatement(node) || ts.isTryStatement(node) ||
            ts.isAwaitExpression(node) || ts.isNewExpression(node)
        ) {
            safe = false;
            return 0;
        }
        if (writesThroughTrackedRoot(node, (target) =>
            ts.isIdentifier(target) &&
            indices.has(context.symbols.valueSymbol(target)!),
        )) {
            safe = false;
            return 0;
        }
        if (ts.isPropertyAccessExpression(node) &&
            context.checker.getSymbolAtLocation(node.name)?.declarations?.some(
                (declaration) => (ts.isGetAccessorDeclaration(declaration) ||
                    ts.isSetAccessorDeclaration(declaration)) && declaration.body !== undefined,
            )) {
            safe = false;
            return 0;
        }
        const assignment = ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            ? { target: node.left, value: node.right }
            : (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
                (node.operator === ts.SyntaxKind.PlusPlusToken ||
                    node.operator === ts.SyntaxKind.MinusMinusToken)
                ? { target: node.operand, value: undefined }
                : undefined;
        if (assignment) {
            const target = unwrapExpression(assignment.target);
            // An outer optional handle would retain one arbitrary iteration's
            // composition identity. Containers already withdraw that identity.
            if (ts.isIdentifier(target) && expressionHandleKind(context, target)) {
                safe = false;
                return 0;
            }
            let lane = target;
            while (ts.isPropertyAccessExpression(lane)) {
                const kind = expressionHandleKind(context, lane.expression);
                if (kind) {
                    const property = lane.name.text;
                    const fixed = assignment.value !== undefined && invariant(assignment.value);
                    if (kind === "material") {
                        if (!runtimeMaterialProperties.has(property) &&
                            (conditional || !fixed)) safe = false;
                    } else if (kind !== "mesh" && kind !== "transform-node") {
                        safe = false;
                    } else if (property === "material") {
                        if (conditional || assignment.value === undefined) safe = false;
                    } else if (property === "receiveShadows") {
                        if (conditional || !fixed) safe = false;
                    } else if (!runtimeMeshProperties.has(property)) {
                        safe = false;
                    }
                    break;
                }
                lane = unwrapExpression(lane.expression);
            }
        }
        if (ts.isCallExpression(node)) {
            const callee = unwrapExpression(node.expression);
            const imported = ts.isIdentifier(callee)
                ? context.symbols.importedName(callee)
                : undefined;
            let work = 0;
            for (const argument of node.arguments) {
                if (ts.isFunctionLike(unwrapExpression(argument))) {
                    safe = false;
                    return 0;
                }
                work += visit(argument, conditional);
            }
            if (imported) {
                const staticOptions = meshFactories.get(imported);
                if (staticOptions || imported === "createStandardMaterial") {
                    if (conditional) safe = false;
                    reachesConstruction = true;
                    if (staticOptions?.length && node.arguments[1]) {
                        const options = resolve(node.arguments[1]);
                        if (!ts.isObjectLiteralExpression(options)) {
                            safe = false;
                        } else {
                            for (const property of options.properties) {
                                if (ts.isPropertyAssignment(property) ||
                                    ts.isShorthandPropertyAssignment(property)) {
                                    const name = property.name;
                                    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
                                        if (staticOptions.includes(name.text) &&
                                            !invariant(ts.isPropertyAssignment(property)
                                                ? property.initializer : property.name)) {
                                            safe = false;
                                        }
                                    }
                                } else {
                                    safe = false;
                                }
                            }
                        }
                    }
                } else if (imported === "addToScene" || imported === "removeFromScene") {
                    if (!nativeSceneMembershipChange(context, imported, node)) safe = false;
                } else if (imported !== "setParent" && imported !== "markMeshDirty" &&
                    !runtimeOnlyIntrinsics.has(imported)) {
                    safe = false;
                }
                return work + 1;
            }
            const called = resolvedLoopCallee(context, node);
            if (isSupportedFunction(called) && called.body) {
                return work + visitFunction(node, called, conditional);
            }
            // Native data/Math methods have library signatures. An unresolved
            // callback or opaque method might conceal generation-time effects.
            if (!called?.getSourceFile().hasNoDefaultLib && !nativeTransformSet(context, node)) safe = false;
            return work + 1;
        }
        const guarded = conditional || ts.isIfStatement(node) ||
            ts.isConditionalExpression(node) || ts.isSwitchStatement(node) ||
            (ts.isBinaryExpression(node) &&
                (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                    node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken));
        let work = 0;
        ts.forEachChild(node, (child) => { work += visit(child, guarded); });
        return work + (ts.isStatement(node) && !ts.isBlock(node) ? 1 : 0);
    };
    const shape = ts.isForStatement(statement)
        ? staticIndexLoopShape(context.symbols, statement)
        : undefined;
    const end = shape && boundValue(shape.end);
    const iterations = ts.isForOfStatement(statement)
        ? forOfCount(statement)
        : shape && end !== undefined
            ? staticIndexLoopIterations(shape, end)
            : undefined;
    if (iterations === undefined) return undefined;
    const expansion = visit(statement, false);
    return safe && reachesConstruction
        ? { iterations, expansion }
        : undefined;
}
