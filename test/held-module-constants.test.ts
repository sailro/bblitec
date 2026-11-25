import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

import { compileSource } from "../src/compiler.js";
import { memberStores } from "../src/compiler/held-constants.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { compileShaderMaterialFixture } from "./shader-material-fixture.js";

/**
 * Entries carry one of two frozen lanes, or none (`build` makes each from a
 * parsed row); a material composes its vertex stage and a uniform's default
 * from the lane it is handed, which the entry's lane or the default selects.
 */
const laneScene = (build: string, prelude = ""): string => `
    import { createEngine, createShaderMaterial, getShaderUniform, wgsl, type ShaderMaterial } from "babylon-lite";
    const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(/*PLACE*/, 1.0); return out; }\`;
    const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
    interface Lane { readonly key: string; readonly place: string; readonly gain: number }
    const PLAIN: Lane = Object.freeze({ key: "plain", place: "input.position", gain: 1 });
    const SCALED: Lane = Object.freeze({ key: "scaled", place: "input.position * 2.0", gain: 2 });
    interface Entry { readonly id: number; readonly lane?: Lane }
    ${prelude}
    function laneMaterial(lane: Lane): ShaderMaterial {
        return createShaderMaterial({
            vertexSource: wgsl\`\${VERTEX.replace("/*PLACE*/", lane.place)}\`,
            fragmentSource: FRAGMENT,
            attributes: ["position"],
            uniforms: ["worldViewProjection", { name: "uGain", type: "f32", defaultValue: lane === PLAIN ? 1 : lane.gain }],
        });
    }
    async function main() {
        await createEngine({});
        const rows = JSON.parse("[0, 1, 0]") as number[];
        const entries: Entry[] = rows.map((row, id) => ${build});
        let total = 0;
        for (const entry of entries) {
            const material = laneMaterial(entry.lane ?? PLAIN);
            total += getShaderUniform(material, "uGain") as number;
        }
        if (total !== TOTAL) throw new Error("lanes");
    }
    main();`;

test("a call compiles once per module constant a member's stores select", (t) => {
    // The entry's lane is SCALED where a row stored it, PLAIN elsewhere:
    // one arm per constant, told apart by the first member they differ in.
    const { compiled, cpp } = compileShaderMaterialFixture(
        laneScene(
            "(row === 1 ? { id, lane: SCALED } : { id })",
            "const TOTAL = 4;",
        ),
    );
    assert.deepEqual(
        compiled.manifest.customShaderPrograms.map(
            (program) =>
                /vec4<f32>\(([^,]+), 1\.0\)/.exec(program.vertexSource)?.[1],
        ),
        ["input.position * 2.0", "input.position"],
    );
    assert.match(
        compiled.cpp,
        /if \(v_bblite_case_value_\d+->key == "scaled"\) \{/,
    );
    assert.doesNotMatch(compiled.cpp, /->place ==/);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        native,
        "held-module-constants/selected-lanes",
        `${cpp}\n#define main generated_main\n${compiled.cpp}\n#undef main\nint main(){assert(generated_main()==0);}`,
        { expectedOutput: "" },
    );
});

test("a member no store sets leaves the one constant its default names", (t) => {
    // No row stores a lane, so every entry reads PLAIN: the call compiles
    // once, with no run-time test and no merged result.
    const { compiled, cpp } = compileShaderMaterialFixture(
        laneScene("({ id: id + row })", "const TOTAL = 3;"),
    );
    assert.equal(compiled.manifest.customShaderPrograms.length, 1);
    assert.doesNotMatch(compiled.cpp, /case_value|case_result/);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        native,
        "held-module-constants/default-lane",
        `${cpp}\n#define main generated_main\n${compiled.cpp}\n#undef main\nint main(){assert(generated_main()==0);}`,
        { expectedOutput: "" },
    );
});

test("a member some store sets to an object literal compiles once per row it selects", (t) => {
    // The stored literal is a row of its own beside PLAIN; both place the
    // vertex alike, so one program serves them, and each keeps its gain.
    const { compiled, cpp } = compileShaderMaterialFixture(
        laneScene(
            '(row === 1 ? { id, lane: { key: "odd", place: "input.position", gain: 3 } } : { id })',
            "const TOTAL = 5;",
        ),
    );
    assert.deepEqual(
        compiled.manifest.customShaderPrograms.map(
            (program) =>
                /vec4<f32>\(([^,]+), 1\.0\)/.exec(program.vertexSource)?.[1],
        ),
        ["input.position"],
    );
    assert.match(
        compiled.cpp,
        /if \(v_bblite_case_value_\d+->key == "odd"\) \{/,
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        native,
        "held-module-constants/literal-lane",
        `${cpp}\n#define main generated_main\n${compiled.cpp}\n#undef main\nint main(){assert(generated_main()==0);}`,
        { expectedOutput: "" },
    );
});

test("an untyped value read as an entry keeps the refusal", () => {
    // A parsed document handed where an entry is declared may hold any lane.
    assert.throws(
        () =>
            compileSource(
                laneScene(
                    "(row === 1 ? { id, lane: SCALED } : parsedEntry(id))",
                    'const TOTAL = 4;\n    function parsedEntry(id: number): Entry { return JSON.parse(`{"id":${id}}`); }',
                ),
                { fileName: "test/held-constants-untyped-entry.ts" },
            ),
        /Expected a string literal/,
    );
});

/**
 * The values the program `source` stores in the `idLane` member of an
 * `Entry`, spelled, or undefined where a site may give it another.
 */
function laneStores(source: string): string[] | undefined {
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        strict: true,
    };
    const host = ts.createCompilerHost(options, true);
    const file = ts.createSourceFile(
        "input.ts",
        `
        interface Lane { readonly key: string }
        interface Entry { id: number; idLane?: Lane }
        const A: Lane = Object.freeze({ key: "a" });
        const B: Lane = Object.freeze({ key: "b" });
        declare const text: string;
        declare const key: string;
        ${source}
        export {};`,
        options.target!,
        true,
    );
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (path, ...rest) =>
        path === "input.ts" ? file : read(path, ...rest);
    const program = ts.createProgram(["input.ts"], options, host);
    const checker = program.getTypeChecker();
    const entry = file.statements.find(
        (statement): statement is ts.InterfaceDeclaration =>
            ts.isInterfaceDeclaration(statement) &&
            statement.name.text === "Entry",
    )!;
    return memberStores(
        program,
        checker,
        "idLane",
        checker.getTypeAtLocation(entry.name),
    )?.map((value) => value.getText());
}

test("a member's stores are its literals' values and its assignments'", () => {
    assert.deepEqual(
        laneStores(`
            const entries: Entry[] = [{ id: 1, idLane: A }, { id: 2 }];
            const idLane = B;
            entries.push({ id: 3, idLane });
            entries[0]!.idLane = B;
            entries[1]!.idLane ??= A;
            const copy: Entry = { ...entries[0]!, id: 4 };
            const counts: Record<string, number> = {};
            counts[key] = 1;
            delete entries[2]!.idLane;
            Object.defineProperties(copy, { id: { value: 5 } });
            (globalThis as unknown as Record<string, unknown>)[key] = 1;
            const seen = (entry: Entry): unknown => entry;
            seen(copy);`),
        ["A", "idLane", "B", "A"],
    );
});

test("a member some site may give an unspelled value has no closed stores", () => {
    const opened = {
        "a method of its name": "const e = { id: 1, idLane() { return A; } };",
        "a class member of its name": "class Row { idLane?: Lane; id = 1; }",
        "a pattern target":
            "const e: Entry = { id: 1 }; ({ idLane: e.idLane } = { idLane: B });",
        "a run-time key on an entry":
            "const e: Entry = { id: 1 }; (e as Record<string, unknown>)[key] = B;",
        "a computed key": "const e: Entry = { id: 1, [key]: B };",
        "an assertion from an unrelated type":
            "const e = JSON.parse(text) as Entry;",
        "an untyped value handed as an entry":
            "const e: Entry = JSON.parse(text);",
        "a type guard":
            "function isEntry(value: unknown): value is Entry { return typeof value === 'object'; }",
        "a spread of an untyped value":
            "const e: Entry = { ...JSON.parse(text), id: 1 };",
        "a reflective definition":
            "const e: Entry = { id: 1 }; Object.defineProperty(e, key, { value: A });",
        "a descriptor of its name":
            "const e: Entry = { id: 1 }; Object.defineProperties(e, { idLane: { value: A } });",
        "a prototype set":
            "const e: Entry = Object.setPrototypeOf({ id: 1 }, { idLane: A });",
    };
    for (const [site, source] of Object.entries(opened))
        assert.equal(laneStores(source), undefined, site);
});
