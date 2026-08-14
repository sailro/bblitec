import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
    createSuiteSceneServer,
} from "../src/capture-suite-reference.js";

test("serves entry modules from their source-relative URL", async () => {
    const root = mkdtempSync(
        resolve(".capture-suite-reference-"),
    );
    const entry = resolve(root, "nested", "entry.ts");
    const helper = resolve(root, "nested", "helper.ts");
    mkdirSync(resolve(root, "nested"));
    writeFileSync(entry, 'import "./helper.js";\n');
    writeFileSync(helper, "export const value = 1;\n");

    const server = createSuiteSceneServer(
        'import "./helper.js";\n',
        { sourcePath: entry },
    );
    try {
        await new Promise<void>((done) =>
            server.listen(0, "127.0.0.1", done),
        );
        const address = server.address();
        assert.ok(
            address && typeof address !== "string",
        );
        const base = `http://127.0.0.1:${address.port}`;
        const html = await (
            await fetch(`${base}/scene.html`)
        ).text();
        const entryPath = `/${root
            .slice(resolve(".").length + 1)
            .replaceAll("\\", "/")}/nested/entry.js`;
        assert.match(
            html,
            new RegExp(
                `src="${entryPath.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    "\\$&",
                )}"`,
            ),
        );
        const entryResponse = await fetch(
            `${base}${entryPath}`,
        );
        assert.equal(entryResponse.status, 200);
        const helperResponse = await fetch(
            `${base}${entryPath.replace(
                /entry\.js$/,
                "helper.js",
            )}`,
        );
        assert.equal(helperResponse.status, 200);
        assert.match(
            await helperResponse.text(),
            /export const value = 1/,
        );
    } finally {
        await new Promise<void>((done) =>
            server.close(() => done()),
        );
        rmSync(root, { recursive: true, force: true });
    }
});
