import ts from "typescript";
import { bindingReferences } from "./binding-references.js";
import { bindingRebinds } from "./binding-rebinds.js";
import {
    directArgumentBinding,
    everyForwardedArgumentUse,
} from "./parameter-effects.js";
import { onlyDirectCalls } from "./written-holders.js";
import {
    calledOrigin,
    declaredSymbol,
    libraryGlobal,
    namedMember,
    resolvedSymbol,
} from "./symbols.js";
import {
    branchPath,
    functionKind,
    hasExportModifier,
    isModuleConstDeclaration,
    isSupportedFunction,
    outermostWrapper,
    ownParameters,
    unwrapExpression,
    variableKind,
} from "./syntax.js";
import type { LoweringServices } from "./lowering-services.js";
import { programObservations } from "./program-observations.js";
import { isShaderMaterialType } from "./shader-derivations.js";
import { knownCondition } from "./values/model.js";
import { unlessRefused } from "./compile-error.js";
import { EmissionMap } from "./emission-transaction.js";
import { forEachReturn } from "./loop-control.js";

/** One immutable entry, its absence, or the proof that generation lacks. */
export type ShaderSideTableFact =
    | { readonly value: unknown }
    | { readonly absent: true }
    | { readonly refusal: string };

interface Store {
    readonly set: ts.CallExpression;
    readonly creation: ts.CallExpression;
    /** The registration's tests between its creation and its store. */
    readonly conditions: readonly {
        readonly test: ts.Expression;
        readonly holds: boolean;
    }[];
}

export interface ShaderSideTable {
    readonly map: ts.Symbol;
    readonly stores: readonly Store[];
    readonly refusal?: string;
}

type Context = Pick<LoweringServices, "program" | "checker" | "symbols">;

/** What evaluates a store's registration tests where generation reaches them. */
type ConditionContext = Pick<LoweringServices, "conditions" | "probeEmission">;

/** @unjournaled A proof over the checked program, independent of lowering. */
const tables = new WeakMap<ts.Symbol, ShaderSideTable>();

/** @unjournaled A proof over the checked program, independent of lowering. */
const creationStores = new WeakMap<
    ts.Program,
    ReadonlyMap<
        ts.CallExpression,
        readonly { readonly table: ShaderSideTable; readonly store: Store }[]
    >
>();

/** The calls of a map binding, when no reference aliases it or extracts a method. */
export function directMapCalls(
    context: Context,
    map: ts.Symbol,
): readonly ts.CallExpression[] | undefined {
    const calls: ts.CallExpression[] = [];
    for (const reference of bindingReferences(
        context.program,
        context.checker,
        map,
    )) {
        const access = outermostWrapper(reference).parent;
        const call = access.parent;
        if (
            !ts.isPropertyAccessExpression(access) ||
            access.expression !== outermostWrapper(reference) ||
            !ts.isCallExpression(call) ||
            call.expression !== access ||
            calledOrigin(context.checker, call) !== "default-lib"
        )
            return undefined;
        calls.push(call);
    }
    return calls;
}

/** The enclosing source function, without crossing a nested function. */
function enclosingFunction(
    node: ts.Node,
): ts.FunctionLikeDeclaration | undefined {
    const found = ts.findAncestor(node.parent, ts.isFunctionLike);
    return found && isSupportedFunction(found) ? found : undefined;
}

/** The stores of a private empty map with no aliases or mutators other than set. */
function privateSideTableSets(
    context: Context,
    map: ts.Symbol,
): readonly ts.CallExpression[] | string {
    const declaration = map.valueDeclaration;
    if (!isModuleConstDeclaration(declaration))
        return "the map is not a module-private const";
    const file = declaration.getSourceFile();
    const module = declaredSymbol(context.checker, file);
    if (
        hasExportModifier(declaration.parent.parent) ||
        (module &&
            context.checker
                .getExportsOfModule(module)
                .some(
                    (symbol) =>
                        symbol === map ||
                        symbol.declarations?.some(
                            (decl) =>
                                ts.isExportSpecifier(decl) &&
                                resolvedSymbol(context.checker, decl.name) ===
                                    map,
                        ),
                ))
    )
        return "the map escapes its module through an export";
    const initial = unwrapExpression(declaration.initializer);
    if (
        !ts.isNewExpression(initial) ||
        !["Map", "WeakMap"].includes(
            libraryGlobal(context.checker, initial.expression) ?? "",
        ) ||
        (initial.arguments?.length ?? 0) !== 0
    )
        return "the map is not an empty default-library Map or WeakMap";
    const sets: ts.CallExpression[] = [];
    const calls = directMapCalls(context, map);
    if (!calls)
        return "the map escapes: every reference must be a direct get, has or set call";
    for (const call of calls) {
        const method = namedMember(context.checker, call.expression)!.name;
        if (!["get", "has", "set"].includes(method))
            return `the map calls '${method}'; entries must never be deleted, cleared or overwritten`;
        if (method === "set") {
            if (!ts.isExpressionStatement(outermostWrapper(call).parent))
                return "the map escapes through the result of set";
            sets.push(call);
        }
    }
    return sets;
}

/**
 * Each store's key traces through direct, unrebound parameters to a local
 * createShaderMaterial result. One registration per creation, outside
 * loops, precedes the material's escape.
 */
export function shaderSideTable(
    context: Context,
    receiver: ts.Expression,
): ShaderSideTable | undefined {
    const name = unwrapExpression(receiver);
    const map = ts.isIdentifier(name)
        ? resolvedSymbol(context.checker, name)
        : undefined;
    if (!map) return undefined;
    const known = tables.get(map);
    if (known) return known;
    const stores: Store[] = [];
    const refuse = (refusal: string): ShaderSideTable => {
        const result = { map, stores, refusal };
        tables.set(map, result);
        return result;
    };
    const sets = privateSideTableSets(context, map);
    if (typeof sets === "string") return refuse(sets);
    const registrations = new Set<ts.CallExpression>();
    const trace = (
        key: ts.Expression,
        site: ts.CallExpression,
        set: ts.CallExpression,
        conditions: Store["conditions"],
        visiting: ReadonlySet<ts.Node>,
    ): string | undefined => {
        const root = unwrapExpression(key);
        const symbol = ts.isIdentifier(root)
            ? resolvedSymbol(context.checker, root)
            : undefined;
        const held = symbol?.valueDeclaration;
        if (
            !symbol ||
            !held ||
            visiting.has(held) ||
            bindingRebinds(
                context.checker,
                context.program.getSourceFiles(),
                symbol,
            ).length > 0
        )
            return "a set is outside the creation site: its key is not an unrebound local material creation";
        const fn = enclosingFunction(site);
        if (!fn || enclosingFunction(held) !== fn)
            return "a set is outside the function that creates its material";
        const next = new Set([...visiting, held]);
        const use = outermostWrapper(site);
        const path = branchPath(
            ts.isExpressionStatement(use.parent) ? use.parent : use,
            (node) => node.parent === fn,
        );
        if ("blocked" in path)
            return ts.isIterationStatement(path.blocked, false)
                ? "a set may run more than once for a material (registration is in a loop)"
                : ts.isIfStatement(path.blocked)
                  ? "registration runs inside a condition rather than its branch"
                  : "registration is not a straight-line statement or an if branch";
        const tests = [
            ...conditions,
            ...path.flatMap(({ statement, holds }) =>
                ts.findAncestor(held, (ancestor) => ancestor === statement)
                    ? []
                    : [{ test: statement.expression, holds }],
            ),
        ];
        if (ts.isParameter(held)) {
            if (functionKind(fn) !== "plain")
                return "a registration helper must run synchronously";
            let earlyReturn = false;
            if (fn.body && ts.isBlock(fn.body))
                forEachReturn([fn.body], (returned) => {
                    if (returned.pos < site.pos) earlyReturn = true;
                });
            if (earlyReturn)
                return "a registration helper can return before its set";
            const calls = onlyDirectCalls(context.program, context.checker, fn);
            if (!calls)
                return "a set's registration helper escapes; its callers are not all direct";
            const index = ownParameters(fn).indexOf(held);
            for (const call of calls) {
                const input = directArgumentBinding(
                    context.checker,
                    call,
                    index,
                );
                if (input?.binding !== held.name)
                    return "a set's material argument is not a fixed positional argument";
                const reason = trace(input.argument, call, set, tests, next);
                if (reason) return reason;
            }
            return undefined;
        }
        const creation =
            ts.isVariableDeclaration(held) &&
            held.initializer &&
            unwrapExpression(held.initializer);
        if (
            !creation ||
            !ts.isCallExpression(creation) ||
            variableKind(held) !== "const" ||
            context.symbols.importedName(creation.expression) !==
                "createShaderMaterial" ||
            creation.end >= site.pos
        )
            return "a set is outside the creation site: its key must name a local const createShaderMaterial result";
        if (registrations.has(creation))
            return "a material creation has a second set; its entry may be overwritten";
        registrations.add(creation);
        for (const reference of bindingReferences(
            context.program,
            context.checker,
            symbol,
        )) {
            if (reference.pos >= site.pos) continue;
            if (
                enclosingFunction(reference) !== fn ||
                !nonEscapingRead(context, reference)
            )
                return "the material escapes before its side-table entry is set";
        }
        stores.push({ set, creation, conditions: tests });
        return undefined;
    };
    for (const set of sets) {
        if (set.arguments.length !== 2)
            return refuse("a set must have exactly a material key and a value");
        const reason = trace(set.arguments[0]!, set, set, [], new Set());
        if (reason) return refuse(reason);
    }
    const result = { map, stores };
    tables.set(map, result);
    return result;
}

/**
 * Start every potentially present entry as unproved, not absent. A false
 * creation-path condition proves absence; a reached set replaces the
 * pending fact with its value. A shared/native helper that loses creation
 * facts therefore cannot silently masquerade as a missing entry.
 */
export function creationSideTables(
    context: Context & ConditionContext,
    creation: ts.CallExpression,
): Map<ts.Symbol, ShaderSideTableFact> {
    const facts = new EmissionMap<ts.Symbol, ShaderSideTableFact>();
    for (const { table, store } of storesByCreation(context).get(creation) ??
        []) {
        const outcomes = store.conditions.map((condition) =>
            storeCondition(context, condition),
        );
        facts.set(
            table.map,
            outcomes.includes(false)
                ? { absent: true }
                : {
                      refusal:
                          "the creation's side-table set has not supplied a generation-evaluable value",
                  },
        );
    }
    return facts;
}

/**
 * The stores of the program's proved side tables keyed by ShaderMaterial,
 * by the creation each registers, each table in the order of its first
 * `set`.
 */
function storesByCreation(
    context: Context,
): ReadonlyMap<
    ts.CallExpression,
    readonly { readonly table: ShaderSideTable; readonly store: Store }[]
> {
    const known = creationStores.get(context.program);
    if (known) return known;
    const stores = new Map<
        ts.CallExpression,
        { readonly table: ShaderSideTable; readonly store: Store }[]
    >();
    const seen = new Set<ts.Symbol>();
    for (const { node, object } of programObservations(
        context.program,
    ).memberCalls.get("set") ?? []) {
        const call = node.parent;
        if (
            !object ||
            !ts.isExpression(object) ||
            !ts.isCallExpression(call) ||
            !call.arguments[0] ||
            !isShaderMaterialType(
                context.checker.getTypeAtLocation(call.arguments[0]),
            )
        )
            continue;
        const table = shaderSideTable(context, object);
        if (!table || table.refusal || seen.has(table.map)) continue;
        seen.add(table.map);
        for (const store of table.stores) {
            const held = stores.get(store.creation);
            if (held) held.push({ table, store });
            else stores.set(store.creation, [{ table, store }]);
        }
    }
    creationStores.set(context.program, stores);
    return stores;
}

/**
 * Whether a registration test holds as its store's path needs, where
 * generation knows it for this variant; undefined where the run time
 * decides it.
 */
function storeCondition(
    context: ConditionContext,
    { test, holds }: Store["conditions"][number],
): boolean | undefined {
    const known = context.probeEmission(
        () =>
            unlessRefused(() =>
                knownCondition(context.conditions.compileCondition(test)),
            ),
        () => false,
    );
    return known === undefined ? undefined : known === holds;
}

/**
 * The fact a reached store call `set` of a proved side table supplies for
 * its key's creation `creation`: the value `stored` reads after the
 * registration's tests, or why generation does not hold it.
 */
export function sideTableStoreFact(
    context: ConditionContext,
    table: ShaderSideTable,
    creation: ts.CallExpression | undefined,
    set: ts.Node,
    stored: () => {
        readonly json: unknown;
        /** What the program may write of the stored value. */
        readonly written: string | undefined;
    },
): ShaderSideTableFact {
    const store = table.stores.find(
        (store) => store.set === set && store.creation === creation,
    );
    const knownTests =
        store &&
        store.conditions.every(
            (condition) => storeCondition(context, condition) !== undefined,
        );
    const { json, written } = stored();
    return !store
        ? {
              refusal:
                  "the set does not belong to this material's creation site",
          }
        : !knownTests
          ? {
                refusal:
                    "a registration condition is decided at run time for this variant",
            }
          : written
            ? { refusal: `the program may write ${written}` }
            : json === undefined
              ? {
                    refusal:
                        "the stored value is not generation-evaluable for this variant",
                }
              : { value: json };
}

/** Read-only validation and other private side-table declarations do not expose the key. */
function nonEscapingRead(context: Context, reference: ts.Expression): boolean {
    return everyForwardedArgumentUse(context, reference, (use) => {
        const node = outermostWrapper(use);
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
            return true;
        if (!ts.isCallExpression(parent)) return false;
        const member = namedMember(context.checker, parent.expression);
        if (
            member &&
            calledOrigin(context.checker, parent) === "default-lib" &&
            parent.arguments[0] === node
        ) {
            const receiver = unwrapExpression(member.expression);
            const symbol = ts.isIdentifier(receiver)
                ? resolvedSymbol(context.checker, receiver)
                : undefined;
            return (
                !!symbol &&
                typeof privateSideTableSets(context, symbol) !== "string"
            );
        }
        return undefined;
    });
}
