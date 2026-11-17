/**
 * The string searches that take a UTF-16 position, at every arity: the
 * runtime helper (`bbl::js::<helper>` in `js_data.hpp`), its result, the
 * position an absent (undefined) argument stands for -- also the helper's
 * default when the call passes none -- and the generation-time answer over
 * a known receiver, needle and position (undefined: the absent position).
 */
export interface StringPositionSearch {
    readonly helper: string;
    readonly result: "number" | "boolean";
    readonly absent: "start" | "end";
    readonly fold: (
        receiver: string,
        search: string,
        position: number | undefined,
    ) => number | boolean;
}

export const STRING_POSITION_SEARCHES: ReadonlyMap<
    string,
    StringPositionSearch
> = new Map<string, StringPositionSearch>([
    [
        "indexOf",
        {
            helper: "string_index_of",
            result: "number",
            absent: "start",
            fold: (receiver, search, position) =>
                receiver.indexOf(search, position),
        },
    ],
    [
        "includes",
        {
            helper: "string_includes",
            result: "boolean",
            absent: "start",
            fold: (receiver, search, position) =>
                receiver.includes(search, position),
        },
    ],
    [
        "lastIndexOf",
        {
            helper: "string_last_index_of",
            result: "number",
            absent: "end",
            fold: (receiver, search, position) =>
                receiver.lastIndexOf(search, position),
        },
    ],
    [
        "startsWith",
        {
            helper: "string_starts_with",
            result: "boolean",
            absent: "start",
            fold: (receiver, search, position) =>
                receiver.startsWith(search, position),
        },
    ],
    [
        "endsWith",
        {
            helper: "string_ends_with",
            result: "boolean",
            absent: "end",
            fold: (receiver, search, position) =>
                receiver.endsWith(search, position),
        },
    ],
]);
