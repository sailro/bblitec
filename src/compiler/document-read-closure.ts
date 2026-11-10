import ts from "typescript";
import { programObservations } from "./program-observations.js";
import { isPlainRecord, isRecordUnion } from "./record-components.js";
import { declaredIn } from "./symbols.js";
import { unionMembers } from "./type-facts.js";

/**
 * @unjournaled `documentReadClosure` answers, by program and record type: a
 * function of the checked program.
 */
const closures = new WeakMap<ts.Program, Map<ts.Type, readonly ts.Type[]>>();

/** Arrays of arrays of records are walked this deep; a recursive alias stops here. */
const MAX_HELD_DEPTH = 6;

/**
 * The record types a value of `type` holds: itself where it is a plain
 * record of the program's own (a union of them too, with each member), an
 * array's or tuple's elements, a dictionary's values.
 */
function heldRecords(
    checker: ts.TypeChecker,
    type: ts.Type,
    depth = 0,
): readonly ts.Type[] {
    const present = checker.getNonNullableType(type);
    if (depth > MAX_HELD_DEPTH) return [];
    const below = (part: ts.Type): readonly ts.Type[] =>
        heldRecords(checker, part, depth + 1);
    if (present.isUnion())
        return [
            ...(isRecordUnion(checker, present) ? [present] : []),
            ...present.types.flatMap(below),
        ];
    if (checker.isArrayType(present) || checker.isTupleType(present))
        return checker
            .getTypeArguments(present as ts.TypeReference)
            .flatMap(below);
    if (isPlainRecord(checker, present))
        return declaredIn(present.aliasSymbol ?? present.getSymbol(), "babylon")
            ? []
            : [present];
    return checker
        .getIndexInfosOfType(present)
        .flatMap((index) => below(index.type));
}

/**
 * The record types whose values are documents once `record`'s are: every
 * record type a property the program reads off a `record` holds
 * (`heldRecords`), and so on from each. A value read out of a document is a
 * document and a record type has one storage, so these types are stored as
 * documents with `record` rather than one compile attempt later each, when
 * their first value arrives.
 */
export function documentReadClosure(
    checker: ts.TypeChecker,
    program: ts.Program,
    record: ts.Type,
): readonly ts.Type[] {
    let known = closures.get(program);
    if (!known) closures.set(program, (known = new Map()));
    const answered = known.get(record);
    if (answered) return answered;
    const reads = programObservations(program).namedReads;
    // Whether an object of this type may be a `holder`: it is one, or a
    // type a `holder` is read as that has the property too.
    const mayHold = (object: ts.Type, holder: ts.Type, name: string): boolean =>
        unionMembers(checker.getNonNullableType(object)).some(
            (member) =>
                member === holder ||
                (checker.getPropertyOfType(member, name) !== undefined &&
                    checker.isTypeAssignableTo(holder, member)),
        );
    const found = new Set<ts.Type>();
    const visit = (holder: ts.Type): void => {
        for (const part of holder.isUnion() ? holder.types : [holder])
            for (const property of checker.getPropertiesOfType(part)) {
                const read = reads
                    .get(property.name)
                    ?.some(
                        ({ object }) =>
                            object === undefined ||
                            mayHold(
                                checker.getTypeAtLocation(object),
                                part,
                                property.name,
                            ),
                    );
                if (!read) continue;
                for (const held of heldRecords(
                    checker,
                    checker.getTypeOfSymbol(property),
                )) {
                    if (held === record || found.has(held)) continue;
                    found.add(held);
                    visit(held);
                }
            }
    };
    visit(checker.getNonNullableType(record));
    const closure = [...found];
    known.set(record, closure);
    return closure;
}
