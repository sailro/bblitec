import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { declaredSymbol, resolvedSymbol } from "./symbols.js";

/** Instance fields include the properties declared by constructor parameters. */
export function classInstanceProperties(
    declaration: ts.ClassDeclaration,
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
export type StaticElement =
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
    readonly declaration: ts.ClassDeclaration;
    /** The local class this one extends. */
    readonly base: ClassMemberTable | undefined;
    /** An `extends` clause naming something other than a local class. */
    readonly unsupportedHeritage: ts.ExpressionWithTypeArguments | undefined;
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
const classMemberTables = new WeakMap<ts.ClassDeclaration, ClassMemberTable>();

export function isStaticMember(member: ts.ClassElement): boolean {
    return (
        (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0
    );
}

export function isAbstractClass(declaration: ts.ClassDeclaration): boolean {
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
    declaration: ts.ClassDeclaration,
):
    | { base: ts.ClassDeclaration }
    | { unsupported: ts.ExpressionWithTypeArguments }
    | undefined {
    const heritage = declaration.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )?.types[0];
    if (!heritage) return undefined;
    const base = resolvedSymbol(checker, heritage.expression)
        ?.getDeclarations()
        ?.find(ts.isClassDeclaration);
    return base &&
        !base.getSourceFile().isDeclarationFile &&
        (ts.getCombinedModifierFlags(base) & ts.ModifierFlags.Ambient) === 0
        ? { base }
        : { unsupported: heritage };
}

export function classMemberTable(
    checker: ts.TypeChecker,
    declaration: ts.ClassDeclaration,
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
        if (!member.name || !ts.isMemberName(member.name)) continue;
        const name = member.name.text;
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

/**
 * Whether evaluating the class declaration runs or stores anything: its own
 * static blocks, or static field storage it declares or inherits.
 */
export function classHasStaticState(
    checker: ts.TypeChecker,
    declaration: ts.ClassDeclaration,
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
    ancestor: ts.ClassDeclaration,
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

/** The static method `name` resolves to through the constructor chain. */
export function classStaticMethod(
    table: ClassMemberTable,
    name: string,
): ts.MethodDeclaration | undefined {
    for (const link of classChain(table)) {
        const method = link.staticMethods.get(name);
        if (method) return method;
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

/** The static fields `table`'s class reads through its constructor chain, nearest first. */
export function classChainStaticFields(
    table: ClassMemberTable,
): Map<string, ts.PropertyDeclaration & { name: ts.MemberName }> {
    const fields = new Map<
        string,
        ts.PropertyDeclaration & { name: ts.MemberName }
    >();
    for (const link of classChain(table)) {
        for (const [name, field] of link.staticFields) {
            if (!fields.has(name)) fields.set(name, field);
        }
    }
    return fields;
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
    const member = declaredSymbol(checker, name)?.declarations?.find(
        (candidate): candidate is ts.ClassElement =>
            ts.isClassElement(candidate) &&
            ts.isClassDeclaration(candidate.parent) &&
            isStaticMember(candidate),
    );
    if (!member || !ts.isClassDeclaration(member.parent)) return undefined;
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
    private subclassesByClass:
        Map<ts.ClassDeclaration, ts.ClassDeclaration[]> | undefined;

    public constructor(
        private readonly checker: ts.TypeChecker,
        private readonly program: ts.Program,
    ) {}

    public table(declaration: ts.ClassDeclaration): ClassMemberTable {
        return classMemberTable(this.checker, declaration);
    }

    /** The classes that name `declaration` in their `extends` clause, in source order. */
    public subclasses(
        declaration: ts.ClassDeclaration,
    ): readonly ts.ClassDeclaration[] {
        if (!this.subclassesByClass) {
            const found = new Map<ts.ClassDeclaration, ts.ClassDeclaration[]>();
            for (const file of this.program.getSourceFiles()) {
                if (
                    file.isDeclarationFile ||
                    this.program.isSourceFileFromExternalLibrary(file)
                )
                    continue;
                forEachAnalysisNode(file, (node) => {
                    if (!ts.isClassDeclaration(node)) return;
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
    public inHierarchy(declaration: ts.ClassDeclaration): boolean {
        return (
            this.table(declaration).base !== undefined ||
            this.subclasses(declaration).length > 0
        );
    }

    /** The class at the top of `declaration`'s chain. */
    public root(declaration: ts.ClassDeclaration): ts.ClassDeclaration {
        return classChain(this.table(declaration)).at(-1)!.declaration;
    }

    /** Every class of the hierarchy under `root`, itself first, depth first in source order. */
    public hierarchyClasses(
        root: ts.ClassDeclaration,
    ): readonly ts.ClassDeclaration[] {
        const classes: ts.ClassDeclaration[] = [];
        const visit = (current: ts.ClassDeclaration): void => {
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
        declaration: ts.ClassDeclaration,
    ): readonly ts.ClassDeclaration[] {
        return this.hierarchyClasses(declaration).filter(
            (candidate) => !isAbstractClass(candidate),
        );
    }

    /** The run-time tag of a concrete class within its hierarchy. */
    public tag(declaration: ts.ClassDeclaration): number {
        return this.concreteClasses(this.root(declaration)).indexOf(
            declaration,
        );
    }

    /**
     * The most derived class every one of `classes` is or extends: the
     * static class a receiver narrowed to them can be read as.
     */
    public commonClass(
        classes: readonly ts.ClassDeclaration[],
    ): ts.ClassDeclaration {
        const [first, ...rest] = classes;
        if (!first) throw new Error("A common class needs at least one class.");
        return classChain(this.table(first)).find((link) =>
            rest.every((other) =>
                classExtends(this.table(other), link.declaration),
            ),
        )!.declaration;
    }
}
