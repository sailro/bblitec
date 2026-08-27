/**
 * The pin's own declared vertex attributes for its instance-stepped buffer
 * groups, taken from the factory that declares them.
 *
 * `shader/fragments/thin-instance-fragment.ts` declares each attribute with
 * a `_bufferGroup`, an `_arrayStride`, a `_stepMode` and an `_offset` --
 * `ti-matrix` carries the four world columns at stride 64, `ti-color` the
 * RGBA lane at 16 -- and the composed WGSL keeps only the location, the name
 * and the type. So the layout half never reached the generated attribute
 * table and both PALs typed it out instead; a stride the pin moved would
 * have updated neither.
 *
 * The factory is EXECUTED rather than read: it is the same module and the
 * same call the two compositions already make (`pinned-standard-variants.ts`
 * resolves its thin-instance fragment from it, and the PBR composition
 * passes it through `_createThinInstanceFragment`), and its return value
 * carries the rows verbatim. So there is no shape to match here, and no
 * second literal in the same factory to match by accident. Which SLOT a
 * group binds at stays each backend's own answer -- the pin assigns none.
 */
import type { LoweringContext } from "./context.js";
import { importPinnedModule } from "../pinned-shader-composer.js";

const module = "src/shader/fragments/thin-instance-fragment.ts";
const factory = "createThinInstanceFragment";

/** One attribute as the pinned factory declares it. */
interface PinnedFragmentAttribute {
    _name: string;
    _gpuFormat: string;
    _arrayStride: number;
    _stepMode: string;
    _bufferGroup: string;
    _offset: number;
}

const pinnedThinInstanceFragment = await importPinnedModule<{
    createThinInstanceFragment: (hasInstanceColor: boolean) => {
        _vertexAttributes: readonly PinnedFragmentAttribute[];
    };
}>("shader/fragments/thin-instance-fragment.js");

/** One declared attribute, as the pin declares it. */
export interface PinnedInstanceAttribute {
    name: string;
    bufferGroup: string;
    arrayStride: number;
    offset: number;
}

/**
 * Every attribute the factory declares, in declaration order.
 *
 * Called with the colour arm ON, because the port composes both arms of the
 * fragment and needs both rows: the four `ti-matrix` columns the base list
 * holds and the one `ti-color` lane the `hasInstanceColor` branch pushes.
 */
export function pinnedInstanceAttributes(
    context: LoweringContext,
): readonly PinnedInstanceAttribute[] {
    const declared =
        pinnedThinInstanceFragment.createThinInstanceFragment(
            true,
        )._vertexAttributes;
    const site = context.functionDeclaration(module, factory).declaration;
    for (const attribute of declared) {
        // Every consumer of the generated table reads a float4 at a
        // per-instance step rate. Those are the two facts the table carries
        // no column for, so they are asserted rather than assumed: a pin
        // that changed either would otherwise be read at the wrong lane
        // width or the wrong step rate.
        if (attribute._gpuFormat !== "float32x4") {
            context.contractError(
                site,
                `Pinned instance attribute '${attribute._name}' declares ` +
                    `format '${attribute._gpuFormat}'; every backend reads ` +
                    "these as float32x4.",
            );
        }
        if (attribute._stepMode !== "instance") {
            context.contractError(
                site,
                `Pinned instance attribute '${attribute._name}' steps per ` +
                    `'${attribute._stepMode}'; this table is the ` +
                    "instance-stepped layout alone.",
            );
        }
    }
    return declared.map((attribute) => ({
        name: attribute._name,
        bufferGroup: attribute._bufferGroup,
        arrayStride: attribute._arrayStride,
        offset: attribute._offset,
    }));
}

/** The generated rows both backends read the layout from. */
export function pinnedInstanceAttributesCpp(
    context: LoweringContext,
): string {
    const rows = pinnedInstanceAttributes(context);
    const groups = [...new Set(rows.map((row) => row.bufferGroup))];
    return `// ${context.provenance(module, factory)}
//
// The pin declares each instance-stepped attribute's buffer group, stride
// and offset; the composed WGSL carries only its location and name, so this
// is where the layout half comes from. Which slot a group binds at is the
// backend's own answer -- the pin assigns none.
struct PinnedInstanceAttribute {
    std::string_view name;
    std::string_view buffer_group;
    std::uint32_t array_stride;
    std::uint32_t offset;
};

inline constexpr std::array<PinnedInstanceAttribute, ${rows.length}>
    pinned_instance_attributes{{
${
        rows
            .map(
                (row) =>
                    `        {"${row.name}", "${row.bufferGroup}", ` +
                    `${row.arrayStride}u, ${row.offset}u},`,
            )
            .join("\n")
    }
    }};

/** The declared row for one attribute name, or null. */
inline constexpr const PinnedInstanceAttribute* pinned_instance_attribute(
    std::string_view name) {
    for (const PinnedInstanceAttribute& row : pinned_instance_attributes) {
        if (row.name == name) return &row;
    }
    return nullptr;
}

/**
 * The distinct buffer groups the pin declares, in declaration order.
 *
 * Which SLOT each binds at is a backend's own answer, but the NAMES are the
 * pin's -- so a backend states its mapping against this list rather than
 * restating the strings, and a pin that renames a group or adds a third
 * fails that backend's own assertions.
 */
inline constexpr std::array<std::string_view, ${groups.length}>
    pinned_instance_groups{${groups.map((group) => `"${group}"`).join(", ")}};

/**
 * The stride the pin declares for one buffer group, or zero for a name it
 * declares no attribute under.
 *
 * Zero is not a usable array stride, so a caller reads it as the refusal it
 * is: both backends static_assert their own streams against it.
 */
inline constexpr std::uint32_t pinned_instance_group_stride(
    std::string_view group) {
    for (const PinnedInstanceAttribute& row : pinned_instance_attributes) {
        if (row.buffer_group == group) return row.array_stride;
    }
    return 0u;
}
`;
}
