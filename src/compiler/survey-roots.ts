/**
 * Survey roots: after the entry, every function of the program's own
 * sources that no lowering of the attempt began is lowered once on its own,
 * its parameters, `this` and the locals it captures from enclosing
 * functions holding empty storage of their types; then, in each function,
 * the statements no lowering began (statement roots), the names they read
 * holding the same. A survey writes no tree: a root's emission is dropped.
 */
import ts from "typescript";
import {
    findAnalysisNode,
    forEachAnalysisNode,
    sourceFileNodes,
} from "./analysis-walk.js";
import { isStaticMember } from "./class-members.js";
import { CompileError, unlessRefused } from "./compile-error.js";
import { emptyStorage, type EmptyStorageContext } from "./empty-storage.js";
import type { LoweringServices } from "./lowering-services.js";
import { isProgramSourceFile } from "./program.js";
import { isModuleInitializerStatement } from "./module-initializers.js";
import { isTotalConstStatement } from "./module-namespaces.js";
import {
    heldStatements,
    isBodyReturn,
    type SurveyCollector,
} from "./survey.js";
import {
    calledDeclaration,
    declaredSymbol,
    libraryName,
    resolvedSymbol,
} from "./symbols.js";
import {
    argumentForParameter,
    functionOfDeclaration,
    isDeclaredInside,
    isGeneratorFunction,
    isSupportedFunction,
    thisMember,
    variableKind,
    type SupportedFunction,
} from "./syntax.js";
import { pinnedHandleKind } from "./data-types.js";
import type { DataType, HandleKind } from "./data-types/model.js";
import {
    callSignatures,
    holdsOnly,
    inheritsFrom,
    isTypeReference,
    objectLikeType,
} from "./type-facts.js";
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
        | "evaluationOrder"
        | "declarations"
    > & { defaultEngineCpp: string | undefined };

/**
 * Lowers what no lowering of the survey's attempt began in the program's
 * own sources: each module's top-level statements (module roots), every
 * function, outermost first, then the statements of each function its
 * lowerings left (statement roots). A rolled-back entry statement can leave
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
    // A root of `declaration`'s code is recorded against its first
    // statement, lowers at the type arguments a call binds, and its
    // emission is dropped.
    const root = (
        first: ts.Statement,
        declaration: ts.SignatureDeclaration,
        lower: () => void,
    ): void =>
        survey.attemptRoot(context, first, () => {
            context.captureEmittedStatements(() =>
                withCalledTypeArguments(context, files, declaration, lower),
            );
        });
    const bodied = (
        node: ts.Node,
    ): node is SupportedFunction & {
        body: ts.Block;
    } => isSupportedFunction(node) && !!node.body && ts.isBlock(node.body);
    context.bindings.pushScope(context.allocateUserFunctionPrefix());
    try {
        for (const file of files) emitModuleRoot(context, survey, file);
        for (const file of files) {
            const visit = (node: ts.Node): void => {
                if (
                    bodied(node) &&
                    node.body.statements.length > 0 &&
                    survey.untouched(node.body)
                ) {
                    const [declaration, body] = [node, node.body];
                    root(body.statements[0]!, declaration, () =>
                        emitSurveyRoot(
                            context,
                            survey,
                            files,
                            declaration,
                            body,
                        ),
                    );
                }
                ts.forEachChild(node, visit);
            };
            visit(file);
        }
        // The statements no root began lower as statement roots: a dead arm
        // of a reached function, or the body of one whose own root refused
        // before its body began (a signature with no native storage). An
        // accessor's or a constructor's body has no function root: its own
        // returns are statements a statement root lowers.
        for (const file of files)
            for (const node of sourceFileNodes(file)) {
                const member = memberBody(node);
                const body =
                    member ??
                    (bodied(node) && !isGeneratorFunction(node)
                        ? node.body
                        : undefined);
                if (body)
                    for (const run of unbegunRuns(
                        survey,
                        body,
                        member !== undefined,
                    ))
                        root(run[0]!, node as ts.SignatureDeclaration, () =>
                            emitStatementRoot(context, survey, run),
                        );
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
    // A statement whose values lower, each discarded: they declare nothing
    // the roots then read.
    const lowerValues = (
        statement: ts.Statement,
        values: readonly ts.Expression[],
    ): void => {
        survey.touch(statement, false);
        survey.attemptStatement(context, statement, () => {
            for (const value of values)
                context.emitDiscardedValue(context.compileValue(value));
        });
    };
    if (context.moduleNamespaces.evaluates(file)) {
        for (const statement of file.statements) {
            if (!survey.unbegun(statement)) continue;
            // Its total constants run as the folds of their reads.
            if (isTotalConstStatement(statement, context.evaluationOrder))
                survey.touch(statement, false);
            // Another constant no read folded, or the module's default
            // export, lowers its values.
            else {
                const values =
                    ts.isVariableStatement(statement) &&
                    variableKind(statement.declarationList) === "const"
                        ? statement.declarationList.declarations.flatMap(
                              ({ initializer }) =>
                                  initializer ? [initializer] : [],
                          )
                        : ts.isExportAssignment(statement)
                          ? [statement.expression]
                          : undefined;
                if (!values) continue;
                survey.inRoots(() =>
                    context.captureEmittedStatements(() =>
                        lowerValues(statement, values),
                    ),
                );
            }
        }
        return;
    }
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
                // `export default <value>` declares the module's default
                // binding: its value is what lowers.
                if (ts.isExportAssignment(statement))
                    lowerValues(statement, [statement.expression]);
                else context.emitStatement(statement);
        }),
    );
}

/** The handle of the nearest pinned interface or class `type` extends that is one. */
function pinnedBaseHandle(type: ts.Type): HandleKind | undefined {
    let handle: HandleKind | undefined;
    inheritsFrom(type, (candidate) => {
        if (candidate === type) return false;
        handle = pinnedHandleKind(candidate);
        return handle !== undefined;
    });
    return handle;
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
    // A root's value is stored as a parameter stores its argument, but for
    // one holding a generic function: its family would demand a signature
    // at each call the roots lower, which storage built by then meets one a
    // pass. Its array is one its caller owns, which a borrowed view only
    // lends a callee; the `unknown` values a type reaches are stored as
    // documents, as a parsed value of it is.
    // A value typed `object` is dynamic, as such a binding is; an iterable
    // is an empty array of its element (`iterableArray`).
    const mapped =
        context.dataTypes.orDynamicJsonTypes(() => {
            const stored = context.dataTypes.fromStoredTsType(type, node);
            return stored && !context.dataTypes.carriesGenericFunction(stored)
                ? stored
                : context.dataTypes.fromTsType(type, node);
        }) ??
        (context.dataTypes.holdsObjectValue(type)
            ? context.dataTypes.dynamicJsonType(type)
            : undefined) ??
        iterableArray(context, type, node);
    const checker = context.checker;
    const record = checker.getNonNullableType(type);
    // An engine object no storage holds (an ArcRotateCamera) stands as the
    // empty handle of the nearest pinned type it extends (a Camera).
    const handle = mapped ? undefined : pinnedBaseHandle(record);
    const storage = emptyStorage(
        context,
        handle
            ? { kind: "handle", handle }
            : mapped && context.dataTypes.ownReadonlyArray(mapped, type),
        label,
    );
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

/**
 * An `Iterable<T>` is a protocol whose reached collection supplies its
 * storage (`UserFunctionLowerer`): a root, which no collection reaches,
 * holds an empty array of `T`, a collection of the protocol.
 */
function iterableArray(
    context: SurveyRootContext,
    type: ts.Type,
    node: ts.Node,
): DataType | undefined {
    const iterable = context.checker.getNonNullableType(type);
    if (libraryName(iterable) !== "Iterable" || !isTypeReference(iterable))
        return undefined;
    const [iterated] = context.checker.getTypeArguments(iterable);
    const element =
        iterated &&
        context.dataTypes.orDynamicJsonTypes(() =>
            context.dataTypes.fromStoredTsType(iterated, node),
        );
    return element && { kind: "vector", element };
}

/** The block body of an accessor or a constructor: one no function root lowers. */
function memberBody(node: ts.Node): ts.Block | undefined {
    return (ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)) &&
        node.body
        ? node.body
        : undefined;
}

/**
 * The runs of consecutive statements of `body` -- and of the statements a
 * begun statement of it holds, nested functions aside -- that no lowering
 * of the attempt began: an arm a generation-known condition left, what
 * follows an exit. Each run is outermost, in source order. The body's own
 * `return` is its function's result, which the function's lowering tried.
 */
function unbegunRuns(
    survey: SurveyCollector,
    body: ts.Block,
    returns = false,
): ts.Statement[][] {
    const runs: ts.Statement[][] = [];
    const visit = (statements: readonly ts.Statement[]): void => {
        let run: ts.Statement[] = [];
        for (const statement of statements) {
            // A block holds statements; its own lowering marks none begun.
            if (
                !ts.isBlock(statement) &&
                survey.unbegun(statement) &&
                (returns || !isBodyReturn(statement))
            ) {
                run.push(statement);
                continue;
            }
            if (run.length > 0) runs.push(run);
            run = [];
            const held = heldStatements(statement).statements;
            if (ts.isBlock(statement) || ts.isSwitchStatement(statement))
                visit(held);
            else for (const nested of held) visit([nested]);
        }
        if (run.length > 0) runs.push(run);
    };
    visit(body.statements);
    return runs;
}

/** Empty storage of a node's type for a root, or the refusal that it has none. */
type RootSite = (node: ts.Node, label: string, type?: ts.Type) => Value;

/**
 * `RootSite` for a name the root may leave unbound: undefined, the reason
 * counted (`unboundCapture`), where its type has no storage.
 */
type RootName = (name: ts.Identifier, node: ts.Node) => Value | undefined;

function emitSurveyRoot(
    context: SurveyRootContext,
    survey: SurveyCollector,
    files: readonly ts.SourceFile[],
    declaration: SupportedFunction,
    body: ts.Block,
): void {
    withRootBindings(
        context,
        survey,
        [declaration],
        body.statements[0]!,
        (site, bound) => {
            // A trailing parameter with a default is left out, as a call
            // leaving it out does: what the default holds reaches the body.
            let passed = declaration.parameters.length;
            while (
                passed > 0 &&
                declaration.parameters[passed - 1]!.initializer
            )
                passed--;
            const parameters = declaration.parameters.slice(0, passed);
            // A string parameter holds a generation-known string a call
            // passes, where one does: a source the body composes stays
            // generation-known (an asset URL, a shader).
            const arguments_ = parameters.map((parameter, index) =>
                ts.isIdentifier(parameter.name)
                    ? (stringParameter(context.checker, parameter) &&
                          staticArgument(context, files, declaration, index)) ||
                      bound(parameter.name, parameter)
                    : site(parameter, "parameter"),
            );
            if (arguments_.every((value) => value !== undefined)) {
                context.userFunctions.compileSurveyRoot(
                    context,
                    declaration,
                    arguments_,
                );
                return;
            }
            // A parameter with no storage of its type stays unbound: the
            // body lowers as a statement root's statements do, the others
            // bound to their placeholders or defaults.
            for (const [index, parameter] of declaration.parameters.entries()) {
                if (!ts.isIdentifier(parameter.name)) continue;
                const value =
                    arguments_[index] ??
                    (index >= passed && parameter.initializer
                        ? unlessRefused(() =>
                              context.compileValue(parameter.initializer!),
                          )
                        : undefined);
                if (value)
                    context.bindings.defineVariable(parameter.name, value);
            }
            context.userFunctions.compileSurveyStatements(
                context,
                body.statements,
            );
        },
    );
}

/**
 * Lowers `run`, statements of a function no lowering began, every name
 * they read from outside them bound as a root binds a captured local.
 */
function emitStatementRoot(
    context: SurveyRootContext,
    survey: SurveyCollector,
    run: readonly ts.Statement[],
): void {
    withRootBindings(context, survey, run, run[0]!, () =>
        context.userFunctions.compileSurveyStatements(context, run),
    );
}

/**
 * Runs `work` in a scope of its own, holding what lowering `scopes` reads
 * from enclosing functions -- each local empty storage of its type, a
 * const holding a function what its initializer makes, as the program's
 * own binding does; one with no storage of its type stays unbound, the
 * statements reading it refused (`unboundCapture`) -- with `this` the
 * instance the member holding `first`, the root's first statement, reads.
 */
function withRootBindings(
    context: SurveyRootContext,
    survey: SurveyCollector,
    scopes: readonly ts.Node[],
    first: ts.Statement,
    work: (site: RootSite, bound: RootName) => void,
): void {
    const site: RootSite = (
        node,
        label,
        type = context.checker.getTypeAtLocation(node),
    ) =>
        emptyValueOf(context, type, node, label) ??
        context.fail(
            node,
            `A survey root's ${label} has no native storage of its type (${context.dataTypes.unrepresentedPart(type, node, true)}).`,
        );
    const bound: RootName = (name, node) => {
        try {
            return site(node, name.text);
        } catch (error) {
            if (!(error instanceof CompileError)) throw error;
            survey.unboundCapture(context.checker, first, name, error);
            return undefined;
        }
    };
    // One walk up from a name finds whichever of the scopes declares it.
    const owners = new Set(scopes);
    const declaredInScopes = (name: ts.Identifier): boolean =>
        ts.findAncestor(name, (node) => owners.has(node)) !== undefined;
    context.emit({ kind: "open", code: "{" });
    context.bindings.pushScope(context.allocateUserFunctionPrefix());
    try {
        for (const scope of scopes)
            for (const { name, initializer } of capturedFunctionLocals(
                context.checker,
                scope,
            ))
                if (
                    !context.bindings.lookupOptional(name) &&
                    !declaredInScopes(name)
                ) {
                    // A nullable resource is its declaration's empty slot.
                    if (
                        !initializer &&
                        context.declarations.bindAbsentResource(name)
                    )
                        continue;
                    const value =
                        (initializer &&
                            unlessRefused(() =>
                                context.compileValue(initializer),
                            )) ??
                        bound(name, name);
                    if (value) context.bindings.defineVariable(name, value);
                }
        // A static member's `this` is its class, which no instance holds.
        const member = thisMember(first);
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
        // An object literal's method reads `this` as the record holding it,
        // stored as the type the checker gives the `this` it reads.
        const literalThis =
            member &&
            ts.isObjectLiteralExpression(member.parent) &&
            findAnalysisNode(
                member,
                (node) =>
                    node.kind === ts.SyntaxKind.ThisKeyword &&
                    thisMember(node) === member,
            );
        // Methods read a stored instance through its class's receiver.
        const instance = stored
            ? (context.classLowerer.hydrate(stored, owner) ?? stored)
            : literalThis
              ? site(literalThis, "this")
              : undefined;
        context.withThis(instance, () => work(site, bound));
    } finally {
        context.bindings.popScope();
        context.emit({ kind: "close", code: "}" });
    }
}

const rootedCalls = new WeakMap<
    ts.Program,
    Map<ts.SignatureDeclaration, ts.CallExpression[]>
>();

/** Whether every value `parameter` takes is a string. */
function stringParameter(
    checker: ts.TypeChecker,
    parameter: ts.ParameterDeclaration,
): boolean {
    return holdsOnly(checker.getTypeAtLocation(parameter), ["string"]);
}

/**
 * The calls of the program's own functions a root lowers by, by the
 * function each resolves to: a generic one's, at the type arguments a call
 * binds; one with a string parameter's, at a generation-known string a call
 * passes. Built once per program in one walk, resolving only calls whose
 * callee names one of them.
 */
function rootedCallsOf(
    context: SurveyRootContext,
    files: readonly ts.SourceFile[],
): Map<ts.SignatureDeclaration, ts.CallExpression[]> {
    const known = rootedCalls.get(context.program);
    if (known) return known;
    const checker = context.checker;
    const rooted = new Set<ts.Node>();
    const candidates: ts.CallExpression[] = [];
    for (const file of files)
        for (const node of sourceFileNodes(file)) {
            if (
                ts.isFunctionLike(node) &&
                (node.typeParameters?.length ||
                    node.parameters.some((parameter) =>
                        stringParameter(checker, parameter),
                    ))
            )
                rooted.add(node);
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
                rooted.has(declaration) ||
                (literal !== undefined && rooted.has(literal))
            );
        });
        const declaration = named && calledDeclaration(checker, call);
        if (!declaration || !rooted.has(declaration)) continue;
        const known = calls.get(declaration);
        if (known) known.push(call);
        else calls.set(declaration, [call]);
    }
    rootedCalls.set(context.program, calls);
    return calls;
}

/** How many of a function's calls a root tries for a parameter's argument. */
const triedCalls = 4;

/**
 * A generation-known string one of `declaration`'s calls passes as its
 * parameter `index`, compiled in the root's scope -- as a module constant
 * or a literal, which the root then lowers with -- or undefined.
 */
function staticArgument(
    context: SurveyRootContext,
    files: readonly ts.SourceFile[],
    declaration: SupportedFunction,
    index: number,
): Value | undefined {
    const calls = rootedCallsOf(context, files).get(declaration) ?? [];
    for (const call of calls.slice(0, triedCalls)) {
        const input = argumentForParameter(call, declaration, index);
        if (input.kind !== "argument") continue;
        const value = unlessRefused(() => context.compileValue(input.argument));
        if (value?.staticString !== undefined) return value;
    }
    return undefined;
}

/** A generic function or class whose type parameters a root binds. */
type GenericOwner = ts.SignatureDeclaration | ts.ClassLikeDeclaration;

/**
 * The type arguments a root of the generic `owner` lowers at: those of the
 * first call of it (a construction of a class) they bind no type parameter
 * in; where none does, each parameter's default or constraint, or `unknown`
 * (a document) for one with neither. Kept per owner: the program does
 * not change between passes.
 */
const calledSubstitutions = new WeakMap<
    GenericOwner,
    ReadonlyMap<ts.Symbol, ts.Type>
>();

const constructions = new WeakMap<
    ts.Program,
    Map<ts.Declaration, ts.NewExpression[]>
>();

/** The program's constructions, by the declaration each names. Built once. */
function constructionsOf(
    context: SurveyRootContext,
    files: readonly ts.SourceFile[],
): Map<ts.Declaration, ts.NewExpression[]> {
    const known = constructions.get(context.program);
    if (known) return known;
    const found = new Map<ts.Declaration, ts.NewExpression[]>();
    for (const file of files)
        for (const node of sourceFileNodes(file))
            if (ts.isNewExpression(node))
                for (const declaration of resolvedSymbol(
                    context.checker,
                    node.expression,
                )?.declarations ?? []) {
                    const list = found.get(declaration);
                    if (list) list.push(node);
                    else found.set(declaration, [node]);
                }
    constructions.set(context.program, found);
    return found;
}

/**
 * The type arguments of the first construction of the generic class
 * `owner` (its instance type's) that bind no type parameter, or undefined.
 */
function constructedTypeArguments(
    context: SurveyRootContext,
    files: readonly ts.SourceFile[],
    owner: ts.ClassLikeDeclaration,
): ReadonlyMap<ts.Symbol, ts.Type> | undefined {
    const checker = context.checker;
    const parameters = owner.typeParameters ?? [];
    for (const node of constructionsOf(context, files).get(owner) ?? []) {
        const instance = checker.getTypeAtLocation(node);
        const bound = isTypeReference(instance)
            ? checker.getTypeArguments(instance)
            : [];
        if (
            bound.length < parameters.length ||
            bound.some((type) => mentionsTypeParameter(checker, type))
        )
            continue;
        const substitution = new Map<ts.Symbol, ts.Type>();
        parameters.forEach((parameter, index) => {
            const symbol = declaredSymbol(checker, parameter.name);
            if (symbol) substitution.set(symbol, bound[index]!);
        });
        return substitution;
    }
    return undefined;
}

/** `calledSubstitutions` for a generic function or class no call binds. */
function unboundTypeArguments(
    checker: ts.TypeChecker,
    owner: GenericOwner,
): ReadonlyMap<ts.Symbol, ts.Type> {
    return unboundParameterTypes(
        checker,
        (owner.typeParameters ?? []).map((parameter) =>
            checker.getTypeAtLocation(parameter),
        ),
    );
}

/**
 * Each type parameter at the argument an unbound use takes: its default,
 * as the checker gives it; else its constraint; else `unknown`.
 */
function unboundParameterTypes(
    checker: ts.TypeChecker,
    parameters: readonly ts.Type[],
): ReadonlyMap<ts.Symbol, ts.Type> {
    const substitution = new Map<ts.Symbol, ts.Type>();
    for (const declared of parameters) {
        const symbol = declared.symbol;
        if (!symbol) continue;
        const bound = [
            checker.getDefaultFromTypeParameter(declared),
            checker.getBaseConstraintOfType(declared),
        ].find(
            (candidate) =>
                candidate !== undefined &&
                !mentionsTypeParameter(checker, candidate),
        );
        substitution.set(symbol, bound ?? checker.getUnknownType());
    }
    return substitution;
}

/**
 * Runs `work` with the type arguments of the generic functions holding
 * `declaration`, itself included, in force, outermost first: for each, the
 * type arguments of a call of it in the program (`calledSubstitutions`).
 */
function withCalledTypeArguments(
    context: SurveyRootContext,
    files: readonly ts.SourceFile[],
    declaration: ts.SignatureDeclaration,
    work: () => void,
): void {
    const checker = context.checker;
    const generic: GenericOwner[] = [];
    for (let node: ts.Node | undefined = declaration; node; node = node.parent)
        if (
            (ts.isFunctionLike(node) || ts.isClassLike(node)) &&
            node.typeParameters?.length
        )
            generic.unshift(node);
    // A function a contextual generic signature types (an object literal's
    // `constrain(kind, point)` under `constrain<T extends Seat>(...)`) has
    // that signature's type parameters, which no call of it binds.
    const contextual = declaration.typeParameters?.length
        ? []
        : (checker.getSignatureFromDeclaration(declaration)?.typeParameters ??
          []);
    // A class's polymorphic `this` (`const owner = this`) is its instance.
    const instances = new Map<ts.Symbol, ts.Type>();
    for (let node: ts.Node | undefined = declaration; node; node = node.parent)
        if (ts.isClassLike(node) && node.name) {
            const symbol = declaredSymbol(checker, node.name);
            const instance = symbol
                ? (checker.getDeclaredTypeOfSymbol(symbol) as ts.InterfaceType)
                : undefined;
            if (instance?.thisType?.symbol)
                instances.set(instance.thisType.symbol, instance);
        }
    if (
        generic.length === 0 &&
        contextual.length === 0 &&
        instances.size === 0
    ) {
        work();
        return;
    }
    // A function's first call binding every type parameter.
    const called = (
        owner: ts.SignatureDeclaration,
    ): ReadonlyMap<ts.Symbol, ts.Type> | undefined => {
        for (const call of rootedCallsOf(context, files).get(owner) ?? []) {
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
            )
                return substitution;
        }
        return undefined;
    };
    const substitutionOf = (
        owner: GenericOwner,
    ): ReadonlyMap<ts.Symbol, ts.Type> => {
        const known = calledSubstitutions.get(owner);
        if (known) return known;
        const found =
            (ts.isClassLike(owner)
                ? constructedTypeArguments(context, files, owner)
                : called(owner)) ?? unboundTypeArguments(checker, owner);
        calledSubstitutions.set(owner, found);
        return found;
    };
    context.dataTypes.withTypeArgumentFrames(
        [
            ...generic.map(substitutionOf),
            ...(contextual.length
                ? [unboundParameterTypes(checker, contextual)]
                : []),
            ...(instances.size ? [instances] : []),
        ],
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
 * initializer reads, and for a function an enclosing function declares,
 * those its body reads. Those come first, so each binds before the
 * function that reads it. Kept per declaration: the program does not
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
                // A function an enclosing function declares lowers at its
                // calls, reading what it captures there.
                if (
                    local &&
                    ts.isFunctionDeclaration(local) &&
                    local.body &&
                    !isDeclaredInside(local, declaration) &&
                    ts.findAncestor(local.parent, ts.isFunctionLike)
                ) {
                    scan(local.body);
                    return;
                }
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
