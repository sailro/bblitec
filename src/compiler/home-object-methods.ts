import { basename } from "node:path";
import ts from "typescript";
import type { DataStructField, DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import { programObservations } from "./program-observations.js";
import { propertyNameText, unwrapExpression, wrappedParent } from "./syntax.js";
import { declaredContextualType } from "./type-facts.js";
import type { Value } from "./types.js";
import { functionUsesDynamicThis } from "./user-functions.js";

/** An object literal's own method or function-expression property whose body reads `this`. */
type HomeObjectMethod = ts.MethodDeclaration | ts.FunctionExpression;

/** An object literal's own method, function-expression property or accessor whose body reads `this`. */
type HomeObjectMember = HomeObjectMethod | ts.AccessorDeclaration;

/**
 * An object literal's method that reads `this` is called with its home
 * object as receiver as long as its function value never leaves that
 * object: every read of the property is the callee of a member call. The
 * program's other reads (`ProgramObservations.namedReads` and
 * `wholesaleReads`: `const f = o.m`, `o.m.call(x)`, `{...o}`,
 * `Object.values(o)`) could call it with another receiver.
 */
interface ProgramReads {
    /** The first wholesale read of each object type, in program order. */
    wholesaleTypes?: ReadonlyMap<ts.Type, ts.Node>;
    readonly answers: Map<string, Map<ts.Type | undefined, ts.Node | null>>;
}

/** Reads are a function of the program, so they outlive any emission transaction. */
const programReads = new WeakMap<ts.Program, ProgramReads>();

/**
 * Whether an object of type `objectType` can be the home object of method
 * `name`: some member of the type declares the property and accepts the
 * home object's declared type. Without a declared home type, every object
 * declaring the property can be it.
 */
function mayHoldMethod(
    checker: ts.TypeChecker,
    objectType: ts.Type,
    name: string,
    home: ts.Type | undefined,
): boolean {
    return (objectType.isUnion() ? objectType.types : [objectType]).some(
        (member) => {
            if (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
                return true;
            const apparent = checker.getApparentType(member);
            return (
                checker.getPropertyOfType(apparent, name) !== undefined &&
                (home === undefined ||
                    checker.isTypeAssignableTo(home, apparent))
            );
        },
    );
}

/**
 * The type every place a literal's object flows to accepts: the one object
 * type its position declares. A literal typed by inference or only checked
 * by `satisfies` keeps its own literal type, which a narrower type does not
 * accept while it is fresh, so it has none.
 */
function homeObjectType(
    checker: ts.TypeChecker,
    method: HomeObjectMethod,
): ts.Type | undefined {
    const literal = ts.isMethodDeclaration(method)
        ? method.parent
        : wrappedParent(method).parent;
    if (!ts.isObjectLiteralExpression(literal)) return undefined;
    for (
        let wrapper: ts.Node = literal.parent;
        ts.isParenthesizedExpression(wrapper) ||
        ts.isSatisfiesExpression(wrapper);
        wrapper = wrapper.parent
    )
        if (ts.isSatisfiesExpression(wrapper)) return undefined;
    const declared = declaredContextualType(checker, literal);
    const type = declared && checker.getNonNullableType(declared);
    return type &&
        !type.isUnion() &&
        (type.flags & ts.TypeFlags.Object) !== 0 &&
        ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.ObjectLiteral) ===
            0
        ? type
        : undefined;
}

/**
 * The first place the program could read method `name`'s function value
 * from an object that can hold it rather than call it through that object,
 * or undefined when there is none. Answers are kept per method name and
 * home type; wholesale reads are tested once per object type.
 */
function methodValueRead(
    context: Pick<LoweringServices, "program" | "checker">,
    name: string,
    home: ts.Type | undefined,
): ts.Node | undefined {
    const { checker } = context;
    const reads = programObservations(context.program);
    let state = programReads.get(context.program);
    if (!state) {
        state = { answers: new Map() };
        programReads.set(context.program, state);
    }
    let answers = state.answers.get(name);
    if (!answers) {
        answers = new Map<ts.Type | undefined, ts.Node | null>();
        state.answers.set(name, answers);
    }
    let answer = answers.get(home);
    if (answer === undefined) {
        const held = new Map<ts.Type, boolean>();
        const mayHold = (type: ts.Type): boolean => {
            let holds = held.get(type);
            if (holds === undefined) {
                holds = mayHoldMethod(checker, type, name, home);
                held.set(type, holds);
            }
            return holds;
        };
        if (!state.wholesaleTypes) {
            const types = new Map<ts.Type, ts.Node>();
            for (const node of reads.wholesaleReads) {
                const type = checker.getTypeAtLocation(node);
                if (!types.has(type)) types.set(type, node);
            }
            state.wholesaleTypes = types;
        }
        answer =
            reads.namedReads
                .get(name)
                ?.find(
                    ({ object }) =>
                        object === undefined ||
                        mayHold(checker.getTypeAtLocation(object)),
                )?.node ??
            [...state.wholesaleTypes].find(([type]) => mayHold(type))?.[1] ??
            null;
        answers.set(home, answer);
    }
    return answer ?? undefined;
}

/**
 * An object literal's own method, function-expression property or accessor
 * whose body reads `this`. A property read or write runs an accessor with
 * the object holding it as receiver, and no lowered form hands its
 * function out, so its `this` is the object the literal creates (a Proxy
 * target's accessors take their receiver instead).
 */
function readsHomeObject(node: ts.Node | undefined): node is HomeObjectMember {
    if (node === undefined) return false;
    let owner: ts.Node = node.parent;
    if (ts.isFunctionExpression(node)) {
        owner = wrappedParent(node);
        if (!ts.isPropertyAssignment(owner)) return false;
        owner = owner.parent;
    } else if (
        !ts.isMethodDeclaration(node) &&
        !ts.isGetAccessorDeclaration(node) &&
        !ts.isSetAccessorDeclaration(node)
    )
        return false;
    return ts.isObjectLiteralExpression(owner) && functionUsesDynamicThis(node);
}

/** A literal's own members reading `this`, keyed by node. */
export function homeObjectMembers(
    literal: ts.ObjectLiteralExpression,
): ReadonlySet<HomeObjectMember> {
    return new Set(
        literal.properties
            .map((property) =>
                ts.isPropertyAssignment(property)
                    ? unwrapExpression(property.initializer)
                    : property,
            )
            .filter(readsHomeObject),
    );
}

/**
 * The property name a home-object method is stored under: its literal
 * name, or the literal type of its computed key.
 */
function methodName(
    checker: ts.TypeChecker,
    method: HomeObjectMethod,
): string | undefined {
    const property = ts.isMethodDeclaration(method)
        ? method
        : wrappedParent(method);
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property))
        return undefined;
    if (!ts.isComputedPropertyName(property.name))
        return propertyNameText(property.name);
    const key = checker.getTypeAtLocation(property.name.expression);
    return key.isStringLiteral() || key.isNumberLiteral()
        ? String(key.value)
        : undefined;
}

/**
 * The binding a declaration hands the object literal it is initialized
 * with, while that literal is lowered: the literal's methods name it, so
 * the literal binds it to the object it creates before they capture it.
 */
interface SelfBinding {
    readonly name: ts.Identifier;
    readonly cppName: string;
}

/** Requests live only while their declaration lowers its initializer. */
const selfBindings = new WeakMap<ts.ObjectLiteralExpression, SelfBinding>();

/**
 * Lowers a declaration's initializer while its object literal binds the
 * declared name to the object it creates (see {@link literalSelf}).
 */
export function withLiteralSelfBinding<T>(
    literal: ts.ObjectLiteralExpression,
    binding: SelfBinding,
    lower: () => T,
): T {
    selfBindings.set(literal, binding);
    try {
        return lower();
    } finally {
        selfBindings.delete(literal);
    }
}

/**
 * The object an object literal creates, allocated before the closures of
 * its methods and accessors capture it: the `this` of its own methods and
 * accessors reading `this`, and the value of the binding it initializes
 * when its methods name that binding. The literal's fields are stored into
 * it once lowered.
 */
export interface LiteralSelf {
    readonly value: Value;
    /** The literal's members reading `this` as this object. */
    readonly members: ReadonlySet<HomeObjectMember>;
}

/**
 * The self object of a struct built from an object literal (`node`), or
 * undefined when nothing in the literal reaches it: the members the struct
 * lowers into its slots (`lowered`) that read `this` as their home object,
 * or a binding the literal initializes. A method whose function value never
 * leaves its object is only called as a member of that object, so `this` is
 * the object the literal creates; any read of the value from an object that
 * can hold it refuses.
 */
export function literalSelf(
    context: Pick<
        LoweringServices,
        | "program"
        | "checker"
        | "fail"
        | "dataTypes"
        | "allocateTemporaryCppName"
        | "reachJsData"
        | "emit"
        | "registerNativeBinding"
        | "bindings"
    >,
    dataType: DataType<"struct">,
    lowered: Iterable<ts.Node | undefined>,
    node: ts.Node,
): LiteralSelf | undefined {
    const literal = ts.isExpression(node) ? unwrapExpression(node) : undefined;
    const binding =
        literal && ts.isObjectLiteralExpression(literal)
            ? selfBindings.get(literal)
            : undefined;
    const members = new Set([...lowered].filter(readsHomeObject));
    if (!members.size && !binding) return undefined;
    const methods = [...members].filter(
        (member): member is HomeObjectMethod => !ts.isAccessor(member),
    );
    if (!context.dataTypes.isReferenceStruct(dataType.name))
        context.fail(
            node,
            `An object literal ${methods.length || !members.size ? "method" : "accessor"} reading \`this\` requires shared native object storage.`,
        );
    for (const method of methods) {
        const name = methodName(context.checker, method);
        if (name === undefined)
            context.fail(
                method,
                "A method reading `this` needs a literal or literal-typed property name.",
            );
        const read = methodValueRead(
            context,
            name,
            homeObjectType(context.checker, method),
        );
        if (!read) continue;
        const file = read.getSourceFile();
        const line = file.getLineAndCharacterOfPosition(read.getStart()).line;
        context.fail(
            method,
            `Method '${name}' reads \`this\`, and ${basename(file.fileName)}:${line + 1} reads its function value, which could call it with another receiver.`,
        );
    }
    const cpp =
        binding?.cppName ?? context.allocateTemporaryCppName("home_object");
    const cppType = context.dataTypes.cppType(dataType);
    context.reachJsData();
    context.emit({
        kind: "declaration",
        type: "auto",
        name: cpp,
        initializer: `bbl::js::make_ref<bblscene::${dataType.name}Data>()`,
    });
    const value: Value = {
        kind: "data",
        cpp,
        dataType,
        nativeCaptures: [
            context.registerNativeBinding(cpp, false, false, cppType),
        ],
    };
    if (binding) context.bindings.defineVariable(binding.name, value);
    return { value, members };
}

/**
 * The receiver a literal's method or accessor is lowered with: its self
 * object when it is one of the literal's members reading `this`.
 */
export function homeReceiver(
    self: LiteralSelf | undefined,
    member: ts.Node,
): Value | undefined {
    if (!self) return undefined;
    const members: ReadonlySet<ts.Node> = self.members;
    return members.has(member) ? self.value : undefined;
}

/**
 * Stores a literal's lowered fields (`aggregate`, its `Data` record) into
 * its self object, which is the literal's value.
 */
export function completeLiteralSelf(
    context: Pick<LoweringServices, "emit">,
    self: LiteralSelf,
    aggregate: string,
    fields: readonly DataStructField[],
): string {
    const cpp = self.value.cpp;
    context.emit({ kind: "expression", code: `*${cpp} = ${aggregate};` });
    // Accessor slots bind to the record that holds them.
    if (fields.some((field) => field.accessorReceiver))
        context.emit({
            kind: "expression",
            code: `${cpp}->bind_accessors(${cpp});`,
        });
    return cpp;
}
