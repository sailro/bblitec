import ts from "typescript";
import {
    forEachAnalysisNode,
    someAnalysisNode,
    sourceFileNodes,
} from "./analysis-walk.js";
import {
    accessedPropertySymbol,
    calledDeclaration,
    declaredInDefaultLibrary,
    declaredSymbol,
    namedMember,
    resolvedSymbol,
    staticPropertyKey,
    type NamedMember,
} from "./symbols.js";
import { ERROR_CONSTRUCTORS } from "./error-values.js";
import { unionMembers } from "./type-facts.js";
import {
    unwrapExpression,
    wrappedParent,
    expressionHasEffects,
    variableKind,
    classBaseExpression,
    bindingElementKey,
    outermostWrapper,
} from "./syntax.js";

/**
 * The local class a name's symbol declares: a class declaration, or a
 * `const` the program binds to a class expression (`const K = class {}`).
 */
export function localClassOfSymbol(
    symbol: ts.Symbol | undefined,
): ts.ClassLikeDeclaration | undefined {
    for (const declaration of symbol?.declarations ?? []) {
        if (ts.isClassLike(declaration)) return declaration;
        const initializer =
            ts.isVariableDeclaration(declaration) &&
            ts.isVariableDeclarationList(declaration.parent) &&
            variableKind(declaration.parent) === "const" &&
            declaration.initializer
                ? unwrapExpression(declaration.initializer)
                : undefined;
        if (initializer && ts.isClassExpression(initializer))
            return initializer;
    }
    return undefined;
}

/**
 * The names a class binds: its own, and for a class expression the `const`
 * it initializes (the name the class's static members are read through).
 */
export function classBindingNames(
    declaration: ts.ClassLikeDeclaration,
): ts.Identifier[] {
    const parent = ts.isClassExpression(declaration)
        ? wrappedParent(declaration)
        : undefined;
    const bound =
        parent &&
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name)
            ? parent.name
            : undefined;
    return [
        ...(bound ? [bound] : []),
        ...(declaration.name ? [declaration.name] : []),
    ];
}

/** Instance fields include the properties declared by constructor parameters. */
export function classInstanceProperties(
    declaration: ts.ClassLikeDeclaration,
): (ts.PropertyDeclaration | ts.ParameterDeclaration)[] {
    return declaration.members.flatMap<
        ts.PropertyDeclaration | ts.ParameterDeclaration
    >((member) => {
        if (ts.isPropertyDeclaration(member) && !isStaticMember(member))
            return [member];
        if (ts.isConstructorDeclaration(member))
            return member.parameters.filter((parameter) =>
                ts.isParameterPropertyDeclaration(parameter, member),
            );
        return [];
    });
}

/** A class body's own instance property declarations, named plainly. */
export type InstanceProperty = (
    ts.PropertyDeclaration | ts.ParameterDeclaration
) & {
    name: ts.MemberName;
};

/** One `static` field or `static { ... }` block, in class evaluation order. */
type StaticElement =
    | (ts.PropertyDeclaration & { name: ts.MemberName })
    | ts.ClassStaticBlockDeclaration;

/**
 * One class body's members by name, resolved once per declaration, linked to
 * the class it extends.
 *
 * Every lookup of a class member by name reads this table, so a method,
 * accessor or field is found by one rule: instance and static members are
 * separate namespaces, as they are in JavaScript, an overloaded name
 * resolves to the declaration that carries the body, and an inherited name
 * resolves through `base` exactly as the prototype chain does
 * (`classMethod`, `classAccessors`, `classChain`).
 */
export interface ClassMemberTable {
    readonly declaration: ts.ClassLikeDeclaration;
    /** The local class this one extends. */
    readonly base: ClassMemberTable | undefined;
    /** An `extends` clause naming something other than a local class. */
    readonly unsupportedHeritage: ts.ExpressionWithTypeArguments | undefined;
    readonly errorBase: string | undefined;
    /** The constructor implementation, or its only declaration. */
    readonly constructorDeclaration: ts.ConstructorDeclaration | undefined;
    readonly methods: ReadonlyMap<string, ts.MethodDeclaration>;
    readonly staticMethods: ReadonlyMap<string, ts.MethodDeclaration>;
    readonly getters: Readonly<Record<string, ts.GetAccessorDeclaration>>;
    readonly setters: Readonly<Record<string, ts.SetAccessorDeclaration>>;
    /** Instance property declarations, in declaration order. */
    readonly fields: ReadonlyMap<string, ts.PropertyDeclaration>;
    /** Instance properties including constructor parameter properties, in order. */
    readonly instanceProperties: readonly InstanceProperty[];
    /** `static readonly` properties with an initializer: generation-time constants. */
    readonly staticConstants: ReadonlyMap<string, ts.PropertyDeclaration>;
    /** Every other static field: storage the class declaration initializes. */
    readonly staticFields: ReadonlyMap<
        string,
        ts.PropertyDeclaration & { name: ts.MemberName }
    >;
    /** Static fields with storage and static blocks, in evaluation order. */
    readonly staticElements: readonly StaticElement[];
}

/** Tables are pure functions of the program, so they outlive any emission transaction. */
const classMemberTables = new WeakMap<
    ts.ClassLikeDeclaration,
    ClassMemberTable
>();

export function isStaticMember(member: ts.ClassElement): boolean {
    return (
        (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0
    );
}

function isAbstractClass(declaration: ts.ClassLikeDeclaration): boolean {
    return (
        (ts.getCombinedModifierFlags(declaration) &
            ts.ModifierFlags.Abstract) !==
        0
    );
}

/** A static property the program folds from its initializer at generation. */
/**
 * Whether a static field reads as its initializer wherever it is read: it
 * is readonly, and evaluating the initializer again changes nothing and
 * builds no fresh object (`next++`, `[]` or a function make it a field the
 * class definition evaluates once).
 */
function isStaticConstant(member: ts.PropertyDeclaration): boolean {
    const initializer = member.initializer;
    return (
        initializer !== undefined &&
        (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Readonly) !==
            0 &&
        !expressionHasEffects(initializer) &&
        !someAnalysisNode(
            initializer,
            (node) =>
                ts.isArrayLiteralExpression(node) ||
                ts.isObjectLiteralExpression(node) ||
                ts.isRegularExpressionLiteral(node) ||
                ts.isFunctionLike(node) ||
                ts.isClassLike(node),
        )
    );
}

/** Keeps the implementation of an overloaded name: the declaration with a body. */
function recordImplementation<T extends ts.FunctionLikeDeclaration>(
    members: Map<string, T>,
    name: string,
    member: T,
): void {
    const existing = members.get(name);
    if (!existing || (!existing.body && member.body)) {
        members.set(name, member);
    }
}

/** The local class an `extends` clause names, or the clause when it names something else. */
function resolveHeritage(
    checker: ts.TypeChecker,
    declaration: ts.ClassLikeDeclaration,
):
    | { base: ts.ClassLikeDeclaration }
    | { unsupported: ts.ExpressionWithTypeArguments }
    | { errorBase: string }
    | undefined {
    const heritage = classBaseExpression(declaration);
    if (!heritage) return undefined;
    const symbol = resolvedSymbol(checker, heritage.expression);
    if (
        symbol &&
        declaredInDefaultLibrary(symbol) &&
        ERROR_CONSTRUCTORS.has(symbol.name)
    )
        return { errorBase: symbol.name };
    const base = localClassOfSymbol(symbol);
    return base &&
        !base.getSourceFile().isDeclarationFile &&
        (ts.getCombinedModifierFlags(base) & ts.ModifierFlags.Ambient) === 0
        ? { base }
        : { unsupported: heritage };
}

export function classMemberTable(
    checker: ts.TypeChecker,
    declaration: ts.ClassLikeDeclaration,
): ClassMemberTable {
    const cached = classMemberTables.get(declaration);
    if (cached) return cached;
    let constructorDeclaration: ts.ConstructorDeclaration | undefined;
    const methods = new Map<string, ts.MethodDeclaration>();
    const staticMethods = new Map<string, ts.MethodDeclaration>();
    const getters: Record<string, ts.GetAccessorDeclaration> = {};
    const setters: Record<string, ts.SetAccessorDeclaration> = {};
    const fields = new Map<string, ts.PropertyDeclaration>();
    const staticConstants = new Map<string, ts.PropertyDeclaration>();
    const staticFields = new Map<
        string,
        ts.PropertyDeclaration & { name: ts.MemberName }
    >();
    const staticElements: StaticElement[] = [];
    for (const member of declaration.members) {
        if (ts.isConstructorDeclaration(member)) {
            if (
                !constructorDeclaration ||
                (!constructorDeclaration.body && member.body)
            ) {
                constructorDeclaration = member;
            }
            continue;
        }
        if (ts.isClassStaticBlockDeclaration(member)) {
            staticElements.push(member);
            continue;
        }
        // A method or accessor is keyed as its name declares it: `"a-b"()`,
        // `1()`, `*[Symbol.iterator]()`. A field the class layout cannot
        // name (computed or quoted) is refused there.
        const name = !member.name
            ? undefined
            : ts.isPropertyDeclaration(member) && !ts.isMemberName(member.name)
              ? undefined
              : staticPropertyKey(checker, member.name);
        if (name === undefined) continue;
        if (ts.isMethodDeclaration(member)) {
            recordImplementation(
                isStaticMember(member) ? staticMethods : methods,
                name,
                member,
            );
        } else if (isStaticMember(member)) {
            if (!ts.isPropertyDeclaration(member)) continue;
            const named = member as ts.PropertyDeclaration & {
                name: ts.MemberName;
            };
            if (isStaticConstant(member)) {
                if (!staticConstants.has(name))
                    staticConstants.set(name, member);
            } else if (!staticFields.has(name)) {
                staticFields.set(name, named);
                staticElements.push(named);
            }
        } else if (ts.isGetAccessorDeclaration(member)) {
            getters[name] = member;
        } else if (ts.isSetAccessorDeclaration(member)) {
            setters[name] = member;
        } else if (ts.isPropertyDeclaration(member) && !fields.has(name)) {
            fields.set(name, member);
        }
    }
    const heritage = resolveHeritage(checker, declaration);
    const table: ClassMemberTable = {
        declaration,
        base:
            heritage && "base" in heritage
                ? classMemberTable(checker, heritage.base)
                : undefined,
        unsupportedHeritage:
            heritage && "unsupported" in heritage
                ? heritage.unsupported
                : undefined,
        errorBase:
            heritage && "errorBase" in heritage
                ? heritage.errorBase
                : undefined,
        constructorDeclaration,
        methods,
        staticMethods,
        getters,
        setters,
        fields,
        instanceProperties: classInstanceProperties(declaration).filter(
            (member): member is InstanceProperty =>
                ts.isMemberName(member.name),
        ),
        staticConstants,
        staticFields,
        staticElements,
    };
    classMemberTables.set(declaration, table);
    return table;
}

export function classErrorBase(table: ClassMemberTable): string | undefined {
    return (
        table.errorBase ?? (table.base ? classErrorBase(table.base) : undefined)
    );
}

/**
 * Whether evaluating the class declaration runs or stores anything: its own
 * static blocks, or static field storage it declares or inherits.
 */
export function classHasStaticState(
    checker: ts.TypeChecker,
    declaration: ts.ClassLikeDeclaration,
): boolean {
    return classChain(classMemberTable(checker, declaration)).some(
        (link, index) =>
            (index === 0 && link.staticElements.length > 0) ||
            link.staticFields.size > 0,
    );
}

/** The class and every class it extends, most derived first. */
export function classChain(table: ClassMemberTable): ClassMemberTable[] {
    const chain: ClassMemberTable[] = [];
    for (
        let current: ClassMemberTable | undefined = table;
        current;
        current = current.base
    ) {
        chain.push(current);
    }
    return chain;
}

/**
 * The names an instance of `table`'s class inherits from its prototype
 * chain: its classes' methods and accessors (fields are own properties).
 */
export function classPrototypeKeys(table: ClassMemberTable): Set<string> {
    const keys = new Set<string>();
    for (const link of classChain(table))
        for (const name of [
            ...link.methods.keys(),
            ...Object.keys(link.getters),
            ...Object.keys(link.setters),
        ])
            keys.add(name);
    return keys;
}

/** Whether `table`'s class is `ancestor` or extends it. */
export function classExtends(
    table: ClassMemberTable,
    ancestor: ts.ClassLikeDeclaration,
): boolean {
    return classChain(table).some((link) => link.declaration === ancestor);
}

/**
 * The method an instance of `table`'s class runs for `name`: the nearest
 * declaration with a body, as the prototype chain resolves it. An abstract
 * or bodiless declaration answers only when nothing in the chain implements
 * the name, so a caller reports the missing body rather than a missing name.
 */
export function classMethod(
    table: ClassMemberTable,
    name: string,
): ts.MethodDeclaration | undefined {
    let declared: ts.MethodDeclaration | undefined;
    for (const link of classChain(table)) {
        const method = link.methods.get(name);
        if (method?.body) return method;
        declared ??= method;
    }
    return declared;
}

/** The `[Symbol.iterator]` method an instance of `table`'s class sees. */
export function classIteratorMethod(
    checker: ts.TypeChecker,
    table: ClassMemberTable,
): ts.MethodDeclaration | undefined {
    for (const link of classChain(table))
        for (const method of link.methods.values()) {
            const name = method.name;
            if (
                ts.isComputedPropertyName(name) &&
                ts.isPropertyAccessExpression(name.expression) &&
                name.expression.name.text === "iterator" &&
                ts.isIdentifier(name.expression.expression) &&
                name.expression.expression.text === "Symbol" &&
                declaredInDefaultLibrary(
                    resolvedSymbol(checker, name.expression.expression),
                )
            )
                return method;
        }
    return undefined;
}

/**
 * The accessors an instance of `table`'s class sees: the nearest class that
 * declares either half of a name owns both halves, as a property descriptor
 * does, so a getter-only override hides the base setter.
 */
export function classAccessors(table: ClassMemberTable): {
    getters: Record<string, ts.GetAccessorDeclaration>;
    setters: Record<string, ts.SetAccessorDeclaration>;
} {
    const getters: Record<string, ts.GetAccessorDeclaration> = {};
    const setters: Record<string, ts.SetAccessorDeclaration> = {};
    for (const link of classChain(table).reverse()) {
        for (const name of [
            ...Object.keys(link.getters),
            ...Object.keys(link.setters),
        ]) {
            delete getters[name];
            delete setters[name];
        }
        Object.assign(getters, link.getters);
        Object.assign(setters, link.setters);
    }
    return { getters, setters };
}

/**
 * Instance properties of the whole chain, base class first. A property a
 * subclass redeclares is the base's property -- one JavaScript property --
 * so only its first declaration is listed.
 */
export function classChainInstanceProperties(
    table: ClassMemberTable,
): InstanceProperty[] {
    const seen = new Set<string>();
    const properties: InstanceProperty[] = [];
    for (const link of classChain(table).reverse()) {
        for (const property of link.instanceProperties) {
            if (seen.has(property.name.text)) continue;
            seen.add(property.name.text);
            properties.push(property);
        }
    }
    return properties;
}

/** A constructor's direct write of one of its parameters to a field. */
export interface ConstructorFieldParameter {
    readonly field: string;
    readonly parameter: number;
    readonly assignment: ts.BinaryExpression;
    readonly statement: ts.ExpressionStatement;
}

/**
 * The constructor's top-level `this.field = parameter` statements, in
 * source order, each with its parameter's index.
 */
export function constructorFieldParameters(
    constructorDeclaration: ts.ConstructorDeclaration,
): readonly ConstructorFieldParameter[] {
    const parameters = new Map<string, number>();
    constructorDeclaration.parameters.forEach((parameter, index) => {
        if (ts.isIdentifier(parameter.name))
            parameters.set(parameter.name.text, index);
    });
    const writes: ConstructorFieldParameter[] = [];
    for (const statement of constructorDeclaration.body?.statements ?? []) {
        if (!ts.isExpressionStatement(statement)) continue;
        const assignment = unwrapExpression(statement.expression);
        if (
            !ts.isBinaryExpression(assignment) ||
            assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !ts.isPropertyAccessExpression(assignment.left) ||
            assignment.left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
            !ts.isIdentifier(assignment.left.name) ||
            !ts.isIdentifier(assignment.right)
        )
            continue;
        const parameter = parameters.get(assignment.right.text);
        if (parameter !== undefined)
            writes.push({
                field: assignment.left.name.text,
                parameter,
                assignment,
                statement,
            });
    }
    return writes;
}

/** The class whose constructor runs for `new` of `table`'s class, following implicit constructors. */
export function effectiveConstructor(
    table: ClassMemberTable,
): ts.ConstructorDeclaration | undefined {
    for (const link of classChain(table)) {
        if (link.constructorDeclaration) return link.constructorDeclaration;
    }
    return undefined;
}

/**
 * The class a static member access `Owner.name` reads, with the member's
 * name, resolved by the checker so imports, aliases and inherited statics
 * resolve as TypeScript resolves them. The owner must be a plain name: a
 * static member read through `this` is not this shape.
 */
export function staticClassMember(
    checker: ts.TypeChecker,
    owner: ts.Expression,
    access: NamedMember,
): { table: ClassMemberTable; name: string } | undefined {
    if (!ts.isIdentifier(owner)) return undefined;
    const member = accessedPropertySymbol(
        checker,
        access.access,
    )?.declarations?.find(
        (candidate): candidate is ts.ClassElement =>
            ts.isClassElement(candidate) &&
            ts.isClassLike(candidate.parent) &&
            isStaticMember(candidate),
    );
    if (!member || !ts.isClassLike(member.parent)) return undefined;
    return {
        table: classMemberTable(checker, member.parent),
        name: access.name,
    };
}

/** Methods the language calls on any object it is handed, by name. */
const LANGUAGE_PROTOCOL_METHODS: ReadonlySet<string> = new Set([
    "handleEvent",
    "next",
    "return",
    "then",
    "throw",
    "toJSON",
    "toLocaleString",
    "toString",
    "valueOf",
]);

/** A key only the run time knows, read by an assignment pattern. */
const RUN_TIME_KEY = "\0run-time key";

/** Every member use of a program, by the name it reads. */
interface MemberUses {
    /** Member calls, with their receiver. */
    readonly calls: Map<
        string,
        { readonly call: ts.CallExpression; readonly receiver: ts.Node }[]
    >;
    /** Members read as values, by receiver (a pattern's source). */
    readonly values: Map<string, ts.Node[]>;
    /** Receivers of a member read by a key only the run time knows. */
    readonly dynamic: ts.Node[];
    /** Keys an assignment pattern reads, whatever it reads them from. */
    readonly patternKeys: Set<string>;
    /**
     * Values handed to library code: an argument of a declaration file's
     * function (a literal's members included) or a value stored into a
     * property it declares.
     */
    readonly sinks: ts.Expression[];
}

/** @unjournaled Derived from the program alone, on first use. */
const memberUsesByProgram = new WeakMap<ts.Program, MemberUses>();

function memberUses(checker: ts.TypeChecker, program: ts.Program): MemberUses {
    const known = memberUsesByProgram.get(program);
    if (known) return known;
    const uses: MemberUses = {
        calls: new Map(),
        values: new Map(),
        dynamic: [],
        patternKeys: new Set(),
        sinks: [],
    };
    const sink = (value: ts.Expression): void => {
        const expression = unwrapExpression(value);
        if (ts.isObjectLiteralExpression(expression))
            for (const member of expression.properties) {
                if (ts.isPropertyAssignment(member)) sink(member.initializer);
                else if (ts.isShorthandPropertyAssignment(member))
                    uses.sinks.push(member.name);
                else if (ts.isSpreadAssignment(member)) sink(member.expression);
            }
        else if (ts.isArrayLiteralExpression(expression))
            for (const element of expression.elements)
                sink(
                    ts.isSpreadElement(element) ? element.expression : element,
                );
        else uses.sinks.push(expression);
    };
    const inDeclarationFile = (declaration: ts.Node | undefined): boolean =>
        declaration?.getSourceFile().isDeclarationFile === true;
    const add = <T>(map: Map<string, T[]>, name: string, use: T): void => {
        const list = map.get(name);
        if (list) list.push(use);
        else map.set(name, [use]);
    };
    for (const file of program.getSourceFiles()) {
        if (
            file.isDeclarationFile ||
            program.isSourceFileFromExternalLibrary(file)
        )
            continue;
        for (const node of sourceFileNodes(file)) {
            if (
                ts.isPropertyAccessExpression(node) ||
                ts.isElementAccessExpression(node)
            ) {
                const member = namedMember(checker, node);
                if (!member) {
                    uses.dynamic.push(node.expression);
                    continue;
                }
                const position = outermostWrapper(node);
                const call = position.parent;
                if (ts.isCallExpression(call) && call.expression === position)
                    add(uses.calls, member.name, {
                        call,
                        receiver: member.expression,
                    });
                else add(uses.values, member.name, member.expression);
            } else if (
                (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
                inDeclarationFile(calledDeclaration(checker, node))
            ) {
                for (const argument of node.arguments ?? [])
                    sink(
                        ts.isSpreadElement(argument)
                            ? argument.expression
                            : argument,
                    );
            }
            if (
                ts.isBindingElement(node) &&
                ts.isObjectBindingPattern(node.parent)
            ) {
                const key = bindingElementKey(node);
                if (key === undefined) uses.dynamic.push(node.parent);
                else add(uses.values, key, node.parent);
            } else if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ) {
                patternKeys(checker, node.left, uses.patternKeys);
                const target = namedMember(
                    checker,
                    unwrapExpression(node.left),
                );
                const declarations =
                    target &&
                    accessedPropertySymbol(checker, target.access)
                        ?.declarations;
                if (
                    declarations?.length &&
                    declarations.every(inDeclarationFile)
                )
                    sink(node.right);
            } else if (
                (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
                !ts.isVariableDeclarationList(node.initializer)
            )
                patternKeys(checker, node.initializer, uses.patternKeys);
        }
    }
    memberUsesByProgram.set(program, uses);
    return uses;
}

/** The keys an assignment pattern reads (`({ m } = o)`), nested ones included. */
function patternKeys(
    checker: ts.TypeChecker,
    pattern: ts.Expression,
    keys: Set<string>,
): void {
    const target = unwrapExpression(pattern);
    if (ts.isArrayLiteralExpression(target))
        for (const element of target.elements)
            patternKeys(
                checker,
                ts.isSpreadElement(element) ? element.expression : element,
                keys,
            );
    else if (ts.isObjectLiteralExpression(target))
        for (const property of target.properties) {
            if (ts.isShorthandPropertyAssignment(property))
                keys.add(property.name.text);
            else if (ts.isPropertyAssignment(property)) {
                keys.add(
                    staticPropertyKey(checker, property.name) ?? RUN_TIME_KEY,
                );
                patternKeys(checker, property.initializer, keys);
            } else if (ts.isSpreadAssignment(property))
                patternKeys(checker, property.expression, keys);
        }
    else if (
        ts.isBinaryExpression(target) &&
        target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
        patternKeys(checker, target.left, keys);
}

/**
 * Whether a value of type `receiver` may be `holder`'s: a type `holder` is
 * assignable to, or one the checker leaves open.
 */
function mayHold(
    checker: ts.TypeChecker,
    receiver: ts.Type,
    holder: ts.Type,
): boolean {
    return unionMembers(checker.getNonNullableType(receiver)).some((member) => {
        if (
            member.flags &
            (ts.TypeFlags.Any |
                ts.TypeFlags.Unknown |
                ts.TypeFlags.NonPrimitive)
        )
            return true;
        if (member.flags & ts.TypeFlags.TypeParameter) {
            const constraint = checker.getBaseConstraintOfType(member);
            return (
                !constraint ||
                constraint === member ||
                mayHold(checker, constraint, holder)
            );
        }
        return checker.isTypeAssignableTo(holder, member);
    });
}

/**
 * Whether the library code a value is handed to may call its member
 * `name`: the type it is handed as declares one. Through `any` a library
 * calls only the language's protocols.
 */
function libraryTypeDeclares(
    checker: ts.TypeChecker,
    value: ts.Expression,
    name: string,
): boolean {
    const expected = checker.getContextualType(value);
    return (
        expected !== undefined &&
        unionMembers(expected).some(
            (member) =>
                (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ===
                    0 && member.getProperty(name) !== undefined,
        )
    );
}

/**
 * The program's local class hierarchies: which classes extend which.
 *
 * A class's own table names its base; the reverse edge -- every class that
 * extends a given one -- is a question about the whole program, answered by
 * one walk over its source files the first time it is asked. A value typed
 * as a base class can be an instance of any class under it, so both the
 * stored layout and the dispatch of an overridden member read the concrete
 * classes from here.
 */
export class ClassHierarchy {
    /** @unjournaled Derived from the program alone, on first use. */
    private subclassesByClass:
        Map<ts.ClassLikeDeclaration, ts.ClassLikeDeclaration[]> | undefined;

    public constructor(
        private readonly checker: ts.TypeChecker,
        private readonly program: ts.Program,
    ) {}

    public table(declaration: ts.ClassLikeDeclaration): ClassMemberTable {
        return classMemberTable(this.checker, declaration);
    }

    /**
     * The calls that may run `method`, a local class's method: dispatch
     * inverted over the whole program. A member call named like it may run
     * it when its receiver may hold an instance of the class (the class
     * itself for a static method), whatever type the receiver is read
     * through: a base class, an interface, a structurally compatible type,
     * `this`, `super` or `any`. Undefined when a use no call names may run
     * it: the member read as a value (passed, bound, destructured), read by
     * a run-time key, a protocol the language calls itself (`then`,
     * `toString`), or a library type an instance may be handed to as.
     */
    public methodCallers(
        method: ts.MethodDeclaration,
    ): readonly ts.CallExpression[] | undefined {
        const owner = method.parent;
        if (!ts.isClassLike(owner) || owner.getSourceFile().isDeclarationFile)
            return undefined;
        const name = staticPropertyKey(this.checker, method.name);
        if (name === undefined || LANGUAGE_PROTOCOL_METHODS.has(name))
            return undefined;
        const symbol = owner.name
            ? declaredSymbol(this.checker, owner.name)
            : undefined;
        if (!symbol) return undefined;
        const holder = isStaticMember(method)
            ? this.checker.getTypeOfSymbol(symbol)
            : this.checker.getDeclaredTypeOfSymbol(symbol);
        const uses = memberUses(this.checker, this.program);
        const known = new Map<ts.Type, boolean>();
        const reaches = (receiver: ts.Node): boolean => {
            const type = this.checker.getTypeAtLocation(receiver);
            let answer = known.get(type);
            if (answer === undefined)
                known.set(type, (answer = mayHold(this.checker, type, holder)));
            return answer;
        };
        if (
            uses.patternKeys.has(name) ||
            uses.patternKeys.has(RUN_TIME_KEY) ||
            uses.dynamic.some(reaches) ||
            (uses.values.get(name) ?? []).some(reaches) ||
            uses.sinks.some(
                (value) =>
                    reaches(value) &&
                    libraryTypeDeclares(this.checker, value, name),
            )
        )
            return undefined;
        return (uses.calls.get(name) ?? []).flatMap(({ call, receiver }) =>
            reaches(receiver) ? [call] : [],
        );
    }

    /** The classes that name `declaration` in their `extends` clause, in source order. */
    public subclasses(
        declaration: ts.ClassLikeDeclaration,
    ): readonly ts.ClassLikeDeclaration[] {
        if (!this.subclassesByClass) {
            const found = new Map<
                ts.ClassLikeDeclaration,
                ts.ClassLikeDeclaration[]
            >();
            for (const file of this.program.getSourceFiles()) {
                if (
                    file.isDeclarationFile ||
                    this.program.isSourceFileFromExternalLibrary(file)
                )
                    continue;
                forEachAnalysisNode(file, (node) => {
                    if (!ts.isClassLike(node)) return;
                    const base = this.table(node).base?.declaration;
                    if (!base) return;
                    const list = found.get(base) ?? [];
                    list.push(node);
                    found.set(base, list);
                });
            }
            this.subclassesByClass = found;
        }
        return this.subclassesByClass.get(declaration) ?? [];
    }

    /** Whether the class takes part in inheritance at all. */
    public inHierarchy(declaration: ts.ClassLikeDeclaration): boolean {
        return (
            this.table(declaration).base !== undefined ||
            this.subclasses(declaration).length > 0
        );
    }

    /** The class at the top of `declaration`'s chain. */
    public root(declaration: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration {
        return classChain(this.table(declaration)).at(-1)!.declaration;
    }

    /** Every class of the hierarchy under `root`, itself first, depth first in source order. */
    public hierarchyClasses(
        root: ts.ClassLikeDeclaration,
    ): readonly ts.ClassLikeDeclaration[] {
        const classes: ts.ClassLikeDeclaration[] = [];
        const visit = (current: ts.ClassLikeDeclaration): void => {
            classes.push(current);
            this.subclasses(current).forEach(visit);
        };
        visit(root);
        return classes;
    }

    /**
     * Every class an instance typed as `declaration` can be at run time:
     * the class itself unless abstract, then each subclass, depth first in
     * source order. The order is the hierarchy's tag numbering.
     */
    public concreteClasses(
        declaration: ts.ClassLikeDeclaration,
    ): readonly ts.ClassLikeDeclaration[] {
        return this.hierarchyClasses(declaration).filter(
            (candidate) => !isAbstractClass(candidate),
        );
    }

    /**
     * The methods a call of `method` can run: the one each concrete class
     * under its class resolves the name to, once each. Undefined for a
     * method outside a local class body.
     */
    public implementations(
        method: ts.MethodDeclaration,
    ): readonly (ts.MethodDeclaration | undefined)[] | undefined {
        const owner = method.parent;
        if (
            !ts.isClassLike(owner) ||
            owner.getSourceFile().isDeclarationFile ||
            isStaticMember(method) ||
            !ts.isMemberName(method.name)
        )
            return undefined;
        const name = method.name.text;
        return [
            ...new Set(
                this.concreteClasses(owner).map((candidate) =>
                    classMethod(this.table(candidate), name),
                ),
            ),
        ];
    }

    /**
     * The bodies a call of `method` runs: every implementation a class
     * method dispatches to, or the method itself outside a local class
     * body; undefined when one of them has no body.
     */
    public dispatchBodies(
        method: ts.MethodDeclaration,
    ): readonly ts.MethodDeclaration[] | undefined {
        const implementations = this.implementations(method) ?? [method];
        return implementations.length > 0 &&
            implementations.every(
                (implementation): implementation is ts.MethodDeclaration =>
                    implementation?.body !== undefined,
            )
            ? implementations
            : undefined;
    }

    /** The run-time tag of a concrete class within its hierarchy. */
    public tag(declaration: ts.ClassLikeDeclaration): number {
        return this.concreteClasses(this.root(declaration)).indexOf(
            declaration,
        );
    }

    /**
     * The most derived class every one of `classes` is or extends: the
     * static class a receiver narrowed to them can be read as.
     */
    public commonClass(
        classes: readonly ts.ClassLikeDeclaration[],
    ): ts.ClassLikeDeclaration {
        const [first, ...rest] = classes;
        if (!first) throw new Error("A common class needs at least one class.");
        return classChain(this.table(first)).find((link) =>
            rest.every((other) =>
                classExtends(this.table(other), link.declaration),
            ),
        )!.declaration;
    }
}
