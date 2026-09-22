import test from "node:test";
import { join, resolve } from "node:path";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("window input services layout without advancing repaint before its default action", (t) => {
    const output = resolve("artifacts/window-input-order");
    emitUpstreamGenerated(output, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "window-input-order", {
        includeDirectories: [join(output, "upstream/include")],
    });
});
