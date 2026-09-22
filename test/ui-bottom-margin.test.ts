import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("auto-height blocks collapse descendant bottom margins with following siblings", (t) => {
    runRmlUiFixture(t, "ui-bottom-margin");
});
