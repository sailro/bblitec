import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("border styles give undrawn sides no width and dash square and rounded borders as Chromium does", (t) => {
    runRmlUiFixture(t, "ui-border-style");
});
