import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const PARSES: readonly (readonly [string, string?])[] = [
    ["https://assets.babylonjs.com/splats/Trogir/lod-meta.json"],
    ["scene.voxel.json", "https://a.b/c/d/lod-meta.json?x=1"],
    [
        "/local-gs/trogir/",
        "http://localhost:5173/lite/demo-trogir-streaming.html?quality=high",
    ],
    ["../x/./y/../z?q=a b'#f g", "http://h.com/a/b/c"],
    ["HTTP://EXAMPLE.com:80/%7Efoo/../bar"],
    ["https://user:pa ss@host.com:8443/p?q#h"],
    ["http://192.168.0.1.:8080/"],
    ["http://0x7f.1/"],
    ["http://[::1]/"],
    ["http://[2001:db8::0:1]:81/"],
    ["http://[::ffff:192.168.1.1]/"],
    ["file:///C:/dir/file.txt"],
    ["mailto:someone@example.com"],
    ["blob:https://a.com/uuid"],
    ["?only=query", "https://h/p/q?old#f"],
    ["#frag", "https://h/p/q?old"],
    ["//other.host/p", "https://h/p/q"],
    ["https://a.com/a\\b/./c/%2e%2E/d"],
    ["https://x/\u00e4?\u00fc=1#\u00f6"],
    ["  https://trim.example/a\tb\n  "],
    ["foo://host/path?x#y"],
    ["https://h:443/"],
];

const COMPONENTS = [
    "href",
    "protocol",
    "username",
    "password",
    "host",
    "hostname",
    "port",
    "pathname",
    "search",
    "hash",
    "origin",
] as const;

test("runtime URL parses, resolves and serializes as the URL Standard does", () => {
    const checks: string[] = [];
    PARSES.forEach(([input, base], index) => {
        const expected =
            base === undefined ? new URL(input) : new URL(input, base);
        checks.push(
            `const url${index} = new URL(${JSON.stringify(input)}${base === undefined ? "" : `, ${JSON.stringify(base)}`});`,
        );
        for (const component of COMPONENTS)
            checks.push(
                `check(url${index}.${component}, ${JSON.stringify(expected[component])}, "${index}.${component}");`,
            );
    });
    // Setters and the live URLSearchParams, against Node's URL.
    const live = new URL(
        "https://h.example/root/lod-meta.json?keep=1&quality=low#top",
    );
    const steps: string[] = [];
    const record = (label: string): void => {
        steps.push(
            `check(live.href, ${JSON.stringify(live.href)}, ${JSON.stringify(label)});`,
        );
    };
    live.pathname = "/new path/x";
    steps.push(`live.pathname = "/new path/x";`);
    record("pathname set");
    live.pathname += "/";
    steps.push(`live.pathname += "/";`);
    record("pathname append");
    live.searchParams.set("quality", "high value");
    steps.push(`live.searchParams.set("quality", "high value");`);
    record("searchParams set");
    live.search = "?a=1&b=2";
    steps.push(`live.search = "?a=1&b=2";`);
    record("search set");
    steps.push(
        `check(live.searchParams.get("b") ?? "", "2", "searchParams follow search");`,
        `if (live.searchParams.get("quality") !== null) throw new Error("stale query list");`,
    );
    live.hash = "frag ment";
    steps.push(`live.hash = "frag ment";`);
    record("hash set");
    live.search = "";
    steps.push(`live.search = "";`);
    record("search cleared");
    live.href = "http://other/x?y=1";
    steps.push(`live.href = "http://other/x?y=1";`);
    record("href set");
    steps.push(
        `check(live.searchParams.get("y") ?? "", "1", "searchParams follow href");`,
    );
    const source = `
        function check(actual: string, expected: string, label: string): void {
            if (actual !== expected) throw new Error(label + ": " + actual + " !== " + expected);
        }
        ${checks.join("\n        ")}
        const base = new URL("https://assets.example/splats/Trogir/lod-meta.json?v=2");
        const relative = new URL("scene.voxel.json", base);
        relative.search = base.search;
        check(relative.href, ${JSON.stringify(Object.assign(new URL("scene.voxel.json", "https://assets.example/splats/Trogir/lod-meta.json?v=2"), { search: "?v=2" }).href)}, "URL base");
        const live = new URL("https://h.example/root/lod-meta.json?keep=1&quality=low#top");
        const params = live.searchParams;
        if (params !== live.searchParams) throw new Error("searchParams identity");
        ${steps.join("\n        ")}
        for (const [input, base] of [["not a url", ""], ["http://", ""], ["x", "mailto:a"], ["http://h:99999/", ""], ["http://\u00e4.com/", ""], ["http://[1::2::3]/", ""]]) {
            let failed = false;
            try { if (base) new URL(input, base); else new URL(input); } catch (error) { failed = error instanceof TypeError; }
            if (!failed) throw new Error("accepted " + input);
        }
    `;
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(tools, "urls/parse", result.cpp, {
        expectedOutput: "",
    });
});

test("URL setters without a native representation refuse", () => {
    for (const [source, message] of [
        [
            `const u = new URL("https://a/"); u.protocol = "http:";`,
            /The URL protocol setter is not lowered/,
        ],
        [
            `const u = new URL("https://a/"); u.port = "8080";`,
            /The URL port setter is not lowered/,
        ],
        [
            `const u = new URL("https://a/"); u.username = "x";`,
            /The URL username setter is not lowered/,
        ],
        [
            `const u = new URL("https://a/"); u.searchParams.sort();`,
            /URLSearchParams.sort is not lowered/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});
