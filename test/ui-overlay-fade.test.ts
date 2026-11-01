import test from "node:test";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// A page's loading overlay (the lab demos' markup and styles): its progress
// bar fades in inside a rounded overflow clip, the overlay fades out over it
// and leaves the document; nothing of it may stay on screen. A translucent
// container then composites with its child as one group.
test("a faded and removed loading overlay leaves no pixels", (t) => {
    runApplicationRmlUiFixture(
        t,
        "ui-overlay-fade",
        "globalThis.close();",
        {},
        `<!doctype html><html><head><title>Overlay</title><style>
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
        .loading-overlay {
          position: fixed; inset: 0; z-index: 10000;
          display: flex; align-items: center; justify-content: center;
          background: #0b0809; transition: opacity 0.5s ease;
        }
        .loading-overlay.is-hidden { opacity: 0; pointer-events: none; }
        .loading-box { display: flex; flex-direction: column; align-items: center; gap: 1rem; }
        .loading-bar {
          width: 240px; max-width: 62vw; height: 4px; margin-top: 0.55rem;
          border-radius: 999px; overflow: hidden; background: rgba(255, 255, 255, 0.14);
          opacity: 0; transition: opacity 0.25s ease;
        }
        .loading-overlay.has-progress .loading-bar { opacity: 1; }
        .loading-bar-fill {
          width: 0%; height: 100%; border-radius: inherit; background: #e0684b;
          transition: width 0.25s ease;
        }
        </style></head><body>
        <div id="loadingOverlay" class="loading-overlay">
            <div class="loading-box">
                <div class="loading-bar"><div id="loadingBarFill" class="loading-bar-fill"></div></div>
            </div>
        </div>
        <script type="module" src="/entry.ts"></script></body></html>`,
    );
});
