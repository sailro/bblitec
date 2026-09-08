// Page init script: pace requestAnimationFrame at a declared rate so a
// scene stepping its physics per rendered frame advances a known amount
// of simulated time per wall frame. Installed by a source hook calling
// `globalThis.__bblRafPacing(rate)` before the engine starts; without
// the call the page runs at the display's own cadence.
(() => {
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.__bblRafPacing = (rate) => {
    let previous;
    let timestamp = 1;
    globalThis.requestAnimationFrame = (callback) => raf((now) => {
      if (now !== previous) {
        timestamp += 1000 / rate;
        previous = now;
      }
      callback(timestamp);
    });
  };
})();
