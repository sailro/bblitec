import assert from "node:assert/strict";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";
import type { NativeHostUiNode } from "../src/compiler/types.js";
import { runRmlUiFixture } from "./native-fixture.js";

const program = (body: string): string => `
    import { createEngine, startEngine } from "@babylonjs/lite";
    async function main(): Promise<void> {
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        const link = document.createElement("a");
        ${body}
        await startEngine(engine);
    }
    void main();
`;

const navigation =
    /bbl::ui_set_link_navigation\([^;]*bbl::pal::window_location_assign\(url, /;

test("a retained link activates as location.assign; a download beside a document URL refuses", () => {
    const link = compileSource(
        program(`
            const url = new URL(location.href);
            url.searchParams.set("quality", "low");
            link.href = url.href;
            link.hidden = false;
            link.click();
        `),
    );
    assert.match(link.cpp, navigation);
    assert.match(link.cpp, /bbl::ui_set_attribute\([^;]*"href", /);
    assert.match(link.cpp, /bbl::ui_click\(/);
    assert.ok(
        !link.manifest.features.includes("browser:file"),
        "a link's click reaches no download machinery",
    );
    for (const body of [
        'link.href = "https://example.invalid/"; link.download = "map.json";',
        'link.download = "map.json"; link.href = "https://example.invalid/";',
    ])
        assert.throws(
            () => compileSource(program(body)),
            (error: unknown) =>
                error instanceof CompileError &&
                /A native download anchor's href requires an object URL/.test(
                    error.message,
                ),
        );
});

test("a host link to this browsing context installs the navigation once; another context's stays inert", () => {
    const source = program("link.hidden = true;");
    const anchor = (href: string, target?: string): NativeHostUiNode => ({
        tag: "a",
        attributes: { href, ...(target !== undefined ? { target } : {}) },
    });
    const compiled = (elements: NativeHostUiNode[]): string =>
        compileSource(source, {
            nativeHostUi: {
                sourcePath: "test/ui-link-activation.test.ts",
                elements: [
                    { tag: "canvas", attributes: { id: "renderCanvas" } },
                    ...elements,
                ],
            },
        }).cpp;
    const links = compiled([
        anchor("./reference.html"),
        anchor("?quality=low", "_top"),
    ]);
    assert.equal(links.match(new RegExp(navigation.source, "g"))?.length, 1);
    assert.doesNotMatch(
        compiled([anchor("https://example.test/", "_blank")]),
        /ui_set_link_navigation/,
    );
});

test("link activation navigates by click and click(); other targets and a missing navigation do not", (t) => {
    runRmlUiFixture(t, "ui-link-activation");
});
