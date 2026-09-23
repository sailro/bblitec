import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("plain text updates retain Rml text nodes and refresh layout with structural fallbacks", (t) => {
    runRmlUiFixture(t, "ui-text-updates");
});
