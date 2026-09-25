/**
 * Library globals are resolved, not matched by name: the library's `Math`
 * folds and spells through the compiler's Math table, while a scene's own
 * binding of the same name is the scene's value and lowers as such.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { isGlobalUndefined } from "../src/compiler/symbols.js";

/** A scene running `body` in `main`, with `declarations` at module scope. */
const scene = (body: string, declarations = ""): string => `
    import { createEngine, createBox } from "@babylonjs/lite";
    ${declarations}
    async function main() {
        const engine = await createEngine({});
        const box = createBox(engine, { size: 1 });
        ${body}
    }
    void main();
`;

test("the library's Math folds an exact member at generation", () => {
    const result = compileSource(scene("box.position.x = Math.floor(3.7);"), {
        fileName: "library-math.ts",
    });
    assert.match(result.cpp, /position\.x = 3\.0;/);
    assert.doesNotMatch(result.cpp, /std::floor/);
});

test("globalThis.Math is the library's Math", () => {
    const result = compileSource(
        scene("box.position.x = globalThis.Math.floor(3.7);"),
        { fileName: "global-this-math.ts" },
    );
    assert.match(result.cpp, /position\.x = 3\.0;/);
});

test("a scene binding named Math is the scene's own value", () => {
    const result = compileSource(
        scene(
            "const Math = { floor: (value: number) => value + 100 };\n" +
                "box.position.x = Math.floor(3.7);",
        ),
        { fileName: "scene-math.ts" },
    );
    assert.match(result.cpp, /return \(v_fn\d+_value \+ 100\.0\);/);
    assert.match(result.cpp, /make_closure\([^\n]+\)\(3\.7\)/);
    assert.doesNotMatch(result.cpp, /position\.x = 3\.0;/);
});

test("a module function named Number is the scene's own call", () => {
    const result = compileSource(
        scene(
            'box.position.x = Number("3");',
            "function Number(text: string): number { return text.length + 40; }",
        ),
        { fileName: "scene-number.ts" },
    );
    assert.match(result.cpp, /position\.x = bblscene::Number\("3"\);/);
    assert.doesNotMatch(result.cpp, /number_from_string/);
});

test("a module function and class named String are the scene's own", () => {
    const conversion = compileSource(
        scene(
            "box.name = String(3);",
            'function String(value: number): string { return "s" + value; }',
        ),
        { fileName: "scene-string.ts" },
    );
    assert.match(conversion.cpp, /name = bbl::js::concat\("s", "3"\);/);
    const charCode = compileSource(
        scene(
            "box.name = String.fromCharCode(65);",
            'class String { static fromCharCode(code: number): string { return "c" + code; } }',
        ),
        { fileName: "scene-string-class.ts" },
    );
    assert.doesNotMatch(charCode.cpp, /string_from_char_code/);
});

test("a class named Map is the scene's own class", () => {
    const result = compileSource(
        scene(
            'const m = new Map(); box.position.x = m.get("abc");',
            "class Map { size = 7; get(key: string): number { return key.length + this.size; } }",
        ),
        { fileName: "scene-map.ts" },
    );
    assert.match(result.cpp, /bblscene::Map_get\(/);
    assert.doesNotMatch(result.cpp, /bbl::js::Map</);
});

test("a timer called through window lowers as the bare call", () => {
    const timers = (qualifier: string): string[] =>
        compileSource(
            scene(
                `const timer = ${qualifier}setTimeout(() => { box.position.x = 1; }, 100);\n` +
                    `${qualifier}clearTimeout(timer);\n` +
                    `const interval = ${qualifier}setInterval(() => { box.position.y = 2; }, 50);\n` +
                    `${qualifier}clearInterval(interval);`,
            ),
            { fileName: `timers-${qualifier || "bare"}.ts` },
        ).cpp.match(/bbl::(?:set|clear)_(?:timeout|interval)\(.*$/gm) ?? [];
    const bare = timers("");
    assert.deepEqual(
        bare.map((line) => /bbl::\w+/.exec(line)![0]),
        [
            "bbl::set_timeout",
            "bbl::clear_timeout",
            "bbl::set_interval",
            "bbl::clear_interval",
        ],
    );
    assert.deepEqual(timers("window."), bare);
});

test("only the global undefined is the absent value", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        export const absent = undefined;
        export const cast = (undefined as unknown);
        export function shadowed(undefined: number): number { return undefined; }
        `,
        "undefined-global.ts",
    );
    const judged: boolean[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isIdentifier(node) &&
            node.text === "undefined" &&
            !ts.isParameter(node.parent)
        )
            judged.push(isGlobalUndefined(checker, node));
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    assert.deepEqual(judged, [true, true, false]);
    const cast = sourceFile.statements[1] as ts.VariableStatement;
    assert.equal(
        isGlobalUndefined(
            checker,
            cast.declarationList.declarations[0]!.initializer!,
        ),
        true,
    );
});

test("a class named Object keeps its own static methods", () => {
    const result = compileSource(
        scene(
            "const o = { a: 1, b: 2 }; box.position.x = Object.keys(o).length;",
            "class Object { static keys(value: { a: number; b: number }): number[] { return [value.a, value.b, 9]; } }",
        ),
        { fileName: "scene-object.ts" },
    );
    assert.match(result.cpp, /bbl::js::Array<double>\{[^}]*9\.0\}/);
    assert.doesNotMatch(result.cpp, /Array<std::string>\{"a", "b"\}/);
});
