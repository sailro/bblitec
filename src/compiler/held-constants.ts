import ts from "typescript";
import { sourceFileNodes } from "./analysis-walk.js";
import type { LoweringServices } from "./lowering-services.js";
import { programObservations } from "./program-observations.js";
import { holdsRecord } from "./record-observations.js";
import {
    calledDeclaration,
    libraryStaticMember,
    nullishLiteral,
    resolvedSymbol,
} from "./symbols.js";
import {
    accessKey,
    isDestructuringPattern,
    isModuleConstDeclaration,
    isTypeAssertion,
    literalKey,
    objectLiteralMembers,
    unwrapExpression,
    variableKind,
    writeSites,
    yieldedOperands,
} from "./syntax.js";
import {
    holdsOnly,
    nullability,
    stringLiteralValues,
    unionMembers,
} from "./type-facts.js";

export type HeldConstantsContext = Pick<
    LoweringServices,
    "bindings" | "checker" | "program" | "userFunctions"
>;

/**
 * The module constants a value can be, where the program picks it at run
 * time: through a selection (`?:`, `??`, `||`, `&&`), or by reading a
 * member no store sets to anything else (`entry.lane ?? DEFAULT_LANE`). One
 * reference names each constant. Undefined when the value can be another
 * object, or nothing picks it at run time.
 */
export function selectedModuleConstants(
    context: HeldConstantsContext,
    expression: ts.Expression,
): readonly ts.Identifier[] | undefined {
    const held = new HeldConstants(context).held(expression, true);
    return held?.selected && held.constants.length > 0
        ? held.constants
        : undefined;
}

/** What a value can be: one of `constants`, or absent. */
interface Held {
    readonly constants: readonly ts.Identifier[];
    readonly absent: boolean;
    /** Whether a run-time test or member read picks among them. */
    readonly selected: boolean;
}

const ABSENT: Held = { constants: [], absent: true, selected: false };

class HeldConstants {
    /** @unjournaled The nodes being read, for one query. */
    private readonly active = new Set<ts.Node>();

    constructor(private readonly context: HeldConstantsContext) {}

    /**
     * `local` reads a parameter of the call being inlined as its argument;
     * a value a member store spells is read in no call.
     */
    public held(expression: ts.Expression, local: boolean): Held | undefined {
        const node = unwrapExpression(expression);
        if (this.active.has(node)) return undefined;
        this.active.add(node);
        try {
            return this.read(node, local);
        } finally {
            this.active.delete(node);
        }
    }

    private read(node: ts.Expression, local: boolean): Held | undefined {
        const { checker } = this.context;
        // A selection (`?:`, `??`, `||`, `&&`) is one of the operands it
        // yields: their constants where it yields objects, their absence
        // where it yields nullish values.
        const operands = yieldedOperands(node);
        if (operands.length > 1 || operands[0]!.operand !== node) {
            const held: Held[] = [];
            let absent = false;
            for (const { operand, classes } of operands) {
                const one = this.held(operand, local);
                if (!one) return undefined;
                held.push(classes.has("truthy") ? one : ABSENT);
                absent ||= one.absent && classes.has("nullish");
            }
            return this.union(held, absent);
        }
        if (nullishLiteral(checker, node) !== undefined) return ABSENT;
        if (ts.isIdentifier(node)) {
            const symbol = resolvedSymbol(checker, node);
            const declaration =
                symbol?.valueDeclaration ?? symbol?.declarations?.[0];
            if (isModuleConstDeclaration(declaration))
                return { constants: [node], absent: false, selected: false };
            if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                ts.isIdentifier(declaration.name) &&
                declaration.initializer &&
                variableKind(declaration) === "const"
            )
                return this.held(declaration.initializer, local);
            const argument = local
                ? this.context.userFunctions.inlinedArgument(node, (name) =>
                      this.context.bindings.scopeOf(name),
                  )
                : undefined;
            return argument ? this.held(argument, local) : undefined;
        }
        if (ts.isPropertyAccessExpression(node)) return this.member(node);
        return undefined;
    }

    /** A data member's read: one of the values the program's stores give it. */
    private member(access: ts.PropertyAccessExpression): Held | undefined {
        const { checker, program } = this.context;
        const declarations = resolvedSymbol(checker, access)?.declarations;
        if (
            ts.isPrivateIdentifier(access.name) ||
            !declarations?.length ||
            !declarations.every(
                (declaration) =>
                    (ts.isPropertySignature(declaration) ||
                        ts.isPropertyDeclaration(declaration)) &&
                    !declaration.getSourceFile().isDeclarationFile,
            )
        )
            return undefined;
        const values = memberStores(
            program,
            checker,
            access.name.text,
            checker.getNonNullableType(
                checker.getTypeAtLocation(access.expression),
            ),
        );
        if (!values) return undefined;
        const held: Held[] = [];
        for (const value of values) {
            const one = this.held(value, false);
            if (!one) return undefined;
            held.push(one);
        }
        const absent = nullability(checker.getTypeAtLocation(access));
        return this.union(held, absent.null || absent.undefined);
    }

    /** The constants any of `held` can be, each named once, picked at run time. */
    private union(held: readonly Held[], absent: boolean): Held {
        const constants: ts.Identifier[] = [];
        const seen = new Set<ts.Node>();
        for (const one of held)
            for (const constant of one.constants) {
                const declaration =
                    resolvedSymbol(this.context.checker, constant)
                        ?.valueDeclaration ?? constant;
                if (seen.has(declaration)) continue;
                seen.add(declaration);
                constants.push(constant);
            }
        return { constants, absent, selected: true };
    }
}

/**
 * Where the program's objects get their members, from one walk of its
 * sources (type nodes skipped):
 *
 * - stores: the value each object literal's property or shorthand, and
 *   each assignment (`=`, `??=`, `||=`, `&&=`), gives a member of a known
 *   name; a copy (a spread, `Object.assign`) moves values stores gave;
 * - opened: the names some other site gives a value no store spells: a
 *   method, accessor or class member of that name, another update of it
 *   (compound, increment, a pattern or loop target);
 * - keyed: the objects, by static type, a run-time key may give any member
 *   (`names` the keys it can be, when a union of literals): a computed key,
 *   a keyed or reflective write, a copy of an untyped or index-signature
 *   source;
 * - viewed: the types a value the program may not have built is viewed as:
 *   an assertion from an `any`, `unknown` or index-signature type or one not
 *   assignable to it, a type guard's, the declared type such a value is
 *   handed to;
 * - escaped: the types of values the program views as `any` or an
 *   index-signature type, through which a run-time key may write them:
 *   handed where one is declared (but to a library function, which writes
 *   no member it does not declare unless reflectively), or asserted to one;
 * - unbounded: a site that may give an object any member: one setting its
 *   prototype, whose members read through it, or a class member under a
 *   run-time string key.
 */
interface MemberStores {
    readonly stores: ReadonlyMap<string, readonly ts.Expression[]>;
    readonly opened: ReadonlySet<string>;
    readonly keyed: readonly {
        readonly type: ts.Type;
        readonly names?: ReadonlySet<string>;
    }[];
    readonly viewed: readonly ts.Type[];
    readonly escaped: readonly ts.Type[];
    readonly unbounded: boolean;
}

/** @unjournaled Pure functions of the checked program, kept across replays. */
const programStores = new WeakMap<ts.Program, MemberStores>();

/**
 * Every value the program stores in the member `name` of an object read
 * as `holder`: undefined where a site can give that member a value no
 * store spells (`MemberStores`). Holders are judged as `ProgramObservations`
 * judges them (`holdsRecord`): a keyed site reaches `holder`'s objects when
 * a value of either type can be a record of the other, an escaped value
 * when it can be a `holder` record.
 */
export function memberStores(
    program: ts.Program,
    checker: ts.TypeChecker,
    name: string,
    holder: ts.Type,
): readonly ts.Expression[] | undefined {
    let index = programStores.get(program);
    if (!index)
        programStores.set(program, (index = indexStores(program, checker)));
    const declares = (type: ts.Type): boolean =>
        unionMembers(checker.getApparentType(type)).some(
            (member) => checker.getPropertyOfType(member, name) !== undefined,
        );
    const holds = (type: ts.Type): boolean =>
        untyped(type) || holdsRecord(checker, type, [holder]);
    return index.unbounded ||
        index.opened.has(name) ||
        libraryMemberNames(program).has(name) ||
        index.viewed.some(declares) ||
        index.escaped.some(holds) ||
        index.keyed.some(
            (site) =>
                (!site.names || site.names.has(name)) &&
                (holds(site.type) || holdsRecord(checker, holder, [site.type])),
        )
        ? undefined
        : (index.stores.get(name) ?? []);
}

function indexStores(
    program: ts.Program,
    checker: ts.TypeChecker,
): MemberStores {
    const stores = new Map<string, ts.Expression[]>();
    const store = (name: string, value: ts.Expression): void => {
        const values = stores.get(name);
        if (values) values.push(value);
        else stores.set(name, [value]);
    };
    const opened = new Set<string>();
    const keyed: { type: ts.Type; names?: ReadonlySet<string> }[] = [];
    const keyedBy = (target: ts.Node, key: ts.Expression): void => {
        const names = keyNames(checker, key);
        if (names?.size !== 0)
            keyed.push({
                type: checker.getTypeAtLocation(target),
                ...(names ? { names } : {}),
            });
    };
    const viewed: ts.Type[] = [];
    const escaped: ts.Type[] = [];
    const observations = programObservations(program);
    let unbounded = observations.foreignPrototype !== undefined;
    for (const value of observations.handed) {
        const type = checker.getTypeAtLocation(value);
        const declared = checker.getContextualType(value);
        if (!declared) continue;
        if (openType(checker, type)) viewed.push(declared);
        if (
            keyedView(checker, declared) &&
            !keyedView(checker, type) &&
            !libraryArgument(checker, value)
        )
            escaped.push(type);
    }
    for (const file of program.getSourceFiles()) {
        if (file.isDeclarationFile) continue;
        for (const node of sourceFileNodes(file)) {
            // A pattern's leaves are written where it assigns (below).
            if (ts.isObjectLiteralExpression(node)) {
                if (isDestructuringPattern(node)) continue;
                for (const member of objectLiteralMembers(node)) {
                    if (member.kind === "spread") {
                        const source = member.node.expression;
                        if (
                            openType(checker, checker.getTypeAtLocation(source))
                        )
                            keyed.push({
                                type: checker.getTypeAtLocation(node),
                            });
                    } else if (member.kind === "proto") unbounded = true;
                    else if (member.key === undefined)
                        keyedBy(
                            node,
                            (member.node.name as ts.ComputedPropertyName)
                                .expression,
                        );
                    else if (
                        member.kind === "property" ||
                        member.kind === "shorthand"
                    )
                        store(member.key, member.value);
                    else opened.add(member.key);
                }
                continue;
            }
            if (ts.isClassLike(node)) {
                for (const member of node.members) {
                    if (!member.name || ts.isPrivateIdentifier(member.name))
                        continue;
                    if (!ts.isComputedPropertyName(member.name))
                        opened.add(member.name.text);
                    else {
                        const names = keyNames(checker, member.name.expression);
                        if (names) for (const name of names) opened.add(name);
                        else unbounded = true;
                    }
                    if (ts.isConstructorDeclaration(member))
                        for (const parameter of member.parameters)
                            if (
                                ts.isIdentifier(parameter.name) &&
                                ts.isParameterPropertyDeclaration(
                                    parameter,
                                    member,
                                )
                            )
                                opened.add(parameter.name.text);
                }
                continue;
            }
            if (isTypeAssertion(node) && !ts.isConstTypeReference(node.type)) {
                const asserted = checker.getTypeAtLocation(node);
                const operand = checker.getTypeAtLocation(node.expression);
                if (
                    openType(checker, operand) ||
                    !checker.isTypeAssignableTo(operand, asserted)
                )
                    viewed.push(asserted);
                // The object asserted is the innermost operand's, as built.
                const built = checker.getTypeAtLocation(
                    unwrapExpression(node.expression),
                );
                if (keyedView(checker, asserted) && !keyedView(checker, built))
                    escaped.push(built);
                continue;
            }
            // A type guard views what it tests as the type it names.
            if (
                ts.isFunctionLike(node) &&
                node.type &&
                ts.isTypePredicateNode(node.type) &&
                node.type.type
            )
                viewed.push(checker.getTypeFromTypeNode(node.type.type));
            if (ts.isCallExpression(node)) {
                const reflective = reflectiveStore(checker, node);
                if (reflective === "prototype") unbounded = true;
                else if (reflective)
                    keyed.push({
                        type: checker.getTypeAtLocation(reflective.target),
                        ...(reflective.names
                            ? { names: reflective.names }
                            : {}),
                    });
                continue;
            }
            for (const site of writeSites(node)) {
                const target = site.target;
                if (
                    !ts.isPropertyAccessExpression(target) &&
                    !ts.isElementAccessExpression(target)
                )
                    continue;
                const key = accessKey(target);
                if (key === undefined) {
                    if (ts.isElementAccessExpression(target))
                        keyedBy(target.expression, target.argumentExpression);
                } else if (site.kind === "delete") continue;
                else if (
                    (site.kind === "assign" || site.kind === "logical") &&
                    site.stored
                )
                    store(key, site.stored);
                else opened.add(key);
            }
        }
    }
    return { stores, opened, keyed, viewed, escaped, unbounded };
}

/**
 * A type whose values the program may not have built, holding any member:
 * `any`, `unknown` or a string index signature (a parsed document, an
 * object built from entries).
 */
function openType(checker: ts.TypeChecker, type: ts.Type): boolean {
    return (
        untyped(type) ||
        unionMembers(type).some((member) => stringIndexed(checker, member))
    );
}

/** Whether a type has a string index signature. */
function stringIndexed(checker: ts.TypeChecker, type: ts.Type): boolean {
    return checker
        .getIndexInfosOfType(type)
        .some((info) => (info.keyType.flags & ts.TypeFlags.String) !== 0);
}

/** A type a run-time key can write members through: `any` or a string index signature. */
function keyedView(checker: ts.TypeChecker, type: ts.Type): boolean {
    return unionMembers(type).some(
        (member) =>
            (member.flags & ts.TypeFlags.Any) !== 0 ||
            stringIndexed(checker, member),
    );
}

/** Whether a value is an argument of a call to a library-declared function. */
function libraryArgument(
    checker: ts.TypeChecker,
    value: ts.Expression,
): boolean {
    const call = value.parent;
    return (
        (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
        (call.arguments?.includes(value) ?? false) &&
        (calledDeclaration(checker, call)?.getSourceFile().isDeclarationFile ??
            false)
    );
}

/** `any` or `unknown`, or a union holding one. */
function untyped(type: ts.Type): boolean {
    return unionMembers(type).some(
        (member) =>
            (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0,
    );
}

/**
 * The member names a run-time key can be: its literal, the strings of a
 * literal union, none for a number or symbol, or undefined for any.
 */
function keyNames(
    checker: ts.TypeChecker,
    key: ts.Expression,
): ReadonlySet<string> | undefined {
    const literal = literalKey(key);
    if (literal !== undefined) return new Set([literal]);
    const type = checker.getTypeAtLocation(key);
    return (
        stringLiteralValues(type) ??
        (holdsOnly(type, ["number", "bigint", "symbol"])
            ? new Set()
            : undefined)
    );
}

/**
 * A library call that defines an object's members, whose values no store
 * spells: the object and the names it can define (`Object.defineProperty`,
 * `Reflect.set`, `Object.defineProperties`, `Object.assign` from an untyped
 * or index-signature source), or one setting a prototype.
 */
function reflectiveStore(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
):
    | { readonly target: ts.Expression; readonly names?: ReadonlySet<string> }
    | "prototype"
    | undefined {
    const callee = libraryStaticMember(
        checker,
        unwrapExpression(call.expression),
    );
    if (callee?.owner !== "Object" && callee?.owner !== "Reflect")
        return undefined;
    const [target, key] = call.arguments;
    if (!target || ts.isSpreadElement(target)) return undefined;
    switch (callee.name) {
        case "defineProperty":
        case "set": {
            const names = key && keyNames(checker, key);
            return names?.size === 0
                ? undefined
                : { target, ...(names ? { names } : {}) };
        }
        case "defineProperties": {
            const names = key && descriptorKeys(key);
            return { target, ...(names ? { names } : {}) };
        }
        case "setPrototypeOf":
            return "prototype";
        case "assign":
            return call.arguments
                .slice(1)
                .some(
                    (source) =>
                        ts.isSpreadElement(source) ||
                        openType(checker, checker.getTypeAtLocation(source)),
                )
                ? { target }
                : undefined;
        default:
            return undefined;
    }
}

/**
 * The keys of the descriptors object an expression builds: a literal's,
 * through selections and spreads of such literals; undefined where a key
 * is known only at run time.
 */
function descriptorKeys(
    expression: ts.Expression,
    keys = new Set<string>(),
): ReadonlySet<string> | undefined {
    for (const { operand } of yieldedOperands(expression)) {
        if (!ts.isObjectLiteralExpression(operand)) return undefined;
        for (const member of objectLiteralMembers(operand)) {
            if (member.kind === "spread") {
                if (!descriptorKeys(member.node.expression, keys))
                    return undefined;
            } else if (member.kind === "proto" || member.key === undefined)
                return undefined;
            else keys.add(member.key);
        }
    }
    return keys;
}

/** @unjournaled Pure functions of the checked program, kept across replays. */
const libraryNames = new WeakMap<ts.Program, ReadonlySet<string>>();

/** Every member name a library declares: its objects may carry those members. */
function libraryMemberNames(program: ts.Program): ReadonlySet<string> {
    let names = libraryNames.get(program);
    if (!names) {
        const found = new Set<string>();
        const visit = (node: ts.Node): void => {
            if (
                (ts.isPropertySignature(node) ||
                    ts.isPropertyDeclaration(node) ||
                    ts.isMethodSignature(node) ||
                    ts.isMethodDeclaration(node) ||
                    ts.isGetAccessorDeclaration(node) ||
                    ts.isSetAccessorDeclaration(node)) &&
                !ts.isComputedPropertyName(node.name) &&
                !ts.isPrivateIdentifier(node.name)
            )
                found.add(node.name.text);
            ts.forEachChild(node, visit);
        };
        for (const file of program.getSourceFiles())
            if (file.isDeclarationFile) visit(file);
        libraryNames.set(program, (names = found));
    }
    return names;
}
