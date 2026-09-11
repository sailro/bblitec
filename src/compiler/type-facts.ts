import ts from "typescript";

/** Scalars copy into callees; composites and unresolved types may alias. */
export function typeCanCarryReference(type: ts.Type): boolean {
    if (type.isUnion() || type.isIntersection()) return type.types.some(typeCanCarryReference);
    const scalar = ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike | ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined |
        ts.TypeFlags.Void | ts.TypeFlags.Never;
    return (type.flags & scalar) === 0;
}
