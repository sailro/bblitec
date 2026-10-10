import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    FixtureBuildCache,
    fixtureCompilePlan,
    includeNotes,
} from "./native-fixture-cache.js";

function scratch(t: test.TestContext): string {
    const directory = mkdtempSync(join(tmpdir(), "fixture-cache-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test("a compile-and-link command names its sources and libraries, and outputs its executable", (t) => {
    const cwd = scratch(t);
    mkdirSync(join(cwd, "libs"));
    writeFileSync(join(cwd, "libs", "physics.lib"), "library");
    const plan = fixtureCompilePlan(
        [
            `/FI${join(cwd, "macros", "prelude.hpp")}`,
            "/nologo",
            "/Fo:artifacts/check/",
            "/Fe:artifacts/check/check.exe",
            "artifacts/check/check.cpp",
            "native/src/pal_fonts.cpp",
            "/link",
            "/OPT:REF",
            `/LIBPATH:${join(cwd, "libs")}`,
            "physics.lib",
            "dwrite.lib",
        ],
        cwd,
    );
    assert.ok(plan);
    // Its objects are intermediates no later step reads.
    assert.deepEqual(plan.outputs, [join(cwd, "artifacts/check/check.exe")]);
    assert.deepEqual(plan.sources, [
        join(cwd, "artifacts/check/check.cpp"),
        join(cwd, "native/src/pal_fonts.cpp"),
    ]);
    // A `/LIBPATH:` library is an input; a system library is found through LIB.
    assert.deepEqual(plan.inputs, [
        join(cwd, "macros", "prelude.hpp"),
        join(cwd, "artifacts/check/check.cpp"),
        join(cwd, "native/src/pal_fonts.cpp"),
        join(cwd, "libs", "physics.lib"),
    ]);
    // Output paths do not enter the key; the sources do.
    assert.ok(plan.normalized.includes("/Fe:<executable>"));
    assert.ok(plan.normalized.includes("/Fo:<objects>"));
});

test("commands whose inputs or outputs the cache cannot name always compile", () => {
    const cwd = join("C:", "repo");
    for (const args of [
        ["@response.rsp"],
        ["/Fo:out/", "/Fe:out/a.exe", "/Tpa.cxx"],
        ["/Fo:out/", "a.cpp"],
        ["/c", "a.cpp"],
        ["/Fo:out/a.obj", "a.cpp", "b.cpp", "/c"],
        ["/c", "/Fo:out/", "a.cpp", "/Yupch.hpp"],
        ["/P", "a.cpp"],
    ])
        assert.equal(fixtureCompilePlan(args, cwd), undefined, args.join(" "));
    // A compile-only command's objects are what later steps link.
    assert.deepEqual(
        fixtureCompilePlan(["/c", "a.cpp", "/Foout/a.obj"], cwd)?.outputs,
        [join(cwd, "out/a.obj")],
    );
    assert.deepEqual(
        fixtureCompilePlan(["/c", "/Fo:out/", "a.cpp", "b.cc"], cwd)?.outputs,
        [join(cwd, "out/a.obj"), join(cwd, "out/b.obj")],
    );
});

test("include notes are separated from the compiler's other output", () => {
    const { includes, rest } = includeNotes(
        [
            "check.cpp",
            "Note: including file: C:\\repo\\native\\include\\bblite\\runtime.hpp",
            "Note: including file:  C:\\repo\\native\\include\\bblite\\js_data.hpp",
            "check.cpp(3): error C2065: 'x': undeclared identifier",
        ].join("\r\n"),
    );
    assert.deepEqual(includes, [
        "C:\\repo\\native\\include\\bblite\\runtime.hpp",
        "C:\\repo\\native\\include\\bblite\\js_data.hpp",
    ]);
    assert.equal(
        rest,
        "check.cpp\ncheck.cpp(3): error C2065: 'x': undeclared identifier",
    );
});

/** One checkout with a fixture source and the header it includes. */
function checkout(root: string): { source: string; header: string } {
    mkdirSync(root, { recursive: true });
    const source = join(root, "check.cpp");
    const header = join(root, "fixture.hpp");
    writeFileSync(source, '#include "fixture.hpp"\nint main() {}\n');
    writeFileSync(header, "#pragma once\n");
    return { source, header };
}

const environment = { INCLUDE: "C:/sdk/include", LIB: "C:/sdk/lib" };
const command = ["/Fo:out/", "/Fe:out/check.exe", "check.cpp"];

test("a stored build is restored only while every header it read keeps its bytes", (t) => {
    const root = scratch(t);
    const { source, header } = checkout(root);
    const cache = new FixtureBuildCache(join(root, "cache"), root);
    const executable = join(root, "out", "check.exe");
    const plan = fixtureCompilePlan(command, root)!;
    const key = cache.commandKey(join(root, "cl.exe"), environment, plan);
    assert.equal(cache.restore(key, plan), false);
    mkdirSync(join(root, "out"), { recursive: true });
    writeFileSync(executable, "program v1");
    cache.store(key, plan, [header]);
    rmSync(join(root, "out"), { recursive: true });
    assert.equal(cache.restore(key, plan), true);
    assert.equal(readFileSync(executable, "utf8"), "program v1");
    // A header the build read changed: the stored build no longer applies.
    writeFileSync(header, "#pragma once\nint changed;\n");
    assert.equal(cache.restore(key, plan), false);
    // A new build under the same command replaces the old variant.
    writeFileSync(executable, "program v2");
    cache.store(key, plan, [header]);
    assert.equal(readdirSync(join(root, "cache", key)).length, 1);
    assert.equal(cache.restore(key, plan), true);
    assert.equal(readFileSync(executable, "utf8"), "program v2");
    // A source the command names, or the environment, moves the command key.
    writeFileSync(source, "int main() { return 1; }\n");
    assert.notEqual(
        cache.commandKey(join(root, "cl.exe"), environment, plan),
        key,
    );
    assert.notEqual(
        cache.commandKey(
            join(root, "cl.exe"),
            { ...environment, CL: "/DEXTRA" },
            plan,
        ),
        cache.commandKey(join(root, "cl.exe"), environment, plan),
    );
});

test("worktrees with the same bytes share one stored build", (t) => {
    const parent = scratch(t);
    const shared = join(parent, "cache");
    const main = join(parent, "main");
    const worktree = join(parent, "worktree");
    const first = checkout(main);
    checkout(worktree);
    const plan = (root: string) => fixtureCompilePlan(command, root)!;
    const mainCache = new FixtureBuildCache(shared, main);
    const worktreeCache = new FixtureBuildCache(shared, worktree);
    const compiler = join(parent, "cl.exe");
    const key = mainCache.commandKey(compiler, environment, plan(main));
    assert.equal(
        worktreeCache.commandKey(compiler, environment, plan(worktree)),
        key,
    );
    mkdirSync(join(main, "out"), { recursive: true });
    writeFileSync(join(main, "out", "check.exe"), "program");
    mainCache.store(key, plan(main), [first.header]);
    assert.equal(worktreeCache.restore(key, plan(worktree)), true);
    assert.equal(
        readFileSync(join(worktree, "out", "check.exe"), "utf8"),
        "program",
    );
});
