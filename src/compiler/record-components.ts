import ts from "typescript";
import {
    declarationOrigin,
    declaredInDefaultLibrary,
    type DeclarationOrigin,
} from "./symbols.js";
import { TYPED_ARRAY_KINDS } from "./data-types/typed-arrays.js";

/**
 * Record types a record converted between stays one object under.
 * JavaScript keeps one object when a record of one type is stored as
 * another; where a native copy could be told apart
 * (`recordCopyObservation`), lowering joins the two types (`RecordJoin`)
 * and every type of the component maps to one struct: the union of the
 * fields of every record shape it stores (its members, a record union's
 * arms), each shape holding the fields it does not declare absent,
 * `readonly` erased -- or, where one record union's own layout already
 * stores every shape, that union's layout. A component no one layout holds
 * refuses, naming the types.
 */
export interface RecordComponent {
    readonly key: string;
    readonly members: readonly ts.Type[];
    /**
     * The record shapes the layout stores: the members that are no union
     * and every arm of the members that are, each type once.
     */
    readonly shapes: readonly ts.Type[];
    /** The shape whose name the layout takes: the widest. */
    readonly named: ts.Type;
    /** The members that are record unions. */
    readonly unions: readonly ts.UnionType[];
    /**
     * Member types whose static type can be wrong about a field: storage
     * of the type may hold a record of a member lacking it, put there
     * through an array the program also holds as an array of the narrower
     * type, or through an assertion.
     */
    readonly holdsNarrower: ReadonlySet<ts.Symbol | ts.Type>;
}

/**
 * The identity a record type keeps across the program: its declared name,
 * or the type itself where a name is shared by several types -- an
 * instantiated generic alias (`Record<K, T>` and `Record<string, U>`
 * share `Record`), an instantiated generic interface or class, an
 * instantiated type literal (every instantiation carries the literal's
 * one symbol) -- or where there is no name.
 */
export function recordIdentity(
    checker: ts.TypeChecker,
    type: ts.Type,
): ts.Symbol | ts.Type {
    const object = type as ts.ObjectType;
    const instantiated =
        (type.aliasSymbol !== undefined &&
            (type.aliasTypeArguments?.length ?? 0) > 0) ||
        ((object.objectFlags & ts.ObjectFlags.Reference) !== 0 &&
            checker.getTypeArguments(type as ts.TypeReference).length > 0) ||
        (object.objectFlags &
            (ts.ObjectFlags.Anonymous | ts.ObjectFlags.Instantiated)) ===
            (ts.ObjectFlags.Anonymous | ts.ObjectFlags.Instantiated);
    return instantiated ? type : (type.aliasSymbol ?? type.symbol ?? type);
}

/**
 * A generic record type as one instantiation in force -- its generic
 * declaration (a generic interface's or class's type, an alias's symbol)
 * and the concrete arguments it takes there -- where its checker type
 * still names the type parameters: one identity per instantiation.
 */
export interface InstantiatedRecord {
    readonly generic: ts.Symbol | ts.Type;
    /** Each argument's concrete type, or a generic one's instantiation. */
    readonly arguments: readonly (ts.Type | InstantiatedRecord)[];
}

/** @unjournaled Canonical identities of the checked program's types, kept across replays. */
const instantiatedRecords = new WeakMap<
    ts.Symbol | ts.Type,
    InstantiatedRecord[]
>();

/** The one identity of a generic record type's instantiation. */
export function instantiatedRecord(
    generic: ts.Symbol | ts.Type,
    arguments_: readonly (ts.Type | InstantiatedRecord)[],
): InstantiatedRecord {
    let known = instantiatedRecords.get(generic);
    if (!known) instantiatedRecords.set(generic, (known = []));
    const existing = known.find(
        (candidate) =>
            candidate.arguments.length === arguments_.length &&
            candidate.arguments.every(
                (argument, index) => argument === arguments_[index],
            ),
    );
    if (existing) return existing;
    const created = { generic, arguments: [...arguments_] };
    known.push(created);
    return created;
}

/** Libraries whose record types keep the layout their declarations give them. */
const FIXED_LAYOUT_ORIGINS: ReadonlySet<DeclarationOrigin> = new Set([
    "default-lib",
    "dom",
    "webgpu",
]);

/**
 * Whether a type is a plain record a component can hold: an object type,
 * or an intersection of them, with properties and no call, construct or
 * index signature, that is not an array or a class instance, every
 * property declared by the program or the engine.
 */
export function isPlainRecord(checker: ts.TypeChecker, type: ts.Type): boolean {
    const parts = type.isIntersection() ? type.types : [type];
    if (
        parts.some(
            (part) =>
                (part.flags & ts.TypeFlags.Object) === 0 ||
                part.symbol?.declarations?.some(ts.isClassLike) === true,
        ) ||
        checker.isArrayLikeType(type) ||
        type.getCallSignatures().length > 0 ||
        type.getConstructSignatures().length > 0 ||
        checker.getIndexInfosOfType(type).length > 0
    )
        return false;
    const properties = checker.getPropertiesOfType(type);
    return (
        properties.length > 0 &&
        properties.every(
            ({ declarations }) =>
                declarations !== undefined &&
                declarations.length > 0 &&
                declarations.every(
                    (declaration) =>
                        !ts.isClassLike(declaration.parent) &&
                        !FIXED_LAYOUT_ORIGINS.has(
                            declarationOrigin(declaration),
                        ),
                ),
        )
    );
}

/** A record type's properties; a union's, every member's. */
function recordProperties(
    checker: ts.TypeChecker,
    type: ts.Type,
): readonly ts.Symbol[] {
    if (!type.isUnion()) return checker.getPropertiesOfType(type);
    const byName = new Map<string, ts.Symbol>();
    for (const member of type.types)
        for (const property of checker.getPropertiesOfType(member))
            if (!byName.has(property.name)) byName.set(property.name, property);
    return [...byName.values()];
}

/** Whether a type is a union of plain records (`isPlainRecord`). */
export function isRecordUnion(
    checker: ts.TypeChecker,
    type: ts.Type,
): type is ts.UnionType {
    return (
        type.isUnion() &&
        type.types.every((member) => isPlainRecord(checker, member))
    );
}

/** Whether a type is a plain record or a union of them. */
function isRecordLike(checker: ts.TypeChecker, type: ts.Type): boolean {
    return isPlainRecord(checker, type) || isRecordUnion(checker, type);
}

/**
 * The types a record type's property holds: its own; a union's, the
 * union of its arms' where every arm declares it, else each declaring
 * arm's.
 */
function propertyTypes(
    checker: ts.TypeChecker,
    type: ts.Type,
    name: string,
): readonly ts.Type[] {
    const property = type.getProperty(name);
    if (property || !type.isUnion())
        return property ? [checker.getTypeOfSymbol(property)] : [];
    return type.types.flatMap((member) => {
        const declared = member.getProperty(name);
        return declared ? [checker.getTypeOfSymbol(declared)] : [];
    });
}

/**
 * Where lowering stored a record of one type as another and the copy was
 * observable: the record and the type joined into one object. `element`:
 * through an array also held as an array of the other type; `assertion`:
 * through `x as T`; `spread`: a spread copying such a record's absence.
 */
export interface RecordJoin {
    readonly source: ts.Type;
    readonly target: ts.Type;
    /**
     * The instantiation of a generic `target` the record was stored as: the
     * component holds that instantiation alone, and its records take the
     * layout of the component's other shapes.
     */
    readonly targetInstantiation?: InstantiatedRecord;
    readonly kind: "value" | "element" | "assertion" | "spread";
}

/** What a record component keys its members by. */
export type RecordComponentKey = ts.Symbol | ts.Type | InstantiatedRecord;

const COMPONENT_KEY = "record-component:";

/**
 * Whether a struct identity names a record component: recomputing the
 * components as joins grow renumbers these keys.
 */
export function isRecordComponentKey(identity: unknown): boolean {
    return typeof identity === "string" && identity.startsWith(COMPONENT_KEY);
}

/**
 * The record components of a program: union-find over the joins lowering
 * met. Joining two record types joins the record types their common fields
 * hold too, since one layout stores each field once.
 */
export function recordComponents(
    checker: ts.TypeChecker,
    joins: readonly RecordJoin[],
): ReadonlyMap<RecordComponentKey, RecordComponent> {
    const parent = new Map<RecordComponentKey, RecordComponentKey>();
    const types = new Map<RecordComponentKey, ts.Type>();
    const find = (identity: RecordComponentKey): RecordComponentKey => {
        let root = identity;
        for (
            let next = parent.get(root);
            next && next !== root;
            next = parent.get(root)
        )
            root = next;
        parent.set(identity, root);
        return root;
    };
    const joined = new Map<RecordComponentKey, Set<RecordComponentKey>>();
    const join = (
        left: ts.Type,
        right: ts.Type,
        instantiation?: InstantiatedRecord,
    ): void => {
        const a = recordIdentity(checker, left);
        const b = instantiation ?? recordIdentity(checker, right);
        if (!types.has(a)) {
            types.set(a, left);
            parent.set(a, a);
        }
        if (!types.has(b)) {
            types.set(b, right);
            parent.set(b, b);
        }
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent.set(rootB, rootA);
        // One layout stores each common field once: the records the two
        // types' fields hold are one object too.
        let targets = joined.get(a);
        if (!targets) joined.set(a, (targets = new Set()));
        // An instantiation's fields name its type parameters: the records
        // they hold join where the instantiation is concrete.
        if (
            targets.has(b) ||
            instantiation ||
            !isRecordLike(checker, left) ||
            !isRecordLike(checker, right)
        )
            return;
        targets.add(b);
        for (const property of recordProperties(checker, right))
            for (const held of propertyTypes(checker, left, property.name))
                for (const field of propertyTypes(
                    checker,
                    right,
                    property.name,
                )) {
                    for (const [source, target] of heldRecords(
                        checker,
                        held,
                        field,
                    ))
                        join(source, target);
                }
    };
    for (const { source, target, targetInstantiation } of joins)
        join(source, target, targetInstantiation);
    // Storage of a wider type holds a narrower record where an array of the
    // wider type is also held as an array of the narrower one, where an
    // assertion retypes a narrower record as the wider type, or where a
    // spread copies such a record.
    const lacks = (narrower: ts.Type, wider: ts.Type): boolean =>
        recordProperties(checker, wider).some(
            (property) => !narrower.getProperty(property.name),
        );
    const holdsNarrower = new Set<ts.Symbol | ts.Type>();
    for (const { source, target, kind } of joins)
        if (kind === "element" && lacks(target, source))
            holdsNarrower.add(recordIdentity(checker, source));
        else if (
            (kind === "assertion" && lacks(source, target)) ||
            kind === "spread"
        )
            holdsNarrower.add(recordIdentity(checker, target));
    const groups = new Map<
        RecordComponentKey,
        { identity: RecordComponentKey; type: ts.Type }[]
    >();
    for (const [identity, type] of types) {
        const root = find(identity);
        const group = groups.get(root);
        if (group) group.push({ identity, type });
        else groups.set(root, [{ identity, type }]);
    }
    const components = new Map<RecordComponentKey, RecordComponent>();
    const instantiated = (identity: RecordComponentKey): boolean =>
        "generic" in identity;
    let next = 0;
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const members = group.map(({ type }) => type);
        // An instantiation stands for the concrete shapes it joined.
        const concrete = group
            .filter(({ identity }) => !instantiated(identity))
            .map(({ type }) => type);
        const unions = concrete.filter((member): member is ts.UnionType =>
            member.isUnion(),
        );
        // The layout stores the members that are no union and every arm of
        // those that are, each type once.
        const shapes = [
            ...new Map(
                concrete
                    .flatMap((member) =>
                        member.isUnion() ? member.types : [member],
                    )
                    .map((shape) => [recordIdentity(checker, shape), shape]),
            ).values(),
        ];
        if (shapes.length === 0) continue;
        // The widest shape names the layout and orders its fields; among
        // equally wide shapes, a declared type before an object literal's.
        const declared = (member: ts.Type): number =>
            member.aliasSymbol ||
            (member.symbol &&
                member.symbol.name !== "__type" &&
                member.symbol.name !== "__object")
                ? 0
                : 1;
        const named = [...shapes].sort(
            (left, right) =>
                checker.getPropertiesOfType(right).length -
                    checker.getPropertiesOfType(left).length ||
                declared(left) - declared(right),
        )[0]!;
        const component: RecordComponent = {
            key: `${COMPONENT_KEY}${next++}`,
            members,
            shapes: [named, ...shapes.filter((shape) => shape !== named)],
            named,
            unions,
            holdsNarrower,
        };
        for (const { identity } of group) components.set(identity, component);
    }
    return components;
}

/**
 * The paired record types two fields hold, including array elements and
 * stored callable parameters/results. Their layouts share every such slot.
 */
function heldRecords(
    checker: ts.TypeChecker,
    left: ts.Type,
    right: ts.Type,
    seen = new Map<ts.Type, Set<ts.Type>>(),
): [ts.Type, ts.Type][] {
    const a = checker.getNonNullableType(left);
    const b = checker.getNonNullableType(right);
    if (a === b) return [];
    let compared = seen.get(a);
    if (!compared) seen.set(a, (compared = new Set()));
    if (compared.has(b)) return [];
    compared.add(b);
    if (checker.isArrayLikeType(a) && checker.isArrayLikeType(b)) {
        const elementA = checker.getIndexTypeOfType(a, ts.IndexKind.Number);
        const elementB = checker.getIndexTypeOfType(b, ts.IndexKind.Number);
        return elementA && elementB
            ? heldRecords(checker, elementA, elementB, seen)
            : [];
    }
    const signatures = compatibleSignatures(checker, a, b);
    if (signatures) {
        const [signatureA, signatureB] = signatures;
        return [
            ...signatureA.parameters.flatMap((parameter, index) =>
                heldRecords(
                    checker,
                    checker.getTypeOfSymbol(parameter),
                    checker.getTypeOfSymbol(signatureB.parameters[index]!),
                    seen,
                ),
            ),
            ...heldRecords(
                checker,
                signatureA.getReturnType(),
                signatureB.getReturnType(),
                seen,
            ),
        ];
    }
    return isRecordLike(checker, a) &&
        isRecordLike(checker, b) &&
        recordIdentity(checker, a) !== recordIdentity(checker, b)
        ? [[a, b]]
        : [];
}

/** One assignable stored signature on each side, with corresponding slots. */
function compatibleSignatures(
    checker: ts.TypeChecker,
    left: ts.Type,
    right: ts.Type,
): [ts.Signature, ts.Signature] | undefined {
    const [a, ...overloadsA] = left.getCallSignatures();
    const [b, ...overloadsB] = right.getCallSignatures();
    return a &&
        b &&
        overloadsA.length === 0 &&
        overloadsB.length === 0 &&
        a.parameters.length === b.parameters.length &&
        (checker.isTypeAssignableTo(left, right) ||
            checker.isTypeAssignableTo(right, left))
        ? [a, b]
        : undefined;
}

/**
 * @unjournaled A pure function of the checked program's types, kept across
 * replays. Only whole answers are kept: a nested pair is assumed compatible
 * while its own comparison is in progress.
 */
const compatibleLayouts = new WeakMap<ts.Type, Map<ts.Type, boolean>>();

/**
 * Whether one layout can store both record types' common fields: each held
 * in storage of one kind (`?` and `| undefined`, string literals and
 * strings, numeric tuples and number arrays aside; functions as their
 * parameters and results), records in records of
 * a component joined with them; a record union's field as every arm
 * declaring it holds it.
 */
export function layoutsCompatible(
    checker: ts.TypeChecker,
    left: ts.Type,
    right: ts.Type,
): boolean {
    let byRight = compatibleLayouts.get(left);
    if (!byRight)
        compatibleLayouts.set(left, (byRight = new Map<ts.Type, boolean>()));
    let compatible = byRight.get(right);
    if (compatible === undefined) {
        compatible = layoutsHoldBoth(checker, left, right, new Map());
        byRight.set(right, compatible);
    }
    return compatible;
}

function layoutsHoldBoth(
    checker: ts.TypeChecker,
    left: ts.Type,
    right: ts.Type,
    seen: Map<ts.Type, Set<ts.Type>>,
): boolean {
    const a = checker.getNonNullableType(left);
    const b = checker.getNonNullableType(right);
    // A field only null or undefined is the other's empty storage.
    if (
        a === b ||
        (a.flags & ts.TypeFlags.Never) !== 0 ||
        (b.flags & ts.TypeFlags.Never) !== 0
    )
        return true;
    // The native view retains its buffer, including its shared brand. The
    // library's buffer type parameter does not change a view's storage.
    const typedArray = (type: ts.Type) =>
        declaredInDefaultLibrary(type.symbol)
            ? TYPED_ARRAY_KINDS.get(type.symbol.name)
            : undefined;
    const arrayA = typedArray(a),
        arrayB = typedArray(b);
    if (arrayA && arrayB) return arrayA === arrayB;
    let compared = seen.get(a);
    if (!compared) seen.set(a, (compared = new Set()));
    if (compared.has(b)) return true;
    compared.add(b);
    const like = (type: ts.Type, flags: ts.TypeFlags): boolean =>
        (type.isUnion() ? type.types : [type]).every(
            (member) => (member.flags & flags) !== 0,
        );
    if (
        (like(a, ts.TypeFlags.StringLike) &&
            like(b, ts.TypeFlags.StringLike)) ||
        (like(a, ts.TypeFlags.NumberLike) &&
            like(b, ts.TypeFlags.NumberLike)) ||
        (like(a, ts.TypeFlags.BooleanLike) && like(b, ts.TypeFlags.BooleanLike))
    )
        return true;
    const element = (type: ts.Type): ts.Type | undefined =>
        checker.isArrayLikeType(type)
            ? checker.getIndexTypeOfType(type, ts.IndexKind.Number)
            : undefined;
    const elementA = element(a);
    const elementB = element(b);
    if (elementA && elementB)
        return layoutsHoldBoth(checker, elementA, elementB, seen);
    if (isRecordLike(checker, a) && isRecordLike(checker, b)) {
        const fields = (type: ts.Type, name: string): readonly ts.Type[] =>
            type.isUnion()
                ? type.types.flatMap((arm) => propertyTypes(checker, arm, name))
                : propertyTypes(checker, type, name);
        return recordProperties(checker, b).every((property) =>
            fields(a, property.name).every((held) =>
                fields(b, property.name).every((field) =>
                    layoutsHoldBoth(checker, held, field, seen),
                ),
            ),
        );
    }
    // A function of one signature is a value of the other: one field holds
    // both where their parameters and results are held alike.
    const signatures = compatibleSignatures(checker, a, b);
    if (signatures) {
        const [signatureA, signatureB] = signatures;
        return (
            signatureA.parameters.every((parameter, index) =>
                layoutsHoldBoth(
                    checker,
                    checker.getTypeOfSymbol(parameter),
                    checker.getTypeOfSymbol(signatureB.parameters[index]!),
                    seen,
                ),
            ) &&
            layoutsHoldBoth(
                checker,
                signatureA.getReturnType(),
                signatureB.getReturnType(),
                seen,
            )
        );
    }
    return checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);
}
