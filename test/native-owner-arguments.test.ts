import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("native storage owners cross narrowed helpers, results and retained closures", (t) => {
    const source = `
        interface Store {
            getItem(key: string): string | null;
            setItem(key: string, value: string): void;
        }
        function write(storage: Store, key: string, value: string): Store {
            storage.setItem(key, value);
            storage.setItem('writes', String(Number(storage.getItem('writes') ?? '0') + 1));
            return storage;
        }
        function read(storage: Store | null): () => Store | null {
            if (!storage) return () => null;
            const selected = write(storage, 'key', 'value');
            return () => selected;
        }
        const readers: Array<typeof read> = [read];
        const retained = readers[0]!(localStorage);
        const absent = readers[0]!(null);
        const owners: Store[] = [retained()!];
        const alias = owners[0]!;
        const holder = {storage: alias};
        if (alias !== localStorage || absent() !== null) throw new Error('owner');
        if (write(holder.storage, 'key', 'updated') !== alias) throw new Error('returned identity');
        if (localStorage.getItem('key') !== 'updated') throw new Error('alias mutation');
        if (retained() !== alias || localStorage.getItem('writes') !== '2') throw new Error('initializer timing');
    `;
    const values = new Map<string, string>();
    runInNewContext(ts.transpile(source), {
        localStorage: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        },
    });
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    runGeneratedProgram(
        tools,
        "native-owner-arguments/storage",
        `${result.cpp}
namespace bbl::pal {
std::map<std::string, std::string> fixture_storage;
std::optional<std::string> read_local_storage(const std::string& key) {
    const auto found = fixture_storage.find(key);
    if (found == fixture_storage.end()) return std::nullopt;
    return found->second;
}
void write_local_storage(const std::string& key, const std::string& value) { fixture_storage[key] = value; }
void remove_local_storage(const std::string& key) { fixture_storage.erase(key); }
}
`,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});

test("native owner arguments retain the selected object across later slot replacement", (t) => {
    const source = `
        const first = new Date(10);
        const second = new Date(20);
        const holder = {value: first};
        let current = first;
        const dates: Date[] = [first];
        const lookup = new Map<string, Date>([['key', first]]);
        let effects = 0;
        function replace(): number {
            effects++;
            current = second;
            holder.value = second;
            dates[0] = second;
            lookup.delete('key');
            return 1;
        }
        function time(value: Date, offset: number): number { return value.getTime() + offset; }
        if (time(current, replace()) !== 11) throw new Error('local owner snapshot');
        holder.value = first;
        if (time(holder.value, replace()) !== 11) throw new Error('field owner snapshot');
        dates[0] = first;
        if (time(dates[0]!, replace()) !== 11) throw new Error('array owner snapshot');
        lookup.set('key', first);
        if (time(lookup.get('key')!, replace()) !== 11) throw new Error('map owner snapshot');
        if (effects !== 4 || current !== second || holder.value !== second) throw new Error('argument effects');
        function replaceSlot(value: Date, slots: Date[], replacement: Date): number {
            slots[0] = replacement;
            return value.getTime();
        }
        dates[0] = new Date(30);
        if (replaceSlot(dates[0]!, dates, second) !== 30) throw new Error('callee owner lifetime');
        function retain(value: Date): () => Date { return () => value; }
        const callbacks: Array<typeof retain> = [retain];
        const owner = callbacks[0]!(first);
        if (owner() !== first) throw new Error('capture identity');
    `;
    runInNewContext(ts.transpile(source));
    const result = compileSource(source);
    assert.match(result.cpp, /snapshot_value/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    runGeneratedProgram(tools, "native-owner-arguments/order", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
});
