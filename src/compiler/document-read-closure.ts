import ts from "typescript";
import { programObservations } from "./program-observations.js";
import { isPlainRecord, isRecordUnion } from "./record-components.js";
import { declaredIn } from "./symbols.js";
import {
    PRIMITIVE_KINDS,
    holdsOnly,
    presentMembers,
    unionMembers,
} from "./type-facts.js";

/** One answer per record type of a checked program. */
type ProgramAnswers<Answer> = WeakMap<ts.Program, Map<ts.Type, Answer>>;

/** `compute`'s answer for `record`, kept for the program. */
function answered<Answer>(
    answers: ProgramAnswers<Answer>,
    program: ts.Program,
    record: ts.Type,
    compute: () => Answer,
): Answer {
    let known = answers.get(program);
    if (!known) {
        known = new Map<ts.Type, Answer>();
        answers.set(program, known);
    }
    let answer = known.get(record);
    if (answer === undefined) {
        answer = compute();
        known.set(record, answer);
    }
    return answer;
}

/** Arrays of arrays of records are walked this deep; a recursive alias stops here. */
const MAX_HELD_DEPTH = 6;

/**
 * The record types a value of `type` holds: itself where it is a plain
 * record of the program's own (a union of them too, with each member), an
 * array's or tuple's elements, a dictionary's values.
 */
function heldRecordTypes(
    checker: ts.TypeChecker,
    type: ts.Type,
    depth = 0,
): readonly ts.Type[] {
    const present = checker.getNonNullableType(type);
    // A primitive holds none; its wrapper's index signature is not a
    // dictionary's.
    if (depth > MAX_HELD_DEPTH || holdsOnly(present, PRIMITIVE_KINDS))
        return [];
    const below = (part: ts.Type): readonly ts.Type[] =>
        heldRecordTypes(checker, part, depth + 1);
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
 * The parts an intersection joins, none for any other type. A value of the
 * intersection is a value of each: it is a document where a part is.
 */
export function intersectedParts(type: ts.Type): readonly ts.Type[] {
    return type.isIntersection() ? type.types : [];
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
 * Where the program's values pass from record types to others: its
 * field-by-field copies (`ProgramObservations.copies`) and the values it
 * hands where another record type is declared (`handed`). `from` is the
 * record types the value may be (an intersection's parts too), `into`
 * those the copy holds or the declared type names.
 */
function copiedRecords(
    checker: ts.TypeChecker,
    program: ts.Program,
): readonly { from: readonly ts.Type[]; into: readonly ts.Type[] }[] {
    let known = copied.get(program);
    if (!known) {
        const observed = programObservations(program);
        const recordsOf = (value: ts.Node): readonly ts.Type[] => {
            const type = checker.getTypeAtLocation(value);
            return [
                ...heldRecordTypes(checker, type),
                ...presentMembers(type).flatMap(intersectedParts),
            ];
        };
        known = [
            ...observed.copies.map(({ from, into }) => ({
                from: recordsOf(from),
                into: heldRecordTypes(checker, checker.getTypeAtLocation(into)),
            })),
            // Most handed values hold no record: the declared type is
            // asked for only where one does.
            ...observed.handed.map((value) => {
                const from = recordsOf(value);
                const declared =
                    from.length > 0
                        ? checker.getContextualType(value)
                        : undefined;
                return {
                    from,
                    into: declared
                        ? heldRecordTypes(checker, declared).filter(
                              (record) => !from.includes(record),
                          )
                        : [],
                };
            }),
        ].filter(({ from, into }) => from.length > 0 && into.length > 0);
        copied.set(program, known);
    }
    return known;
}

/**
 * @unjournaled `parsedRecords` answers, by program: a function of the
 * checked program.
 */
const parsed = new WeakMap<ts.Program, readonly ts.Type[]>();

/**
 * The record types held by the types the program asserts data of no shape
 * as (`JSON.parse(text) as Save`, or the `object` a `typeof` test leaves of
 * it).
 */
function parsedRecords(
    checker: ts.TypeChecker,
    program: ts.Program,
): readonly ts.Type[] {
    let known = parsed.get(program);
    if (!known) {
        known = [
            ...new Set(
                programObservations(program).assertions.flatMap(
                    ({ asserted, shapeless }) =>
                        shapeless ? heldRecordTypes(checker, asserted) : [],
                ),
            ),
        ];
        parsed.set(program, known);
    }
    return known;
}

/**
 * @unjournaled `documentReadClosure` answers, by program and record type: a
 * function of the checked program.
 */
const closures: ProgramAnswers<readonly ts.Type[]> = new WeakMap();

/**
 * The record types whose values are documents once `record`'s are, read
 * down and up:
 *
 * - every record type a property the program reads off a `record` holds
 *   (`heldRecordTypes`), and so on from each (`readOut`): a value read out
 *   of a document is a document;
 * - every record type one of these is copied into field by field (a spread
 *   into a literal, the rest of a pattern) or handed as (an argument, a
 *   returned or assigned value under another declared type), with what is
 *   read out of it: the copy of a document's fields holds document values,
 *   and a document seen as another type is that type's value
 *   (`heldDocuments`);
 * - where `record` is itself held by a type the program asserts data of no
 *   shape as (`parsedRecords`), that type and everything it holds: the
 *   document a `record` arrived in is one of those, however far down its
 *   first stored value was found. An intersection arrived where one of its
 *   parts did (`Save & { id: number }` over a parsed `Save`).
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
    return answered(closures, program, record, () => {
        const closure = new Set(heldDocuments(checker, program, record));
        const arrived = [record, ...intersectedParts(record)];
        for (const root of parsedRecords(checker, program)) {
            if (root === record || closure.has(root)) continue;
            const below = heldDocuments(checker, program, root);
            if (!arrived.some((part) => part === root || below.has(part)))
                continue;
            closure.add(root);
            for (const held of below) if (held !== record) closure.add(held);
        }
        return [...closure];
    });
}

/**
 * @unjournaled `heldDocuments` answers, by program and record type: a
 * function of the checked program.
 */
const documents: ProgramAnswers<ReadonlySet<ts.Type>> = new WeakMap();

/**
 * The record types a document `record` hands its values to: those read
 * out of it (`readOut`), those any of them is copied into or handed as
 * (`copiedRecords`), and those read out of these.
 */
function heldDocuments(
    checker: ts.TypeChecker,
    program: ts.Program,
    record: ts.Type,
): ReadonlySet<ts.Type> {
    return answered(documents, program, record, () => {
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
        return found;
    });
}

/** The objects a property name is read off. */
interface ReadReceivers {
    /** Whether some read names no object to type: any holder's. */
    readonly anywhere: boolean;
    /** The distinct types of the objects read. */
    readonly types: readonly ts.Type[];
}

/**
 * @unjournaled `readReceivers` answers, by program and property name: a
 * function of the checked program.
 */
const receivers = new WeakMap<ts.Program, Map<string, ReadReceivers>>();

/** The objects the program reads `name` off, or undefined where it reads it off none. */
function readReceivers(
    checker: ts.TypeChecker,
    program: ts.Program,
    name: string,
): ReadReceivers | undefined {
    let known = receivers.get(program);
    if (!known) {
        known = new Map<string, ReadReceivers>();
        receivers.set(program, known);
    }
    let answer = known.get(name);
    if (!answer) {
        const reads = programObservations(program).namedReads.get(name);
        if (!reads) return undefined;
        const types = new Set<ts.Type>();
        let anywhere = false;
        for (const { object } of reads)
            if (object === undefined) anywhere = true;
            else types.add(checker.getTypeAtLocation(object));
        answer = { anywhere, types: [...types] };
        known.set(name, answer);
    }
    return answer;
}

/**
 * @unjournaled `readFrom` answers, by program and record type: a function
 * of the checked program.
 */
const steps: ProgramAnswers<readonly ts.Type[]> = new WeakMap();

/** The record types held by the properties the program reads off a `holder`. */
function readFrom(
    checker: ts.TypeChecker,
    program: ts.Program,
    holder: ts.Type,
): readonly ts.Type[] {
    return answered(steps, program, holder, () => {
        // Whether an object of this type may be the holder: it is one, or
        // a type the holder is read as that has the property too.
        const mayHold = (object: ts.Type, name: string): boolean =>
            presentMembers(object).some(
                (member) =>
                    member === holder ||
                    (checker.getPropertyOfType(member, name) !== undefined &&
                        checker.isTypeAssignableTo(holder, member)),
            );
        const held = new Set<ts.Type>();
        for (const property of checker.getPropertiesOfType(holder)) {
            const read = readReceivers(checker, program, property.name);
            if (
                !read ||
                !(
                    read.anywhere ||
                    read.types.some((object) => mayHold(object, property.name))
                )
            )
                continue;
            for (const record of heldRecordTypes(
                checker,
                checker.getTypeOfSymbol(property),
            ))
                held.add(record);
        }
        return [...held];
    });
}

/**
 * @unjournaled `readOut` answers, by program and record type: a function
 * of the checked program.
 */
const readOuts: ProgramAnswers<readonly ts.Type[]> = new WeakMap();

/** The record types the program reads out of a `record`, and out of each of those. */
function readOut(
    checker: ts.TypeChecker,
    program: ts.Program,
    record: ts.Type,
): readonly ts.Type[] {
    return answered(readOuts, program, record, () => {
        const found = new Set<ts.Type>();
        const visit = (holder: ts.Type): void => {
            for (const part of unionMembers(holder))
                for (const held of readFrom(checker, program, part)) {
                    if (held === record || found.has(held)) continue;
                    found.add(held);
                    visit(held);
                }
        };
        visit(checker.getNonNullableType(record));
        return [...found];
    });
}
