import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("visibility preserves layout, descendant overrides, input and delayed transitions", (t) => {
    runRmlUiFixture(t, "ui-visibility");
});
