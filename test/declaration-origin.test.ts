/**
 * A name is the engine's or the browser's only when that library declares
 * it: declaration origin, resolved the way the program resolves its
 * packages, decides the classification -- never the spelling of a name.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    declarationOrigin,
    type DeclarationOrigin,
} from "../src/compiler/symbols.js";
import { nullability, presentMembers } from "../src/compiler/type-facts.js";

/** The type each top-level `declare const` of a program is declared with. */
function declaredTypes(source: string): {
    checker: ts.TypeChecker;
    types: Map<string, ts.Type>;
} {
    const { checker, sourceFile } = createCompilerProgram(source, "origin.ts");
    const types = new Map<string, ts.Type>();
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name))
                types.set(
                    declaration.name.text,
                    checker.getTypeAtLocation(declaration.name),
                );
        }
    }
    return { checker, types };
}

function origins(type: ts.Type | undefined): DeclarationOrigin[] {
    const symbol = type?.aliasSymbol ?? type?.getSymbol();
    return [
        ...new Set((symbol?.declarations ?? []).map(declarationOrigin)),
    ].sort();
}

test("declaration origins follow the program's package resolution", () => {
    const { types } = declaredTypes(`
        import type { Mesh } from "@babylonjs/lite";
        interface Local { value: number }
        declare const mesh: Mesh;
        declare const local: Local;
        declare const element: Element;
        declare const device: GPUDevice;
        declare const list: number[];
        declare const entries: URLSearchParamsIterator<string>;
    `);
    assert.deepEqual(origins(types.get("mesh")), ["babylon"]);
    assert.deepEqual(origins(types.get("local")), ["program"]);
    assert.deepEqual(origins(types.get("element")), ["dom"]);
    assert.deepEqual(origins(types.get("device")), ["webgpu"]);
    assert.deepEqual(origins(types.get("list")), ["default-lib"]);
    // Declared only by the DOM's iteration library: still the DOM.
    assert.deepEqual(origins(types.get("entries")), ["dom"]);
});

test("the nullable-union member rule has one statement", () => {
    const { types } = declaredTypes(`
        import type { Mesh } from "@babylonjs/lite";
        declare const nullable: Mesh | null;
        declare const optional: number | undefined;
        declare const both: string | null | undefined;
        declare const voided: boolean | void;
        declare const plain: number;
        declare const flag: boolean | null;
    `);
    const facts = (name: string) => {
        const type = types.get(name)!;
        return {
            present: presentMembers(type).length,
            ...nullability(type),
        };
    };
    assert.deepEqual(facts("nullable"), {
        present: 1,
        null: true,
        undefined: false,
        void: false,
    });
    assert.deepEqual(facts("optional"), {
        present: 1,
        null: false,
        undefined: true,
        void: false,
    });
    assert.deepEqual(facts("both"), {
        present: 1,
        null: true,
        undefined: true,
        void: false,
    });
    // `void` reads as undefined; `boolean` is its two literal members.
    assert.deepEqual(facts("voided"), {
        present: 2,
        null: false,
        undefined: true,
        void: true,
    });
    assert.deepEqual(facts("plain"), {
        present: 1,
        null: false,
        undefined: false,
        void: false,
    });
    assert.deepEqual(facts("flag"), {
        present: 2,
        null: true,
        undefined: false,
        void: false,
    });
});

const scene = (declarations: string, body: string): string => `
    import {
        addToScene, createArcRotateCamera, createEngine, createSceneContext,
        createSphere, registerScene, startEngine,
    } from "@babylonjs/lite";
    ${declarations}
    async function main(): Promise<void> {
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        scene.camera = createArcRotateCamera(0, 1.2, 4, [0, 0, 0]);
        addToScene(scene, createSphere(engine, { diameter: 2 }));
        ${body}
        registerScene(scene);
        await startEngine(engine);
    }
    main();
`;

test("a program's own interface named Material held nullable is its own data", () => {
    const result = compileSource(
        scene(
            `
            interface Material { roughness: number; name: string }
            let current: Material | null = null;
            function pick(name: string): Material {
                if (!current) current = { roughness: 0.5, name };
                return current;
            }
            `,
            `scene.fixedDeltaMs = pick("wood").roughness;`,
        ),
        { fileName: "user-material.ts" },
    );
    assert.doesNotMatch(result.cpp, /MaterialHandle/);
    assert.match(result.cpp, /roughness/);
});

test("a program's own class named Mesh held nullable is not the engine mesh", () => {
    const result = compileSource(
        scene(
            `
            class Mesh {
                public vertices: number[] = [];
                public add(v: number): void { this.vertices.push(v); }
            }
            function first(list: Mesh[]): Mesh | null {
                return list.length > 0 ? list[0]! : null;
            }
            `,
            `
            const found: Mesh | null = first([new Mesh()]);
            if (found) found.add(3);
            scene.fixedDeltaMs = found ? found.vertices.length : 0;
            `,
        ),
        { fileName: "user-mesh.ts" },
    );
    assert.doesNotMatch(result.cpp, /std::optional<bbl::MeshHandle>/);
});

test("a program's own interface named DataView is a record, not the library view", () => {
    const result = compileSource(
        scene(
            `interface DataView { byteLength: number }`,
            `
            const view: DataView = { byteLength: 4 };
            scene.fixedDeltaMs = view.byteLength;
            `,
        ),
        { fileName: "user-dataview.ts" },
    );
    assert.doesNotMatch(result.cpp, /bbl::js::DataView/);
});
