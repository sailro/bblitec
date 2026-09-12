import type { DataKindOperations } from "./contracts.js";

export const containerKinds: DataKindOperations<
    "promise" | "optional" | "union" | "vector" | "map" | "set" | "iterator" | "span" | "tuple" | "product" | "enummap" | "table"
> = {
    promise: {
        cpp: (type, context) => `bbl::js::Promise<${type.result ? context.cppType(type.result) : "bbl::js::PromiseVoid"}>`,
        key: (type, key) => `promise(${type.result ? key(type.result) : "void"})`,
        equal: (left, right, equal) => left.result && right.result ? equal(left.result, right.result) : left.result === right.result,
        children: type => type.result ? [type.result] : [], byReference: false,
    },
    product: {
        cpp: (type, context) => `bbl::js::Product<${type.elements.map(element => context.cppType(element)).join(", ")}>`,
        key: (type, key) => `product(${type.elements.map(key).join(",")})`,
        equal: (left, right, equal) => left.elements.length === right.elements.length &&
            left.elements.every((element, index) => equal(element, right.elements[index]!)),
        children: type => type.elements, byReference: true,
    },
    union: {
        cpp: (type, context) => `std::variant<${type.members.map(member => context.cppType(member)).join(", ")}>`,
        key: (type, key) => `union(${type.members.map(key).join(",")})`,
        equal: (left, right, equal) => left.members.length === right.members.length &&
            left.members.every((member, index) => equal(member, right.members[index]!)),
        children: type => type.members, byReference: false,
    },
    optional: {
        cpp: (type, context) => type.inner.kind === "struct" && context.isReferenceStruct(type.inner.name)
            ? context.cppType(type.inner) : `bbl::js::Nullable<${context.cppType(type.inner)}>`,
        key: (type, key) => `o(${key(type.inner)})`,
        equal: (left, right, equal) => equal(left.inner, right.inner),
        children: type => [type.inner], byReference: false,
    },
    vector: {
        cpp: (type, context) => `bbl::js::Array<${context.cppType(type.element)}>`,
        key: (type, key) => `v(${key(type.element)})`,
        equal: (left, right, equal) => equal(left.element, right.element),
        children: type => [type.element], byReference: true,
    },
    map: {
        cpp: (type, context) => `bbl::js::Map<${context.cppType(type.key)}, ${context.cppType(type.value)}>`,
        key: (type, key) => `map(${key(type.key)},${key(type.value)})`,
        equal: (left, right, equal) => equal(left.key, right.key) && equal(left.value, right.value),
        children: type => [type.key, type.value], byReference: true,
    },
    set: {
        cpp: (type, context) => `bbl::js::Set<${context.cppType(type.element)}>`,
        key: (type, key) => `set(${key(type.element)})`,
        equal: (left, right, equal) => equal(left.element, right.element),
        children: type => [type.element], byReference: true,
    },
    iterator: {
        cpp: (type, context) => `bbl::js::Iterator<${context.cppType(type.element)}>`,
        key: (type, key) => `iterator(${key(type.element)})`,
        equal: (left, right, equal) => equal(left.element, right.element),
        children: type => [type.element], byReference: true, opaqueReference: true,
    },
    span: {
        cpp: (type, context) => `bbl::js::Span<const ${context.cppType(type.element)}>`,
        key: (type, key) => `r(${key(type.element)})`,
        equal: (left, right, equal) => equal(left.element, right.element),
        children: type => [type.element], byReference: false,
    },
    tuple: {
        cpp: type => `bbl::js::Tuple<${type.arity}>`,
        key: type => `t${type.arity}`,
        equal: (left, right) => left.arity === right.arity,
        children: () => [], byReference: true,
    },
    enummap: {
        cpp: (type, context) => {
            context.namedType(type.enumName);
            return `bbl::js::EnumMap<${context.cppType(type.element)}, ${context.enumSize(type.enumName)}>`;
        },
        key: (type, key) => `m(${type.enumName},${key(type.element)})`,
        equal: (left, right, equal) => left.enumName === right.enumName && equal(left.element, right.element),
        children: type => [type.element], byReference: true,
    },
    table: {
        cpp: (type, context) => `const ${context.tableCppType(type.dimensions)}&`,
        key: type => `g(${type.dimensions.join("x")})`,
        equal: (left, right) => left.dimensions.join(",") === right.dimensions.join(","),
        children: () => [], byReference: false,
    },
};
