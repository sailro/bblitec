// `var`: one binding per function, class static block or module for each
// name, undefined until assigned. A `var` that a block-scoped binding at its
// declaration would serve exactly lowers as one, in place. Any other is
// hoisted: its storage is declared where its scope's body starts, and each
// declaration assigns it where it sits (`var x = e` is `x = e`, `var x;`
// nothing; a pattern or a for-in/of head assigns each name it binds).
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import type { LoweringServices } from "./lowering-services.js";
import { valueSymbolOf } from "./symbols.js";
import {
    bindingNameIdentifiers,
    declarationNamed,
    hasNonNullAssertion,
    isDeclaredInside,
    isValueReference,
    outermostWrapper,
    variableKind,
    writeSiteOf,
    type WriteSite,
} from "./syntax.js";
import { nullability } from "./type-facts.js";
import type { Value } from "./types.js";

/** What owns a `var`'s one binding. */
type VarScope =
    | ts.SignatureDeclaration
    | ts.ClassStaticBlockDeclaration
    | ts.SourceFile
    | ts.ModuleBlock;

/** A `var` declaration: a declaration list's member or a pattern leaf of one. */
type VarDeclaration = ts.VariableDeclaration | ts.BindingElement;

/**
 * How a `var` lowers: in place, hoisted, or refused because it shares its
 * binding with another kind of declaration (a parameter, a function).
 */
type VarPlacement = "in-place" | "hoisted" | "shared";

function isVarScope(node: ts.Node): node is VarScope {
    return (
        ts.isFunctionLike(node) ||
        ts.isClassStaticBlockDeclaration(node) ||
        ts.isSourceFile(node) ||
        ts.isModuleBlock(node)
    );
}

/** The scope whose binding a `var` declared at `node` would be. */
function varScopeOf(node: ts.Node): VarScope | undefined {
    return ts.findAncestor(node.parent, isVarScope);
}

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

/** Each scope's `var` names by symbol, with how each lowers. */
const placements = new WeakMap<
    ts.TypeChecker,
    WeakMap<VarScope, ReadonlyMap<ts.Symbol, VarPlacement>>
>();

function scopePlacements(
    checker: ts.TypeChecker,
    scope: VarScope,
): ReadonlyMap<ts.Symbol, VarPlacement> {
    let scopes = placements.get(checker);
    if (!scopes) placements.set(checker, (scopes = new WeakMap()));
    const cached = scopes.get(scope);
    if (cached) return cached;
    const declared = new Map<ts.Symbol, VarDeclaration[]>();
    forEachAnalysisNode(
        scope,
        (node) => {
            if (node !== scope && isVarScope(node)) return "skip";
            if (!ts.isIdentifier(node)) return;
            const declaration = varDeclarationNamed(node);
            const symbol = declaration && valueSymbolOf(checker, node);
            if (!declaration || !symbol) return;
            const list = declared.get(symbol);
            if (list) list.push(declaration);
            else declared.set(symbol, [declaration]);
        },
        { types: "skip" },
    );
    const references = new Map<ts.Symbol, ts.Identifier[]>();
    if (declared.size > 0)
        forEachAnalysisNode(
            scope,
            (node) => {
                if (!ts.isIdentifier(node)) return;
                const symbol = valueSymbolOf(checker, node);
                if (!symbol || !declared.has(symbol)) return;
                const list = references.get(symbol);
                if (list) list.push(node);
                else references.set(symbol, [node]);
            },
            { types: "skip", names: "references" },
        );
    const result = new Map<ts.Symbol, VarPlacement>();
    for (const [symbol, declarations] of declared) {
        const others = (symbol.declarations ?? []).filter(
            (declaration) => !isAmbient(declaration),
        );
        result.set(
            symbol,
            others.length !== declarations.length
                ? "shared"
                : declarations.length === 1 &&
                    servedInPlace(
                        scope,
                        declarations[0]!,
                        references.get(symbol) ?? [],
                    )
                  ? "in-place"
                  : "hoisted",
        );
    }
    scopes.set(scope, result);
    return result;
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

/** TypeScript's "Variable is used before being assigned." */
const usedBeforeAssigned = 2454;

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
    | "program"
    | "sharedClosures"
    | "symbols"
>;

/** Lowers hoisted `var`s: storage where the scope starts, assignments where declared. */
export class VarBindings {
    /** @unjournaled Set only while one hoisted storage is declared. */
    private declaring: ts.Symbol | undefined;
    /** @unjournaled The reads TypeScript reports used before assigned, by file. */
    private readonly unassignedReads = new WeakMap<
        ts.SourceFile,
        ReadonlySet<number>
    >();

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
        for (const [symbol, placement] of scopePlacements(
            this.context.checker,
            scope,
        ))
            if (
                placement === "hoisted" &&
                !this.context.bindings.peekBinding(symbol)
            )
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
     * does not admit, refuses: one of its own scope where TypeScript reports
     * it used before assigned (or `!` asserts it is), and one of a nested
     * function lowered before the walk reached an assignment.
     */
    public refuseUnassignedRead(identifier: ts.MemberName): void {
        if (!ts.isIdentifier(identifier) || !isValueReference(identifier))
            return;
        const write = writeSiteOf(identifier)?.kind;
        if (write === "assign" || write === "loop") return;
        const declaration =
            this.context.symbols.valueSymbol(identifier)?.valueDeclaration;
        if (!declaration) return;
        const own = varScopeOf(identifier) === varScopeOf(declaration);
        // TypeScript assumes `x!` assigned and reports nothing there.
        if (
            own &&
            !hasNonNullAssertion(outermostWrapper(identifier)) &&
            !this.readsUnassigned(identifier)
        )
            return;
        this.context.fail(
            identifier,
            own
                ? `The \`var\` '${identifier.text}' can be read here before it is assigned, while it holds undefined, which its type does not admit. Assign it on every path, or declare it with \`| undefined\`.`
                : `A function reads the \`var\` '${identifier.text}' where it can still be undefined, which its type does not admit. Assign it before the function is created or called, or declare it with \`| undefined\`.`,
        );
    }

    private readsUnassigned(identifier: ts.Identifier): boolean {
        const file = identifier.getSourceFile();
        let starts = this.unassignedReads.get(file);
        if (!starts) {
            starts = new Set(
                this.context.program
                    .getSemanticDiagnostics(file)
                    .flatMap((diagnostic) =>
                        diagnostic.code === usedBeforeAssigned &&
                        diagnostic.start !== undefined
                            ? [diagnostic.start]
                            : [],
                    ),
            );
            this.unassignedReads.set(file, starts);
        }
        return starts.has(identifier.getStart());
    }
}
