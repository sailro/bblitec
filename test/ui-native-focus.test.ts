import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("native focus selects the control leaf and preserves range keyboard edits", (t) => {
    runRmlUiFixture(t, "ui-native-focus");
});
