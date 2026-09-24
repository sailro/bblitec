import ts from "typescript";
import { isDomElementType, type DataType } from "./data-types.js";

/**
 * Whether the data model can map a checker type to the retained UI element
 * handle. Only a DOM element interface maps to it (the object arm of
 * `DataTypes.fromTsType`); every other route reaches that arm through a
 * constituent this walk visits: a union member (nullable or not), an
 * intersection member (`NonNullable<T>`), a type argument (a synchronously
 * lowered `Promise<T>` maps as the `T` it resolves to), or a type parameter,
 * whose substitution belongs to the active instantiation and so counts as
 * possibly an element. A `false` answer is therefore exact; `true` only
 * means the mapping has to be asked.
 */
export function typeMayMapToUiElement(
    type: ts.Type,
    checker: ts.TypeChecker,
    visited = new Set<ts.Type>(),
): boolean {
    if (visited.has(type)) return false;
    visited.add(type);
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return true;
    if (type.isUnionOrIntersection())
        return type.types.some((member) =>
            typeMayMapToUiElement(member, checker, visited),
        );
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    if (type.symbol && isDomElementType(type.symbol)) return true;
    return (
        ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !==
            0 &&
        checker
            .getTypeArguments(type as ts.TypeReference)
            .some((argument) =>
                typeMayMapToUiElement(argument, checker, visited),
            )
    );
}

/**
 * Whether a data value of this type can lower to a UI element: the element
 * handle itself, or an `EventTarget` a typed read narrows to one, possibly
 * behind the optional and union layers that narrowing removes.
 */
export function dataTypeMayHoldUiElement(type: DataType): boolean {
    switch (type.kind) {
        case "handle":
            return type.handle === "ui-element";
        case "event-target":
            return true;
        case "optional":
            return dataTypeMayHoldUiElement(type.inner);
        case "union":
            return type.members.some(dataTypeMayHoldUiElement);
        default:
            return false;
    }
}
