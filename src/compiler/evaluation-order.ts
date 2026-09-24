import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { classChain, type ClassHierarchy } from "./class-members.js";
import { isEngineDeclaration, type EngineBodies } from "./engine-bodies.js";
import { writeReceiverMethods } from "./data-methods.js";
import { propertyIsReadOnly } from "./data-types.js";
import {
    declaredInDefaultLibrary,
    libraryGlobal,
    resolvedSymbol,
} from "./symbols.js";
import { doubleLiteral } from "../cpp-literals.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import {
    assignmentTargets,
    isAssignmentExpression,
    isUpdateExpression,
    unwrapExpression,
} from "./syntax.js";

/**
 * JavaScript evaluates the operands of one expression left to right. The
 * lowering does not always keep that order: an operand whose call is
 * inlined or shared runs its work in statements emitted ahead of the
 * expression, and C++ leaves the order of operands inside one expression
 * unspecified. An operand is therefore read into a temporary before the
 * later operands lower whenever the two touch the same storage and one of
 * them writes it.
 *
 * What an operand touches is answered from the source: the variables it
 * reads and writes, whether it reads or writes objects that existed before
 * it ran (their properties and elements, as one store), and, through the
 * functions it calls, everything they touch. A call the analysis cannot
 * follow -- a function value it cannot name, an abstract method, an
 * `await` -- touches everything. An engine function or class method is read
 * from the pin's own body behind its typing (`engine-bodies.ts`), the
 * engine's module state counting as object state; an engine member with no
 * pinned body (an interface method) touches everything. A function of the
 * language's library has no body to read: it is taken to read its receiver
 * and the objects it is handed, to write only through the mutating
 * container methods (`push`, `set`, `sort`, ...), and to run the callbacks
 * it is handed. `Math.random` reads and writes its generator, so two draws
 * keep their order.
 */

/** Storage an evaluation reads or writes. */
interface Storage {
    /** Code the analysis cannot follow ran: anything may be touched. */
    any: boolean;
    /** Properties and elements of objects that existed before the evaluation. */
    heap: boolean;
    /** Variables by symbol, and the state behind `Math.random`. */
    variables: Set<ts.Symbol | typeof randomState>;
}

interface Access {
    readonly reads: Storage;
    readonly writes: Storage;
}

/** What one function body touches itself, and the functions it runs. */
interface DirectAccess extends Access {
    readonly callees: Set<Unit>;
}

/** Code a call runs: a function body, or a class field's initializer. */
type Unit = ts.FunctionLikeDeclaration | ts.PropertyDeclaration;

/** The generator `Math.random` advances: each call reads and writes it. */
const randomState = Symbol("Math.random");

/**
 * Whether a built-in method changes its receiver. Read at call time: the
 * table lives in a module that imports this one.
 */
function mutatesReceiver(method: string): boolean {
    return method === "sort" || writeReceiverMethods.has(method);
}

function emptyStorage(): Storage {
    return { any: false, heap: false, variables: new Set() };
}

function touchesAnything(storage: Storage): boolean {
    return storage.any || storage.heap || storage.variables.size > 0;
}

function touches(left: Storage, right: Storage): boolean {
    if (left.any) return touchesAnything(right);
    if (right.any) return touchesAnything(left);
    if (left.heap && right.heap) return true;
    return [...left.variables].some((variable) =>
        right.variables.has(variable),
    );
}

/** Record code the analysis cannot follow: it may read and write anything. */
function touchEverything(access: Access): void {
    access.reads.any = true;
    access.writes.any = true;
}

function merge(into: Storage, from: Storage): void {
    into.any ||= from.any;
    into.heap ||= from.heap;
    from.variables.forEach((variable) => into.variables.add(variable));
}

/** Whether the later operand's evaluation must not overtake the earlier one's. */
function conflicts(earlier: Access, later: Access): boolean {
    return (
        touches(earlier.writes, later.reads) ||
        touches(earlier.reads, later.writes) ||
        touches(earlier.writes, later.writes)
    );
}

/** The function (or file) whose frame a declaration's variable lives in. */
function evaluationContainer(node: ts.Node): ts.Node {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isFunctionLike(current) || ts.isSourceFile(current))
            return current;
        if (ts.isClassStaticBlockDeclaration(current)) return current;
    }
    return node.getSourceFile();
}

/** Whether `outer` lexically contains `inner`. */
function encloses(outer: ts.Node, inner: ts.Node): boolean {
    for (let current = inner.parent; current; current = current.parent)
        if (current === outer) return true;
    return false;
}

/** The object an access chain starts from: `a` for `a.b[0].c`. */
function accessRoot(expression: ts.Expression): ts.Expression {
    let current = unwrapExpression(expression);
    while (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
    )
        current = unwrapExpression(current.expression);
    return current;
}

/** The targets a `for (x of ...)` / `for (x in ...)` loop assigns. */
function loopTargets(node: ts.Node): readonly ts.Expression[] {
    return (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer)
        ? assignmentTargets(node.initializer)
        : [];
}

/** One analysis of the pinned program per resolver, shared by every scene. */
const pinnedOrders = new WeakMap<EngineBodies, EvaluationOrder>();

export class EvaluationOrder {
    private readonly written = new WeakMap<ts.SourceFile, Set<ts.Symbol>>();
    private readonly direct = new Map<Unit, DirectAccess>();
    private readonly summaries = new Map<Unit, Access>();

    public constructor(
        private readonly checker: ts.TypeChecker,
        private readonly hierarchy: ClassHierarchy,
        /** The engine's pinned bodies, for a scene program's calls into it. */
        private readonly engine?: () => EngineBodies,
    ) {}

    /**
     * For operands evaluated in order, the flag per operand that says it
     * must be read into a temporary before the rest lower: some later
     * operand touches what it touches, and one of the two writes it.
     */
    public operandsToPin(operands: readonly ts.Node[]): boolean[] {
        const accesses = operands.map((operand) => this.access(operand));
        return accesses.map((earlier, index) =>
            accesses
                .slice(index + 1)
                .some((later) => conflicts(earlier, later)),
        );
    }

    /**
     * Whether evaluating `node` again later could give another value or
     * repeat an effect: it reads storage some code writes, or writes
     * storage itself.
     */
    public touchesStorage(node: ts.Node): boolean {
        const access = this.access(node);
        return touchesAnything(access.reads) || touchesAnything(access.writes);
    }

    /** Everything evaluating `node` touches, the functions it calls included. */
    private access(node: ts.Node): Access {
        const direct = this.walk([node], undefined);
        const access: Access = {
            reads: direct.reads,
            writes: direct.writes,
        };
        direct.callees.forEach((callee) => {
            const summary = this.summary(callee);
            merge(access.reads, summary.reads);
            merge(access.writes, summary.writes);
        });
        return access;
    }

    /**
     * Whether a value built from `built` must be read before a call to
     * `callee` runs, rather than where the callee reads it: building it has
     * an effect, or the callee (with everything it reaches) writes storage
     * the value reads.
     */
    public calleeChanges(built: ts.Node, callee: ts.Node): boolean {
        const access = this.access(built);
        if (touchesAnything(access.writes)) return true;
        const units = this.declarationUnits(callee);
        return !units || touches(this.bodyAccess(units).writes, access.reads);
    }

    /**
     * The code calling a declaration runs: a constructor's whole chain, every
     * implementation an overridden method dispatches to, a function's body;
     * undefined for a declaration without one.
     */
    private declarationUnits(
        declaration: ts.Node,
    ): readonly Unit[] | undefined {
        if (ts.isConstructorDeclaration(declaration))
            return ts.isClassDeclaration(declaration.parent)
                ? this.construction(declaration.parent)
                : undefined;
        if (ts.isMethodDeclaration(declaration)) {
            const implementations = this.hierarchy.implementations(
                declaration,
            ) ?? [declaration];
            return implementations.every(
                (implementation): implementation is ts.MethodDeclaration =>
                    implementation?.body !== undefined,
            )
                ? implementations
                : undefined;
        }
        if (ts.isAccessor(declaration))
            return declaration.body &&
                !(
                    ts.isClassDeclaration(declaration.parent) &&
                    this.hierarchy.subclasses(declaration.parent).length > 0
                )
                ? [declaration]
                : undefined;
        return (ts.isFunctionDeclaration(declaration) ||
            ts.isFunctionExpression(declaration) ||
            ts.isArrowFunction(declaration)) &&
            declaration.body
            ? [declaration]
            : undefined;
    }

    /**
     * What running the units touches outside their own frames, merged: the
     * access a call reaching any of them may have.
     */
    public bodyAccess(units: readonly Unit[]): Access {
        const access: Access = {
            reads: emptyStorage(),
            writes: emptyStorage(),
        };
        units.forEach((unit) => {
            const summary = this.summary(unit);
            merge(access.reads, summary.reads);
            merge(access.writes, summary.writes);
        });
        return access;
    }

    /**
     * What running `unit` touches outside its own frame: its own body and
     * every function it can reach, less the variables those functions
     * declare -- each run has fresh ones no caller can see. A function that
     * encloses `unit` is the exception: its variables are the ones `unit`
     * closes over.
     */
    private summary(unit: Unit): Access {
        const known = this.summaries.get(unit);
        if (known) return known;
        const summary: Access = {
            reads: emptyStorage(),
            writes: emptyStorage(),
        };
        const reached = new Set<Unit>([unit]);
        const pending: Unit[] = [unit];
        for (let next = pending.pop(); next; next = pending.pop()) {
            const direct = this.directAccess(next);
            merge(summary.reads, direct.reads);
            merge(summary.writes, direct.writes);
            if (summary.reads.any && summary.writes.any) break;
            direct.callees.forEach((callee) => {
                if (reached.has(callee)) return;
                reached.add(callee);
                pending.push(callee);
            });
        }
        for (const storage of [summary.reads, summary.writes]) {
            storage.variables.forEach((variable) => {
                if (typeof variable === "symbol") return;
                const frame = this.frameOf(variable);
                if (
                    frame &&
                    reached.has(frame) &&
                    !(frame !== unit && encloses(frame, unit))
                )
                    storage.variables.delete(variable);
            });
        }
        this.summaries.set(unit, summary);
        return summary;
    }

    private directAccess(unit: Unit): DirectAccess {
        const known = this.direct.get(unit);
        if (known) return known;
        const roots: ts.Node[] = ts.isPropertyDeclaration(unit)
            ? unit.initializer
                ? [unit.initializer]
                : []
            : [
                  ...unit.parameters.flatMap((parameter) =>
                      parameter.initializer ? [parameter.initializer] : [],
                  ),
                  ...(unit.body ? [unit.body] : []),
              ];
        const direct = this.walk(roots, unit);
        this.direct.set(unit, direct);
        return direct;
    }

    /** The storage `roots` touch themselves, and the functions they call. */
    private walk(
        roots: readonly ts.Node[],
        unit: Unit | undefined,
    ): DirectAccess {
        const access: DirectAccess = {
            reads: emptyStorage(),
            writes: emptyStorage(),
            callees: new Set(),
        };
        const visit = (current: ts.Node): "skip" | void => {
            const targets = isAssignmentExpression(current)
                ? assignmentTargets(current.left)
                : isUpdateExpression(current)
                  ? [current.operand]
                  : ts.isDeleteExpression(current)
                    ? [current.expression]
                    : loopTargets(current);
            if (targets.length > 0) {
                targets.forEach((target) => this.write(access, target, unit));
            } else if (
                ts.isAwaitExpression(current) ||
                ts.isTaggedTemplateExpression(current)
            ) {
                touchEverything(access);
            } else if (
                ts.isCallExpression(current) ||
                ts.isNewExpression(current)
            ) {
                this.call(access, current, unit);
            } else if (
                ts.isPropertyAccessExpression(current) ||
                ts.isElementAccessExpression(current)
            ) {
                return this.read(access, current, unit);
            } else if (ts.isIdentifier(current)) {
                const symbol = resolvedSymbol(this.checker, current);
                if (symbol && this.isWrittenVariable(symbol))
                    access.reads.variables.add(symbol);
            }
        };
        roots.forEach((root) =>
            forEachAnalysisNode(root, visit, {
                functions: "skip",
                types: "skip",
                memberNames: "skip",
            }),
        );
        return access;
    }

    private read(
        access: DirectAccess,
        node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
        unit: Unit | undefined,
    ): "skip" | void {
        const symbol = resolvedSymbol(this.checker, node);
        // An enum member or a readonly constant of the language's own
        // library (`Math.PI`) never changes; a library function read off
        // a namespace object (`Math.sin`) is no object's state.
        if (
            symbol &&
            ((symbol.flags & ts.SymbolFlags.EnumMember) !== 0 ||
                (declaredInDefaultLibrary(symbol) &&
                    (propertyIsReadOnly(symbol) ||
                        (libraryGlobal(this.checker, node.expression) !==
                            undefined &&
                            (symbol.flags & ts.SymbolFlags.Method) !== 0))))
        )
            return "skip";
        const getter = symbol?.declarations?.find(
            (declaration): declaration is ts.GetAccessorDeclaration =>
                ts.isGetAccessorDeclaration(declaration) &&
                !declaration.getSourceFile().isDeclarationFile,
        );
        if (getter) this.runs(access, getter);
        if (!this.isFresh(node, unit)) access.reads.heap = true;
    }

    private write(
        access: DirectAccess,
        target: ts.Expression,
        unit: Unit | undefined,
    ): void {
        const node = unwrapExpression(target);
        if (ts.isIdentifier(node)) {
            const symbol = resolvedSymbol(this.checker, node);
            if (symbol) access.writes.variables.add(symbol);
            else access.writes.any = true;
            return;
        }
        if (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        ) {
            const setter = resolvedSymbol(
                this.checker,
                node,
            )?.declarations?.find(
                (declaration): declaration is ts.SetAccessorDeclaration =>
                    ts.isSetAccessorDeclaration(declaration) &&
                    !declaration.getSourceFile().isDeclarationFile,
            );
            if (setter) this.runs(access, setter);
        }
        if (!this.isFresh(node, unit)) access.writes.heap = true;
    }

    /** Record that `access` runs an accessor, or anything when an override may run instead. */
    private runs(access: DirectAccess, accessor: ts.AccessorDeclaration): void {
        if (
            !accessor.body ||
            (ts.isClassDeclaration(accessor.parent) &&
                this.hierarchy.subclasses(accessor.parent).length > 0)
        ) {
            touchEverything(access);
            return;
        }
        access.callees.add(accessor);
    }

    private call(
        access: DirectAccess,
        call: ts.CallExpression | ts.NewExpression,
        unit: Unit | undefined,
    ): void {
        if (this.isRandom(call.expression)) {
            access.reads.variables.add(randomState);
            access.writes.variables.add(randomState);
            return;
        }
        const engine = this.engineAccess(call);
        if (engine) {
            merge(access.reads, engine.reads);
            merge(access.writes, engine.writes);
            return;
        }
        const units = this.callees(call);
        if (units === "library") {
            this.libraryCall(access, call, unit);
            return;
        }
        if (!units) touchEverything(access);
        else units.forEach((callee) => access.callees.add(callee));
    }

    /**
     * What an engine call touches, from the pinned bodies its typing names:
     * everything when it names none or runs code the pinned bodies cannot
     * follow, otherwise the objects and engine state they read and write.
     * Undefined for a call that is not the engine's.
     */
    private engineAccess(
        call: ts.CallExpression | ts.NewExpression,
    ): Access | undefined {
        if (!this.engine || ts.isNewExpression(call)) return undefined;
        const declaration =
            this.checker.getResolvedSignature(call)?.declaration;
        if (!declaration || !isEngineDeclaration(declaration)) return undefined;
        const engine = this.engine();
        const bodies = engine.bodies(declaration);
        if (!bodies) {
            const access = { reads: emptyStorage(), writes: emptyStorage() };
            touchEverything(access);
            return access;
        }
        let pinned = pinnedOrders.get(engine);
        if (!pinned) {
            pinned = new EvaluationOrder(engine.checker, engine.hierarchy);
            pinnedOrders.set(engine, pinned);
        }
        const summary = pinned.bodyAccess(bodies);
        // The engine's own variables are state only its calls reach: to the
        // scene they are one store with the objects it holds.
        const asScene = (storage: Storage): Storage => ({
            any: storage.any,
            heap: storage.heap || storage.variables.size > 0,
            variables: new Set(),
        });
        return {
            reads: asScene(summary.reads),
            writes: asScene(summary.writes),
        };
    }

    /**
     * A library call reads the objects it is handed and its receiver's
     * state, writes that state through a mutating built-in method, and runs
     * the callbacks it is given.
     */
    private libraryCall(
        access: DirectAccess,
        call: ts.CallExpression | ts.NewExpression,
        unit: Unit | undefined,
    ): void {
        const callee = unwrapExpression(call.expression);
        if (
            ts.isPropertyAccessExpression(callee) &&
            libraryGlobal(this.checker, callee.expression) === undefined &&
            !this.isPrimitive(callee.expression) &&
            !this.isFresh(callee.expression, unit)
        ) {
            access.reads.heap = true;
            if (mutatesReceiver(callee.name.text)) access.writes.heap = true;
        }
        for (const argument of call.arguments ?? []) {
            const expression = unwrapExpression(argument);
            if (
                ts.isArrowFunction(expression) ||
                ts.isFunctionExpression(expression)
            ) {
                access.callees.add(expression);
                continue;
            }
            const type = this.checker.getTypeAtLocation(argument);
            if (type.getCallSignatures().length > 0) {
                // A library function handed on (`map(Number)`) runs as a
                // library call over the values it is given.
                if (this.isRandom(expression)) {
                    access.reads.variables.add(randomState);
                    access.writes.variables.add(randomState);
                    continue;
                }
                const declarations =
                    resolvedSymbol(this.checker, expression)?.declarations ??
                    [];
                if (
                    declarations.length > 0 &&
                    declarations.every(
                        (declaration) =>
                            declaration.getSourceFile().isDeclarationFile,
                    )
                )
                    continue;
                const declaration = this.namedFunction(expression);
                if (declaration) access.callees.add(declaration);
                else touchEverything(access);
                continue;
            }
            if (
                !this.isPrimitive(argument) &&
                !ts.isArrayLiteralExpression(expression) &&
                !ts.isObjectLiteralExpression(expression) &&
                !ts.isNewExpression(expression) &&
                !this.isFresh(expression, unit)
            )
                access.reads.heap = true;
        }
    }

    /**
     * The code a call runs: the function bodies it can reach -- every
     * implementation an overridden method can dispatch to, a constructor
     * chain with its field initializers -- "library" for a declaration
     * file's function, or undefined when it cannot be named.
     */
    private callees(
        call: ts.CallExpression | ts.NewExpression,
    ): readonly Unit[] | "library" | undefined {
        if (call.expression.kind === ts.SyntaxKind.SuperKeyword) {
            const owner = ts.findAncestor(call, ts.isClassDeclaration);
            const base = owner && this.hierarchy.table(owner).base?.declaration;
            return base ? this.construction(base) : undefined;
        }
        if (ts.isNewExpression(call)) {
            const declaration = resolvedSymbol(
                this.checker,
                unwrapExpression(call.expression),
            )?.declarations?.find(ts.isClassDeclaration);
            if (declaration && !declaration.getSourceFile().isDeclarationFile)
                return this.construction(declaration);
            return this.checker
                .getResolvedSignature(call)
                ?.declaration?.getSourceFile().isDeclarationFile || declaration
                ? "library"
                : undefined;
        }
        const declaration =
            this.checker.getResolvedSignature(call)?.declaration;
        if (!declaration) return undefined;
        if (declaration.getSourceFile().isDeclarationFile) return "library";
        const callee = unwrapExpression(call.expression);
        if (ts.isMethodDeclaration(declaration))
            return this.declarationUnits(declaration);
        // A function reached through a variable or a property is that
        // function only while nothing stores another one there.
        if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) {
            const named = this.namedFunction(callee);
            return named ? [named] : undefined;
        }
        return ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)
            ? [callee]
            : undefined;
    }

    /** Whether an expression is the language's `Math.random`. */
    private isRandom(expression: ts.Expression): boolean {
        const node = unwrapExpression(expression);
        return (
            ts.isPropertyAccessExpression(node) &&
            libraryGlobal(this.checker, node.expression) === "Math" &&
            node.name.text === "random"
        );
    }

    /** Whether every value an expression can have is a primitive, which no code can change in place. */
    private isPrimitive(expression: ts.Expression): boolean {
        const type = this.checker.getTypeAtLocation(expression);
        return (type.isUnion() ? type.types : [type]).every(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.NumberLike |
                        ts.TypeFlags.StringLike |
                        ts.TypeFlags.BooleanLike |
                        ts.TypeFlags.BigIntLike |
                        ts.TypeFlags.EnumLike |
                        ts.TypeFlags.Undefined |
                        ts.TypeFlags.Null)) !==
                0,
        );
    }

    /** The function a name always holds: a function declaration, or a never-reassigned `const`. */
    private namedFunction(
        expression: ts.Expression,
    ): ts.FunctionLikeDeclaration | undefined {
        const symbol = resolvedSymbol(
            this.checker,
            unwrapExpression(expression),
        );
        const declaration = symbol?.valueDeclaration;
        if (!symbol || !declaration) return undefined;
        if (ts.isFunctionDeclaration(declaration)) {
            return symbol.declarations?.find(
                (candidate): candidate is ts.FunctionDeclaration =>
                    ts.isFunctionDeclaration(candidate) &&
                    candidate.body !== undefined,
            );
        }
        if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            !this.isWrittenVariable(symbol)
        ) {
            const initializer = unwrapExpression(declaration.initializer);
            if (
                ts.isArrowFunction(initializer) ||
                ts.isFunctionExpression(initializer)
            )
                return initializer;
        }
        return undefined;
    }

    /** The constructors and field initializers `new` of a class runs, or undefined past a non-local base. */
    private construction(
        declaration: ts.ClassDeclaration,
    ): readonly Unit[] | undefined {
        const units: Unit[] = [];
        for (const link of classChain(this.hierarchy.table(declaration))) {
            if (link.unsupportedHeritage) return undefined;
            const constructor = link.constructorDeclaration;
            if (constructor) {
                if (!constructor.body) return undefined;
                units.push(constructor);
            }
            link.fields.forEach((field) => units.push(field));
        }
        return units;
    }

    /**
     * Whether an access chain starts at an object the current run created
     * and nothing else holds yet: a local initialized with a literal or a
     * `new` and never reassigned, or the object a constructor or field
     * initializer is building.
     */
    private isFresh(
        expression: ts.Expression,
        unit: Unit | undefined,
    ): boolean {
        if (!unit) return false;
        const root = accessRoot(expression);
        if (root.kind === ts.SyntaxKind.ThisKeyword)
            return (
                ts.isConstructorDeclaration(unit) ||
                ts.isPropertyDeclaration(unit)
            );
        if (!ts.isIdentifier(root)) return false;
        const symbol = resolvedSymbol(this.checker, root);
        const declaration = symbol?.valueDeclaration;
        if (
            !symbol ||
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !declaration.initializer ||
            this.isWrittenVariable(symbol) ||
            evaluationContainer(declaration) !== unit
        )
            return false;
        const initializer = unwrapExpression(declaration.initializer);
        return (
            ts.isArrayLiteralExpression(initializer) ||
            ts.isObjectLiteralExpression(initializer) ||
            ts.isNewExpression(initializer)
        );
    }

    /** The function whose frame a local variable or parameter lives in. */
    private frameOf(symbol: ts.Symbol): Unit | undefined {
        const declaration = symbol.valueDeclaration;
        if (
            !declaration ||
            !(
                ts.isVariableDeclaration(declaration) ||
                ts.isParameter(declaration)
            )
        )
            return undefined;
        const container = evaluationContainer(declaration);
        return ts.isFunctionLike(container) && "body" in container
            ? container
            : undefined;
    }

    /** Whether any code assigns the variable after its declaration. */
    private isWrittenVariable(symbol: ts.Symbol): boolean {
        if ((symbol.flags & ts.SymbolFlags.Variable) === 0) return false;
        const file = symbol.valueDeclaration?.getSourceFile();
        if (!file) return false;
        let written = this.written.get(file);
        if (!written) {
            const found = new Set<ts.Symbol>();
            const record = (target: ts.Expression): void => {
                const node = unwrapExpression(target);
                if (!ts.isIdentifier(node)) return;
                const assigned = resolvedSymbol(this.checker, node);
                if (assigned) found.add(assigned);
            };
            forEachAnalysisNode(file, (node) => {
                if (isAssignmentExpression(node))
                    assignmentTargets(node.left).forEach(record);
                else if (isUpdateExpression(node)) record(node.operand);
                else loopTargets(node).forEach(record);
            });
            written = found;
            this.written.set(file, written);
        }
        return written.has(symbol);
    }
}

/**
 * An operand read where JavaScript reads it: a value the compiler already
 * knows is that value's literal, anything else a temporary.
 */
export function pinOperand(
    context: Pick<LoweringServices, "bindings"> & ScalarReadContext,
    value: Value,
    node: ts.Expression,
    label: string,
): Value {
    return (
        readScalarOperand(context, value, label) ??
        context.bindings.pinValueToTemporary(value, label, node)
    );
}

type ScalarReadContext = Pick<
    LoweringServices,
    | "cppString"
    | "dataTypes"
    | "allocateTemporaryCppName"
    | "emit"
    | "registerNativeConstBinding"
    | "registerNativeBindingType"
>;

/**
 * A scalar operand read where it stands: its literal when generation knows
 * it, otherwise a constant temporary. Undefined for any other value.
 */
export function readScalarOperand(
    context: ScalarReadContext,
    value: Value,
    label: string,
): Value | undefined {
    if (value.staticNumber !== undefined)
        return { ...value, cpp: doubleLiteral(value.staticNumber) };
    if (value.staticBoolean !== undefined)
        return { ...value, cpp: value.staticBoolean ? "true" : "false" };
    if (value.staticString !== undefined)
        return { ...value, cpp: context.cppString(value.staticString) };
    // A scalar is copied where it stands. Its variable may be written by
    // the later operand, so its binding's own stability cannot stand in
    // for the read.
    const type =
        value.kind === "number"
            ? "double"
            : value.kind === "boolean"
              ? "bool"
              : value.kind === "string"
                ? "std::string"
                : value.kind === "data" &&
                    value.dataType &&
                    ["number", "boolean", "string", "enum"].includes(
                        value.dataType.kind,
                    )
                  ? context.dataTypes.cppType(value.dataType)
                  : undefined;
    if (!type) return undefined;
    const name = context.allocateTemporaryCppName(label);
    context.emit({
        kind: "declaration",
        type: `const ${type}`,
        name,
        initializer: value.cpp,
        attributes: "[[maybe_unused]] ",
    });
    context.registerNativeBindingType(name, `const ${type}`);
    return {
        ...value,
        cpp: name,
        nativeCaptures: [context.registerNativeConstBinding(name)],
        nativeBinding: true,
    };
}
