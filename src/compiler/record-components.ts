import ts from "typescript";
import { declarationOrigin, type DeclarationOrigin } from "./symbols.js";

/**
 * Record types a record converted between stays one object under.
 * JavaScript keeps one object when a record of one type is stored as
 * another; where a native copy could be told apart
 * (`recordCopyObservation`), lowering joins the two types (`RecordJoin`)
 * and every type of the component maps to one struct: the union of their
 * fields, each member type holding the fields it does not declare absent,
 * `readonly` erased -- or, where a member is a record union, that union's
 * layout. A component no one layout holds refuses, naming the types.
 */
export interface RecordComponent {
    readonly key: string;
    readonly members: readonly ts.Type[];
    /** The member whose name the layout takes: the widest. */
    readonly named: ts.Type;
    readonly union?: ts.Type;
    /** Two record unions met: no one layout holds both. */
    readonly conflict?: string;
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

/**
 * Where lowering stored a record of one type as another and the copy was
 * observable: the record and the type joined into one object. `element`:
 * through an array also held as an array of the other type; `assertion`:
 * through `x as T`; `spread`: a spread copying such a record's absence.
 */
export interface RecordJoin {
    readonly source: ts.Type;
    readonly target: ts.Type;
    readonly kind: "value" | "element" | "assertion" | "spread";
}

/**
 * The record components of a program: union-find over the joins lowering
 * met. Joining two record types joins the record types their common fields
 * hold too, since one layout stores each field once.
 */
export function recordComponents(
    checker: ts.TypeChecker,
    joins: readonly RecordJoin[],
): ReadonlyMap<ts.Symbol | ts.Type, RecordComponent> {
    const parent = new Map<ts.Symbol | ts.Type, ts.Symbol | ts.Type>();
    const types = new Map<ts.Symbol | ts.Type, ts.Type>();
    const find = (identity: ts.Symbol | ts.Type): ts.Symbol | ts.Type => {
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
    const joined = new Map<ts.Symbol | ts.Type, Set<ts.Symbol | ts.Type>>();
    const join = (left: ts.Type, right: ts.Type): void => {
        const a = recordIdentity(checker, left);
        const b = recordIdentity(checker, right);
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
        if (targets.has(b) || !isPlainRecord(checker, left)) return;
        targets.add(b);
        for (const property of recordProperties(checker, right)) {
            const held = left.getProperty(property.name);
            if (!held) continue;
            const fieldPair = heldRecords(
                checker,
                checker.getTypeOfSymbol(held),
                checker.getTypeOfSymbol(property),
            );
            if (fieldPair) join(fieldPair[0], fieldPair[1]);
        }
    };
    for (const { source, target } of joins) join(source, target);
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
    const groups = new Map<ts.Symbol | ts.Type, ts.Type[]>();
    for (const [identity, type] of types) {
        const root = find(identity);
        const group = groups.get(root);
        if (group) group.push(type);
        else groups.set(root, [type]);
    }
    const components = new Map<ts.Symbol | ts.Type, RecordComponent>();
    let next = 0;
    for (const members of groups.values()) {
        if (members.length < 2) continue;
        const unions = members.filter((member) => member.isUnion());
        const named = [...members]
            .filter((member) => !member.isUnion())
            .sort(
                (left, right) =>
                    checker.getPropertiesOfType(right).length -
                    checker.getPropertiesOfType(left).length,
            )[0]!;
        const component: RecordComponent = {
            key: `record-component:${next++}`,
            members,
            named,
            holdsNarrower,
            ...(unions.length === 1 ? { union: unions[0]! } : {}),
            ...(unions.length > 1
                ? {
                      conflict: `record unions '${checker.typeToString(unions[0]!)}' and '${checker.typeToString(unions[1]!)}'`,
                  }
                : {}),
        };
        for (const member of members)
            components.set(recordIdentity(checker, member), component);
    }
    return components;
}

/** The record types two field types hold in the same place, if both hold plain records. */
function heldRecords(
    checker: ts.TypeChecker,
    left: ts.Type,
    right: ts.Type,
): [ts.Type, ts.Type] | undefined {
    const a = checker.getNonNullableType(left);
    const b = checker.getNonNullableType(right);
    if (a === b) return undefined;
    if (checker.isArrayLikeType(a) && checker.isArrayLikeType(b)) {
        const elementA = checker.getIndexTypeOfType(a, ts.IndexKind.Number);
        const elementB = checker.getIndexTypeOfType(b, ts.IndexKind.Number);
        return elementA && elementB
            ? heldRecords(checker, elementA, elementB)
            : undefined;
    }
    return isPlainRecord(checker, a) &&
        isPlainRecord(checker, b) &&
        recordIdentity(checker, a) !== recordIdentity(checker, b)
        ? [a, b]
        : undefined;
}

/**
 * Whether one layout can store both record types' common fields: each held
 * in storage of one kind (`?` and `| undefined`, string literals and
 * strings, numeric tuples and number arrays aside), records in records of
 * a component joined with them.
 */
export function layoutsCompatible(
    checker: ts.TypeChecker,
    left: ts.Type,
    right: ts.Type,
    seen = new Map<ts.Type, Set<ts.Type>>(),
): boolean {
    const a = checker.getNonNullableType(left);
    const b = checker.getNonNullableType(right);
    if (a === b) return true;
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
        return layoutsCompatible(checker, elementA, elementB, seen);
    if (isPlainRecord(checker, a) && isPlainRecord(checker, b))
        return recordProperties(checker, b).every((property) => {
            const held = a.getProperty(property.name);
            return (
                !held ||
                layoutsCompatible(
                    checker,
                    checker.getTypeOfSymbol(held),
                    checker.getTypeOfSymbol(property),
                    seen,
                )
            );
        });
    return checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);
}
