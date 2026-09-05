import { floatLiteral } from "./cpp-literals.js";
import { pinnedMathSpelling } from "./lowering/pinned-operators.js";
import { typeComponents, type ShaderExpression } from "./shader-ir.js";

export interface ShaderCppScalar {
    cpp: string;
    constant?: boolean;
    /** This lane is a normalized byte, with this expression as its byte index. */
    unorm8?: string;
    /** Unsuffixed WGSL constant arithmetic precedes f32 materialization. */
    abstract?: { value: number; integer: boolean };
}

/** Scalarize float WGSL expressions without changing their arithmetic tree. */
export function emitShaderCppExpression(
    expression: ShaderExpression,
    bindings: ReadonlyMap<string, readonly ShaderCppScalar[]>,
    options: { tabulateUnorm8?: boolean } = {},
): { components: string[]; declarations: string[] } {
    const declarations: string[] = [];
    const tables = new Map<string, string>();
    const abstract = (value: number, integer: boolean): ShaderCppScalar => {
        // Keep the bounded interpreter exact; wider abstract integers need a
        // BigInt path before they can be accepted (WGSL uses signed 64-bit).
        if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
            throw new Error("WGSL abstract constant is outside the supported exact range.");
        }
        return { cpp: floatLiteral(value), constant: true, abstract: { value, integer } };
    };
    const materialize = (value: ShaderCppScalar): ShaderCppScalar => {
        if (!value.abstract) return value;
        if (!Number.isFinite(Math.fround(value.abstract.value))) throw new Error("WGSL constant cannot materialize as f32.");
        return { cpp: floatLiteral(value.abstract.value), constant: true };
    };
    const swizzle = (value: readonly ShaderCppScalar[], member: string): ShaderCppScalar[] => {
        const alphabet = [...member].every(c => "xyzw".includes(c)) ? "xyzw" : "rgba";
        return [...member].map(c => {
            const lane = value[alphabet.indexOf(c)];
            if (!lane) throw new Error(`Unsupported WGSL swizzle '${member}'.`);
            return lane;
        });
    };
    const vectorize = (
        values: readonly (readonly ShaderCppScalar[])[],
        scalar: (args: ShaderCppScalar[]) => ShaderCppScalar,
    ): ShaderCppScalar[] => {
        const width = Math.max(...values.map(v => v.length));
        if (values.some(v => v.length !== 1 && v.length !== width)) throw new Error("Incompatible WGSL vector dimensions.");
        return Array.from({ length: width }, (_, i) => scalar(values.map(v => v[v.length === 1 ? 0 : i]!)));
    };
    const emit = (node: ShaderExpression): ShaderCppScalar[] => {
        switch (node.kind) {
            case "number": {
                const value = Number(node.value.endsWith("f") ? node.value.slice(0, -1) : node.value);
                if (!Number.isFinite(value)) throw new Error(`Unsupported float WGSL literal '${node.value}'.`);
                return [node.value.endsWith("f")
                    ? materialize(abstract(value, false))
                    : abstract(value, !/[.eE]/.test(node.value))];
            }
            case "path": {
                const value = bindings.get(node.parts.join("."));
                if (value) return [...value];
                const root = bindings.get(node.parts[0]!);
                if (!root || node.parts.length !== 2) throw new Error(`Unbound WGSL value '${node.parts.join(".")}'.`);
                return swizzle(root, node.parts[1]!);
            }
            case "member": return swizzle(emit(node.expression), node.member);
            case "construct": {
                if (node.type === "mat4x4<f32>") throw new Error(`Unsupported C++ shader construction '${node.type}'.`);
                const width = typeComponents(node.type);
                const lanes = node.arguments.flatMap(emit).map(materialize);
                if (lanes.length === 1) return Array.from({ length: width }, () => lanes[0]!);
                if (lanes.length !== width) throw new Error("Invalid WGSL constructor dimensions.");
                return lanes;
            }
            case "binary": {
                if (!["+", "-", "*", "/"].includes(node.operator)) throw new Error("C++ shader projection expects float arithmetic.");
                return vectorize([emit(node.left), emit(node.right)], ([a, b]) => {
                    if (a!.abstract && b!.abstract) {
                        const lhs = a!.abstract.value, rhs = b!.abstract.value;
                        const integer = a!.abstract.integer && b!.abstract.integer;
                        let result: number;
                        switch (node.operator) {
                            case "+": result = lhs + rhs; break;
                            case "-": result = lhs - rhs; break;
                            case "*": result = lhs * rhs; break;
                            case "/": result = integer ? Math.trunc(lhs / rhs) : lhs / rhs; break;
                            default: throw new Error("Expected abstract arithmetic.");
                        }
                        return abstract(result, integer);
                    }
                    return { cpp: `(${materialize(a!).cpp} ${node.operator} ${materialize(b!).cpp})`, constant: !!a!.constant && !!b!.constant };
                });
            }
            case "call": {
                const arities: Readonly<Record<string, number>> = { pow: 2, max: 2, min: 2, sqrt: 1, abs: 1 };
                if (arities[node.name] !== node.arguments.length) throw new Error(`Unsupported WGSL call '${node.name}'.`);
                return vectorize(node.arguments.map(emit), args => {
                    if (args.every(arg => arg.abstract)) {
                        const values = args.map(arg => arg.abstract!.value);
                        const integer = args.every(arg => arg.abstract!.integer);
                        switch (node.name) {
                            case "min": return abstract(Math.min(...values), integer);
                            case "max": return abstract(Math.max(...values), integer);
                            case "abs": return abstract(Math.abs(values[0]!), integer);
                            default: throw new Error(`Unsupported abstract WGSL builtin '${node.name}'.`);
                        }
                    }
                    args = args.map(materialize);
                    const call = (values: readonly string[]): string => `${pinnedMathSpelling(node.name)}(${values.join(", ")})`;
                    let cpp = call(args.map(a => a.cpp));
                    // Hoist expensive unary byte-domain work, preserving C++ f32
                    // evaluation. Tables are deduplicated across vector lanes.
                    if (options.tabulateUnorm8 && node.name === "pow" && args[0]!.unorm8 && args.slice(1).every(a => a.constant)) {
                        const body = call(["static_cast<float>(byte) / 255.0f", ...args.slice(1).map(a => a.cpp)]);
                        let name = tables.get(body);
                        if (!name) {
                            name = `shader_table_${tables.size}`;
                            tables.set(body, name);
                            declarations.push(`static const std::array<float, 256> ${name} = [] {
    std::array<float, 256> table{};
    for (std::size_t byte = 0; byte < table.size(); ++byte) table[byte] = ${body};
    return table;
}();`);
                        }
                        cpp = `${name}[${args[0]!.unorm8}]`;
                    }
                    return { cpp, constant: args.every(a => a.constant) };
                });
            }
        }
    };
    return { components: emit(expression).map(lane => materialize(lane).cpp), declarations };
}
