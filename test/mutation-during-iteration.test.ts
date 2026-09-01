// The behavior guards behind the mechanical consolidation of the
// mutation walkers, the data-method dispatcher, and the Map/Set
// container shell (TODO: compiler/runtime consolidation).
//
// Two layers must agree for JavaScript's delete-during-iteration
// semantics to survive lowering: the compiler keeps the erase on the
// container being iterated (rather than refusing or snapshotting), and
// the native containers make that erase safe mid-walk — the active-bit
// soft delete held until the last iterator releases. The compiler half
// also pins the aliased-mutation walk's fork: an object nobody mutates
// folds away, one written through an alias materializes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { findRepositoryRoot } from "../src/upstream-source.js";

function nativeSource(...parts: string[]): string {
    return readFileSync(
        join(findRepositoryRoot(), ...parts),
        "utf8",
    );
}

test("keeps a Map delete on the container being iterated", () => {
    const result = compileSource(`
        const retained: string[] = [];
        const jobs = new Map<string, number>();
        jobs.set("a", 1);
        jobs.set("b", 2);
        jobs.set("c", 3);
        for (const [name, cost] of jobs) {
            if (cost > 1.5) {
                jobs.delete(name);
            } else {
                retained.push(name);
            }
        }
        const survivors = jobs.size;
        console.log(retained.length + survivors);
    `);

    // The loop iterates the live container and the delete erases from
    // that same container mid-walk; the native InsertionOrdered storage
    // is what makes this well-defined.
    assert.match(result.cpp, /bbl::js::Map<std::string, double> v_jobs/);
    assert.match(result.cpp, /for \(auto&& (v_bblite_item_\d+) : v_jobs\) \{/);
    const item = /for \(auto&& (v_bblite_item_\d+) : v_jobs\) \{/.exec(
        result.cpp,
    )![1];
    assert.match(
        result.cpp,
        new RegExp(`v_jobs\\.erase\\(${item}\\.first\\)`),
    );
    assert.match(result.cpp, /v_jobs\.size\(\)/);
});

test("keeps a Set delete on the container being iterated", () => {
    const result = compileSource(`
        const seen = new Set<number>();
        seen.add(1);
        seen.add(2);
        for (const value of seen) {
            if (value > 1.5) {
                seen.delete(value);
            }
        }
        console.log(seen.size);
    `);

    assert.match(result.cpp, /bbl::js::Set<double> v_seen/);
    assert.match(result.cpp, /for \(auto&& (v_bblite_item_\d+) : v_seen\) \{/);
    const item = /for \(auto&& (v_bblite_item_\d+) : v_seen\) \{/.exec(
        result.cpp,
    )![1];
    assert.match(
        result.cpp,
        new RegExp(`v_seen\\.erase\\(${item}\\)`),
    );
});

test("forks inferred objects on the aliased-mutation walk", () => {
    const result = compileSource(`
        const frozen = { x: 1, y: 2 };
        const moved = { x: 1, y: 2 };
        const alias = moved;
        alias.x = 5;
        const sum = frozen.x + moved.x;
        console.log(sum);
    `);

    // The unmutated object folds away entirely; the one written through
    // an alias materializes reference storage and its reads stay live.
    assert.doesNotMatch(result.cpp, /v_frozen/);
    assert.match(result.cpp, /v_alias = v_moved;/);
    assert.match(result.cpp, /v_alias->x = 5\.0;/);
    assert.match(result.cpp, /v_sum = \(1\.0 \+ v_moved->x\);/);
});

test("treats a call argument as an array mutation escape", () => {
    const result = compileSource(`
        const grown: number[] = [10, 20, 30];
        function extend(list: number[]): void {
            list.push(40);
        }
        extend(grown);
        console.log(grown.length);
    `);

    // The walk's call-argument clause: handing the array to a helper
    // keeps it in real storage, passed by reference, and the helper's
    // push lands in the caller's buffer.
    assert.match(result.cpp, /bbl::js::Array<double> v_grown/);
    assert.match(
        result.cpp,
        /void extend\(bbl::js::Array<double>& (v_fn\d+_list)\)/,
    );
    assert.match(result.cpp, /v_fn\d+_list\.push_back\(40\.0\);/);
    assert.match(result.cpp, /bblscene::extend\(v_grown\);/);
});

test("erasing during native iteration soft-deletes until release", () => {
    const data = nativeSource(
        "native",
        "include",
        "bblite",
        "js_data.hpp",
    );

    // The mechanics the compiler's delete-in-loop emission relies on:
    // a live iterator turns erase into an active-bit clear, the walk
    // skips cleared slots, and the last iterator's release sweeps them.
    assert.ok(
        (data.match(/slot->active = false;/g) ?? []).length >= 1,
        "erase no longer soft-deletes under a live iterator",
    );
    assert.match(data, /storage_->iterator_count > 0/);
    assert.match(
        data,
        /if \(storage_->iterator_count == 0\) \{\s*storage_->sweep_deleted\(\);/,
    );
    assert.match(
        data,
        /while \(current_ != end_ && !current_->active\) \+\+current_;/,
    );
    // The soft-deleting erase lives once, in the shell both containers
    // derive from, so the two cannot age apart on these mechanics.
    assert.equal(
        (data.match(/slot->active = false;/g) ?? []).length,
        1,
        "the guarded erase should be defined once, in the shared shell",
    );
    assert.match(
        data,
        /class Map : public IndexedInsertionOrdered<std::pair<K, V>, K> \{/,
    );
    assert.match(
        data,
        /class Set : public IndexedInsertionOrdered<T, T> \{/,
    );
    assert.match(data, /InsertionOrderedIterator/);
    assert.match(data, /InsertionOrderedStorage/);
});
