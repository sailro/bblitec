import test from "node:test";
import { join, resolve } from "node:path";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("Window repaint receipts select submitted frames, bound slow producers and preserve retries", (t) => {
    const output = resolve("artifacts/window-repaint-receipts");
    emitUpstreamGenerated(output, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "window-repaint-receipts", {
        includeDirectories: [join(output, "upstream/include")],
    });
});
