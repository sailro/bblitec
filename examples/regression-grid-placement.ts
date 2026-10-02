const sheet = document.createElement("style");
sheet.textContent = `
body { margin:0; background:#202830; }
.board { position:absolute; display:grid; gap:10px; background:#384858; }
.cell { background:#80b8f0; min-height:30px; }
.warm { background:#e09840; }
.green { background:#60c0a0; }
.violet { background:#b090d0; }
.layout { left:50px; top:50px; width:350px; height:210px; grid-template-columns:60px 90px 120px; grid-template-rows:40px 60px 80px; justify-content:start; align-content:start; }
.wide { grid-column:span 2; }
.reserved { grid-column:2; grid-row:1 / span 2; }
.fit { left:460px; top:50px; width:350px; grid-template-columns:repeat(auto-fit,minmax(70px,1fr)); }
.fill { left:460px; top:120px; width:350px; grid-template-columns:repeat(auto-fill,minmax(70px,1fr)); }
.intrinsic { left:460px; top:190px; width:350px; grid-template-columns:minmax(34px,auto) minmax(0,1fr); }
.small { width:74px; }
.cap { left:50px; top:330px; width:350px; grid-template-columns:minmax(0,90px) 1fr; grid-template-rows:35px 45px; }
.end { grid-column:-2 / -1; grid-row:1 / span 2; }
.stack { position:absolute; left:460px; top:330px; width:150px; height:120px; isolation:isolate; background:#384858; }
.raised { position:absolute; left:20px; top:20px; width:130px; height:90px; z-index:10; background:#e09840; }
.cover { position:absolute; left:530px; top:370px; width:150px; height:90px; z-index:1; background:#80b8f0; }
.toggle { position:absolute; left:50px; top:470px; width:350px; height:50px; border:0; padding:0; font:18px Arial; line-height:50px; color:#182028; background:#60c0a0; }
`;
document.head.append(sheet);

function cell(parent: HTMLElement, classes: string): HTMLDivElement {
    const element = document.createElement("div");
    element.className = "cell " + classes;
    parent.append(element);
    return element;
}

function board(classes: string): HTMLDivElement {
    const element = document.createElement("div");
    element.className = "board " + classes;
    document.body.append(element);
    return element;
}

const layout = board("layout");
cell(layout, "");
const moving = cell(layout, "wide green");
cell(layout, "violet");
cell(layout, "reserved warm");
const fit = board("fit");
cell(fit, ""); cell(fit, "warm"); cell(fit, "green");
const fill = board("fill");
cell(fill, ""); cell(fill, "warm"); cell(fill, "green");
const intrinsic = board("intrinsic");
cell(intrinsic, "small warm"); cell(intrinsic, "green");
const capped = board("cap");
cell(capped, "warm"); cell(capped, "end violet"); cell(capped, "green");

const group = document.createElement("div");
group.className = "stack";
const raised = document.createElement("div");
raised.className = "raised";
group.append(raised);
document.body.append(group);
const cover = document.createElement("div");
cover.className = "cover";
document.body.append(cover);
const toggle = document.createElement("button");
toggle.className = "toggle";
toggle.textContent = "Change placement";
toggle.addEventListener("click", () => {
    moving.style.gridColumn = "-2 / -1";
    moving.style.gridRow = "-2 / -1";
    group.style.isolation = "auto";
    fit.style.width = "230px";
    toggle.textContent = "Placement changed";
});
document.body.append(toggle);
