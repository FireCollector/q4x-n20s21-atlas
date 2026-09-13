"use strict";

const state = { data: null, filtered: [], selected: null, family: "all", page: 0, pageSize: 10, sort: "id", color: "rho", hMin: 0, hMax: 1, canonicalRanges: [], scatterPoints: [], queryInitialized: false };
const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 4) => Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits });
const sci = (value) => Number(value).toExponential(3);
const metricLabels = { rho: "ρ̄", h: "h̄", kNorm: "‖Ke‖F" };
const MATCH_EXACT_TOLERANCE = 1e-8;
const NEIGHBOR_COUNT = 8;
const shapeParameters = [
  { label: "x₃ᶜ", name: "P3 横坐标", core: [.65, 1.25], boundary: [.45, 1.45] },
  { label: "y₃ᶜ", name: "P3 纵坐标", core: [.75, 1.35], boundary: [.55, 1.55] },
  { label: "x₄ᶜ", name: "P4 横坐标", core: [-.25, .35], boundary: [-.45, .55] },
  { label: "y₄ᶜ", name: "P4 纵坐标", core: [.75, 1.35], boundary: [.55, 1.55] },
];

function mixColor(t) {
  const stops = [[41,91,255],[57,215,210],[255,227,107],[255,106,101]];
  const x = Math.max(0, Math.min(.999, t)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  return `rgb(${stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f)).join(",")})`;
}

function toast(message) {
  const node = $("toast"); node.textContent = message; node.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 1800);
}

function configureControls(meta) {
  const [h0, h1] = meta.ranges.h;
  Object.assign(state, { hMin: h0, hMax: h1, canonicalRanges: meta.canonicalRanges.map(range => [...range]) });
  Object.assign($("h-min"), { min: h0, max: h1, value: h0 });
  Object.assign($("h-max"), { min: h0, max: h1, value: h1 });
  const sourceCount = meta.sourceRuns?.length || 1;
  $("run-id").textContent = `${sourceCount} 个数据源 · ${meta.runId} · ${meta.status}`;
  $("metric-count").textContent = meta.count.toLocaleString("zh-CN");
  $("metric-geometries").textContent = meta.geometryCount.toLocaleString("zh-CN");
  $("metric-fidelity").textContent = meta.fidelity;
  $("metric-status-detail").textContent = `${meta.count.toLocaleString("zh-CN")} 唯一键 · ${sourceCount} 源`;
  $("sampling-summary").textContent = `当前图谱汇集 ${sourceCount} 个独立 Sobol 批次，共 ${meta.geometryCount.toLocaleString("zh-CN")} 个规范几何；每个几何配 8 个 h̄，共 ${meta.count.toLocaleString("zh-CN")} 条 N20/S21 记录。`;
  $("geometry-filter-grid").innerHTML = shapeParameters.map((p, i) => `<div class="shape-slider-row"><div><label>${p.label}<small>${p.name}</small></label><output id="c${i}-output">—</output></div><div class="range-stack shape-range"><input id="c${i}-min" type="range" step="any" aria-label="${p.name}下限"><input id="c${i}-max" type="range" step="any" aria-label="${p.name}上限"></div></div>`).join("");
  meta.canonicalRanges.forEach((range, i) => {
    Object.assign($("c"+i+"-min"), { min: range[0], max: range[1], value: range[0] });
    Object.assign($("c"+i+"-max"), { min: range[0], max: range[1], value: range[1] });
  });
  const actual = [...meta.canonicalRanges, meta.ranges.h];
  const definitions = [...shapeParameters, { label: "h̄", core: [.04, .14], boundary: [.04, .14] }];
  $("parameter-range-body").innerHTML = definitions.map((p, i) => `<tr><th>${p.label}</th><td>${rangeText(p.core)}</td><td>${rangeText(p.boundary)}</td><td>${rangeText(actual[i])}</td></tr>`).join("");
  fillGeometryInputs();
  syncOutputs();
}

const rangeText = range => `${range[0].toFixed(3)} — ${range[1].toFixed(3)}`;

function fillGeometryInputs() {
  state.canonicalRanges.forEach((range, i) => { $("c"+i+"-min").value=range[0]; $("c"+i+"-max").value=range[1]; });
}

function syncOutputs() {
  $("h-output").textContent = `${state.hMin.toFixed(3)} — ${state.hMax.toFixed(3)}`;
  state.canonicalRanges.forEach((range,i)=>{$("c"+i+"-output").textContent=`${range[0].toFixed(3)} — ${range[1].toFixed(3)}`;});
}

function applyFilters() {
  state.filtered = state.data.records.filter(r =>
    (state.family === "all" || r.family === state.family) &&
    r.h >= state.hMin && r.h <= state.hMax &&
    r.canonical.every((value, i) => value >= state.canonicalRanges[i][0] && value <= state.canonicalRanges[i][1])
  );
  state.filtered.sort((a, b) => state.sort === "id" ? Number(a.id.match(/(\d+)$/)[1]) - Number(b.id.match(/(\d+)$/)[1]) : b[state.sort] - a[state.sort]);
  state.page = Math.min(state.page, Math.max(0, Math.ceil(state.filtered.length / state.pageSize) - 1));
  $("filtered-count").textContent = state.filtered.length.toLocaleString("zh-CN");
  if (!state.selected || !state.filtered.includes(state.selected)) state.selected = state.filtered[0] || null;
  renderAll();
}

function renderAll() { drawScatter(); renderSelected(); renderTable(); }

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  return { width, height, dpr };
}

function drawScatter() {
  const canvas = $("scatter-canvas"), { width, height, dpr } = resizeCanvas(canvas), ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height); state.scatterPoints = [];
  const pad = { l: 52*dpr, r: 18*dpr, t: 15*dpr, b: 36*dpr };
  const records = state.filtered, all = state.data.records;
  const xs = all.map(r => r.canonical[0]), ys = all.map(r => r.canonical[1]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  ctx.strokeStyle = "rgba(151,190,211,.12)"; ctx.fillStyle = "#7895a4"; ctx.lineWidth = dpr; ctx.font = `${11*dpr}px ui-monospace`;
  for (let i=0;i<=5;i++) {
    const x = pad.l + i*(width-pad.l-pad.r)/5, y = pad.t + i*(height-pad.t-pad.b)/5;
    ctx.beginPath(); ctx.moveTo(x,pad.t); ctx.lineTo(x,height-pad.b); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(width-pad.r,y); ctx.stroke();
    ctx.fillText((xmin+i*(xmax-xmin)/5).toFixed(2), x-12*dpr, height-12*dpr);
    ctx.fillText((ymax-i*(ymax-ymin)/5).toFixed(2), 5*dpr, y+4*dpr);
  }
  const range = state.data.meta.ranges[state.color], lo = range[0], hi = range[1];
  $("legend-low").textContent = fmt(lo, 3); $("legend-high").textContent = fmt(hi, 3);
  for (const r of records) {
    const x = pad.l + (r.canonical[0]-xmin)/(xmax-xmin)*(width-pad.l-pad.r);
    const y = height-pad.b - (r.canonical[1]-ymin)/(ymax-ymin)*(height-pad.t-pad.b);
    const selected = r === state.selected, radius = (selected ? 5.2 : r.family === "boundary" ? 2.9 : 2.1)*dpr;
    ctx.beginPath(); ctx.arc(x,y,radius,0,Math.PI*2); ctx.fillStyle = mixColor((r[state.color]-lo)/Math.max(hi-lo,1e-20)); ctx.globalAlpha = selected ? 1 : .7; ctx.fill();
    if (selected) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5*dpr; ctx.stroke(); }
    state.scatterPoints.push({ x:x/dpr, y:y/dpr, record:r });
  }
  ctx.globalAlpha = 1;
  if (!records.length) { ctx.fillStyle = "#8da7b5"; ctx.font = `${15*dpr}px sans-serif`; ctx.fillText("当前条件下没有样本", width/2-70*dpr, height/2); }
}

function geometryMarkup(record) {
  if (!record) return `<text x="180" y="130" fill="#8da7b5" text-anchor="middle">未选择样本</text>`;
  const nodes = [[0,0],[1,0],[record.canonical[0],record.canonical[1]],[record.canonical[2],record.canonical[3]]];
  const xs=nodes.map(n=>n[0]), ys=nodes.map(n=>n[1]), minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
  const scale=Math.min(270/Math.max(maxX-minX,.1),190/Math.max(maxY-minY,.1));
  const p=nodes.map(([x,y])=>[180+(x-(minX+maxX)/2)*scale,137-(y-(minY+maxY)/2)*scale]);
  const polygon=p.map(n=>n.join(",")).join(" ");
  const width=Math.max(4, Math.min(18, record.h*85));
  return `<defs><filter id="glow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <polygon points="${polygon}" fill="rgba(89,216,255,.035)" stroke="#59d8ff" stroke-width="2"/>
    <line x1="${p[0][0]}" y1="${p[0][1]}" x2="${p[2][0]}" y2="${p[2][1]}" stroke="#a7f36b" stroke-width="${width}" stroke-linecap="round" opacity=".78" filter="url(#glow)"/>
    <line x1="${p[1][0]}" y1="${p[1][1]}" x2="${p[3][0]}" y2="${p[3][1]}" stroke="#a7f36b" stroke-width="${width}" stroke-linecap="round" opacity=".78" filter="url(#glow)"/>
    ${p.map((n,i)=>`<circle cx="${n[0]}" cy="${n[1]}" r="5" fill="#081521" stroke="#fff"/><text x="${n[0]+9}" y="${n[1]-9}" fill="#a9c0cb" font-size="12">P${i+1}</text>`).join("")}`;
}

function renderSelected() {
  const r = state.selected;
  $("selected-id").textContent = r ? r.id : "—"; $("geometry-svg").innerHTML = geometryMarkup(r);
  $("selected-h").textContent = r ? r.h.toFixed(4) : "—"; $("selected-rho").textContent = r ? r.rho.toFixed(4) : "—"; $("selected-k").textContent = r ? r.kNorm.toFixed(4) : "—";
  drawMatrix(r);
}

function drawMatrix(record) {
  const canvas=$("matrix-canvas"), {width,height,dpr}=resizeCanvas(canvas), ctx=canvas.getContext("2d"); ctx.clearRect(0,0,width,height);
  if (!record) return;
  const m=record.matrix, max=Math.max(...m.map(Math.abs)), labels=["u₁x","u₁y","u₂x","u₂y","u₃x","u₃y","u₄x","u₄y"];
  const pad=34*dpr, size=Math.min(width-pad-5*dpr,height-pad-5*dpr), cell=size/8;
  for(let row=0;row<8;row++) for(let col=0;col<8;col++) {
    const v=m[row*8+col], t=v/max, x=pad+col*cell, y=pad+row*cell;
    const color=t>=0 ? `rgba(89,216,255,${.12+.88*Math.abs(t)})` : `rgba(255,116,116,${.12+.88*Math.abs(t)})`;
    ctx.fillStyle=color; ctx.fillRect(x+1,y+1,cell-2,cell-2);
  }
  ctx.fillStyle="#89a4b2"; ctx.font=`${10*dpr}px sans-serif`; ctx.textAlign="center";
  labels.forEach((l,i)=>{ctx.fillText(l,pad+(i+.5)*cell,22*dpr); ctx.save();ctx.translate(17*dpr,pad+(i+.62)*cell);ctx.rotate(-Math.PI/2);ctx.fillText(l,0,0);ctx.restore();});
  $("matrix-scale").textContent=`± ${max.toExponential(2)}`;
  canvas.matrixMeta={pad:pad/dpr,cell:cell/dpr,record,max};
}

function renderTable() {
  const start=state.page*state.pageSize, page=state.filtered.slice(start,start+state.pageSize);
  $("record-body").innerHTML=page.map(r=>`<tr data-id="${r.id}" class="${r===state.selected?'selected':''}"><td>${r.id}</td><td><span class="family-tag ${r.family}">${r.family==="core"?"常规":"边界"}</span></td><td>${r.h.toFixed(4)}</td><td>${r.rho.toFixed(4)}</td><td>${r.kNorm.toFixed(4)}</td></tr>`).join("");
  const pages=Math.max(1,Math.ceil(state.filtered.length/state.pageSize)); $("page-label").textContent=`${state.filtered.length?start+1:0}–${Math.min(start+state.pageSize,state.filtered.length)} / ${state.filtered.length.toLocaleString("zh-CN")}`;
  $("prev-page").disabled=state.page===0; $("next-page").disabled=state.page>=pages-1;
  Object.assign($("page-jump-input"),{max:pages,placeholder:`1–${pages}`});
  $("page-jump-button").disabled=pages<=1;
  renderPageNumbers(pages);
  $("record-body").querySelectorAll("tr").forEach(row=>row.addEventListener("click",()=>selectRecord(state.data.records.find(r=>r.id===row.dataset.id))));
}

function renderPageNumbers(pageCount) {
  const current=state.page+1, visible=new Set([1,pageCount,current-2,current-1,current,current+1,current+2]);
  const pages=[...visible].filter(page=>page>=1&&page<=pageCount).sort((a,b)=>a-b);
  const parts=[];
  pages.forEach((page,index)=>{
    if(index&&page-pages[index-1]>1) parts.push(`<span class="page-gap" aria-hidden="true">…</span>`);
    parts.push(`<button class="page-number${page===current?' active':''}" data-page="${page-1}"${page===current?' aria-current="page"':''} aria-label="第 ${page} 页">${page}</button>`);
  });
  $("page-numbers").innerHTML=parts.join("");
  $("page-numbers").querySelectorAll("button").forEach(button=>button.addEventListener("click",()=>{state.page=+button.dataset.page;renderTable();}));
}

function selectRecord(record) { if(!record)return; state.selected=record; renderAll(); }

function fillQueryFromRecord(record) {
  if (!record) return;
  for (let i=0;i<4;i++) {
    $("q-x"+(i+1)).value=record.raw[i*2].toFixed(6);
    $("q-y"+(i+1)).value=record.raw[i*2+1].toFixed(6);
  }
  $("q-h").value=record.h.toFixed(6);
  state.queryInitialized=true;
}

function readCustomerQuery() {
  const raw=[];
  for(let i=1;i<=4;i++) raw.push(+$("q-x"+i).value,+$("q-y"+i).value);
  const h=+$("q-h").value;
  if(!raw.every(Number.isFinite)||!Number.isFinite(h)||h<=0) throw new Error("请完整输入 8 个坐标和正的杆宽比");
  const [x1,y1,x2,y2,x3,y3,x4,y4]=raw, vx=x2-x1, vy=y2-y1, length=Math.hypot(vx,vy);
  if(length<1e-12) throw new Error("P1 与 P2 不能重合");
  const ex=vx/length, ey=vy/length;
  const project=(x,y)=>[((x-x1)*ex+(y-y1)*ey)/length, (-(x-x1)*ey+(y-y1)*ex)/length];
  return {raw,h,canonical:[...project(x3,y3),...project(x4,y4)]};
}

function resetFilters() {
  const m=state.data.meta;
  state.family="all";state.hMin=m.ranges.h[0];state.hMax=m.ranges.h[1];state.canonicalRanges=m.canonicalRanges.map(range=>[...range]);state.color="rho";state.sort="id";
  $("h-min").value=state.hMin;$("h-max").value=state.hMax;$("color-metric").value="rho";$("sort-select").value="id";
  $("family-filter").querySelectorAll("button").forEach(b=>b.classList.toggle("active",b.dataset.value==="all"));
  fillGeometryInputs();syncOutputs();
}

function matchCustomerQuery() {
  try {
    const query=readCustomerQuery(), ranges=state.data.meta.canonicalRanges, hr=state.data.meta.ranges.h;
    const ranked=state.data.records.map(record=>{
      let distance=((record.h-query.h)/(hr[1]-hr[0]))**2;
      for(let i=0;i<4;i++) distance+=((record.canonical[i]-query.canonical[i])/(ranges[i][1]-ranges[i][0]))**2;
      return {record,distance};
    }).sort((a,b)=>a.distance-b.distance);
    const exact=ranked[0].distance<=MATCH_EXACT_TOLERANCE, matches=exact?[ranked[0].record]:ranked.slice(0,NEIGHBOR_COUNT).map(item=>item.record), best=matches[0];
    resetFilters();state.filtered=matches;state.selected=best;state.page=0;
    $("filtered-count").textContent=matches.length.toLocaleString("zh-CN");renderAll();
    const resultTitle=exact?`精确命中 ${best.id}`:`未找到完全相同记录，已显示附近 ${matches.length} 个样本`;
    $("query-result").innerHTML=`<strong>${resultTitle}</strong><small>最近样本：${best.id} · h̄ ${best.h.toFixed(6)}<br>内部规范坐标：${query.canonical.map(v=>v.toFixed(3)).join(" · ")}</small><button type="button" id="view-match">查看联动结果</button>`;
    $("view-match").addEventListener("click",()=>$("selected-id").scrollIntoView({behavior:"smooth",block:"center"}));
    const panel=document.querySelector(".specimen-panel");panel.classList.remove("match-flash");requestAnimationFrame(()=>panel.classList.add("match-flash"));
    toast(exact?"已找到精确记录":"已显示最接近的参考样本");
  } catch(error) { $("query-result").innerHTML=`<span class="query-error">${error.message}</span>`; }
}

function nearestScatter(event) {
  const rect=$("scatter-canvas").getBoundingClientRect(), x=event.clientX-rect.left, y=event.clientY-rect.top;
  let best=null, distance=Infinity; for(const p of state.scatterPoints){const d=(p.x-x)**2+(p.y-y)**2;if(d<distance){distance=d;best=p;}}
  return distance<=144?best:null;
}

function showDetail() {
  const r=state.selected; if(!r)return;
  $("detail-title").textContent=r.id;
  const items=[
    ["几何组编号",r.geometry],["采样类型",r.family==="core"?"常规样本":"边界样本"],["固定规范节点",`P1=(0, 0)，P2=(1, 0)` ,"wide"],
    ["规范坐标 P3",`(${r.canonical[0].toFixed(6)}, ${r.canonical[1].toFixed(6)})`],["规范坐标 P4",`(${r.canonical[2].toFixed(6)}, ${r.canonical[3].toFixed(6)})`],
    ["杆宽比 h̄",r.h.toFixed(6)],["相对密度 ρ̄",r.rho.toFixed(6)],["刚度范数 ‖Ke‖F",r.kNorm.toFixed(8)],
    ["原始四节点坐标",r.raw.reduce((s,v,i)=>s+`${i%2===0?`P${i/2+1}=(`:", "}${v.toFixed(6)}${i%2===1?")  ":""}`,""),"wide"]
  ];
  $("detail-content").innerHTML=items.map(([label,value,wide])=>`<div class="${wide||''}"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("detail-dialog").showModal();
}

function exportFiltered() {
  const header=["case_id","geometry_id","sample_type","x3c","y3c","x4c","y4c","h_bar","rho_bar","ke_frobenius"];
  const lines=[header.join(","),...state.filtered.map(r=>[r.id,r.geometry,r.family,...r.canonical,r.h,r.rho,r.kNorm].join(","))];
  const url=URL.createObjectURL(new Blob(["\ufeff"+lines.join("\n")],{type:"text/csv;charset=utf-8"}));
  const link=document.createElement("a");link.href=url;link.download=`q4x-filtered-${state.filtered.length}.csv`;link.click();URL.revokeObjectURL(url);toast("筛选结果已导出");
}

function bindEvents() {
  $("family-filter").querySelectorAll("button").forEach(button=>button.addEventListener("click",()=>{$("family-filter").querySelectorAll("button").forEach(b=>b.classList.toggle("active",b===button));state.family=button.dataset.value;applyFilters();}));
  $("h-min").addEventListener("input",e=>{state.hMin=Math.min(+e.target.value,state.hMax);syncOutputs();applyFilters();});
  $("h-max").addEventListener("input",e=>{state.hMax=Math.max(+e.target.value,state.hMin);syncOutputs();applyFilters();});
  $("color-metric").addEventListener("change",e=>{state.color=e.target.value;drawScatter();});
  $("sort-select").addEventListener("change",e=>{state.sort=e.target.value;applyFilters();});
  $("prev-page").addEventListener("click",()=>{state.page--;renderTable();}); $("next-page").addEventListener("click",()=>{state.page++;renderTable();});
  $("page-jump-form").addEventListener("submit",event=>{event.preventDefault();const pages=Math.max(1,Math.ceil(state.filtered.length/state.pageSize)),target=Math.trunc(Number($("page-jump-input").value));if(!Number.isFinite(target)||target<1||target>pages){toast(`请输入 1–${pages} 之间的页码`);return;}state.page=target-1;renderTable();$("page-jump-input").select();});
  $("open-detail").addEventListener("click",showDetail); $("selected-id").addEventListener("dblclick",showDetail);
  $("update-guide").addEventListener("click",()=>$("guide-dialog").showModal()); $("export-button").addEventListener("click",exportFiltered);
  $("parameter-guide").addEventListener("click",()=>$("parameter-dialog").showModal());
  shapeParameters.forEach((_,i)=>["min","max"].forEach(side=>$("c"+i+"-"+side).addEventListener("input",e=>{const pair=state.canonicalRanges[i];if(side==="min")pair[0]=Math.min(+e.target.value,pair[1]);else pair[1]=Math.max(+e.target.value,pair[0]);fillGeometryInputs();syncOutputs();applyFilters();})));
  $("reset-shape").addEventListener("click",()=>{state.canonicalRanges=state.data.meta.canonicalRanges.map(range=>[...range]);fillGeometryInputs();syncOutputs();applyFilters();});
  $("match-query").addEventListener("click",matchCustomerQuery);
  $("copy-id").addEventListener("click",async()=>{await navigator.clipboard.writeText(state.selected.id);toast("样本编号已复制");});
  $("reset-button").addEventListener("click",()=>{resetFilters();applyFilters();$("query-result").innerHTML="<span>筛选条件已恢复</span>";});
  $("scatter-canvas").addEventListener("mousemove",e=>{const p=nearestScatter(e),tip=$("scatter-tooltip");if(!p){tip.hidden=true;return;}tip.hidden=false;tip.style.left=`${e.offsetX+15}px`;tip.style.top=`${e.offsetY+15}px`;tip.innerHTML=`<b>${p.record.id}</b><br>h̄ ${fmt(p.record.h,6)}`;});
  $("scatter-canvas").addEventListener("mouseleave",()=>$("scatter-tooltip").hidden=true); $("scatter-canvas").addEventListener("click",e=>{const p=nearestScatter(e);if(p)selectRecord(p.record);});
  $("matrix-canvas").addEventListener("mousemove",e=>{const c=e.currentTarget,m=c.matrixMeta,tip=$("matrix-tooltip");if(!m)return;const x=e.offsetX-m.pad,y=e.offsetY-m.pad,col=Math.floor(x/m.cell),row=Math.floor(y/m.cell);if(row<0||row>7||col<0||col>7){tip.hidden=true;return;}tip.hidden=false;tip.style.left=`${e.offsetX+12}px`;tip.style.top=`${e.offsetY+12}px`;tip.textContent=`K[${row+1},${col+1}] = ${m.record.matrix[row*8+col].toExponential(5)}`;});
  $("matrix-canvas").addEventListener("mouseleave",()=>$("matrix-tooltip").hidden=true);
  window.addEventListener("resize",()=>{drawScatter();drawMatrix(state.selected);});
  document.addEventListener("pointermove",e=>{document.documentElement.style.setProperty("--mx",`${e.clientX}px`);document.documentElement.style.setProperty("--my",`${e.clientY}px`);},{passive:true});
}

async function boot() {
  try {
    const response=await fetch("./data/q4x-data.json",{cache:"no-store"}); if(!response.ok)throw new Error(`HTTP ${response.status}`);
    state.data=await response.json(); configureControls(state.data.meta); bindEvents(); applyFilters(); fillQueryFromRecord(state.selected); document.body.classList.add("ready");
  } catch(error) {
    document.body.innerHTML=`<main style="max-width:720px;margin:12vh auto;padding:32px;color:#edf8fb;font-family:sans-serif"><h1>数据快照未载入</h1><p style="color:#8da7b5">请先生成 dist/data/q4x-data.json，再通过本地服务器访问站点。</p><pre>${String(error)}</pre></main>`;
  }
}

boot();
