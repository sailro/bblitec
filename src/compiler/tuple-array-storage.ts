import ts from "typescript";
import { isRetypableDeclaration } from "./symbols.js";

/**
 * A record property whose fixed-length tuples are stored where a number
 * array could grow them: the compile replays with growable array storage
 * for the property, which every record type sharing its layout keeps.
 */
export class TupleArraySlotRequired extends Error {
    constructor(
        readonly declaration: ts.PropertySignature | ts.PropertyDeclaration,
    ) {
        super("A record property must store its tuples as arrays.");
    }
}

/**
 * Demands growable array storage for the record slot a tuple value was read
 * from, when it has one not yet retyped; returns otherwise.
 */
export function requireTupleArraySlot(
    slots: ReadonlySet<ts.Declaration>,
    value: { readonly slotDeclarations?: readonly ts.Declaration[] },
): void {
    for (const declaration of value.slotDeclarations ?? [])
        if (
            isRetypableDeclaration(declaration) &&
            (ts.isPropertySignature(declaration) ||
                ts.isPropertyDeclaration(declaration)) &&
            !slots.has(declaration)
        )
            throw new TupleArraySlotRequired(declaration);
}
