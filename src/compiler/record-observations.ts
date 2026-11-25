import ts from "typescript";
import { writeGuardRejects } from "./value-guards.js";
import { forEachAnalysisNode, someAnalysisNode } from "./analysis-walk.js";
import { isOpaqueEngineObject, pinnedSourceHandleKind } from "./data-types.js";
import type { EvaluationOrder } from "./evaluation-order.js";
import { callOnlyReadsArgument } from "./parameter-effects.js";
import { lengthPreservingArrayMethods } from "./receiver-methods.js";
import {
    nullability,
    arrayElementType,
    arrayShape,
    callSignatures,
    libraryDeclaredType,
    objectLikeType,
    reachedTypes,
    signatureParameterTypes,
    stringIndexType,
    unionMembers,
    viewsAnyRecord,
    weakTypeProperties,
} from "./type-facts.js";
import {
    programObservations,
    type MemberDefinition,
    type ObservedWrite,
    type ProgramObservations,
} from "./program-observations.js";
import {
    arrayHeldOnlyByItsLocal,
    freshConstLocal,
    yieldsNewArray,
} from "./fresh-records.js";
import { enclosedReference } from "./array-length-growth.js";
import {
    determinedTypeArguments,
    mentionsTypeParameter,
} from "./type-arguments.js";
import {
    bindingReferences,
    exportedUnderAnotherName,
    soleBindingRead,
} from "./binding-references.js";
import { OPEN_HOLDER_FLAGS } from "./written-holders.js";
import {
    declarationInDefaultLibrary,
    declarationOrigin,
    declaredSymbol,
    resolvedSymbol,
    nullishLiteral,
    calledDeclaration,
    calledFunction,
    calledOrigin,
    calledParameterType,
    namedMember,
    libraryStaticMember,
} from "./symbols.js";
import {
    expressionMayRunCode,
    isOperandSelection,
    outermostWrapper,
    unwrapExpression,
    valueOperands,
    isExpressionWrapper,
    writeSites,
    writeSiteOf,
    equalityOperator,
    positionalParameter,
    variableKind,
    propertyKey,
    literalKey,
    valueConsumer,
    isGeneratorFunction,
    isDestructuringPattern,
    wrappedParent,
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
const arrayWriteAnswers = new WeakMap<
    ts.Type,
    WeakMap<ts.Type, string | null>
>();
/** @unjournaled Pure functions of the checked program, kept across replays. */
const builtArrayWriteAnswers = new WeakMap<
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
 * of the code the call runs. A class instance's `view` lists only the
 * record type's members when enumerated (fidelity.md), and as its object's
 * only handle (`"sole"`) cannot be told apart by identity.
 */
export function recordCopyObservation(
    context: RecordObservationContext,
    source: ts.Type,
    target: ts.Type,
    fields: readonly string[],
    carries: boolean,
    argument?: ts.Node,
    view?: "sole" | "shared",
): string | undefined {
    const call = argument && readOnlyArgumentCall(context.checker, argument);
    // A lent copy's answer is the call's own.
    const lent = call ? `|${call.getSourceFile().fileName}:${call.pos}` : "";
    const key = `${fields.join(",")}|${carries}|${view ?? ""}${lent}`;
    let byTarget = answers.get(source);
    if (!byTarget) answers.set(source, (byTarget = new WeakMap()));
    let byKey = byTarget.get(target);
    if (!byKey)
        byTarget.set(target, (byKey = new Map<string, string | null>()));
    const known = byKey.get(key);
    if (known !== undefined) return known ?? undefined;
    const observations = programObservations(context.program);
    const { checker } = context;
    const holds = holderTest(checker);
    // A write through either the original or the copy is missed by the
    // other. Only the copy can be told apart by identity or enumeration,
    // and it flows only where its target type flows.
    const either = [source, target];
    const copies = copyTypes(checker, observations, target);
    const keptWrite = (write: ObservedWrite): boolean =>
        write.property === undefined || fields.includes(write.property);
    if (call) {
        // A copy handed to a callee that only reads it lives for the call:
        // only a write while the call runs can make it stale.
        const reached = context.evaluationOrder.reachedCode(call);
        const during = reached.opaque
            ? undefined
            : writesWhere(
                  observations,
                  (type) => holds(type, either),
                  (write) =>
                      keptWrite(write) &&
                      ts.findAncestor(
                          write.node,
                          (node) => node === call || reached.units.has(node),
                      ) !== undefined,
              );
        const answer = reached.opaque
            ? "the call runs code the program does not hold"
            : during === undefined
              ? undefined
              : during.property === undefined
                ? "the call writes properties of such records"
                : `the call writes '${during.property}' of such records`;
        byKey.set(key, answer ?? null);
        return answer;
    }
    const answer = observed(
        observations,
        (type) => holds(type, either),
        (type) => holds(type, copies),
        keptWrite,
        carries,
        view,
    );
    byKey.set(key, answer ?? null);
    return answer;
}

/** @unjournaled Pure answers of the checked program, kept across replays. */
const ownTypeReads = new WeakMap<ts.Type, boolean>();

/**
 * Whether the program reaches a record of the object literal type `literal`
 * through that type itself: a read, call, write or enumeration of its
 * members, or a copy or wholesale read of it, through an expression the
 * checker types as it. A read through a destructuring assignment target, which names no
 * source, reaches it.
 */
export function observedUnderOwnType(
    context: RecordObservationContext,
    literal: ts.Type,
): boolean {
    const known = ownTypeReads.get(literal);
    if (known !== undefined) return known;
    const { checker } = context;
    const observations = programObservations(context.program);
    const own = (type: ts.Type): boolean =>
        unionMembers(checker.getNonNullableType(type)).includes(literal);
    const typed = (node: ts.Node): boolean =>
        own(checker.getTypeAtLocation(node));
    const observed =
        [...observations.writes.keys()].some(own) ||
        [...observations.enumerations].some(own) ||
        checker
            .getPropertiesOfType(literal)
            .some((property) =>
                [
                    ...(observations.namedReads.get(property.name) ?? []),
                    ...(observations.memberCalls.get(property.name) ?? []),
                ].some(({ object }) => object === undefined || typed(object)),
            ) ||
        observations.wholesaleReads.some(typed) ||
        observations.copies.some(({ from }) => typed(from));
    ownTypeReads.set(literal, observed);
    return observed;
}

/** Where a record's own keys can show, over a program ({@link undeclaredMembersObservable}). */
interface KeyObservations {
    /** The types whose values' own keys are viewed, none viewing any record. */
    readonly views: readonly ts.Type[];
    /**
     * The types of values handed or asserted where any record may be viewed,
     * or handed to code the program does not hold.
     */
    readonly escapes: readonly ts.Type[];
    /** Values a hand-off, a spread or an assertion carries, own keys and all, into an `into`. */
    readonly flows: readonly {
        readonly from: ts.Type;
        readonly into: ts.Type;
    }[];
    /** A member defined reflectively is read as a function value: every record may show. */
    readonly unbounded: boolean;
}

/** @unjournaled Pure functions of the checked program, kept across replays. */
const keyObservations = new WeakMap<ts.Program, KeyObservations>();
/** @unjournaled Pure answers of the checked program, kept across replays. */
const undeclaredMemberAnswers = new WeakMap<ts.Type, boolean>();

/**
 * Whether the program could see a member a record of type `record` holds
 * that its type does not declare: through a key view
 * (`ProgramObservations.keyViews`) of a type that can hold it; through a
 * value that can hold it handed or asserted where any record may be viewed
 * (`viewsAnyRecord`) or handed to code the program does not hold, the
 * default library's aside; or through a hand-off, a spread or an assertion
 * of it into a type whose records could. A view of a type that views any record sees
 * such a record only through the value that widened into it: one handed
 * or asserted, or one handed to a function whose parameter reads wider
 * than its callers type it.
 */
export function undeclaredMembersObservable(
    program: ts.Program,
    checker: ts.TypeChecker,
    record: ts.Type,
): boolean {
    const known = undeclaredMemberAnswers.get(record);
    if (known !== undefined) return known;
    let index = keyObservations.get(program);
    if (!index)
        keyObservations.set(
            program,
            (index = indexKeyObservations(program, checker)),
        );
    const { views, escapes, flows, unbounded } = index;
    if (unbounded) return true;
    const observable = (candidate: ts.Type, seen: Set<ts.Type>): boolean => {
        // A cycle of copies shows nothing of its own.
        if (seen.has(candidate)) return false;
        seen.add(candidate);
        const holds = (holder: ts.Type): boolean =>
            holdsRecord(checker, holder, [candidate]);
        return (
            views.some(holds) ||
            escapes.some(holds) ||
            flows.some(
                ({ from, into }) => holds(from) && observable(into, seen),
            )
        );
    };
    const answer = observable(record, new Set());
    undeclaredMemberAnswers.set(record, answer);
    return answer;
}

/** {@link KeyObservations}, from the program's observations. */
function indexKeyObservations(
    program: ts.Program,
    checker: ts.TypeChecker,
): KeyObservations {
    const observations = programObservations(program);
    const typeOf = (node: ts.Node): ts.Type => checker.getTypeAtLocation(node);
    const wide = (type: ts.Type): boolean => viewsAnyRecord(checker, type);
    const escapes = new Set<ts.Type>();
    const flows: { from: ts.Type; into: ts.Type }[] = [];
    const flowing = new Map<ts.Type, Set<ts.Type>>();
    // A value that escapes takes every record it leads to along: code that
    // views it as any record can walk into what it holds.
    const escapeReached = (type: ts.Type): void => {
        for (const reached of reachedTypes(checker, type))
            if (!wide(reached)) escapes.add(reached);
    };
    // A value handed on is seen as its slot's type there too, member by
    // member: an interface's record given to an alias-typed slot takes the
    // alias's implicit index signature on, and so do the records it holds.
    const reach = (from: ts.Type, into: ts.Type | undefined): void => {
        if (wide(from) || into === undefined || into === from) return;
        if (wide(into)) {
            escapeReached(from);
            return;
        }
        if (!unionMembers(from).some(objectLikeType)) return;
        let targets = flowing.get(from);
        if (!targets) flowing.set(from, (targets = new Set()));
        if (targets.has(into)) return;
        targets.add(into);
        flows.push({ from, into });
        const element = arrayElementType(checker, from);
        const slotElement = arrayElementType(checker, into);
        if (element && slotElement) reach(element, slotElement);
        if (libraryDeclaredType(from)) return;
        for (const slot of unionMembers(checker.getNonNullableType(into)))
            for (const property of checker.getPropertiesOfType(from)) {
                const member = checker.getPropertyOfType(slot, property.name);
                reach(
                    checker.getTypeOfSymbol(property),
                    member
                        ? checker.getTypeOfSymbol(member)
                        : stringIndexType(checker, slot),
                );
            }
    };
    for (const value of observations.handed) {
        const own = typeOf(value);
        if (wide(own)) continue;
        // A member of a literal is handed where the literal is.
        const root = literalRoot(value);
        if (
            foreignArgument(checker, value) ||
            (root !== outermostWrapper(value) &&
                ts.isExpression(root) &&
                wide(checker.getContextualType(root) ?? typeOf(root)))
        )
            escapeReached(own);
        else reach(own, checker.getContextualType(value));
    }
    // A function whose parameter reads wider than its callers type it
    // (`(v: object) => Object.keys(v)` given where `(value: T) => void` is
    // expected) views what they hand it as any record: what the expected
    // signature passes, and as a call's argument all its receiver and
    // arguments lead to.
    const parameterTypes = (node: ts.Node, type = typeOf(node)) =>
        callSignatures(checker, type, "present").flatMap((signature) =>
            signatureParameterTypes(checker, signature, node),
        );
    const widens = (parameter: ts.Type): boolean =>
        reachedTypes(checker, parameter).some(wide);
    for (const value of [
        ...observations.handed,
        ...observations.givenFunctions,
    ]) {
        const own = parameterTypes(value).filter(widens);
        if (own.length === 0) continue;
        const contextual = checker.getContextualType(value);
        const expected = contextual ? parameterTypes(value, contextual) : [];
        if (own.every((parameter) => expected.includes(parameter))) continue;
        expected.forEach(escapeReached);
        const call = argumentCall(value);
        if (!call) continue;
        const receiver = namedMember(
            checker,
            unwrapExpression(call.expression),
        );
        if (receiver) escapeReached(typeOf(receiver.expression));
        for (const argument of call.arguments ?? [])
            escapeReached(typeOf(argument));
    }
    // A member defined as such a function is called through any type naming
    // it: every call of a member of that name hands it its arguments. A read
    // of it as a function value lets it go where the walk cannot follow, so
    // its parameter may receive whatever its declared type admits; a
    // reflective definition's value is not followed and admits anything.
    let unbounded = false;
    const definedFunction = (
        definition: Exclude<MemberDefinition, { via: "reflect" }>,
    ): ts.Node | undefined => {
        switch (definition.via) {
            case "literal":
            case "write":
                return (
                    definition.stored ??
                    (ts.isMethodDeclaration(definition.node)
                        ? definition.node.name
                        : undefined)
                );
            case "class":
                return ts.isPropertyDeclaration(definition.node) &&
                    definition.node.initializer
                    ? definition.node.initializer
                    : ts.isMethodDeclaration(definition.node) ||
                        ts.isParameter(definition.node)
                      ? definition.node.name
                      : undefined;
        }
    };
    const wideningParameters = (
        definition: MemberDefinition,
    ): readonly ts.Type[] | undefined => {
        if (definition.via === "reflect") return undefined;
        const defined = definedFunction(definition);
        return defined ? parameterTypes(defined).filter(widens) : [];
    };
    for (const [name, definitions] of observations.definitions) {
        const parameters = definitions.map(wideningParameters);
        if (parameters.every((types) => types?.length === 0)) continue;
        for (const { node } of observations.memberCalls.get(name) ?? []) {
            const call = ts.isExpression(node) && wrappedParent(node);
            if (call && ts.isCallExpression(call))
                for (const argument of call.arguments)
                    escapeReached(typeOf(argument));
        }
        if (
            (observations.namedReads.get(name) ?? []).some(
                ({ node }) =>
                    callSignatures(checker, typeOf(node), "present").length > 0,
            )
        )
            for (const types of parameters)
                if (types === undefined) unbounded = true;
                else
                    for (const parameter of types)
                        for (const reached of reachedTypes(checker, parameter))
                            escapes.add(reached);
    }
    // A rest's keys are a key view; a spread's land in the literal.
    for (const { from, into } of observations.copies) {
        if (!ts.isObjectLiteralExpression(into) || isDestructuringPattern(into))
            continue;
        const own = typeOf(from);
        if (wide(own)) continue;
        const target = checker.getContextualType(into) ?? typeOf(into);
        if (foreignArgument(checker, into)) escapeReached(own);
        else reach(own, target);
    }
    for (const assertion of observations.typeAssertions) {
        if (ts.isConstTypeReference(assertion.type)) continue;
        const own = typeOf(unwrapExpression(assertion.expression));
        if (wide(own)) continue;
        reach(own, typeOf(assertion));
    }
    return {
        views: [...observations.keyViews].filter((view) => !wide(view)),
        escapes: [...escapes],
        flows,
        unbounded,
    };
}

/** The outermost literal a value is a member or element of, or the value: through wrappers each. */
function literalRoot(value: ts.Node): ts.Node {
    let site = outermostWrapper(value);
    while (
        ts.isPropertyAssignment(site.parent) ||
        ts.isShorthandPropertyAssignment(site.parent) ||
        ts.isSpreadAssignment(site.parent) ||
        ts.isSpreadElement(site.parent) ||
        ts.isArrayLiteralExpression(site.parent) ||
        ts.isObjectLiteralExpression(site.parent)
    )
        site =
            ts.isArrayLiteralExpression(site.parent) ||
            ts.isObjectLiteralExpression(site.parent)
                ? outermostWrapper(site.parent)
                : site.parent;
    return site;
}

/** The call a value is given to as an argument, itself or as a part of literals. */
function argumentCall(
    value: ts.Node,
): ts.CallExpression | ts.NewExpression | undefined {
    const site = literalRoot(value);
    const call = site.parent;
    return (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
        (call.arguments ?? []).some((argument) => argument === site)
        ? call
        : undefined;
}

/**
 * Whether a value is given, itself or as a part of literals, to a call of
 * code the program does not hold, the default library's aside: a callee
 * the checker resolves to no declaration, or to one without a body.
 */
function foreignArgument(checker: ts.TypeChecker, value: ts.Node): boolean {
    const call = argumentCall(value);
    if (!call || calledFunction(checker, call)) return false;
    const declaration = calledDeclaration(checker, call);
    return !(declaration && declarationInDefaultLibrary(declaration));
}

/**
 * Whether any write in the program can replace `property` on a record of
 * `source` type: one through a holder that can hold such a record, or through
 * a more specific type whose records the program can also view as `source`.
 * Asking only whether the field stays present, a plain assignment of a value
 * that is neither null nor undefined cannot remove it. A record whose object
 * an `origin` literal creates is reached by no write through a `const` holding
 * another literal's object (`ObservedWrite.freshObject`). With `holding`, the
 * value the field is known to hold, a write that runs only when its slot
 * holds another value (`writeGuardRejects`) is not counted.
 */
export function recordFieldIsWritten(
    context: RecordObservationContext,
    source: ts.Type,
    property: string,
    keepsPresent = false,
    origin?: ts.Node,
    holding?: { readonly value: unknown },
): boolean {
    return cachedFieldWrite(
        context,
        source,
        property,
        keepsPresent,
        origin,
        false,
        holding,
    );
}

/**
 * Whether any write in the program can add, replace or delete a key of a
 * map record of `source` type (one declaring an index signature): through a
 * holder of a type that can hold such a record and is not open to any value,
 * or through any holder with a key only the run time knows. A named write
 * through an open holder is attributed to the types declaring its name, as
 * {@link recordFieldIsWritten} attributes it.
 */
export function recordKeysAreWritten(
    context: RecordObservationContext,
    source: ts.Type,
): boolean {
    const holds = holderTest(context.checker);
    const observations = programObservations(context.program);
    return (
        writesWhere(
            observations,
            (type) =>
                (type.flags & OPEN_HOLDER_FLAGS) === 0 && holds(type, [source]),
            () => true,
        ) !== undefined ||
        writesWhere(
            observations,
            (type) => holds(type, [source]),
            (write) => write.property === undefined,
        ) !== undefined
    );
}

/**
 * Whether a write in the program can replace `property` on a record of
 * `source` type once that record is built: as
 * {@link recordFieldIsWritten}, but a write through a function's own
 * `const` holding a fresh literal's object, in that function's own body
 * (no nested function, no generator), builds the object before the
 * function returns it, and is not counted. What such a write stores is
 * the reader's to know. With `holding`, the value the member is known to
 * hold, a write that runs only when its slot holds another value
 * (`writeGuardRejects`) is not counted either.
 */
export function builtRecordFieldIsWritten(
    context: RecordObservationContext,
    source: ts.Type,
    property: string,
    holding?: { readonly value: unknown },
): boolean {
    return cachedFieldWrite(
        context,
        source,
        property,
        false,
        undefined,
        true,
        holding,
    );
}

/** {@link recordFieldIsWritten} or {@link builtRecordFieldIsWritten}, kept per type and question. */
function cachedFieldWrite(
    context: RecordObservationContext,
    source: ts.Type,
    property: string,
    keepsPresent: boolean,
    origin: ts.Node | undefined,
    built: boolean,
    holding?: { readonly value: unknown },
): boolean {
    const site = origin
        ? `${origin.getSourceFile().fileName}:${origin.pos}:${origin.end}:${origin.kind}`
        : "";
    const held = holding
        ? `${typeof holding.value}:${String(holding.value)}`
        : "";
    const key = `${property}|${keepsPresent}|${site}|${built}|${held}`;
    let byKey = writtenFields.get(source);
    if (!byKey) writtenFields.set(source, (byKey = new Map<string, boolean>()));
    let written = byKey.get(key);
    if (written === undefined) {
        written = fieldWriteFound(
            context,
            source,
            property,
            keepsPresent,
            origin,
            built,
            holding,
        );
        byKey.set(key, written);
    }
    return written;
}

/**
 * Whether `write` goes through a function's own `const` holding a fresh
 * literal's object, in that function's own body: it builds that
 * invocation's object, before the function hands it out.
 */
function buildsFreshObject(write: ObservedWrite): boolean {
    const literal = write.freshObject;
    if (!literal) return false;
    const owner = ts.findAncestor(literal.parent, ts.isFunctionLike);
    return (
        owner !== undefined &&
        !isGeneratorFunction(owner) &&
        ts.findAncestor(write.node.parent, ts.isFunctionLike) === owner
    );
}

/**
 * @unjournaled {@link recordFieldIsWritten}'s answers by record type and
 * question: pure functions of the checked program, kept across replays.
 */
const writtenFields = new WeakMap<ts.Type, Map<string, boolean>>();

/** {@link cachedFieldWrite}, computed. */
function fieldWriteFound(
    context: RecordObservationContext,
    source: ts.Type,
    property: string,
    keepsPresent: boolean,
    origin: ts.Node | undefined,
    built: boolean,
    holding: { readonly value: unknown } | undefined,
): boolean {
    const { checker } = context;
    const observations = programObservations(context.program);
    const holds = holderTest(checker);
    const records = [source];
    const mentionsTypeParameter = (
        type: ts.Type,
        seen = new Set<ts.Type>(),
    ): boolean => {
        if (seen.has(type)) return false;
        seen.add(type);
        if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return true;
        if (type.isUnionOrIntersection())
            return type.types.some((member) =>
                mentionsTypeParameter(member, seen),
            );
        return (
            (type.flags & ts.TypeFlags.Object) !== 0 &&
            ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !==
                0 &&
            checker
                .getTypeArguments(type as ts.TypeReference)
                .some((argument) => mentionsTypeParameter(argument, seen))
        );
    };
    // A holder instantiated over a type parameter may be any concrete
    // instantiation, which assignability cannot relate to `source`; only a
    // write that names the property is attributed to it.
    // A record type whose properties are all optional takes only a value
    // that shares one of them, as the checker's weak-type rule requires of
    // every assignment; its assignability test alone admits any object.
    const weakProperties = weakTypeProperties(checker, source);
    const viewedAsSource = (holder: ts.Type): boolean =>
        unionMembers(holder).some(
            (member) =>
                checker.isTypeAssignableTo(member, source) &&
                (!weakProperties ||
                    weakProperties.some(
                        (property) =>
                            checker.getPropertyOfType(member, property.name) !==
                            undefined,
                    )),
        );
    const mayRemove = (write: ObservedWrite): boolean => {
        const assignment = write.node.parent;
        if (
            !ts.isBinaryExpression(assignment) ||
            assignment.left !== write.node ||
            assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
        )
            return true;
        const absent = nullability(checker.getTypeAtLocation(assignment.right));
        return absent.null || absent.undefined;
    };
    const relevant = (write: ObservedWrite): boolean =>
        (!keepsPresent || mayRemove(write)) &&
        (origin === undefined ||
            write.freshObject === undefined ||
            write.freshObject === origin) &&
        !(built && buildsFreshObject(write)) &&
        !(
            holding &&
            writeGuardRejects(
                checker,
                context.program.getSourceFiles(),
                write.node,
                holding.value,
            )
        );
    return (
        writesWhere(
            observations,
            (type) => holds(type, records) || viewedAsSource(type),
            (write) =>
                (write.property === undefined || write.property === property) &&
                relevant(write),
        ) !== undefined ||
        writesWhere(
            observations,
            mentionsTypeParameter,
            (write) => write.property === property && relevant(write),
        ) !== undefined
    );
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
    return (
        arrayWriteObservation(context, source, target) ??
        arrayIdentityObservation(context, target)
    );
}

/**
 * Writes that may change an array's contents; identity observations do not
 * change its size. With `read`, the expression an array is read through, a
 * write through a binding that builds its array before sharing it
 * (`buildsUnsharedArray`) counts only when `read` names such a binding:
 * any other expression reaches that array once it is built.
 */
export function arrayWriteObservation(
    context: RecordObservationContext,
    source: ts.Type,
    target: ts.Type,
    read?: ts.Expression,
): string | undefined {
    const built = read !== undefined && !buildsUnsharedArray(context, read);
    const cached = built ? builtArrayWriteAnswers : arrayWriteAnswers;
    let byTarget = cached.get(source);
    if (!byTarget) cached.set(source, (byTarget = new WeakMap()));
    let answer = byTarget.get(target);
    if (answer === undefined) {
        answer = observedArrayWrites(context, source, target, built) ?? null;
        byTarget.set(target, answer);
    }
    return answer ?? undefined;
}

/**
 * Why the elements of an array of `type`'s elements, only ever referenced
 * as readonly arrays (`readonly number[]`) -- a literal a record field of
 * that type holds alone, or one `constantArrayWriteObservation` follows --
 * could change, or undefined when nothing can: no reference to it writes,
 * so only an assertion retyping a value as, or as holding, a mutable array
 * that may hold its elements makes it writable.
 */
export function readonlyArrayWriteObservation(
    context: RecordObservationContext,
    type: ts.Type,
): string | undefined {
    let answer = readonlyArrayWriteAnswers.get(type);
    if (answer === undefined) {
        answer = assertedWritableArray(context, type) ?? null;
        readonlyArrayWriteAnswers.set(type, answer);
    }
    return answer ?? undefined;
}

/** @unjournaled {@link readonlyArrayWriteObservation}'s answers by type: pure functions of the checked program. */
const readonlyArrayWriteAnswers = new WeakMap<ts.Type, string | null>();

/** Whether an element type may be one of an array of `type`'s elements. */
function elementRelated(
    checker: ts.TypeChecker,
    type: ts.Type,
): (other: ts.Type) => boolean {
    const element = arrayElementType(checker, type);
    return (other) =>
        element === undefined ||
        checker.isTypeAssignableTo(element, other) ||
        checker.isTypeAssignableTo(other, element);
}

/** {@link readonlyArrayWriteObservation}, computed. */
function assertedWritableArray(
    context: RecordObservationContext,
    type: ts.Type,
): string | undefined {
    const { checker } = context;
    const related = elementRelated(checker, type);
    const assertion = programObservations(context.program).assertions.find(
        ({ asserted }) =>
            holdsMutableArray(checker, asserted, related, new Set()),
    );
    return (
        assertion &&
        `an assertion to '${checker.typeToString(assertion.asserted)}' may write such arrays`
    );
}

/**
 * Why the elements of the array a `const` binding's array literal creates
 * could change, or undefined when nothing can: every reference to the
 * binding hands the array on where the program holds it only as a readonly
 * array (`handedOnReadonly`), so the binding's own mutable type writes
 * nothing and, as for a record field's own literal, only an assertion
 * makes it writable (`readonlyArrayWriteObservation`).
 */
export function constantArrayWriteObservation(
    context: RecordObservationContext,
    declaration: ts.VariableDeclaration,
): string | undefined {
    let answer = constantArrayWriteAnswers.get(declaration);
    if (answer === undefined) {
        answer = constantArrayWrite(context, declaration) ?? null;
        constantArrayWriteAnswers.set(declaration, answer);
    }
    return answer ?? undefined;
}

/** @unjournaled {@link constantArrayWriteObservation}'s answers by declaration: pure functions of the checked program. */
const constantArrayWriteAnswers = new WeakMap<
    ts.VariableDeclaration,
    string | null
>();

/** {@link constantArrayWriteObservation}, computed. */
function constantArrayWrite(
    context: RecordObservationContext,
    declaration: ts.VariableDeclaration,
): string | undefined {
    const { program, checker } = context;
    const symbol = ts.isIdentifier(declaration.name)
        ? declaredSymbol(checker, declaration.name)
        : undefined;
    if (
        !symbol ||
        variableKind(declaration) !== "const" ||
        !declaration.initializer ||
        !ts.isArrayLiteralExpression(unwrapExpression(declaration.initializer))
    )
        return "the binding is not a constant created by its array literal";
    if (exportedUnderAnotherName(program, checker, symbol))
        return "the binding leaves its module under another name";
    const type = checker.getTypeAtLocation(declaration.name);
    const related = elementRelated(checker, type);
    const mutable = bindingReferences(program, checker, symbol).find(
        (reference) => !handedOnReadonly(checker, reference, [], related),
    );
    if (mutable)
        return `'${mutable.getText()}' hands the array on where it may be written`;
    return readonlyArrayWriteObservation(context, type);
}

/**
 * Whether `at` hands the value whose member `path` is the array on only
 * where the program holds that member as a readonly array: through a
 * selection or an object literal's property into a binding's declared type,
 * an assignment target's type, or the parameter of an authored function or
 * of the engine's API. A generic callee's parameter is read both as its
 * body declares it and as the call instantiates it, which its result keeps.
 */
function handedOnReadonly(
    checker: ts.TypeChecker,
    at: ts.Expression,
    path: readonly string[],
    related: (element: ts.Type) => boolean,
): boolean {
    const holdsReadonly = (type: ts.Type): boolean => {
        let member: ts.Type | undefined = type;
        for (const key of path) {
            const property: ts.Symbol | undefined = checker.getPropertyOfType(
                checker.getNonNullableType(member),
                key,
            );
            member = property && checker.getTypeOfSymbol(property);
            if (!member) return false;
        }
        return !holdsMutableArray(checker, member, related, new Set());
    };
    const consumer = valueConsumer(outermostWrapper(at));
    switch (consumer.kind) {
        case "operand":
            return handedOnReadonly(checker, consumer.selection, path, related);
        case "property": {
            const key = propertyKey(consumer.name);
            return (
                key !== undefined &&
                handedOnReadonly(
                    checker,
                    consumer.literal,
                    [key, ...path],
                    related,
                )
            );
        }
        case "initializer":
            return (
                consumer.declaration.type !== undefined &&
                holdsReadonly(
                    checker.getTypeAtLocation(consumer.declaration.name),
                )
            );
        case "assigned":
            return holdsReadonly(
                checker.getTypeAtLocation(consumer.assignment.left),
            );
        case "argument": {
            const authored = calledFunction(checker, consumer.call);
            const declaration =
                authored ??
                (calledOrigin(checker, consumer.call) === "babylon"
                    ? calledDeclaration(checker, consumer.call)
                    : undefined);
            const parameter =
                declaration &&
                positionalParameter(consumer.call, declaration, consumer.index);
            const instantiated =
                parameter &&
                calledParameterType(
                    checker,
                    consumer.call,
                    declaration.parameters.indexOf(parameter),
                );
            return (
                parameter !== undefined &&
                instantiated !== undefined &&
                holdsReadonly(checker.getTypeAtLocation(parameter.name)) &&
                holdsReadonly(instantiated)
            );
        }
        default:
            return false;
    }
}

/**
 * Whether a value of `type` holds, as itself or anywhere inside, a mutable
 * array whose element type `related` accepts. An open type may hold any,
 * but an `unknown` one is written only through a further assertion, and a
 * type parameter holds what its constraint does.
 */
function holdsMutableArray(
    checker: ts.TypeChecker,
    type: ts.Type,
    related: (element: ts.Type) => boolean,
    seen: Set<ts.Type>,
): boolean {
    if (seen.has(type)) return false;
    seen.add(type);
    if ((type.flags & ts.TypeFlags.Unknown) !== 0) return false;
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
        const constraint = checker.getBaseConstraintOfType(type);
        return (
            constraint !== undefined &&
            holdsMutableArray(checker, constraint, related, seen)
        );
    }
    if ((type.flags & OPEN_HOLDER_FLAGS) !== 0) return true;
    if (type.isUnionOrIntersection())
        return type.types.some((member) =>
            holdsMutableArray(checker, member, related, seen),
        );
    const shape = arrayShape(checker, type);
    if (shape)
        return (
            (shape.mutable && related(shape.element)) ||
            holdsMutableArray(checker, shape.element, related, seen)
        );
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    return (
        checker
            .getPropertiesOfType(type)
            .some((property) =>
                holdsMutableArray(
                    checker,
                    checker.getTypeOfSymbol(property),
                    related,
                    seen,
                ),
            ) ||
        checker
            .getIndexInfosOfType(type)
            .some((index) =>
                holdsMutableArray(checker, index.type, related, seen),
            )
    );
}

/**
 * Whether `array` names a binding that builds its array before any other
 * reference can hold it: a function's `const` initialized with a new array,
 * named in no nested function or class, where every statement writing
 * through it ends before any reference sharing the array (one
 * `enclosedReference` rejects) begins, and no loop holds both but one whose
 * body declares the binding. Until then only the binding reaches that array.
 */
function buildsUnsharedArray(
    context: RecordObservationContext,
    array: ts.Expression,
): boolean {
    const name = unwrapExpression(array);
    const symbol = ts.isIdentifier(name)
        ? resolvedSymbol(context.checker, name)
        : undefined;
    if (!symbol) return false;
    let unshared = unsharedArrayBindings.get(symbol);
    if (unshared === undefined) {
        unshared = arrayBuiltBeforeShared(context, symbol);
        unsharedArrayBindings.set(symbol, unshared);
    }
    return unshared;
}

/** @unjournaled {@link buildsUnsharedArray}'s answers by binding: pure functions of the checked program. */
const unsharedArrayBindings = new WeakMap<ts.Symbol, boolean>();

/** {@link buildsUnsharedArray}, computed. */
function arrayBuiltBeforeShared(
    context: RecordObservationContext,
    symbol: ts.Symbol,
): boolean {
    const { program, checker } = context;
    const declaration = symbol.valueDeclaration;
    if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !declaration.initializer ||
        variableKind(declaration) !== "const" ||
        !newArrayExpression(checker, declaration.initializer)
    )
        return false;
    const owner = activationOf(declaration.parent);
    if (!owner || !ts.isFunctionLike(owner) || isGeneratorFunction(owner))
        return false;
    const written = observedWriteNodes(programObservations(program));
    const writes: ts.Statement[] = [];
    const shared: ts.Expression[] = [];
    for (const site of bindingReferences(program, checker, symbol)) {
        if (activationOf(site.parent) !== owner) return false;
        const statement = writingStatement(site, written);
        if (statement) writes.push(statement);
        if (!enclosedReference(checker, site)) shared.push(site);
    }
    const contains = (outer: ts.Node, inner: ts.Node): boolean =>
        outer.pos <= inner.pos && inner.end <= outer.end;
    // A loop whose body declares the binding runs a new one each iteration.
    const loopHolds = (statement: ts.Statement, use: ts.Expression): boolean =>
        ts.findAncestor(statement, (node) =>
            !ts.isIterationStatement(node, false)
                ? false
                : contains(node.statement, declaration)
                  ? "quit"
                  : contains(node, use),
        ) !== undefined;
    return writes.every((statement) =>
        shared.every(
            (use) =>
                statement.end <= use.getStart() && !loopHolds(statement, use),
        ),
    );
}

/** The function or class whose activation evaluates `node`. */
function activationOf(node: ts.Node): ts.Node | undefined {
    return ts.findAncestor(
        node,
        (ancestor) => ts.isFunctionLike(ancestor) || ts.isClassLike(ancestor),
    );
}

/**
 * The statement holding the write a reference to an array binding makes as
 * the receiver of an observed write (`ProgramObservations`): an element or
 * `length` write, or a mutating method call.
 */
function writingStatement(
    site: ts.Expression,
    written: ReadonlySet<ts.Node>,
): ts.Statement | undefined {
    const consumer = valueConsumer(outermostWrapper(site));
    if (consumer.kind !== "member") return undefined;
    const call = outermostWrapper(consumer.access).parent;
    return written.has(consumer.access) ||
        (ts.isCallExpression(call) && written.has(call))
        ? ts.findAncestor(consumer.access, ts.isStatement)
        : undefined;
}

/** Every observed write's node. */
function observedWriteNodes(
    observations: ProgramObservations,
): ReadonlySet<ts.Node> {
    let nodes = writeNodes.get(observations);
    if (!nodes) {
        nodes = new Set(
            [
                ...observations.arrayWrites.values(),
                ...observations.writes.values(),
            ]
                .flat()
                .map((write) => write.node),
        );
        writeNodes.set(observations, nodes);
    }
    return nodes;
}

/** @unjournaled {@link observedWriteNodes} per program: a pure function of the checked program. */
const writeNodes = new WeakMap<ProgramObservations, ReadonlySet<ts.Node>>();

function observedArrayWrites(
    context: RecordObservationContext,
    source: ts.Type,
    target: ts.Type,
    built: boolean,
): string | undefined {
    const observations = programObservations(context.program);
    const { checker } = context;
    const elementOf = (type: ts.Type): ts.Type | undefined =>
        arrayElementType(checker, type);
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
        observations.assertions.some(({ asserted, open, from }) => {
            const shape = arrayShape(checker, asserted);
            const wide =
                shape?.mutable && !shape.tuple ? shape.element : undefined;
            return (
                wide !== undefined &&
                assignable(wide, element) &&
                (open ||
                    assignable(sourceElement, wide) ||
                    from.some((type) => assignable(source, type)))
            );
        });
    const targetShape = arrayShape(checker, target);
    const targetMutable = targetShape?.mutable === true && !targetShape.tuple;
    const writtenHolder = (holder: ts.Type): boolean =>
        holdsArray(context, holder, [source, target], (element) => {
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
    const counted = (write: ObservedWrite): boolean => {
        if (writesNewArray(checker, write)) return false;
        if (!built) return true;
        const place = ts.isCallExpression(write.node)
            ? write.node.expression
            : write.node;
        return !(
            (ts.isPropertyAccessExpression(place) ||
                ts.isElementAccessExpression(place)) &&
            buildsUnsharedArray(context, place.expression)
        );
    };
    // A record write naming a key that is neither an index nor `length`
    // changes no element and no length of an array it may reach.
    const changesElements = (write: ObservedWrite): boolean =>
        write.property === undefined ||
        write.property === "length" ||
        String(Number(write.property)) === write.property;
    if (
        writesWhere(
            observations,
            writtenHolder,
            counted,
            observations.arrayWrites,
        ) ||
        writesWhere(
            observations,
            writtenHolder,
            (write) => changesElements(write) && counted(write),
        )
    )
        return "the program changes the elements of such arrays";
    return undefined;
}

/**
 * Why a native copy of an array, stored where the program reads it as
 * `target`, could be told apart from the array JavaScript keeps by its
 * identity alone, or undefined when no identity use (`ProgramObservations`)
 * can reach an array of that type. An assertion to a subtype of `target`,
 * or out of `any` or `unknown`, extends where the copy may flow.
 */
function arrayIdentityObservation(
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

/**
 * Whether an assertion can retype a copy of `copy` type: one through
 * `any` or `unknown` retypes anything, one to a subtype of `copy`
 * narrows it, and one a value of `copy` type reaches (`from`) hands it
 * on as the asserted type, related or not.
 */
function assertionRetypes(
    checker: ts.TypeChecker,
    assertion: ProgramObservations["assertions"][number],
    copy: ts.Type,
): boolean {
    return (
        assertion.open ||
        checker.isTypeAssignableTo(assertion.asserted, copy) ||
        assertion.from.some((from) => checker.isTypeAssignableTo(copy, from))
    );
}

/** The types a copy of `target` type has: its own and each an assertion retypes it to. */
function copyTypes(
    checker: ts.TypeChecker,
    observations: ProgramObservations,
    target: ts.Type,
): ts.Type[] {
    return [
        target,
        ...observations.assertions
            .filter((assertion) => assertionRetypes(checker, assertion, target))
            .map(({ asserted }) => asserted),
    ];
}

function observedArrayIdentity(
    context: RecordObservationContext,
    target: ts.Type,
): string | undefined {
    const observations = programObservations(context.program);
    const { checker } = context;
    const copies = copyTypes(checker, observations, target);
    if (
        [...observations.identities].some((type) =>
            holdsArray(context, type, copies, (element) =>
                copies.some((copy) => {
                    const own = arrayElementType(checker, copy);
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
 * Why the object a declaration's literal creates must stay one runtime
 * object rather than a compile-time record or tuple rebuilt at each use,
 * found before lowering from the program's uses of the binding:
 *
 * - `identity`: a use may compare it by identity. Its references are
 *   followed through wrappers, selections, aliases and the parameters of
 *   program functions it is handed to; a use that only reads it (a member,
 *   an element, iteration, a callee that only reads the argument) observes
 *   nothing, and an equality operand compares it. A tuple stored in an
 *   array slot is compared where arrays of the slot's type are
 *   (`arrayIdentityObservation`); a record or tuple stored anywhere else
 *   keeps the storage its sink gives it.
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
    const array = checker.isArrayLikeType(
        checker.getTypeAtLocation(declaration.name),
    );
    const { reads, follow, add } = objectReads(context);
    follow(declaration.name);
    let reason: string | undefined;
    for (let index = 0; index < reads.length && !reason; index++) {
        const use = flowingUse(reads[index]!);
        const parent = use.parent;
        if (isIdentityComparison(parent)) {
            const other = parent.left === use ? parent.right : parent.left;
            const partner = token ? emptyTokenRoot(checker, other) : undefined;
            if (partner) tokens.push(partner);
            else if (nullishLiteral(checker, other) === undefined)
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
            if (
                engineTakesArgument(checker, use) ||
                (ts.isCallExpression(parent) &&
                    callOnlyReadsArgument(checker, parent, position))
            )
                continue;
            const parameter = programParameter(
                calledDeclaration(checker, parent),
                parent,
                position,
            );
            if (parameter) follow(parameter.name);
            else if (array) reason = storedIdentity(context, use);
        } else if (array && !onlyReads(use)) {
            const member = handedMemberReads(context, use);
            if (member) add(member);
            else reason = storedIdentity(context, use);
        }
    }
    const uses = { ...(reason ? { reason } : {}), tokens };
    identityUseAnswers.set(declaration, uses);
    return uses;
}

/**
 * The expressions that read an object, as a walk over them finds more:
 * `follow` adds the references of a name that holds it, once per name;
 * `add` adds the reads of a member a callee was handed it as, once each.
 */
function objectReads(context: RecordObservationContext): {
    readonly reads: readonly ts.Expression[];
    readonly follow: (name: ts.BindingName) => void;
    readonly add: (more: readonly ts.Expression[]) => void;
} {
    const followed = new Set<ts.Symbol>();
    const reads: ts.Expression[] = [];
    const queued = new Set<ts.Expression>();
    const add = (more: readonly ts.Expression[]): void => {
        for (const read of more)
            if (!queued.has(read)) {
                queued.add(read);
                reads.push(read);
            }
    };
    const follow = (name: ts.BindingName): void => {
        const symbol = ts.isIdentifier(name)
            ? declaredSymbol(context.checker, name)
            : undefined;
        if (symbol && !followed.has(symbol)) {
            followed.add(symbol);
            add(bindingReferences(context.program, context.checker, symbol));
        }
    };
    return { reads, follow, add };
}

/** @unjournaled Pure functions of the checked program, kept across replays. */
const rebuiltAnswers = new WeakMap<ts.VariableDeclaration, string | null>();

/**
 * Why rebuilding, at each read of a declaration's binding, the objects its
 * initializer's literals create could be told apart from the one object
 * JavaScript keeps, or undefined when nothing can. The reads are followed
 * as {@link oneObjectObservation} follows them -- through wrappers,
 * selections, aliases, the parameters of program functions it is handed to
 * and the reads of the member an object literal hands it as -- and each
 * only reads the object: reads a member without calling it, tests,
 * stringifies, spreads or enumerates it, compares it with a nullish
 * literal, or hands it to a callee that only reads it, or to the engine,
 * which takes what a call hands it, however nested in literals, in its own
 * storage. A literal nested in another is rebuilt where its member is read,
 * which no read names.
 */
export function rebuiltObjectObservation(
    context: RecordObservationContext,
    declaration: ts.VariableDeclaration,
): string | undefined {
    const known = rebuiltAnswers.get(declaration);
    if (known !== undefined) return known ?? undefined;
    const { checker } = context;
    const nested =
        declaration.initializer !== undefined &&
        someAnalysisNode(
            declaration.initializer,
            (node) =>
                ts.isObjectLiteralExpression(node) &&
                node.properties.some((property) =>
                    someAnalysisNode(property, ts.isObjectLiteralExpression),
                ),
        );
    let reason = nested ? "a literal it creates holds another" : undefined;
    const { reads, follow, add } = objectReads(context);
    follow(declaration.name);
    for (let index = 0; index < reads.length && !reason; index++) {
        const use = flowingUse(reads[index]!);
        const consumer = valueConsumer(use);
        switch (consumer.kind) {
            case "member":
                if (writeSiteOf(consumer.access))
                    reason = "the program writes through it";
                else if (
                    valueConsumer(outermostWrapper(consumer.access)).kind ===
                    "called"
                )
                    reason = "the program calls a method of it";
                break;
            case "compared": {
                const { left, right } = consumer.comparison;
                if (
                    nullishLiteral(checker, left === use ? right : left) ===
                    undefined
                )
                    reason = "the program compares it by identity";
                break;
            }
            case "switched":
                reason = "the program compares it by identity";
                break;
            case "initializer":
                if (ts.isIdentifier(consumer.declaration.name))
                    follow(consumer.declaration.name);
                break;
            case "argument": {
                if (
                    engineTakesArgument(checker, use) ||
                    (ts.isCallExpression(consumer.call) &&
                        callOnlyReadsArgument(
                            checker,
                            consumer.call,
                            consumer.index,
                        ))
                )
                    break;
                const parameter = programParameter(
                    calledDeclaration(checker, consumer.call),
                    consumer.call,
                    consumer.index,
                );
                if (parameter) follow(parameter.name);
                else reason = "the program hands it to code it does not hold";
                break;
            }
            case "property":
            case "element": {
                if (engineTakesArgument(checker, use)) break;
                const member = handedMemberReads(context, use);
                if (member) add(member);
                else reason = "the program keeps it";
                break;
            }
            case "spread":
            case "operator":
            case "operand":
            case "keyed":
            case "tested":
            case "stringified":
            case "enumerated":
            case "discarded":
                break;
            default:
                reason = "the program keeps it";
        }
    }
    rebuiltAnswers.set(declaration, reason ?? null);
    return reason;
}

/**
 * Whether the engine takes `use` as what a call hands it, however nested in
 * literals: in its own storage, converted at the call.
 */
function engineTakesArgument(
    checker: ts.TypeChecker,
    use: ts.Expression,
): boolean {
    let holder: ts.Node = use;
    while (
        ts.isPropertyAssignment(holder.parent) ||
        ts.isShorthandPropertyAssignment(holder.parent) ||
        ts.isObjectLiteralExpression(holder.parent) ||
        ts.isArrayLiteralExpression(holder.parent) ||
        isExpressionWrapper(holder.parent)
    )
        holder = holder.parent;
    const call = holder.parent;
    const callee =
        (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
        call.expression !== holder
            ? calledDeclaration(checker, call)
            : undefined;
    return callee !== undefined && declarationOrigin(callee) === "babylon";
}

/**
 * The reads of the member an object literal hands `use` as to a function
 * the program holds (`f({ dir: use })`, `f({ dir })`): every
 * `parameter.dir` in its body. Undefined where the callee uses the
 * parameter otherwise (keeps, hands on or spreads the object), so the
 * member may be read where no reference names it.
 */
function handedMemberReads(
    context: RecordObservationContext,
    use: ts.Expression,
): readonly ts.Expression[] | undefined {
    const { checker } = context;
    const property = valueConsumer(use);
    if (property.kind !== "property") return undefined;
    const key = propertyKey(property.name);
    const handed = valueConsumer(flowingUse(property.literal));
    if (key === undefined || handed.kind !== "argument") return undefined;
    const parameter = programParameter(
        calledDeclaration(checker, handed.call),
        handed.call,
        handed.index,
    );
    const symbol =
        parameter &&
        ts.isIdentifier(parameter.name) &&
        declaredSymbol(checker, parameter.name);
    if (!symbol) return undefined;
    const memberReads: ts.Expression[] = [];
    for (const reference of bindingReferences(
        context.program,
        checker,
        symbol,
    )) {
        const read = valueConsumer(flowingUse(reference));
        if (
            read.kind !== "member" ||
            !ts.isPropertyAccessExpression(read.access)
        )
            return undefined;
        if (read.access.name.text === key) memberReads.push(read.access);
    }
    return memberReads;
}

/**
 * Why a tuple stored where the program reads it may be compared by
 * identity: only an array slot holds the tuple as an array, and the engine
 * takes what a call hands it, however nested in literals, in its own
 * storage.
 */
function storedIdentity(
    context: RecordObservationContext,
    use: ts.Expression,
): string | undefined {
    const { checker } = context;
    if (engineTakesArgument(checker, use)) return undefined;
    const slot = checker.getNonNullableType(
        descriptorValueSlot(checker, use) ??
            checker.getContextualType(use) ??
            checker.getTypeAtLocation(use),
    );
    return checker.isArrayLikeType(slot)
        ? arrayIdentityObservation(context, slot)
        : undefined;
}

/** A descriptor's `value` is stored in the defined property, not its `any`-typed descriptor slot. */
function descriptorValueSlot(
    checker: ts.TypeChecker,
    use: ts.Expression,
): ts.Type | undefined {
    const value = valueConsumer(use);
    if (value.kind !== "property" || propertyKey(value.name) !== "value")
        return undefined;
    const descriptor = valueConsumer(flowingUse(value.literal));
    let handed = descriptor;
    let key: string | undefined;
    if (descriptor.kind === "property") {
        key = propertyKey(descriptor.name);
        handed = valueConsumer(flowingUse(descriptor.literal));
    }
    if (handed.kind !== "argument" || !ts.isCallExpression(handed.call))
        return undefined;
    const member = libraryStaticMember(checker, handed.call.expression);
    if (member?.owner !== "Object") return undefined;
    if (
        member.name === "defineProperty" &&
        handed.index === 2 &&
        descriptor.kind === "argument"
    ) {
        const name = handed.call.arguments[1];
        key = name && literalKey(name);
    } else if (
        member.name !== "defineProperties" ||
        handed.index !== 1 ||
        descriptor.kind !== "property"
    )
        return undefined;
    const target = handed.call.arguments[0];
    if (target === undefined || key === undefined) return undefined;
    const property = checker.getPropertyOfType(
        checker.getTypeAtLocation(target),
        key,
    );
    return property && checker.getTypeOfSymbolAtLocation(property, target);
}

/** An equality, which compares object operands by identity. */
function isIdentityComparison(node: ts.Node): node is ts.BinaryExpression {
    return (
        ts.isBinaryExpression(node) &&
        equalityOperator(node.operatorToken.kind) !== undefined
    );
}

/**
 * A use that reads the value without keeping, comparing or handing it on:
 * a member or element read, iteration, a spread of its contents, a
 * destructuring, a statement of its own, or an operator reading it as a
 * primitive.
 */
function onlyReads(use: ts.Expression): boolean {
    const consumer = valueConsumer(use);
    switch (consumer.kind) {
        case "member":
        case "keyed":
        case "iterated":
        case "enumerated":
        case "spread":
        case "discarded":
        case "tested":
        case "stringified":
        case "operator":
        case "operand":
            return true;
        case "initializer":
            return !ts.isIdentifier(consumer.declaration.name);
        default: {
            // Rebinding the variable (including a destructuring target)
            // does not hand its previous object to the assignment.
            const write = writeSiteOf(use);
            return write?.kind === "assign" || write?.kind === "loop";
        }
    }
}

/** The expression a reference's value flows on as, past wrappers and the operators that yield it. */
function flowingUse(reference: ts.Expression): ts.Expression {
    return outermostWrapper(reference, { branches: "objects" });
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
        !declaration.body
    )
        return undefined;
    return positionalParameter(call, declaration, position);
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
            variableKind(current.parent) !== "const"
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
        for (const { target } of writeSites(node)) written(target);
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
    context: RecordObservationContext,
    holder: ts.Type,
    arrays: readonly ts.Type[],
    related: (element: ts.Type) => boolean,
): boolean {
    const { checker } = context;
    if (holder.isUnion() || holder.isIntersection())
        return holder.types.some((member) =>
            holdsArray(context, member, arrays, related),
        );
    const element = arrayElementType(checker, holder);
    if (element === undefined || (holder.flags & ts.TypeFlags.Object) === 0)
        return holdsRecord(checker, holder, arrays);
    // A type parameter's array holds what its function's calls bind it to
    // (`typeParameterBindings`), else what its constraint admits.
    if ((element.flags & ts.TypeFlags.TypeParameter) !== 0) {
        const bound = typeParameterBindings(context, element);
        if (bound) return bound.some(related);
        const constraint = checker.getBaseConstraintOfType(element);
        return (
            constraint === undefined ||
            constraint === element ||
            (constraint.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
                0 ||
            arrays.some((array) => {
                const own = arrayElementType(checker, array);
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

/**
 * What a function's type parameter stands for over the program: the type
 * each call binds it to (`determinedTypeArguments`), where every reference
 * to the function calls it, and a binding to a type parameter of the
 * calling function stands for what that one does. Undefined where the
 * parameter is no named function's, a reference hands the function on, or
 * a binding is a type that mentions a type parameter.
 */
function typeParameterBindings(
    context: RecordObservationContext,
    parameter: ts.Type,
    active: ReadonlySet<ts.Symbol> = new Set(),
): readonly ts.Type[] | undefined {
    const symbol = parameter.symbol;
    if (!symbol || active.has(symbol)) return undefined;
    let bound = typeParameterAnswers.get(symbol);
    if (bound === undefined) {
        bound =
            boundTypeArguments(
                context,
                parameter,
                new Set([...active, symbol]),
            ) ?? null;
        // An answer that leaned on an enclosing parameter being resolved
        // is that resolution's alone.
        if (active.size === 0) typeParameterAnswers.set(symbol, bound);
    }
    return bound ?? undefined;
}

/** @unjournaled {@link typeParameterBindings} by type parameter: pure functions of the checked program. */
const typeParameterAnswers = new WeakMap<
    ts.Symbol,
    readonly ts.Type[] | null
>();

/** {@link typeParameterBindings}, computed. */
function boundTypeArguments(
    context: RecordObservationContext,
    parameter: ts.Type,
    active: ReadonlySet<ts.Symbol>,
): readonly ts.Type[] | undefined {
    const { program, checker } = context;
    const declaration = parameter.symbol.declarations?.find(
        ts.isTypeParameterDeclaration,
    );
    const owner = declaration?.parent;
    const name =
        owner && ts.isFunctionDeclaration(owner)
            ? owner.name
            : owner &&
                (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
                ts.isVariableDeclaration(owner.parent) &&
                owner.parent.initializer === owner &&
                variableKind(owner.parent) === "const" &&
                ts.isIdentifier(owner.parent.name)
              ? owner.parent.name
              : undefined;
    const binding = name && declaredSymbol(checker, name);
    if (!owner || !binding || !ts.isFunctionLike(owner)) return undefined;
    const types: ts.Type[] = [];
    for (const site of bindingReferences(program, checker, binding)) {
        const reference = outermostWrapper(site);
        const call = reference.parent;
        if (!ts.isCallExpression(call) || call.expression !== reference)
            return undefined;
        const type = determinedTypeArguments(checker, call, owner).get(
            parameter.symbol,
        );
        if (!type) return undefined;
        if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
            const outer = typeParameterBindings(context, type, active);
            if (!outer) return undefined;
            types.push(...outer);
        } else if (mentionsTypeParameter(checker, type)) return undefined;
        else types.push(type);
    }
    return types;
}

function observed(
    observations: ProgramObservations,
    holdsEither: (type: ts.Type) => boolean,
    holdsCopy: (type: ts.Type) => boolean,
    keptWrite: (write: ObservedWrite) => boolean,
    carries: boolean,
    view: "sole" | "shared" | undefined,
): string | undefined {
    const written = writesWhere(observations, holdsEither, keptWrite);
    if (written)
        return written.property === undefined
            ? "the program writes properties of such records"
            : `the program writes '${written.property}' of such records`;
    if (view !== "sole" && [...observations.identities].some(holdsCopy))
        return "the program compares or keys such records by identity";
    const addsProperty =
        view === undefined &&
        (carries ||
            writesWhere(
                observations,
                holdsEither,
                (write) => write.property !== undefined && !keptWrite(write),
            ) !== undefined);
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
export function holderTest(
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

/**
 * Whether a value of type `holder` can be a record of one of `records`.
 * Under a generic instantiation each type the walk meets is first
 * `resolve`d to the type the active call binds; {@link holderTest} caches
 * the answers outside one.
 */
export function holdsRecord(
    checker: ts.TypeChecker,
    holder: ts.Type,
    records: readonly ts.Type[],
    resolve?: (type: ts.Type) => ts.Type,
): boolean {
    if (resolve) holder = resolve(holder);
    // A type parameter holds whatever its constraint admits; an
    // unconstrained one holds anything.
    if ((holder.flags & ts.TypeFlags.TypeParameter) !== 0) {
        const constraint = checker.getBaseConstraintOfType(holder);
        return (
            constraint === undefined ||
            constraint === holder ||
            holdsRecord(checker, constraint, records, resolve)
        );
    }
    if ((holder.flags & OPEN_HOLDER_FLAGS) !== 0) return true;
    if (holder.isUnion())
        return holder.types.some((member) =>
            holdsRecord(checker, member, records, resolve),
        );
    if (
        holder.isIntersection() &&
        holder.types.some((member) => (member.flags & OPEN_HOLDER_FLAGS) !== 0)
    )
        return true;
    if (
        (holder.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) ===
        0
    )
        return false;
    const holderHandle = pinnedSourceHandleKind(holder);
    const holderOpaque = isOpaqueEngineObject(checker, holder);
    // A record union's value is a record of one of its members.
    return records.some((record) =>
        unionMembers(record).some((member) => {
            const memberHandle = pinnedSourceHandleKind(member);
            if (holderHandle !== undefined || memberHandle !== undefined) {
                return holderHandle === memberHandle;
            }
            if (holderOpaque) return member.symbol === holder.symbol;
            return checker.isTypeAssignableTo(member, holder);
        }),
    );
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
    let use: ts.Expression = outermostWrapper(argument);
    // A property of an object literal handed to the call: the callee reads
    // it through that property of its parameter.
    let property: string | undefined;
    const assignment = use.parent;
    if (
        (ts.isPropertyAssignment(assignment) &&
            assignment.initializer === use) ||
        (ts.isShorthandPropertyAssignment(assignment) &&
            assignment.name === use)
    ) {
        property = propertyKey(assignment.name);
        if (property === undefined) return undefined;
        use = outermostWrapper(assignment.parent);
    }
    const call = use.parent;
    return ts.isCallExpression(call) &&
        call.expression !== use &&
        callOnlyReadsArgument(
            checker,
            call,
            call.arguments.indexOf(use),
            property,
        )
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
 * destructuring declaration, reached through wrappers and the operators
 * that yield it, binding names without a default that can run code.
 * Nothing runs between taking a copy of the array and reading it, and
 * nothing keeps the copy, so the two agree.
 */
export function arrayDestructuredAtOnce(expression: ts.Expression): boolean {
    const current = outermostWrapper(expression, { branches: "objects" });
    const parent = current.parent;
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
    // An array nothing else holds changes only through its local, which
    // does not run while the call reads the copy.
    if (
        ts.isExpression(argument) &&
        arrayHeldOnlyByItsLocal(context.checker, argument)
    )
        return true;
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
        variableKind(declaration.parent) !== "const" ||
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
    if (isOperandSelection(unwrapped))
        return valueOperands(unwrapped).every((operand) =>
            newArrayExpression(checker, operand),
        );
    // These methods return their receiver.
    const method = ts.isCallExpression(unwrapped)
        ? namedMember(checker, unwrapped.expression)
        : undefined;
    if (
        method &&
        lengthPreservingArrayMethods.has(method.name) &&
        checker.isArrayLikeType(checker.getTypeAtLocation(method.expression))
    )
        return newArrayExpression(checker, method.expression);
    return yieldsNewArray(checker, unwrapped);
}

/**
 * Whether `read` is the only reference to a `freshConstLocal`, read once
 * per binding (`soleBindingRead`). A copy stored there replaces the only
 * reference.
 */
export function soleReadOfFreshLocal(
    program: ts.Program,
    checker: ts.TypeChecker,
    read: ts.Expression,
    fresh: (initializer: ts.Expression) => boolean,
): boolean {
    const declaration = freshConstLocal(checker, read, fresh);
    return (
        declaration !== undefined &&
        soleBindingRead(program, checker, declaration) ===
            unwrapExpression(read)
    );
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
    const use = outermostWrapper(unwrapped);
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
        const reference = outermostWrapper(node);
        const parent = reference.parent;
        if (
            ts.findAncestor(node.parent, ts.isFunctionLike) !== owner ||
            !(
                ts.isPropertyAccessExpression(parent) ||
                ts.isElementAccessExpression(parent)
            ) ||
            parent.expression !== reference
        ) {
            only = false;
            return;
        }
        const member = outermostWrapper(parent);
        only = !(
            ts.isCallExpression(member.parent) &&
            member.parent.expression === member
        );
    });
    return only;
}
