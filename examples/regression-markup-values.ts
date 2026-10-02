const sheet = document.createElement("style");
sheet.textContent = `
body { margin:0; background:#202830; }
.panel { position:absolute; top:80px; width:360px; height:240px; padding:20px; background:#384858; }
.choices { display:flex; gap:20px; }
.stacked { flex-direction:column; }
.choice { display:block; width:150px; height:72px; border:0; padding:0; color:#182028; font:20px Arial; }
.go { background:#80b8f0; }
.cancel { background:#e09840; }
`;
document.head.append(sheet);

function button(label: string): string {
    return '<button type="button" class="choice go">' + label + '</button>';
}

function panel(stack: boolean, left: string): void {
    const root = document.createElement("div");
    root.className = "panel";
    root.style.left = left;
    let label = "Apply";
    const go = button(label);
    const cancel = '<button type="button" class="choice cancel">' + label + '</button>';
    label = "Later";
    root.innerHTML = '<div class="choices' + (stack ? ' stacked' : '') + '">' +
        (stack ? go + cancel : cancel + go) + '</div>';
    const apply = root.querySelector(".go") as HTMLElement;
    apply.addEventListener("click", () => {
        apply.style.backgroundColor = "#60c0a0";
        apply.textContent = "Done";
    });
    document.body.append(root);
}

const selected = performance.now() >= 0;
panel(selected, "80px");
panel(!selected, "540px");
