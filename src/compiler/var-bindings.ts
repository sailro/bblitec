// `var`: one binding per function, class static block or module for each
// name, undefined until assigned. A `var` that a block-scoped binding at its
// declaration would serve exactly lowers as one, in place. Any other is
// hoisted: its storage is declared where its scope's body starts, and each
// declaration assigns it where it sits (`var x = e` is `x = e`, `var x;`
// nothing; a pattern or a for-in/of head assigns each name it binds).
import ts from "typescript";
import { sourceFileNodes } from "./analysis-walk.js";
import { definitelyAssignedAt } from "./definite-assignment.js";
import type { LoweringServices } from "./lowering-services.js";
import { valueSymbolOf } from "./symbols.js";
import {
    bindingNameIdentifiers,
    declarationNamed,
    evaluationContainer,
    isDeclaredInside,
    isEvaluationContainer,
    isValueReference,
    variableKind,
    writeSiteOf,
    type EvaluationContainer,
    type WriteSite,
} from "./syntax.js";
import { nullability } from "./type-facts.js";
import type { Value } from "./types.js";

/** What owns a `var`'s one binding: the frame it lives in. */
type VarScope = EvaluationContainer;

/** A `var` declaration: a declaration list's member or a pattern leaf of one. */
type VarDeclaration = ts.VariableDeclaration | ts.BindingElement;

/**
 * How a `var` lowers: in place, hoisted, or refused because it shares its
 * binding with another kind of declaration (a parameter, a function).
 */
type VarPlacement = "in-place" | "hoisted" | "shared";

const isVarScope = isEvaluationContainer;

/** The scope whose binding a `var` declared at `node` would be. */
const varScopeOf = evaluationContainer;

function isAmbient(node: ts.Declaration): boolean {
    return (
        node.getSourceFile().isDeclarationFile ||
        (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0
    );
}

/** The `var` declaration whose own name `identifier` is. */
function varDeclarationNamed(
    identifier: ts.Identifier,
): VarDeclaration | undefined {
    const declaration = declarationNamed(identifier);
    return declaration &&
        (ts.isVariableDeclaration(declaration) ||
            ts.isBindingElement(declaration)) &&
        variableKind(declaration) === "var" &&
        !isAmbient(declaration)
        ? declaration
        : undefined;
}

/** A scope's `var` names by symbol, with how each lowers, and its hoisted ones. */
interface ScopeVars {
    readonly placements: ReadonlyMap<ts.Symbol, VarPlacement>;
    readonly hoisted: readonly ts.Symbol[];
}

const noVars: ScopeVars = { placements: new Map(), hoisted: [] };

/** Each file's `var` scopes, decided once per checker. */
const fileVars = new WeakMap<
    ts.TypeChecker,
    WeakMap<ts.SourceFile, ReadonlyMap<VarScope, ScopeVars>>
>();

function scopeVars(checker: ts.TypeChecker, scope: VarScope): ScopeVars {
    const file = scope.getSourceFile();
    let files = fileVars.get(checker);
    if (!files) fileVars.set(checker, (files = new WeakMap()));
    let scopes = files.get(file);
    if (!scopes) files.set(file, (scopes = varScopes(checker, file)));
    return scopes.get(scope) ?? noVars;
}

function scopePlacements(
    checker: ts.TypeChecker,
    scope: VarScope,
): ReadonlyMap<ts.Symbol, VarPlacement> {
    return scopeVars(checker, scope).placements;
}

/**
 * One walk of a file: each `var` declaration under its scope, and the
 * references to a name some `var` declares, resolved only then.
 */
function varScopes(
    checker: ts.TypeChecker,
    file: ts.SourceFile,
): ReadonlyMap<VarScope, ScopeVars> {
    const declared = new Map<ts.Symbol, VarDeclaration[]>();
    const scopeOf = new Map<ts.Symbol, VarScope>();
    const names = new Set<string>();
    const candidates: ts.Identifier[] = [];
    for (const node of sourceFileNodes(file)) {
        if (!ts.isIdentifier(node)) continue;
        const declaration = varDeclarationNamed(node);
        if (!declaration) {
            candidates.push(node);
            continue;
        }
        const symbol = valueSymbolOf(checker, node);
        if (!symbol) continue;
        const list = declared.get(symbol);
        if (list) list.push(declaration);
        else {
            declared.set(symbol, [declaration]);
            scopeOf.set(symbol, varScopeOf(declaration));
            names.add(node.text);
        }
    }
    const references = new Map<ts.Symbol, ts.Identifier[]>();
    for (const candidate of candidates) {
        if (!names.has(candidate.text) || !isValueReference(candidate))
            continue;
        const symbol = valueSymbolOf(checker, candidate);
        if (!symbol || !declared.has(symbol)) continue;
        const list = references.get(symbol);
        if (list) list.push(candidate);
        else references.set(symbol, [candidate]);
    }
    const scopes = new Map<
        VarScope,
        { placements: Map<ts.Symbol, VarPlacement>; hoisted: ts.Symbol[] }
    >();
    for (const [symbol, declarations] of declared) {
        const scope = scopeOf.get(symbol)!;
        let vars = scopes.get(scope);
        if (!vars)
            scopes.set(scope, (vars = { placements: new Map(), hoisted: [] }));
        const others = (symbol.declarations ?? []).filter(
            (declaration) => !isAmbient(declaration),
        );
        const placement: VarPlacement =
            others.length !== declarations.length
                ? "shared"
                : declarations.length === 1 &&
                    servedInPlace(
                        scope,
                        declarations[0]!,
                        references.get(symbol) ?? [],
                    )
                  ? "in-place"
                  : "hoisted";
        vars.placements.set(symbol, placement);
        if (placement === "hoisted") vars.hoisted.push(symbol);
    }
    return scopes;
}

/**
 * Whether a `var`'s only declaration binds it as a block-scoped binding
 * there would: every reference lies in the block (or loop) it is declared
 * in, after the declaration -- a function's references where the function
 * is created, a function declaration's where it is called; one a loop runs
 * again assigns it each time, and no function captures it.
 */
function servedInPlace(
    scope: VarScope,
    declaration: VarDeclaration,
    references: readonly ts.Identifier[],
): boolean {
    const root = ts.findAncestor(declaration, ts.isVariableDeclaration);
    if (!root) return false;
    const statement = root.parent.parent;
    const eachIteration =
        ts.isForInStatement(statement) || ts.isForOfStatement(statement);
    // A statement's block holds what follows it; a lone statement (a case
    // clause's, an unbraced branch's) holds nothing after it.
    const container =
        ts.isVariableStatement(statement) &&
        (ts.isBlock(statement.parent) ||
            ts.isSourceFile(statement.parent) ||
            ts.isModuleBlock(statement.parent))
            ? statement.parent
            : statement;
    const repeated =
        eachIteration ||
        ts.findAncestor(statement.parent, (node) =>
            node === scope ? "quit" : ts.isIterationStatement(node, false),
        ) !== undefined;
    if (repeated && !eachIteration && !root.initializer) return false;
    return references.every((reference) => {
        if (!isDeclaredInside(reference, container)) return false;
        // The function directly in this scope the reference is read in.
        const nested = ts.findAncestor(reference, (node) =>
            node === scope
                ? "quit"
                : isVarScope(node) && varScopeOf(node) === scope,
        );
        if (nested && repeated) return false;
        if (nested && ts.isFunctionDeclaration(nested)) return true;
        const site = nested ?? reference;
        return eachIteration
            ? isDeclaredInside(site, statement.statement)
            : site.getStart() >= root.end;
    });
}

function placementOf(
    checker: ts.TypeChecker,
    name: ts.Identifier,
): VarPlacement | undefined {
    const declaration = varDeclarationNamed(name);
    const scope = declaration && varScopeOf(declaration);
    const symbol = scope && valueSymbolOf(checker, name);
    return scope && symbol
        ? scopePlacements(checker, scope).get(symbol)
        : undefined;
}

/**
 * The writes hoisted `var` declarations make, as `x = e` and a for-in/of
 * target would: each declaration with an initializer, each loop head.
 */
export function hoistedVarWrites(
    checker: ts.TypeChecker,
    node: ts.Node,
): readonly WriteSite[] {
    if (!ts.isVariableDeclaration(node)) return [];
    const loop = node.parent.parent;
    const eachIteration =
        ts.isForInStatement(loop) || ts.isForOfStatement(loop);
    const from = eachIteration ? loop.expression : node.initializer;
    if (!from) return [];
    return bindingNameIdentifiers(node.name)
        .filter((name) => placementOf(checker, name) === "hoisted")
        .map((target): WriteSite =>
            eachIteration
                ? { target, kind: "loop", node: loop, from }
                : {
                      target,
                      kind: "assign",
                      node,
                      from,
                      ...(target === node.name ? { stored: from } : {}),
                  },
        );
}

/** What `var` lowering reads of the compiler. */
type VarBindingsContext = Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
    | "bindings"
    | "checker"
    | "compileValue"
    | "dataLowerer"
    | "declarations"
    | "fail"
    | "sharedClosures"
    | "symbols"
>;

/** Lowers hoisted `var`s: storage where the scope starts, assignments where declared. */
export class VarBindings {
    /** @unjournaled Set only while one hoisted storage is declared. */
    private declaring: ts.Symbol | undefined;

    constructor(private readonly context: VarBindingsContext) {}

    /** Whether a declaration names a hoisted `var`, which it assigns rather than binds. */
    public hoists(declaration: ts.VariableDeclaration): boolean {
        if (variableKind(declaration) !== "var") return false;
        let hoisted = false;
        for (const name of bindingNameIdentifiers(declaration.name)) {
            const placement = placementOf(this.context.checker, name);
            if (placement === "shared")
                this.context.fail(
                    name,
                    `The \`var\` '${name.text}' shares its binding with a parameter, function or global of another declaration; give it a name of its own.`,
                );
            hoisted ||= placement === "hoisted";
        }
        return hoisted;
    }

    /**
     * Before a function, static block or module body's statements, declares
     * the storage of each `var` the body hoists: undefined until assigned,
     * or unreadable until then where its type cannot hold undefined.
     */
    public declareFor(statement: ts.Statement): void {
        // A statement the compiler synthesized sits in no scope of its own.
        const body: ts.Node | undefined = statement.parent;
        if (!body) return;
        const scope =
            ts.isSourceFile(body) || ts.isModuleBlock(body)
                ? body
                : ts.isBlock(body) &&
                    (ts.isFunctionLike(body.parent) ||
                        ts.isClassStaticBlockDeclaration(body.parent))
                  ? body.parent
                  : undefined;
        if (!scope) return;
        // The body's first lowered statement declares them all at once.
        const { hoisted } = scopeVars(this.context.checker, scope);
        if (
            hoisted.length === 0 ||
            this.context.bindings.peekBinding(hoisted[0]!)
        )
            return;
        for (const symbol of hoisted)
            if (!this.context.bindings.peekBinding(symbol))
                this.declare(symbol);
    }

    private declare(symbol: ts.Symbol): void {
        const declaration = symbol.declarations?.find(
            (node): node is VarDeclaration & { name: ts.Identifier } =>
                (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) &&
                ts.isIdentifier(node.name),
        );
        const root =
            declaration &&
            ts.findAncestor(declaration, ts.isVariableDeclaration);
        if (!declaration || !root)
            throw new Error(`The hoisted var ${symbol.name} has no name.`);
        const name = declaration.name;
        this.declaring = symbol;
        try {
            this.context.declarations.declareUnassigned(
                name,
                root.name === name ? root : undefined,
                this.context.allocateTemporaryCppName(`var_${name.text}`),
                this.context.sharedClosures.needsSharedClosureStorage(
                    root,
                    name,
                ),
            );
        } finally {
            this.declaring = undefined;
        }
        if (
            this.context.bindings.peekBinding(symbol)?.value.kind ===
            "pending-let"
        )
            this.context.fail(
                name,
                `The \`var\` '${name.text}' is hoisted (read outside the block declaring it, redeclared, or assigned again by a loop) and needs storage its type gives.`,
            );
        const type = this.context.checker.getTypeAtLocation(name);
        if (
            !nullability(type).undefined &&
            (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0
        )
            this.context.bindings.markVarUnassigned(symbol);
    }

    /**
     * A hoisted `var` declaration where it sits: `var x = e` assigns `e`,
     * `var x;` nothing. False for a pattern, whose names assign as it binds
     * them ({@link assignsDeclared}).
     */
    public emitDeclaration(declaration: ts.VariableDeclaration): boolean {
        if (!declaration.initializer) return true;
        if (!ts.isIdentifier(declaration.name)) return false;
        this.assign(
            declaration.name,
            this.context.compileValue(declaration.initializer),
        );
        return true;
    }

    /**
     * Binding a hoisted `var`'s name where a pattern or loop head declares
     * it assigns the hoisted storage instead.
     */
    public assignsDeclared(identifier: ts.MemberName, value: Value): boolean {
        if (
            !ts.isIdentifier(identifier) ||
            placementOf(this.context.checker, identifier) !== "hoisted" ||
            this.declaring === this.context.symbols.valueSymbol(identifier)
        )
            return false;
        this.assign(identifier, value);
        return true;
    }

    private assign(name: ts.Identifier, value: Value): void {
        const symbol = this.context.symbols.valueSymbol(name);
        if (!symbol || !this.context.bindings.peekBinding(symbol))
            this.context.fail(
                name,
                `The hoisted \`var\` '${name.text}' has no storage: its scope's body was not lowered from its first statement.`,
            );
        this.context.dataLowerer.emitAssignmentTargetWrite(name, value);
    }

    /**
     * A read of a hoisted `var` that can still be undefined, which its type
     * does not admit, refuses: one of its own scope that some path reaches
     * unassigned ({@link definitelyAssignedAt}), and one of a nested
     * function lowered before the walk reached an assignment.
     */
    public refuseUnassignedRead(identifier: ts.MemberName): void {
        if (!ts.isIdentifier(identifier) || !isValueReference(identifier))
            return;
        const write = writeSiteOf(identifier)?.kind;
        if (write === "assign" || write === "loop") return;
        const symbol = this.context.symbols.valueSymbol(identifier);
        const declaration = symbol?.valueDeclaration;
        if (!symbol || !declaration) return;
        const scope = varScopeOf(declaration);
        const own = varScopeOf(identifier) === scope;
        const assigned =
            own &&
            definitelyAssignedAt(
                this.context.checker,
                scope,
                symbol,
                identifier,
            );
        if (assigned === true) return;
        if (typeof assigned === "object")
            this.context.fail(
                identifier,
                `The \`var\` '${identifier.text}' is read where its assignment runs through a ${ts.SyntaxKind[assigned.unsupported.kind]}, which the definite-assignment analysis does not follow. Assign it before, or declare it with \`| undefined\`.`,
            );
        this.context.fail(
            identifier,
            own
                ? `The \`var\` '${identifier.text}' can be read here before it is assigned, while it holds undefined, which its type does not admit. Assign it on every path, or declare it with \`| undefined\`.`
                : `A function reads the \`var\` '${identifier.text}' where it can still be undefined, which its type does not admit. Assign it before the function is created or called, or declare it with \`| undefined\`.`,
        );
    }
}
