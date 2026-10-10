import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("stored native method views preserve presence and evaluated owners", (t) => {
    const source = `
        interface View { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void; }
        function clear(storage: View | null, key: string): void {
            storage?.removeItem?.(key);
            if (storage && !storage.removeItem) storage.setItem(key, "");
        }
        const clearers: Array<typeof clear> = [clear];
        localStorage.setItem("entry", "present");
        clearers[0]!(localStorage, "entry");
        if (localStorage.getItem("entry") !== null) throw new Error("optional native method");
        clearers[0]!(null, "entry");
        let reads = 0;
        function owner(): Storage { reads++; return localStorage; }
        const readers: Array<typeof owner> = [owner];
        const present = !!readers[0]!().removeItem;
        if (!present || reads !== 1) throw new Error("method read discarded its owner");
        const same = readers[0]!().removeItem === localStorage.removeItem;
        if (!same || reads !== 2) throw new Error("unbound method identity");
    `;
    const entries = new Map<string, string>();
    runInNewContext(ts.transpile(source), {
        localStorage: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => entries.set(key, value),
            removeItem: (key: string) => entries.delete(key),
        },
    });
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "stored-native-method-view",
        result.cpp +
            `
namespace bbl::pal {
static std::map<std::string, std::string> fixture_storage;
std::optional<std::string> read_local_storage(const std::string& key) {
    const auto entry = fixture_storage.find(key);
    return entry == fixture_storage.end() ? std::nullopt : std::optional<std::string>{entry->second};
}
void write_local_storage(const std::string& key, const std::string& value) { fixture_storage[key] = value; }
void remove_local_storage(const std::string& key) { fixture_storage.erase(key); }
}
`,
    );
});
