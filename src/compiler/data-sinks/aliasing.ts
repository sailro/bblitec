import ts from "typescript";

import type { DataType } from "../data-types.js";
import {
    yieldsFreshObject,
    yieldsFreshRecordElements,
    yieldsNewArray,
} from "../fresh-records.js";
import { returnedRecordLocal } from "../record-observations.js";
import { unwrapExpression } from "../syntax.js";
import type { Value } from "../types.js";
import type { DataSinkHost } from "./contracts.js";

/**
 * Whether no JavaScript reference but the value a sink at `node` stores
 * holds the object it yields (`Value.unaliased`): the producer's flag (an
 * element of an array of fresh records), or the converted expression's
 * own -- a literal or construction, a call returning only such objects
 * (or creating its tuple), a new array copy, a callback returning a fresh
 * object, a local the function returns as its last reference, or an
 * element of an array of fresh records (`elements`). The expression must
 * yield the value itself, never a container it was read out of
 * (`convertedExpression`). Storing such a value in another representation
 * copies or adopts an object nothing else can reach.
 */
export function unaliasedValue(
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): Value["unaliased"] {
    if (value.unaliased) return value.unaliased;
    const checker = lowerer.context.checker;
    const own =
        value.dataType?.kind === "optional"
            ? value.dataType.inner
            : value.dataType;
    const holds = (type: DataType | undefined): boolean => {
        const inner = type?.kind === "optional" ? type.inner : type;
        return (
            own !== undefined &&
            inner !== undefined &&
            (inner.kind === own.kind ||
                (inner.kind === "vector" && own.kind === "span")) &&
            (inner.kind !== "struct" ||
                (own.kind === "struct" && inner.name === own.name))
        );
    };
    const freshElements = (array: ts.Expression | undefined): boolean => {
        const elements = array && lowerer.dataTypeAt(array);
        return (
            array !== undefined &&
            elements?.kind === "vector" &&
            holds(elements.element) &&
            yieldsFreshRecordElements(checker, array)
        );
    };
    const converted = lowerer.convertedExpression(node);
    if (!converted)
        return freshElements(lowerer.convertedElementOf(node))
            ? "object"
            : undefined;
    const expression = unwrapExpression(converted);
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
        const returned = ts.isBlock(expression.body)
            ? expression.body.statements.find(ts.isReturnStatement)?.expression
            : expression.body;
        return returned !== undefined &&
            holds(lowerer.dataTypeAt(returned)) &&
            yieldsFreshObject(checker, expression)
            ? "object"
            : undefined;
    }
    if (!holds(lowerer.dataTypeAt(expression))) return undefined;
    if (
        own?.kind === "vector" &&
        yieldsFreshRecordElements(checker, expression)
    )
        return "elements";
    return yieldsFreshObject(checker, expression) ||
        (own?.kind === "struct" &&
            returnedRecordLocal(checker, expression, (initializer) =>
                yieldsFreshObject(checker, initializer),
            )) ||
        ((own?.kind === "vector" || own?.kind === "span") &&
            yieldsNewArray(checker, expression)) ||
        // A call creating its tuple owns it; a selection (`??`, `?:`)
        // marked fresh may still yield a stored one.
        (own?.kind === "tuple" &&
            value.freshData === true &&
            ts.isCallExpression(expression))
        ? "object"
        : undefined;
}
