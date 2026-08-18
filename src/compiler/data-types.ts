import ts from "typescript";
import { doubleLiteral, sanitizeCppIdentifier } from "../cpp-literals.js";

type Fail = (node: ts.Node, message: string) => never;

/**
 * Native representation for the plain-data TypeScript subset: numbers,
 * booleans, interface-typed structs, string-literal-union enums, nullable
 * objects, dynamic arrays, readonly views, and all-number tuples. Engine
 * handles never enter this model; they keep their dedicated value kinds.
 */
export type DataType =
    | { kind: "number" }
    | { kind: "boolean" }
    // A resource handle stored inside plain data (the demo particle
    // list keeps its meshes this way). Handles are trivially copyable
    // ids, so the value-copy model carries them unchanged: copying a
    // struct copies the id and both refer to the same resource, which
    // is exactly the JavaScript object-reference behavior.
    | { kind: "handle"; handle: "mesh" }
    | { kind: "struct"; name: string }
    | { kind: "enum"; name: string }
    | { kind: "optional"; inner: DataType }
    | { kind: "vector"; element: DataType }
    | { kind: "span"; element: DataType }
    | { kind: "tuple"; arity: number }
    // `Record<Union, T>`: one slot per member of a string-literal
    // union, indexed at runtime by the union's own enum tag. The key
    // space is closed at compile time, so this is a fixed table rather
    // than a growable array.
    | { kind: "enummap"; enumName: string; element: DataType }
    | { kind: "table"; dimensions: number[] }
    | { kind: "f32array" }
    | { kind: "u32array" };

export interface DataStructField {
    name: string;
    type: DataType;
}

interface DataStructDefinition {
    name: string;
    fields: DataStructField[];
}

interface DataEnumDefinition {
    name: string;
    members: string[];
}

interface DataTableDefinition {
    name: string;
    dimensions: number[];
    values: string;
}

const numberType: DataType = { kind: "number" };
const booleanType: DataType = { kind: "boolean" };

/**
 * True when a symbol is declared by the pinned Babylon Lite typings, so
 * a scene's own interface named `Mesh` is never mistaken for the engine
 * resource type.
 */
function declaredInBabylonLite(symbol: ts.Symbol): boolean {
    return (symbol.declarations ?? []).some((declaration) =>
        declaration
            .getSourceFile()
            .fileName.replace(/\\/g, "/")
            .includes("@babylonjs/lite/"),
    );
}

export function dataTypesEqual(
    left: DataType,
    right: DataType,
): boolean {
    if (left.kind !== right.kind) {
        return false;
    }
    switch (left.kind) {
        case "number":
        case "boolean":
        case "f32array":
        case "u32array":
            return true;
        case "handle":
            return (
                left.handle ===
                (right as { handle: string }).handle
            );
        case "struct":
        case "enum":
            return (
                left.name ===
                (right as { name: string }).name
            );
        case "optional":
            return dataTypesEqual(
                left.inner,
                (right as { inner: DataType }).inner,
            );
        case "vector":
        case "span":
            return dataTypesEqual(
                left.element,
                (right as { element: DataType }).element,
            );
        case "tuple":
            return (
                left.arity ===
                (right as { arity: number }).arity
            );
        case "enummap": {
            const other = right as {
                enumName: string;
                element: DataType;
            };
            return (
                left.enumName === other.enumName &&
                dataTypesEqual(left.element, other.element)
            );
        }
        case "table":
            return (
                left.dimensions.join(",") ===
                (
                    right as { dimensions: number[] }
                ).dimensions.join(",")
            );
    }
}

function sanitizeIdentifier(name: string): string {
    const cleaned = sanitizeCppIdentifier(name);
    const prefixed = /^[0-9]/.test(cleaned)
        ? `_${cleaned}`
        : cleaned;
    const reserved = new Set([
        "auto", "bool", "break", "case", "catch", "char",
        "class", "const", "continue", "default", "delete",
        "do", "double", "else", "enum", "explicit",
        "export", "extern", "false", "float", "for",
        "friend", "goto", "if", "inline", "int", "long",
        "namespace", "new", "operator", "private",
        "protected", "public", "register", "return",
        "short", "signed", "sizeof", "static", "struct",
        "switch", "template", "this", "throw", "true",
        "try", "typedef", "typeid", "typename", "union",
        "unsigned", "using", "virtual", "void", "volatile",
        "while",
    ]);
    return reserved.has(prefixed)
        ? `${prefixed}_`
        : prefixed;
}

/**
 * Maps checker types onto native data types and owns the generated struct,
 * enum, and static-table definitions emitted ahead of `main`.
 */
export class DataTypeRegistry {
    private readonly structsByKey = new Map<
        string,
        DataStructDefinition
    >();
    private readonly structNames = new Set<string>();
    private readonly enumsByKey = new Map<
        string,
        DataEnumDefinition
    >();
    private readonly enumNames = new Set<string>();
    private readonly tables = new Map<
        ts.Node,
        DataTableDefinition
    >();
    private readonly tableNames = new Set<string>();
    /**
     * One-dimensional constant arrays, materialized so a runtime index
     * can reach them. The numeric tables above are doubles all the way
     * down and may nest; these are flat and hold any scalar element.
     */
    private readonly tagTables = new Map<
        ts.Node,
        {
            name: string;
            elementCppType: string;
            elements: string[];
        }
    >();
    private readonly mappingInProgress =
        new Set<ts.Type>();
    private anonymousStructIndex = 0;
    private anonymousEnumIndex = 0;

    public constructor(
        private readonly checker: ts.TypeChecker,
        private readonly fail: Fail,
    ) {}

    public get empty(): boolean {
        return (
            this.structsByKey.size === 0 &&
            this.enumsByKey.size === 0 &&
            this.tables.size === 0 &&
            this.tagTables.size === 0
        );
    }

    /**
     * Maps a checker type to a data type, or undefined when the type does
     * not belong to the plain-data subset (engine handles, promises,
     * functions, strings, ...).
     */
    public fromTsType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        if (
            (type.flags & ts.TypeFlags.Union) !== 0 &&
            (type.flags & ts.TypeFlags.Boolean) === 0 &&
            (type as ts.UnionType).types.some(
                (member) =>
                    (member.flags &
                        (ts.TypeFlags.Null |
                            ts.TypeFlags.Undefined)) !==
                    0,
            )
        ) {
            const inner = this.fromNonNullableType(
                this.checker.getNonNullableType(type),
                node,
            );
            if (!inner) {
                return undefined;
            }
            return { kind: "optional", inner };
        }
        return this.fromNonNullableType(type, node);
    }

    public requireFromTsType(
        type: ts.Type,
        node: ts.Node,
        role: string,
    ): DataType {
        const mapped = this.fromTsType(type, node);
        if (!mapped) {
            this.fail(
                node,
                `${role} type '${this.checker.typeToString(type)}' is outside the supported plain-data subset.`,
            );
        }
        return mapped;
    }

    private fromNonNullableType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        if (
            (type.flags &
                (ts.TypeFlags.Number |
                    ts.TypeFlags.NumberLiteral)) !==
            0
        ) {
            return numberType;
        }
        if (
            (type.flags &
                (ts.TypeFlags.Boolean |
                    ts.TypeFlags.BooleanLiteral)) !==
            0
        ) {
            return booleanType;
        }
        if ((type.flags & ts.TypeFlags.Union) !== 0) {
            return this.fromUnionType(
                type as ts.UnionType,
            );
        }
        if ((type.flags & ts.TypeFlags.Object) === 0) {
            return undefined;
        }
        const recordMap = this.fromRecordType(type, node);
        if (recordMap) {
            return recordMap;
        }
        if (type.symbol?.name === "Float32Array") {
            return { kind: "f32array" };
        }
        if (type.symbol?.name === "Uint32Array") {
            return { kind: "u32array" };
        }
        if (
            type.symbol?.name === "Mesh" &&
            declaredInBabylonLite(type.symbol)
        ) {
            return { kind: "handle", handle: "mesh" };
        }
        const objectType = type as ts.ObjectType;
        if (
            (objectType.objectFlags &
                ts.ObjectFlags.Reference) !==
            0
        ) {
            const reference = type as ts.TypeReference;
            const target = reference.target;
            if (
                (target.objectFlags &
                    ts.ObjectFlags.Tuple) !==
                0
            ) {
                return this.fromTupleType(
                    reference,
                    node,
                );
            }
            const symbolName = type.symbol?.name;
            if (
                symbolName === "Array" ||
                symbolName === "ReadonlyArray"
            ) {
                const [elementType] =
                    this.checker.getTypeArguments(
                        reference,
                    );
                if (!elementType) {
                    return undefined;
                }
                const element = this.fromTsType(
                    elementType,
                    node,
                );
                if (!element) {
                    return undefined;
                }
                return symbolName === "Array"
                    ? { kind: "vector", element }
                    : { kind: "span", element };
            }
        }
        if (
            type.getCallSignatures().length > 0 ||
            type.getConstructSignatures().length > 0
        ) {
            return undefined;
        }
        return this.fromStructType(type, node);
    }

    private fromUnionType(
        type: ts.UnionType,
    ): DataType | undefined {
        const members = type.types;
        if (
            members.every(
                (member) =>
                    (member.flags &
                        (ts.TypeFlags.Number |
                            ts.TypeFlags.NumberLiteral)) !==
                    0,
            )
        ) {
            return numberType;
        }
        if (
            members.every(
                (member) =>
                    (member.flags &
                        (ts.TypeFlags.Boolean |
                            ts.TypeFlags.BooleanLiteral)) !==
                    0,
            )
        ) {
            return booleanType;
        }
        if (
            members.every(
                (member) =>
                    (member.flags &
                        ts.TypeFlags.StringLiteral) !==
                    0,
            )
        ) {
            return this.registerEnum(
                type,
                members.map(
                    (member) =>
                        (member as ts.StringLiteralType)
                            .value,
                ),
            );
        }
        return undefined;
    }

    private fromTupleType(
        reference: ts.TypeReference,
        node: ts.Node,
    ): DataType | undefined {
        const elements =
            this.checker.getTypeArguments(reference);
        if (elements.length === 0) {
            return undefined;
        }
        for (const element of elements) {
            const mapped = this.fromTsType(element, node);
            if (!mapped || mapped.kind !== "number") {
                return undefined;
            }
        }
        return {
            kind: "tuple",
            arity: elements.length,
        };
    }

    private fromStructType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        if (this.mappingInProgress.has(type)) {
            return undefined;
        }
        this.mappingInProgress.add(type);
        try {
            return this.fromStructTypeInner(type, node);
        } finally {
            this.mappingInProgress.delete(type);
        }
    }

    private fromStructTypeInner(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        const properties =
            this.checker.getPropertiesOfType(type);
        if (properties.length === 0) {
            return undefined;
        }
        const fields: DataStructField[] = [];
        for (const property of properties) {
            const declaration =
                property.valueDeclaration ??
                property.declarations?.[0];
            const propertyType =
                this.checker.getTypeOfSymbolAtLocation(
                    property,
                    declaration ?? node,
                );
            const mapped = this.fromTsType(
                propertyType,
                declaration ?? node,
            );
            if (!mapped) {
                return undefined;
            }
            fields.push({
                name: sanitizeIdentifier(property.name),
                type: mapped,
            });
        }
        const preferredName =
            type.aliasSymbol?.name ??
            (type.symbol &&
            type.symbol.name !== "__type" &&
            type.symbol.name !== "__object"
                ? type.symbol.name
                : undefined);
        const key = `${fields
            .map(
                (field) =>
                    `${field.name}:${this.typeKey(field.type)}`,
            )
            .join(",")}`;
        const existing = this.structsByKey.get(key);
        if (existing) {
            return {
                kind: "struct",
                name: existing.name,
            };
        }
        const name = this.uniqueName(
            preferredName
                ? sanitizeIdentifier(preferredName)
                : `Record${++this.anonymousStructIndex}`,
            this.structNames,
        );
        this.structsByKey.set(key, { name, fields });
        return { kind: "struct", name };
    }

    /**
     * Recognizes `Record<Union, T>` where the key is a string-literal
     * union, and lowers it to a fixed slot per union member.
     *
     * The check is on the `Record` alias itself, so an interface that
     * happens to declare the same property names stays the struct it
     * already was.
     */
    private fromRecordType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        if (type.aliasSymbol?.name !== "Record") {
            return undefined;
        }
        const [keyType, valueType] =
            type.aliasTypeArguments ?? [];
        if (!keyType || !valueType) {
            return undefined;
        }
        const key = this.fromTsType(keyType, node);
        if (key?.kind !== "enum") {
            return undefined;
        }
        const element = this.fromTsType(valueType, node);
        if (!element) {
            return undefined;
        }
        return {
            kind: "enummap",
            enumName: key.name,
            element,
        };
    }

    /**
     * The union's members in tag order, which is the order the slots of
     * a `Record` keyed by it are laid out in.
     */
    public enumMembers(name: string): string[] {
        const definition = [
            ...this.enumsByKey.values(),
        ].find((entry) => entry.name === name);
        return definition ? [...definition.members] : [];
    }

    private registerEnum(
        type: ts.UnionType,
        literals: string[],
    ): DataType {
        const sorted = [...literals].sort();
        const key = sorted.join("|");
        const existing = this.enumsByKey.get(key);
        if (existing) {
            return {
                kind: "enum",
                name: existing.name,
            };
        }
        const preferredName = type.aliasSymbol?.name;
        const name = this.uniqueName(
            preferredName
                ? sanitizeIdentifier(preferredName)
                : `Enum${++this.anonymousEnumIndex}`,
            this.enumNames,
        );
        this.enumsByKey.set(key, {
            name,
            members: sorted,
        });
        return { kind: "enum", name };
    }

    /**
     * Resolves a string literal against an enum data type, failing when the
     * literal is not a member.
     */
    public enumMemberCpp(
        dataType: DataType & { kind: "enum" },
        literal: string,
        node: ts.Node,
    ): string {
        const definition = [
            ...this.enumsByKey.values(),
        ].find((entry) => entry.name === dataType.name);
        if (
            !definition ||
            !definition.members.includes(literal)
        ) {
            this.fail(
                node,
                `'${literal}' is not a member of ${dataType.name}.`,
            );
        }
        return `bblscene::${dataType.name}::${sanitizeIdentifier(literal)}`;
    }

    /**
     * A struct's field types, or an empty list when the struct is not
     * registered. Unlike `structFields` this asks a question rather
     * than asserting an answer, so it needs no node to blame.
     */
    public structFieldTypes(name: string): DataType[] {
        const definition = [
            ...this.structsByKey.values(),
        ].find((entry) => entry.name === name);
        return (definition?.fields ?? []).map(
            (field) => field.type,
        );
    }

    public structFields(
        name: string,
        node: ts.Node,
    ): DataStructField[] {
        const definition = [
            ...this.structsByKey.values(),
        ].find((entry) => entry.name === name);
        if (!definition) {
            this.fail(
                node,
                `Unknown generated struct '${name}'.`,
            );
        }
        return definition.fields;
    }

    public structField(
        name: string,
        field: string,
        node: ts.Node,
    ): DataStructField {
        const found = this.structFields(name, node).find(
            (candidate) => candidate.name === field,
        );
        if (!found) {
            this.fail(
                node,
                `Struct ${name} has no field '${field}'.`,
            );
        }
        return found;
    }

    /**
     * Materializes a uniform static numeric table (nested readonly array
     * literals with numeric leaves) as a namespace-scope constant. Returns
     * the table name and dimensions.
     */
    public registerTable(
        declaration: ts.Node,
        preferredName: string,
        literal: ts.ArrayLiteralExpression,
        compileLeaf: (
            expression: ts.Expression,
        ) => number,
    ): { name: string; dimensions: number[] } {
        const existing = this.tables.get(declaration);
        if (existing) {
            return {
                name: existing.name,
                dimensions: existing.dimensions,
            };
        }
        const dimensions = this.tableDimensions(
            literal,
            compileLeaf,
        );
        const name = this.uniqueName(
            sanitizeIdentifier(preferredName),
            this.tableNames,
        );
        const values = this.renderTableValues(
            literal,
            dimensions,
            compileLeaf,
        );
        this.tables.set(declaration, {
            name,
            dimensions,
            values,
        });
        return { name, dimensions };
    }

    /**
     * Materializes a one-dimensional constant array as a
     * namespace-scope constant, so an index computed at runtime can
     * read it. Keyed by the array's declaration, so every use site
     * shares one constant. Returns the constant's name.
     */
    public registerConstantArray(
        declaration: ts.Node,
        preferredName: string,
        elementCppType: string,
        elements: string[],
    ): string {
        const existing = this.tagTables.get(declaration);
        if (existing) {
            return existing.name;
        }
        const name = this.uniqueName(
            sanitizeIdentifier(preferredName),
            this.tableNames,
        );
        this.tagTables.set(declaration, {
            name,
            elementCppType,
            elements,
        });
        return name;
    }

    private tableDimensions(
        literal: ts.ArrayLiteralExpression,
        compileLeaf: (
            expression: ts.Expression,
        ) => number,
    ): number[] {
        if (literal.elements.length === 0) {
            this.fail(
                literal,
                "Static tables require non-empty array literals.",
            );
        }
        const first = literal.elements[0]!;
        if (ts.isArrayLiteralExpression(first)) {
            const inner = this.tableDimensions(
                first,
                compileLeaf,
            );
            for (const element of literal.elements) {
                if (
                    !ts.isArrayLiteralExpression(element)
                ) {
                    this.fail(
                        element,
                        "Static tables require uniform nesting.",
                    );
                }
                const elementDims = this.tableDimensions(
                    element,
                    compileLeaf,
                );
                if (
                    elementDims.join(",") !==
                    inner.join(",")
                ) {
                    this.fail(
                        element,
                        "Static tables require uniform dimensions.",
                    );
                }
            }
            return [literal.elements.length, ...inner];
        }
        for (const element of literal.elements) {
            compileLeaf(element);
        }
        return [literal.elements.length];
    }

    private renderTableValues(
        literal: ts.ArrayLiteralExpression,
        dimensions: number[],
        compileLeaf: (
            expression: ts.Expression,
        ) => number,
    ): string {
        // Every level is a std::array aggregate, so each level carries the
        // double-brace form instead of relying on brace elision.
        if (dimensions.length === 1) {
            return `{{${literal.elements
                .map((element) =>
                    doubleLiteral(compileLeaf(element)),
                )
                .join(", ")}}}`;
        }
        return `{{${literal.elements
            .map((element) =>
                this.renderTableValues(
                    element as ts.ArrayLiteralExpression,
                    dimensions.slice(1),
                    compileLeaf,
                ),
            )
            .join(", ")}}}`;
    }

    public tableCppType(dimensions: number[]): string {
        let cpp = "double";
        for (
            let index = dimensions.length - 1;
            index >= 0;
            index -= 1
        ) {
            cpp = `std::array<${cpp}, ${dimensions[index]}>`;
        }
        return cpp;
    }

    public cppType(dataType: DataType): string {
        switch (dataType.kind) {
            case "number":
                return "double";
            case "boolean":
                return "bool";
            case "handle":
                return "bbl::MeshHandle";
            case "struct":
                return `bblscene::${dataType.name}`;
            case "enum":
                return `bblscene::${dataType.name}`;
            case "optional":
                return `bbl::js::Nullable<${this.cppType(dataType.inner)}>`;
            case "vector":
                return `bbl::js::Array<${this.cppType(dataType.element)}>`;
            case "span":
                return `bbl::js::Span<const ${this.cppType(dataType.element)}>`;
            case "tuple":
                return `bbl::js::Tuple<${dataType.arity}>`;
            case "enummap":
                return `bbl::js::EnumMap<${this.cppType(dataType.element)}, ${this.enumMembers(dataType.enumName).length}>`;
            case "table":
                return `const ${this.tableCppType(dataType.dimensions)}&`;
            case "f32array":
                return "bbl::js::F32Array";
            case "u32array":
                return "bbl::js::U32Array";
        }
    }

    private typeKey(dataType: DataType): string {
        switch (dataType.kind) {
            case "number":
                return "n";
            case "boolean":
                return "b";
            case "handle":
                return `h(${dataType.handle})`;
            case "struct":
                return `s(${dataType.name})`;
            case "enum":
                return `e(${dataType.name})`;
            case "optional":
                return `o(${this.typeKey(dataType.inner)})`;
            case "vector":
                return `v(${this.typeKey(dataType.element)})`;
            case "span":
                return `r(${this.typeKey(dataType.element)})`;
            case "tuple":
                return `t${dataType.arity}`;
            case "enummap":
                return `m(${dataType.enumName},${this.typeKey(dataType.element)})`;
            case "table":
                return `g(${dataType.dimensions.join("x")})`;
            case "f32array":
                return "f32";
            case "u32array":
                return "u32";
        }
    }

    private uniqueName(
        preferred: string,
        used: Set<string>,
    ): string {
        let name = preferred;
        let suffix = 1;
        while (
            used.has(name) ||
            this.structNames.has(name) ||
            this.enumNames.has(name) ||
            this.tableNames.has(name)
        ) {
            name = `${preferred}${++suffix}`;
        }
        used.add(name);
        return name;
    }

    /**
     * Renders the generated enum, struct, and table definitions in
     * dependency order inside `namespace bblscene`.
     */
    public renderPreamble(): string {
        if (this.empty) {
            return "";
        }
        const lines: string[] = ["namespace bblscene {", ""];
        for (const definition of this.enumsByKey.values()) {
            lines.push(
                `enum class ${definition.name} {`,
                ...definition.members.map(
                    (member) =>
                        `    ${sanitizeIdentifier(member)},`,
                ),
                "};",
                "",
            );
        }
        const emitted = new Set<string>();
        const structs = [...this.structsByKey.values()];
        const emitStruct = (
            definition: DataStructDefinition,
        ): void => {
            if (emitted.has(definition.name)) {
                return;
            }
            emitted.add(definition.name);
            for (const field of definition.fields) {
                for (const dependency of this.structDependencies(
                    field.type,
                )) {
                    const nested = structs.find(
                        (candidate) =>
                            candidate.name === dependency,
                    );
                    if (nested) {
                        emitStruct(nested);
                    }
                }
            }
            lines.push(
                `struct ${definition.name} {`,
                ...definition.fields.map(
                    (field) =>
                        `    ${this.cppType(field.type)} ${field.name};`,
                ),
                "};",
                "",
            );
        };
        for (const definition of structs) {
            emitStruct(definition);
        }
        for (const table of this.tables.values()) {
            lines.push(
                `inline const ${this.tableCppType(table.dimensions)} ${table.name} = ${table.values};`,
                "",
            );
        }
        for (const table of this.tagTables.values()) {
            lines.push(
                `inline const std::array<${table.elementCppType}, ${table.elements.length}> ${table.name}{${table.elements.join(", ")}};`,
                "",
            );
        }
        lines.push("}  // namespace bblscene");
        return lines.join("\n");
    }

    private structDependencies(
        dataType: DataType,
    ): string[] {
        switch (dataType.kind) {
            case "struct":
                return [dataType.name];
            case "optional":
                return this.structDependencies(
                    dataType.inner,
                );
            case "vector":
            case "span":
                return this.structDependencies(
                    dataType.element,
                );
            default:
                return [];
        }
    }
}

export { doubleLiteral };
