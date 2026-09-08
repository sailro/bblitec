/**
 * The path language check expectations use to read a native render
 * capture (or any JSON value): `meshes.length`, `meshes[0].position`,
 * `draws[pipeline=shader].order`, `materials[directIntensity=0].textures[slot=metallicRoughness].byteLength`.
 *
 * Segments are separated by `.`. A segment is a property name, optionally
 * followed by selectors applied in turn: `[<index>]` picks one element,
 * `[*]` keeps every element, `[<key>=<value>]` keeps the elements whose
 * `key` equals `value` (parsed as JSON when it parses, else the literal
 * text), so `draws[pipeline=billboard][0]` is the first matching draw. A
 * property applied to an array maps over its elements, so a selection is
 * followed naturally by the field read from each match; `length` on an
 * array is its size. A missing property yields `undefined` at that point
 * rather than throwing, so an expectation compares against what is there.
 */
export function readCapturePath(value: unknown, path: string): unknown {
    let current: unknown = value;
    for (const segment of splitSegments(path)) {
        const open = segment.indexOf("[");
        const name = open < 0 ? segment : segment.slice(0, open);
        if (name !== "") current = property(current, name);
        if (open < 0) continue;
        const selectors = segment.slice(open);
        const pattern = /\[([^\]]*)\]/g;
        let consumed = 0;
        for (let match = pattern.exec(selectors); match !== null; match = pattern.exec(selectors)) {
            if (match.index !== consumed) break;
            consumed = match.index + match[0].length;
            current = select(current, match[1] ?? "", path);
        }
        if (consumed !== selectors.length) {
            throw new Error(`capture path: cannot parse segment '${segment}' of '${path}'`);
        }
    }
    return current;
}

function splitSegments(path: string): string[] {
    const segments: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < path.length; index += 1) {
        const character = path[index];
        if (character === "[") depth += 1;
        if (character === "]") depth -= 1;
        if (character === "." && depth === 0) {
            segments.push(path.slice(start, index));
            start = index + 1;
        }
    }
    segments.push(path.slice(start));
    return segments.filter((segment) => segment !== "");
}

function property(value: unknown, name: string): unknown {
    if (Array.isArray(value)) {
        if (name === "length") return value.length;
        return value.map((element) => property(element, name));
    }
    if (typeof value === "object" && value !== null) {
        return (value as Record<string, unknown>)[name];
    }
    return undefined;
}

function select(value: unknown, selector: string, path: string): unknown {
    if (!Array.isArray(value)) return undefined;
    // A property read over an array of records yields an array of arrays
    // (each record's list); a selector then applies to each list.
    if (value.length > 0 && value.every((element) => Array.isArray(element))) {
        return value.map((element) => select(element, selector, path));
    }
    if (selector === "*") return value;
    if (/^\d+$/.test(selector)) return value[Number(selector)];
    const equality = selector.indexOf("=");
    if (equality < 0) {
        throw new Error(`capture path: selector '[${selector}]' of '${path}' must be an index, '*' or 'key=value'`);
    }
    const key = selector.slice(0, equality);
    const text = selector.slice(equality + 1);
    let wanted: unknown = text;
    try {
        wanted = JSON.parse(text);
    } catch {
        // A bare word compares as text.
    }
    return value.filter(
        (element) =>
            typeof element === "object" &&
            element !== null &&
            (element as Record<string, unknown>)[key] === wanted,
    );
}
