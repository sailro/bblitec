import type { NativeStatement } from "./native-statements.js";

/** What declaring a shared binding cell needs from the lowering context. */
export interface SharedCellContext {
    emit(line: NativeStatement): void;
    registerNativeBindingType(name: string, cppType: string): void;
}

/** A binding held in a gc-shared cell: its lvalue and the cell closures capture. */
export interface SharedCell {
    readonly cpp: string;
    readonly sharedStorageCpp: string;
}

/**
 * The held value: its type (recorded so capturing environments are concrete),
 * or, absent or `auto`, the initializer's.
 */
export type SharedCellValue =
    | {
          readonly type: string;
          readonly initializer?: string | undefined;
          readonly attributes?: string;
      }
    | {
          readonly type?: undefined;
          readonly initializer: string;
          readonly attributes?: string;
      };

/**
 * Declare `name` as one gc-shared cell: the storage of a binding several
 * closures, iterations or suspended calls share, each capturing the cell. An
 * absent initializer value-initializes the held value.
 */
export function emitSharedCell(
    context: SharedCellContext,
    name: string,
    value: SharedCellValue,
): SharedCell {
    const type = value.type === "auto" ? undefined : value.type;
    if (type === undefined && value.initializer === undefined)
        throw new Error(
            `Shared cell ${name} has neither a type nor an initializer.`,
        );
    context.emit({
        kind: "declaration",
        type: "auto",
        name,
        initializer:
            type === undefined
                ? `bbl::js::make_gc_cell(${value.initializer})`
                : `bbl::js::make_gc_shared<${type}>(${value.initializer ?? ""})`,
        ...(value.attributes ? { attributes: value.attributes } : {}),
    });
    if (type !== undefined)
        context.registerNativeBindingType(name, `std::shared_ptr<${type}>`);
    return { cpp: sharedCellCpp(name), sharedStorageCpp: name };
}

/** The binding a shared cell holds, as an lvalue. */
export function sharedCellCpp(cell: string): string {
    return `(*${cell})`;
}

/** Rebind a per-iteration cell to a copy for the next iteration (CreatePerIterationEnvironment). */
export function nextIterationCellCpp(cell: string): string {
    return `${cell} = bbl::js::make_gc_cell(*${cell})`;
}
