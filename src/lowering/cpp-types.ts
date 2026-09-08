/**
 * The C++ spellings the pinned translators share for the value shapes a
 * pinned body carries.
 *
 * Every translator that types a pinned value -- the numeric lowerer's list
 * and record shapes, the reference lowerer's storage, the flow graph's
 * residual shapes, the live node-particle buffer columns -- lands on the
 * same handful of native types: a JavaScript number is a `double`, a typed
 * array is a `std::vector` of its element width, the pin's small
 * positional records are the runtime's `Vec2d`/`Vec3d`/`Color4d`. Spelling
 * them here once is what keeps a `Vec3d` a `Vec3d` in every emitted unit,
 * and what a translator that learns a new shape extends.
 */

/** The scalar a pinned value of each JavaScript type lands on. */
export const CPP_SCALAR = {
    number: "double",
    boolean: "bool",
    string: "std::string",
} as const;

/** The element type behind each typed-array width the pin allocates. */
export const CPP_ELEMENT = {
    f32: "float",
    f64: "double",
    u32: "std::uint32_t",
    u8: "std::uint8_t",
} as const;

export type CppElementWidth = keyof typeof CPP_ELEMENT;

/** An owned buffer of one element width: the pin's typed array. */
export function cppVector(element: CppElementWidth | string): string {
    return `std::vector<${element in CPP_ELEMENT ? CPP_ELEMENT[element as CppElementWidth] : element}>`;
}

/**
 * The pin's three small positional records, by the storage each one takes
 * and the members the pin reads off it. `Vec3d` is the runtime's own; the
 * two-lane and four-lane records land on the same double-per-lane shape,
 * declared by the translation unit that reaches them. The member ORDER is
 * the pin's own literal order and is what a record literal is checked
 * against.
 */
export const CPP_RECORD = {
    vec2: { storage: "Vec2d", members: ["x", "y"], annotation: "Vec2" },
    vec3: { storage: "Vec3d", members: ["x", "y", "z"], annotation: "Vec3" },
    color4: {
        storage: "Color4d",
        members: ["r", "g", "b", "a"],
        annotation: "Color4",
    },
} as const satisfies Record<
    string,
    { storage: string; members: readonly string[]; annotation: string }
>;

export type CppRecordShape = keyof typeof CPP_RECORD;
