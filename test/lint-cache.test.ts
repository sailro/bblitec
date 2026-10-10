import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cachePathKey } from "../src/build-stamp.js";
import {
    currentLintInputs,
    LintResultCache,
    lintResultKey,
    ninjaDependencies,
} from "../src/lint-cache.js";
import { commandOutput } from "../src/lint-compilation.js";
import {
    oldResultCacheEntries,
    pruneResultCache,
} from "../src/native-cache-clean.js";

function scratch(t: test.TestContext): string {
    const directory = mkdtempSync(join(tmpdir(), "lint-cache-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

/** Writes `text` and stamps it `secondsAgo` before now, so the test controls build order. */
function stamped(path: string, text: string, secondsAgo: number): string {
    writeFileSync(path, text);
    const when = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(path, when, when);
    return path;
}

const modified = (path: string): number | undefined =>
    statSync(path, { throwIfNoEntry: false })?.mtimeMs;

test("ninja dependency logs map each valid object to its build-relative inputs", () => {
    const build = join("C:", "work", "build");
    const dependencies = ninjaDependencies(
        [
            "CMakeFiles/app.dir/main.cpp.obj: #deps 2, deps mtime 7 (VALID)",
            "    ../include/a.hpp",
            "    C:/sdk/b.h",
            "",
            "CMakeFiles/app.dir/old.cpp.obj: #deps 1, deps mtime 3 (STALE)",
            "    ../include/c.hpp",
        ].join("\n"),
        build,
    );
    assert.deepEqual(
        dependencies
            .get(cachePathKey(join(build, "CMakeFiles/app.dir/main.cpp.obj")))
            ?.map(cachePathKey),
        [join("C:", "work", "include", "a.hpp"), "C:/sdk/b.h"].map(
            cachePathKey,
        ),
    );
    assert.equal(
        dependencies.has(
            cachePathKey(join(build, "CMakeFiles/app.dir/old.cpp.obj")),
        ),
        false,
    );
});

test("a compile command's output is its MSVC or clang destination, in every spelling", () => {
    const directory = join("C:", "work", "build");
    const output = (args: string[]): string | undefined => {
        const path = commandOutput({
            directory,
            file: "main.cpp",
            arguments: args,
        });
        return path && cachePathKey(path);
    };
    const object = cachePathKey(join(directory, "CMakeFiles", "main.obj"));
    assert.equal(
        output(["clang-cl", "/FoCMakeFiles/main.obj", "-c", "main.cpp"]),
        object,
    );
    assert.equal(
        output(["clang-cl", "/Fo:CMakeFiles/main.obj", "-c", "main.cpp"]),
        object,
    );
    assert.equal(
        output(["clang-cl", "/Fo", "CMakeFiles/main.obj", "-c", "main.cpp"]),
        object,
    );
    assert.equal(
        output(["clang++", "-c", "main.cpp", "-o", "CMakeFiles/main.obj"]),
        object,
    );
    assert.equal(output(["cl", "/c", "main.cpp"]), undefined);
});

test("only a unit whose object postdates every recorded input is keyed", (t) => {
    const root = scratch(t);
    const source = stamped(join(root, "main.cpp"), "int main() {}", 30);
    const header = stamped(join(root, "a.hpp"), "#pragma once", 30);
    const object = stamped(join(root, "main.obj"), "obj", 10);
    const dependencies = new Map([[cachePathKey(object), [header]]]);
    assert.deepEqual(
        currentLintInputs(source, object, dependencies, modified)?.map(
            cachePathKey,
        ),
        [source, header].map(cachePathKey),
    );
    // A header edited after the build may now include files the log lacks.
    stamped(header, "#pragma once\n#include <b.hpp>", 0);
    assert.equal(
        currentLintInputs(source, object, dependencies, modified),
        undefined,
    );
    // An object the log does not describe is never keyed.
    assert.equal(
        currentLintInputs(source, object, new Map(), modified),
        undefined,
    );
    assert.equal(
        currentLintInputs(source, undefined, dependencies, modified),
        undefined,
    );
});

test("a result key follows the invocation and the inputs' bytes, not the checkout root", (t) => {
    const parent = scratch(t);
    const checkout = (name: string): { root: string; inputs: string[] } => {
        const root = join(parent, name);
        mkdirSync(root, { recursive: true });
        return {
            root,
            inputs: [
                stamped(join(root, "main.cpp"), "int main() {}", 30),
                stamped(join(root, "a.hpp"), "#pragma once", 30),
            ],
        };
    };
    const first = checkout("main");
    const second = checkout("worktree");
    const invocation = (root: string): unknown[] => [
        "clang-tidy 21",
        [`--config-file=${join(root, ".clang-tidy")}`],
        `[${join(root, "main.cpp")},[/W4]]`,
    ];
    const base = lintResultKey(
        invocation(first.root),
        first.inputs,
        first.root,
    );
    assert.equal(
        lintResultKey(invocation(second.root), second.inputs, second.root),
        base,
    );
    assert.equal(
        lintResultKey(
            invocation(first.root),
            [...first.inputs].reverse(),
            first.root,
        ),
        base,
    );
    assert.notEqual(
        lintResultKey(
            [...invocation(first.root), "--header-filter=generated"],
            first.inputs,
            first.root,
        ),
        base,
    );
    stamped(first.inputs[1]!, "#pragma once\nint value;", 30);
    assert.notEqual(
        lintResultKey(invocation(first.root), first.inputs, first.root),
        base,
    );
});

test("the result cache keeps clean results; pruning removes unused entries", (t) => {
    const root = scratch(t);
    const directory = join(root, "cache");
    const cache = new LintResultCache(directory);
    assert.equal(cache.has("a"), false);
    cache.store("a", "main.cpp");
    assert.equal(cache.has("a"), true);
    stamped(join(directory, "old"), "main.cpp", 40 * 24 * 60 * 60);
    assert.deepEqual(
        oldResultCacheEntries(directory, 30).map((entry) => entry.path),
        [join(directory, "old")],
    );
    assert.equal(pruneResultCache(directory, 30).length, 1);
    assert.equal(existsSync(join(directory, "a")), true);
    assert.equal(existsSync(join(directory, "old")), false);
});
