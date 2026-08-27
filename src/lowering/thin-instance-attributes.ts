/**
 * The pin's own declared vertex attributes for its instance-stepped buffer
 * groups, lowered from the declaration that states them.
 *
 * `shader/fragments/thin-instance-fragment.ts` declares each attribute with
 * a `_bufferGroup`, an `_arrayStride`, a `_stepMode` and an `_offset` --
 * `ti-matrix` carries the four world columns at stride 64, `ti-color` the
 * RGBA lane at 16 -- and the composed WGSL keeps only the location, the name
 * and the type. So the layout half never reached the generated attribute
 * table and both PALs typed it out instead; a stride the pin moved would
 * have updated neither.
 *
 * The declaration is a plain list of object literals, so this is a fold
 * rather than an execution: the shape is the contract, and a pin that adds
 * a group, changes a stride or stops stepping per instance fails generation
 * here. Which SLOT a group binds at stays each backend's own answer -- the
 * pin assigns none.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";

const module = "src/shader/fragments/thin-instance-fragment.ts";
const factory = "createThinInstanceFragment";

/** One declared attribute, as the pin declares it. */
export interface PinnedInstanceAttribute {
    name: string;
    bufferGroup: string;
    arrayStride: number;
    offset: number;
    instanceStepped: boolean;
}

/**
 * Every attribute the factory declares, in declaration order.
 *
 * Both arms are read: the four `ti-matrix` columns the base list holds and
 * the one `ti-color` lane the `hasInstanceColor` branch pushes. The port
 * composes both arms of the fragment, so it needs both rows.
 */
export function pinnedInstanceAttributes(
    context: LoweringContext,
): readonly PinnedInstanceAttribute[] {
    const { file, declaration } = context.functionDeclaration(
        module,
        factory,
    );
    // Keyed on `_bufferGroup`: it is what makes a literal a VERTEX
    // attribute here. `_name` alone also matches the `vInstanceColor`
    // varying the same factory declares.
    const literals = context.findNodes(
        declaration,
        (node): node is ts.ObjectLiteralExpression =>
            ts.isObjectLiteralExpression(node) &&
            node.properties.some(
                (property) =>
                    ts.isPropertyAssignment(property) &&
                    context.propertyName(property.name) === "_bufferGroup",
            ),
    );
    if (literals.length === 0) {
        context.contractError(
            declaration,
            `Expected ${factory} to declare its vertex attributes as ` +
                "object literals carrying `_bufferGroup`.",
        );
    }
    return literals.map((literal) => {
        const text = (name: string): string =>
            context.stringValue(
                context.propertyInitializer(literal, name),
                file,
            );
        const number = (name: string): number =>
            context.numericValue(
                context.propertyInitializer(literal, name),
                file,
            );
        // Every declared attribute is one vec4 of floats, which is the lane
        // `pinned_vertex_input` maps them onto. A pin declaring another
        // width fails here rather than at a silently misread stream.
        const wgslType = text("_type");
        const gpuFormat = text("_gpuFormat");
        if (wgslType !== "vec4<f32>" || gpuFormat !== "float32x4") {
            context.contractError(
                literal,
                `Pinned instance attribute '${text("_name")}' is no longer ` +
                    `a float32x4 vec4: ${wgslType} / ${gpuFormat}.`,
            );
        }
        const stepMode = text("_stepMode");
        if (stepMode !== "instance") {
            context.contractError(
                literal,
                `Pinned instance attribute '${text("_name")}' steps ` +
                    `'${stepMode}', not per instance.`,
            );
        }
        return {
            name: text("_name"),
            bufferGroup: text("_bufferGroup"),
            arrayStride: number("_arrayStride"),
            offset: number("_offset"),
            instanceStepped: true,
        };
    });
}

/** The generated rows both backends read the layout from. */
export function pinnedInstanceAttributesCpp(
    context: LoweringContext,
): string {
    const rows = pinnedInstanceAttributes(context);
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
    bool instance_stepped;
};

inline constexpr std::array<PinnedInstanceAttribute, ${rows.length}>
    pinned_instance_attributes{{
${
        rows
            .map(
                (row) =>
                    `        {"${row.name}", "${row.bufferGroup}", ` +
                    `${row.arrayStride}u, ${row.offset}u, ` +
                    `${row.instanceStepped ? "true" : "false"}},`,
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

/** The stride the pin declares for one buffer group. */
inline constexpr std::uint32_t pinned_instance_group_stride(
    std::string_view group) {
    for (const PinnedInstanceAttribute& row : pinned_instance_attributes) {
        if (row.buffer_group == group) return row.array_stride;
    }
    return 0u;
}
`;
}
