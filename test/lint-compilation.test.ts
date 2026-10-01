import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
    commandArguments,
    lintCompilationGroups,
    lintCompilationKey,
    lintEnvironmentAllowsDedup,
    type CompilationCommand,
} from "../src/lint-compilation.js";

const root = resolve("artifacts/lint-compilation");
const source = resolve(root, "native/pal.cpp");
const compiler = resolve(root, "LLVM tools/clang-cl.exe");
const includes = [
    resolve(root, "generated headers"),
    resolve(root, "native/include"),
];
function command(build: string): CompilationCommand {
    return {
        directory: resolve(root, build),
        file: source,
        arguments: [
            compiler,
            "/nologo",
            "-TP",
            "-DBACKEND=1",
            '-DNAME=\\"assets\\"',
            `-I${includes[0]}`,
            "-imsvc",
            includes[1]!,
            "/EHsc",
            "/O2",
            "/Ob2",
            "-std:c++20",
            "-MD",
            "-Xclang",
            "-include-pch",
            "-Xclang",
            resolve(root, build, "header.pch"),
            "/W4",
            "/WX",
            "/permissive-",
            "/bigobj",
            "-Wundef",
            "-Werror=undef",
            "-Xclang",
            "-fno-pch-timestamp",
            "/FoCMakeFiles/unit.obj",
            "/FdCMakeFiles/",
            "-c",
            "--",
            source,
        ],
    };
}
const digest = (): string => "identical PCH bytes";
function changed(from: string, to: string): CompilationCommand {
    const entry = command("first");
    return {
        ...entry,
        arguments: entry.arguments!.map((argument) =>
            argument === from ? to : argument,
        ),
    };
}

test("lint compilation identity shares only equivalent frontend contexts", () => {
    const first = command("first"),
        second = command("second");
    second.arguments = second.arguments!.map((argument) =>
        argument.startsWith("/Fo")
            ? "/Foother.obj"
            : argument.startsWith("/Fd")
              ? `/Fd${resolve(root, "debug")}`
              : argument,
    );
    const key = lintCompilationKey(first, digest);
    assert.notEqual(key, undefined);
    assert.equal(lintCompilationKey(second, digest), key);
    for (const entry of [
        changed("-DBACKEND=1", "-DBACKEND=2"),
        changed("/O2", "/O1"),
        changed("-MD", "-MT"),
        changed(`-I${includes[0]}`, `-I${resolve(root, "other headers")}`),
        changed("-std:c++20", "-std:c++17"),
        {
            ...first,
            file: resolve(root, "other.cpp"),
            arguments: first.arguments!.map((argument) =>
                argument === source ? resolve(root, "other.cpp") : argument,
            ),
        },
    ])
        assert.notEqual(lintCompilationKey(entry, digest), key);
    const reversed = command("first");
    reversed.arguments!.splice(
        5,
        3,
        `-imsvc${includes[1]}`,
        "-I",
        includes[0]!,
    );
    assert.notEqual(lintCompilationKey(reversed, digest), key);
    assert.notEqual(
        lintCompilationKey(first, () => "changed PCH bytes"),
        key,
    );
});

test("lint keys refuse ambiguous or working-directory-dependent commands", () => {
    for (const entry of [
        { ...command("first"), file: "native/pal.cpp" },
        changed(compiler, "clang-cl.exe"),
        changed(`-I${includes[0]}`, "-Irelative"),
        changed(resolve(root, "first/header.pch"), "header.pch"),
        changed("/W4", "@flags.rsp"),
        changed("/W4", "-fmodule-map-file=module.map"),
        changed("/W4", "-unknown-frontend-option"),
        changed("/W4", "/FIrelative.hpp"),
        changed("-fno-pch-timestamp", "-ivfsoverlay"),
        changed(source, resolve(root, "different.cpp")),
    ])
        assert.equal(lintCompilationKey(entry, digest), undefined);
    const first = command("first"),
        second = command("second");
    assert.deepEqual(
        lintCompilationGroups(
            [first, second, changed("-MD", "-MT"), undefined, undefined],
            digest,
        ),
        [[0, 1], [2], [3], [4]],
    );
});

test("lint preserves command tokenization and GNU dependency flag semantics", () => {
    const entry: CompilationCommand = {
        directory: root,
        file: source,
        command: `"${compiler}" /nologo -TP "-I${includes[0]}" /Foout.obj -c "${source}"`,
    };
    const arguments_ = [
        compiler,
        "/nologo",
        "-TP",
        `-I${includes[0]}`,
        "/Foout.obj",
        "-c",
        source,
    ];
    assert.deepEqual(commandArguments(entry), arguments_);
    assert.equal(
        lintCompilationKey(entry, digest),
        lintCompilationKey({ ...entry, arguments: arguments_ }, digest),
    );
    if (process.platform === "win32")
        assert.equal(
            lintCompilationKey(
                {
                    ...entry,
                    command: `'${compiler}' /nologo -TP -c '${source}'`,
                },
                digest,
            ),
            undefined,
        );
    const gnu: CompilationCommand = {
        directory: root,
        file: source,
        arguments: [
            resolve(root, "clang++"),
            "-std=c++20",
            "-I",
            includes[0]!,
            "-MD",
            "-MT",
            "first target",
            "-MF",
            "first.d",
            "-include-pch",
            resolve(root, "header.pch"),
            "-o",
            "first.o",
            "-c",
            source,
        ],
    };
    const other = {
        ...gnu,
        directory: resolve(root, "elsewhere"),
        arguments: gnu.arguments!.map((argument) =>
            argument.startsWith("first")
                ? argument.replace("first", "second")
                : argument,
        ),
    };
    assert.notEqual(lintCompilationKey(gnu, digest), undefined);
    assert.equal(
        lintCompilationKey(gnu, digest),
        lintCompilationKey(other, digest),
    );
});

test("lint keeps injected flags and relative environment include paths independent", () => {
    assert.equal(lintEnvironmentAllowsDedup({}), true);
    assert.equal(lintEnvironmentAllowsDedup({ INCLUDE: includes[0] }), true);
    for (const environment of [
        { CL: "/DOTHER=1" },
        { _CL_: "/FIextra.hpp" },
        { CPATH: "." },
        { INCLUDE: "" },
        { CPLUS_INCLUDE_PATH: "relative" },
        { COMPILER_PATH: "/tools" },
        { SDKROOT: "relative" },
    ])
        assert.equal(lintEnvironmentAllowsDedup(environment), false);
});
