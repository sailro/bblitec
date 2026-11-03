import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";

/**
 * DOMRect's getters over the measured box (`bbl::UiClientRect`). Its sizes are
 * the border box, as offsetWidth/Height are.
 */
const COMPONENTS: ReadonlyMap<string, readonly [string, string?]> = new Map([
    ["x", ["left"]],
    ["left", ["left"]],
    ["y", ["top"]],
    ["top", ["top"]],
    ["width", ["offset_width"]],
    ["height", ["offset_height"]],
    ["right", ["left", "offset_width"]],
    ["bottom", ["top", "offset_height"]],
]);

/** `element.getBoundingClientRect()`: the box measured now, as its own object. */
export function domRectSnapshotCpp(engine: string, element: string): string {
    return `std::make_shared<const bbl::UiClientRect>(bbl::ui_get_client_rect(${engine}, ${element}))`;
}

/** A DOMRect's `x`, `y`, `width`, `height`, `top`, `right`, `bottom` or `left`. */
export function domRectProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    if (owner.dataType?.kind !== "dom-rect") return undefined;
    const component = COMPONENTS.get(property);
    if (!component) return undefined;
    const [start, extent] = component;
    return lowerer.leafValue(
        extent
            ? `((${owner.cpp})->${start} + (${owner.cpp})->${extent})`
            : `(${owner.cpp})->${start}`,
        { kind: "number" },
    );
}
