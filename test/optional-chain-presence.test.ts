/**
 * An optional chain short-circuits as a whole: `found?.position.y` is
 * `undefined` when `found` is, however many links follow the `?.`. The
 * owner's presence travels with every link, and a primitive read through
 * an owner that may be absent is selected against a default, so neither a
 * condition, a `??` nor a binding reads through the absent owner.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const scene = (body: string): string => `
    import {
        addToScene, createBox, createEngine, createSceneContext, createSphere,
        registerScene, startEngine,
    } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const sphere = createSphere(engine, { diameter: 1 });
        sphere.name = "hero";
        addToScene(scene, sphere);
        const box = createBox(engine, { size: 1 });
        addToScene(scene, box);
        const found = scene.meshes.find((m) => m.name === "hero");
        ${body}
        await registerScene(scene);
        await startEngine(engine);
    }
    void main();
`;

/**
 * The read `found?.position.y` guarded by the chain's presence; the entry's
 * engine is in scope, so the owned pair's engine is that engine.
 */
const guardedRead =
    /\(v_found\.has_value\(\) \? (?<read>bbl::handle_at\(v_engine\.meshes, \(\(\*v_found\)\)\.second\)\.position\.y) : std::remove_cvref_t<decltype\(\k<read>\)>\{\}\)/;

test("a condition over a chain continuation tests presence first", () => {
    const result = compileSource(
        scene("if (found?.position.y) box.position.y = 3;"),
        { fileName: "optional-chain-condition.ts" },
    );
    assert.match(
        result.cpp,
        /if \(\(v_found\.has_value\(\) && bbl::js::number_truthy\(\(v_found\.has_value\(\) \? /,
    );
    assert.match(result.cpp, guardedRead);
    assert.doesNotMatch(result.cpp, /number_truthy\(bbl::handle_at\(/);
});

test("a binding of a chain continuation reads through the guard", () => {
    const result = compileSource(
        scene(
            "const height = found?.position.y; box.position.x = height ?? 1;",
        ),
        { fileName: "optional-chain-binding.ts" },
    );
    assert.match(result.cpp, /double v_height = \(v_found\.has_value\(\) \? /);
    assert.match(result.cpp, guardedRead);
    // The fallback selects on the presence the binding snapshotted.
    assert.match(
        result.cpp,
        /\.position\.x = \(v_bblite_element_found_\d+ \? v_height : 1\.0\);/,
    );
});

test("optional-chain callback results retain intrinsic absence and identity", async (t) => {
    const source = `
        interface Handler { action?: (value: number) => number; }
        const action = (value: number): number => value + 4;
        const handlers = new Map<string, Handler>([
            ["empty", {}], ["present", { action }],
        ]);
        const expected = handlers.get("present")!.action;
        let lookups = 0;
        function lookup(key: string): Handler | undefined {
            lookups++;
            return handlers.get(key);
        }
        const missing = lookup("missing")?.action;
        const absent = lookup("empty")?.action;
        const present = lookup("present")?.action;
        if (missing !== undefined || absent !== undefined || missing || absent)
            throw new Error("absent callback became present");
        if (present !== expected || present?.(3) !== 7 || lookups !== 3)
            throw new Error("callback identity or receiver evaluation");
        let effects = 0;
        if (lookup("empty")?.action?.(++effects) !== undefined || effects !== 0)
            throw new Error("absent callback evaluated arguments");
        if (lookup("empty")?.["action"] !== undefined ||
            lookup("present")?.["action"] !== expected)
            throw new Error("indexed callback presence");
        interface Provider { read: () => ((value: number) => number) | undefined; }
        const providers = new Map<string, Provider>([
            ["empty", { read: (): ((value: number) => number) | undefined => undefined }],
            ["present", { read: () => expected }],
        ]);
        if (providers.get("empty")?.read() !== undefined ||
            providers.get("missing")?.read() !== undefined ||
            providers.get("present")?.read() !== expected)
            throw new Error("returned callback presence");
        interface State { value: number | null | undefined; count?: number; }
        const states = new Map<string, State>([
            ["null", { value: null }], ["zero", { value: 0, count: 0 }],
        ]);
        if (states.get("missing")?.value !== undefined ||
            states.get("null")?.value !== null || states.get("zero")?.value !== 0 ||
            states.get("null")?.count !== undefined || states.get("zero")?.count !== 0)
            throw new Error("scalar absence tags");
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ESNext },
        }).outputText,
    );
    const result = compileSource(source, {
        fileName: "optional-chain-callback-presence.ts",
    });
    const native = optionalNativeFixtureTools(false);
    await t.test("native", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "optional-chain-callback-presence",
            result.cpp,
        );
    });
});
