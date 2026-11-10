import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runSelfCheckingProgram } from "./self-checking-program.js";

test("Object.getPrototypeOf answers with the prototype of a value's kind", async (t) => {
    const source = `
        function canonical(value: unknown, path = "root"): string {
            if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
            if (typeof value === "number") return JSON.stringify(value);
            if (Array.isArray(value)) return \`[\${value.map((item, index) => canonical(item, \`\${path}[\${index}]\`)).join(",")}]\`;
            if (typeof value === "object") {
                const record = value as Record<string, unknown>;
                const proto = Object.getPrototypeOf(record);
                if (proto !== Object.prototype && proto !== null) throw new Error(\`\${path} must contain only plain objects\`);
                return \`{\${Object.keys(record).sort().map((key) => \`\${JSON.stringify(key)}:\${canonical(record[key], \`\${path}.\${key}\`)}\`).join(",")}}\`;
            }
            throw new Error(\`\${path} unsupported\`);
        }
        const parsed = canonical(JSON.parse('{"b":[1,{"c":null}],"a":"x"}'));
        if (parsed !== '{"a":"x","b":[1,{"c":null}]}') throw new Error(parsed);
        const written = canonical({ z: 1, y: [true, "t"] });
        if (written !== '{"y":[true,"t"],"z":1}') throw new Error(written);

        const doc = JSON.parse('{"a":[1],"n":null,"s":"x","k":2,"b":true,"o":{}}') as Record<string, unknown>;
        if (Object.getPrototypeOf(doc) !== Object.prototype) throw new Error("document object");
        if (Object.getPrototypeOf(doc.o) !== Object.prototype) throw new Error("nested object");
        if (Object.getPrototypeOf(doc.a) !== Array.prototype) throw new Error("document array");
        if (Object.getPrototypeOf(doc.a) === Object.prototype) throw new Error("an array is no plain object");
        if (Object.getPrototypeOf(doc.s) !== String.prototype) throw new Error("document string");
        if (Object.getPrototypeOf(doc.k) !== Number.prototype) throw new Error("document number");
        if (Object.getPrototypeOf(doc.b) !== Boolean.prototype) throw new Error("document boolean");
        if (Object.getPrototypeOf(doc.a) !== Object.getPrototypeOf(JSON.parse("[]"))) throw new Error("two documents");
        let thrown = 0;
        try { Object.getPrototypeOf(doc.n); } catch (error) { if (error instanceof TypeError) thrown++; }
        try { Object.getPrototypeOf(doc.missing); } catch (error) { if (error instanceof TypeError) thrown++; }
        if (thrown !== 2) throw new Error("null and undefined throw TypeError");

        const literal = { a: 1, b: "x" };
        const proto = Object.getPrototypeOf(literal);
        if (proto !== Object.prototype || proto === null) throw new Error("literal");
        if (typeof proto !== "object" || !proto) throw new Error("a prototype is a truthy object");
        let held = Object.getPrototypeOf(doc);
        if (held !== proto) throw new Error("held prototype");
        held = Array.prototype;
        if (held !== Array.prototype || held === proto) throw new Error("reassigned prototype");
        if (Object.prototype === Array.prototype || Object.prototype !== Object.prototype) throw new Error("constants");
        const counts: Record<string, number> = { one: 1 };
        if (Object.getPrototypeOf(counts) !== Object.prototype) throw new Error("dictionary");
        const list = [1, 2, 3];
        if (Object.getPrototypeOf(list) !== Array.prototype) throw new Error("array");
        const pair: [string, number] = ["a", 1];
        if (Object.getPrototypeOf(pair) !== Array.prototype) throw new Error("tuple");
        if (Object.getPrototypeOf("text") !== String.prototype) throw new Error("string");
        if (Object.getPrototypeOf(list.length) !== Number.prototype) throw new Error("number");
        if (Object.getPrototypeOf(list.length > 1) !== Boolean.prototype) throw new Error("boolean");
        let calls = 0;
        function make(): { n: number } { calls++; return { n: calls }; }
        if (Object.getPrototypeOf(make()) !== Object.prototype || calls !== 1) throw new Error("the argument is evaluated once");
        class Box { constructor(public value: number) {} }
        if (Object.getPrototypeOf(new Box(1)) !== Box.prototype) throw new Error("class instance");
    `;
    assert.match(compileSource(source).cpp, /\.prototype\(\)/);
    await runSelfCheckingProgram(t, "object-prototypes/semantics", source);
});

const read = `
    const doc = JSON.parse('{"a":1}') as Record<string, unknown>;
    if (Object.getPrototypeOf(doc) !== Object.prototype) throw new Error("document");
`;

test("a program that gives an object another prototype refuses Object.getPrototypeOf", () => {
    for (const foreign of [
        "const bare: Record<string, number> = Object.create(null); bare.a = 1;",
        "const base = { a: 1 }; Object.setPrototypeOf(base, null);",
        "const base = { a: 1 }; Reflect.setPrototypeOf(base, null);",
        "const base: Record<string, unknown> = {}; base.__proto__ = null;",
        "const base = { __proto__: null, a: 1 };",
        'const grouped = Object.groupBy([1, 2], (value) => (value > 1 ? "big" : "small"));',
        'const year = /(?<year>[0-9]+)/.exec("2026")?.groups?.year;',
    ])
        assert.throws(
            () =>
                compileSource(`${read} function later(): void { ${foreign} }`),
            /Object\.getPrototypeOf answers exactly only in a program that gives no object another prototype; .*:\d+ does\./,
            foreign,
        );
});

test("Object.getPrototypeOf refuses by name a prototype it does not represent", () => {
    for (const [source, refusal] of [
        [
            "class Box { constructor(public value: number) {} } const box = new Box(1); if (Object.getPrototypeOf(box) === Object.prototype) throw new Error('box');",
            /reads a class instance's prototype in a comparison with a class's prototype only/,
        ],
        [
            "const index = new Map<string, number>(); if (Object.getPrototypeOf(index) === Object.prototype) throw new Error('map');",
            /does not represent the prototype of 'Map<string, number>'/,
        ],
        [
            "function one(): number { return 1; } if (Object.getPrototypeOf(one) === Object.prototype) throw new Error('function');",
            /does not represent the prototype of '\(\) => number'/,
        ],
        [
            "const bytes = new Uint8Array(2); if (Object.getPrototypeOf(bytes) === Object.prototype) throw new Error('bytes');",
            /does not represent the prototype of 'Uint8Array/,
        ],
        [
            "if (Object.getPrototypeOf(Array.prototype) !== Object.prototype) throw new Error('chain');",
            /does not represent the prototype of a prototype/,
        ],
        [
            "function pick(flag: boolean): { a: number } | null { return flag ? { a: 1 } : null; } const value = pick(true); if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('absent');",
            /needs a value that cannot be null or undefined/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), refusal, source);
});
