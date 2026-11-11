/**
 * Survey roots: after the entry, every function of the program's own
 * sources that no lowering of the attempt began is lowered once on its own,
 * its parameters, `this` and the locals it captures from enclosing
 * functions holding empty storage of their types. A survey writes no tree:
 * a root's emission is dropped.
 */
import ts from "typescript";
import { forEachAnalysisNode, sourceFileNodes } from "./analysis-walk.js";
import { isStaticMember } from "./class-members.js";
import { unlessRefused } from "./compile-error.js";
import { emptyStorage, type EmptyStorageContext } from "./empty-storage.js";
import type { LoweringServices } from "./lowering-services.js";
import { isProgramSourceFile } from "./program.js";
import { isModuleInitializerStatement } from "./module-initializers.js";
import type { SurveyCollector } from "./survey.js";
import {
    calledDeclaration,
    declaredSymbol,
    resolvedSymbol,
} from "./symbols.js";
import {
    functionOfDeclaration,
    isDeclaredInside,
    isSupportedFunction,
    thisMember,
    variableKind,
    type SupportedFunction,
} from "./syntax.js";
import { callSignatures, objectLikeType } from "./type-facts.js";
import { callTypeArguments, mentionsTypeParameter } from "./type-arguments.js";
import type { Value } from "./types.js";
import type { UserFunctionContext } from "./user-functions.js";

/** What the survey roots need from their compiler. */
export type SurveyRootContext = UserFunctionContext &
    EmptyStorageContext &
    Pick<
        LoweringServices,
        | "program"
        | "options"
        | "checker"
        | "bindings"
        | "allocateUserFunctionPrefix"
        | "registerNativeBindingType"
        | "classLowerer"
        | "userFunctions"
        | "withThis"
        | "captureEmittedStatements"
        | "fail"
        | "realmEngine"
        | "refusedDemand"
        | "bindEmptyStorage"
        | "emitStatement"
        | "compileValue"
        | "emitDiscardedValue"
        | "moduleNamespaces"
    > & { defaultEngineCpp: string | undefined };

/**
 * Lowers what no lowering of the survey's attempt began in the program's
 * own sources: each module's top-level statements (module roots), then
 * every function, outermost first. A rolled-back entry statement can leave
 * the entry's one engine undeclared: the roots then hold one of their own
 * while they lower.
 */
export function emitSurveyRoots(
    context: SurveyRootContext,
    survey: SurveyCollector,
): void {
    const files = context.program.getSourceFiles().filter(isProgramSourceFile);
    survey.programSources(files);
    const enclosingEngine = context.defaultEngineCpp;
    if (!enclosingEngine) {
        const engine = context.realmEngine(
            context.allocateTemporaryCppName("survey_engine"),
        );
        context.emit({
            kind: "declaration",
            type: engine.type,
            name: engine.name,
            initializer: "{}",
        });
        context.registerNativeBindingType(engine.name, engine.type);
        context.defaultEngineCpp = engine.cpp;
    }
    // Module roots lower first, in one scope the function roots then lower
    // in: a function reads the module bindings they declare. Nothing the
    // roots emit reaches the program's body.
    context.bindings.pushScope(context.allocateUserFunctionPrefix());
    try {
        for (const file of files) emitModuleRoot(context, survey, file);
        for (const file of files) {
            const visit = (node: ts.Node): void => {
                if (
                    isSupportedFunction(node) &&
                    node.body &&
                    ts.isBlock(node.body) &&
                    node.body.statements.length > 0 &&
                    survey.untouched(node.body)
                ) {
                    const [declaration, body] = [node, node.body];
                    survey.attemptRoot(context, body, () => {
                        context.captureEmittedStatements(() =>
                            withCalledTypeArguments(
                                context,
                                files,
                                declaration,
                                () =>
                                    emitSurveyRoot(context, declaration, body),
                            ),
                        );
                    });
                }
                ts.forEachChild(node, visit);
            };
            visit(file);
        }
    } finally {
        context.bindings.popScope();
        context.defaultEngineCpp = enclosingEngine;
    }
}

/**
 * Lowers the top-level statements of a module the program never evaluates
 * (one nothing imports at run time), each its own attempt, in the roots'
 * scope. A module the program evaluates lowers its own statements, folding
 * a constant it only reads where it is read. Function declarations lower as
 * roots of their own; classes, enums and namespaces stay with the module
 * that declares them.
 */
function emitModuleRoot(
    context: SurveyRootContext,
    survey: SurveyCollector,
    file: ts.SourceFile,
): void {
    if (context.moduleNamespaces.evaluates(file)) return;
    const pending = file.statements.filter(
        (statement) =>
            isModuleInitializerStatement(statement, context.checker) &&
            !ts.isClassDeclaration(statement) &&
            !ts.isModuleDeclaration(statement) &&
            survey.unbegun(statement),
    );
    if (pending.length === 0) return;
    survey.inRoots(() =>
        context.captureEmittedStatements(() => {
            for (const statement of pending)
                if (ts.isExportAssignment(statement)) {
                    // `export default <value>` declares the module's
                    // default binding: its value is what lowers.
                    survey.touch(statement, false);
                    survey.attemptStatement(context, statement, () =>
                        context.emitDiscardedValue(
                            context.compileValue(statement.expression),
                        ),
                    );
                } else context.emitStatement(statement);
        }),
    );
}

/**
 * Empty storage of `type`, or -- for a record no native layout holds (one
 * with function members) -- the record a literal of that type would be:
 * each member, `depth` levels down, empty storage of its own type, a member
 * with none left out. Undefined for anything else.
 */
function emptyValueOf(
    context: SurveyRootContext,
    type: ts.Type,
    node: ts.Node,
    label: string,
    depth = 0,
): Value | undefined {
    // A root's array is one its caller owns, which a borrowed view only
    // lends a callee.
    const mapped = context.dataTypes.fromTsType(type, node);
    const storage = emptyStorage(
        context,
        mapped && context.dataTypes.ownReadonlyArray(mapped, type),
        label,
    );
    const checker = context.checker;
    const record = checker.getNonNullableType(type);
    if (
        storage ||
        depth >= 3 ||
        !objectLikeType(record) ||
        checker.isArrayType(record) ||
        checker.isTupleType(record) ||
        callSignatures(checker, record, "exact").length > 0
    )
        return storage;
    const recordProperties: Record<string, Value> = {};
    for (const property of checker.getPropertiesOfType(record)) {
        const value = unlessRefused(() =>
            emptyValueOf(
                context,
                checker.getTypeOfSymbolAtLocation(property, node),
                node,
                `${label}_${property.name}`,
                depth + 1,
            ),
        );
        if (value) recordProperties[property.name] = value;
    }
    return { kind: "record", cpp: "", recordProperties };
}

function emitSurveyRoot(
    context: SurveyRootContext,
    declaration: SupportedFunction,
    body: ts.Block,
): void {
    const site = (
        node: ts.Node,
        label: string,
        type = context.checker.getTypeAtLocation(node),
    ): Value =>
        emptyValueOf(context, type, node, label) ??
        context.fail(
            node,
            `A survey root's ${label} has no native storage of its type.`,
        );
    context.emit({ kind: "open", code: "{" });
    context.bindings.pushScope(context.allocateUserFunctionPrefix());
    try {
        // A captured const holding a function holds what its initializer
        // makes, as the program's own binding does.
        for (const { name, initializer } of capturedFunctionLocals(
            context.checker,
            declaration,
        ))
            if (!context.bindings.lookupOptional(name)) {
                const value =
                    (initializer &&
                        unlessRefused(() =>
                            context.compileValue(initializer),
                        )) ??
                    site(name, name.text);
                context.bindings.defineVariable(name, value);
            }
        // A static member's `this` is its class, which no instance holds.
        const member = thisMember(body);
        const owner =
            member &&
            ts.isClassLike(member.parent) &&
            !ts.isClassStaticBlockDeclaration(member) &&
            !(ts.isClassElement(member) && isStaticMember(member))
                ? member.parent
                : undefined;
        // An instance a root holds is stored: the class is shared from its
        // first construction (a demand the next pass replays with).
        if (owner) context.dataTypes.requireSharedClass(owner);
        const ownerSymbol =
            owner?.name && declaredSymbol(context.checker, owner.name);
        const stored =
            owner &&
            ownerSymbol &&
            site(
                owner,
                "this",
                context.checker.getDeclaredTypeOfSymbol(ownerSymbol),
            );
        // Methods read a stored instance through its class's receiver.
        const instance =
            stored && (context.classLowerer.hydrate(stored, owner) ?? stored);
        const arguments_ = declaration.parameters.map((parameter) =>
            site(
                parameter,
                ts.isIdentifier(parameter.name)
                    ? parameter.name.text
                    : "parameter",
            ),
        );
        context.withThis(instance, () =>
            context.userFunctions.compileSurveyRoot(
                context,
                declaration,
                arguments_,
            ),
        );
    } finally {
        context.bindings.popScope();
        context.emit({ kind: "close", code: "}" });
    }
}

const genericCalls = new WeakMap<
    ts.Program,
    Map<ts.SignatureDeclaration, ts.CallExpression[]>
>();

/**
 * The calls of the program's own generic functions, by the function each
 * resolves to: a root of one lowers at the type arguments a call binds.
 * Built once per program in one walk, resolving only calls whose callee
 * names one of them.
 */
function genericCallsOf(
    context: SurveyRootContext,
    files: readonly ts.SourceFile[],
): Map<ts.SignatureDeclaration, ts.CallExpression[]> {
    const known = genericCalls.get(context.program);
    if (known) return known;
    const checker = context.checker;
    const generic = new Set<ts.Node>();
    const candidates: ts.CallExpression[] = [];
    for (const file of files)
        for (const node of sourceFileNodes(file)) {
            if (ts.isFunctionLike(node) && node.typeParameters?.length)
                generic.add(node);
            else if (ts.isCallExpression(node)) candidates.push(node);
        }
    const calls = new Map<ts.SignatureDeclaration, ts.CallExpression[]>();
    for (const call of candidates) {
        const named = resolvedSymbol(
            checker,
            call.expression,
        )?.declarations?.some((declaration) => {
            const literal = ts.isVariableDeclaration(declaration)
                ? functionOfDeclaration(declaration)
                : undefined;
            return (
                generic.has(declaration) ||
                (literal !== undefined && generic.has(literal))
            );
        });
        const declaration = named && calledDeclaration(checker, call);
        if (!declaration || !generic.has(declaration)) continue;
        const known = calls.get(declaration);
        if (known) known.push(call);
        else calls.set(declaration, [call]);
    }
    genericCalls.set(context.program, calls);
    return calls;
}

/**
 * The type arguments a root of the generic `owner` lowers at: those of the
 * first call of it they bind no type parameter in; undefined when no call
 * does. Kept per function: the program does not change between passes.
 */
const calledSubstitutions = new WeakMap<
    ts.SignatureDeclaration,
    ReadonlyMap<ts.Symbol, ts.Type> | null
>();

/**
 * Runs `work` with the type arguments of the generic functions holding
 * `declaration`, itself included, in force, outermost first: for each, the
 * type arguments of a call of it in the program (`calledSubstitutions`).
 */
function withCalledTypeArguments(
    context: SurveyRootContext,
    files: readonly ts.SourceFile[],
    declaration: SupportedFunction,
    work: () => void,
): void {
    const generic: ts.SignatureDeclaration[] = [];
    for (let node: ts.Node | undefined = declaration; node; node = node.parent)
        if (ts.isFunctionLike(node) && node.typeParameters?.length)
            generic.unshift(node);
    if (generic.length === 0) {
        work();
        return;
    }
    const checker = context.checker;
    const substitutionOf = (
        owner: ts.SignatureDeclaration,
    ): ReadonlyMap<ts.Symbol, ts.Type> | null => {
        const known = calledSubstitutions.get(owner);
        if (known !== undefined) return known;
        let found: ReadonlyMap<ts.Symbol, ts.Type> | null = null;
        for (const call of genericCallsOf(context, files).get(owner) ?? []) {
            const substitution = unlessRefused(() =>
                callTypeArguments(checker, call, owner, (node, text) =>
                    context.fail(node, text),
                ),
            );
            if (
                substitution &&
                [...substitution.values()].every(
                    (type) => !mentionsTypeParameter(checker, type),
                )
            ) {
                found = substitution;
                break;
            }
        }
        calledSubstitutions.set(owner, found);
        return found;
    };
    context.dataTypes.withTypeArgumentFrames(
        generic.flatMap((owner) => substitutionOf(owner) ?? []),
        work,
    );
}

/** A captured name, with the initializer of the function `const` it is. */
interface CapturedLocal {
    name: ts.Identifier;
    initializer: ts.Expression | undefined;
}

const capturedLocals = new WeakMap<ts.Node, CapturedLocal[]>();

/**
 * The initializer of a `const` declared `local` that holds a function --
 * a literal, a choice of literals (`traced ? <T>(...) => ... : ...`), a
 * factory's result -- if any.
 */
function constFunctionInitializer(
    checker: ts.TypeChecker,
    local: ts.Declaration,
): ts.Expression | undefined {
    if (
        !ts.isVariableDeclaration(local) ||
        variableKind(local) !== "const" ||
        !local.initializer
    )
        return undefined;
    const literal = functionOfDeclaration(local);
    if (literal && ts.isExpression(literal)) return literal;
    return callSignatures(
        checker,
        checker.getTypeAtLocation(local.name),
        "exact",
    ).length > 0
        ? local.initializer
        : undefined;
}

/**
 * The variables and parameters of enclosing functions that `declaration`
 * reads, by their declared names: what a root binds besides its
 * parameters -- with, for a captured const holding a function, those its
 * initializer reads. Those come first, so each binds before the function
 * that reads it. Kept per declaration: the program does not
 * change between passes.
 */
function capturedFunctionLocals(
    checker: ts.TypeChecker,
    declaration: ts.Node,
): CapturedLocal[] {
    const known = capturedLocals.get(declaration);
    if (known) return known;
    const found = new Map<ts.Symbol, CapturedLocal>();
    const scanned = new Set<ts.Node>();
    const scan = (scope: ts.Node): void => {
        if (scanned.has(scope)) return;
        scanned.add(scope);
        forEachAnalysisNode(
            scope,
            (node) => {
                if (!ts.isIdentifier(node)) return;
                const symbol = resolvedSymbol(checker, node);
                const local = symbol?.valueDeclaration;
                if (
                    !symbol ||
                    !local ||
                    found.has(symbol) ||
                    !(
                        ts.isVariableDeclaration(local) ||
                        ts.isParameter(local) ||
                        ts.isBindingElement(local)
                    ) ||
                    !ts.isIdentifier(local.name) ||
                    isDeclaredInside(local, scope) ||
                    isDeclaredInside(local, declaration) ||
                    !ts.findAncestor(local.parent, ts.isFunctionLike)
                )
                    return;
                const initializer = constFunctionInitializer(checker, local);
                if (initializer) scan(initializer);
                found.set(symbol, { name: local.name, initializer });
            },
            { types: "skip", names: "references" },
        );
    };
    scan(declaration);
    const locals = [...found.values()];
    capturedLocals.set(declaration, locals);
    return locals;
}
