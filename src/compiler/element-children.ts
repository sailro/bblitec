import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import { libraryStaticMember } from "./symbols.js";
import { valueConsumer } from "./syntax.js";
import type { Value } from "./types.js";

const ELEMENT_LIST: DataType = {
    kind: "vector",
    element: { kind: "handle", handle: "ui-element" },
};

/**
 * Whether one walk reads `element.children`: a for...of subject, a spread
 * element, or Array.from's source. The collection is live, so it has a
 * value only where one walk reads it, which sees it as it is then.
 */
export function readByOneWalk(
    checker: ts.TypeChecker,
    access: ts.Expression,
): boolean {
    const consumer = valueConsumer(access);
    if (consumer.kind === "iterated") return true;
    if (consumer.kind === "spread") return ts.isSpreadElement(consumer.spread);
    if (consumer.kind !== "argument" || consumer.index !== 0) return false;
    const callee = libraryStaticMember(checker, consumer.call.expression);
    return callee?.owner === "Array" && callee.name === "from";
}

/** `element.children` now: its element children in order, a fresh array. */
export function elementChildrenSnapshot(
    lowerer: DataLowerer,
    owner: Value,
    engine: string,
): Value {
    return {
        ...lowerer.leafValue(
            `bbl::ui_element_children(${engine}, ${owner.cpp})`,
            ELEMENT_LIST,
        ),
        freshData: true,
    };
}
