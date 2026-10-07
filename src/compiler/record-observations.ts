import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import type { EvaluationOrder } from "./evaluation-order.js";
import { callOnlyReadsArgument } from "./parameter-effects.js";
import {
    programObservations,
    type ObservedWrite,
    type ProgramObservations,
} from "./program-observations.js";
import { yieldsNewArray } from "./fresh-records.js";
import {
    declarationOrigin,
    declaredSymbol,
    resolvedSymbol,
} from "./symbols.js";
import {
    assignmentTargets,
    expressionMayRunCode,
    isAssignmentExpression,
    isUpdateExpression,
    unwrapExpression,
} from "./syntax.js";

/** What a record-observation question reads: the program and the code its calls run. */
export interface RecordObservationContext {
    readonly program: ts.Program;
    readonly checker: ts.TypeChecker;
    readonly evaluationOrder: EvaluationOrder;
}

/**
 * Where a program could tell a copied record from the object JavaScript
 * shares. Storing a record as another record type copies it natively; the
 * copy and the original agree for every read until one of them changes, is
 * compared or keyed by identity, or is enumerated beyond the copied fields
 * (`ProgramObservations` lists who touches objects of each static type).
 *
 * A copy is unobservable when no write of a field it keeps can reach the
 * original or the copy, no identity use can reach the copy, and no
 * enumeration can reach the copy while the original carries or gains
 * properties the copy drops. A copy handed to a callee that only reads it
 * needs only that nothing the call runs writes such a field. Holders are
 * judged by assignability, so a record reaching an operation through
 * another structural type, `any`, `unknown` or a type parameter counts as
 * reaching it; a type assertion to a subtype of the copy's type, or out of
 * `any` or `unknown`, extends where the copy may flow.
 */

/** @unjournaled Pure functions of the checked program, kept across replays. */
const answers = new WeakMap<
    ts.Type,
    WeakMap<ts.Type, Map<string, string | null>>
>();
/** @unjournaled Pure functions of the checked program, kept across replays. */
const arrayCopyAnswers = new WeakMap<
    ts.Type,
    WeakMap<ts.Type, string | null>
>();
/** @unjournaled Pure functions of the checked program, kept across replays. */
const arrayIdentityAnswers = new WeakMap<ts.Type, string | null>();

/**
 * Why a native copy of a `source` record stored as `target` could be told
 * apart from the shared JavaScript object, or undefined when nothing in the
 * program can. `fields` are the properties the copy keeps; `carries` says
 * whether the source records have other properties the copy drops; an
 * `argument` handed to a callee that only reads it needs only the writes
 * of the code the call runs.
 */
export function recordCopyObservation(
    context: RecordObservationContext,
    source: ts.Type,
    target: ts.Type,
    fields: readonly string[],
    carries: boolean,
    argument?: ts.Node,
): string | undefined {
    const call = argument && readOnlyArgumentCall(context.checker, argument);
    const key = `${fields.join(",")}|${carries}`;
    let byTarget = answers.get(source);
    if (!byTarget) answers.set(source, (byTarget = new WeakMap()));
    let byKey = byTarget.get(target);
    if (!byKey)
        byTarget.set(target, (byKey = new Map<string, string | null>()));
    if (!call) {
        const known = byKey.get(key);
        if (known !== undefined) return known ?? undefined;
    }
    const observations = programObservations(context.program);
    const { checker } = context;
    const holds = holderTest(checker);
    // A write through either the original or the copy is missed by the
    // other. Only the copy can be told apart by identity or enumeration,
    // and it flows only where its target type flows.
    const either = [source, target];
    // An assertion can retype the copy as a subtype of its target, or as
    // anything once it went through `any` or `unknown`.
    const copyTypes = [
        target,
        ...observations.assertions
            .filter(
                ({ asserted, open }) =>
                    open || checker.isTypeAssignableTo(asserted, target),
            )
            .map(({ asserted }) => asserted),
    ];
    const keptWrite = (write: ObservedWrite): boolean =>
        write.property === undefined || fields.includes(write.property);
    if (call) {
        // A copy handed to a callee that only reads it lives for the call:
        // only a write while the call runs can make it stale.
        const reached = context.evaluationOrder.reachedCode(call);
        if (reached.opaque)
            return "the call runs code the program does not hold";
        const during = writesWhere(
            observations,
            (type) => holds(type, either),
            (write) =>
                keptWrite(write) &&
                ts.findAncestor(
                    write.node,
                    (node) => node === call || reached.units.has(node),
                ) !== undefined,
        );
        return during === undefined
            ? undefined
            : during.property === undefined
              ? "the call writes properties of such records"
              : `the call writes '${during.property}' of such records`;
    }
    const answer = observed(
        observations,
        (type) => holds(type, either),
        (type) => holds(type, copyTypes),
        keptWrite,
        carries,
    );
    byKey.set(key, answer ?? null);
    return answer;
}

/**
 * Why a native copy of an array of plain values (numbers, strings,
 * booleans and their unions, which have no identity of their own), stored
 * where the program reads it as `target`, could be told apart from the one
 * array JavaScript keeps, or undefined when nothing in the program can: a
 * change of the elements or length of an array that may be the original
 * (or, when `target` is mutable, the copy), or an identity use of an array
 * the copy's type may hold.
 *
 * An array of a narrower or equal element type may be the original. One
 * of a wider element type may be too only where the program widens a
 * mutable array of the original's element type (array covariance, or an
 * assertion); a readonly array is never written.
 */
export function arrayCopyObservation(
    context: RecordObservationContext,
    source: ts.Type,
    target: ts.Type,
): string | undefined {
    let byTarget = arrayCopyAnswers.get(source);
    if (!byTarget) arrayCopyAnswers.set(source, (byTarget = new WeakMap()));
    let answer = byTarget.get(target);
    if (answer === undefined) {
        answer = observedArrayCopy(context, source, target) ?? null;
        byTarget.set(target, answer);
    }
    return answer ?? undefined;
}

function observedArrayCopy(
    context: RecordObservationContext,
    source: ts.Type,
    target: ts.Type,
): string | undefined {
    const observations = programObservations(context.program);
    const { checker } = context;
    const elementOf = (type: ts.Type): ts.Type | undefined =>
        checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    const sourceElement = elementOf(source);
    const targetElement = elementOf(target);
    const assignable = (from: ts.Type, to: ts.Type): boolean =>
        checker.isTypeAssignableTo(from, to);
    // A wider array type holds the original only where a mutable array
    // that may be it (its elements within the original's) is widened to an
    // element type the holder's admits, or asserted to one.
    const widenedInto = (element: ts.Type): boolean =>
        sourceElement === undefined ||
        observations.widenedArrays.some(
            ({ own, wide, evolving }) =>
                assignable(wide, element) &&
                // A local read as still empty may be the original only
                // where it is read with such elements elsewhere.
                (evolving
                    ? (
                          observations.arrayLocalElements.get(evolving) ?? []
                      ).some(
                          (read) =>
                              (read.flags & ts.TypeFlags.Never) === 0 &&
                              assignable(read, sourceElement),
                      )
                    : assignable(own, sourceElement)),
        ) ||
        observations.assertions.some(({ asserted, open }) => {
            const wide =
                checker.isArrayType(asserted) &&
                asserted.getSymbol()?.name === "Array"
                    ? elementOf(asserted)
                    : undefined;
            return (
                wide !== undefined &&
                assignable(wide, element) &&
                (open || assignable(sourceElement, wide))
            );
        });
    const targetMutable =
        checker.isArrayType(target) && target.getSymbol()?.name === "Array";
    const writtenHolder = (holder: ts.Type): boolean =>
        holdsArray(checker, holder, [source, target], (element) => {
            if (
                sourceElement === undefined ||
                assignable(element, sourceElement) ||
                (assignable(sourceElement, element) && widenedInto(element))
            )
                return true;
            return (
                targetMutable &&
                targetElement !== undefined &&
                assignable(targetElement, element)
            );
        });
    if (
        writesWhere(
            observations,
            writtenHolder,
            (write) => !writesNewArray(checker, write),
            observations.arrayWrites,
        )
    )
        return "the program changes the elements of such arrays";
    return arrayIdentityObservation(context, target);
}

/**
 * Why a native copy of an array, stored where the program reads it as
 * `target`, could be told apart from the array JavaScript keeps by its
 * identity alone, or undefined when no identity use (`ProgramObservations`)
 * can reach an array of that type. An assertion to a subtype of `target`,
 * or out of `any` or `unknown`, extends where the copy may flow.
 */
export function arrayIdentityObservation(
    context: RecordObservationContext,
    target: ts.Type,
): string | undefined {
    let answer = arrayIdentityAnswers.get(target);
    if (answer === undefined) {
        answer = observedArrayIdentity(context, target) ?? null;
        arrayIdentityAnswers.set(target, answer);
    }
    return answer ?? undefined;
}

function observedArrayIdentity(
    context: RecordObservationContext,
    target: ts.Type,
): string | undefined {
    const observations = programObservations(context.program);
    const { checker } = context;
    const copyTypes = [
        target,
        ...observations.assertions
            .filter(
                ({ asserted, open }) =>
                    open || checker.isTypeAssignableTo(asserted, target),
            )
            .map(({ asserted }) => asserted),
    ];
    if (
        [...observations.identities].some((type) =>
            holdsArray(checker, type, copyTypes, (element) =>
                copyTypes.some((copy) => {
                    const own = checker.getIndexTypeOfType(
                        copy,
                        ts.IndexKind.Number,
                    );
                    return (
                        own === undefined ||
                        checker.isTypeAssignableTo(own, element) ||
                        checker.isTypeAssignableTo(element, own)
                    );
                }),
            ),
        )
    )
        return "the program compares such arrays by identity";
    return undefined;
}

/**
 * Why a copy stored where the program reads it as `target` could be told
 * apart from the one object JavaScript keeps by its identity alone: the
 * array half (`arrayIdentityObservation`), or for a record an identity use
 * of a type that may hold it.
 */
export function identityObservation(
    context: RecordObservationContext,
    target: ts.Type,
): string | undefined {
    const { checker } = context;
    if (checker.isArrayLikeType(target))
        return arrayIdentityObservation(context, target);
    const observations = programObservations(context.program);
    const copyTypes = [
        target,
        ...observations.assertions
            .filter(
                ({ asserted, open }) =>
                    open || checker.isTypeAssignableTo(asserted, target),
            )
            .map(({ asserted }) => asserted),
    ];
    return [...observations.identities].some((type) =>
        holdsRecord(checker, type, copyTypes),
    )
        ? "the program compares such records by identity"
        : undefined;
}

/**
 * Why the object a declaration's literal creates must stay one runtime
 * object rather than a compile-time record or tuple rebuilt at each use,
 * found before lowering from the program's uses of the binding:
 *
 * - `identity`: a use may compare it by identity. Its references are
 *   followed through wrappers, selections, aliases and the parameters of
 *   program functions it is handed to; a use that only reads it (a member,
 *   an element, iteration, a callee that only reads the argument) observes
 *   nothing, an equality operand compares it, and any other use stores it
 *   where an identity use of that type may reach (`identityObservation`).
 *   Two empty-object tokens compared with each other are settled at
 *   generation (`foldSettledComparison`) unless either is one object.
 * - `receiverWrites`: the fields its methods write through `this`, which
 *   need the object where they hold generation-time constants.
 */
export interface OneObjectObservation {
    readonly identity?: string;
    readonly receiverWrites: readonly string[];
}

/** @unjournaled Pure functions of the checked program, kept across replays. */
const oneObjectAnswers = new WeakMap<
    ts.VariableDeclaration,
    OneObjectObservation
>();

export function oneObjectObservation(
    context: RecordObservationContext,
    declaration: ts.VariableDeclaration,
): OneObjectObservation {
    let known = oneObjectAnswers.get(declaration);
    if (!known) {
        const identity = tokenGroupIdentity(context, declaration);
        known = {
            ...(identity ? { identity } : {}),
            receiverWrites: receiverWrites(declaration.initializer),
        };
        oneObjectAnswers.set(declaration, known);
    }
    return known;
}

/** One declaration's own identity use, and the tokens it is compared with. */
interface IdentityUses {
    readonly reason?: string;
    readonly tokens: readonly ts.VariableDeclaration[];
}

/** @unjournaled Pure functions of the checked program, kept across replays. */
const identityUseAnswers = new WeakMap<ts.VariableDeclaration, IdentityUses>();

/**
 * The identity use of a declaration or of any empty-object token it is
 * compared with, transitively: one of them becoming one object leaves the
 * others' comparisons to run.
 */
function tokenGroupIdentity(
    context: RecordObservationContext,
    declaration: ts.VariableDeclaration,
): string | undefined {
    const group = new Set([declaration]);
    for (const member of group) {
        const uses = identityUses(context, member);
        if (uses.reason) return uses.reason;
        for (const token of uses.tokens) group.add(token);
    }
    return undefined;
}

function identityUses(
    context: RecordObservationContext,
    declaration: ts.VariableDeclaration,
): IdentityUses {
    const known = identityUseAnswers.get(declaration);
    if (known) return known;
    const { checker } = context;
    const tokens: ts.VariableDeclaration[] = [];
    const token = emptyTokenRoot(checker, declaration) === declaration;
    const followed: ts.Symbol[] = [];
    const follow = (name: ts.BindingName): void => {
        const symbol = ts.isIdentifier(name)
            ? declaredSymbol(checker, name)
            : undefined;
        if (symbol && !followed.includes(symbol)) followed.push(symbol);
    };
    follow(declaration.name);
    let reason: string | undefined;
    for (let index = 0; index < followed.length && !reason; index++)
        for (const reference of bindingReferences(context, followed[index]!)) {
            const use = flowingUse(reference);
            const parent = use.parent;
            if (isIdentityComparison(parent)) {
                const other = parent.left === use ? parent.right : parent.left;
                const partner = token
                    ? emptyTokenRoot(checker, other)
                    : undefined;
                if (partner) tokens.push(partner);
                else if (!nullishOperand(other))
                    reason = "the program compares it by identity";
            } else if (
                (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) &&
                parent.initializer === use &&
                ts.isIdentifier(parent.name)
            )
                follow(parent.name);
            else if (
                (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
                parent.expression !== use
            ) {
                const position = parent.arguments?.indexOf(use) ?? -1;
                const callee =
                    checker.getResolvedSignature(parent)?.declaration;
                // The engine takes what it is handed in its own storage:
                // a record or array converts at the call.
                if (
                    (callee && declarationOrigin(callee) === "babylon") ||
                    (ts.isCallExpression(parent) &&
                        callOnlyReadsArgument(checker, parent, position))
                )
                    continue;
                const parameter = programParameter(callee, parent, position);
                if (parameter) follow(parameter.name);
                else reason = storedIdentity(context, use);
            } else if (!onlyReads(use, parent))
                reason = storedIdentity(context, use);
            if (reason) break;
        }
    const uses = { ...(reason ? { reason } : {}), tokens };
    identityUseAnswers.set(declaration, uses);
    return uses;
}

/** Why a value stored where the program reads it may be compared by identity. */
function storedIdentity(
    context: RecordObservationContext,
    use: ts.Expression,
): string | undefined {
    const { checker } = context;
    return identityObservation(
        context,
        checker.getContextualType(use) ?? checker.getTypeAtLocation(use),
    );
}

/** An equality, which compares object operands by identity. */
function isIdentityComparison(node: ts.Node): node is ts.BinaryExpression {
    if (!ts.isBinaryExpression(node)) return false;
    const operator = node.operatorToken.kind;
    return (
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        operator === ts.SyntaxKind.EqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsToken
    );
}

function nullishOperand(node: ts.Expression): boolean {
    const unwrapped = unwrapExpression(node);
    return (
        unwrapped.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") ||
        ts.isVoidExpression(unwrapped)
    );
}

/**
 * A use that reads the value without keeping, comparing or handing it on:
 * a member or element read, iteration, a spread of its contents, a
 * destructuring, a statement of its own, or an operator reading it as a
 * primitive.
 */
function onlyReads(use: ts.Expression, parent: ts.Node): boolean {
    return (
        ((ts.isPropertyAccessExpression(parent) ||
            ts.isElementAccessExpression(parent)) &&
            parent.expression === use) ||
        ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
            parent.expression === use) ||
        ts.isSpreadElement(parent) ||
        ts.isSpreadAssignment(parent) ||
        ts.isExpressionStatement(parent) ||
        ts.isTypeOfExpression(parent) ||
        ts.isVoidExpression(parent) ||
        ts.isTemplateSpan(parent) ||
        ts.isPrefixUnaryExpression(parent) ||
        (isAssignmentExpression(parent) && parent.left === use) ||
        (ts.isVariableDeclaration(parent) && !ts.isIdentifier(parent.name)) ||
        (ts.isBinaryExpression(parent) &&
            !isAssignmentExpression(parent) &&
            parent.operatorToken.kind !== ts.SyntaxKind.CommaToken)
    );
}

/**
 * The expression a reference's value flows on as: through wrappers and
 * the arms of a selection (`?:`, `??`, `||`, the right of `&&`).
 */
function flowingUse(reference: ts.Expression): ts.Expression {
    let current = climb(reference);
    for (;;) {
        const parent = current.parent;
        if (
            (ts.isConditionalExpression(parent) &&
                parent.condition !== current) ||
            (ts.isBinaryExpression(parent) &&
                (parent.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken ||
                    parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                    (parent.operatorToken.kind ===
                        ts.SyntaxKind.AmpersandAmpersandToken &&
                        parent.right === current)))
        )
            current = climb(parent);
        else return current;
    }
}

/**
 * The parameter an argument at `position` binds in a function the program
 * holds; undefined for a rest parameter, after a spread, or where the
 * callee's body is not the program's.
 */
function programParameter(
    declaration: ts.Declaration | undefined,
    call: ts.CallExpression | ts.NewExpression,
    position: number,
): ts.ParameterDeclaration | undefined {
    if (
        position < 0 ||
        !declaration ||
        !ts.isFunctionLike(declaration) ||
        !("body" in declaration) ||
        !declaration.body ||
        call.arguments?.slice(0, position).some(ts.isSpreadElement)
    )
        return undefined;
    const parameter = declaration.parameters[position];
    return parameter && !parameter.dotDotDotToken ? parameter : undefined;
}

/**
 * The empty-object token (`const token = {}`) a declaration is, or an
 * expression names through `const` aliases.
 */
function emptyTokenRoot(
    checker: ts.TypeChecker,
    node: ts.Expression | ts.VariableDeclaration,
): ts.VariableDeclaration | undefined {
    const named = (expression: ts.Expression) => {
        const name = unwrapExpression(expression);
        const declaration = ts.isIdentifier(name)
            ? resolvedSymbol(checker, name)?.valueDeclaration
            : undefined;
        return declaration && ts.isVariableDeclaration(declaration)
            ? declaration
            : undefined;
    };
    const seen = new Set<ts.VariableDeclaration>();
    let current = ts.isVariableDeclaration(node) ? node : named(node);
    while (current?.initializer && !seen.has(current)) {
        seen.add(current);
        if (
            !ts.isVariableDeclarationList(current.parent) ||
            (current.parent.flags & ts.NodeFlags.Const) === 0
        )
            return undefined;
        const initializer = unwrapExpression(current.initializer);
        if (
            ts.isObjectLiteralExpression(initializer) &&
            initializer.properties.length === 0
        )
            return current;
        current = named(initializer);
    }
    return undefined;
}

/** @unjournaled Pure functions of the checked program, kept across replays. */
const namedIdentifiers = new WeakMap<
    ts.SourceFile,
    ReadonlyMap<string, readonly ts.Identifier[]>
>();

/** A file's identifiers outside type positions, by name. */
function identifiersByName(
    file: ts.SourceFile,
): ReadonlyMap<string, readonly ts.Identifier[]> {
    let known = namedIdentifiers.get(file);
    if (!known) {
        const names = new Map<string, ts.Identifier[]>();
        const visit = (node: ts.Node): void => {
            if (ts.isTypeNode(node)) return;
            if (ts.isIdentifier(node)) {
                const list = names.get(node.text);
                if (list) list.push(node);
                else names.set(node.text, [node]);
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
        namedIdentifiers.set(file, (known = names));
    }
    return known;
}

/**
 * The expressions reading a binding: in its own file, and for a module
 * binding in every file of the program, by its name or the local name an
 * import gives it.
 */
function bindingReferences(
    context: RecordObservationContext,
    symbol: ts.Symbol,
): ts.Expression[] {
    const declaration = symbol.valueDeclaration;
    if (!declaration) return [];
    const moduleBinding =
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableStatement(declaration.parent.parent) &&
        ts.isSourceFile(declaration.parent.parent.parent);
    const files = moduleBinding
        ? context.program
              .getSourceFiles()
              .filter((file) => !file.isDeclarationFile)
        : [declaration.getSourceFile()];
    const declared = ts.getNameOfDeclaration(declaration);
    return files.flatMap((file) => {
        const byName = identifiersByName(file);
        const names = new Set([symbol.name]);
        for (const identifier of byName.get(symbol.name) ?? []) {
            const specifier = identifier.parent;
            if (
                (ts.isImportSpecifier(specifier) ||
                    ts.isExportSpecifier(specifier)) &&
                specifier.propertyName === identifier
            )
                names.add(specifier.name.text);
        }
        return [...names].flatMap((name) =>
            (byName.get(name) ?? []).flatMap((identifier) => {
                const parent = identifier.parent;
                // A namespace import reads a module binding as `m.name`.
                const member =
                    ts.isPropertyAccessExpression(parent) &&
                    parent.name === identifier;
                return identifier !== declared &&
                    !ts.isImportSpecifier(parent) &&
                    !ts.isExportSpecifier(parent) &&
                    (!member || moduleBinding) &&
                    resolvedSymbol(context.checker, identifier) === symbol
                    ? [member ? parent : identifier]
                    : [];
            }),
        );
    });
}

/** The fields a literal's methods write through `this`. */
function receiverWrites(initializer: ts.Expression | undefined): string[] {
    const literal = initializer && unwrapExpression(initializer);
    if (!literal || !ts.isObjectLiteralExpression(literal)) return [];
    const fields = new Set<string>();
    const written = (target: ts.Expression): void => {
        const access = unwrapExpression(target);
        if (
            ts.isPropertyAccessExpression(access) &&
            access.expression.kind === ts.SyntaxKind.ThisKeyword
        )
            fields.add(access.name.text);
    };
    const visit = (node: ts.Node): void => {
        if (
            ts.isClassLike(node) ||
            (ts.isFunctionLike(node) && !ts.isArrowFunction(node))
        )
            return;
        if (isAssignmentExpression(node))
            assignmentTargets(node.left).forEach(written);
        else if (isUpdateExpression(node)) written(node.operand);
        ts.forEachChild(node, visit);
    };
    for (const property of literal.properties) {
        const method =
            ts.isMethodDeclaration(property) ||
            ts.isGetAccessorDeclaration(property) ||
            ts.isSetAccessorDeclaration(property)
                ? property
                : ts.isPropertyAssignment(property) &&
                    ts.isFunctionExpression(property.initializer)
                  ? property.initializer
                  : undefined;
        if (method?.body) ts.forEachChild(method.body, visit);
    }
    return [...fields];
}

/**
 * Whether a value of type `holder` can be one of the arrays typed
 * `arrays`: an open type, a non-array object type the arrays are
 * assignable to, or an array type whose element type `related` accepts.
 */
function holdsArray(
    checker: ts.TypeChecker,
    holder: ts.Type,
    arrays: readonly ts.Type[],
    related: (element: ts.Type) => boolean,
): boolean {
    if (holder.isUnion() || holder.isIntersection())
        return holder.types.some((member) =>
            holdsArray(checker, member, arrays, related),
        );
    const element = checker.getIndexTypeOfType(holder, ts.IndexKind.Number);
    if (element === undefined || (holder.flags & ts.TypeFlags.Object) === 0)
        return holdsRecord(checker, holder, arrays);
    // A type parameter's array holds what its constraint admits.
    if ((element.flags & ts.TypeFlags.TypeParameter) !== 0) {
        const constraint = checker.getBaseConstraintOfType(element);
        return (
            constraint === undefined ||
            constraint === element ||
            (constraint.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
                0 ||
            arrays.some((array) => {
                const own = checker.getIndexTypeOfType(
                    array,
                    ts.IndexKind.Number,
                );
                return (
                    own === undefined ||
                    checker.isTypeAssignableTo(own, constraint) ||
                    checker.isTypeAssignableTo(constraint, own)
                );
            })
        );
    }
    return related(element);
}

function observed(
    observations: ProgramObservations,
    holdsEither: (type: ts.Type) => boolean,
    holdsCopy: (type: ts.Type) => boolean,
    keptWrite: (write: ObservedWrite) => boolean,
    carries: boolean,
): string | undefined {
    const written = writesWhere(observations, holdsEither, keptWrite);
    if (written)
        return written.property === undefined
            ? "the program writes properties of such records"
            : `the program writes '${written.property}' of such records`;
    if ([...observations.identities].some(holdsCopy))
        return "the program compares or keys such records by identity";
    const addsProperty =
        carries ||
        writesWhere(
            observations,
            holdsEither,
            (write) => write.property !== undefined && !keptWrite(write),
        ) !== undefined;
    if (addsProperty && [...observations.enumerations].some(holdsCopy))
        return "the program enumerates properties of such records";
    return undefined;
}

/**
 * The first write, in program order, of an object whose static type
 * `holds`, matching `matches`.
 */
function writesWhere(
    observations: ProgramObservations,
    holds: (type: ts.Type) => boolean,
    matches: (write: ObservedWrite) => boolean,
    index: ReadonlyMap<ts.Type, readonly ObservedWrite[]> = observations.writes,
): ObservedWrite | undefined {
    let first: ObservedWrite | undefined;
    for (const [type, writes] of index) {
        const write = writes.find(
            (candidate) =>
                (first === undefined || candidate.order < first.order) &&
                matches(candidate),
        );
        if (write && holds(type)) first = write;
    }
    return first;
}

/**
 * Whether a value of type `holder` can be a record of one of `records`, one
 * answer per holder and record list.
 */
function holderTest(
    checker: ts.TypeChecker,
): (holder: ts.Type, records: readonly ts.Type[]) => boolean {
    const known = new Map<readonly ts.Type[], Map<ts.Type, boolean>>();
    return (holder, records) => {
        let byHolder = known.get(records);
        if (!byHolder)
            known.set(records, (byHolder = new Map<ts.Type, boolean>()));
        let holds = byHolder.get(holder);
        if (holds === undefined) {
            holds = holdsRecord(checker, holder, records);
            byHolder.set(holder, holds);
        }
        return holds;
    };
}

function holdsRecord(
    checker: ts.TypeChecker,
    holder: ts.Type,
    records: readonly ts.Type[],
): boolean {
    // A type parameter holds whatever its constraint admits; an
    // unconstrained one holds anything.
    if ((holder.flags & ts.TypeFlags.TypeParameter) !== 0) {
        const constraint = checker.getBaseConstraintOfType(holder);
        return (
            constraint === undefined ||
            constraint === holder ||
            holdsRecord(checker, constraint, records)
        );
    }
    const open =
        ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.TypeParameter |
        ts.TypeFlags.Index |
        ts.TypeFlags.IndexedAccess |
        ts.TypeFlags.Conditional |
        ts.TypeFlags.Substitution |
        ts.TypeFlags.NonPrimitive;
    if ((holder.flags & open) !== 0) return true;
    if (holder.isUnion())
        return holder.types.some((member) =>
            holdsRecord(checker, member, records),
        );
    if (
        holder.isIntersection() &&
        holder.types.some((member) => (member.flags & open) !== 0)
    )
        return true;
    if (
        (holder.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) ===
        0
    )
        return false;
    // A record union's value is a record of one of its members.
    return records.some((record) =>
        (record.isUnion() ? record.types : [record]).some((member) =>
            checker.isTypeAssignableTo(member, holder),
        ),
    );
}

/** A wrapper that keeps the value of the expression it encloses. */
function climb(node: ts.Expression): ts.Expression {
    let current = node;
    while (
        ts.isParenthesizedExpression(current.parent) ||
        ts.isNonNullExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent)
    )
        current = current.parent;
    return current;
}

/**
 * The call a value is handed to as `argument`, when the callee only reads
 * that parameter (`callOnlyReadsArgument`): a copy passed there lives for
 * the call alone, and nothing but a write while it runs can tell it apart.
 */
function readOnlyArgumentCall(
    checker: ts.TypeChecker,
    argument: ts.Node,
): ts.CallExpression | undefined {
    if (!ts.isExpression(argument)) return undefined;
    const use = climb(argument);
    const call = use.parent;
    return ts.isCallExpression(call) &&
        call.expression !== use &&
        callOnlyReadsArgument(checker, call, call.arguments.indexOf(use))
        ? call
        : undefined;
}

/**
 * Whether the callee a value is handed to as `argument` only reads that
 * parameter: never writes, compares, enumerates, stores, returns or captures
 * it, so it can neither grow nor outlive the call through the callee.
 */
export function argumentOnlyRead(
    checker: ts.TypeChecker,
    argument: ts.Node,
): boolean {
    return readOnlyArgumentCall(checker, argument) !== undefined;
}

/**
 * Whether the array `expression` evaluates is read element by element
 * where it is produced, then dropped: the initializer of an array
 * destructuring declaration, reached through wrappers and the arms of a
 * selection (`?:`, `??`, `||`, the right of `&&`), binding names without a
 * default that can run code. Nothing runs between taking a copy of the
 * array and reading it, and nothing keeps the copy, so the two agree.
 */
export function arrayDestructuredAtOnce(expression: ts.Expression): boolean {
    let current = climb(expression);
    let parent = current.parent;
    while (
        (ts.isConditionalExpression(parent) && parent.condition !== current) ||
        (ts.isBinaryExpression(parent) &&
            (parent.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken ||
                parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                (parent.operatorToken.kind ===
                    ts.SyntaxKind.AmpersandAmpersandToken &&
                    parent.right === current)))
    ) {
        current = climb(parent);
        parent = current.parent;
    }
    return (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === current &&
        ts.isArrayBindingPattern(parent.name) &&
        parent.name.elements.every(
            (element) =>
                ts.isOmittedExpression(element) ||
                (!element.dotDotDotToken &&
                    ts.isIdentifier(element.name) &&
                    (!element.initializer ||
                        !expressionMayRunCode(element.initializer))),
        )
    );
}

/**
 * Whether an array handed as `argument` to a callee that only reads it can
 * be lent as a copy for the call: the callee keeps neither the array nor an
 * element, and nothing the call runs changes the elements or length of an
 * array that may be the original. A write of an element's fields while the
 * call runs is the element copies' own question.
 */
export function arrayLentForCall(
    context: RecordObservationContext,
    argument: ts.Node,
): boolean {
    const call = readOnlyArgumentCall(context.checker, argument);
    if (!call) return false;
    const reached = context.evaluationOrder.reachedCode(call);
    if (reached.opaque) return false;
    const array = context.checker.getTypeAtLocation(argument);
    const observations = programObservations(context.program);
    const holds = (type: ts.Type): boolean =>
        holdsRecord(context.checker, type, [array]);
    const during = (write: ObservedWrite): boolean =>
        ts.findAncestor(
            write.node,
            (node) => node === call || reached.units.has(node),
        ) !== undefined &&
        !createdDuringCall(context.checker, write, call, reached.units);
    // An engine or ambient function may change any array it is handed.
    return (
        writesWhere(observations, holds, during, observations.arrayWrites) ===
            undefined &&
        writesWhere(
            observations,
            holds,
            (write) => write.property === undefined && during(write),
        ) === undefined
    );
}

/**
 * Whether an array write changes an array the call itself creates: a new
 * array (`new Array(n).fill(x)`), or a `const` local of a function the
 * call enters (not the one it is written in) initialized with one, so
 * every activation holds its own array and none existed before the call.
 */
/** Whether an array write's receiver is a new array (`new Array(n).fill(0)`). */
function writesNewArray(
    checker: ts.TypeChecker,
    write: ObservedWrite,
): boolean {
    const target = ts.isCallExpression(write.node)
        ? write.node.expression
        : write.node;
    return (
        (ts.isPropertyAccessExpression(target) ||
            ts.isElementAccessExpression(target)) &&
        newArrayExpression(checker, unwrapExpression(target.expression))
    );
}

function createdDuringCall(
    checker: ts.TypeChecker,
    write: ObservedWrite,
    call: ts.CallExpression,
    units: ReadonlySet<ts.Node>,
): boolean {
    const target = ts.isCallExpression(write.node)
        ? write.node.expression
        : write.node;
    if (
        !ts.isPropertyAccessExpression(target) &&
        !ts.isElementAccessExpression(target)
    )
        return false;
    if (writesNewArray(checker, write)) return true;
    const receiver = unwrapExpression(target.expression);
    if (!ts.isIdentifier(receiver)) return false;
    const declaration = declaredSymbol(checker, receiver)?.valueDeclaration;
    if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !declaration.initializer ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
        !newArrayExpression(checker, declaration.initializer)
    )
        return false;
    const owner = ts.findAncestor(declaration, ts.isFunctionLike);
    return (
        owner !== undefined &&
        units.has(owner) &&
        ts.findAncestor(call, (node) => node === owner) === undefined
    );
}

/** An array expression that evaluates to an array no earlier reference holds. */
function newArrayExpression(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    const unwrapped = unwrapExpression(expression);
    if (ts.isConditionalExpression(unwrapped))
        return (
            newArrayExpression(checker, unwrapped.whenTrue) &&
            newArrayExpression(checker, unwrapped.whenFalse)
        );
    // These methods return their receiver.
    if (
        ts.isCallExpression(unwrapped) &&
        ts.isPropertyAccessExpression(unwrapped.expression) &&
        ["fill", "copyWithin", "reverse", "sort"].includes(
            unwrapped.expression.name.text,
        ) &&
        checker.isArrayLikeType(
            checker.getTypeAtLocation(unwrapped.expression.expression),
        )
    )
        return newArrayExpression(checker, unwrapped.expression.expression);
    return yieldsNewArray(checker, unwrapped);
}

/**
 * Whether a record returned as `returned` is the last reference to it: a
 * local of the returning function, initialized with a fresh object
 * (`fresh`), whose other uses only read or write its properties, outside
 * any nested function. A copy returned there replaces the only reference.
 */
export function returnedRecordLocal(
    checker: ts.TypeChecker,
    returned: ts.Node,
    fresh: (initializer: ts.Expression) => boolean,
): boolean {
    if (!ts.isExpression(returned)) return false;
    const unwrapped = unwrapExpression(returned);
    if (!ts.isIdentifier(unwrapped)) return false;
    const use = climb(unwrapped);
    const owner = ts.findAncestor(use.parent, ts.isFunctionLike);
    if (
        !owner ||
        !(
            ts.isReturnStatement(use.parent) ||
            (ts.isArrowFunction(use.parent) && use.parent.body === use)
        )
    )
        return false;
    const symbol = declaredSymbol(checker, unwrapped);
    const declaration = symbol?.valueDeclaration;
    if (
        !symbol ||
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        ts.findAncestor(declaration, ts.isFunctionLike) !== owner ||
        !fresh(declaration.initializer)
    )
        return false;
    let only = true;
    forEachAnalysisNode(owner, (node) => {
        if (!only) return "skip";
        if (
            !ts.isIdentifier(node) ||
            node === unwrapped ||
            node === declaration.name ||
            declaredSymbol(checker, node) !== symbol
        )
            return;
        const reference = climb(node);
        const parent = reference.parent;
        only =
            ts.findAncestor(node.parent, ts.isFunctionLike) === owner &&
            (ts.isPropertyAccessExpression(parent) ||
                ts.isElementAccessExpression(parent)) &&
            parent.expression === reference &&
            !(
                ts.isCallExpression(climb(parent).parent) &&
                (climb(parent).parent as ts.CallExpression).expression ===
                    climb(parent)
            );
    });
    return only;
}
