/**
 * The string searches that take a UTF-16 position, at every arity: the
 * runtime helper (`bbl::js::<helper>` in `js_data.hpp`), its result, the
 * position an absent (undefined) argument stands for -- also the helper's
 * default when the call passes none -- and, where one exists, the
 * generation-time answer over a known receiver and needle with no position.
 */
export interface StringPositionSearch {
    readonly helper: string;
    readonly result: "number" | "boolean";
    readonly absent: "start" | "end";
    readonly fold?: (receiver: string, search: string) => boolean;
}

export const STRING_POSITION_SEARCHES: ReadonlyMap<
    string,
    StringPositionSearch
> = new Map<string, StringPositionSearch>([
    [
        "indexOf",
        { helper: "string_index_of", result: "number", absent: "start" },
    ],
    [
        "includes",
        { helper: "string_includes", result: "boolean", absent: "start" },
    ],
    [
        "lastIndexOf",
        { helper: "string_last_index_of", result: "number", absent: "end" },
    ],
    [
        "startsWith",
        {
            helper: "string_starts_with",
            result: "boolean",
            absent: "start",
            fold: (receiver, search) => receiver.startsWith(search),
        },
    ],
    [
        "endsWith",
        { helper: "string_ends_with", result: "boolean", absent: "end" },
    ],
]);
