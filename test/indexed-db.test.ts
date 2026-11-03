import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/** A notebook kept in IndexedDB through promise-wrapped requests, as browser code writes it. */
const LIBRARY = `
    const DATABASE = "notebook";
    const STORE_NAMES = ["pages", "attachments"] as const;

    function connect(): Promise<IDBDatabase> {
        return new Promise((settle, fail) => {
            const opening = indexedDB.open(DATABASE, 3);
            opening.onupgradeneeded = (): void => {
                const database = opening.result;
                for (const name of STORE_NAMES)
                    if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
            };
            opening.onsuccess = (): void => settle(opening.result);
            opening.onerror = (): void => fail(opening.error);
        });
    }

    async function readEntry<T>(storeName: string, id: IDBValidKey): Promise<T | undefined> {
        const database = await connect();
        try {
            return await new Promise<T | undefined>((settle, fail) => {
                const lookup = database.transaction(storeName, "readonly").objectStore(storeName).get(id);
                lookup.onsuccess = (): void => settle(lookup.result as T | undefined);
                lookup.onerror = (): void => fail(lookup.error);
            });
        } finally {
            database.close();
        }
    }

    async function writeEntry(storeName: string, id: IDBValidKey, entry: { readonly revision: number }): Promise<void> {
        const database = await connect();
        try {
            await new Promise<void>((settle, fail) => {
                const batch = database.transaction(storeName, "readwrite");
                batch.objectStore(storeName).put(entry, id);
                batch.oncomplete = (): void => settle();
                batch.onerror = (): void => fail(batch.error);
                batch.onabort = (): void => fail(batch.error);
            });
        } finally {
            database.close();
        }
    }

    async function writeAny(storeName: string, id: IDBValidKey, entry: unknown): Promise<void> {
        const database = await connect();
        try {
            await new Promise<void>((settle, fail) => {
                const batch = database.transaction(storeName, "readwrite");
                batch.objectStore(storeName).put(entry, id);
                batch.oncomplete = (): void => settle();
                batch.onerror = (): void => fail(batch.error);
            });
        } finally {
            database.close();
        }
    }

    async function removeEntry(storeName: string, id: IDBValidKey): Promise<void> {
        const database = await connect();
        try {
            await new Promise<void>((settle, fail) => {
                const batch = database.transaction(storeName, "readwrite");
                batch.objectStore(storeName).delete(id);
                batch.oncomplete = (): void => settle();
                batch.onerror = (): void => fail(batch.error);
                batch.onabort = (): void => fail(batch.error);
            });
        } finally {
            database.close();
        }
    }

    /** Each key in store order with its entry's revision, read through one cursor. */
    async function listRevisions(storeName: string): Promise<{ id: IDBValidKey; revision: number }[]> {
        const database = await connect();
        try {
            return await new Promise((settle, fail) => {
                const listed: { id: IDBValidKey; revision: number }[] = [];
                const walk = database.transaction(storeName, "readonly").objectStore(storeName).openCursor();
                walk.onsuccess = (): void => {
                    const position = walk.result;
                    if (!position) {
                        settle(listed);
                        return;
                    }
                    const revision = (position.value as { revision?: unknown } | null)?.revision;
                    listed.push({ id: position.primaryKey, revision: typeof revision === "number" ? revision : -1 });
                    position.continue();
                };
                walk.onerror = (): void => fail(walk.error);
            });
        } finally {
            database.close();
        }
    }
`;

function compileLibrary(main: string) {
    return compileSource(`${LIBRARY}\n${main}`);
}

test("IndexedDB helpers lower to the native requests, transactions and cursor", () => {
    const result = compileLibrary(`
        async function main(): Promise<void> {
            await writeEntry("pages", "cover", { revision: 1 });
            const read = await readEntry<{ revision: number }>("pages", "cover");
            if (read?.revision !== 1) throw new Error("read back");
            await removeEntry("pages", "cover");
            console.log((await listRevisions("attachments")).length);
        }
        void main();
    `);
    assert.ok(result.manifest.features.includes("storage:indexeddb"));
    for (const shape of [
        /bbl::js::IdbFactory\{\}\)?\.open\(/,
        /\.set_onupgradeneeded\(/,
        /\.create_object_store\(/,
        /\.object_store_names\(\)\)?\.contains\(/,
        /\.transaction\(/,
        /\.put\(/,
        /\.remove\(/,
        /\.open_cursor\(\)/,
        /\.advance\(\)/,
        /\.set_oncomplete\(/,
    ])
        assert.match(result.cpp, shape);
    assert.match(result.cpp, /#include <bblite\/js_indexed_db\.hpp>/);
});

test("IndexedDB forms beyond out-of-line keys and whole-store cursors refuse", () => {
    for (const [body, message] of [
        [
            `const req = indexedDB.open("d", 1); req.onupgradeneeded = () => { req.result.createObjectStore("s", { keyPath: "id" }); };`,
            /created by name alone/,
        ],
        [
            `const req = indexedDB.open("d"); req.onsuccess = () => { req.result.transaction("s").objectStore("s").openCursor(IDBKeyRange.lowerBound(1)); };`,
            /openCursor walks the whole store/,
        ],
        [
            `const req = indexedDB.open("d"); req.onsuccess = () => { req.result.transaction("s", "readwrite").objectStore("s").put({ a: 1 }); };`,
            /keys out of line/,
        ],
        [
            `const req = indexedDB.open("d"); req.onsuccess = () => { req.result.transaction("s", "readwrite").objectStore("s").put(new Map<string, number>(), 1); };`,
            /reads back from a store as no dynamic value/,
        ],
        [
            `const req = indexedDB.open("d"); req.onversionchange = () => {};`,
            /not written natively/,
        ],
    ] as const)
        assert.throws(() => compileSource(body), message, body);
});

test("a native IndexedDB program stores, reads, orders, deletes and keeps its records", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts", "indexed-db-check");
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    // Native console output is erased: a mismatch throws, an unhandled rejection fails the run.
    const build = (name: string, body: string): string => {
        const result = compileLibrary(`
            async function main(): Promise<void> {
                ${body}
            }
            void main().then(() => globalThis.close());
        `);
        const source = join(directory, `${name}.cpp`);
        const executable = join(directory, `${name}.exe`);
        writeFileSync(source, result.cpp);
        runNativeFixtureCompiler(tools, [
            "/DBBLITE_WORKERS=1",
            `/Fo:${directory}\\`,
            `/Fe:${executable}`,
            source,
            "native/src/pal_indexed_db.cpp",
            // The one PAL service the storage root reads that the engine's unit owns.
            "test/fixtures/js-json/pal-environment-stub.cpp",
            "/link",
            `/LIBPATH:${nativeFixtureVcpkgRoot}\\lib`,
            "sqlite3.lib",
            "SDL3.lib",
        ]);
        return executable;
    };
    const write = build(
        "write",
        `
        if ((await readEntry<{ revision: number }>("pages", "cover")) !== undefined)
            throw new Error("a fresh database holds no record");
        await writeEntry("pages", "cover", { revision: 7 });
        await writeEntry("attachments", "b", { revision: 2 });
        await writeEntry("attachments", 10, { revision: 1 });
        await writeEntry("attachments", "a", { revision: 3 });
        await writeEntry("attachments", -2.5, { revision: 4 });
        const scan = await listRevisions("attachments");
        if (JSON.stringify(scan.map((entry) => entry.id)) !== '[-2.5,10,"a","b"]')
            throw new Error("cursor order: " + JSON.stringify(scan));
        if (scan[0]!.revision !== 4) throw new Error("cursor value");
        await removeEntry("attachments", "a");
        if ((await readEntry<{ revision: number }>("attachments", "a")) !== undefined)
            throw new Error("deleted record");
        await writeAny("pages", "sketch", { revision: 9, file: new Blob(["abc"], { type: "TEXT/plain" }) });
    `,
    );
    const read = build(
        "read",
        `
        const kept = await readEntry<{ revision: number; title?: string }>("pages", "cover");
        if (kept?.revision !== 7 || kept.title !== undefined) throw new Error("kept record");
        const scan = await listRevisions("attachments");
        if (JSON.stringify(scan.map((entry) => entry.id)) !== '[-2.5,10,"b"]')
            throw new Error("kept order: " + JSON.stringify(scan));
        const sketch = await readEntry<{ revision?: number; file?: Blob }>("pages", "sketch");
        const file = sketch?.file instanceof Blob ? sketch.file : undefined;
        if (!file || file.size !== 3 || file.type !== "text/plain" || sketch?.revision !== 9)
            throw new Error("kept Blob");
    `,
    );
    const storageRoot = join(directory, "storage-root");
    mkdirSync(storageRoot, { recursive: true });
    const run = (executable: string) =>
        runFixtureExecutable(executable, {
            env: {
                ...process.env,
                // Never the user's own preference directory.
                BBLITE_LOCAL_STORAGE_ROOT: storageRoot,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env["PATH"] ?? ""}`,
            },
            timeoutMs: 60_000,
        });
    // Before anything is written, the reader's records are absent: its failure proves it checks.
    assert.throws(() => run(read), /kept record/);
    run(write);
    run(read);
});
