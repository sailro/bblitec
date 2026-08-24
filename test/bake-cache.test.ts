import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cachedBakeSync,
    moduleClosureBytes,
    moduleIdentity,
} from "../src/bake-cache.js";

// The replay cache for the deterministic executed bakes. Its contract:
// a key change misses, a repeat hits with the same bytes, a deleted
// cache directory is a cold start, and — under the test runner or
// BBLITE_BAKE_CACHE=0 — it is not there at all, so the existing
// determinism gates keep measuring the bake rather than the replay.

const cacheRoot = resolve("artifacts", "bake-cache");

function withCacheEnabled<T>(body: () => T): T {
    // Node's test runner marks its children, and the cache disables
    // itself there on purpose; this test IS about the cache, so the
    // marker is lifted for its body alone.
    const previous = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    try {
        return body();
    } finally {
        if (previous !== undefined) {
            process.env.NODE_TEST_CONTEXT = previous;
        }
    }
}

function removeEntries(kind: string): void {
    if (!existsSync(cacheRoot)) return;
    for (const name of readdirSync(cacheRoot)) {
        if (name.startsWith(`${kind}-`)) {
            rmSync(join(cacheRoot, name), { force: true });
        }
    }
}

test("replays a stored bake byte-for-byte and misses on any key change", () => {
    const kind = "test-roundtrip";
    removeEntries(kind);
    try {
        withCacheEnabled(() => {
            let bakes = 0;
            const bake = (): Uint8Array => {
                bakes += 1;
                return Uint8Array.from([1, 2, 3, bakes]);
            };
            const key = {
                kind,
                version: "1",
                module: "test-module",
                browser: false,
                parameters: { a: 1, b: "two" },
                inputs: [Uint8Array.from([9, 9])],
            };
            const first = cachedBakeSync(key, bake);
            assert.deepEqual([...first], [1, 2, 3, 1]);
            // The second call replays the FIRST result; the bake does
            // not run again.
            const second = cachedBakeSync(key, bake);
            assert.deepEqual([...second], [1, 2, 3, 1]);
            assert.equal(bakes, 1);
            // Parameter key order does not matter (canonical JSON) --
            // still a hit.
            const reordered = cachedBakeSync(
                { ...key, parameters: { b: "two", a: 1 } },
                bake,
            );
            assert.deepEqual([...reordered], [1, 2, 3, 1]);
            assert.equal(bakes, 1);
            // Any component change misses: version, inputs, parameters.
            cachedBakeSync({ ...key, version: "2" }, bake);
            assert.equal(bakes, 2);
            cachedBakeSync(
                { ...key, inputs: [Uint8Array.from([9, 8])] },
                bake,
            );
            assert.equal(bakes, 3);
            cachedBakeSync(
                { ...key, parameters: { a: 2, b: "two" } },
                bake,
            );
            assert.equal(bakes, 4);
            // Deleting the entries is a cold start.
            removeEntries(kind);
            cachedBakeSync(key, bake);
            assert.equal(bakes, 5);
        });
    } finally {
        removeEntries(kind);
    }
});

test("is disabled under the test runner and BBLITE_BAKE_CACHE=0", () => {
    const kind = "test-disabled";
    removeEntries(kind);
    try {
        let bakes = 0;
        const bake = (): Uint8Array => {
            bakes += 1;
            return Uint8Array.from([bakes]);
        };
        const key = {
            kind,
            version: "1",
            module: "test-module",
            browser: false,
            parameters: {},
            inputs: [],
        };
        // Under node --test the NODE_TEST_CONTEXT marker is present, so
        // both calls bake: a determinism gate that re-runs a bake must
        // measure the bake, not the replay. If Node ever stops setting
        // the marker, this fails loudly and the cache's disable
        // mechanism needs a new signal.
        assert.ok(
            process.env.NODE_TEST_CONTEXT !== undefined,
            "node --test no longer marks its children with NODE_TEST_CONTEXT; " +
                "the bake cache's test-run disable leans on that marker.",
        );
        cachedBakeSync(key, bake);
        cachedBakeSync(key, bake);
        assert.equal(bakes, 2);
        withCacheEnabled(() => {
            const previous = process.env.BBLITE_BAKE_CACHE;
            process.env.BBLITE_BAKE_CACHE = "0";
            try {
                cachedBakeSync(key, bake);
                cachedBakeSync(key, bake);
                assert.equal(bakes, 4);
            } finally {
                if (previous === undefined) {
                    delete process.env.BBLITE_BAKE_CACHE;
                } else {
                    process.env.BBLITE_BAKE_CACHE = previous;
                }
            }
        });
    } finally {
        removeEntries(kind);
    }
});

test("hashes a module's transitive relative imports, and refuses an unresolvable closure", () => {
    const directory = resolve(".cache", "bake-closure");
    mkdirSync(directory, { recursive: true });
    const entry = join(directory, "closure-entry.ts");
    const sibling = join(directory, "closure-sibling.ts");
    try {
        writeFileSync(
            sibling,
            "export const value = 1;\n",
        );
        writeFileSync(
            entry,
            'import { value } from "./closure-sibling.js";\n' +
                'import "babylon-lite";\n' +
                "export const twice = value * 2;\n",
        );
        const closure = moduleClosureBytes([entry]);
        assert.ok(closure !== undefined);
        const text = closure
            .map((payload) => Buffer.from(payload).toString("utf8"))
            .join("\n");
        // Both files' bytes are in the closure; the package specifier
        // is not followed (the pin keys the cache instead).
        assert.match(text, /closure-sibling/);
        assert.match(text, /value \* 2/);
        assert.match(text, /export const value = 1/);
        // A sibling edit changes the closure even though the entry
        // module's own text is unchanged.
        writeFileSync(sibling, "export const value = 2;\n");
        const edited = moduleClosureBytes([entry]);
        assert.ok(edited !== undefined);
        assert.notDeepEqual(
            edited.map((payload) => Buffer.from(payload).toString("utf8")),
            closure.map((payload) =>
                Buffer.from(payload).toString("utf8"),
            ),
        );
        // An unresolvable relative import means "bake uncached", never
        // "guess the inputs".
        writeFileSync(
            entry,
            'import { gone } from "./no-such-module.js";\n',
        );
        assert.equal(moduleClosureBytes([entry]), undefined);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("moduleIdentity hashes the calling module's compiled source", () => {
    const identity = moduleIdentity(import.meta.url);
    assert.match(identity, /^[0-9a-f]{64}$/);
    assert.equal(identity, moduleIdentity(import.meta.url));
});
