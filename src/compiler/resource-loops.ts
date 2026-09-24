import { EmissionSet, EmissionMap } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    isPinnedType,
    pinnedHandleKind,
    platformHandleKind,
} from "./data-types.js";
import { propertyRules } from "./properties.js";
import {
    staticNumberValue,
    type PositiveIntegerContext,
} from "./option-helpers.js";
import {
    aliasTarget,
    declarationInDefaultLibrary,
    declaredInDomLibrary,
    libraryGlobal,
    type CompilerSymbols,
} from "./symbols.js";
import {
    aliasedMutationScan,
    callArgumentIsReadOnly,
    isSupportedFunction,
    parameterIsReadOnly,
    tryResolveFunctionDeclaration,
    writesThroughTrackedRoot,
    type SupportedFunction,
} from "./user-functions.js";
import {
    isAssignmentExpression,
    isUpdateExpression,
    rootIdentifier,
    unwrapExpression,
} from "./syntax.js";
import {
    nativeDataIterationIntrinsics,
    runtimeOnlyIntrinsics,
    sharedBodyIntrinsics,
} from "./intrinsics/registry.js";
import { isMaterialCallEffectIntrinsic } from "./intrinsics/material.js";
import { isAssetCallEffectIntrinsic } from "./intrinsics/asset.js";
import { resizingArrayMethods } from "./data-methods.js";
import { sceneNodeTransformDescriptor } from "../scene-node-transform-descriptor.js";

interface ResourceLoopContext
    extends
        PositiveIntegerContext,
        Pick<
            LoweringServices,
            | "checker"
            | "symbols"
            | "canvasSizeProperty"
            | "constArrayLiteral"
            | "knownCollectionCardinality"
            | "knownValueWithoutEvaluation"
        > {}

function resolvedLoopCallee(
    context: Pick<ResourceLoopContext, "checker"> &
        Partial<
            Pick<
                ResourceLoopContext,
                "bindings" | "knownValueWithoutEvaluation"
            >
        >,
    call: ts.CallExpression | ts.NewExpression,
): ts.Signature["declaration"] {
    const callee = unwrapExpression(call.expression);
    const value =
        context.knownValueWithoutEvaluation?.(callee) ??
        (ts.isIdentifier(callee)
            ? context.bindings?.lookupOptional(callee)
            : undefined);
    const owner = ts.isPropertyAccessExpression(callee)
        ? context.knownValueWithoutEvaluation?.(callee.expression)
        : undefined;
    const declaration =
        value?.callbackDeclaration ??
        (ts.isPropertyAccessExpression(callee) &&
        !owner?.recordGetters?.[callee.name.text]
            ? owner?.recordMethods?.[callee.name.text]
            : undefined);
    if (declaration) {
        return ts.isIdentifier(declaration)
            ? tryResolveFunctionDeclaration(context.checker, declaration)
            : declaration;
    }
    return (
        (ts.isIdentifier(callee)
            ? tryResolveFunctionDeclaration(context.checker, callee)
            : undefined) ??
        context.checker.getResolvedSignature(call)?.declaration
    );
}

function expressionHandleKind(
    context: Pick<ResourceLoopContext, "checker">,
    expression: ts.Expression,
) {
    const type = context.checker.getNonNullableType(
        context.checker.getTypeAtLocation(expression),
    );
    return (
        pinnedHandleKind(type) ??
        platformHandleKind(type) ??
        (isPinnedType(type, ["StandardMaterialProps", "PbrMaterialProps"])
            ? "material"
            : undefined)
    );
}

function nativePlatformRead(
    context: Pick<ResourceLoopContext, "checker">,
    node: ts.Node,
): boolean {
    if (!ts.isPropertyAccessExpression(node)) return false;
    const owner = unwrapExpression(node.expression);
    if (
        node.name.text === "getGamepads" &&
        libraryGlobal(context.checker, owner) === "navigator"
    )
        return true;
    const type = context.checker.getNonNullableType(
        context.checker.getTypeAtLocation(owner),
    );
    const kind = platformHandleKind(type);
    return (
        kind !== undefined &&
        propertyRules.some(
            (rule) =>
                rule.owner === kind &&
                rule.property === node.name.text &&
                !("unsupported" in rule),
        )
    );
}

function nativeSceneMembershipChange(
    context: Pick<ResourceLoopContext, "checker">,
    imported: string,
    call: ts.CallExpression,
): boolean {
    if (imported !== "addToScene" && imported !== "removeFromScene")
        return false;
    const kind =
        call.arguments[1] && expressionHandleKind(context, call.arguments[1]);
    return kind === "mesh" || kind === "transform-node";
}

function nativeTransformSet(
    context: Pick<ResourceLoopContext, "checker">,
    call: ts.CallExpression,
): boolean {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "set")
        return false;
    const owner = unwrapExpression(callee.expression);
    if (
        !ts.isPropertyAccessExpression(owner) ||
        !sceneNodeTransformDescriptor(owner.name.text)
    )
        return false;
    const kind = expressionHandleKind(context, owner.expression);
    return kind === "mesh" || kind === "transform-node";
}

/** Follow reached calls with readonly callback parameters bound to their source bodies. */
export function walkReachedLoopNodes(
    context: Pick<ResourceLoopContext, "checker" | "symbols">,
    root: ts.Node,
    visit: (
        node: ts.Node,
        called?: ts.Signature["declaration"],
    ) => boolean | void,
): void {
    type Callbacks = ReadonlyMap<ts.Symbol, SupportedFunction | undefined>;
    const functions = new Map<ts.Node, Set<string>>();
    const identities = new Map<ts.Node | ts.Symbol, number>();
    const identity = (value: ts.Node | ts.Symbol): number => {
        let id = identities.get(value);
        if (id === undefined) {
            id = identities.size;
            identities.set(value, id);
        }
        return id;
    };
    const callback = (
        expression: ts.Expression,
        callbacks: Callbacks,
    ): SupportedFunction | undefined => {
        const value = unwrapExpression(expression);
        if (isSupportedFunction(value)) return value;
        if (!ts.isIdentifier(value)) return undefined;
        const symbol = context.checker.getSymbolAtLocation(value);
        if (symbol && callbacks.has(symbol)) return callbacks.get(symbol);
        const target = symbol && aliasTarget(context.checker, symbol);
        if (
            target?.declarations?.some(
                (declaration) =>
                    ts.isVariableDeclaration(declaration) &&
                    (declaration.parent.flags & ts.NodeFlags.Const) === 0,
            )
        )
            return undefined;
        return tryResolveFunctionDeclaration(context.checker, value);
    };
    const walkFunction = (node: ts.Node, callbacks: Callbacks): void => {
        if (
            !(
                isSupportedFunction(node) ||
                ts.isConstructorDeclaration(node) ||
                ts.isGetAccessorDeclaration(node) ||
                ts.isSetAccessorDeclaration(node)
            ) ||
            !node.body
        )
            return;
        const key = [...callbacks]
            .map(
                ([symbol, value]) =>
                    `${identity(symbol)}:${value ? identity(value) : "?"}`,
            )
            .sort()
            .join(",");
        let seen = functions.get(node);
        if (!seen) functions.set(node, (seen = new Set()));
        if (seen.has(key)) return;
        seen.add(key);
        walk(node.body, callbacks);
    };
    const walk = (subtree: ts.Node, callbacks: Callbacks): void =>
        forEachAnalysisNode(
            subtree,
            (node) => {
                const invocation =
                    ts.isCallExpression(node) || ts.isNewExpression(node);
                const callee = invocation
                    ? unwrapExpression(node.expression)
                    : undefined;
                const symbol =
                    callee && ts.isIdentifier(callee)
                        ? context.checker.getSymbolAtLocation(callee)
                        : undefined;
                const called = invocation
                    ? symbol && callbacks.has(symbol)
                        ? (callbacks.get(symbol) ??
                          context.checker.getResolvedSignature(node)
                              ?.declaration)
                        : resolvedLoopCallee(context, node)
                    : undefined;
                if (visit(node, called) === false) return "skip";
                if (invocation && callee) {
                    const imported = ts.isIdentifier(callee)
                        ? context.symbols.importedName(callee)
                        : undefined;
                    if (!imported && called) {
                        let bound:
                            | Map<ts.Symbol, SupportedFunction | undefined>
                            | undefined;
                        for (const [
                            index,
                            parameter,
                        ] of called.parameters.entries()) {
                            if (
                                !ts.isParameter(parameter) ||
                                !ts.isIdentifier(parameter.name) ||
                                context.checker
                                    .getTypeAtLocation(parameter)
                                    .getCallSignatures().length === 0
                            )
                                continue;
                            const symbol = context.checker.getSymbolAtLocation(
                                parameter.name,
                            );
                            if (!symbol) continue;
                            const argument =
                                node.arguments?.[index] ??
                                parameter.initializer;
                            bound ??= new Map(callbacks);
                            bound.set(
                                symbol,
                                argument &&
                                    isSupportedFunction(called) &&
                                    parameterIsReadOnly(
                                        context.checker,
                                        called,
                                        parameter.name,
                                    )
                                    ? callback(argument, callbacks)
                                    : undefined,
                            );
                        }
                        walkFunction(called, bound ?? callbacks);
                    }
                    if (ts.isNewExpression(node)) {
                        const declaration =
                            context.checker.getTypeAtLocation(callee).symbol
                                ?.valueDeclaration;
                        if (
                            declaration &&
                            (ts.isClassDeclaration(declaration) ||
                                ts.isClassExpression(declaration))
                        ) {
                            for (const member of declaration.members) {
                                if (
                                    ts.isPropertyDeclaration(member) &&
                                    member.initializer
                                )
                                    walk(member.initializer, callbacks);
                            }
                        }
                    }
                    for (const argument of node.arguments ?? []) {
                        const declaration = callback(argument, callbacks);
                        if (declaration) walkFunction(declaration, callbacks);
                    }
                }
                if (ts.isPropertyAccessExpression(node)) {
                    for (const declaration of context.checker.getSymbolAtLocation(
                        node.name,
                    )?.declarations ?? []) {
                        if (
                            ts.isGetAccessorDeclaration(declaration) ||
                            ts.isSetAccessorDeclaration(declaration)
                        )
                            walkFunction(declaration, callbacks);
                    }
                }
            },
            { skip: (node) => node !== subtree && ts.isFunctionLike(node) },
        );
    walk(root, new Map());
}

export function requiresStaticLoopIteration(
    context: Pick<ResourceLoopContext, "checker" | "symbols">,
    statement: ts.Node,
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
    statement: ts.Node,
    callEffects = false,
): boolean {
    return reachesSpecializingEffect(context, statement, callEffects, true);
}

/**
 * Whether a reached effect needs generation-time specialization. Retained
 * DOM/canvas operations and scene-node transform or parent writes lower to
 * native calls on runtime handles; a closed data loop still expands them
 * statically to keep their generation facts (`keepsRetainedFacts`).
 */
function reachesSpecializingEffect(
    context: ResourceLoopContext,
    root: ts.Node,
    callEffects: boolean,
    keepsRetainedFacts: boolean,
): boolean {
    let required = false;
    walkReachedLoopNodes(context, root, (node) => {
        if (required) return false;
        // Handle and finite record properties dispatch by their source key.
        if (
            ts.isElementAccessExpression(node) &&
            !ts.isStringLiteralLike(unwrapExpression(node.argumentExpression))
        ) {
            const ownerType = context.checker.getNonNullableType(
                context.checker.getTypeAtLocation(node.expression),
            );
            const keyType = context.checker.getTypeAtLocation(
                node.argumentExpression,
            );
            const stringKey = (
                keyType.isUnion() ? keyType.types : [keyType]
            ).every((type) => (type.flags & ts.TypeFlags.StringLike) !== 0);
            if (
                expressionHandleKind(context, node.expression) ||
                (stringKey &&
                    expressionHandleKind(context, node) &&
                    !context.checker.getIndexInfoOfType(
                        ownerType,
                        ts.IndexKind.String,
                    ))
            ) {
                required = true;
                return false;
            }
        }
        // Canvas extents have native reads; writes still belong to their
        // normal DOM/retained-canvas lowering and cannot use this exemption.
        if (
            keepsRetainedFacts &&
            writesThroughTrackedRoot(node, (target) => {
                const member = unwrapExpression(target);
                const symbol = ts.isPropertyAccessExpression(member)
                    ? context.checker.getSymbolAtLocation(member.name)
                    : undefined;
                return symbol !== undefined && declaredInDomLibrary(symbol);
            })
        ) {
            required = true;
            return false;
        }
        const symbol = ts.isPropertyAccessExpression(node)
            ? context.checker.getSymbolAtLocation(node.name)
            : ts.isCallExpression(node) && ts.isIdentifier(node.expression)
              ? context.checker.getSymbolAtLocation(node.expression)
              : undefined;
        if (
            keepsRetainedFacts &&
            symbol &&
            declaredInDomLibrary(symbol) &&
            !(
                ts.isPropertyAccessExpression(node) &&
                context.canvasSizeProperty(node)
            ) &&
            !nativePlatformRead(context, node)
        ) {
            required = true;
            return false;
        }
        // Readback intrinsics return their resolved native value after waiting
        // for submitted work. Their await does not create a frame continuation
        // or a generation-owned resource. Still walk the call's arguments.
        const awaited = ts.isAwaitExpression(node)
            ? unwrapExpression(node.expression)
            : undefined;
        const awaitedCallee =
            awaited && ts.isCallExpression(awaited)
                ? unwrapExpression(awaited.expression)
                : undefined;
        const awaitedIntrinsic =
            awaitedCallee && ts.isIdentifier(awaitedCallee)
                ? context.symbols.importedName(awaitedCallee)
                : undefined;
        const effectAwait =
            callEffects &&
            awaited &&
            ts.isCallExpression(awaited) &&
            ((awaitedIntrinsic &&
                (isMaterialCallEffectIntrinsic(awaitedIntrinsic) ||
                    isAssetCallEffectIntrinsic(awaitedIntrinsic))) ||
                isSupportedFunction(resolvedLoopCallee(context, awaited)));
        if (
            (ts.isAwaitExpression(node) &&
                !effectAwait &&
                !(
                    awaitedIntrinsic &&
                    (runtimeOnlyIntrinsics.has(awaitedIntrinsic) ||
                        (awaited &&
                            ts.isCallExpression(awaited) &&
                            runtimeProfileCall(
                                context,
                                awaitedIntrinsic,
                                awaited,
                            )))
                )) ||
            ts.isYieldExpression(node)
        ) {
            required = true;
            return false;
        }
        if (ts.isCallExpression(node)) {
            const callee = unwrapExpression(node.expression);
            const imported = ts.isIdentifier(callee)
                ? context.symbols.importedName(callee)
                : undefined;
            if (
                imported &&
                !(
                    keepsRetainedFacts
                        ? nativeDataIterationIntrinsics
                        : sharedBodyIntrinsics
                ).has(imported) &&
                !(
                    callEffects &&
                    (isMaterialCallEffectIntrinsic(imported) ||
                        isAssetCallEffectIntrinsic(imported))
                ) &&
                !nativeSceneMembershipChange(context, imported, node) &&
                !runtimeProfileCall(context, imported, node)
            ) {
                required = true;
                return false;
            }
        }
        const target = isAssignmentExpression(node)
            ? node.left
            : isUpdateExpression(node)
              ? node.operand
              : undefined;
        if (!target) return;
        let member = unwrapExpression(target);
        while (ts.isPropertyAccessExpression(member)) {
            const kind = expressionHandleKind(context, member.expression);
            if (kind) {
                const property = member.name.text;
                required =
                    kind === "mesh" ||
                    kind === "transform-node" ||
                    (!keepsRetainedFacts && kind === "scene-node")
                        ? !runtimeMeshProperties.has(property) &&
                          property !== "material" &&
                          property !== "receiveShadows" &&
                          (keepsRetainedFacts || property !== "parent")
                        : kind === "node-input"
                          ? property !== "texture"
                          : kind === "material"
                            ? !callEffects &&
                              !runtimeMaterialProperties.has(property)
                            : true;
                return !required;
            }
            member = unwrapExpression(member.expression);
        }
    });
    return required;
}

/**
 * Share function bodies whose reached effects have native representations.
 * A call through a function value runs its own native body; a callback
 * known at generation is lowered inside the shared body, where effects
 * that need one definite invocation refuse (`emitReusableNativeBody`).
 */
export function canShareFunctionBody(
    context: ResourceLoopContext,
    body: ts.Node,
    callEffects = false,
): boolean {
    return !reachesSpecializingEffect(context, body, callEffects, false);
}

/**
 * Whether every reached effect is closed: nothing needs static iteration and
 * every callee is reachable. A closed handle table and a callback invoked by
 * an operation run such a body natively.
 */
export function reachesOnlyClosedEffects(
    context: ResourceLoopContext,
    body: ts.Node,
    callEffects = false,
): boolean {
    return (
        !requiresStaticDataIteration(context, body, callEffects) &&
        !reachesOpaqueCallee(context, body)
    );
}

/** Whether the body calls a function value whose body this walk cannot reach. */
export function reachesOpaqueCallee(
    context: ResourceLoopContext,
    body: ts.Node,
): boolean {
    let opaque = false;
    walkReachedLoopNodes(context, body, (node, resolved) => {
        if (!ts.isCallExpression(node)) return;
        if (
            resolved &&
            !resolved.getSourceFile().isDeclarationFile &&
            !(isSupportedFunction(resolved) && resolved.body)
        )
            opaque = true;
    });
    return opaque;
}

/**
 * Construction and generation-dependent operations replay their ordinary
 * recorder effects; a function value the walk cannot reach may construct.
 */
export function sharedFunctionHasCallEffects(
    context: ResourceLoopContext,
    body: ts.Node,
): boolean {
    if (!canShareFunctionBody(context, body, true)) return false;
    if (!canShareFunctionBody(context, body)) return true;
    let constructs = false;
    walkReachedLoopNodes(context, body, (node) => {
        if (!ts.isCallExpression(node)) return;
        const callee = unwrapExpression(node.expression);
        const imported = ts.isIdentifier(callee)
            ? context.symbols.importedName(callee)
            : undefined;
        if (imported && runtimeProfileConstructionIntrinsics.has(imported))
            constructs = true;
    });
    return constructs || reachesOpaqueCallee(context, body);
}

/** A folded bound must not be invalidated by the loop or its called helpers. */
export function loopBoundMayChange(
    context: Pick<ResourceLoopContext, "checker" | "symbols">,
    body: ts.Statement,
    bound: ts.Expression,
): boolean {
    const unwrapped = unwrapExpression(bound);
    const arrayLength =
        ts.isPropertyAccessExpression(unwrapped) &&
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
    const reached = new EmissionSet<ts.Node>();
    walkReachedLoopNodes(context, body, (node) => {
        reached.add(node);
    });
    return dependencies.some((identifier) =>
        aliasedMutationScan(
            identifier,
            (name) => context.symbols.valueSymbol(name),
            {
                aliasingInitializer: (initializer, scan) => {
                    if (arrayLength)
                        return scan.namesAlias(unwrapExpression(initializer));
                    const root = rootIdentifier(initializer);
                    if (!root || !scan.namesAlias(root)) return false;
                    const type = context.checker.getTypeAtLocation(initializer);
                    return (
                        (type.flags &
                            (ts.TypeFlags.Object |
                                ts.TypeFlags.Intersection |
                                ts.TypeFlags.Union)) !==
                        0
                    );
                },
                mutates: (node, scan) => {
                    if (!reached.has(node)) return false;
                    const namesAlias = (expression: ts.Expression): boolean => {
                        if (arrayLength) {
                            const target = unwrapExpression(expression);
                            return (
                                scan.namesAlias(target) ||
                                ((ts.isElementAccessExpression(target) ||
                                    (ts.isPropertyAccessExpression(target) &&
                                        target.name.text === "length")) &&
                                    scan.namesAlias(
                                        unwrapExpression(target.expression),
                                    ))
                            );
                        }
                        const root = rootIdentifier(expression);
                        return root !== undefined && scan.namesAlias(root);
                    };
                    return (
                        writesThroughTrackedRoot(
                            node,
                            namesAlias,
                            arrayLength
                                ? (method) => resizingArrayMethods.has(method)
                                : undefined,
                        ) ||
                        (ts.isCallExpression(node) &&
                            node.arguments.some(
                                (argument, index) =>
                                    (arrayLength
                                        ? scan.namesAlias(
                                              unwrapExpression(argument),
                                          )
                                        : namesAlias(argument)) &&
                                    !callArgumentIsReadOnly(
                                        context.checker,
                                        node,
                                        index,
                                    ),
                            ))
                    );
                },
            },
        ),
    );
}

interface StaticIndexLoop {
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
        (statement.condition.operatorToken.kind !==
            ts.SyntaxKind.LessThanToken &&
            statement.condition.operatorToken.kind !==
                ts.SyntaxKind.LessThanEqualsToken) ||
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
        !isUpdateExpression(incrementor) ||
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
        inclusive:
            statement.condition.operatorToken.kind ===
            ts.SyntaxKind.LessThanEqualsToken,
    };
}

export interface ParameterizedResourceLoop {
    iterations: number;
}

export type ResourceLoop = ts.ForStatement | ts.ForOfStatement;

// These factories record only an attribute shape and emit native construction.
// Counts that the existing option lowerers require at generation stay invariant;
// dimensions and transforms remain ordinary runtime numeric expressions.
const meshFactories: ReadonlyMap<string, readonly string[]> = new EmissionMap([
    ["createBox", []],
    ["createPlane", []],
    ["createGround", ["subdivisions"]],
    ["createSphere", ["segments"]],
    ["createTorus", ["tessellation"]],
    ["createTorusKnot", []],
]);
/** These native factories have a closed call-site profile, not a baked body. */
export const runtimeProfileConstructionIntrinsics: ReadonlySet<string> =
    new EmissionSet([
        ...meshFactories.keys(),
        "createMeshFromData",
        "cloneTransformNode",
        "createStandardMaterial",
        "createShaderMaterial",
        "parseNodeMaterialFromSnippet",
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
        if (
            !ts.isPropertyAssignment(property) &&
            !ts.isShorthandPropertyAssignment(property)
        )
            return false;
        const name = property.name;
        if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name))
            return false;
        return (
            !options.includes(name.text) ||
            staticNumberValue(
                context,
                ts.isPropertyAssignment(property)
                    ? property.initializer
                    : property.name,
            ) !== undefined
        );
    });
}
const runtimeMeshProperties = new EmissionSet([
    "position",
    "rotation",
    "rotationQuaternion",
    "scaling",
    "name",
    "visibility",
    "visible",
    "isVisible",
    "isPickable",
    "renderOrder",
    "boundMin",
    "boundMax",
]);
const runtimeMaterialProperties = new EmissionSet([
    "diffuseColor",
    "specularColor",
    "ambientColor",
    "emissiveColor",
    "specularPower",
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
    const active = new EmissionSet<SupportedFunction>();
    const indices = new EmissionSet<ts.Symbol>();
    const bindings = new EmissionMap<ts.Symbol, ts.Expression>();
    const mutated = new EmissionSet<ts.Symbol>();
    const rebound = new EmissionSet<ts.Symbol>();
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
    let dataFunction = false;
    const resolve = (expression: ts.Expression): ts.Expression => {
        let current = unwrapExpression(expression);
        const seen = new EmissionSet<ts.Symbol>();
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
        libraryGlobal: (expression) => context.libraryGlobal(expression),
        bindings: {
            lookup: (identifier) => context.bindings.lookup(identifier),
            lookupOptional: (identifier) =>
                indices.has(context.symbols.valueSymbol(identifier)!)
                    ? undefined
                    : context.bindings.lookupOptional(identifier),
        },
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
        seen = new EmissionSet<ts.Symbol>(),
    ): boolean => {
        const node = unwrapExpression(expression);
        if (ts.isIdentifier(node)) {
            const symbol = context.symbols.valueSymbol(node);
            if (!symbol || seen.has(symbol)) return false;
            if (indices.has(symbol) || rebound.has(symbol)) return false;
            const bound = bindings.get(symbol);
            const value = bound
                ? undefined
                : context.bindings.lookupOptional(node);
            if (
                value?.kind === "engine" ||
                value?.kind === "scene" ||
                value?.kind === "material" ||
                value?.kind === "texture"
            ) {
                return true;
            }
            const declaration = symbol.valueDeclaration;
            const initializer =
                bound ??
                (declaration && ts.isVariableDeclaration(declaration)
                    ? declaration.initializer
                    : undefined);
            const localStandard =
                initializer &&
                ts.isCallExpression(initializer) &&
                ts.isIdentifier(initializer.expression) &&
                context.symbols.importedName(initializer.expression) ===
                    "createStandardMaterial";
            if (mutated.has(symbol) && !localStandard) return false;
            if (initializer) {
                return invariant(
                    initializer,
                    new EmissionSet([...seen, symbol]),
                );
            }
            return context.bindings.lookupOptional(node) !== undefined;
        }
        if (ts.isPropertyAccessExpression(node)) {
            return invariant(node.expression, seen);
        }
        if (ts.isCallExpression(node)) {
            return (
                ts.isIdentifier(node.expression) &&
                context.symbols.importedName(node.expression) ===
                    "createStandardMaterial"
            );
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
            if (ts.isExpression(child) && !invariant(child, seen))
                answer = false;
        });
        return answer;
    };
    const forOfCount = (loop: ts.ForOfStatement): number | undefined => {
        if (loop === statement && knownIterations !== undefined)
            return knownIterations;
        if (
            loop.awaitModifier ||
            !ts.isVariableDeclarationList(loop.initializer) ||
            loop.initializer.declarations.length !== 1
        )
            return undefined;
        const count = context.knownCollectionCardinality(loop.expression);
        if (
            count !== undefined &&
            !loopBoundMayChange(context, loop.statement, loop.expression)
        )
            return count;
        if (!invariant(loop.expression)) return undefined;
        const resolved = resolve(loop.expression);
        const expression = context.constArrayLiteral(resolved) ?? resolved;
        if (ts.isArrayLiteralExpression(expression)) {
            let effect = false;
            const check = (node: ts.Node): void => {
                if (
                    ts.isCallExpression(node) ||
                    ts.isNewExpression(node) ||
                    ts.isSpreadElement(node) ||
                    ts.isOmittedExpression(node)
                ) {
                    effect = true;
                    return;
                }
                ts.forEachChild(node, check);
            };
            check(expression);
            return effect ? undefined : expression.elements.length;
        }
        const value = ts.isIdentifier(expression)
            ? context.bindings.lookupOptional(expression)
            : undefined;
        if (
            value?.collectionCardinality ||
            value?.staticElementsOwner?.collectionCardinality
        ) {
            return context.knownCollectionCardinality(loop.expression);
        }
        return (
            (
                value?.tupleElements ??
                value?.staticElementsOwner?.staticElements ??
                value?.staticElements
            )?.length ?? context.knownCollectionCardinality(loop.expression)
        );
    };
    const visitFunction = (
        call: ts.CallExpression,
        fn: SupportedFunction,
        conditional: boolean,
    ): void => {
        if (!fn.body || active.has(fn)) {
            safe = false;
            return;
        }
        active.add(fn);
        const previous = new EmissionMap(bindings);
        fn.parameters.forEach((parameter, index) => {
            const argument = call.arguments[index] ?? parameter.initializer;
            if (ts.isIdentifier(parameter.name) && argument) {
                bindings.set(
                    context.symbols.valueSymbol(parameter.name)!,
                    resolve(argument),
                );
            }
        });
        const previousDataFunction = dataFunction;
        dataFunction = !requiresStaticLoopIteration(context, fn.body);
        if (ts.isBlock(fn.body)) {
            for (const [index, child] of fn.body.statements.entries()) {
                if (
                    ts.isReturnStatement(child) &&
                    index === fn.body.statements.length - 1
                ) {
                    if (child.expression) visit(child.expression, conditional);
                } else {
                    visit(child, conditional);
                }
            }
        } else {
            visit(fn.body, conditional);
        }
        dataFunction = previousDataFunction;
        bindings.clear();
        for (const [symbol, expression] of previous)
            bindings.set(symbol, expression);
        active.delete(fn);
    };
    const visit = (node: ts.Node, conditional: boolean): void => {
        if (!safe || ts.isFunctionLike(node)) return;
        if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
            const condition = resolve(
                ts.isIfStatement(node) ? node.expression : node.condition,
            );
            const fixed =
                condition.kind === ts.SyntaxKind.TrueKeyword
                    ? true
                    : condition.kind === ts.SyntaxKind.FalseKeyword
                      ? false
                      : ts.isIdentifier(condition) &&
                          !indices.has(
                              context.symbols.valueSymbol(condition)!,
                          ) &&
                          !mutated.has(context.symbols.valueSymbol(condition)!)
                        ? context.bindings.lookupOptional(condition)
                              ?.staticBoolean
                        : undefined;
            if (fixed !== undefined) {
                const selected = ts.isIfStatement(node)
                    ? fixed
                        ? node.thenStatement
                        : node.elseStatement
                    : fixed
                      ? node.whenTrue
                      : node.whenFalse;
                if (selected) visit(selected, conditional);
                return;
            }
        }
        if (ts.isForStatement(node)) {
            const shape = staticIndexLoopShape(context.symbols, node);
            const end =
                shape && !loopBoundMayChange(context, node.statement, shape.end)
                    ? boundValue(shape.end)
                    : undefined;
            const count =
                shape && end !== undefined
                    ? staticIndexLoopIterations(shape, end)
                    : undefined;
            if (!shape || count === undefined) {
                safe = false;
                return;
            }
            const symbol = context.symbols.valueSymbol(shape.indexBinding)!;
            indices.add(symbol);
            if (count !== 0) visit(node.statement, conditional);
            indices.delete(symbol);
            return;
        }
        if (ts.isForOfStatement(node)) {
            const count = forOfCount(node);
            if (
                count === undefined ||
                !ts.isVariableDeclarationList(node.initializer)
            ) {
                safe = false;
                return;
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
            if (count !== 0) visit(node.statement, conditional);
            for (const symbol of bound) indices.delete(symbol);
            return;
        }
        if (ts.isReturnStatement(node) && dataFunction) {
            if (node.expression) visit(node.expression, conditional);
            return;
        }
        if (
            ts.isWhileStatement(node) ||
            ts.isDoStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isBreakStatement(node) ||
            ts.isContinueStatement(node) ||
            ts.isReturnStatement(node) ||
            ts.isTryStatement(node) ||
            ts.isAwaitExpression(node) ||
            ts.isNewExpression(node)
        ) {
            safe = false;
            return;
        }
        if (
            writesThroughTrackedRoot(
                node,
                (target) =>
                    ts.isIdentifier(target) &&
                    indices.has(context.symbols.valueSymbol(target)!),
            )
        ) {
            safe = false;
            return;
        }
        if (
            ts.isPropertyAccessExpression(node) &&
            context.checker
                .getSymbolAtLocation(node.name)
                ?.declarations?.some(
                    (declaration) =>
                        (ts.isGetAccessorDeclaration(declaration) ||
                            ts.isSetAccessorDeclaration(declaration)) &&
                        declaration.body !== undefined,
                )
        ) {
            safe = false;
            return;
        }
        const assignment = isAssignmentExpression(node)
            ? { target: node.left, value: node.right }
            : isUpdateExpression(node)
              ? { target: node.operand, value: undefined }
              : undefined;
        if (assignment) {
            const target = unwrapExpression(assignment.target);
            // An outer optional handle would retain one arbitrary iteration's
            // composition identity. Containers already withdraw that identity.
            if (
                ts.isIdentifier(target) &&
                expressionHandleKind(context, target)
            ) {
                safe = false;
                return;
            }
            let lane = target;
            while (ts.isPropertyAccessExpression(lane)) {
                const kind = expressionHandleKind(context, lane.expression);
                if (kind) {
                    const property = lane.name.text;
                    const fixed =
                        assignment.value !== undefined &&
                        invariant(assignment.value);
                    if (kind === "material") {
                        if (
                            !runtimeMaterialProperties.has(property) &&
                            (conditional || !fixed)
                        )
                            safe = false;
                    } else if (kind !== "mesh" && kind !== "transform-node") {
                        safe = false;
                    } else if (property === "material") {
                        if (conditional || assignment.value === undefined)
                            safe = false;
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
            for (const argument of node.arguments) {
                if (ts.isFunctionLike(unwrapExpression(argument))) {
                    safe = false;
                    return;
                }
                visit(argument, conditional);
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
                                if (
                                    ts.isPropertyAssignment(property) ||
                                    ts.isShorthandPropertyAssignment(property)
                                ) {
                                    const name = property.name;
                                    if (
                                        ts.isIdentifier(name) ||
                                        ts.isStringLiteralLike(name)
                                    ) {
                                        if (
                                            staticOptions.includes(name.text) &&
                                            !invariant(
                                                ts.isPropertyAssignment(
                                                    property,
                                                )
                                                    ? property.initializer
                                                    : property.name,
                                            )
                                        ) {
                                            safe = false;
                                        }
                                    }
                                } else {
                                    safe = false;
                                }
                            }
                        }
                    }
                } else if (
                    imported === "addToScene" ||
                    imported === "removeFromScene"
                ) {
                    if (!nativeSceneMembershipChange(context, imported, node))
                        safe = false;
                } else if (nativeDataIterationIntrinsics.has(imported)) {
                    reachesConstruction = true;
                } else if (
                    imported !== "setParent" &&
                    imported !== "markMeshDirty" &&
                    !runtimeOnlyIntrinsics.has(imported)
                ) {
                    safe = false;
                }
                return;
            }
            const called = resolvedLoopCallee(context, node);
            if (isSupportedFunction(called) && called.body) {
                visitFunction(node, called, conditional);
                return;
            }
            // Native data/Math methods have library signatures. An unresolved
            // callback or opaque method might conceal generation-time effects.
            if (
                !(
                    called !== undefined && declarationInDefaultLibrary(called)
                ) &&
                !nativeTransformSet(context, node)
            ) {
                safe = false;
            }
            return;
        }
        const guarded =
            conditional ||
            ts.isIfStatement(node) ||
            ts.isConditionalExpression(node) ||
            ts.isSwitchStatement(node) ||
            (ts.isBinaryExpression(node) &&
                (node.operatorToken.kind ===
                    ts.SyntaxKind.AmpersandAmpersandToken ||
                    node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                    node.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken));
        ts.forEachChild(node, (child) => {
            visit(child, guarded);
        });
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
    visit(statement, false);
    return safe && reachesConstruction ? { iterations } : undefined;
}
