import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import { programObservations } from "./program-observations.js";
import { holdsRecord } from "./record-observations.js";
import { forEachReturn } from "./loop-control.js";
import {
    calledDeclaration,
    calledFunction,
    nullishLiteral,
    resolvedSymbol,
} from "./symbols.js";
import {
    isDestructuringPattern,
    isModuleConstDeclaration,
    literalKey,
    objectLiteralMembers,
    objectProperty,
    unwrapExpression,
    variableKind,
    yieldedOperands,
} from "./syntax.js";
import {
    finiteScalarValues,
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
 * The module constants and constant rows a value can be, where the program
 * picks it at run time: through a selection (`?:`, `??`, `||`, `&&`), by
 * reading a member no store sets to anything else (`entry.lane ??
 * DEFAULT_LANE`), through a module function's `return`s, a module constant
 * table read by a key of a few literals (`PROFILES[name]`), or a literal
 * spreading such a row and giving members values of a few outcomes. One row
 * names each, at most `limit`. Undefined when the value can be another
 * object, or nothing picks it at run time.
 */
export function selectedModuleConstants(
    context: HeldConstantsContext,
    expression: ts.Expression,
    limit: number,
): readonly HeldRow[] | undefined {
    const held = new HeldConstants(context, limit).held(expression, true);
    return held?.selected && held.constants.length > 0
        ? held.constants
        : undefined;
}

/**
 * One object a value can be: the module constant or constant table row
 * `base` spells, with `overrides` replacing members a spread's literal
 * gives one of a few values (`{ ...row, clusterLights }`).
 */
export interface HeldRow {
    readonly base: ts.Expression;
    readonly overrides: ReadonlyMap<string, boolean | string>;
}

/** What a value can be: one of `constants`, or absent. */
interface Held {
    readonly constants: readonly HeldRow[];
    readonly absent: boolean;
    /** Whether a run-time test or member read picks among them. */
    readonly selected: boolean;
}

const ABSENT: Held = { constants: [], absent: true, selected: false };
const NO_OVERRIDES: ReadonlyMap<string, boolean | string> = new Map();

/** One constant, held as it is. */
function oneRow(base: ts.Expression): Held {
    return {
        constants: [{ base, overrides: NO_OVERRIDES }],
        absent: false,
        selected: false,
    };
}

class HeldConstants {
    /** @unjournaled The nodes being read, for one query. */
    private readonly active = new Set<ts.Node>();

    /** `limit` bounds the rows a value may be. */
    constructor(
        private readonly context: HeldConstantsContext,
        private readonly limit: number,
    ) {}

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
            if (isModuleConstDeclaration(declaration)) return oneRow(node);
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
        if (ts.isElementAccessExpression(node)) return this.tableRow(node);
        if (ts.isCallExpression(node)) return this.returned(node);
        if (ts.isObjectLiteralExpression(node))
            return this.literal(node, local);
        return undefined;
    }

    /**
     * `TABLE[key]` of a module constant's object literal, by a key of a few
     * literal values: the row each names.
     */
    private tableRow(access: ts.ElementAccessExpression): Held | undefined {
        const { checker } = this.context;
        const table = unwrapExpression(access.expression);
        const declaration = ts.isIdentifier(table)
            ? resolvedSymbol(checker, table)?.valueDeclaration
            : undefined;
        const literal =
            isModuleConstDeclaration(declaration) &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer
                ? unwrapExpression(declaration.initializer)
                : undefined;
        if (!literal || !ts.isObjectLiteralExpression(literal))
            return undefined;
        const key = literalKey(access.argumentExpression);
        const keys =
            key !== undefined
                ? [key]
                : [
                      ...(stringLiteralValues(
                          checker.getTypeAtLocation(access.argumentExpression),
                      ) ?? []),
                  ];
        if (keys.length === 0) return undefined;
        const held: Held[] = [];
        for (const name of keys) {
            const value = objectProperty(literal, name);
            const one = value && this.held(value, false);
            if (!one) return undefined;
            held.push(one);
        }
        return this.picked(held, false, keys.length > 1);
    }

    /** A module function's call: one of the values its `return`s give. */
    private returned(call: ts.CallExpression): Held | undefined {
        const callee = calledFunction(this.context.checker, call);
        const body = callee?.body;
        if (!body) return undefined;
        if (!ts.isBlock(body)) {
            const one = this.held(body, false);
            return one && this.picked([one], one.absent, false);
        }
        const held: Held[] = [];
        let absent = false;
        let known = true;
        forEachReturn([body], (statement) => {
            if (!statement.expression) absent = true;
            else {
                const one = known
                    ? this.held(statement.expression, false)
                    : undefined;
                if (one) held.push(one);
                else known = false;
            }
        });
        return known && (held.length > 0 || absent)
            ? this.picked(held, absent || held.some((one) => one.absent), false)
            : undefined;
    }

    /**
     * An object literal: a row of its own, or a spread row whose members the
     * literal then gives values of a few outcomes, one row per combination.
     */
    private literal(
        literal: ts.ObjectLiteralExpression,
        local: boolean,
    ): Held | undefined {
        const [first, ...rest] = objectLiteralMembers(literal);
        if (first?.kind !== "spread")
            return rest.some((member) => member.kind === "spread")
                ? undefined
                : oneRow(literal);
        const spread = this.held(first.node.expression, local);
        if (!spread || spread.absent) return undefined;
        let rows = spread.constants;
        let selected = spread.selected;
        for (const member of rest) {
            const name =
                member.kind === "property" || member.kind === "shorthand"
                    ? member.key
                    : undefined;
            const values =
                name !== undefined && "value" in member && member.value
                    ? this.outcomes(member.value)
                    : undefined;
            if (name === undefined || !values) return undefined;
            rows = rows.flatMap((row) =>
                values.map((value) => ({
                    base: row.base,
                    overrides: new Map([...row.overrides, [name, value]]),
                })),
            );
            if (rows.length > this.limit) return undefined;
            selected ||= values.length > 1;
        }
        return { constants: rows, absent: false, selected };
    }

    /** The values of a few a member's expression can be: its literal, or its type's booleans or strings. */
    private outcomes(
        expression: ts.Expression,
    ): readonly (boolean | string)[] | undefined {
        const node = unwrapExpression(expression);
        if (node.kind === ts.SyntaxKind.TrueKeyword) return [true];
        if (node.kind === ts.SyntaxKind.FalseKeyword) return [false];
        if (ts.isStringLiteralLike(node)) return [node.text];
        return finiteScalarValues(this.context.checker.getTypeAtLocation(node));
    }

    /** {@link union} of `held`, picked at run time only where more than one row or a part picks. */
    private picked(
        held: readonly Held[],
        absent: boolean,
        picks: boolean,
    ): Held | undefined {
        const union = this.union(held, absent);
        if (union.constants.length > this.limit) return undefined;
        return {
            ...union,
            selected:
                picks ||
                union.constants.length > 1 ||
                held.some((one) => one.selected),
        };
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
        const constants: HeldRow[] = [];
        const seen = new Map<ts.Node, Set<string>>();
        for (const one of held)
            for (const row of one.constants) {
                const declaration =
                    (ts.isIdentifier(row.base)
                        ? resolvedSymbol(this.context.checker, row.base)
                              ?.valueDeclaration
                        : undefined) ?? row.base;
                const overrides = JSON.stringify([...row.overrides]);
                let rows = seen.get(declaration);
                if (!rows) seen.set(declaration, (rows = new Set()));
                if (rows.has(overrides)) continue;
                rows.add(overrides);
                constants.push(row);
            }
        return { constants, absent, selected: true };
    }
}

/**
 * Where the program's objects get their members, from its observed
 * definitions (`ProgramObservations`):
 *
 * - stores: the value each object literal's property or shorthand, and
 *   each assignment (`=`, `??=`, `||=`, `&&=`), gives a member of a known
 *   name; a copy (a spread, `Object.assign`) moves values stores gave;
 * - opened: the names some other site gives a value no store spells: a
 *   method, accessor or class member of that name, a constructor's
 *   parameter property, another update of it (compound, increment, a
 *   pattern or loop target);
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
 * - unbounded: a site that may give an object any member: one giving it a
 *   foreign prototype (`foreignPrototype`), whose members read through it,
 *   or a class member under a run-time string key.
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

/** @unjournaled Pure functions of the checked program: `memberStores` by holder type and name. */
const holderStores = new WeakMap<
    ts.Type,
    Map<string, readonly ts.Expression[] | null>
>();

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
    let byName = holderStores.get(holder);
    if (!byName)
        holderStores.set(
            holder,
            (byName = new Map<string, readonly ts.Expression[] | null>()),
        );
    let known = byName.get(name);
    if (known === undefined) {
        known = holderMemberStores(program, checker, name, holder) ?? null;
        byName.set(name, known);
    }
    return known ?? undefined;
}

function holderMemberStores(
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
        holdsRecord(checker, type, [holder]);
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
    const keyedAt = (
        target: ts.Node,
        names: ReadonlySet<string> | undefined,
    ): void => {
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
    for (const [name, definitions] of observations.definitions)
        for (const definition of definitions) {
            if (definition.via === "reflect")
                keyedAt(definition.node.arguments[0]!, new Set([name]));
            else if (definition.via !== "class" && definition.stored)
                store(name, definition.stored);
            else if (definition.via !== "write" || definition.kind !== "delete")
                opened.add(name);
        }
    for (const definition of observations.keyedDefinitions)
        switch (definition.via) {
            case "literal":
                keyedAt(
                    definition.node.parent,
                    definition.key && keyNames(checker, definition.key),
                );
                break;
            case "write":
                keyedAt(
                    definition.node.expression,
                    definition.key && keyNames(checker, definition.key),
                );
                break;
            case "class": {
                const names =
                    definition.key && keyNames(checker, definition.key);
                if (names) for (const name of names) opened.add(name);
                else unbounded = true;
                break;
            }
            case "reflect": {
                const [target, key, ...sources] = definition.node.arguments;
                if (
                    definition.method === "defineProperty" ||
                    definition.method === "set"
                )
                    keyedAt(target!, key && keyNames(checker, key));
                else if (
                    definition.method === "defineProperties" ||
                    [key, ...sources].some(
                        (source) =>
                            source !== undefined &&
                            (ts.isSpreadElement(source) ||
                                openType(
                                    checker,
                                    checker.getTypeAtLocation(source),
                                )),
                    )
                )
                    keyedAt(target!, undefined);
                break;
            }
        }
    for (const { from, into } of observations.copies)
        if (
            ts.isObjectLiteralExpression(into) &&
            !isDestructuringPattern(into) &&
            openType(checker, checker.getTypeAtLocation(from))
        )
            keyedAt(into, undefined);
    for (const assertion of observations.typeAssertions) {
        if (ts.isConstTypeReference(assertion.type)) continue;
        const asserted = checker.getTypeAtLocation(assertion);
        const operand = checker.getTypeAtLocation(assertion.expression);
        if (
            openType(checker, operand) ||
            !checker.isTypeAssignableTo(operand, asserted)
        )
            viewed.push(asserted);
        // The object asserted is the innermost operand's, as built.
        const built = checker.getTypeAtLocation(
            unwrapExpression(assertion.expression),
        );
        if (keyedView(checker, asserted) && !keyedView(checker, built))
            escaped.push(built);
    }
    // A type guard views what it tests as the type it names.
    for (const guarded of observations.guardedTypes)
        viewed.push(checker.getTypeFromTypeNode(guarded));
    return { stores, opened, keyed, viewed, escaped, unbounded };
}

/**
 * Whether some member of a type has one of `flags` or a string index
 * signature.
 */
function indexedOr(
    checker: ts.TypeChecker,
    type: ts.Type,
    flags: ts.TypeFlags,
): boolean {
    return unionMembers(type).some(
        (member) =>
            (member.flags & flags) !== 0 ||
            checker
                .getIndexInfosOfType(member)
                .some(
                    (info) => (info.keyType.flags & ts.TypeFlags.String) !== 0,
                ),
    );
}

/**
 * A type whose values the program may not have built, holding any member:
 * `any`, `unknown` or a string index signature (a parsed document, an
 * object built from entries).
 */
function openType(checker: ts.TypeChecker, type: ts.Type): boolean {
    return indexedOr(checker, type, ts.TypeFlags.Any | ts.TypeFlags.Unknown);
}

/** A type a run-time key can write members through: `any` or a string index signature. */
function keyedView(checker: ts.TypeChecker, type: ts.Type): boolean {
    return indexedOr(checker, type, ts.TypeFlags.Any);
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
