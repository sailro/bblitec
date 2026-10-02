const sheet = document.createElement("style");
sheet.textContent = `
.panel { position:fixed;inset:0;background:#202830;color:#60b0e0;--Tone:.2; }
.sample { position:absolute;top:90px;width:100px;height:80px;background:#e0a060; }
.first { left:90px;filter:brightness(calc(1 - var(--Tone, 0) * .5)) drop-shadow(8px 10px calc(var(--Tone) * 5px) currentColor); }
.second { left:290px;filter:drop-shadow(-8px 10px) saturate(calc(1 - var(--Tone) * .75)); }
.third { left:490px;filter:drop-shadow(0 12px 4px rgba(255,80,32,calc(var(--Tone) * .5))) brightness(calc(1 - var(--Missing, .2) * .5)); }
`;
document.head.append(sheet);
const panel = document.createElement("div");
panel.className = "panel";
document.body.append(panel);
const first = document.createElement("div");
first.className = "sample first";
const second = document.createElement("div");
second.className = "sample second";
const third = document.createElement("div");
third.className = "sample third";
panel.append(first, second, third);
panel.style.setProperty("--Tone", ".8");
panel.style.color = "#80c060";
panel.addEventListener("click", () => {
    panel.style.setProperty("--Tone", ".4");
    panel.style.color = "#e060a0";
    first.style.filter = "brightness(calc(1 - var(--Tone) * .25)) drop-shadow(12px 12px currentColor)";
});
