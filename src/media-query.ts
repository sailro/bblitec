/** The media features a retained sheet's query conjoins. */
export interface UiMediaConditions {
    maxWidth?: number;
    reducedMotion?: boolean;
    orientation?: "portrait" | "landscape";
    /** The primary pointing device's run-time capabilities. */
    mediaHover?: boolean;
    mediaPointer?: "none" | "coarse" | "fine";
}

export interface MediaConditions extends UiMediaConditions {
    resolution?: number;
}

const bareFeatures: ReadonlyMap<string, string> = new Map([
    ["prefers-reduced-motion", "reduce"],
    ["hover", "hover"],
]);
const whitespace = "[\\t\\n\\f\\r ]";
const featurePattern = new RegExp(
    `^\\(${whitespace}*([a-z-]+)${whitespace}*(?::${whitespace}*([^()]*?)${whitespace}*)?\\)`,
    "i",
);
const conjunction = new RegExp(`^${whitespace}+and${whitespace}+`, "i");
const trim = (text: string): string =>
    text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");

/** The bounded conjunction grammar shared by sheets and literal matchMedia calls. */
export function parseMediaQuery(
    query: string,
    surface: "sheet" | "window",
): MediaConditions | undefined {
    let rest = trim(query);
    const conditions: MediaConditions = {};
    const named = new Set<string>();
    while (rest) {
        const feature = featurePattern.exec(rest);
        if (!feature) return undefined;
        const name = feature[1]!.toLowerCase();
        const value = feature[2]?.toLowerCase() ?? bareFeatures.get(name);
        if (value === undefined || named.has(name)) return undefined;
        named.add(name);
        if (
            (name === "max-width" && surface === "sheet") ||
            (name === "resolution" && surface === "window")
        ) {
            const unit = name === "max-width" ? "px" : "dppx";
            const token = value.endsWith(unit)
                ? value.slice(0, -unit.length)
                : "";
            if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token))
                return undefined;
            const number = Number(token);
            if (
                !Number.isFinite(number) ||
                (number === 0 && /[1-9]/.test(token.split(/e/i)[0]!))
            )
                return undefined;
            if (name === "max-width") conditions.maxWidth = number;
            else conditions.resolution = number;
        } else if (
            name === "orientation" &&
            surface === "sheet" &&
            (value === "portrait" || value === "landscape")
        )
            conditions.orientation = value;
        else if (
            name === "prefers-reduced-motion" &&
            (value === "reduce" || value === "no-preference")
        )
            conditions.reducedMotion = value === "reduce";
        else if (name === "hover" && (value === "hover" || value === "none"))
            conditions.mediaHover = value === "hover";
        else if (
            name === "pointer" &&
            (value === "none" || value === "coarse" || value === "fine")
        )
            conditions.mediaPointer = value;
        else return undefined;
        rest = rest.slice(feature[0].length);
        if (!trim(rest))
            return conditions.resolution !== undefined && named.size !== 1
                ? undefined
                : conditions;
        const and = conjunction.exec(rest);
        if (!and) return undefined;
        rest = rest.slice(and[0].length);
    }
    return undefined;
}
