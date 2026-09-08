/**
 * Library globals are resolved, not matched by name: the library's `Math`
 * folds and spells through the compiler's Math table, while a scene's own
 * binding of the same name is the scene's value and lowers as such.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const scene = (body: string): string => `
    import { createEngine, createBox } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        const box = createBox(engine, { size: 1 });
        ${body}
    }
    void main();
`;

test("the library's Math folds an exact member at generation", () => {
    const result = compileSource(
        scene("box.position.x = Math.floor(3.7);"),
        { fileName: "library-math.ts" },
    );
    assert.match(result.cpp, /position\.x = 3\.0;/);
    assert.doesNotMatch(result.cpp, /std::floor/);
});

test("a scene binding named Math is the scene's own value", () => {
    const result = compileSource(
        scene(
            "const Math = { floor: (value: number) => value + 100 };\n" +
                "box.position.x = Math.floor(3.7);",
        ),
        { fileName: "scene-math.ts" },
    );
    assert.match(result.cpp, /position\.x = \(3\.7 \+ 100\.0\);/);
    assert.doesNotMatch(result.cpp, /position\.x = 3\.0;/);
});
