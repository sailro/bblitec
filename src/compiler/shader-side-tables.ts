import ts from "typescript";
import { bindingReferences } from "./binding-references.js";
import { bindingRebinds } from "./binding-rebinds.js";
import { onlyDirectCalls } from "./written-holders.js";
import {
    calledFunction,
    calledOrigin,
    declaredSymbol,
    libraryGlobal,
    namedMember,
    resolvedSymbol,
} from "./symbols.js";
import {
    argumentForParameter,
    functionKind,
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

/** @unjournaled A proof over the checked program, independent of lowering. */
const tables = new WeakMap<ts.Symbol, ShaderSideTable>();

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
    if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        variableKind(declaration) !== "const" ||
        !ts.isVariableStatement(declaration.parent.parent) ||
        !ts.isSourceFile(declaration.parent.parent.parent)
    )
        return "the map is not a module-private const";
    const file = declaration.getSourceFile();
    const module = declaredSymbol(context.checker, file);
    if (
        (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !==
            0 ||
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
    const initial =
        declaration.initializer && unwrapExpression(declaration.initializer);
    if (
        !initial ||
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
        const tests = [...conditions];
        const use = outermostWrapper(site);
        for (let node: ts.Node = use; node !== fn; node = node.parent) {
            if (
                node === use ||
                ts.isBlock(node) ||
                ts.isExpressionStatement(node)
            )
                continue;
            if (ts.isIterationStatement(node, false))
                return "a set may run more than once for a material (registration is in a loop)";
            if (!ts.isIfStatement(node))
                return "registration is not a straight-line statement or an if branch";
            const then = ts.findAncestor(
                site,
                (ancestor) => ancestor === node.thenStatement,
            );
            const otherwise =
                node.elseStatement &&
                ts.findAncestor(
                    site,
                    (ancestor) => ancestor === node.elseStatement,
                );
            if (!then && !otherwise)
                return "registration runs inside a condition rather than its branch";
            if (!ts.findAncestor(held, (ancestor) => ancestor === node))
                tests.push({
                    test: node.expression,
                    holds: then !== undefined,
                });
        }
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
            const parameters = ownParameters(fn);
            const index = parameters.indexOf(held);
            for (const call of calls) {
                const input = argumentForParameter(call, { parameters }, index);
                if (input.kind !== "argument")
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
                !nonEscapingRead(context, reference, new Set())
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
    context: Context & Pick<LoweringServices, "conditions" | "probeEmission">,
    creation: ts.CallExpression,
): Map<ts.Symbol, ShaderSideTableFact> {
    const facts = new EmissionMap<ts.Symbol, ShaderSideTableFact>();
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
        if (!table || table.refusal || facts.has(table.map)) continue;
        const store = table.stores.find((store) => store.creation === creation);
        if (!store) continue;
        const outcomes = store.conditions.map(({ test, holds }) => {
            const known = context.probeEmission(
                () =>
                    unlessRefused(() =>
                        knownCondition(
                            context.conditions.compileCondition(test),
                        ),
                    ),
                () => false,
            );
            return known === undefined ? undefined : known === holds;
        });
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

/** Read-only validation and other private side-table declarations do not expose the key. */
function nonEscapingRead(
    context: Context,
    reference: ts.Expression,
    visiting: ReadonlySet<ts.Node>,
): boolean {
    const node = outermostWrapper(reference);
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
    const fn = calledFunction(context.checker, parent);
    if (
        !fn ||
        visiting.has(fn) ||
        !onlyDirectCalls(context.program, context.checker, fn)
    )
        return false;
    const parameter = ownParameters(fn)[parent.arguments.indexOf(node)];
    const symbol =
        parameter && ts.isIdentifier(parameter.name)
            ? declaredSymbol(context.checker, parameter.name)
            : undefined;
    return (
        !!symbol &&
        bindingReferences(context.program, context.checker, symbol).every(
            (use) => nonEscapingRead(context, use, new Set([...visiting, fn])),
        )
    );
}
