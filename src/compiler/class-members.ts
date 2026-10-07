import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    declaredInDefaultLibrary,
    resolvedSymbol,
    symbolPropertyKey,
} from "./symbols.js";
import { ERROR_CONSTRUCTORS } from "./error-values.js";

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
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
            declaration.initializer
                ? skipOuterExpressions(declaration.initializer)
                : undefined;
        if (initializer && ts.isClassExpression(initializer))
            return initializer;
    }
    return undefined;
}

/** Parentheses and type assertions around an expression. */
function skipOuterExpressions(expression: ts.Expression): ts.Expression {
    while (
        ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression) ||
        ts.isTypeAssertionExpression(expression)
    )
        expression = expression.expression;
    return expression;
}

/**
 * The names a class binds: its own, and for a class expression the `const`
 * it initializes (the name the class's static members are read through).
 */
export function classBindingNames(
    declaration: ts.ClassLikeDeclaration,
): ts.Identifier[] {
    let parent: ts.Node = declaration.parent;
    while (
        ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression(parent)
    )
        parent = parent.parent;
    const bound =
        ts.isClassExpression(declaration) &&
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
type InstanceProperty = (ts.PropertyDeclaration | ts.ParameterDeclaration) & {
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
function isStaticConstant(member: ts.PropertyDeclaration): boolean {
    return (
        member.initializer !== undefined &&
        (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Readonly) !== 0
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
    const heritage = declaration.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )?.types[0];
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
        // A method a unique symbol names (`*[Symbol.iterator]()`) is keyed
        // by that symbol's property key.
        const name = !member.name
            ? undefined
            : ts.isMemberName(member.name)
              ? member.name.text
              : ts.isMethodDeclaration(member) &&
                  ts.isComputedPropertyName(member.name)
                ? symbolPropertyKey(checker, member.name.expression)
                : undefined;
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
    name: ts.MemberName,
): { table: ClassMemberTable; name: string } | undefined {
    if (!ts.isIdentifier(owner)) return undefined;
    const member = resolvedSymbol(checker, name)?.declarations?.find(
        (candidate): candidate is ts.ClassElement =>
            ts.isClassElement(candidate) &&
            ts.isClassLike(candidate.parent) &&
            isStaticMember(candidate),
    );
    if (!member || !ts.isClassLike(member.parent)) return undefined;
    return {
        table: classMemberTable(checker, member.parent),
        name: name.text,
    };
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
