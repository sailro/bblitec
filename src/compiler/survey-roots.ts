/**
 * Survey roots: after the entry, every function of the program's own
 * sources that no lowering of the attempt began is lowered once on its own,
 * its parameters, `this` and the locals it captures from enclosing
 * functions holding empty storage of their types. A survey writes no tree:
 * a root's emission is dropped.
 */
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { isStaticMember } from "./class-members.js";
import { unlessRefused } from "./compile-error.js";
import type { DataType } from "./data-types/model.js";
import type { LoweringServices } from "./lowering-services.js";
import { isProgramSourceFile } from "./program.js";
import type { SurveyCollector } from "./survey.js";
import { declaredSymbol, resolvedSymbol } from "./symbols.js";
import {
    isDeclaredInside,
    isSupportedFunction,
    thisMember,
    type SupportedFunction,
} from "./syntax.js";
import { callSignatures, objectLikeType } from "./type-facts.js";
import type { Value } from "./types.js";
import type { UserFunctionContext } from "./user-functions.js";

/** What a native local of empty storage needs from its compiler. */
export type EmptyStorageContext = Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
    | "emit"
    | "dataTypes"
    | "dataLowerer"
    | "requireDefaultEngine"
    | "sourceFile"
>;

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
    > & { defaultEngineCpp: string | undefined };

/**
 * A native local holding empty storage of `type`; undefined when it has
 * none. A resource no carrier names belongs to the entry's one engine,
 * when there is one.
 */
export function emptyStorage(
    context: EmptyStorageContext,
    type: DataType | undefined,
    label: string,
): Value | undefined {
    if (!type) return undefined;
    const cpp = context.allocateTemporaryCppName(`empty_${label}`);
    context.emit({
        kind: "declaration",
        type: context.dataTypes.cppType(type),
        name: cpp,
        initializer: "{}",
    });
    const value = context.dataLowerer.leafValue(cpp, type);
    if (value.kind === "data" || value.engineCpp) return value;
    const engineCpp = unlessRefused(() =>
        context.requireDefaultEngine(context.sourceFile),
    );
    return engineCpp ? { ...value, engineCpp } : value;
}

/**
 * Lowers every function of the program's own sources that no lowering of
 * the survey's attempt began, outermost first. A rolled-back entry
 * statement can leave the entry's one engine undeclared: the roots then
 * hold one of their own while they lower.
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
    try {
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
                            emitSurveyRoot(context, declaration, body),
                        );
                    });
                }
                ts.forEachChild(node, visit);
            };
            visit(file);
        }
    } finally {
        context.defaultEngineCpp = enclosingEngine;
    }
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
    const storage = emptyStorage(
        context,
        context.dataTypes.fromTsType(type, node),
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
        for (const name of capturedFunctionLocals(context.checker, declaration))
            if (!context.bindings.lookupOptional(name))
                context.bindings.defineVariable(name, site(name, name.text));
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

const capturedLocals = new WeakMap<ts.Node, ts.Identifier[]>();

/**
 * The variables and parameters of enclosing functions that `declaration`
 * reads, by their declared names: what a root binds besides its
 * parameters. Kept per declaration: the program does not change between
 * passes.
 */
function capturedFunctionLocals(
    checker: ts.TypeChecker,
    declaration: ts.Node,
): ts.Identifier[] {
    const known = capturedLocals.get(declaration);
    if (known) return known;
    const found = new Map<ts.Symbol, ts.Identifier>();
    forEachAnalysisNode(
        declaration,
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
                isDeclaredInside(local, declaration) ||
                !ts.findAncestor(local.parent, ts.isFunctionLike)
            )
                return;
            found.set(symbol, local.name);
        },
        { types: "skip", names: "references" },
    );
    const locals = [...found.values()];
    capturedLocals.set(declaration, locals);
    return locals;
}
