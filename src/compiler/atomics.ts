// `Atomics` over integer typed arrays.
// One realm owns its memory (worker messages refuse shared buffers), so no
// other agent observes an access: each operation is the plain element
// access, with the index validation and conversions the specification
// gives it (`bbl::js::atomics_*`).
import ts from "typescript";
import { EmissionMap } from "./emission-transaction.js";
import type { ExpressionContext } from "./expressions.js";
import { argumentAt, expressionMayRunCode } from "./syntax.js";
import { pinOperand } from "./evaluation-order.js";
import {
    isTypedArrayType,
    typedArrayConstructorName,
    type DataType,
} from "./data-types.js";
import { booleanValue, type Value } from "./types.js";

/** The read-modify-write operations, as `bbl::js::AtomicOperation` names them. */
const MODIFYING: ReadonlyMap<string, string> = new EmissionMap([
    ["add", "add"],
    ["sub", "sub"],
    ["and", "bit_and"],
    ["or", "bit_or"],
    ["xor", "bit_xor"],
    ["exchange", "exchange"],
]);

const INTEGER_KINDS: ReadonlySet<string> = new Set([
    "i8array",
    "u8array",
    "i16array",
    "u16array",
    "i32array",
    "u32array",
]);

/** The argument counts of the operations over a typed array. */
function operandCounts(method: string): [number, number] | undefined {
    if (method === "load") return [2, 2];
    if (method === "store" || MODIFYING.has(method)) return [3, 3];
    if (method === "compareExchange") return [4, 4];
    return method === "notify" ? [2, 3] : undefined;
}

/** `Atomics.<method>(...)`; methods needing another agent refuse. */
export function compileAtomicsCall(
    context: ExpressionContext,
    call: ts.CallExpression,
    method: string,
): Value {
    if (method === "isLockFree") {
        context.expectArgumentCount(call, 1, 1);
        const sizeNode = argumentAt(call, 0);
        const size = context.compileValue(sizeNode);
        if (size.staticNumber !== undefined) {
            context.emitDiscardedValue(size);
            return booleanValue(
                Atomics.isLockFree(size.staticNumber) ? "true" : "false",
            );
        }
        context.reachJsData();
        return booleanValue(
            `bbl::js::atomics_is_lock_free(${context.dataLowerer.compileKnownValueForSink(size, { kind: "number" }, sizeNode)})`,
        );
    }
    const counts = operandCounts(method);
    if (!counts)
        return context.fail(
            call,
            method === "wait" || method === "waitAsync"
                ? `Atomics.${method} suspends an agent until another agent notifies it; one realm has no other agent.`
                : `Atomics.${method} is not lowered.`,
        );
    context.expectArgumentCount(call, ...counts);
    const viewNode = argumentAt(call, 0);
    const viewType = integerViewType(context, viewNode, method);
    const rest = call.arguments.slice(1);
    const laterRunsCode = rest.some(expressionMayRunCode);
    const view = context.dataLowerer.compileKnownValueForSink(
        laterRunsCode
            ? pinOperand(
                  context,
                  context.compileValue(viewNode),
                  viewNode,
                  "atomics_view",
              )
            : context.compileValue(viewNode),
        viewType,
        viewNode,
    );
    // Arguments evaluate left to right; each number is pinned while a later
    // argument may run code.
    const numbers = rest.map((argument, index) => {
        const cpp = context.compileNumber(argument, "double");
        if (!rest.slice(index + 1).some(expressionMayRunCode)) return cpp;
        const temporary = context.allocateTemporaryCppName("atomics_operand");
        context.emit({
            kind: "declaration",
            type: "const double",
            name: temporary,
            initializer: cpp,
        });
        return temporary;
    });
    context.reachJsData();
    if (method === "notify") {
        if (viewType.kind !== "i32array")
            return context.fail(
                viewNode,
                "Atomics.notify takes an Int32Array; BigInt64Array is not represented.",
            );
        return numberValue(
            `bbl::js::atomics_notify(${view}, ${numbers[0]}, ${numbers[1] === undefined ? "std::nullopt" : `std::optional<double>(${numbers[1]})`})`,
        );
    }
    if (method === "load")
        return numberValue(`bbl::js::atomics_load(${view}, ${numbers[0]})`);
    if (method === "store")
        return numberValue(
            `bbl::js::atomics_store(${view}, ${numbers.join(", ")})`,
        );
    if (method === "compareExchange")
        return numberValue(
            `bbl::js::atomics_compare_exchange(${view}, ${numbers.join(", ")})`,
        );
    return numberValue(
        `bbl::js::atomics_modify<bbl::js::AtomicOperation::${MODIFYING.get(method)!}>(${view}, ${numbers.join(", ")})`,
    );
}

function numberValue(cpp: string): Value {
    return { kind: "number", cpp, dataType: { kind: "number" } };
}

/** The integer typed-array kind an Atomics call's first argument holds. */
function integerViewType(
    context: ExpressionContext,
    node: ts.Expression,
    method: string,
): DataType {
    const type = context.dataTypes.fromTsType(
        context.checker.getNonNullableType(
            context.checker.getTypeAtLocation(node),
        ),
        node,
    );
    if (isTypedArrayType(type) && INTEGER_KINDS.has(type.kind)) return type;
    return context.fail(
        node,
        `Atomics.${method} takes one integer typed-array kind${isTypedArrayType(type) ? `, not ${typedArrayConstructorName(type.kind)}` : ""}.`,
    );
}
