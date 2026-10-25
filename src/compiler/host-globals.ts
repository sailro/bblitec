import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { unwrapExpression } from "./syntax.js";
import { GLOBAL_OBJECT_NAMES } from "./symbols.js";

/**
 * The global object's host properties programs redefine, and how each is
 * represented:
 *
 * - `accessor`: a number the Window host provides. Reads take the Window
 *   realm's `bbl::pal::HostAccessor` slot (the single surface reads
 *   `surface`); `Object.defineProperty` with a getter replaces it there.
 * - `instrumentation`: an assigned replacement wraps browser loading
 *   instrumentation, which is erased: no native load calls it.
 *
 * A Window realm refuses a write or definition of any other host property.
 */
type HostGlobal =
    | { kind: "accessor"; slot: string; surface: number }
    | { kind: "instrumentation" };

const HOST_GLOBALS: ReadonlyMap<string, HostGlobal> = new Map<
    string,
    HostGlobal
>([
    [
        "devicePixelRatio",
        { kind: "accessor", slot: "device_pixel_ratio", surface: 1 },
    ],
    ["fetch", { kind: "instrumentation" }],
]);

const ACCESSOR_NAMES = [...HOST_GLOBALS]
    .filter(([, row]) => row.kind === "accessor")
    .map(([name]) => `'${name}'`)
    .join(", ");

type Context = Pick<LoweringServices, "libraryGlobal" | "options">;

function accessorRow(
    name: string,
): Extract<HostGlobal, { kind: "accessor" }> | undefined {
    const row = HOST_GLOBALS.get(name);
    return row?.kind === "accessor" ? row : undefined;
}

function realmHostAccessorSlot(name: string): string {
    const row = accessorRow(name);
    if (!row) throw new Error(`'${name}' is not a host accessor.`);
    return `bbl::pal::HostAccessor::${row.slot}`;
}

/** A host accessor's value in the running Window realm, empty outside one. */
export function realmHostAccessorCpp(name: string): string {
    return `bbl::pal::realm_host_accessor(${realmHostAccessorSlot(name)})`;
}

/** Whether `name` is a global host accessor (a member of the realm global). */
export function isHostAccessor(name: string): boolean {
    return accessorRow(name) !== undefined;
}

/**
 * A read of a host accessor (`devicePixelRatio`, `window.devicePixelRatio`):
 * the single surface's constant, or the Window realm's current value, which
 * a display change or a definition changes.
 */
export function hostAccessorValue(
    context: Context,
    node: ts.Expression,
): Value | undefined {
    node = unwrapExpression(node);
    const name = ts.isIdentifier(node)
        ? node.text
        : ts.isPropertyAccessExpression(node)
          ? node.name.text
          : undefined;
    const row = name === undefined ? undefined : accessorRow(name);
    if (!row || context.libraryGlobal(node) !== name) return undefined;
    return {
        kind: "number",
        dataType: { kind: "number" },
        ...(context.options.workers
            ? {
                  cpp: `static_cast<double>(*${realmHostAccessorCpp(name!)})`,
                  impure: true as const,
              }
            : { cpp: `${row.surface}.0`, staticNumber: row.surface }),
    };
}

/** A Window realm's global object, whose host properties are this table's. */
export function isRealmGlobalObject(
    context: Context,
    expression: ts.Expression,
): boolean {
    const workers = context.options.workers;
    return (
        workers !== undefined &&
        !workers.namespace &&
        GLOBAL_OBJECT_NAMES.has(
            context.libraryGlobal(unwrapExpression(expression)) ?? "",
        )
    );
}

/** Why a Window realm refuses defining the global's `key`; undefined for a host accessor. */
export function globalDefinitionRefusal(key: string): string | undefined {
    return accessorRow(key)
        ? undefined
        : `on the global object defines only the host accessors ${ACCESSOR_NAMES}, not '${key}'.`;
}

/** `Object.defineProperty(globalThis, key, { get })` in a Window realm. */
export function defineHostAccessor(
    key: string,
    getterCpp: string,
    configurable: boolean,
): string {
    return `bbl::pal::WorkerRealm::current().define_host_accessor(${realmHostAccessorSlot(key)}, ${getterCpp}, ${configurable});`;
}

/** Whether an assignment to `target` replaces erased browser instrumentation. */
export function isInstrumentationHostWrite(
    context: Context,
    target: ts.Expression,
): boolean {
    const name = context.libraryGlobal(target);
    return (
        name !== undefined && HOST_GLOBALS.get(name)?.kind === "instrumentation"
    );
}

/** A write of a Window realm global host property no table row represents. */
export function isRefusedRealmHostWrite(
    context: Context,
    target: ts.Expression,
): boolean {
    const node = unwrapExpression(target);
    return (
        ts.isPropertyAccessExpression(node) &&
        isRealmGlobalObject(context, node.expression) &&
        context.libraryGlobal(node) !== undefined &&
        !isInstrumentationHostWrite(context, node)
    );
}

/** Refuses a write {@link isRefusedRealmHostWrite} names. */
export function refuseRealmHostWrite(
    context: Context & Pick<LoweringServices, "fail">,
    target: ts.PropertyAccessExpression,
): void {
    if (isRefusedRealmHostWrite(context, target))
        context.fail(
            target,
            `A Window realm does not represent writing its global's host property '${target.name.text}': ` +
                `it redefines the accessors ${ACCESSOR_NAMES} with Object.defineProperty getters, ` +
                "and erases a fetch replacement as loading instrumentation.",
        );
}
