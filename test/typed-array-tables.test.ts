import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { float32Literal, floatLiteral } from "../src/cpp-literals.js";
import type { TypedArrayKind } from "../src/compiler/data-types.js";
import { float32TableLiteral } from "../src/compiler/data-types/typed-arrays.js";
import { typedArrayTable } from "../src/compiler/typed-array-tables.js";

/** A finite double as an exact rational `numerator / denominator`. */
function exactRational(value: number): {
    numerator: bigint;
    denominator: bigint;
} {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    const negative = bits >> 63n === 1n;
    const exponentBits = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & ((1n << 52n) - 1n);
    const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
    const exponent = (exponentBits === 0 ? 1 : exponentBits) - 1075;
    const signed = negative ? -mantissa : mantissa;
    return exponent >= 0
        ? { numerator: signed << BigInt(exponent), denominator: 1n }
        : { numerator: signed, denominator: 1n << BigInt(-exponent) };
}

/** A C++ decimal floating literal (suffix removed) as an exact rational. */
function decimalRational(text: string): {
    numerator: bigint;
    denominator: bigint;
} {
    const match = /^(-?)(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(text);
    assert.ok(match, `not a decimal literal: ${text}`);
    const [, sign, whole, fraction, exponentText] = match;
    const digits = BigInt(`${whole}${fraction}` || "0");
    const exponent = Number(exponentText ?? "0") - fraction!.length;
    const numerator = sign === "-" ? -digits : digits;
    return exponent >= 0
        ? { numerator: numerator * 10n ** BigInt(exponent), denominator: 1n }
        : { numerator, denominator: 10n ** BigInt(-exponent) };
}

function compare(
    a: { numerator: bigint; denominator: bigint },
    b: { numerator: bigint; denominator: bigint },
): number {
    const left = a.numerator * b.denominator;
    const right = b.numerator * a.denominator;
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Neighbouring float32 values of a float32, below and above. */
function float32Neighbours(value: number): [number, number] {
    const floats = new Float32Array(1);
    const words = new Int32Array(floats.buffer);
    floats[0] = value;
    const word = words[0]!;
    const step = (delta: number): number => {
        words[0] = word + delta;
        return floats[0]!;
    };
    return value > 0 || Object.is(value, 0)
        ? [value === 0 ? -step(1) : step(-1), step(1)]
        : [step(1), step(-1)];
}

/**
 * Whether a C++ compiler, which rounds a decimal `f` literal once to the
 * nearest float with ties to even, reads `literal` back as `expected`.
 */
function readsBackAs(literal: string, expected: number): boolean {
    assert.ok(literal.endsWith("f"), literal);
    const decimal = decimalRational(literal.slice(0, -1));
    if (expected === 0) return decimal.numerator === 0n;
    let [below, above] = float32Neighbours(expected);
    // Past the largest float, rounding treats 2^128 as the next value.
    if (!Number.isFinite(above)) above = expected + (expected - below);
    if (!Number.isFinite(below)) below = expected - (above - expected);
    const half = (a: number, b: number) => {
        const x = exactRational(a);
        const y = exactRational(b);
        return {
            numerator:
                x.numerator * y.denominator + y.numerator * x.denominator,
            denominator: 2n * x.denominator * y.denominator,
        };
    };
    const low = compare(decimal, half(below, expected));
    const high = compare(decimal, half(expected, above));
    const words = new Uint32Array(Float32Array.of(expected).buffer);
    const even = (words[0]! & 1) === 0;
    return (
        (low > 0 || (low === 0 && even)) && (high < 0 || (high === 0 && even))
    );
}

test("float32 table literals read back as the stored float", () => {
    const values = [
        -0.1555,
        0.4098,
        0.1,
        1 / 3,
        2 / 3,
        1e-7,
        -2.5,
        1e21,
        16777217,
        3.4028234663852886e38,
        1.1754943508222875e-38,
        1.401298464324817e-45,
        -1.401298464324817e-45,
        0.5,
        65504.5,
    ];
    let seed = 0x9e3779b9;
    const random = () => {
        seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
        return seed / 2 ** 32;
    };
    for (let index = 0; index < 20000; ++index) {
        const scale = 10 ** Math.floor(random() * 12 - 6);
        values.push((random() * 2 - 1) * scale);
        // Every float32 bit pattern class: random finite words.
        const word = Math.floor(random() * 2 ** 32);
        const float = new Float32Array(new Uint32Array([word]).buffer)[0]!;
        if (Number.isFinite(float)) values.push(float);
    }
    for (const value of values) {
        const literal = float32TableLiteral(value);
        assert.ok(literal, `no literal for ${value}`);
        assert.ok(
            readsBackAs(literal, Math.fround(value)),
            `${literal} does not read back as fround(${value})`,
        );
    }
    // The shortest round-trip decimal is the midpoint 33565870 here; the
    // table spells the float's exact value instead.
    assert.equal(float32TableLiteral(33565872), "33565872.0f");
    assert.equal(float32TableLiteral(-0), "-0.0f");
    assert.equal(float32TableLiteral(-0.1555), "-0.1555f");
    assert.equal(float32TableLiteral(1e39), undefined);
});

test("float32 literals read back in C++ as Math.fround of the number", () => {
    // Doubles that are themselves float32 midpoints: JavaScript stores the
    // even neighbour, while each one's shortest double decimal lies just
    // past the midpoint and a C++ `f` literal of it reads the odd one.
    const midpoints = [1 + 2 ** -24, -(1 + 2 ** -24), 1 + 3 * 2 ** -24];
    for (const value of midpoints) {
        assert.equal(String(value).length > 9, true);
        assert.equal(
            readsBackAs(`${String(value)}f`, Math.fround(value)),
            false,
            `${value} is a double-rounding case`,
        );
    }
    assert.equal(float32Literal(1 + 2 ** -24), "1.0f");
    assert.equal(float32Literal(-(1 + 2 ** -24)), "-1.0f");
    assert.equal(float32Literal(1 + 3 * 2 ** -24), "1.0000002f");
    // Every float write shares the rule: only a midpoint double changes spelling.
    assert.equal(floatLiteral(1 + 2 ** -24), "1.0f");
    assert.equal(floatLiteral(0.30000000000000004), "0.30000000000000004f");
    // An exact decimal midpoint reads back as JavaScript's even neighbour on
    // both paths, but no literal stands at one: 33565870 is passed over.
    assert.equal(float32Literal(33565870), "33565872.0f");
    assert.equal(float32Literal(33565872), "33565872.0f");
    assert.throws(() => float32Literal(1e39), /needs a finite value/);
    let seed = 0x2545f491;
    const random = () => {
        seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
        return seed / 2 ** 32;
    };
    const values = [...midpoints, 0, -0, 0.1, 16777217, 3.4028235e38];
    for (let index = 0; index < 20000; ++index) {
        const scale = 10 ** Math.floor(random() * 12 - 6);
        values.push((random() * 2 - 1) * scale);
        const word = Math.floor(random() * 2 ** 32);
        const float = new Float32Array(new Uint32Array([word]).buffer)[0]!;
        if (Number.isFinite(float)) values.push(float);
        // A double exactly halfway between this float and the next.
        const next = new Float32Array(new Uint32Array([word + 1]).buffer)[0]!;
        const half = (float + next) / 2;
        if (Number.isFinite(half) && Number.isFinite(Math.fround(half)))
            values.push(half);
    }
    for (const value of values) {
        const literal = float32Literal(value);
        assert.ok(
            readsBackAs(literal, Math.fround(value)),
            `${literal} does not read back as fround(${value})`,
        );
    }
});

test("integer tables store each element as the typed array would", () => {
    const text = [
        "-1.0",
        "4294967296.5",
        "4294967301.0",
        "1.9",
        "-1.9",
        "300.0",
        "-129.0",
        "1e+21",
    ];
    const values = text.map(Number);
    const kinds: [TypedArrayKind, (values: number[]) => ArrayLike<number>][] = [
        ["u32array", (v) => Uint32Array.from(v)],
        ["i32array", (v) => Int32Array.from(v)],
        ["u16array", (v) => Uint16Array.from(v)],
        ["i16array", (v) => Int16Array.from(v)],
        ["u8array", (v) => Uint8Array.from(v)],
        ["i8array", (v) => Int8Array.from(v)],
    ];
    for (const [kind, store] of kinds) {
        const table = typedArrayTable(kind, text);
        assert.ok(table, kind);
        const expected = Array.from(store(values), (value) =>
            kind.startsWith("u") ? `${value}u` : `${value}`,
        );
        assert.deepEqual(table.elements, expected, kind);
    }
    assert.deepEqual(typedArrayTable("i8array", ["(-3.0)", "2"])?.elements, [
        "-3",
        "2",
    ]);
    assert.equal(typedArrayTable("u32array", ["1.0", "count"]), undefined);
    assert.equal(typedArrayTable("u32array", ["(1.0 / 3.0)"]), undefined);
    assert.deepEqual(typedArrayTable("f64array", ["0.1", "count"])?.elements, [
        "0.1",
        "count",
    ]);
});

test("hoisted constant typed-array tables are stored in their element type", () => {
    const floats = Array.from(
        { length: 130 },
        (_, index) => ((index * 37) % 101) / 64 - 0.1555,
    );
    const words = Array.from(
        { length: 130 },
        (_, index) => index * 33554432 - 7,
    );
    const result = compileSource(`
        const floats = new Float32Array([${floats.join(", ")}]);
        const words = new Uint32Array([${words.join(", ")}]);
        if (floats[1] + words[1] < 0) throw new Error("unreachable");
    `);
    const floatTable = /std::array<float, 130> \w+\{([^}]*)\}/.exec(result.cpp);
    assert.ok(floatTable, "float table");
    assert.doesNotMatch(floatTable[1]!, /static_cast/);
    floatTable[1]!
        .split(", ")
        .forEach((literal, index) =>
            assert.ok(
                readsBackAs(literal, Math.fround(floats[index]!)),
                literal,
            ),
        );
    const wordTable = /std::array<std::uint32_t, 130> \w+\{([^}]*)\}/.exec(
        result.cpp,
    );
    assert.ok(wordTable, "uint32 table");
    assert.deepEqual(
        wordTable[1]!.split(", "),
        Array.from(Uint32Array.from(words), (value) => `${value}u`),
    );
});
