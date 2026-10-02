import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { discoverWindowsBuildTools } from "../src/development-tools.js";
import { runGeneratedProgram } from "./native-fixture.js";

test("fresh record returns permit elision and preserve borrowed callable aliases", (t) => {
    if (process.platform !== "win32")
        return t.skip("The clang-cl native fixture requires Windows.");
    let native;
    try {
        native = discoverWindowsBuildTools("clangcl");
    } catch {
        return t.skip("The clang-cl native fixture compiler is unavailable.");
    }
    const result = compileSource(`
        interface State { value: number; }
        interface Api { state: State; read: (amount: number) => number; }
        let creations = 0;
        function factory(): Api {
            creations++;
            const state = {value: 0};
            return {state, read: (amount: number) => { state.value += amount; return state.value; }};
        }
        const cache = new Map<string, Api>();
        const first = cache.get("active") ?? factory();
        cache.set("active", first);
        const second = cache.get("active") ?? factory();
        const saved = first.read;
        if (first !== second || saved !== second.read || creations !== 1)
            throw new Error("cached fallback aliases");
        if (saved(2) !== 2 || second.read(3) !== 5 || first.state.value !== 5)
            throw new Error("retained callback state");
        const direct = factory();
        const directAlias = direct;
        if (direct === first || direct.read === saved || directAlias.read(7) !== 7 ||
            direct.state.value !== 7 || first.state.value !== 5 || creations !== 2)
            throw new Error("fresh initializer ownership");
        function borrowed(holder: {api: Api}): Api { return holder.api; }
        function retained(api: Api): () => Api { return () => api; }
        const holder = {api: first};
        const captured = retained(first);
        if (borrowed(holder) !== first || borrowed(holder) !== first || holder.api !== first ||
            captured() !== first || captured() !== first || first.read(1) !== 6)
            throw new Error("borrowed and captured return ownership");
        const labels = new Map<number, string>();
        function label(id: number): string {
            let text = labels.get(id);
            if (text === undefined) {
                text = "label " + id;
                labels.set(id, text);
            }
            return text;
        }
        if (label(3) !== "label 3" || label(3) !== "label 3" || labels.get(3) !== "label 3")
            throw new Error("owned optional return");
    `);
    runGeneratedProgram(native, "record-return-ownership", result.cpp);
    assert.doesNotMatch(result.cpp, /return std::move\(v_bblite_return_/);
    assert.match(
        result.cpp,
        /bbl::js::take_temporary\(v_bblite_return_factory_\d+\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Nullable<std::string> (v_fn\d+_text) = [^;]+;[\s\S]*return std::move\(\(\*\1\)\);/,
    );
});
