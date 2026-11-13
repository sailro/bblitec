import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { pinnedLibraryRoot } from "../src/pinned-shader-composer.js";

/** Every JavaScript module of the pinned package outside its vendored dependencies. */
function packageModules(root: string): string[] {
    const modules: string[] = [];
    const visit = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                if (
                    relative(root, path).replaceAll("\\", "/") !==
                    "_chunks/vendor"
                )
                    visit(path);
            } else if (entry.name.endsWith(".js")) modules.push(path);
        }
    };
    visit(root);
    return modules;
}

test("the pinned package makes its engine objects without classes of its own", () => {
    // `isPinnedEngineObjectKind` answers `constructor` reads with `Object`:
    // the package's own modules declare no class whose instances it returns.
    const root = pinnedLibraryRoot();
    const declaring = packageModules(root).filter((path) =>
        /^\s*(export\s+)?class\s+[A-Za-z_$]/m.test(readFileSync(path, "utf8")),
    );
    assert.deepEqual(
        declaring.map((path) => relative(root, path)),
        [],
    );
});

test("an engine object's constructor is Object", () => {
    const { cpp } = compileSource(`
        import { createEngine, createBox, startEngine, type Mesh } from "babylon-lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("c") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const box: Mesh = createBox(engine, { size: 1 });
            const kind = (box as { constructor?: { name?: string } }).constructor?.name ?? "none";
            localStorage.setItem("kind", kind);
            await startEngine(engine);
        }
        void main();
    `);
    assert.match(cpp, /"kind", std::string\("Object"\)|"kind", "Object"/);
});
