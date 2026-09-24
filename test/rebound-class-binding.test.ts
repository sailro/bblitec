/**
 * A rebound binding is storage for its declared type. `let c: C | null =
 * null` followed by `c = new C()` stores a class instance into a binding
 * whose initializer is null, so the declaration maps its declared type as a
 * stored position: the local class takes its shared-object representation
 * (`bbl::js::Ref<CData>`) and null is that reference's empty state.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

// The class shares its name with a Babylon Lite type on purpose: the
// binding's representation follows the declaration's provenance, not its
// spelling.
const lazyInstance = `
    class Mesh {
        public values: number[] = [];
        add(value: number): void { this.values.push(value); }
    }
    let cached: Mesh | null = null;
    let created = 0;
    function getMesh(): Mesh {
        if (!cached) {
            cached = new Mesh();
            created += 1;
        }
        return cached;
    }
    getMesh().add(3);
    getMesh().add(4);
    if (created !== 1 || getMesh().values.length !== 2)
        throw new Error("lazy instance identity");
    cached = null;
    if (getMesh().values.length !== 0 || created !== 2)
        throw new Error("rebind to null");
    let current = new Mesh();
    const first = current;
    current = new Mesh();
    current.add(1);
    if (first === current || first.values.length !== 0 || current.values.length !== 1)
        throw new Error("rebound instance identity");
    let pending: Mesh | null = null;
    pending ??= new Mesh();
    pending.add(5);
    const kept = pending;
    pending ??= new Mesh();
    if (pending !== kept || pending.values.length !== 1)
        throw new Error("nullish assignment on a class reference");
    class Holder {
        public selected: Mesh | null = null;
        pick(mesh: Mesh): Mesh {
            this.selected ??= mesh;
            return this.selected;
        }
    }
    const holder = new Holder();
    const a = new Mesh();
    if (holder.pick(a) !== a || holder.pick(new Mesh()) !== a)
        throw new Error("nullish assignment on a class field");
`;

test("a rebound class binding stores a shared object", () => {
    const { cpp } = compileSource(lazyInstance, { fileName: "lazy.ts" });
    assert.match(cpp, /using Mesh = bbl::js::Ref<MeshData>;/);
    assert.match(cpp, /bblscene::Mesh v_cached = bblscene::Mesh\{\};/);
    assert.match(cpp, /v_cached = bblscene::Mesh\{\};/);
});

test("a lazily created engine-scene helper compiles beside the engine", () => {
    const { cpp } = compileSource(
        `
        import {
            addToScene,
            createArcRotateCamera,
            createEngine,
            createSceneContext,
            createSphere,
            registerScene,
            startEngine,
        } from "@babylonjs/lite";

        class Mesh {
            public vertices: number[] = [];
            public add(v: number): void { this.vertices.push(v); }
        }
        let cached: Mesh | null = null;
        function getMesh(): Mesh {
            if (!cached) cached = new Mesh();
            return cached;
        }

        async function main(): Promise<void> {
            const canvas = document.getElementById("app") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            scene.camera = createArcRotateCamera(0, 1.2, 4, [0, 0, 0]);
            const sphere = createSphere(engine, { diameter: 2 });
            addToScene(scene, sphere);
            getMesh().add(3);
            scene.fixedDeltaMs = getMesh().vertices.length;
            registerScene(scene);
            await startEngine(engine);
        }
        main();
        `,
        { fileName: "lazy-scene.ts" },
    );
    assert.match(cpp, /using Mesh = bbl::js::Ref<MeshData>;/);
});

const tools = optionalNativeFixtureTools(false);
test(
    "a rebound class binding keeps JavaScript identity natively",
    { skip: !tools },
    () => {
        const { cpp } = compileSource(lazyInstance, { fileName: "lazy.ts" });
        const output = resolve("artifacts/rebound-class-binding");
        mkdirSync(output, { recursive: true });
        const source = join(output, "check.cpp");
        const executable = join(output, "check.exe");
        writeFileSync(source, cpp);
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            source,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);
