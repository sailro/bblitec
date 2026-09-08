/**
 * The path language check expectations use to read a native render
 * capture (or any JSON value): `meshes.length`, `meshes[0].position`,
 * `draws[pipeline=shader].order`, `materials[directIntensity=0].textures[slot=metallicRoughness].byteLength`.
 *
 * Segments are separated by `.`. A segment is a property name, optionally
 * followed by one selector: `[<index>]` picks one element, `[*]` keeps
 * every element, `[<key>=<value>]` keeps the elements whose `key` equals
 * `value` (parsed as JSON when it parses, else the literal text). A
 * property applied to an array maps over its elements, so a selection is
 * followed naturally by the field read from each match; `length` on an
 * array is its size. A missing property yields `undefined` at that point
 * rather than throwing, so an expectation compares against what is there.
 */
export function readCapturePath(value: unknown, path: string): unknown {
    let current: unknown = value;
    for (const segment of splitSegments(path)) {
        const match = /^([^[]*)(?:\[(.*)\])?$/.exec(segment);
        if (!match) throw new Error(`capture path: cannot parse segment '${segment}' of '${path}'`);
        const name = match[1] ?? "";
        const selector = match[2];
        if (name !== "") current = property(current, name);
        if (selector !== undefined) current = select(current, selector, path);
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
