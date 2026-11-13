/**
 * Empty storage of a data type: what a survey binds where the program's
 * own value is out of reach (a rolled-back declaration, a root's
 * parameter, a repeated call's result).
 */
import { unlessRefused } from "./compile-error.js";
import type { DataType } from "./data-types/model.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";

/** What a native local of empty storage needs from its compiler. */
export type EmptyStorageContext = Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
    | "emit"
    | "dataTypes"
    | "dataLowerer"
    | "requireDefaultEngine"
    | "sourceFile"
>;

/**
 * A native local holding empty storage of `type`; undefined when it has
 * none. A resource no carrier names belongs to the entry's one engine,
 * when there is one.
 */
export function emptyStorage(
    context: EmptyStorageContext,
    type: DataType | undefined,
    label: string,
): Value | undefined {
    if (!type) return undefined;
    const cpp = context.allocateTemporaryCppName(`empty_${label}`);
    context.emit({
        kind: "declaration",
        type: context.dataTypes.cppType(type),
        name: cpp,
        initializer: "{}",
    });
    const value = context.dataLowerer.leafValue(cpp, type);
    if (value.kind === "data" || value.engineCpp) return value;
    const engineCpp = unlessRefused(() =>
        context.requireDefaultEngine(context.sourceFile),
    );
    return engineCpp ? { ...value, engineCpp } : value;
}
