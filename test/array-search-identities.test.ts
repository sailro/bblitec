import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("array searches compare represented owners by identity and erased numbers by SameValueZero", (t) => {
    const source = `
        const row = [1, 2];
        const equalRow = [1, 2];
        const rows: number[][] = [row, equalRow, row];
        if (!rows.includes(row) || rows.indexOf(row) !== 0 || rows.lastIndexOf(row) !== 2 ||
            rows.includes([1, 2]) || rows.indexOf(equalRow, 2) !== -1) throw new Error('array identity');
        const tuple: [number, number] = [1, 2];
        const equalTuple: [number, number] = [1, 2];
        const tuples: [number, number][] = [tuple, equalTuple, tuple];
        if (tuples.indexOf(tuples[0]!) !== 0 || tuples.indexOf(equalTuple) !== 1 ||
            tuples.lastIndexOf(tuple) !== 2 || !tuples.includes(tuple) ||
            tuples.includes([1, 2]) || tuples.indexOf([1, 2]) !== -1)
            throw new Error('numeric tuple identity');
        tuple[0] = 9;
        if (tuples[2]![0] !== 9 || equalTuple[0] !== 1 || tuples.indexOf(tuple) !== 0 ||
            tuples.indexOf([9, 2]) !== -1) throw new Error('numeric tuple aliases');
        const table = new Map<string, number>([['a', 1]]);
        const tables: Map<string, number>[] = [table];
        if (!tables.includes(table) || tables.includes(new Map<string, number>([['a', 1]]))) throw new Error('map identity');
        const values = new Set<number>([1]);
        const sets: Set<number>[] = [values];
        if (sets.indexOf(values) !== 0 || sets.includes(new Set<number>([1]))) throw new Error('set identity');
        const date = new Date(0);
        const dates: (Date | null)[] = [null, date, date];
        if (!dates.includes(date) || dates.indexOf(null) !== 0 || dates.lastIndexOf(date, 1) !== 1 ||
            dates.includes(new Date(0))) throw new Error('optional owner identity');
        const bytes = new Uint8Array([1]);
        const arrays: Uint8Array[] = [bytes];
        if (!arrays.includes(bytes) || arrays.includes(new Uint8Array([1]))) throw new Error('typed array identity');
        const error = new Error('same');
        const errors: Error[] = [error];
        if (!errors.includes(error) || errors.includes(new Error('same'))) throw new Error('error identity');
        const unknowns: unknown[] = [NaN, -0, 'a', row, error];
        if (!unknowns.includes(NaN) || unknowns.indexOf(NaN) !== -1 || unknowns.lastIndexOf(NaN) !== -1 ||
            !unknowns.includes(0) || !unknowns.includes(row) || !unknowns.includes(error) || unknowns.includes(equalRow))
            throw new Error('erased equality');
        let order = '';
        let selected = row;
        function needle(): number[] { order += 'N'; return selected; }
        function offset(): number { order += 'F'; selected = equalRow; return 0; }
        if (rows.indexOf(needle(), offset()) !== 0 || order !== 'NF') throw new Error('search snapshots');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, "array-search-identities/owners", result.cpp);
});

test("event target array searches use document-owned identities", (t) => {
    const result = compileSource(
        `
        const panel = document.createElement('div');
        document.body.appendChild(panel);
        panel.addEventListener('keydown', event => {
            const path = event.composedPath();
            if (!path.includes(panel) || path.indexOf(panel) < 0 || path.lastIndexOf(panel) < 0)
                throw new Error('event path identity');
        });
    `,
        { deferredCapabilities: "runtime-throw" },
    );
    assert.match(result.cpp, /array_includes\(/);
    assert.match(result.cpp, /array_last_index_of\(/);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        native,
        "array-search-identities/event-targets",
        `
        #include <bblite/js_data.hpp>
        #include <bblite/dom_event_state.hpp>
        #include <cassert>
        int main() {
            const auto first_owner = std::make_shared<const int>(1);
            const auto second_owner = std::make_shared<const int>(1);
            const bbl::DomEventTargetValue first{nullptr, bbl::DomEventTarget::node(7), first_owner};
            const bbl::DomEventTargetValue alias = first;
            const bbl::DomEventTargetValue other{nullptr, bbl::DomEventTarget::node(7), second_owner};
            const bbl::js::Array<bbl::DomEventTargetValue> path{first, other, alias};
            assert(bbl::js::array_includes(path, alias));
            assert(bbl::js::array_index_of(path, alias) == 0);
            assert(bbl::js::array_last_index_of(path, alias, 2) == 2);
            assert(bbl::js::array_index_of(path, other) == 1);
            assert(!bbl::js::array_includes(path, other, 2));
        }
    `,
    );
});
