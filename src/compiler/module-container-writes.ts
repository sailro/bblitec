import ts from "typescript";
import { someAnalysisNode, sourceFileNodes } from "./analysis-walk.js";
import { pinnedHandleKind } from "./data-types.js";
import type { EvaluationOrder } from "./evaluation-order.js";
import {
    callResultCanHoldReceiver,
    callResultHoldsArguments,
    keptArguments,
} from "./kept-values.js";
import { callArgumentIsReadOnly } from "./parameter-effects.js";
import { visitMutableArgumentReferences } from "./parameter-projection-effects.js";
import { programObservations } from "./program-observations.js";
import { propertyRules } from "./properties.js";
import { unwrapObjectIdentity } from "./static-evaluator.js";
import {
    accessedPropertySymbol,
    aliasTarget,
    memberAccessors,
    namedMember,
    type CompilerSymbols,
} from "./symbols.js";
import {
    isAssignmentExpression,
    isMemberAccess,
    plainDataMembers,
    rootExpression,
    unwrapExpression,
    wrappedParent,
} from "./syntax.js";
import {
    callSignatures,
    typeCanCarryReference,
    unionMembers,
} from "./type-facts.js";
import {
    aliasedMutationScan,
    returningFunctionName,
    writesThroughTrackedRoot,
    type AliasedMutationScan,
} from "./user-functions.js";

/** What the module-constant write walk reads beside the checked program. */
export interface ModuleConstantWrites {
    readonly program: ts.Program;
    readonly checker: ts.TypeChecker;
    readonly symbols: CompilerSymbols;
    readonly evaluationOrder: EvaluationOrder;
}

/** Answers are a function of the checked program. */
const writtenModuleConstants = new WeakMap<
    ts.Program,
    Map<ts.Symbol, boolean>
>();
/** Destination exposure depends only on the checked program. */
const nativeValueExposure = new WeakMap<
    ts.Program,
    Map<ts.Type, Map<string, boolean>>
>();

/** The expression whose identity a reader sees, through `await`. */
function identityUnwrap(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): ts.Expression {
    return unwrapObjectIdentity(checker, expression, { await: true });
}

/** A module namespace object (`import * as m`, `export * as m`). */
function isModuleNamespace(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    return (
        checker
            .getTypeAtLocation(expression)
            .getSymbol()
            ?.declarations?.some(ts.isSourceFile) === true
    );
}

/** A name, or an export read through its module namespace (`m.item`). */
function namesBinding(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    return (
        ts.isIdentifier(expression) ||
        (isMemberAccess(expression) &&
            isModuleNamespace(checker, expression.expression))
    );
}

/**
 * The owning binding beneath ordinary members, imported namespace exports
 * and a library call whose result holds its arguments (`Object.values(M)[0]`
 * is a member of M): the first argument that names one.
 */
export function moduleContainerSymbol(
    expression: ts.Expression,
    checker: ts.TypeChecker,
    symbols: CompilerSymbols,
): ts.Symbol | undefined {
    const current = unwrapExpression(expression);
    let symbol: ts.Symbol | undefined;
    if (ts.isIdentifier(current)) symbol = symbols.valueSymbol(current);
    else if (
        ts.isCallExpression(current) &&
        callResultHoldsArguments(checker, current)
    ) {
        for (const argument of current.arguments) {
            const held = moduleContainerSymbol(argument, checker, symbols);
            if (held) return held;
        }
        return undefined;
    } else if (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
    ) {
        if (isModuleNamespace(checker, current.expression)) {
            const exported = accessedPropertySymbol(checker, current);
            symbol = exported && aliasTarget(checker, exported);
        } else
            return moduleContainerSymbol(current.expression, checker, symbols);
    }
    return symbol?.declarations?.some(ts.isSourceFile) ? undefined : symbol;
}

/** Checked-source references are immutable across storage-demand replays. */
const moduleContainerFiles = new WeakMap<
    ts.Program,
    ReadonlyMap<ts.Symbol, readonly ts.SourceFile[]>
>();

/**
 * Files whose alias analysis can start from this binding. A file with no
 * occurrence of the original symbol cannot grow that analysis's alias set.
 * Keep its full traversal policy, including function bodies and type nodes.
 */
export function moduleContainerReferenceFiles(
    program: ts.Program,
    checker: ts.TypeChecker,
    symbols: CompilerSymbols,
    symbol: ts.Symbol,
): readonly ts.SourceFile[] {
    let indexed = moduleContainerFiles.get(program);
    if (!indexed) {
        const files = new Map<ts.Symbol, ts.SourceFile[]>();
        for (const file of program.getSourceFiles()) {
            if (file.isDeclarationFile) continue;
            const referenced = new Set<ts.Symbol>();
            sourceFileNodes(file).forEach((node) => {
                if (
                    !ts.isIdentifier(node) &&
                    !ts.isPropertyAccessExpression(node) &&
                    !ts.isElementAccessExpression(node)
                )
                    return;
                const owner = moduleContainerSymbol(node, checker, symbols);
                if (owner) referenced.add(owner);
            });
            for (const owner of referenced) {
                const references = files.get(owner);
                if (references) references.push(file);
                else files.set(owner, [file]);
            }
        }
        indexed = files;
        moduleContainerFiles.set(program, indexed);
    }
    return indexed.get(symbol) ?? [];
}

/**
 * Whether the program writes through a module constant: an assignment,
 * an update or a mutating call through it, through a binding initialized
 * from an expression that carries it, or through an iteration binding
 * over one; or it hands one to a call that may write it. The scan covers
 * the constant's file, and referencing files when it is exported. A binding
 * carrying a copied scalar does not carry its source object's identity.
 */
export function moduleConstantIsWritten(
    context: ModuleConstantWrites,
    name: ts.Identifier,
): boolean {
    const { program, checker, symbols } = context;
    const symbol = symbols.valueSymbol(name);
    const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
    if (!symbol || !declaration) return true;
    let answers = writtenModuleConstants.get(program);
    if (!answers)
        writtenModuleConstants.set(
            program,
            (answers = new Map<ts.Symbol, boolean>()),
        );
    const cached = answers.get(symbol);
    if (cached !== undefined) return cached;
    const exported =
        (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !==
        0;
    const files = exported
        ? moduleContainerReferenceFiles(program, checker, symbols, symbol)
        : [declaration.getSourceFile()];
    const written = writesThroughBinding(context, files, name, declaration);
    answers.set(symbol, written);
    return written;
}

/** A copied native value cannot expose its source identity when never read back. */
function unobservedNativeValueAssignment(
    checker: ts.TypeChecker,
    program: ts.Program,
    node: ts.BinaryExpression,
): boolean {
    const left = identityUnwrap(checker, node.left);
    if (
        node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !ts.isExpressionStatement(wrappedParent(node)) ||
        !ts.isPropertyAccessExpression(left)
    )
        return false;
    const ownerType = checker.getTypeAtLocation(left.expression);
    const owner = pinnedHandleKind(ownerType);
    const property = left.name.text;
    if (
        !propertyRules.some(
            (rule) =>
                rule.owner === owner &&
                rule.property === property &&
                "value" in rule &&
                rule.value === "color4" &&
                rule.field !== undefined,
        )
    )
        return false;
    let exposure = nativeValueExposure.get(program);
    if (!exposure)
        nativeValueExposure.set(
            program,
            (exposure = new Map<ts.Type, Map<string, boolean>>()),
        );
    let byProperty = exposure.get(ownerType);
    if (!byProperty)
        exposure.set(ownerType, (byProperty = new Map<string, boolean>()));
    const known = byProperty.get(property);
    if (known !== undefined) return !known;
    const observations = programObservations(program);
    const exposed =
        (observations.namedReads.get(property)?.length ?? 0) > 0 ||
        observations.wholesaleReads.some((read) => {
            const parent = read.parent;
            if (
                ts.isElementAccessExpression(parent) &&
                parent.expression === read
            ) {
                const key = checker.getTypeAtLocation(
                    parent.argumentExpression,
                );
                const keys = unionMembers(key);
                if (
                    keys.every(
                        (member) =>
                            member.isStringLiteral() &&
                            member.value !== property,
                    )
                )
                    return false;
            }
            const type = checker.getTypeAtLocation(read);
            return (
                (type.flags &
                    (ts.TypeFlags.Any |
                        ts.TypeFlags.Unknown |
                        ts.TypeFlags.TypeParameter |
                        ts.TypeFlags.IndexedAccess |
                        ts.TypeFlags.Conditional |
                        ts.TypeFlags.Substitution)) !==
                    0 || checker.isTypeAssignableTo(ownerType, type)
            );
        });
    byProperty.set(property, exposed);
    return !exposed;
}

function writesThroughBinding(
    context: ModuleConstantWrites,
    initialFiles: readonly ts.SourceFile[],
    name: ts.Identifier,
    declaration: ts.VariableDeclaration,
): boolean {
    const { program, checker, symbols, evaluationOrder } = context;
    const initializer =
        declaration.initializer &&
        identityUnwrap(checker, declaration.initializer);
    const members =
        initializer && ts.isObjectLiteralExpression(initializer)
            ? plainDataMembers(initializer)
            : undefined;
    // A record of scalars: a write-through certificate that holds only
    // while its identity stays inside this walk.
    const scalarRecord =
        members?.every(
            (member) =>
                !typeCanCarryReference(checker.getTypeAtLocation(member.value)),
        ) ?? false;
    const selectedRecordKeys =
        scalarRecord && members
            ? new Set(members.map((member) => member.key))
            : undefined;
    // A named helper whose `return` carries the constant is an alias: a
    // call of one is the constant.
    const returnsConstant = (
        scan: AliasedMutationScan,
        call: ts.CallExpression,
    ): boolean => {
        const callee = unwrapExpression(call.expression);
        const called = ts.isIdentifier(callee)
            ? symbols.valueSymbol(callee)
            : undefined;
        return (
            called !== undefined &&
            scan.holds(called) &&
            called.declarations?.some(ts.isFunctionDeclaration) === true
        );
    };
    const names = (scan: AliasedMutationScan, node: ts.Node): boolean => {
        // A member chain rooted at a call reads that call's result.
        const root = ts.isExpression(node) ? rootExpression(node) : node;
        if (ts.isCallExpression(root) && returnsConstant(scan, root))
            return true;
        const named =
            ts.isIdentifier(node) ||
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node) ||
            ts.isCallExpression(node)
                ? moduleContainerSymbol(node, checker, symbols)
                : undefined;
        return named !== undefined && scan.holds(named);
    };
    // Whether the callee may write or keep the constant handed to it.
    const writesArgument = (
        scan: AliasedMutationScan,
        call: ts.CallExpression,
        index: number,
    ): boolean => {
        let written = false;
        visitMutableArgumentReferences(
            checker,
            call,
            index,
            (reference) => {
                if (names(scan, reference)) written = true;
            },
            scalarRecord ? (reference) => names(scan, reference) : undefined,
            selectedRecordKeys,
        );
        return written;
    };
    // Whether an expression carries the constant: a binding initialized
    // from, iterating, assigned or destructured out of it holds it
    // (`view = M`, `view ??= M`, a pattern leaf, a loop target). A
    // function inside the expression reads the constant without handing it
    // on; its own body is part of the walk.
    const mentions = (
        expression: ts.Expression,
        scan: AliasedMutationScan,
    ): boolean =>
        someAnalysisNode(
            expression,
            (node) => {
                if (
                    ts.isExpression(node) &&
                    !typeCanCarryReference(checker.getTypeAtLocation(node))
                )
                    return "skip";
                if (!ts.isCallExpression(node)) return names(scan, node);
                // A function's result is not the function; a method's can
                // be its receiver or a member of it.
                const retained =
                    (ts.isIdentifier(unwrapExpression(node.expression))
                        ? returnsConstant(scan, node)
                        : callResultCanHoldReceiver(checker, node) &&
                          someAnalysisNode(
                              node.expression,
                              (inner) => names(scan, inner),
                              { functions: "skip" },
                          )) ||
                    node.arguments.some((_, index) =>
                        writesArgument(scan, node, index),
                    );
                return retained ? true : "skip";
            },
            { functions: "skip" },
        );
    // Stored or returned references can acquire aliases outside this walk:
    // a scalar-record certificate does not survive its identity escaping,
    // and cannot follow the result of a function other than a named helper.
    const scalarRecordEscapes = (
        node: ts.Node,
        scan: AliasedMutationScan,
    ): boolean =>
        (ts.isReturnStatement(node) &&
            node.expression !== undefined &&
            !returningFunctionName(node) &&
            mentions(node.expression, scan)) ||
        (isAssignmentExpression(node) &&
            mentions(node.right, scan) &&
            !(
                names(scan, identityUnwrap(checker, node.right)) &&
                unobservedNativeValueAssignment(checker, program, node)
            )) ||
        ((ts.isThrowStatement(node) || ts.isExportAssignment(node)) &&
            node.expression !== undefined &&
            mentions(node.expression, scan)) ||
        (ts.isArrowFunction(node) &&
            !ts.isBlock(node.body) &&
            mentions(node.body, scan)) ||
        ((ts.isParameter(node) || ts.isPropertyDeclaration(node)) &&
            node.initializer !== undefined &&
            mentions(node.initializer, scan));
    return aliasedMutationScan(
        name,
        (identifier) => symbols.valueSymbol(identifier),
        {
            files: {
                initial: initialFiles,
                referencing: (aliased) =>
                    moduleContainerReferenceFiles(
                        program,
                        checker,
                        symbols,
                        aliased,
                    ),
            },
            aliasingInitializer: mentions,
            aliasingMember: (source, _leaf, scan) => mentions(source, scan),
            aliasingIteration: (source, _leaf, scan) => mentions(source, scan),
            // A named helper can return a container holding the identity;
            // its callers, importing files included, are followed.
            aliasingReturn: mentions,
            mutates: (node, scan) =>
                (scalarRecord && scalarRecordEscapes(node, scan)) ||
                // The alias walk can stop at a getter's scalar result,
                // but evaluating that getter may still mutate its owner.
                ((ts.isPropertyAccessExpression(node) ||
                    ts.isElementAccessExpression(node)) &&
                    memberAccessors(checker, node, "get").length > 0 &&
                    mentions(node.expression, scan) &&
                    evaluationOrder.writesStorage(node)) ||
                writesThroughTrackedRoot(
                    node,
                    (callee) => namedMember(checker, callee),
                    // Assigning a name, the binding's own included and an
                    // export through its namespace, rebinds it (`isRebound`'s
                    // question); the object it held is unchanged.
                    (target, via) => {
                        const written = identityUnwrap(checker, target);
                        return (
                            !(
                                via === "assignment" &&
                                namesBinding(checker, written)
                            ) && names(scan, written)
                        );
                    },
                    undefined,
                    checker,
                    program.getSourceFiles(),
                ) ||
                (ts.isCallExpression(node) &&
                    node.arguments.some(
                        (argument, index) =>
                            mentions(argument, scan) &&
                            !callArgumentIsReadOnly(
                                checker,
                                node,
                                index,
                                "refused",
                            ) &&
                            writesArgument(scan, node, index),
                    )) ||
                // The constant, or a member of it, kept past the call
                // (a construction, a storing call) is written through
                // its new owner; a kept function writes only what its own
                // body, which the walk reads, writes.
                keptArguments(checker, node).some(
                    (argument) =>
                        callSignatures(
                            checker,
                            checker.getTypeAtLocation(argument),
                            "exact",
                        ).length === 0 && mentions(argument, scan),
                ),
        },
    );
}
