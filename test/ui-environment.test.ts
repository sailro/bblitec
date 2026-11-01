import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("env() safe-area insets are the window's, read at run time", (t) => {
    runRmlUiFixture(t, "ui-environment");
});
