import { basename } from "node:path";
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import type { DataStructField, DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import type { LibraryGlobal } from "./symbols.js";
import { propertyNameText, unwrapExpression, wrappedParent } from "./syntax.js";
import { declaredContextualType } from "./type-facts.js";
import type { Value } from "./types.js";
import { functionUsesDynamicThis } from "./user-functions.js";

/** An object literal's own method or function-expression property whose body reads `this`. */
export type HomeObjectMethod = ts.MethodDeclaration | ts.FunctionExpression;

/**
 * An object literal's method that reads `this` is called with its home
 * object as receiver as long as its function value never leaves that
 * object: every read of the property is the callee of a member call.
 * These are the program's other reads, which could call it with another
 * receiver (`const f = o.m`, `o.m.call(x)`, `{...o}`, `Object.values(o)`).
 */
interface MethodValueReads {
    /** Property names read as values, with every read of each in program order. */
    readonly named: ReadonlyMap<string, readonly NamedRead[]>;
    /** Objects read wholesale or by a computed key: any property may be read. */
    readonly wholesale: readonly ts.Node[];
}

/** One read of a property's value. */
interface NamedRead {
    readonly node: ts.Node;
    /**
     * What holds the object it reads from: the accessed expression or the
     * destructured binding pattern. A destructuring assignment target names
     * no source, so its reads reach every object.
     */
    readonly object: ts.Node | undefined;
}

/** The program's reads, and the read found for each method name and home type. */
interface ProgramReads {
    readonly reads: MethodValueReads;
    /** The first wholesale read of each object type, in program order. */
    wholesaleTypes?: ReadonlyMap<ts.Type, ts.Node>;
    readonly answers: Map<string, Map<ts.Type | undefined, ts.Node | null>>;
}

/** Library functions that read every own property of an argument. */
const wholesaleReaders: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    [
        "Object",
        new Set([
            "assign",
            "entries",
            "values",
            "getOwnPropertyDescriptor",
            "getOwnPropertyDescriptors",
        ]),
    ],
    ["Reflect", new Set(["get", "getOwnPropertyDescriptor", "apply"])],
]);

/** Reads are a function of the program, so they outlive any emission transaction. */
const programReads = new WeakMap<ts.Program, ProgramReads>();

/** Whether a member read is a call's callee, a write target or a `typeof`/`delete` operand. */
function readsOnlyAsMember(access: ts.Expression): boolean {
    const parent = wrappedParent(access);
    return (
        (ts.isCallExpression(parent) &&
            unwrapExpression(parent.expression) === access) ||
        (ts.isTaggedTemplateExpression(parent) &&
            unwrapExpression(parent.tag) === access) ||
        (ts.isBinaryExpression(parent) &&
            unwrapExpression(parent.left) === access &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
        ts.isDeleteExpression(parent) ||
        ts.isTypeOfExpression(parent)
    );
}

/** The property names a destructuring assignment target reads. */
function assignmentPatternNames(
    pattern: ts.Expression,
    names: (name: string, node: ts.Node) => void,
): void {
    const target = unwrapExpression(pattern);
    if (ts.isArrayLiteralExpression(target)) {
        for (const element of target.elements)
            assignmentPatternNames(
                ts.isSpreadElement(element) ? element.expression : element,
                names,
            );
        return;
    }
    if (!ts.isObjectLiteralExpression(target)) return;
    for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property))
            names(property.name.text, property);
        else if (ts.isPropertyAssignment(property)) {
            const name = propertyNameText(property.name);
            if (name !== undefined) names(name, property);
            assignmentPatternNames(property.initializer, names);
        }
    }
}

function collectReads(
    program: ts.Program,
    libraryGlobal: LibraryGlobal,
): MethodValueReads {
    const named = new Map<string, NamedRead[]>();
    const wholesale: ts.Node[] = [];
    const read = (name: string, node: ts.Node, object?: ts.Node): void => {
        const reads = named.get(name);
        if (reads) reads.push({ node, object });
        else named.set(name, [{ node, object }]);
    };
    for (const file of program.getSourceFiles()) {
        if (file.isDeclarationFile) continue;
        forEachAnalysisNode(
            file,
            (node) => {
                if (ts.isPropertyAccessExpression(node)) {
                    if (!readsOnlyAsMember(node))
                        read(node.name.text, node, node.expression);
                } else if (ts.isElementAccessExpression(node)) {
                    const key = node.argumentExpression;
                    if (
                        ts.isStringLiteralLike(key) ||
                        ts.isNumericLiteral(key)
                    ) {
                        if (!readsOnlyAsMember(node))
                            read(key.text, node, node.expression);
                    } else wholesale.push(node.expression);
                } else if (ts.isBindingElement(node)) {
                    if (ts.isObjectBindingPattern(node.parent)) {
                        const name = node.dotDotDotToken
                            ? undefined
                            : node.propertyName
                              ? propertyNameText(node.propertyName)
                              : ts.isIdentifier(node.name)
                                ? node.name.text
                                : undefined;
                        if (name !== undefined) read(name, node, node.parent);
                        else wholesale.push(node.parent);
                    }
                } else if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ) {
                    assignmentPatternNames(node.left, read);
                } else if (ts.isSpreadAssignment(node)) {
                    wholesale.push(node.expression);
                } else if (
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression)
                ) {
                    const owner = libraryGlobal(node.expression.expression);
                    if (
                        owner !== undefined &&
                        wholesaleReaders
                            .get(owner)
                            ?.has(node.expression.name.text) === true
                    )
                        wholesale.push(
                            ...node.arguments.filter(
                                (argument) => !ts.isSpreadElement(argument),
                            ),
                        );
                }
            },
            { types: "skip" },
        );
    }
    return { named, wholesale };
}

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
    context: Pick<LoweringServices, "program" | "checker" | "libraryGlobal">,
    name: string,
    home: ts.Type | undefined,
): ts.Node | undefined {
    const { checker } = context;
    let state = programReads.get(context.program);
    if (!state) {
        state = {
            reads: collectReads(context.program, (expression) =>
                context.libraryGlobal(expression),
            ),
            answers: new Map(),
        };
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
            for (const node of state.reads.wholesale) {
                const type = checker.getTypeAtLocation(node);
                if (!types.has(type)) types.set(type, node);
            }
            state.wholesaleTypes = types;
        }
        answer =
            state.reads.named
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

/** An object literal's own method or function-expression property whose body reads `this`. */
export function readsHomeObject(node: ts.Node): node is HomeObjectMethod {
    let owner: ts.Node = node.parent;
    if (ts.isFunctionExpression(node)) {
        owner = wrappedParent(node);
        if (!ts.isPropertyAssignment(owner)) return false;
        owner = owner.parent;
    } else if (!ts.isMethodDeclaration(node)) return false;
    return ts.isObjectLiteralExpression(owner) && functionUsesDynamicThis(node);
}

/** A literal's own methods reading `this`, by property name. */
export function homeObjectMethods(
    literal: ts.ObjectLiteralExpression,
): ReadonlyMap<string, HomeObjectMethod> {
    const methods = new Map<string, HomeObjectMethod>();
    for (const property of literal.properties) {
        const method = ts.isPropertyAssignment(property)
            ? unwrapExpression(property.initializer)
            : property;
        const name =
            property.name === undefined
                ? undefined
                : propertyNameText(property.name);
        if (name !== undefined && readsHomeObject(method))
            methods.set(name, method);
    }
    return methods;
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
 * its methods capture it: the `this` of its own methods reading `this`,
 * and the value of the binding it initializes when its methods name that
 * binding. The literal's fields are stored into it once lowered.
 */
export interface LiteralSelf {
    readonly value: Value;
    readonly methods: ReadonlyMap<string, HomeObjectMethod>;
}

/**
 * The self object of a struct built from an object literal (`node`), or
 * undefined when nothing in the literal reaches it. A method whose function
 * value never leaves its object is only called as a member of that object,
 * so `this` is the object the literal creates; any read of the value from
 * an object that can hold it refuses.
 */
export function literalSelf(
    context: Pick<
        LoweringServices,
        | "program"
        | "checker"
        | "libraryGlobal"
        | "fail"
        | "dataTypes"
        | "allocateTemporaryCppName"
        | "reachJsData"
        | "emit"
        | "registerNativeBinding"
        | "bindings"
    >,
    dataType: DataType<"struct">,
    methods: ReadonlyMap<string, HomeObjectMethod>,
    node: ts.Node,
): LiteralSelf | undefined {
    const literal = ts.isExpression(node) ? unwrapExpression(node) : undefined;
    const binding =
        literal && ts.isObjectLiteralExpression(literal)
            ? selfBindings.get(literal)
            : undefined;
    if (!methods.size && !binding) return undefined;
    if (!context.dataTypes.isReferenceStruct(dataType.name))
        context.fail(
            node,
            "An object literal method reading `this` requires shared native object storage.",
        );
    for (const [name, method] of methods) {
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
    return { value, methods };
}

/** The receiver a literal's method `name` is lowered with: its self object when it is that method. */
export function homeReceiver(
    self: LiteralSelf | undefined,
    name: string,
    method: ts.Node,
): Value | undefined {
    return self?.methods.get(name) === method ? self.value : undefined;
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
