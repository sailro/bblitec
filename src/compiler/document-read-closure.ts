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
            ...unionMembers(present).flatMap(below),
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
 * @unjournaled `copiedRecords` answers, by program: a function of the
 * checked program.
 */
const copied = new WeakMap<
    ts.Program,
    readonly { from: readonly ts.Type[]; into: readonly ts.Type[] }[]
>();

/**
 * The program's field-by-field copies between record types
 * (`ProgramObservations.copies`): the record types a copied object may be
 * (an intersection's parts too) and those the copy holds.
 */
function copiedRecords(
    checker: ts.TypeChecker,
    program: ts.Program,
): readonly { from: readonly ts.Type[]; into: readonly ts.Type[] }[] {
    let known = copied.get(program);
    if (!known) {
        known = programObservations(program)
            .copies.map(({ from, into }) => {
                const source = checker.getTypeAtLocation(from);
                return {
                    from: [
                        ...heldRecords(checker, source),
                        ...unionMembers(
                            checker.getNonNullableType(source),
                        ).flatMap((member) =>
                            member.isIntersection() ? member.types : [],
                        ),
                    ],
                    into: heldRecords(checker, checker.getTypeAtLocation(into)),
                };
            })
            .filter(({ from, into }) => from.length > 0 && into.length > 0);
        copied.set(program, known);
    }
    return known;
}

/**
 * The record types whose values are documents once `record`'s are, read
 * down and up:
 *
 * - every record type a property the program reads off a `record` holds
 *   (`heldRecords`), and so on from each (`readOut`): a value read out of
 *   a document is a document;
 * - every record type one of these is copied into field by field (a spread
 *   into a literal, the rest of a pattern), with what is read out of it:
 *   the copy of a document's fields holds document values
 *   (`heldDocuments`);
 * - where `record` is itself held by a type the program asserts data of no
 *   shape as (`JSON.parse(text) as Save`, or the `object` a `typeof` test
 *   leaves of it), that type and everything it holds: the document a
 *   `record` arrived in is one of those, however far down its first stored
 *   value was found.
 *
 * A record type has one storage, so these types are stored as documents
 * with `record` rather than one compile attempt later each, when their
 * first value arrives.
 */
export function documentReadClosure(
    checker: ts.TypeChecker,
    program: ts.Program,
    record: ts.Type,
): readonly ts.Type[] {
    let known = closures.get(program);
    if (!known) {
        known = new Map<ts.Type, readonly ts.Type[]>();
        closures.set(program, known);
    }
    const answered = known.get(record);
    if (answered) return answered;
    const closure = new Set(heldDocuments(checker, program, record));
    for (const { asserted, shapeless } of programObservations(program)
        .assertions) {
        if (!shapeless) continue;
        for (const parsed of heldRecords(checker, asserted)) {
            if (parsed === record || closure.has(parsed)) continue;
            const below = heldDocuments(checker, program, parsed);
            if (!below.includes(record)) continue;
            closure.add(parsed);
            for (const held of below) if (held !== record) closure.add(held);
        }
    }
    const answer = [...closure];
    known.set(record, answer);
    return answer;
}

/**
 * @unjournaled `heldDocuments` answers, by program and record type: a
 * function of the checked program.
 */
const documents = new WeakMap<ts.Program, Map<ts.Type, readonly ts.Type[]>>();

/**
 * The record types a document `record` hands its values to: those read
 * out of it (`readOut`), those any of them is copied into field by field
 * (`copiedRecords`), and those read out of the copies.
 */
function heldDocuments(
    checker: ts.TypeChecker,
    program: ts.Program,
    record: ts.Type,
): readonly ts.Type[] {
    let known = documents.get(program);
    if (!known) {
        known = new Map<ts.Type, readonly ts.Type[]>();
        documents.set(program, known);
    }
    const answered = known.get(record);
    if (answered) return answered;
    const found = new Set(readOut(checker, program, record));
    const copies = copiedRecords(checker, program);
    for (let grown = true; grown;) {
        grown = false;
        for (const { from, into } of copies) {
            if (!from.some((held) => held === record || found.has(held)))
                continue;
            for (const made of into) {
                if (made === record || found.has(made)) continue;
                grown = true;
                found.add(made);
                for (const held of readOut(checker, program, made))
                    if (held !== record) found.add(held);
            }
        }
    }
    const answer = [...found];
    known.set(record, answer);
    return answer;
}

/**
 * @unjournaled `readOut` answers, by program and record type: a function
 * of the checked program.
 */
const readOuts = new WeakMap<ts.Program, Map<ts.Type, readonly ts.Type[]>>();

/** The record types the program reads out of a `record`, and out of each of those. */
function readOut(
    checker: ts.TypeChecker,
    program: ts.Program,
    record: ts.Type,
): readonly ts.Type[] {
    let known = readOuts.get(program);
    if (!known) {
        known = new Map<ts.Type, readonly ts.Type[]>();
        readOuts.set(program, known);
    }
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
        for (const part of unionMembers(holder))
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
