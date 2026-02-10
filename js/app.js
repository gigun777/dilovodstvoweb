// js/app.js
// BUILD: v12.6.23 (Merged: TransferCore + SpacesCore + UX|UI Circles + Gestures + QuickNav + Device env)
import { openDB, cfgGet, cfgSet, cfgGetBackupManifest, getRows, addRow, putRow, deleteRow, clearRows, clearAllRows,
         getAllCases, addCase, getCaseRows, addCaseRow, putCaseRow, deleteCaseRow, clearAllCasesAndRows } from "./db.js";
import { DEFAULT_SHEETS, CASE_DESC_COLUMNS, uaDateToday, parseUAdate, excelSerialToUAdate, isIntegerString, nowStamp, safeName, normalizeForExport } from "./schema.js";
import { $, el, showMenu, hideMenu, modalOpen, btn, confirmDeleteNumber, downloadBlob } from "./ui.js";
import { unzipStoreEntries, unzipEntries } from "./zip.js";
import { exportDOCXTable, exportXLSXTable } from "./office.js";
import { exportPDFTable } from "./pdfgen.js";
import { exportAllZipJSON, exportFullBackupZipAllFormats, exportJournalAsJSON, exportJournalAsDOCX, exportJournalAsXLSX, exportJournalAsPDF, makeJournalExportFileName, makeCaseExportFileName } from "./export.js";
import { ensureDefaultTransferRules, ensureDefaultTransferTemplates, getTransferTemplates } from "./transfer.js?v=12.6.23";
import { getAllSheets, saveUserSheets, saveAllSheets, getSheetSettings, saveSheetSettings, getAddFieldConfig, saveAddFieldConfig, getUISettings, saveUISettings, buildSettingsUI } from "./settings.js?v=12.6.23";
import { executeTransfer } from "./transfer_core.js?v=12.6.23";
import { createQuickNavPanel } from "./quicknav.js?v=12.6.23";
import { initDeviceEnv } from "./device.js?v=12.6.23";

import {
  ensureSpaces, addSpace, addSubspace, spaceChildren, spaceById,
  ensureJournalTree, saveJournalTree,
  nodeById, childrenOf, nodeTitle,
  currentDataKey, activeSheetKey, journalKeyForSheet,
  createChild
} from "./spaces_core.js?v=12.6.23";

import {
  ensureValidJournalPath,
  buildNavModel,
  breadcrumbs,
  goParent,
  goFirstChild,
  isActiveNode,
  setTop,
  setAtDepth,
  setChild
} from "./navigation_core.js?v=12.6.23";
import { StructureCore } from "./structure_core.js";
// (imports above are the single source of truth)

// Device environment (PPI / type / DPR) for adaptive UX (Android WebView friendly)
try{ initDeviceEnv(); }catch(_e){}

await openDB();
await ensureDefaultTransferRules();

const state = {
  // Stage 2 (minimal): fixed Level="Адміністратор" + one root space ("Простір 1").
  level:"admin",
  spaceId:"space1", // single root space
  spaces:[],          // cached spaces list
  // Journal tree (nested subjournals)
  jtree:null,         // { nodes: {id:node}, topIds:[id...] }
  journalPath:[],     // [topJournalId, childId, childId, ...]
  mode:"sheet",
  sheetKey: DEFAULT_SHEETS[0].key,
  caseId: null,
  search:"",
  sort: { col:null, dir:1 },
  sheets: [],
  sheetSettings: {},
  addFieldsCfg: {},
  uiSettings: { circleNav:false, gestures:false },
  settingsDirty:false,
  settingsTab:"sheets",
  selectionMode:false,
  selectedRowIds:new Set(),
};

const levelSelect = $("#levelSelect");
const circleSpacesWrap = $("#circleSpacesWrap");
const circleJournalsWrap = $("#circleJournalsWrap");
const spaceSelect = $("#spaceSelect");
const subspaceChain = $("#subspaceChain");
const btnAddSubspace = $("#btnAddSubspace");
const btnQuickNav = $("#btnQuickNav");
const sheetSelect = $("#sheetSelect");
const subjournalChain = $("#subjournalChain");
const caseSelect = $("#caseSelect");
const btnCaseBack = $("#btnCaseBack");
const table = $("#table");
const cards = $("#cards");
const menu = $("#menu");
const sideHint = $("#sideHint");

function isCustomKey(key){ return key.startsWith("custom_"); }

function toggleRowSelection(rowId){
  if(!state.selectionMode) return;
  const set = state.selectedRowIds;
  if(set.has(rowId)) set.delete(rowId);
  else set.add(rowId);
  state.selectedRowIds = new Set(set);
  // update transfer button visibility
  $("#btnTransferSelected").style.display = (state.selectionMode?"inline-block":"none");
  render();
}

async function loadConfig(){
  state.sheets = await getAllSheets();
  state.sheetSettings = await getSheetSettings();
  state.addFieldsCfg = await getAddFieldConfig();
  state.uiSettings = await getUISettings();
  const saved = await cfgGet("last_view");
  if(saved){
    state.mode = "sheet";
    state.spacePath = Array.isArray(saved.spacePath) ? saved.spacePath : (saved.spaceId ? [saved.spaceId] : []);
    state.spaceId = (state.spacePath && state.spacePath.length) ? state.spacePath[state.spacePath.length-1] : (saved.spaceId || state.spaceId || "space1");
    state.journalPath = Array.isArray(saved.journalPath) ? saved.journalPath : [];
    state.sheetKey = saved.sheetKey || state.sheetKey;
    state.caseId = null;
  }
  state.spaces = await ensureSpaces();
  // Ensure spacePath points to an existing space, otherwise fallback to first root.
  if(!Array.isArray(state.spacePath)) state.spacePath = [];
  if(state.spaceId && !spaceById(state.spaces, state.spaceId)){
    const roots = spaceChildren(state.spaces, null);
    const first = roots[0] || state.spaces[0];
    state.spacePath = first ? [first.id] : [];
    state.spaceId = first ? first.id : "space1";
  }
  // Load per-space journal tree (each space has its own independent hierarchy)
  state.jtree = await ensureJournalTree(state.spaceId, state.sheets);
  // ensure there is always a valid top journal selected
  if(!state.journalPath.length){
    const topId = state.jtree?.topIds?.[0];
    if(topId) state.journalPath = [topId];
  }
}
async function saveView(){
	await cfgSet("last_view", {spaceId:state.spaceId, spacePath: state.spacePath || [state.spaceId], journalPath:state.journalPath, mode:"sheet", sheetKey:state.sheetKey, caseId:null});
}

function curDataKey(){ return currentDataKey(state.spaceId, state.journalPath); }
function curSheetKey(){ return activeSheetKey(state.jtree, state.journalPath, state.sheetKey); }
function currentSheet(){ return state.sheets.find(s=>s.key===curSheetKey()); }

// --- SpacesCore & NavigationCore are now in separate modules ---



function ensureSimplifiedConfig(entity){
  if(!entity) return;
  if(!entity.simplified) entity.simplified = { enabled:false, on:false, activeTemplateId:null, templates:[] };
  if(typeof entity.simplified.enabled!=="boolean") entity.simplified.enabled = false;
  if(typeof entity.simplified.on!=="boolean") entity.simplified.on = false;
  if(!Array.isArray(entity.simplified.templates)) entity.simplified.templates = [];
  // No default template: normal table view is the default when simplified view is OFF.
  // User creates simplified templates explicitly in the constructor.
  if(entity.simplified.enabled && !entity.simplified.activeTemplateId && entity.simplified.templates.length){
    entity.simplified.activeTemplateId = entity.simplified.templates[0].id;
  }
}
function currentSimplifiedEntity(){
  if(state.mode==="case"){
    // Stage 1: cases do not yet have simplified settings; return null.
    return null;
  }
  return currentSheet();
}
function updateSimplifiedToggle(){
  const btn = document.getElementById("btnSimpleView");
  const sel = document.getElementById("simpleViewTemplate");
  if(!btn) return;
  const ent = currentSimplifiedEntity();
  if(!ent){
    btn.disabled=true; btn.classList.remove("btn-toggle-on"); btn.title="Спрощений перегляд (немає профілю)";
    if(sel){ sel.style.display="none"; sel.innerHTML=""; }
    return;
  }
  ensureSimplifiedConfig(ent);
  const cfg = ent.simplified;
  const hasProfile = cfg.enabled && (cfg.templates||[]).length>0;
  btn.disabled = !hasProfile;
  btn.classList.toggle("btn-toggle-on", !!(hasProfile && cfg.on));
  btn.textContent = cfg.on ? "☰ Спрощено: ON" : "☰ Спрощено";
  btn.title = hasProfile ? "Спрощений перегляд" : "Спрощений перегляд (не налаштовано)";

  // Stage 2: template switcher (only when profile exists and more than 1 template)
  if(sel){
    if(hasProfile && (cfg.templates||[]).length>1){
      sel.style.display = "";
      sel.innerHTML = "";
      for(const t of cfg.templates){
        sel.appendChild(el("option",{value:t.id, textContent:t.name||t.id}));
      }
      sel.value = cfg.activeTemplateId || cfg.templates[0].id;
      sel.onchange = async ()=>{
        cfg.activeTemplateId = sel.value;
        await saveUserSheets(state.sheets);
      };
    } else {
      sel.style.display = "none";
      sel.innerHTML = "";
      sel.onchange = null;
    }
  }
}
async function toggleSimplifiedView(){
  const ent = currentSimplifiedEntity();
  if(!ent) return;
  ensureSimplifiedConfig(ent);
  if(!(ent.simplified.enabled && ent.simplified.templates.length)) return;
  ent.simplified.on = !ent.simplified.on;
  await saveUserSheets(state.sheets); // persist
  updateSimplifiedToggle();
  try{ if(state.mode==='sheet') await renderSheet(); }catch(e){}
}



function getActiveSimplifiedTemplate(entity){
  if(!entity?.simplified) return null;
  const cfg = entity.simplified;
  const id = cfg.activeTemplateId || (cfg.templates?.[0]?.id || null);
  if(!id) return null;
  return (cfg.templates||[]).find(t=>t.id===id) || null;
}
function hexToRgba(hex, alpha){
  try{
    if(!hex) return `rgba(0,0,0,${alpha})`;
    let h = hex.trim();
    if(h.startsWith("#")) h=h.slice(1);
    if(h.length===3) h=h.split("").map(c=>c+c).join("");
    const r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16);
    const a=Math.max(0,Math.min(1,Number(alpha)));
    return `rgba(${r},${g},${b},${a})`;
  }catch(e){
    const a=Math.max(0,Math.min(1,Number(alpha)));
    return `rgba(0,0,0,${a})`;
  }
}
function ensureSimplifiedTheme(entity){
  ensureSimplifiedConfig(entity);
  const t = entity.simplified.theme || (entity.simplified.theme = {});
  if(!Number.isFinite(t.radius)) t.radius = 16;
  if(typeof t.showBorders!=="boolean") t.showBorders = false;
  if(typeof t.glass!=="boolean") t.glass = true;
  if(typeof t.gradient!=="boolean") t.gradient = false;
  if(typeof t.cardColor!=="string") t.cardColor = "#ff3b30";
  if(typeof t.cardOpacity!=="number") t.cardOpacity = 0.92;
  if(typeof t.gradFrom!=="string") t.gradFrom = "#ff3b30";
  if(typeof t.gradTo!=="string") t.gradTo = "#ff9500";
  if(typeof t.bgColor!=="string") t.bgColor = "";
  if(typeof t.borderColor!=="string") t.borderColor = "rgba(255,255,255,0.30)";
  if(!Number.isFinite(t.blur)) t.blur = 18;
  if(typeof t.customCss!=="string") t.customCss = "";
  // Conditional card background rules (per-row)
  if(typeof t.cardBgRulesEnabled!=="boolean") t.cardBgRulesEnabled = false;
  if(!Array.isArray(t.cardBgRules)) t.cardBgRules = [];
  return t;
}
function applySimplifiedTheme(entity){
  const th = ensureSimplifiedTheme(entity);
  // background for the cards area
  if(cards){
    cards.classList.toggle("sv-bg", !!th.bgColor);
    cards.style.setProperty("--sv-bg", th.bgColor || "transparent");
    cards.style.setProperty("--sv-radius", (th.radius||16)+"px");
    cards.style.setProperty("--sv-border", th.borderColor || "rgba(255,255,255,0.30)");
    cards.style.setProperty("--sv-blur", (th.blur||18)+"px");
    // card bg with opacity
    const bg = hexToRgba(th.cardColor || "#ff3b30", (typeof th.cardOpacity==="number") ? th.cardOpacity : 0.92);
    cards.style.setProperty("--sv-card-bg", bg);
    const g1 = hexToRgba(th.gradFrom || th.cardColor || "#ff3b30", (typeof th.cardOpacity==="number") ? th.cardOpacity : 0.92);
    const g2 = hexToRgba(th.gradTo || "#ff9500", (typeof th.cardOpacity==="number") ? th.cardOpacity : 0.92);
    cards.style.setProperty("--sv-grad-from", g1);
    cards.style.setProperty("--sv-grad-to", g2);
  }
  // inject custom css
  const id="svCustomStyle";
  let st=document.getElementById(id);
  if(th.customCss && th.customCss.trim()){
    if(!st){ st=document.createElement("style"); st.id=id; document.head.appendChild(st); }
    st.textContent = th.customCss;
  } else if(st){ st.remove(); }
  return th;
}

function computeBlockValue(sheet, row, block){
  const srcs = Array.isArray(block?.sources) ? block.sources : [];
  const vals = srcs.map(i=>{
    const idx = Number(i);
    const col = sheet.columns?.[idx];
    const name = col?.name;
    const v = name ? (row?.data?.[name] ?? "") : "";
    return (v===null || v===undefined) ? "" : String(v);
  });
  const op = block?.op || "concat";
  const delim = (typeof block?.delimiter==="string") ? block.delimiter : " ";
  if(op==="newline") return vals.join("\n");
  if(op==="seq") return vals.join("");
  return vals.join(delim);
}

function computeCellValue(sheet, row, cellCfg){
  const blocks = Array.isArray(cellCfg?.blocks) ? cellCfg.blocks : (Array.isArray(cellCfg) ? cellCfg : []);
  if(!blocks.length) return "";
  const joinAll = cellCfg?.joinAll || {op:"newline", delimiter:""};
  const joins = Array.isArray(cellCfg?.joins) ? cellCfg.joins : [];
  let out = computeBlockValue(sheet,row,blocks[0]);
  for(let i=1;i<blocks.length;i++){
    const j = joins[i-1] || joinAll || {op:"newline", delimiter:""};
    const op = j.op || "newline";
    const delim = (typeof j.delimiter==="string") ? j.delimiter : ((joinAll?.delimiter)||" ");
    if(op==="seq") out += "";
    else if(op==="concat") out += delim;
    else out += "\n";
    out += computeBlockValue(sheet,row,blocks[i]);
  }
  return out;
}


function parseDateDMY(s){
  // expects DD.MM.YY or DD.MM.YYYY
  if(typeof s!=="string") return null;
  const m = s.trim().match(/^([0-3]?\d)\.([01]?\d)\.(\d{2}|\d{4})$/);
  if(!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), yRaw = Number(m[3]);
  const y = (m[3].length===2) ? (2000 + yRaw) : yRaw;
  if(!(d>=1&&d<=31&&mo>=1&&mo<=12&&y>=1900&&y<=2100)) return null;
  // basic date validity
  const dt = new Date(y, mo-1, d);
  if(dt.getFullYear()!==y || (dt.getMonth()+1)!==mo || dt.getDate()!==d) return null;
  return dt;
}
function isNumericStr(s){
  if(typeof s!=="string") return false;
  const t = s.trim();
  if(!t) return false;
  return /^-?\d+(\.\d+)?$/.test(t);
}
function getRowValueByColIndex(sheet, row, colIndex){
  const idx = Number(colIndex);
  const col = sheet.columns?.[idx];
  const name = col?.name;
  const v = name ? (row?.data?.[name] ?? "") : "";
  return (v===null || v===undefined) ? "" : String(v);
}
function resolveCardBgHex(sheet, row, th){
  // default
  let base = th.cardColor || "#ff3b30";
  if(!th.cardBgRulesEnabled) return base;
  const rules = Array.isArray(th.cardBgRules) ? th.cardBgRules : [];
  for(const r of rules){
    if(!r || typeof r!=="object") continue;
    const v = getRowValueByColIndex(sheet, row, r.col);
    const vv = (v ?? "").toString();
    const test = r.test || "notempty";
    let ok=false;
    if(test==="empty") ok = vv.trim()==="";
    else if(test==="notempty") ok = vv.trim()!=="";
    else if(test==="isnumber") ok = isNumericStr(vv);
    else if(test==="isdate") ok = !!parseDateDMY(vv);
    else if(test==="equals") ok = vv.trim() === String(r.value ?? "").trim();
    else if(test==="contains") ok = vv.toLowerCase().includes(String(r.value ?? "").toLowerCase());
    if(ok){
      const col = (typeof r.color==="string" && r.color.trim()) ? r.color.trim() : base;
      return col;
    }
  }
  return base;
}

function renderSimplifiedCardsForSheet(sheet, rows){
  const t = getActiveSimplifiedTemplate(sheet);
  if(!t?.layout?.rows || !t?.layout?.cols) return false;
  applySimplifiedTheme(sheet);
  // Toggle displays
  if(cards) cards.style.display="";
  if(table) table.style.display="none";
  cards.innerHTML="";
  const th = ensureSimplifiedTheme(sheet);
  const showBorders = !!th.showBorders;
  for(const row of rows){
    const card = el("div",{className:"sv-card"});
    const bgHex = resolveCardBgHex(sheet, row, th);
    const op = (typeof th.cardOpacity==="number") ? th.cardOpacity : 0.92;
    const bgRgba = hexToRgba(bgHex, op);
    card.style.setProperty("--sv-card-bg", bgRgba);
    if(th.gradient){
      // If a rule matched (different from default), make gradient a solid color.
      const g1 = hexToRgba(bgHex, op);
      const g2 = g1;
      card.style.setProperty("--sv-grad-from", g1);
      card.style.setProperty("--sv-grad-to", g2);
    }
    if(th.glass) card.classList.add("sv-glass");
    if(th.gradient) card.classList.add("sv-gradient");
    if(showBorders) card.classList.add("sv-show-borders");
    const grid = el("div",{className:"sv-card-grid"});
    grid.style.gridTemplateColumns = `repeat(${t.layout.cols}, minmax(0, 1fr))`;
    // build cells row-major
    for(let r=0;r<t.layout.rows;r++){
      for(let c=0;c<t.layout.cols;c++){
        const key = `${r}-${c}`;
        const cfg = t.layout.cells?.[key] || {blocks:[]};
        const val = computeCellValue(sheet,row,cfg);
        const cell = el("div",{className:"sv-card-cell",textContent: val});
        // For border rendering in grid: add data attributes
        cell.dataset.r=String(r); cell.dataset.c=String(c);
        grid.appendChild(cell);
      }
    }
    card.appendChild(grid);
    cards.appendChild(card);
  }
  // Apply background on main wrap (optional)
  return true;
}

function applyDefaultSortForSheet(sheet){
  // Reset sort to sheet defaults. User can override by clicking headers.
  state.sort = { col:null, dir:1 };
  if(!sheet) return;

  const ds = sheet.defaultSort;
  if(ds && ds.col){
    const exists = (sheet.columns || []).some(c => c.name === ds.col);
    if(exists){
      state.sort.col = ds.col;
      state.sort.dir = (ds.dir === 'desc') ? -1 : 1;
      return;
    }
  }
  // Fallback to legacy orderColumn behavior handled in render() when state.sort.col is null.
}


function visibleColumns(sheet){
  const cfg = state.sheetSettings[sheet.key] || {};
  const hidden = new Set(cfg.hiddenCols || []);
  return sheet.columns.map(c=>c.name).filter(n=>!hidden.has(n));
}
function setSideHint(text){ sideHint.textContent = text || ""; }

$("#btnSettings").onclick=(e)=>{
  e.stopPropagation();
  openSettings();
};

$("#btnImportExport").onclick=(e)=>{
  e.stopPropagation();
  openImportExportWindow();
};

// Quick navigation window (tree)
if(btnQuickNav){
  btnQuickNav.onclick = async (e)=>{
    e.stopPropagation();
    const qnav = await createQuickNavPanel({
      mode:"navigate",
      showSpaces:true,
      showJournals:true,
      allowAdd:true,
      allowDelete:true,
      showSearch:true,
      defaultCollapsed: true,
      persistDefaultCollapsed:true,
      getData: async ()=>({
        spaces: state.spaces,
        activeSpaceId: state.spaceId,
        jtree: state.jtree,
        activeJournalId: (Array.isArray(state.journalPath)&&state.journalPath.length)?state.journalPath[state.journalPath.length-1]:null,
      }),
      onGoSpace: async (spaceId)=>{
        if(!spaceId || spaceId===state.spaceId) return;
        await setSpacePath([spaceId]);
      },
      onAddSpace: async (parentId)=>{
        const p = parentId ? spaceById(state.spaces, parentId) : null;
        const promptText = parentId ? `Назва підпростору у: ${p? p.name : 'Простір'}` : 'Назва нового простору:';
        const def = parentId ? 'Новий підпростір' : 'Новий простір';
        const name = (prompt(promptText, def)||'').trim();
        if(!name) return;
        if(parentId){
          await addSubspace(parentId, name);
        } else {
          await addSpace(name);
        }
        state.spaces = await ensureSpaces();
      },
      onDeleteSpace: async (spaceId)=>{
        const s = spaceById(state.spaces, spaceId);
        if(!s) return;
        if(!confirm(`Видалити простір: ${s.name}?`)) return;
        // delete space and all descendant subspaces
        const all = (state.spaces||[]).slice();
        const toDel = new Set();
        const stack = [spaceId];
        while(stack.length){
          const id = stack.pop();
          if(toDel.has(id)) continue;
          toDel.add(id);
          for(const ch of spaceChildren(all, id)) stack.push(ch.id);
        }
        const kept = all.filter(x=>!toDel.has(x.id));
        await cfgSet('spaces_v1', kept);
        state.spaces = await ensureSpaces();
        // If current space was deleted, move to first root
        if(toDel.has(state.spaceId)){
          const roots = spaceChildren(state.spaces, null);
          const first = roots[0] || state.spaces[0];
          await setSpacePath(first ? [first.id] : []);
        } else {
          fillSpaceSelect(state.spaces);
        }
      },
      onGoJournalPath: async (path)=>{
        if(Array.isArray(path) && path.length){
          state.journalPath = ensureValidJournalPath(state.jtree, path);
          await saveView();
          renderJournalNav();
          render();
        }
      }
      ,
      onAddJournalChild: async (journalId)=>{
        if(!journalId) return;
        const path = breadcrumbs(state.jtree, journalId);
        if(!Array.isArray(path) || !path.length) return;
        await openAddChildModal(path, path.length-1);
        await saveJournalTree(state.spaceId, state.jtree);
        renderJournalNav();
        render();
      },
      onDeleteJournal: async (journalId)=>{
        if(!journalId) return;
        const n = nodeById(state.jtree, journalId);
        if(!n) return;
        if(!confirm(`Видалити журнал: ${nodeTitle(n)}?`)) return;
        // remove subtree and clear associated rows
        const ids=[];
        const stack=[journalId];
        while(stack.length){
          const id=stack.pop();
          if(!id || !state.jtree.nodes[id]) continue;
          ids.push(id);
          const kids = state.jtree.nodes[id].children||[];
          for(const k of kids) stack.push(k);
        }
        for(const id of ids){
          try{ await clearRows(`${state.spaceId}::${id}`); }catch(_e){}
        }
        // detach from parent
        const parentId = n.parentId;
        if(parentId && state.jtree.nodes[parentId]){
          state.jtree.nodes[parentId].children = (state.jtree.nodes[parentId].children||[]).filter(cid=>cid!==journalId);
        }
        // delete nodes
        for(const id of ids){ delete state.jtree.nodes[id]; }
        await saveJournalTree(state.spaceId, state.jtree);
        state.journalPath = ensureValidJournalPath(state.jtree, state.journalPath);
        await saveView();
        renderJournalNav();
        render();
      }
    });
    await modalOpen({
      title:"Швидкий перегляд",
      bodyNodes:[qnav.root],
      actions:[btn("Закрити","cancel","btn")]
    });
  };
}
document.addEventListener("click",(e)=>{
  if(menu.style.display==="block" && !menu.contains(e.target) && e.target!==$("#btnSettings")) hideMenu(menu);
});
menu.addEventListener("click", async (e)=>{
  const b = e.target.closest("button");
  if(!b) return;
  const act = b.dataset.action;
  hideMenu(menu);
  if(act==="settingsPanel") return openSettings();
  if(act==="exportCurrent") return exportCurrentFlow();
  if(act==="exportAllZip") return exportAllFlow();
  if(act==="importJson") return $("#fileImportJson").click();
  if(act==="importZip") return $("#fileImportZip").click();
  if(act==="importXlsx") return $("#fileImportXlsx").click();
  if(act==="print") return window.print();
  if(act==="clearCurrent") return clearCurrent();
  if(act==="clearAll") return clearAll();
});

$("#btnSimpleView").onclick=()=>toggleSimplifiedView();
$("#searchInput").addEventListener("input",(e)=>{ state.search=e.target.value||""; render(); });
$("#btnAdd").onclick=()=>addFlow();


// Jump scroll buttons (top/bottom)
const scrollJump = document.getElementById("scrollJump");
const btnScrollTop = document.getElementById("btnScrollTop");
const btnScrollBottom = document.getElementById("btnScrollBottom");
function getScrollEl(){ return document.scrollingElement || document.documentElement; }
function updateScrollJump(){
  if(!scrollJump) return;
  const se = getScrollEl();
  const y = window.scrollY || (se ? se.scrollTop : 0) || 0;
  // show after a small scroll so it doesn't clutter the UI
  if(y > 180) scrollJump.classList.remove("hidden");
  else scrollJump.classList.add("hidden");
}
if(btnScrollTop){
  btnScrollTop.addEventListener("click", ()=>window.scrollTo({top:0, behavior:"smooth"}));
}
if(btnScrollBottom){
  btnScrollBottom.addEventListener("click", ()=>{
    const se = getScrollEl();
    const max = Math.max(se.scrollHeight - se.clientHeight, 0);
    window.scrollTo({top:max, behavior:"smooth"});
  });
}
window.addEventListener("scroll", updateScrollJump, {passive:true});
window.addEventListener("resize", updateScrollJump);
setTimeout(updateScrollJump, 0);

// Selection mode (multi-row transfer)
$("#btnSelect").onclick=async ()=>{
  if(state.mode!=="sheet" && state.mode!=="case") return alert("Режим вибору працює тільки в листі або в описі справи.");
  if(!state.selectionMode){
    state.selectionMode=true;
    state.selectedRowIds=new Set();
    $("#btnTransferSelected").style.display="inline-block";
    $("#btnSelect").textContent="☑ Вибір*";
    render();
    return;
  }
  const op = await modalOpen({
    title:"Режим вибору",
    bodyNodes:[el("div",{className:"muted",textContent:`Вибрано: ${state.selectedRowIds.size}`})],
    actions:[
      btn("Скасувати","cancel","btn"),
      btn("Вибрати всі","all","btn btn-primary"),
      btn("Зняти всі","none","btn"),
      btn("Вийти","exit","btn")
    ]
  });
  if(op.type==="all"){
    if(state.mode==="sheet"){
      const rows=await getRows(curDataKey());
      state.selectedRowIds=new Set(rows.map(r=>r.id));
    }else{
      const rows=await getCaseRows(state.caseId);
      state.selectedRowIds=new Set(rows.map(r=>r.id));
    }
    render();
  }else if(op.type==="none"){
    state.selectedRowIds=new Set();
    render();
  }else if(op.type==="exit"){
    state.selectionMode=false;
    state.selectedRowIds=new Set();
    $("#btnTransferSelected").style.display="none";
    $("#btnSelect").textContent="☑ Вибір";
    render();
  }
};

$("#btnTransferSelected").onclick=async ()=>{
  if(!state.selectionMode || !state.selectedRowIds.size) return alert("Немає вибраних строк.");
  if(state.mode==="sheet"){
    const sheet=currentSheet();
    const all=await getRows(curDataKey());
    const selected = all.filter(r=>state.selectedRowIds.has(r.id));
    if(!selected.length) return alert("Немає вибраних строк.");
    await transferMultipleFlow(sheet, selected);
  }else{
    const all=await getCaseRows(state.caseId);
    const selected = all.filter(r=>state.selectedRowIds.has(r.id));
    if(!selected.length) return alert("Немає вибраних строк.");
    await transferMultipleCaseFlow(state.caseId, selected);
  }
};
$("#fileImportJson").addEventListener("change",(e)=>importJsonFile(e.target));
$("#fileImportZip").addEventListener("change",(e)=>importZipFile(e.target));
$("#fileImportXlsx").addEventListener("change",(e)=>importXlsxFile(e.target));
$("#fileImportXlsx").addEventListener("change",(e)=>importXlsxFile(e.target));

// Space is fixed for now (no editor), so no change handler.

async function openAddChildModal(parentPath, parentDepth){
  // Adds a child journal instance under the node at parentDepth.
  // parentPath includes IDs up to that parent (inclusive).
  var parentId = parentPath[parentDepth];
  var parentNode = nodeById(state.jtree, parentId);
  if(!parentNode) return;

  // --- Combined picker (single field + ▾) ---
  // IMPORTANT UX: user must explicitly pick one of proposed journals.
  // Do not auto-pick the first item when user typed arbitrary text.
  var selectedSheetKey = null;
  var allSheets = (state.sheets||[]).slice();

  var showAllBtn = el('button', {className:'btn', textContent:'▾', title:'Показати повний список журналів', style:'width:42px; padding:0;'});
  var comboInput = el('input', {className:'input', placeholder:'Пошук / вибір журналу…', value:''});
  var list = el('div', {className:'combo-list', style:'display:none;'});
  var currentItems = [];

  function renderList(filterText){
    var q = String(filterText||'').trim().toLowerCase();
    currentItems = allSheets.filter(function(s){
      if(!q) return true;
      return String(s.title||'').toLowerCase().includes(q) || String(s.key||'').toLowerCase().includes(q);
    });
    list.innerHTML='';
    if(currentItems.length===0){
      list.appendChild(el('div', {className:'combo-item muted', textContent:'Нічого не знайдено'}));
      return;
    }
    for(var i=0;i<currentItems.length;i++){
      (function(s){
        var item = el('div', {className:'combo-item', textContent:s.title, title:s.key});
        item.onclick = function(){
          selectedSheetKey = s.key;
          comboInput.value = s.title;
          closeList();
        };
        list.appendChild(item);
      })(currentItems[i]);
    }
  }
  function openList(filterText){ renderList(filterText); list.style.display='block'; }
  function closeList(){ list.style.display='none'; }

  comboInput.oninput = function(){ openList(comboInput.value); };
  comboInput.onfocus = function(){ openList(comboInput.value); };
  comboInput.onkeydown = function(e){
    if(e.key==='Enter'){
      e.preventDefault();
      closeList();
    } else if(e.key==='Escape'){
      closeList();
    }
  };
  showAllBtn.onclick = function(){ comboInput.value=''; openList(''); try{ comboInput.focus(); }catch(_e){} };

  function outsideClose(ev){
    if(!list.contains(ev.target) && ev.target!==comboInput && ev.target!==showAllBtn){
      closeList();
      document.removeEventListener('mousedown', outsideClose, true);
    }
  }
  comboInput.addEventListener('focus', function(){
    document.addEventListener('mousedown', outsideClose, true);
  });

  var comboWrap = el('div', {className:'combo-wrap'},
    el('div', {style:'display:flex; gap:8px;'}, showAllBtn, comboInput),
    list
  );

  var idxInput = el('input', {className:'input', value:'', placeholder:'Індекс/позначення (необов’язково)'});

  // Validate: user must choose from the предложених журналів.
  while(true){
    var res = await modalOpen({
      title: 'Додати піджурнал у: ' + nodeTitle(parentNode),
      bodyNodes:[
        el('div', {className:'muted', textContent:'Оберіть, який саме журнал буде піджурналом. Дані піджурналу ізольовані.'}),
        el('div', {style:'height:10px'}),
        comboWrap,
        el('div', {style:'height:10px'}),
        el('div', {className:'muted', textContent:'Індекс (додаткове позначення для розрізнення)'}),
        idxInput
      ],
      actions:[
        btn('Скасувати','cancel','btn'),
        btn('Створити','ok','btn btn-primary')
      ]
    });
    if(!res || res.type!=='ok') return;

    // Resolve exact match if typed (title OR key). Otherwise require explicit click.
    var typed = String(comboInput.value||'').trim();
    var resolvedKey = selectedSheetKey;
    if(typed){
      var low = typed.toLowerCase();
      var m = (state.sheets||[]).find(function(s){
        return String(s.title||'').toLowerCase()===low || String(s.key||'').toLowerCase()===low;
      });
      if(m) resolvedKey = m.key;
    }
    if(!resolvedKey){
      alert('Оберіть журнал зі списку (або введіть точну назву/ключ)');
      continue;
    }
    selectedSheetKey = resolvedKey;
    break;
  }

  var childSheet = (state.sheets||[]).find(function(s){ return s.key===selectedSheetKey; });
  if(!childSheet){ alert('Не знайдено обраний журнал.'); return; }
  var baseTitle = (childSheet && (childSheet.title || childSheet.name || childSheet.key)) || 'Піджурнал';
  var idx = String(idxInput.value||'').trim();
  var name = idx ? (baseTitle + ' ' + idx) : baseTitle;

  // Create via StructureCore (auto-enter)
  await StructureCore.createSubjournal(state.spaceId, parentId, childSheet.key, name);

  // Reload from core
  state.jtree = await StructureCore.getJournalTree(state.spaceId);
  state.journalPath = await StructureCore.getJournalPath(state.spaceId);

  await saveView();
  renderJournalNav();
  render();
}

// Add a ROOT journal in the current space.
// IMPORTANT UX: user must explicitly pick one of proposed journal templates.
// After creation we automatically enter the newly created journal (per your rule).
async function openAddRootJournalModal(){
  var sheets = (state.sheets || []).slice();
  if(!sheets.length){
    alert('Немає шаблонів журналів (листи). Додайте/імпортуйте шаблони у налаштуваннях.');
    return;
  }

  // Pick template (must be from list)
  var pickedKey = await openPickModal({
    title: 'Додати журнал',
    items: sheets.map(function(s){ return { id: s.key, name: '📄 ' + (s.title || s.name || s.key) }; }),
    currentId: null,
    allowNone: false
  });
  if(pickedKey===null) return;

  var tpl = sheets.find(function(s){ return s.key===pickedKey; });
  if(!tpl){ alert('Не знайдено обраний шаблон журналу.'); return; }

  // Index (optional)
  var idxInput = el('input', {className:'input', value:'', placeholder:'Індекс/позначення (необов’язково)'});
  var res = await modalOpen({
    title: 'Індекс журналу',
    bodyNodes:[
      el('div', {className:'muted', textContent:'За основу береться назва шаблону. Індекс — додаткове позначення для розрізнення.'}),
      idxInput
    ],
    actions:[
      btn('Скасувати','cancel','btn'),
      btn('Створити','ok','btn btn-primary')
    ]
  });
  if(!res || res.type!=='ok') return;

  var baseTitle = (tpl.title || tpl.name || tpl.key) || 'Журнал';
  var idx = String(idxInput.value||'').trim();
  var name = idx ? (baseTitle + ' ' + idx) : baseTitle;

  // Create via StructureCore (auto-enter)
  await StructureCore.createRootJournal(state.spaceId, tpl.key, name);

  // Reload from core
  state.jtree = await StructureCore.getJournalTree(state.spaceId);
  state.journalPath = await StructureCore.getJournalPath(state.spaceId);

  await saveView();
  renderJournalNav();
  render();
}

caseSelect.addEventListener("change", async ()=>{
  const v=caseSelect.value;
  if(!v){ state.mode="sheet"; state.caseId=null; btnCaseBack.style.display="none"; await saveView(); render(); return; }
  state.mode="case"; state.caseId=parseInt(v,10); btnCaseBack.style.display="inline-block"; await saveView(); render();
});
btnCaseBack.onclick=async ()=>{ state.mode="sheet"; state.caseId=null; caseSelect.value=""; btnCaseBack.style.display="none"; await saveView(); render(); };

$("#settingsClose").onclick=()=>closeSettings();
$("#settingsCancel").onclick=()=>closeSettings();
$("#settingsSave").onclick=()=>saveSettings();
document.querySelectorAll(".tab").forEach(t=>{
  t.onclick=()=>{
    document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
    t.classList.add("active");
    state.settingsTab=t.dataset.tab;
    renderSettings();
  };
});
function markDirty(){ state.settingsDirty=true; $("#settingsSave").textContent="Зберегти*"; }
function clearDirty(){ state.settingsDirty=false; $("#settingsSave").textContent="Зберегти"; }
async function openImportExportWindow(){
  const backdrop = $("#modalBackdrop");
  const t = $("#modalTitle");
  const b = $("#modalBody");
  const a = $("#modalActions");

  const close = ()=>{
    backdrop.style.display = "none";
    backdrop.onclick = null;
  };

  t.textContent = "Імпорт / Експорт";
  b.innerHTML = "";
  a.innerHTML = "";

  // Tabs
  const tabs = el("div", {className:"tabs"});
  const tabImport = el("button", {className:"tab active", textContent:"Імпорт"});
  const tabExport = el("button", {className:"tab", textContent:"Експорт"});
  const tabService = el("button", {className:"tab", textContent:"Сервіс"});
  tabs.append(tabImport, tabExport, tabService);

  const content = el("div", {className:"settings-content", style:"padding:0"});

  const setActive = (which)=>{
    [tabImport,tabExport,tabService].forEach(x=>x.classList.remove("active"));
    which.classList.add("active");
  };

  const sectionTitle = (text)=>el("div", {className:"muted", textContent:text, style:"margin:6px 0 10px"});

  const renderImport = ()=>{
    content.innerHTML = "";
    content.appendChild(sectionTitle("Імпорт у систему"));
    const row = el("div", {style:"display:flex; gap:10px; flex-wrap:wrap"});
    const bJson = btn("📥 Імпорт JSON", "imp_json", "btn btn-primary");
    const bZip = btn("📥 Імпорт ZIP", "imp_zip", "btn btn-primary");
    const bXlsx = btn("📥 Імпорт XLSX (у поточний)", "imp_xlsx", "btn");
    row.append(bJson,bZip,bXlsx);
    content.appendChild(row);

    // helper hint
    content.appendChild(el("div", {className:"muted", textContent:"Порада: ZIP — це повний імпорт, JSON — імпорт одного журналу/опису справи.", style:"margin-top:10px"}));

    bJson.onclick = ()=>{ close(); $("#fileImportJson").click(); };
    bZip.onclick  = ()=>{ close(); $("#fileImportZip").click(); };
    bXlsx.onclick = ()=>{ close(); $("#fileImportXlsx").click(); };
  };

  const renderExport = ()=>{
    content.innerHTML = "";
    content.appendChild(sectionTitle("Експорт/друк"));
    const row = el("div", {style:"display:flex; gap:10px; flex-wrap:wrap"});
    const bCur = btn("📤 Експорт поточного", "exp_cur", "btn btn-primary");
    const bAll = btn("📦 Повний експорт ВСЬОГО (ZIP→JSON)", "exp_all", "btn");
    const bPrint = btn("🖨 Друк / PDF (через друк)", "print", "btn");
    row.append(bCur,bAll,bPrint);
    content.appendChild(row);

    bCur.onclick = async ()=>{ close(); await exportCurrentFlow(); };
    bAll.onclick = async ()=>{ close(); await exportAllFlow(); };
    bPrint.onclick = ()=>{ close(); window.print(); };
  };

  const renderService = ()=>{
    content.innerHTML = "";
    content.appendChild(sectionTitle("Обережно: дії видалення"));
    const row = el("div", {style:"display:flex; gap:10px; flex-wrap:wrap"});
    const bCC = btn("🧹 Очистити поточний", "clr_cur", "btn");
    const bCA = btn("🧨 Очистити ВСЕ", "clr_all", "btn");
    bCC.classList.add("danger");
    bCA.classList.add("danger");
    row.append(bCC,bCA);
    content.appendChild(row);

    bCC.onclick = async ()=>{ close(); await clearCurrent(); };
    bCA.onclick = async ()=>{ close(); await clearAll(); };
  };

  tabImport.onclick = ()=>{ setActive(tabImport); renderImport(); };
  tabExport.onclick = ()=>{ setActive(tabExport); renderExport(); };
  tabService.onclick = ()=>{ setActive(tabService); renderService(); };

  b.appendChild(tabs);
  b.appendChild(content);
  renderImport();

  const closeBtn = btn("Закрити", "close", "btn");
  closeBtn.onclick = ()=>close();
  a.appendChild(closeBtn);

  backdrop.style.display = "flex";
  backdrop.onclick = (e)=>{ if(e.target===backdrop) close(); };
}

function openSettings(){ $("#settingsBackdrop").style.display="flex"; clearDirty(); renderSettings(); }
function closeSettings(){ $("#settingsBackdrop").style.display="none"; }
async function saveSettings(){
  const userSheets = state.sheets.filter(s=>isCustomKey(s.key));
  await saveUserSheets(userSheets);
  // Persist full schema (including renamed/changed default sheets)
  await saveAllSheets(state.sheets);
  await saveSheetSettings(state.sheetSettings);
  await saveAddFieldConfig(state.addFieldsCfg);
  await saveUISettings(state.uiSettings);
  clearDirty();
  await loadConfig();
  applyUISettings();
  applyDefaultSortForSheet(currentSheet());
  const spaces = await ensureSpaces();
  state.spaces = spaces;
  fillSpaceSelect(spaces);
  state.jtree = await ensureJournalTree(state.spaceId, state.sheets);
  state.journalPath = ensureValidJournalPath(state.jtree, state.journalPath);
  renderJournalNav();
  render();
}
function renderSettings(){
  const root = buildSettingsUI({tab:state.settingsTab,sheets:state.sheets,settings:state.sheetSettings,addFieldsCfg:state.addFieldsCfg,uiSettings:state.uiSettings,onDirty:markDirty});
  const box=$("#settingsContent"); box.innerHTML=""; box.appendChild(root);
}

function applyUISettings(){
  document.body.classList.toggle("circle-nav-enabled", !!state.uiSettings?.circleNav);
  // Table typography
  try{
    var hfs = parseInt(state.uiSettings && state.uiSettings.headerFontPx, 10);
    var cfs = parseInt(state.uiSettings && state.uiSettings.cellFontPx, 10);
    if(!hfs || hfs < 8) hfs = 14;
    if(!cfs || cfs < 8) cfs = 14;
    document.documentElement.style.setProperty("--sheet-th-fs", hfs + "px");
    document.documentElement.style.setProperty("--sheet-td-fs", cfs + "px");
  }catch(_e){}

  // Column header orientation
  document.body.classList.toggle("th-vertical", (state.uiSettings && state.uiSettings.headerTextDir) === "v");
  // gesture handlers are attached/detached based on this setting
  setupGestures(!!state.uiSettings?.gestures);
}

let __gestureBound = false;
let __gestureEnabled = false;
function setupGestures(enabled){
  __gestureEnabled = !!enabled;
  if(__gestureBound) return;
  const area = document.querySelector(".table-wrap") || document.body;
  let down = null;
  const shouldIgnoreTarget = (t)=>{
    if(!t) return false;
    return !!t.closest("input,textarea,select,button,.modal,.menu");
  };
  area.addEventListener("pointerdown", (e)=>{
    if(!__gestureEnabled) return;
    if(shouldIgnoreTarget(e.target)) return;
    down = { x:e.clientX, y:e.clientY, t:performance.now() };
  }, {passive:true});
  area.addEventListener("pointerup", async (e)=>{
    if(!__gestureEnabled) return;
    if(!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    down = null;
    // horizontal swipe only
    if(Math.abs(dx) < 70) return;
    if(Math.abs(dx) < Math.abs(dy) * 1.4) return;

    // right swipe: go to parent; left swipe: go to first child (if exists)
    if(dx > 0){
      state.journalPath = goParent(state.journalPath);
    } else {
      state.journalPath = goFirstChild(state.jtree, state.journalPath);
    }
    state.journalPath = ensureValidJournalPath(state.jtree, state.journalPath);
    await saveView();
    renderJournalNav();
    render();
  }, {passive:true});
  __gestureBound = true;
}



function setSpacePath(path){
  // Delegated to StructureCore (single source of truth). Returns a Promise.
  var p = Array.isArray(path) ? path.slice() : [];
  return StructureCore.setSpacePath(p)
    .then(function(saved){
      state.spacePath = saved || [];
      state.spaceId = state.spacePath.length ? state.spacePath[state.spacePath.length-1] : null;
      return StructureCore.getJournalTree(state.spaceId);
    })
    .then(function(jtree){
      state.jtree = jtree;
      return StructureCore.getJournalPath(state.spaceId);
    })
    .then(function(jpath){
      state.journalPath = jpath || [];
      return saveView();
    })
    .then(function(){
      // spaces UI is built from StructureCore; keep legacy cache in sync where possible
      try{ fillSpaceSelect(state.spaces); }catch(_e){}
      renderJournalNav();
      render();
    });
}



function fillSpaceSelect(_spaces){
  // Minimal, stable spaces navigation UI. Built purely from StructureCore.
  if(!spaceSelect) return;

  // Circle mode temporarily disabled in Variant 1 (stability). Keep UI consistent.
  if(circleSpacesWrap) circleSpacesWrap.style.display = 'none';
  if(spaceSelect) spaceSelect.style.display = '';
  if(subspaceChain) subspaceChain.style.display = '';
  if(btnAddSubspace) btnAddSubspace.style.display = '';

  function promptName(title, defv){
    var v = (prompt(title, defv || '') || '').trim();
    return v ? v : null;
  }

  // Build siblings selector for the current level
  StructureCore.getSpaceLevelModel().then(function(model){
    var curId = model && model.currentId ? model.currentId : null;

    // Root select = siblings of current node
    spaceSelect.innerHTML = '';
    (model.siblings||[]).forEach(function(it){
      spaceSelect.appendChild(el('option', { value: it.id, textContent: '📁 ' + it.title }));
    });
    spaceSelect.appendChild(el('option', { value: '__add_root__', textContent: '＋ Додати простір' }));

    if(curId) spaceSelect.value = curId;

    // Only current space is active (green). This control represents current space.
    try{ spaceSelect.classList.add('nav-active'); }catch(_e){}

    spaceSelect.onchange = function(){
      var v = spaceSelect.value;
      if(v === '__add_root__'){
        // revert
        if(curId) spaceSelect.value = curId;
        var nm = promptName('Назва простору', 'Новий простір');
        if(!nm) return;
        StructureCore.createRootSpace(nm).then(function(){
          return StructureCore.getSpacePath();
        }).then(function(p){
          return setSpacePath(p);
        });
        return;
      }
      // enter selected sibling
      StructureCore.enterSpace(v).then(function(p){
        return setSpacePath(p);
      });
    };

    // Subspace chain: show ONLY one next-level selector if children exist.
    if(subspaceChain) subspaceChain.innerHTML = '';
    if(model.hasChildren && subspaceChain){
      var kids = model.children || [];
      var sel = el('select', { className: 'select', style: 'max-width:240px', ariaLabel: 'Підпростір' });
      sel.appendChild(el('option', { value: '', textContent: String(kids.length) }));
      for(var i=0;i<kids.length;i++){
        sel.appendChild(el('option', { value: kids[i].id, textContent: '📁 ' + kids[i].title }));
      }
      sel.appendChild(el('option', { value: '__add__', textContent: '＋ Додати підпростір' }));
      sel.value = '';
      // Next-level selector must NEVER be active
      try{ sel.classList.remove('nav-active'); }catch(_e){}

      sel.onchange = function(){
        if(sel.value === '__add__'){
          sel.value = '';
          var nm2 = promptName('Назва підпростору', 'Новий підпростір');
          if(!nm2) return;
          StructureCore.currentSpaceId().then(function(parentId){
            return StructureCore.createSubspace(parentId, nm2);
          }).then(function(){
            return StructureCore.getSpacePath();
          }).then(function(p){
            return setSpacePath(p);
          });
          return;
        }
        var v2 = sel.value;
        if(!v2) return;
        StructureCore.enterSpace(v2).then(function(p){
          return setSpacePath(p);
        });
      };

      subspaceChain.appendChild(sel);
    }

    // Separate '+' button right of last dropdown: create CHILD under current space
    if(btnAddSubspace){
      btnAddSubspace.onclick = function(){
        var nm3 = promptName('Назва підпростору', 'Новий підпростір');
        if(!nm3) return;
        StructureCore.currentSpaceId().then(function(parentId){
          return StructureCore.createSubspace(parentId, nm3);
        }).then(function(){
          return StructureCore.getSpacePath();
        }).then(function(p){
          return setSpacePath(p);
        });
      };
    }

  }).catch(function(e){
    console.error(e);
  });
}



function renderJournalNav(){
  if(!sheetSelect) return;

  // Build navigation model (gesture-friendly) and normalize path in one place.
  const model = buildNavModel(state.jtree, state.journalPath);
  state.journalPath = model.path;

  // Optional circle navigation (UX|UI setting)
  if(state.uiSettings && state.uiSettings.circleNav){
    if(circleJournalsWrap) circleJournalsWrap.style.display = "";
    if(sheetSelect) sheetSelect.style.display = "none";
    if(subjournalChain) subjournalChain.style.display = "none";
    renderCircleNav(model);
    return;
  } else {
    if(circleJournalsWrap) circleJournalsWrap.style.display = "none";
    if(sheetSelect) sheetSelect.style.display = "";
    if(subjournalChain) subjournalChain.style.display = "";
  }

  // Top-level journal select
  sheetSelect.innerHTML="";
  for(const n of model.topNodes){
    sheetSelect.appendChild(el("option",{value:n.id, textContent:`📄 ${nodeTitle(n)}`}));
  }
  // Add option (must be the LAST item)
  sheetSelect.appendChild(el("option",{value:"__add__", textContent:"＋ Додати журнал"}));
  sheetSelect.value = state.journalPath[0] || model.topNodes[0]?.id;
  sheetSelect.classList.toggle("nav-active", isActiveNode(state.journalPath, sheetSelect.value) && state.journalPath.length===1);
  sheetSelect.onchange = async ()=>{
    if(sheetSelect.value === "__add__"){
      // revert selection and open add-root modal
      const prev = state.journalPath[0] || model.topNodes[0]?.id || "";
      sheetSelect.value = prev;
      await openAddRootJournalModal();
      return;
    }
    state.journalPath = setTop(state.journalPath, sheetSelect.value);
    await saveView();
    renderJournalNav();
    render();
  };

  // Nested selects + plus buttons
  subjournalChain.innerHTML="";
  for(var li=0; li<model.levels.length; li++){
    var lvl = model.levels[li];
    var sel = el("select",{className:"select", style:"max-width:220px", ariaLabel:"Піджурнал"});
    var kids = (lvl.kids||[]);
    var noneLbl = String(kids.length);
    sel.appendChild(el("option",{value:"", textContent:noneLbl}));
    for(var ki=0; ki<kids.length; ki++){
      var k = kids[ki];
      sel.appendChild(el("option",{value:k.id, textContent:"📄 "+nodeTitle(k)}));
    }
    // Add option (must be the LAST item)
    sel.appendChild(el("option",{value:"__add__", textContent:"＋ Додати піджурнал"}));
    sel.value = lvl.selected || "";
    try{
      sel.classList.toggle("nav-active", !!lvl.selected && (state.journalPath[lvl.depth]===lvl.selected));
    }catch(_e){}
    sel.setAttribute("data-depth", String(lvl.depth));
    sel.onchange = async function(){
      var v = this.value;
      var depth = parseInt(this.getAttribute("data-depth")||"0",10);

      if(v === "__add__"){
        // revert selection
        this.value = (state.journalPath[depth] || "");
        // "+" creates a CHILD under current selected node at this depth, else under parent at depth-1.
        if(state.journalPath[depth]){
          var parentPath = state.journalPath.slice(0, depth+1);
          await openAddChildModal(parentPath, depth);
        } else {
          var pd = Math.max(depth-1, 0);
          var parentPath2 = state.journalPath.slice(0, pd+1);
          await openAddChildModal(parentPath2, pd);
        }
        return;
      }

      state.journalPath = setAtDepth(state.journalPath, depth, v);
      state.journalPath = ensureValidJournalPath(state.jtree, state.journalPath);
      await saveView();
      renderJournalNav();
      render();
    };
    subjournalChain.appendChild(sel);
  }

  // Quick add button AFTER the last dropdown (requested UX): adds a SUBJOURNAL under the CURRENT journal node.
const navPlus = el("button", { className: "btn", textContent: "＋", title: "Додати піджурнал" });
navPlus.style.width = "42px";
navPlus.style.height = "42px";
navPlus.style.padding = "0";
navPlus.style.marginLeft = "6px";
navPlus.onclick = async function(e){
  e.preventDefault();
  e.stopPropagation();
  // Always add under the current node (the last id in journalPath)
  var currentId = (Array.isArray(state.journalPath) && state.journalPath.length) ? state.journalPath[state.journalPath.length-1] : null;
  if(!currentId){
    await openAddRootJournalModal();
    return;
  }
  var idx = state.journalPath.lastIndexOf(currentId);
  var parentPath = (idx>=0) ? state.journalPath.slice(0, idx+1) : [currentId];
  await openAddChildModal(parentPath, parentPath.length-1);
};
subjournalChain.appendChild(navPlus);
}

async function openPickModal({title, items, currentId=null, allowNone=false, noneLabel="↩ У цьому журналі", addLabel=null}){
  // items: [{id,name}]
  let selected = currentId;
  let lastTapId = null;
  let lastTapTime = 0;
  const wrap = el("div",{style:"min-width:340px"});
  const row = el("div",{className:"row",style:"gap:8px; align-items:center"});
  const inp = el("input",{className:"input",type:"text",placeholder:"Пошук..."});
  inp.style.flex = "1";
  row.appendChild(inp);
  wrap.appendChild(row);

  const bCancel = btn("Скасувати","cancel","btn");
  const bOk = btn("Обрати","ok","btn btn-primary");

  const list = el("div",{style:"margin-top:10px; display:flex; flex-direction:column; gap:6px; max-height:45vh; overflow:auto"});
  wrap.appendChild(list);

  const renderList = ()=>{
    const q = (inp.value||"").trim().toLowerCase();
    list.innerHTML="";

    const makeBtn = (id, text)=>{
      const b = el("button",{className:"btn",textContent:text, style:"text-align:left; justify-content:flex-start"});
      if(id === selected) b.classList.add("nav-active");

      const pickOnly = ()=>{ selected = id; renderList(); };
      const pickAndOk = ()=>{ selected = id; renderList(); try{ bOk.click(); }catch(_e){} };

      // Desktop: double click to open
      b.ondblclick = ()=>{ pickAndOk(); };

      // Touch: double tap to open (300ms)
      b.onclick = ()=>{
        const now = Date.now();
        if(lastTapId === id && (now - lastTapTime) < 320){
          lastTapTime = 0; lastTapId = null;
          pickAndOk();
          return;
        }
        lastTapId = id; lastTapTime = now;
        pickOnly();
      };
      return b;
    };
    if(allowNone){
      list.appendChild(makeBtn("", noneLabel));
    }
    for(const it of items){
      if(q && !String(it.name||"").toLowerCase().includes(q)) continue;
      list.appendChild(makeBtn(it.id, it.name));
    }
    if(addLabel){
      list.appendChild(makeBtn("__add__", addLabel));
    }
    if(!list.firstChild){
      list.appendChild(el("div",{className:"muted",textContent:"Немає співпадінь"}));
    }
  };
  inp.oninput = renderList;
  renderList();
  const res = await modalOpen({
    title,
    bodyNodes:[wrap],
    actions:[ bCancel, bOk ]
  });
  if(res.type!=="ok") return null;
  return selected;
}

function shortLabel(text){
  const t = String(text||"").trim();
  if(!t) return "?";
  // use first letter or first digit; keep it compact
  const m = t.match(/[A-Za-zА-Яа-яЇїІіЄєҐґ0-9]/);
  return (m ? m[0] : t[0]).toUpperCase();
}

function renderCircleNav(model){
  // Render space bubbles and journal bubbles into separate containers.
  if(circleSpacesWrap) circleSpacesWrap.innerHTML="";
  if(circleJournalsWrap) circleJournalsWrap.innerHTML="";

  const allSpaces = (state.spaces||[]).filter(s=>s && s.kind==="space");
  const roots = spaceChildren(allSpaces, null);
  const curSpace = spaceById(allSpaces, state.spaceId) || roots[0] || allSpaces[0];

  const spacePathTo = (id)=>{
    const path=[];
    let cur = spaceById(allSpaces, id);
    const guard=new Set();
    while(cur && !guard.has(cur.id)){
      guard.add(cur.id);
      path.unshift(cur.id);
      cur = cur.parentId ? spaceById(allSpaces, cur.parentId) : null;
    }
    return path.length ? path : (curSpace? [curSpace.id] : []);
  };

  const flattenSpaces = ()=>{
    const out=[];
    const walk=(parentId, depth)=>{
      const kids = spaceChildren(allSpaces, parentId);
      for(const s of kids){
        out.push({id:s.id, name:`${' '.repeat(depth*2)}📁 ${s.name}`});
        walk(s.id, depth+1);
      }
    };
    walk(null,0);
    return out;
  };

  const mk = ({label,title,active=false,cls="",onClick})=>{
    const b = el("button",{className:`nav-circle ${cls}`.trim(), textContent:label, title:title||""});
    if(active) b.classList.add("active");
    b.onclick = onClick;
    return b;
  };

  // Space pick (rings): root space + each selected subspace as its own circle (journal-nav parity)
  const spPath = Array.isArray(state.spacePath) ? state.spacePath.slice() : (state.spaceId ? [state.spaceId] : []);
  for(let depth=0; depth<spPath.length; depth++){
    const curId = spPath[depth];
    const parentId = (depth===0) ? null : spPath[depth-1];
    const siblings = spaceChildren(allSpaces, parentId);
    const cur = spaceById(allSpaces, curId) || siblings[0] || null;
    const countLbl = String((siblings||[]).length);
    const lbl = cur ? shortLabel(cur.name||"S") : countLbl;
    const ttl = cur ? (`📁 ${cur.name||"Простір"}`) : (`Просторів: ${countLbl}`);

    circleSpacesWrap.appendChild(mk({
      label: lbl,
      title: ttl,
      active: (depth === (spPath.length-1)),
      onClick: async ()=>{
        const items = (siblings||[]).map(s=>({id:s.id, name:`📁 ${(s.name||'Простір')}`}));
        const picked = await openPickModal({
          title: (depth===0 ? "Оберіть простір" : "Оберіть підпростір"),
          items,
          currentId: curId || null,
          allowNone: (depth>0),
          noneLabel: countLbl,
          addLabel: (depth===0 ? "＋ Додати простір" : "＋ Додати підпростір"),
        });
        if(picked===null) return;

        if(picked==="__add__"){
          if(depth===0){
            const name = (prompt("Назва нового простору:", "Новий простір")||"").trim();
            if(!name) return;
            const { id } = await addSpace(name);
            state.spaces = await ensureSpaces();
            await setSpacePath([id]);
            return;
          } else {
            const p = spaceById(allSpaces, parentId);
            const pname = p ? p.name : "Простір";
            const nm = (prompt("Назва підпростору у: " + pname, "Новий підпростір")||"").trim();
            if(!nm) return;
            const created = await addSubspace(parentId, nm);
            state.spaces = await ensureSpaces();
            const base = spPath.slice(0, depth);
            base.push(parentId);
            base.push(created.id);
            await setSpacePath(base);
            return;
          }
        }

        // None (collapse) -> go to parent
        if(!picked){
          await setSpacePath(spPath.slice(0, depth));
          return;
        }

        // Selecting the SAME item should still allow going to this depth (truncate deeper).
        const nextPath = spPath.slice(0, depth);
        nextPath.push(picked);
        await setSpacePath(nextPath);
      }
    }));
  }

  // "Next" ring for children of the current space (parity with the general view dropdown that shows count).
  const curSpaceIdForKids = spPath.length ? spPath[spPath.length-1] : (state.spaceId || null);
  const kidSpaces = curSpaceIdForKids ? spaceChildren(allSpaces, curSpaceIdForKids) : [];
  if(kidSpaces && kidSpaces.length){
    const cnt = String(kidSpaces.length);
    circleSpacesWrap.appendChild(mk({
      label: cnt,
      title: `Підпросторів: ${cnt}`,
      // This is the "next level" selector ring (children count). It must not be marked active.
      active: false,
      cls: "next",
      onClick: async ()=>{
        const items = (kidSpaces||[]).map(s=>({id:s.id, name:`📁 ${(s.name||'Підпростір')}`}));
        const picked = await openPickModal({
          title: "Оберіть підпростір",
          items,
          currentId: null,
          allowNone: true,
          noneLabel: cnt,
          addLabel: "＋ Додати підпростір",
        });
        if(picked===null) return;
        if(picked==="__add__"){
          const p = spaceById(allSpaces, curSpaceIdForKids);
          const pname = p ? p.name : "Простір";
          const nm = (prompt("Назва підпростору у: " + pname, "Новий підпростір")||"").trim();
          if(!nm) return;
          const created = await addSubspace(curSpaceIdForKids, nm);
          state.spaces = await ensureSpaces();
          const base = spPath.slice();
          base.push(created.id);
          await setSpacePath(base);
          return;
        }
        if(!picked) return;
        const base = spPath.slice();
        base.push(picked);
        await setSpacePath(base);
      }
    }));
  }

  // Quick add button AFTER the last SPACE ring (requested UX)
  const plusSpace = el("button", { className: "btn", textContent: "＋", title: "Додати підпростір" });
  plusSpace.style.width = "42px";
  plusSpace.style.height = "42px";
  plusSpace.style.padding = "0";
  plusSpace.style.marginLeft = "6px";
  plusSpace.onclick = async function(e){
    e.preventDefault(); e.stopPropagation();
    const parentId = curSpaceIdForKids || (spPath[spPath.length-1] || null);
    if(!parentId) return;
    const p = spaceById(allSpaces, parentId);
    const pname = p ? p.name : "Простір";
    const nm = (prompt("Назва підпростору у: " + pname, "Новий підпростір")||"").trim();
    if(!nm) return;
    const created = await addSubspace(parentId, nm);
    state.spaces = await ensureSpaces();
    const base = spPath.slice();
    base.push(created.id);
    await setSpacePath(base);
  };
  circleSpacesWrap.appendChild(plusSpace);
// Top journal pick
  const topId = state.journalPath[0] || (model.topNodes[0] ? model.topNodes[0].id : null);
  const topNode = nodeById(state.jtree, topId) || model.topNodes[0];
  circleJournalsWrap.appendChild(mk({
    label: shortLabel(nodeTitle(topNode)),
    title:`📄 ${nodeTitle(topNode)}`,
    active: state.journalPath.length===1,
    onClick: async()=>{
      const picked = await openPickModal({
        title:"Оберіть журнал",
        items: model.topNodes.map(n=>({id:n.id,name:`📄 ${nodeTitle(n)}`})),
        currentId: topId,
        addLabel: "＋ Додати журнал"
      });
      if(picked===null) return;
      if(picked==="__add__"){
        await openAddRootJournalModal();
        return;
      }
      if(picked===topId) return;
      state.journalPath = setTop(state.journalPath, picked);
      await saveView();
      renderJournalNav();
      render();
    }
  }));

  // Nested levels
  for(const lvl of model.levels){
    const selId = lvl.selected || "";
    const selNode = selId ? nodeById(state.jtree, selId) : null;
    const noneCount = String((lvl.kids||[]).length);
    const lbl = selId ? shortLabel(nodeTitle(selNode)) : noneCount;
    const ttl = selId ? `📄 ${nodeTitle(selNode)}` : (`Піджурналів: ${noneCount}`);
    circleJournalsWrap.appendChild(mk({
      label: lbl,
      title: ttl,
      // Active highlight only for the currently opened JOURNAL node.
      // When selId is empty, this circle represents the "next level" selector and must not be active.
      active: (!!selId) && (state.journalPath.length === (lvl.depth+1)),
      onClick: async()=>{
        const picked = await openPickModal({
          title:"Оберіть піджурнал",
          items: lvl.kids.map(k=>({id:k.id,name:`📄 ${nodeTitle(k)}`})),
          currentId: selId,
          allowNone:true,
          noneLabel: noneCount,
          addLabel: "＋ Додати піджурнал",
        });
        if(picked===null) return;
        if(picked==="__add__"){
          const parentPath = state.journalPath.slice(0, lvl.depth);
          const addUnder = selId ? parentPath.concat([selId]) : parentPath;
          await openAddChildModal(addUnder, addUnder.length-1);
          return;
        }
        state.journalPath = setAtDepth(state.journalPath, lvl.depth, picked);
        state.journalPath = ensureValidJournalPath(state.jtree, state.journalPath);
        await saveView();
        renderJournalNav();
        render();
      }
    }));
  }

  // Quick add button AFTER the last circle (requested UX)
  const plus = el("button", { className: "btn", textContent: "＋", title: "Додати журнал" });
  plus.style.width = "42px";
  plus.style.height = "42px";
  plus.style.padding = "0";
  plus.style.marginLeft = "6px";
  plus.onclick = async function(e){
    e.preventDefault(); e.stopPropagation();
    if(model.levels && model.levels.length){
      const last = model.levels[model.levels.length-1];
      const selId = last.selected || "";
      const parentPath = state.journalPath.slice(0, last.depth);
      const addUnder = selId ? parentPath.concat([selId]) : parentPath;
      await openAddChildModal(addUnder, addUnder.length-1);
    } else {
      await openAddRootJournalModal();
    }
  };
  circleJournalsWrap.appendChild(plus);
}
async function fillCaseSelect(){
  // Legacy feature (Номенклатура → Опис справ) is disabled.
  // Subjournals replace this functionality for ALL journals.
  caseSelect.style.display="none";
  btnCaseBack.style.display="none";
  return;
}

function matchesSearch(row, sheet){
  // Search must work regardless of hidden/visible columns.
  const q=(state.search||"").trim().toLowerCase();
  if(!q) return true;
  const parts=[];
  for(const colDef of (sheet.columns||[])){
    const c = colDef.name;
    if(!c) continue;
    // main cell value
    parts.push(String(row.data?.[c] ?? ""));
    // subrows values (if any)
    if(colDef.subrows){
      for(const sr of (row.subrows||[])) parts.push(String(sr?.[c] ?? ""));
    }
  }
  return parts.join(" ").toLowerCase().includes(q);
}

function matchesSearchCase(row){
  const q=(state.search||"").trim().toLowerCase();
  if(!q) return true;
  const parts=[];
  for(const col of (CASE_DESC_COLUMNS||[])){
    parts.push(String(row?.[col.name] ?? ""));
  }
  return parts.join(" ").toLowerCase().includes(q);
}
function sortRows(rows, sheet){
  const {col,dir}=state.sort; if(!col) return rows;
  const def=sheet.columns.find(c=>c.name===col);
  const getVal=(r)=>{
    if(def?.subrows) return String((r.subrows?.[0]?.[col])??"").toLowerCase();
    const v=r.data?.[col]??"";
    if(def?.type==="int" && isIntegerString(v)) return parseInt(v,10);
    if(def?.type==="date"){
      const p=parseUAdate(v); if(!p) return 0;
      const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(p);
      if(m) return new Date(+m[3],+m[2]-1,+m[1]).getTime();
      return 0;
    }
    return String(v).toLowerCase();
  };
  return rows.slice().sort((a,b)=>{ const va=getVal(a), vb=getVal(b); if(va<vb) return -1*dir; if(va>vb) return 1*dir; return 0; });
}
function toggleSort(sheet,col){ if(state.sort.col===col) state.sort.dir*=-1; else {state.sort.col=col; state.sort.dir=1;} render(); }
function nextOrder(rows,col){ let max=0; for(const r of rows){ const v=parseInt(r.data?.[col]??0,10); if(!Number.isNaN(v)&&v>max) max=v;} return max+1; }

function updateStickyOffsets(){
  try{
    const topbar=document.querySelector(".topbar");
    if(topbar){
      const topH=Math.round(topbar.getBoundingClientRect().height);
      document.documentElement.style.setProperty("--topbar-h", topH+"px");
    }
    const thead=table?.querySelector?.("thead");
    const tr1=thead?.querySelector?.("tr");
    if(tr1){
      const h1=Math.round(tr1.getBoundingClientRect().height);
      document.documentElement.style.setProperty("--head1-h", h1+"px");
    }
  }catch(e){}
}

async function render(){
  // Do not reload config on every render (it would override current UI state).
  // Config is loaded at startup, after settings save, and for explicit refresh.
  const spaces = await ensureSpaces();
  fillSpaceSelect(spaces);
  if(!state.jtree) state.jtree = await ensureJournalTree(state.spaceId, state.sheets);
  state.journalPath = ensureValidJournalPath(state.jtree, state.journalPath);
  renderJournalNav();
  if(levelSelect) levelSelect.value = "admin";
  applyDefaultSortForSheet(currentSheet());
  await fillCaseSelect();
  if(state.mode==="case" && state.caseId) return renderCase(state.caseId);
  return renderSheet();
}
async function renderSheet(){
  const sheet=currentSheet(); if(!sheet) return;
  ensureSimplifiedConfig(sheet);
  updateSimplifiedToggle();
  ensureSimplifiedConfig(sheet);
  updateSimplifiedToggle();
  setSideHint(sheet.key.startsWith("custom_")?"Користувацький лист":"");
  const colsVisible=visibleColumns(sheet);
  let rows=await getRows(curDataKey());
  rows=rows.filter(r=>matchesSearch(r,sheet));
  if(sheet.orderColumn && !state.sort.col){
    rows=rows.slice().sort((a,b)=>parseInt(a.data?.[sheet.orderColumn]??0,10)-parseInt(b.data?.[sheet.orderColumn]??0,10));
  } else rows=sortRows(rows,sheet);


// Simplified view (cards) — Stage 4
if(sheet.simplified?.enabled && sheet.simplified?.on && sheet.simplified?.templates?.length){
  const ok = renderSimplifiedCardsForSheet(sheet, rows);
  if(ok){
    updateStickyOffsets();
    return;
  }
}
// fallback: normal table
if(cards){ cards.style.display="none"; cards.innerHTML=""; }
if(table){ table.style.display=""; }
table.innerHTML="";

  // col widths (persisted per sheet)
  const colgroup = el("colgroup");
  const ss = state.sheetSettings || (state.sheetSettings = {});
  const sheetSS = ss[sheet.key] || (ss[sheet.key] = {});
  const colWidths = sheetSS.colWidths || (sheetSS.colWidths = {});
  const colEls = [];
  colsVisible.forEach((name)=>{
    const col = el("col");
    const w = colWidths[name];
    if(typeof w === "number" && w > 0) col.style.width = w + "px";
    colEls.push(col);
    colgroup.appendChild(col);
  });
  // action cols (fixed)
  colgroup.appendChild(el("col",{className:"col-action"}));
  colgroup.appendChild(el("col",{className:"col-action"}));
  table.appendChild(colgroup);

  const thead=el("thead");
  const tr1=el("tr"), tr2=el("tr");
  colsVisible.forEach((name,i)=>{
    const th=el("th",{textContent:name});
    th.classList.add("sortable","col-resizable");
    th.onclick=()=>toggleSort(sheet,name);
    // column resize (drag near right edge) — pointer-events based (Edge-safe)
    let resizing=false;
    const RESIZE_ZONE=12; // px from right edge
    const minW = 60;

    const isNearRightEdge = (ev)=>{
      const x = ev.clientX;
      const r = th.getBoundingClientRect();
      return x >= (r.right - RESIZE_ZONE);
    };

    const setHover = (on)=>{
      if(on) th.classList.add("col-resize-hover");
      else th.classList.remove("col-resize-hover");
    };

    const startResize = (ev)=>{
      ev.preventDefault(); ev.stopPropagation();
      resizing=true;
      document.body.classList.add("col-resize-active");
      setHover(true);

      const startX = ev.clientX;
      const startW = th.getBoundingClientRect().width;

      // Capture pointer so Edge keeps sending move events even if cursor leaves header
      if(ev.pointerId != null && th.setPointerCapture){
        try{ th.setPointerCapture(ev.pointerId); }catch(e){}
      }

      const onMove = (mv)=>{
        const dx = mv.clientX - startX;
        const w = Math.max(minW, Math.round(startW + dx));
        colEls[i].style.width = w + "px";
        colWidths[name] = w;
      };

      const finish = async ()=>{
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("col-resize-active");
        resizing=false;
        setHover(false);
        try{ await saveSheetSettings(ss); }catch(e){}
      };

      const onUp = ()=>{ finish(); };

      // Prefer pointer events (Edge), fall back to mouse
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, {once:true});
      document.addEventListener("pointercancel", onUp, {once:true});
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp, {once:true});
    };

    // hover detection (pointer + mouse)
    const onHoverMove = (ev)=>{ if(resizing) return; setHover(isNearRightEdge(ev)); };
    th.addEventListener("pointermove", onHoverMove);
    th.addEventListener("mousemove", onHoverMove);
    th.addEventListener("mouseleave",()=>{ if(!resizing) setHover(false); });
    th.addEventListener("pointerleave",()=>{ if(!resizing) setHover(false); });

    // start resize (pointer + mouse)
    th.addEventListener("pointerdown",(ev)=>{ if(isNearRightEdge(ev)) startResize(ev); });
    th.addEventListener("mousedown",(ev)=>{ if(isNearRightEdge(ev)) startResize(ev); });

    // prevent sort click after resizing / near-edge interaction
    th.addEventListener("click",(ev)=>{
      if(resizing || th.classList.contains("col-resize-hover")){ ev.stopPropagation(); }
    }, true);
    if(state.sort.col===name) th.appendChild(el("span",{className:"sort-ind",textContent: state.sort.dir===1?"▲":"▼"}));
    tr1.appendChild(th);
    tr2.appendChild(el("th",{textContent:String(i+1)}));
  });
  tr1.appendChild(el("th",{className:"th-action",textContent:"↪"}));
  tr1.appendChild(el("th",{className:"th-action",textContent:"🗑"}));
  // action columns are not numbered
  tr2.appendChild(el("th",{className:"th-action",textContent:""}));
  tr2.appendChild(el("th",{className:"th-action",textContent:""}));
  thead.appendChild(tr1); thead.appendChild(tr2); table.appendChild(thead);
  // after header exists, measure exact offsets for sticky stacking
  updateStickyOffsets();
  const tbody=el("tbody"); table.appendChild(tbody);

  const hasSubCols = sheet.columns.some(c=>c.subrows);
  const actionDeleteCell=(row)=>{
    const td=el("td",{className:"td-action"});
    const b=el("button",{className:"icon danger",textContent:"🗑"});
    b.onclick=async (ev)=>{ev.stopPropagation(); await deleteFlow(sheet,row);};
    td.appendChild(b); return td;
  };
  const actionTransferCell=(row)=>{
    const td=el("td",{className:"td-action"});
    const b=el("button",{className:"icon",textContent:"↪"});
    b.onclick=async (ev)=>{ev.stopPropagation(); await transferFlow(sheet,row);};
    td.appendChild(b); return td;
  };

  // Render: main row + 0..N subrows. Columns with subrows=false are shared (rowSpan).
  if(!hasSubCols){
    for(const r of rows){
      const tr=el("tr");
      if(state.selectionMode){
        tr.classList.add("sel-row");
        if(state.selectedRowIds.has(r.id)) tr.classList.add("selected");
        tr.onclick=(ev)=>{ ev.preventDefault(); ev.stopPropagation(); toggleRowSelection(r.id); };
      }
      for(const cn of colsVisible){
        const td=el("td",{textContent:String(r.data?.[cn]??"")});
        td.onclick=(ev)=>{ if(state.selectionMode){ ev.stopPropagation(); toggleRowSelection(r.id); return; } editCell(sheet,r,cn,null); };
        tr.appendChild(td);
      }
      tr.appendChild(actionTransferCell(r));
      tr.appendChild(actionDeleteCell(r));
      tbody.appendChild(tr);
    }
    return;
  }
  for(const r of rows){
    const subs = r.subrows || [];
    const totalRows = 1 + subs.length; // 1 main + subrows
    const firstSubCol = colsVisible.find(cn=>{
      const d=sheet.columns.find(x=>x.name===cn);
      return !!d?.subrows;
    });
    for(let i=0;i<totalRows;i++){
      const tr=el("tr");
      if(state.selectionMode){
        tr.classList.add("sel-row");
        if(state.selectedRowIds.has(r.id)) tr.classList.add("selected");
        tr.onclick=(ev)=>{ ev.preventDefault(); ev.stopPropagation(); toggleRowSelection(r.id); };
      }
      for(const colName of colsVisible){
        const def=sheet.columns.find(x=>x.name===colName);
        const allowSub = !!def?.subrows;
        if(!allowSub){
          if(i!==0) continue;
          const td=el("td",{textContent:String(r.data?.[colName]??"")});
          td.rowSpan = totalRows;
          td.onclick=(ev)=>{ if(state.selectionMode){ ev.stopPropagation(); toggleRowSelection(r.id); return; } editCell(sheet,r,colName,null); };
          tr.appendChild(td);
          continue;
        }

        // allowSub === true
        let txt="";
        let subIndex=null;
        const hasSubs = (subs.length>0);
        if(i===0){
          // Main row acts as Subrow #1 (no separate "main" vs numbered subrows)
          txt = (hasSubs && colName==="Номер примірника") ? "1" : String(r.data?.[colName] ?? "");
          subIndex = null;
        } else {
          const sr = subs[i-1] || {};
          txt = (colName==="Номер примірника") ? String(i+1) : String(sr[colName] ?? "");
          subIndex = i-1;
        }
        const td=el("td",{});
        // Show subrow ordinal for ALL subrows (including the first one), but only when row actually has subrows.
        if(hasSubs && firstSubCol && colName===firstSubCol){
          td.appendChild(el("span",{className:"subrow-idx",textContent:String(i+1)}));
          td.appendChild(el("span",{textContent:" "}));
        }
        td.appendChild(el("span",{textContent:txt}));
        td.onclick=(ev)=>{ if(state.selectionMode){ ev.stopPropagation(); toggleRowSelection(r.id); return; } editCell(sheet,r,colName,subIndex); };

        tr.appendChild(td);
      }
      if(i===0){
        const tdT=actionTransferCell(r); tdT.rowSpan=totalRows; tr.appendChild(tdT);
        const tdD=actionDeleteCell(r); tdD.rowSpan=totalRows; tr.appendChild(tdD);
      }
      tbody.appendChild(tr);
    }
  }
}
async function renderCase(caseId){
  updateSimplifiedToggle();
  updateSimplifiedToggle();
  setSideHint("Внутрішній опис справи");
  table.innerHTML="";
  let rows=await getCaseRows(caseId);
  // Apply search filter for case descriptions as well
  rows = rows.filter(matchesSearchCase);
  rows.sort((a,b)=>parseInt(a["№ з/п"]??0,10)-parseInt(b["№ з/п"]??0,10));
  const thead=el("thead"); const tr1=el("tr"), tr2=el("tr");
  CASE_DESC_COLUMNS.forEach((col,i)=>{ tr1.appendChild(el("th",{textContent:col.name})); tr2.appendChild(el("th",{textContent:String(i+1)})); });
  tr1.appendChild(el("th",{className:"th-action",textContent:"↪"}));
  // action columns are not numbered
  tr2.appendChild(el("th",{className:"th-action",textContent:""}));
  tr1.appendChild(el("th",{className:"th-action",textContent:"🗑"}));
  tr2.appendChild(el("th",{className:"th-action",textContent:""}));
  thead.appendChild(tr1); thead.appendChild(tr2); table.appendChild(thead);
  const tbody=el("tbody"); table.appendChild(tbody);
  for(const r of rows){
    const tr=el("tr");
    if(state.selectionMode && state.selectedRowIds?.has(r.id)) tr.classList.add("row-selected");
    CASE_DESC_COLUMNS.forEach(col=>{
      const td=el("td",{textContent:String(r[col.name]??"")});
      td.onclick=async (ev)=>{
        if(state.selectionMode){ ev.stopPropagation(); toggleRowSelection(r.id); return; }
        if(col.editable===false) return;
        const v=prompt(`Редагування\n${col.name}:`,String(r[col.name]??""));
        if(v===null) return;
        r[col.name]=String(v);
        await putCaseRow(r);
        render();
      };
      tr.appendChild(td);
    });
    // transfer button
    const tdT=el("td",{className:"td-action"});
    const bT=el("button",{className:"icon",textContent:"↪"});
    bT.onclick=async (ev)=>{ ev.stopPropagation(); await transferCaseFlow(caseId, r); };
    tdT.appendChild(bT); tr.appendChild(tdT);
    const tdD=el("td",{className:"td-action"});
    const b=el("button",{className:"icon danger",textContent:"🗑"});
    b.onclick=async (ev)=>{ev.stopPropagation(); const ok=await confirmDeleteNumber("Видалити рядок?"); if(!ok) return; await deleteCaseRow(r.id); render();};
    tdD.appendChild(b); tr.appendChild(tdD);
    tbody.appendChild(tr);
  }
}
async function validateValue(def, raw){
  const s=String(raw??"").trim();
  if(def?.required && !s){ alert(`Поле «${def.name}» є обовʼязковим.`); return null; }
  if(!s) return "";
  if(def?.type==="int"){ if(!isIntegerString(s)){ alert("Потрібно число (лише цифри)."); return null; } return s; }
  if(def?.type==="date"){
    const p=parseUAdate(s);
    if(!p){
      alert([
        "Некоректна дата. Допустимі формати:",
        "1) ДДММ  (система додасть крапки та поточний рік)",
        "2) ДД.ММ (система додасть поточний рік)",
        "3) ДД.ММ.РРРР (без підстановок)",
        "4) ДДММРРРР (система підставить крапки)",
      ].join("\n"));
      return null;
    }
    return p;
  }
  return s;
}
async function editCell(sheet,row,colName,subIndex){
  const def=sheet.columns.find(c=>c.name===colName);
  if(def?.editable===false) return;
  if(def?.subrows){
    const lineLabel = (subIndex===null)
      ? "Підстрочка № 1"
      : `Підстрочка № ${subIndex+2}`;
    const actions=[
      btn("Скасувати","cancel","btn"),
      btn("Редагувати","edit","btn btn-primary"),
      btn("Додати підстрочку","add","btn btn-primary"),
    ];
    if(subIndex!==null) actions.push(btn("Видалити підстрочку","del","btn"));
    const op = await modalOpen({
      title:"Оберіть дію",
      bodyNodes:[el("div",{className:"muted",textContent:`${sheet.title}\n${colName}\n${lineLabel}`})],
      actions
    });
    if(op.type==="cancel") return;
    if(op.type==="edit"){
      if(subIndex===null){
        const current=String(row.data?.[colName]??"");
        const v=prompt(`${sheet.title}\n\nРедагування: ${colName}`, current);
        if(v===null) return;
        const val=await validateValue(def,v); if(val===null) return;
        row.data=row.data||{}; row.data[colName]=val;
        await putRow(row); render();
        return;
      }
      return editSubCell(sheet,row,colName,subIndex);
    }
    if(op.type==="add") return addSubRow(sheet,row,subIndex,colName);
    if(op.type==="del") return deleteSubRow(sheet,row,subIndex);
    return;
  }
  const current=String(row.data?.[colName]??"");
  const v=prompt(`${sheet.title}\n\nРедагування: ${colName}`, current);
  if(v===null) return;
  const val=await validateValue(def,v); if(val===null) return;
  row.data=row.data||{}; row.data[colName]=val;
  await putRow(row); render();
}
async function editSubCell(sheet,row,colName,subIndex){
  const subs=row.subrows||[]; const sr=subs[subIndex]||{};
  if(colName==="Номер примірника") return;
  const v=prompt(`${sheet.title}\n\nРедагування підрядка #${subIndex+1}\n${colName}:`, String(sr[colName]??"")); if(v===null) return;
  const def=sheet.columns.find(c=>c.name===colName);
  const val=await validateValue(def,v); if(val===null) return;
  sr[colName]=val; subs[subIndex]=sr; row.subrows=subs;
  if(sheet.columns.some(c=>c.name==="Кількість примірників")){ row.data=row.data||{}; row.data["Кількість примірників"]=String(subs.length); }
  await putRow(row); render();
}
async function addSubRow(sheet,row,afterIndex,onlyColName){
  const subs=row.subrows||[];
  const insertAt=(afterIndex===null||afterIndex===undefined)?subs.length:Math.min(afterIndex+1,subs.length);
  const newSr={};
  let subCols=sheet.columns.filter(c=>c.subrows && !c.computed && c.editable!==false && c.name!=="Номер примірника");
  if(onlyColName){ subCols = subCols.filter(c=>c.name===onlyColName); }
  if(!subCols.length){
    alert("У цьому листі підстрочки вимкнені для всіх колонок (або всі колонки службові).\n\nУвімкніть підстрочки в конструкторі колонок.");
    return;
  }
  for(const sc of subCols){
    let draft="";
    while(true){
      const v=prompt(`${sheet.title}\n\nНовий підрядок\n${sc.name}:`, draft);
      if(v===null) return;
      const vv=await validateValue(sc,v);
      if(vv===null){ draft=String(v??""); continue; }
      newSr[sc.name]=vv;
      break;
    }
  }
  subs.splice(insertAt,0,newSr); row.subrows=subs;
  if(sheet.columns.some(c=>c.name==="Кількість примірників")){ row.data=row.data||{}; row.data["Кількість примірників"]=String(subs.length); }
  await putRow(row); render();
}
async function deleteSubRow(sheet,row,subIndex){
  const subs=row.subrows||[];
  if(subIndex===null||subIndex===undefined) return;
  const ok=await confirmDeleteNumber(`${sheet.title}\nВидалити підрядок № ${subIndex+1}?`); if(!ok) return;
  subs.splice(subIndex,1); row.subrows=subs;
  if(sheet.columns.some(c=>c.name==="Кількість примірників")){ row.data=row.data||{}; row.data["Кількість примірників"]=String(subs.length); }
  await putRow(row); render();
}
async function addSubRowModal(sheet, row){
  // Modal-based subrow add (same UX as +Додати main row)
  const hasSubCols = !!(sheet && sheet.columns && sheet.columns.some(function(c){
    return c.subrows && !c.computed && c.editable!==false && c.name!=="Номер примірника";
  }));
  if(!hasSubCols){
    alert("У цьому листі підстрочки вимкнені для всіх колонок (або всі колонки службові).\n\nУвімкніть підстрочки в конструкторі колонок.");
    return;
  }

  const fields = [];
  (sheet.columns||[]).forEach(function(def){
    if(!def) return;
    if(!def.subrows) return;
    if(def.computed) return;
    if(def.editable===false) return;
    if(def.name==="Номер примірника") return;
    fields.push({name:def.name, def:def});
  });

  if(!fields.length){
    alert("Немає колонок для підстрочки.");
    return;
  }

  const backdrop = $("#modalBackdrop");
  const t = $("#modalTitle");
  const b = $("#modalBody");
  const a = $("#modalActions");

  const draft = { data: {} };
  fields.forEach(function(it){
    draft.data[it.name] = "";
  });

  const form = el("div",{className:"add-form"});
  const inputs = [];

  function makeRow(label, inputEl){
    const r = el("div",{className:"add-row"});
    r.appendChild(el("div",{className:"add-label", textContent: label}));
    r.appendChild(inputEl);
    return r;
  }

  for(let i=0;i<fields.length;i++){
    const name = fields[i].name;
    const def = fields[i].def;
    const isLast = (i===fields.length-1);

    const inp = el("input", {className:"input"});
    inp.dataset.addField = name;
    inp.value = String(draft.data[name] ?? "");

    if(def.type==="int"){
      inp.inputMode = "numeric";
      inp.placeholder = "Лише цифри";
    } else if(def.type==="date"){
      inp.inputMode = "numeric";
      inp.placeholder = "ДДММ / ДД.ММ / ДД.ММ.РРРР / ДДММРРРР";
    }

    inp.setAttribute("enterkeyhint", isLast ? "done" : "next");

    inputs.push({name:name, def:def, el:inp});
    form.appendChild(makeRow(`${name}${def.required?" (обовʼязково)":""}`, inp));
  }

  function focusWithKeyboard(elm){
    if(!elm) return;
    requestAnimationFrame(function(){ requestAnimationFrame(function(){
      try{ elm.focus(); }catch(_e){}
      try{ elm.click(); }catch(_e){}
      try{
        if(elm.setSelectionRange){
          const L = String(elm.value||"").length;
          elm.setSelectionRange(L,L);
        }
      }catch(_e){}
    });});
  }

  function showAcceptedDateFormats(){
    alert([
      "Некоректна дата. Допустимі формати:",
      "1) ДДММ  (система додасть крапки та поточний рік)",
      "2) ДД.ММ (система додасть поточний рік)",
      "3) ДД.ММ.РРРР (без підстановок)",
      "4) ДДММРРРР (система підставить крапки)",
    ].join("\n"));
  }

  async function onOk(){
    for(let k=0;k<inputs.length;k++){
      const it = inputs[k];
      const raw = String((draft.data[it.name] ?? "")).trim();
      const s = raw;

      if(it.def && it.def.required && !s){
        alert(`Поле «${it.name}» є обовʼязковим.`);
        focusWithKeyboard(it.el);
        return;
      }
      if(!s){
        draft.data[it.name] = "";
        continue;
      }

      if(it.def && it.def.type==="int"){
        if(!isIntegerString(s)){
          alert("Потрібно число (лише цифри).");
          focusWithKeyboard(it.el);
          return;
        }
        draft.data[it.name] = s;
        it.el.value = s;
        continue;
      }

      if(it.def && it.def.type==="date"){
        const p = parseUAdate(s);
        if(!p){
          showAcceptedDateFormats();
          focusWithKeyboard(it.el);
          return;
        }
        draft.data[it.name] = p;
        it.el.value = p;
        continue;
      }

      draft.data[it.name] = s;
      it.el.value = s;
    }

    const subs = row.subrows || [];
    const newSr = {};
    inputs.forEach(function(it){
      const v = draft.data[it.name];
      if(v!=null && String(v).trim()!=="") newSr[it.name] = v;
    });
    subs.push(newSr);
    row.subrows = subs;

    if(sheet.columns && sheet.columns.some(function(c){ return c.name==="Кількість примірників"; })){
      row.data = row.data || {};
      row.data["Кількість примірників"] = String(subs.length);
    }

    close();
    // IMPORTANT: rows are indexed by journalKey. If we put() a row without journalKey
    // back to IndexedDB, it will no longer appear in journal lists.
    if(!row.journalKey) row.journalKey = curDataKey();
    await putRow(row);
    render();
  }

  function bindEnter(){
    inputs.forEach(function(it, idx){
      it.el.addEventListener("keydown", function(e){
        if(!e || e.key!=="Enter") return;
        e.preventDefault();
        const next = (inputs[idx+1] && inputs[idx+1].el) ? inputs[idx+1].el : null;
        if(next){
          focusWithKeyboard(next);
        } else {
          onOk();
        }
      });
    });
  }

  bindEnter();

  inputs.forEach(function(it){
    it.el.addEventListener("input", function(){
      draft.data[it.name] = String(it.el.value ?? "");
    });
  });

  const hint = el("div",{className:"muted", textContent:"Підтвердження: Enter = далі / Готово. На останньому полі Enter = Додати підстрочку.", style:"margin-top:4px"});
  b.innerHTML="";
  b.appendChild(form);
  b.appendChild(hint);

  a.innerHTML="";
  const bCancel = btn("Скасувати","cancel","btn");
  const bOk = btn("Додати підстрочку","ok","btn btn-primary");
  a.appendChild(bCancel);
  a.appendChild(bOk);

  function close(){
    backdrop.style.display="none";
    backdrop.onclick=null;
    bCancel.onclick=null;
    bOk.onclick=null;
  }

  t.textContent = `${sheet.title}\nДодати підстрочку`;
  backdrop.style.display="flex";
  backdrop.onclick = function(e){ if(e && e.target===backdrop){ close(); } };

  bCancel.onclick = function(){ close(); };
  bOk.onclick = function(){ onOk(); };

  focusWithKeyboard(inputs[0] ? inputs[0].el : null);
}

async function maybeAskAddSubrow(sheet, record){
  const hasSubCols = !!(sheet && sheet.columns && sheet.columns.some(function(c){
    return c.subrows && !c.computed && c.editable!==false && c.name!=="Номер примірника";
  }));
  if(!hasSubCols) return;

  // Wait a tick to avoid the previous Enter/tap closing the modal instantly in WebView
  await new Promise(function(r){ setTimeout(r, 0); });

  const bNo = btn("Ні","no","btn btn-primary");
  const bYes = btn("Так","yes","btn");

  // Disable answering by Enter (especially YES)
  function blockEnter(e){
    if(e && e.key==="Enter"){ e.preventDefault(); e.stopPropagation(); }
  }
  bNo.addEventListener("keydown", blockEnter);
  bYes.addEventListener("keydown", blockEnter);

  // Also block Enter globally while this modal is open
  document.addEventListener("keydown", blockEnter, true);
  try{
    const prom = modalOpen({
      title: "Підстрочки",
      bodyNodes: [el("div",{className:"muted",textContent:"У цьому журналі увімкнені підстрочки. Додати підстрочку до щойно створеної строки?"})],
      actions: [bNo, bYes]
    });
    // Focus NO by default so Enter cannot confirm YES
    requestAnimationFrame(function(){ try{ bNo.focus(); }catch(_e){} });
    const res = await prom;
    if(res && res.type==="yes"){
      await addSubRowModal(sheet, record);
    }
  } finally {
    document.removeEventListener("keydown", blockEnter, true);
  }
}

async function addFlow(){
  // New modal-based add flow (better for Android: autofocus + Enter navigation/submit)
  if(state.mode==="case"){ alert("Додавання у опис справи — через перенесення ↪."); return; }
  const sheet=currentSheet(); if(!sheet) return;
  const rows=await getRows(curDataKey());

  const record={data:{}, subrows:[]};
  // keep journalKey on the in-memory object so later putRow() calls don't drop it
  record.journalKey = curDataKey();
  if(sheet.orderColumn) record.data[sheet.orderColumn]=String(nextOrder(rows,sheet.orderColumn));

  // apply defaults
  for(const c of sheet.columns){
    if(c.defaultValue && record.data[c.name]==null) record.data[c.name]=c.defaultValue;
    if(c.type==="date" && c.defaultToday && record.data[c.name]==null) record.data[c.name]=uaDateToday();
  }

  const addCfg = state.addFieldsCfg[sheet.key] || sheet.addFields || sheet.columns.map(c=>c.name);
  const fields = [];
  for(const name of addCfg){
    const def=sheet.columns.find(c=>c.name===name); if(!def) continue;
    if(sheet.orderColumn && name===sheet.orderColumn) continue;
    if(def.computed) continue;
    fields.push({name, def});
  }

  // If no fields configured, fall back to old behavior (still adds empty row)
  if(!fields.length){
    record.id = await addRow(curDataKey(), record);
    if(sheet.key==="nomenklatura") await ensureCaseFromNomenRecord(record);
    await fillCaseSelect();
    render();

    await maybeAskAddSubrow(sheet, record);
    render();
    return;
  }

  // --- modal UI ---
  const backdrop = $("#modalBackdrop");
  const t = $("#modalTitle");
  const b = $("#modalBody");
  const a = $("#modalActions");

  // Virtual container (draft): keep everything while validating
  const draft = {
    data: {...(record.data||{})},
    subrows: []
  };

  const form = el("div", {className:"add-form", style:"display:flex; flex-direction:column; gap:10px;"});
  const inputs = []; // {name, def, el}

  const makeRow = (labelText, inputEl)=>{
    const row = el("div", {style:"display:flex; flex-direction:column; gap:6px;"});
    row.appendChild(el("div", {className:"muted", textContent:labelText}));
    row.appendChild(inputEl);
    return row;
  };

  for(let i=0;i<fields.length;i++){
    const {name, def} = fields[i];
    const isLast = (i===fields.length-1);

    // input
    const inp = el("input", {className:"input"});
    inp.dataset.addField = name;
    inp.value = String(draft.data?.[name] ?? "");

    // type hints
    if(def.type==="int"){
      inp.inputMode = "numeric";
      inp.placeholder = "Лише цифри";
    } else if(def.type==="date"){
      inp.inputMode = "numeric";
      inp.placeholder = "ДДММ / ДД.ММ / ДД.ММ.РРРР / ДДММРРРР";
    }

    // IME: Next/Done for Android keyboards
    inp.setAttribute("enterkeyhint", isLast ? "done" : "next");

    inputs.push({name, def, el: inp});
    form.appendChild(makeRow(`${name}${def.required?" (обовʼязково)":""}`, inp));
  }

  // helper: open keyboard reliably on Android WebView
  function focusWithKeyboard(elm){
    if(!elm) return;
    // Use two RAFs to survive rerenders/paint
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      try{ elm.focus(); }catch(_e){}
      // click helps Android WebView to show keyboard
      try{ elm.click(); }catch(_e){}
      try{ elm.setSelectionRange?.(String(elm.value||"").length, String(elm.value||"").length); }catch(_e){}
    }));
  }

  // Enter navigation / submit
  function bindEnter(){
    inputs.forEach((it, idx)=>{
      it.el.addEventListener("keydown", (e)=>{
        if(e.key!=="Enter") return;
        e.preventDefault();
        const next = inputs[idx+1]?.el;
        if(next){
          focusWithKeyboard(next);
        } else {
          onOk();
        }
      });
    });
  }

  bindEnter();

  // Keep draft updated live
  inputs.forEach(it=>{
    it.el.addEventListener("input", ()=>{
      draft.data[it.name] = String(it.el.value ?? "");
    });
  });

  const hint = el("div",{className:"muted", textContent:"Підтвердження: Enter = далі / Готово. На останньому полі Enter = Додати.", style:"margin-top:4px"});
  b.innerHTML="";
  b.appendChild(form);
  b.appendChild(hint);

  // actions
  a.innerHTML="";
  const bCancel = btn("Скасувати","cancel","btn");
  const bOk = btn("Додати","ok","btn btn-primary");
  a.appendChild(bCancel);
  a.appendChild(bOk);

  const close = ()=>{
    backdrop.style.display="none";
    backdrop.onclick=null;
    bCancel.onclick=null;
    bOk.onclick=null;
    // remove listeners are GC-ed
  };

  function showAcceptedDateFormats(){
    alert([
      "Некоректна дата. Допустимі формати:",
      "1) ДДММ  (система додасть крапки та поточний рік)",
      "2) ДД.ММ (система додасть поточний рік)",
      "3) ДД.ММ.РРРР (без підстановок)",
      "4) ДДММРРРР (система підставить крапки)",
    ].join("\n"));
  }

  async function onOk(){
    // validate sequentially, keep draft and return focus to invalid field
    for(const it of inputs){
      const raw = String(draft.data?.[it.name] ?? "").trim();
      const s = raw;
      // required
      if(it.def?.required && !s){
        alert(`Поле «${it.name}» є обовʼязковим.`);
        focusWithKeyboard(it.el);
        return;
      }
      if(!s){
        draft.data[it.name] = "";
        continue;
      }
      if(it.def?.type==="int"){
        if(!isIntegerString(s)){
          alert("Потрібно число (лише цифри).");
          focusWithKeyboard(it.el);
          return;
        }
        draft.data[it.name] = s;
        it.el.value = s;
        continue;
      }
      if(it.def?.type==="date"){
        const p = parseUAdate(s);
        if(!p){
          showAcceptedDateFormats();
          focusWithKeyboard(it.el);
          return;
        }
        draft.data[it.name] = p;
        it.el.value = p;
        continue;
      }
      draft.data[it.name] = s;
      it.el.value = s;
    }

    // commit draft to record
    record.data = {...(record.data||{}), ...(draft.data||{})};

    close();
    record.id = await addRow(curDataKey(), record);
    if(sheet.key==="nomenklatura") await ensureCaseFromNomenRecord(record);
    await fillCaseSelect();
    render();

    await maybeAskAddSubrow(sheet, record);
    render();
  }

  // open modal
  t.textContent = `${sheet.title}\nДодати строку`;
  backdrop.style.display="flex";
  backdrop.onclick = (e)=>{ if(e.target===backdrop) { close(); } };

  bCancel.onclick = ()=>{ close(); };
  bOk.onclick = ()=>{ onOk(); };

  // autofocus first input & open keyboard (Android)
  focusWithKeyboard(inputs[0]?.el);
}
async function ensureCaseFromNomenRecord(row){
  const idx=String(row.data?.["Індекс справи"]??"").trim();
  const title=String(row.data?.["Заголовок справи (тому, частини)"]??"").trim();
  if(!idx && !title) return null;
  const cases=await getAllCases();
  const existing=cases.find(c=>String(c.caseIndex||"").trim()===idx && String(c.caseTitle||"").trim()===title);
  if(existing) return existing;
  const c={caseIndex:idx, caseTitle:title, createdAt:new Date().toISOString(), createdFrom:"nomenklatura"};
  const id=await addCase(c); c.id=id; return c;
}
async function deleteFlow(sheet,row){
  const hasSub = sheet.columns.some(c=>c.subrows);
  if(!hasSub || !(row.subrows && row.subrows.length)){
    const ok=await confirmDeleteNumber(`${sheet.title}\nВидалити всю строку?`); if(!ok) return;
    await deleteRow(row.id); render(); return;
  }
  const op = await modalOpen({
    title:"Видалення",
    bodyNodes:[el("div",{className:"muted",textContent:`${sheet.title}\nОберіть що видалити`})],
    actions:[btn("Скасувати","cancel","btn"),btn("Вся строка","row","btn btn-primary"),btn("Підстрока","sub","btn btn-primary")]
  });
  if(op.type==="cancel") return;
  if(op.type==="row"){ const ok=await confirmDeleteNumber(`${sheet.title}\nВидалити всю строку?`); if(!ok) return; await deleteRow(row.id); render(); return; }
  if(op.type==="sub"){
    const v=prompt(`Виберіть номер підстроки (1..${row.subrows.length})`,"1"); if(v===null) return;
    const n=parseInt(v,10); if(Number.isNaN(n)||n<1||n>row.subrows.length) return alert("Некоректний номер.");
    const ok=await confirmDeleteNumber(`${sheet.title}\nВидалити підстроку № ${n}?`); if(!ok) return;
    row.subrows.splice(n-1,1);
    if(sheet.columns.some(c=>c.name==="Кількість примірників")){ row.data=row.data||{}; row.data["Кількість примірників"]=String(row.subrows.length); }
    await putRow(row); render();
  }
}

async function ensureAllSpaceJournalTree(){
  // Synthetic tree: Space/Subspace nodes, and under each - its journals.
  const allSpaces = (state.spaces||[]).filter(function(s){ return s && s.kind==="space"; });
  const nodes = {};
  const topIds = [];

  // numbering like 1, 1.1, 1.1.1
  const numMap = {};
  (function walk(parentId, prefix){
    const kids = spaceChildren(allSpaces, parentId);
    for(var i=0;i<kids.length;i++){
      const s = kids[i];
      const num = prefix ? (prefix + "." + (i+1)) : String(i+1);
      numMap[s.id] = num;
      walk(s.id, num);
    }
  })(null, "");

  function addNode(n){ nodes[n.id]=n; return n; }

  async function attachJournals(spaceId, spaceNodeId){
    var jt=null;
    try{ jt = await ensureJournalTree(spaceId, state.sheets); }catch(_e){ jt=null; }
    if(!jt || !jt.nodes || !jt.topIds) return;

    function walkJournal(origId, parentCombinedId){
      const origNode = jt.nodes[origId];
      if(!origNode) return;
      const cid = "J:"+spaceId+":"+origId;
      const title = "📄 " + (origNode.title || origNode.key || origNode.id);
      const cn = addNode({ id: cid, title: title, children: [] });
      const p = nodes[parentCombinedId];
      if(p) p.children.push(cid);

      const ch = Array.isArray(origNode.children) ? origNode.children : [];
      for(var k=0;k<ch.length;k++){
        walkJournal(ch[k], cid);
      }
    }

    for(var i=0;i<jt.topIds.length;i++){
      walkJournal(jt.topIds[i], spaceNodeId);
    }
  }

  async function walkSpaces(parentId, parentCombinedId){
    const kids = spaceChildren(allSpaces, parentId);
    for(var i=0;i<kids.length;i++){
      const s = kids[i];
      const sid = "S:"+s.id;
      const num = numMap[s.id] || "";
      const title = "📁 " + (num? (num+" ") : "") + (s.name||"Простір");
      addNode({ id: sid, title: title, children: [] });
      if(parentCombinedId){
        nodes[parentCombinedId].children.push(sid);
      } else {
        topIds.push(sid);
      }
      await attachJournals(s.id, sid);
      await walkSpaces(s.id, sid);
    }
  }

  await walkSpaces(null, null);
  return { nodes: nodes, topIds: topIds };
}


async function transferFlow(sheet,row){
  const tpls=await getTransferTemplates();
  const forSheet=tpls.filter(t=>t.fromSheetKey===sheet.key);
  if(!forSheet.length){ alert("Немає шаблонів перенесення для цього листа."); return; }

  const selTpl = el("select",{className:"select"});
  forSheet.forEach((t,i)=>selTpl.appendChild(el("option",{value:t.id,textContent:`${i+1}) ${t.name||"(без назви)"}`})));
  selTpl.value = forSheet[0].id;

  const info = el("div",{className:"muted",style:"margin-top:6px"});

  const modeWrap = el("div",{style:"margin-top:10px"});
  const rbAll = el("input",{type:"radio", name:"submode", checked:true});
  const rbPick = el("input",{type:"radio", name:"submode"});
  const lblAll = el("label",{style:"display:flex; gap:8px; align-items:center;"});
  lblAll.appendChild(rbAll); lblAll.appendChild(el("span",{textContent:"Переносити всі підстрочки (1,2,3... по індексу)"}));
  const lblPick = el("label",{style:"display:flex; gap:8px; align-items:center; margin-top:6px;"});
  lblPick.appendChild(rbPick); lblPick.appendChild(el("span",{textContent:"Обрати підстрочки"}));
  modeWrap.appendChild(lblAll);
  modeWrap.appendChild(lblPick);

  const subsBox = el("div",{style:"margin-top:8px; padding-left:22px"});
  modeWrap.appendChild(subsBox);

  const render = ()=>{
    const t = forSheet.find(x=>x.id===selTpl.value) || forSheet[0];
    if(t.toSheetKey==="__case__"){
      info.textContent = "Ціль: Опис справи";
    } else {
      const dest = state.sheets.find(s=>s.key===t.toSheetKey);
      info.textContent = dest ? `Ціль: Лист: ${dest.title}` : "";
    }
    subsBox.innerHTML="";
    const subs=row.subrows||[];
    const total = 1 + subs.length;
    if(total===1){
      // only one subrow (№1)
      rbPick.disabled=true;
      rbAll.checked=true;
      subsBox.appendChild(el("div",{className:"muted",textContent:"У цієї строки є тільки підстрочка №1."}));
      return;
    }
    rbPick.disabled=false;
    subsBox.appendChild(el("div",{className:"muted",textContent:"Оберіть підстрочки для перенесення (можна декілька):"}));
    const tools=el("div",{className:"row",style:"gap:8px; margin-top:6px"});
    const bAll=el("button",{className:"btn",textContent:"Всі"});
    const bNone=el("button",{className:"btn",textContent:"Жодної"});
    tools.appendChild(bAll); tools.appendChild(bNone);
    subsBox.appendChild(tools);
    const list=el("div",{style:"margin-top:6px"});
    // Показуємо ВСІ підстрочки 1..N, де 1 — це row.data, а 2..N — row.subrows
    for(let i=0;i<total;i++){
      const lab=el("label",{style:"display:flex; gap:8px; align-items:center; margin:2px 0"});
      const ch=el("input",{type:"checkbox"});
      // subIndex тут у "загальній" шкалі: 0 => перша підстрочка (row.data), 1.. => row.subrows[subIndex-1]
      ch.dataset.subIndex=String(i);
      lab.appendChild(ch);
      lab.appendChild(el("span",{textContent:`Підстрочка ${i+1}`}));
      list.appendChild(lab);
    }
    bAll.onclick=()=>{ list.querySelectorAll("input[type=checkbox]").forEach(x=>x.checked=true); };
    bNone.onclick=()=>{ list.querySelectorAll("input[type=checkbox]").forEach(x=>x.checked=false); };
    subsBox.appendChild(list);
  };
  selTpl.onchange=render;
  render();

  // Destination picker (QuickNav core) embedded in transfer dialog
  let pickedDest = null;
  const _activeJournalId = ()=> (Array.isArray(state.journalPath) && state.journalPath.length ? state.journalPath[state.journalPath.length-1] : null);
  const destTitle = el("div",{className:"muted", style:"margin-top:12px", textContent:"Документ-призначення (швидка навігація):"});
  const destInfo = el("div",{className:"muted", style:"margin-top:6px", textContent:"Не обрано"});
  const qnav = await createQuickNavPanel({
    mode:"pick",
    showSpaces:false,
    showJournals:true,
    allowAdd:false,
    allowDelete:false,
    showSearch:false,
    defaultCollapsed:true,
    persistDefaultCollapsed:false,
   getData: async ()=>({
      spaces: [],
      activeSpaceId: null,
      jtree: (state._transferAllTree = await ensureAllSpaceJournalTree()),
      activeJournalId: null,
     }),
    onPick: async (sel)=>{
      if(sel && sel.kind==="journal"){
        const pathIds = Array.isArray(sel.path) ? sel.path.slice() : [sel.id];
        let spaceId = null;
        const journalPath = [];
        for(let i=0;i<pathIds.length;i++){
          const pid = pathIds[i];
          if(typeof pid !== "string") continue;
          if(pid.indexOf("J:")===0){
            const parts = pid.split(":");
            if(parts.length>=3){
              if(!spaceId) spaceId = parts[1];
              journalPath.push(parts.slice(2).join(":"));
            }
          }
        }
        const lastJ = journalPath.length ? journalPath[journalPath.length-1] : null;
        if(!lastJ){
          pickedDest = null;
          destInfo.textContent = "Не обрано";
          return;
        }
        pickedDest = { kind:"journal", spaceId: (spaceId||state.spaceId), id: lastJ };

        // Pretty path
        const tree = state._transferAllTree;
        const labels = [];
        if(tree && tree.nodes){
          for(let i=0;i<pathIds.length;i++){
            const pid = pathIds[i];
            const n = tree.nodes[pid];
            if(n && n.title){
              labels.push(String(n.title).replace(/^📁\s*/,'').replace(/^📄\s*/,''));
            }
          }
        }
        destInfo.textContent = labels.length ? ("Обрано: " + labels.join(" → ")) : ("Обрано: " + lastJ);
      }
    },
    closeOnPick:false,
  });
  const applyTplToQuickNav = ()=>{
    const t = forSheet.find(x=>x.id===selTpl.value) || forSheet[0];
    if(!t || t.toSheetKey==="__case__"){
      pickedDest = null;
      destInfo.textContent = "Не потрібно (ціль: Опис справи)";
      // NOTE: search is intentionally hidden in transfer picker.
      // Keep internal value for future programmatic use, but do not filter UI now.
      try{ state._transferQuickNavSearch = ""; }catch(_e){}
      return;
    }
    const destSheet = (state.sheets||[]).find(s=>s.key===t.toSheetKey);
    const q = destSheet ? (destSheet.title || destSheet.name) : String(t.toSheetKey||"");
    state._transferQuickNavSearch = q;
    // Apply hidden search immediately so journals matching destination name are shown automatically.
    try{ qnav.api.setSearch(q); }catch(_e){}
    try{ qnav.api.refresh(); }catch(_e){}
  };
  applyTplToQuickNav();
  const _oldOnChange = selTpl.onchange;
  selTpl.onchange = ()=>{ try{ _oldOnChange && _oldOnChange(); }catch(_e){} applyTplToQuickNav(); };

  const op = await modalOpen({
    title:"Перенесення",
    bodyNodes:[
      el("div",{className:"muted",textContent:sheet.title}),
      selTpl,
      info,
      modeWrap,
      destTitle,
      destInfo,
      qnav.root
    ],
    actions:[btn("Скасувати","cancel","btn"),btn("Перенести","go","btn btn-primary")]
  });
  // persist hidden search string (for later automated insertions)
  try{ state._transferQuickNavSearch = qnav.api.getSearch(); }catch(_e){}
  if(op.type!=="go") return;

  const tpl = forSheet.find(x=>x.id===selTpl.value) || forSheet[0];
  let subMode="all";
  let selectedSubIdx=[];
  if(rbPick.checked){
    subMode="selected";
    selectedSubIdx = Array.from(subsBox.querySelectorAll("input[type=checkbox]")).filter(ch=>ch.checked).map(ch=>parseInt(ch.dataset.subIndex,10)).filter(n=>Number.isFinite(n));
    if(!selectedSubIdx.length) return alert("Оберіть хоча б одну підстрочку.");
  }
  await runTransferForRows(sheet,[row],tpl,{subMode, subIndexes:selectedSubIdx}, {pickedDest});
}

function casePseudoSheet(){
  return { key:"__case__", title:"Опис справи", columns: CASE_DESC_COLUMNS.map(c=>({name:c.name, subrows:false})) };
}
function wrapCaseRow(r){
  // normalize case row to the same shape as journal rows
  return { id:r.id, data:{...r}, subrows:[] };
}

async function transferCaseFlow(caseId, caseRow){
  const tpls=await getTransferTemplates();
  const forCase=tpls.filter(t=>t.fromSheetKey==="__case__");
  if(!forCase.length){ alert("Немає шаблонів перенесення для опису справи."); return; }

  const selTpl = el("select",{className:"select"});
  forCase.forEach((t,i)=>selTpl.appendChild(el("option",{value:t.id,textContent:`${i+1}) ${t.name||"(без назви)"}`})));
  selTpl.value = forCase[0].id;

  const info = el("div",{className:"muted",style:"margin-top:6px"});
  const renderInfo=()=>{
    const t = forCase.find(x=>x.id===selTpl.value) || forCase[0];
    if(t.toSheetKey==="__case__") info.textContent = "Ціль: Опис справи";
    else {
      const dest = state.sheets.find(s=>s.key===t.toSheetKey);
      info.textContent = dest ? `Ціль: Лист: ${dest.title}` : "";
    }
  };
  selTpl.onchange=renderInfo; renderInfo();

  const op = await modalOpen({
    title:"Перенесення",
    bodyNodes:[
      el("div",{className:"muted",textContent:"Опис справи"}),
      selTpl,
      info,
      el("div",{className:"muted",textContent:"У описі справи підстрочок немає — переноситься один рядок."})
    ],
    actions:[btn("Скасувати","cancel","btn"),btn("Перенести","go","btn btn-primary")]
  });
  if(op.type!=="go") return;
  const tpl = forCase.find(x=>x.id===selTpl.value) || forCase[0];
  await runTransferForRows(casePseudoSheet(), [wrapCaseRow(caseRow)], tpl, {subMode:"main", subIndexes:[]}, {caseId});
}

async function transferMultipleCaseFlow(caseId, caseRows){
  const tpls=await getTransferTemplates();
  const forCase=tpls.filter(t=>t.fromSheetKey==="__case__");
  if(!forCase.length){ alert("Немає шаблонів перенесення для опису справи."); return; }

  const selTpl = el("select",{className:"select"});
  forCase.forEach((t,i)=>selTpl.appendChild(el("option",{value:t.id,textContent:`${i+1}) ${t.name||"(без назви)"}`})));
  selTpl.value=forCase[0].id;
  const info=el("div",{className:"muted",style:"margin-top:6px"});
  const renderInfo=()=>{
    const t = forCase.find(x=>x.id===selTpl.value) || forCase[0];
    if(t.toSheetKey==="__case__") info.textContent = "Ціль: Опис справи";
    else {
      const dest = state.sheets.find(s=>s.key===t.toSheetKey);
      info.textContent = dest ? `Ціль: Лист: ${dest.title}` : "";
    }
  };
  selTpl.onchange=renderInfo; renderInfo();

  const op = await modalOpen({
    title:"Перенесення вибраних",
    bodyNodes:[
      el("div",{className:"muted",textContent:`Опис справи — вибрано рядків: ${caseRows.length}`}),
      selTpl,
      info,
    
      destTitle,
      destInfo,
      qnav.root,
],
    actions:[btn("Скасувати","cancel","btn"),btn("Перенести","go","btn btn-primary")]
  });
  if(op.type!=="go") return;
  const tpl = forCase.find(x=>x.id===selTpl.value) || forCase[0];
  const wrapped = caseRows.map(wrapCaseRow);
  await runTransferForRows(casePseudoSheet(), wrapped, tpl, {subMode:"main", subIndexes:[]}, {caseId});
}


async function transferMultipleFlow(sheet, rows){
  const tpls=await getTransferTemplates();
  const forSheet=tpls.filter(t=>t.fromSheetKey===sheet.key);
  if(!forSheet.length){ alert("Немає шаблонів перенесення для цього листа."); return; }

  const selTpl = el("select",{className:"select"});
  forSheet.forEach((t,i)=>selTpl.appendChild(el("option",{value:t.id,textContent:`${i+1}) ${t.name||"(без назви)"}`})));
  selTpl.value=forSheet[0].id;

  const info=el("div",{className:"muted",style:"margin-top:6px"});
  const modeSel=el("select",{className:"select"});
  [{v:"main",t:"Тільки основні строки"},{v:"all",t:"Основні + всі підстрочки"}].forEach(x=>modeSel.appendChild(el("option",{value:x.v,textContent:x.t})));

  const render=()=>{
    const t=forSheet.find(x=>x.id===selTpl.value) || forSheet[0];
    if(t.toSheetKey==="__case__"){
      info.textContent = "Ціль: Опис справи";
    } else {
      const dest=state.sheets.find(s=>s.key===t.toSheetKey);
      info.textContent = dest ? `Ціль: Лист: ${dest.title}` : "";
    }
  };
  selTpl.onchange=render; render();



  // Destination picker (QuickNav core) embedded in transfer dialog
  let pickedDest = null;
  const _activeJournalId = ()=> (Array.isArray(state.journalPath) && state.journalPath.length ? state.journalPath[state.journalPath.length-1] : null);
  const destTitle = el("div",{className:"muted", style:"margin-top:12px", textContent:"Документ-призначення (швидка навігація):"});
  const destInfo = el("div",{className:"muted", style:"margin-top:6px", textContent:"Не обрано"});
  const qnav = await createQuickNavPanel({
    mode:"pick",
    showSpaces:true,
    showJournals:true,
    allowAdd:false,
    allowDelete:false,
    showSearch:false,
    defaultCollapsed:true,
    persistDefaultCollapsed:false,
    getData: async ()=>({
      spaces: state.spaces,
      activeSpaceId: state.spaceId,
      jtree: state.jtree,
      activeJournalId: _activeJournalId(),
    }),
    onPick: async (sel)=>{
      if(sel && sel.kind==="journal"){
        pickedDest = sel;
        const path = Array.isArray(sel.path) ? sel.path.join(" → ") : sel.id;
        destInfo.textContent = `Обрано: ${path}`;
      }
    },
    closeOnPick:false,
  });
  const applyTplToQuickNav = ()=>{
    const t = forSheet.find(x=>x.id===selTpl.value) || forSheet[0];
    if(!t || t.toSheetKey==="__case__"){
      pickedDest = null;
      destInfo.textContent = "Не потрібно (ціль: Опис справи)";
      try{ qnav.api.setSearch(""); }catch(_e){}
      return;
    }
    const destSheet = (state.sheets||[]).find(s=>s.key===t.toSheetKey);
    const q = destSheet ? (destSheet.title || destSheet.name) : String(t.toSheetKey||"");
    state._transferQuickNavSearch = q;
    try{ qnav.api.setSearch(q); }catch(_e){}
  };
  applyTplToQuickNav();
  const _oldOnChange = selTpl.onchange;
  selTpl.onchange = ()=>{ try{ _oldOnChange && _oldOnChange(); }catch(_e){} applyTplToQuickNav(); };
    const op = await modalOpen({
    title:"Перенесення вибраних",
    bodyNodes:[
      el("div",{className:"muted",textContent:`${sheet.title} — вибрано строк: ${rows.length}`}),
      selTpl,
      info,
      modeSel,
      el("div",{className:"muted",textContent:"Для вибраних строк детальний вибір підстрочок по кожній строкі не робимо — або тільки основні, або всі підстрочки."}),
      destTitle,
      destInfo,
      qnav.root
    ],
    actions:[btn("Скасувати","cancel","btn"),btn("Перенести","go","btn btn-primary")]
  });
  // persist hidden search string (for later automated insertions)
  try{ state._transferQuickNavSearch = qnav.api.getSearch(); }catch(_e){}
  if(op.type!=="go") return;
  const tpl = forSheet.find(x=>x.id===selTpl.value) || forSheet[0];
  const subMode = modeSel.value || "main";
  await runTransferForRows(sheet, rows, tpl, {subMode, subIndexes:[]}, {pickedDest});
}





async function runTransferForRows(sourceSheet, rows, tpl, {subMode, subIndexes}, ctx={}){
  // Wrapper: UI-specific prompts and state refresh around TransferCore
  const onNeedEnableSubrows = async ({toSheetKey, colNames})=>{
    const cols = colNames.join(", ");
    const op=await modalOpen({
      title:"Підстрочки заборонені",
      bodyNodes:[
        el("div",{className:"muted",textContent:`Для перенесення потрібні підстрочки у колонках: ${cols}`}),
        el("div",{className:"muted",textContent:"Дозволити підстрочки у цих колонках і продовжити?"})
      ],
      actions:[btn("Скасувати","cancel","btn"),btn("Пропустити ці колонки","skip","btn"),btn("Дозволити і продовжити","allow","btn btn-primary")]
    });
    return op.type; // cancel|skip|allow
  };
  const allowSubrows = async ({toSheetKey, colNames})=>{
    const all=await getAllSheets();
    const sh=all.find(s=>s.key===toSheetKey);
    if(sh){
      for(const cn of colNames){
        const c=sh.columns.find(x=>x.name===cn);
        if(c) c.subrows=true;
      }
      await saveAllSheets(all);
      state.sheets=await getAllSheets();
    }
  };

  await executeTransfer({
    state,
    sourceSheet,
    rows,
    tpl,
    subMode,
    subIndexes,
    pickedDest: ctx.pickedDest || null,
    deps:{
      alert:(msg)=>alert(msg),
      onNeedEnableSubrows,
      allowSubrows,
      pickOrCreateCase,
      appendCaseRow,
      onDone:()=>{ render(); }
    }
  });
}


function computeMappedRow(target,row,subIndex){
  const evalExpr=(expr)=>{
    const field=(col,from)=>{ if(from==="sub"){ const sr=(row.subrows||[])[subIndex]||{}; return sr[col]??""; } return row.data?.[col]??""; };
    if(expr.op==="field") return String(field(expr.col, expr.from||"data"));
    if(expr.op==="concat"){ const j=expr.joiner??" "; return (expr.parts||[]).map(evalExpr).filter(v=>v!=="").join(j); }
    if(expr.op==="sum"){ let sum=0; for(const p of (expr.parts||[])){ const n=parseInt(String(evalExpr(p)).trim(),10); if(!Number.isNaN(n)) sum+=n; } return String(sum); }
    return "";
  };
  const mapped={};
  for(const m of target.map||[]) mapped[m.destCol]=evalExpr(m.expr);
  return mapped;
}
async function pickOrCreateCase(){
  const cases=await getAllCases();
  const list=cases.map((c,i)=>`${i+1}) ${c.caseIndex||"(без індексу)"} — ${c.caseTitle||"(без заголовка)"}`).join("\n");
  const v=prompt(`Виберіть справу (номер) або введіть індекс вручну.\n\nІснуючі:\n${list}`,"");
  if(v===null) return null;
  const t=v.trim(); if(!t) return null;
  const n=parseInt(t,10);
  if(!Number.isNaN(n)&&n>=1&&n<=cases.length) return cases[n-1].id;
  const index=t;
  const existing=cases.find(c=>String(c.caseIndex||"").trim()===index);
  if(existing) return existing.id;
  const title=prompt("Заголовок справи (необовʼязково):",""); if(title===null) return null;
  const id=await addCase({caseIndex:index, caseTitle:String(title||"").trim(), createdAt:new Date().toISOString(), createdFrom:"manual"});
  return id;
}
async function appendCaseRow(caseId,mapped){
  const rows=await getCaseRows(caseId);
  let max=0; for(const r of rows){ const v=parseInt(r["№ з/п"]??0,10); if(!Number.isNaN(v)&&v>max) max=v; }
  await addCaseRow(caseId,{...mapped,"№ з/п":String(max+1)});
}
async function exportCurrentFlow(){
  // Determine export profile for current sheet
  const getExportProfileForSheet = (sheetKey)=>{
    const cfg = state.sheetSettings[sheetKey] || {};
    return cfg.export || {pageSize:"A4",orientation:"portrait",exportHiddenCols:[],rowFilters:[]};
  };

  if(state.mode==="case" && state.caseId){
    const cases=await getAllCases();
    const c=cases.find(x=>x.id===state.caseId) || {id:state.caseId, caseIndex:"", caseTitle:""};
    const rows=await getCaseRows(state.caseId);
    rows.sort((a,b)=>parseInt(a["№ з/п"]??0,10)-parseInt(b["№ з/п"]??0,10));

    const op=await modalOpen({
      title:"Експорт поточного (опис справи)",
      bodyNodes:[el("div",{className:"muted",textContent:`${c.caseIndex||""} — ${c.caseTitle||""}`})],
      actions:[
        btn("Скасувати","cancel","btn"),
        btn("JSON","json","btn btn-primary"),
        btn("DOCX","docx","btn btn-primary"),
        btn("XLSX","xlsx","btn btn-primary"),
        btn("PDF","pdf","btn btn-primary"),
      ]
    });
    if(op.type==="cancel") return;

    const stamp=nowStamp();
    if(op.type==="json"){
      const payload={meta:{type:"case_description",exportedAt:new Date().toISOString(),case:c},rows};
      downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}), makeCaseExportFileName(c.caseIndex,c.caseTitle,stamp));
      return;
    }

    const cols=CASE_DESC_COLUMNS.map(x=>x.name);
    const flatRows = rows.map(r=>{
      const o={}; cols.forEach(k=>o[k]=r[k]??""); return o;
    });

    const title = "Внутрішній опис справи";
    const subtitle = `Справа: ${c.caseIndex||""} — ${c.caseTitle||""}\nЕкспорт: ${new Date().toLocaleString()}`;
    const filenameBase = `Opis_spravy_${c.caseIndex||""}_${c.caseTitle||""}`;

    if(op.type==="docx"){
      exportDOCXTable({title, subtitle, columns:cols, rows:flatRows, filenameBase});
      return;
    }
    if(op.type==="xlsx"){
      exportXLSXTable({title, columns:cols, rows:flatRows, filenameBase});
      return;
    }
    if(op.type==="pdf"){
      exportPDFTable({title, subtitle, columns:cols, rows:flatRows, filenameBase, pageSize:"A4", orientation:"portrait"});
      return;
    }
    return;
  }

  const sheet=currentSheet(); 
  const rows=await getRows(curDataKey());

  // columns to export: visible-for-export = (not exportHiddenCols)
  const viewVisible=visibleColumns(sheet);
  const exportProfile = getExportProfileForSheet(sheet.key);
  const exportHidden = new Set(exportProfile.exportHiddenCols || []);
  const exportCols = sheet.columns.map(c=>c.name).filter(n=>!exportHidden.has(n));

  const op=await modalOpen({
    title:"Експорт поточного листа",
    bodyNodes:[
      el("div",{className:"muted",textContent:sheet.title}),
      el("div",{className:"muted",textContent:`Профіль: ${exportProfile.pageSize||"A4"} / ${exportProfile.orientation||"portrait"}; колонки (експорт): ${exportCols.length}`})
    ],
    actions:[
      btn("Скасувати","cancel","btn"),
      btn("JSON","json","btn btn-primary"),
      btn("DOCX","docx","btn btn-primary"),
      btn("XLSX","xlsx","btn btn-primary"),
      btn("PDF","pdf","btn btn-primary"),
    ]
  });
  if(op.type==="cancel") return;

  if(op.type==="json") return exportJournalAsJSON({sheet, rows, sheetExportProfile:exportProfile, visibleColumnsForView:viewVisible});
  if(op.type==="docx") return exportJournalAsDOCX({sheet, rows, columns:exportCols, sheetExportProfile:exportProfile});
  if(op.type==="xlsx") return exportJournalAsXLSX({sheet, rows, columns:exportCols, sheetExportProfile:exportProfile});
  if(op.type==="pdf")  return exportJournalAsPDF({sheet, rows, columns:exportCols, sheetExportProfile:exportProfile});
}
async function exportAllFlow(){
  // Full backup ZIP: includes spaces + journal trees + all journals data +
  // all settings (cfg keys) + transfer rules/templates + simplified templates
  // (stored in user_sheets) + human-friendly DOCX/XLSX (PDF excluded).
  const stamp = nowStamp();
  const sheets = state.sheets;

  // cfg dump (everything registered in backup manifest)
  const cfgDump = {};
  try{
    const man = await cfgGetBackupManifest();
    const keysObj = (man && typeof man === "object" && man.keys && typeof man.keys === "object") ? man.keys : {};
    const keys = Object.keys(keysObj);
    for(const k of keys){
      if(k === "__backup_manifest_v1") continue;
      try{ cfgDump[k] = await cfgGet(k); }catch(_e){}
    }
  }catch(_e){}

  // spaces + journal trees
  const spaces = await ensureSpaces();
  const journalTreesBySpaceId = {};
  for(const sp of (spaces||[])){
    const tree = await ensureJournalTree(sp.id, sheets);
    journalTreesBySpaceId[sp.id] = tree;
  }

  // rows by dataKey (spaceId::journalInstanceId)
  const rowsByDataKey = new Map();
  for(const sp of (spaces||[])){
    const tree = journalTreesBySpaceId[sp.id];
    const nodeIds = tree && tree.nodes ? Object.keys(tree.nodes) : [];
    for(const nodeId of nodeIds){
      const dataKey = `${sp.id}::${nodeId}`;
      rowsByDataKey.set(dataKey, await getRows(dataKey));
    }
  }

  // cases
  const cases = await getAllCases();
  const caseRowsByCaseId = new Map();
  for (const c of cases) {
    caseRowsByCaseId.set(c.id, await getCaseRows(c.id));
  }

  await exportFullBackupZipAllFormats({
    stamp,
    spaces,
    journalTreesBySpaceId,
    sheets,
    rowsByDataKey,
    cfgDump,
    cases,
    caseRowsByCaseId,
  });
}

async function importJsonFile(input){
  const file=input.files && input.files[0]; if(!file) return;
  const text=await file.text();
  try{
    const parsed=JSON.parse(text);
    await importJsonWizard(parsed);
  }catch(e){
    alert("Помилка імпорту JSON: "+e.message);
  }finally{
    input.value="";
    render();
  }
}
async function importZipFile(input){
  const file=input.files && input.files[0]; if(!file) return;
  const buf=await file.arrayBuffer();
  let entriesAll;
  try{ entriesAll=unzipStoreEntries(buf); }
  catch(e){ alert("Не вдалося прочитати ZIP: "+e.message); input.value=""; return; }

  const jsonEntries = entriesAll.filter(x=>x.name.toLowerCase().endsWith(".json"));
  if(!jsonEntries.length){ alert("У ZIP немає JSON."); input.value=""; return; }

  // Detect fullbackup archive (manifest.json with meta.type=fullbackup_manifest)
  let isFullBackup = false;
  try{
    const manEnt = jsonEntries.find(e=>e.name.toLowerCase().endsWith("manifest.json")) || null;
    if(manEnt){
      const man = JSON.parse(new TextDecoder().decode(manEnt.data));
      if(man && man.meta && man.meta.type === "fullbackup_manifest") isFullBackup = true;
    }
  }catch(_e){}

  if(isFullBackup){
    const ok = confirm(`Full backup ZIP: знайдено ${jsonEntries.length} JSON файлів.\n\nІмпорт відновлює структуру, журнали і налаштування.\nДеякі елементи можуть не імпортуватися (буде звіт).\n\nПродовжити?`);
    if(!ok){ input.value=""; return; }
    await importFullBackupZipFromEntries(jsonEntries);
    input.value="";
    render();
    return;
  }

  // Legacy ZIP import (journals/cases JSON only) — keep behavior.
  const ok=confirm(`Знайдено ${jsonEntries.length} JSON файлів.\n\nІмпорт замінить поточні дані.\nПродовжити?`);
  if(!ok){ input.value=""; return; }
  await clearAllRows(); await clearAllCasesAndRows();
  for(const ent of jsonEntries){
    try{ const parsed=JSON.parse(new TextDecoder().decode(ent.data)); await importPayload(parsed,true); }
    catch(e){ console.warn("ZIP import fail",ent.name,e); }
  }
  input.value=""; alert("Імпорт ZIP завершено."); render();
}

async function importFullBackupZipFromEntries(jsonEntries){
  const report = {
    meta:{ type:"fullbackup_import_report", startedAt:new Date().toISOString() },
    notes:[],
    missing:[],
    applied:{ cfg:0, journals:0, cases:0 },
    errors:[],
  };

  // Parse all json safely
  const parsedFiles = [];
  for(const ent of jsonEntries){
    try{
      const parsed = JSON.parse(new TextDecoder().decode(ent.data));
      parsedFiles.push({ name: ent.name, parsed });
    }catch(e){ report.errors.push({file:ent.name, error:String(e.message||e)}); }
  }

  // Stage buckets
  const cfgFiles = [];
  const journalTreeFiles = [];
  const journalFiles = [];
  const caseFiles = [];
  let cfgDumpFile = null;

  for(const f of parsedFiles){
    const t = f.parsed?.meta?.type || "";
    if(t === "cfg") cfgFiles.push(f);
    else if(t === "journal_trees") journalTreeFiles.push(f);
    else if(t === "cfg_dump") cfgDumpFile = f;
    else if(t === "journal") journalFiles.push(f);
    else if(t === "case_description") caseFiles.push(f);
  }

  // Confirm & clear DB first (full restore)
  await clearAllRows();
  await clearAllCasesAndRows();

  // 1) Apply spaces + journal trees first
  try{
    const spacesCfg = cfgFiles.find(x=>x.parsed?.meta?.key === "spaces_v1") || null;
    if(spacesCfg){
      await cfgSet("spaces_v1", spacesCfg.parsed.value);
      report.applied.cfg++;
    } else if(cfgDumpFile && cfgDumpFile.parsed?.cfg && cfgDumpFile.parsed.cfg.spaces_v1){
      await cfgSet("spaces_v1", cfgDumpFile.parsed.cfg.spaces_v1);
      report.applied.cfg++;
    } else {
      report.missing.push({stage:"spaces", what:"spaces_v1"});
    }
  }catch(e){ report.errors.push({stage:"spaces", error:String(e.message||e)}); }

  // Refresh spaces list for import validations
  let importedSpaces = [];
  try{ importedSpaces = await ensureSpaces(); }catch(_e){}
  const spaceIdSet = new Set((importedSpaces||[]).map(s=>s.id));

  // Journal trees: either single file journal_trees.json or per-space cfg files
  try{
    if(journalTreeFiles.length){
      for(const jt of journalTreeFiles){
        const trees = jt.parsed?.trees || {};
        for(const [spaceId, tree] of Object.entries(trees)){
          if(spaceIdSet.size && !spaceIdSet.has(spaceId)){
            report.missing.push({stage:"journal_trees", what:"space", spaceId});
            continue;
          }
          await cfgSet(`journal_tree_v1:${spaceId}`, tree);
          report.applied.cfg++;
        }
      }
    }
    // per-space cfg trees
    for(const f of cfgFiles){
      const key = f.parsed?.meta?.key || "";
      if(key.startsWith("journal_tree_v1:")){
        const spaceId = key.split(":")[1] || "";
        if(spaceIdSet.size && !spaceIdSet.has(spaceId)){
          report.missing.push({stage:"journal_trees", what:"space", spaceId});
          continue;
        }
        await cfgSet(key, f.parsed.value);
        report.applied.cfg++;
      }
    }
  }catch(e){ report.errors.push({stage:"journal_trees", error:String(e.message||e)}); }

  // 2) Apply cfg dump (all settings). This enables templates, simplified view, transfer rules, etc.
  try{
    const cfg = cfgDumpFile?.parsed?.cfg || null;
    if(cfg && typeof cfg === "object"){
      for(const [k,v] of Object.entries(cfg)){
        if(k === "__backup_manifest_v1") continue;
        // spaces/journal trees already applied above, but re-applying is ok.
        await cfgSet(k, v);
        report.applied.cfg++;
      }
    }
  }catch(e){ report.errors.push({stage:"cfg", error:String(e.message||e)}); }

  // Reload config to have sheets in memory
  try{ await loadConfig(); }catch(_e){}

  // Ensure spaces & trees after templates import
  try{
    state.spaces = await ensureSpaces();
    if(!state.spaceId && state.spaces && state.spaces[0]) state.spaceId = state.spaces[0].id;
  }catch(_e){}

  // 3) Import journal data (spaceId::instanceId)
  try{
    const knownSpaceIds = new Set((await ensureSpaces()).map(s=>s.id));
    for(const jf of journalFiles){
      const restore = jf.parsed?.meta?.restore || null;
      const spaceId = restore?.spaceId || "";
      const instanceId = restore?.instanceId || "";
      const sheetKey = restore?.sheetKey || jf.parsed?.meta?.key || null;
      if(spaceId && !knownSpaceIds.has(spaceId)){
        report.missing.push({stage:"journals", what:"space", spaceId, file:jf.name});
        continue;
      }
      if(!sheetKey){
        report.missing.push({stage:"journals", what:"sheetKey", file:jf.name});
        continue;
      }
      const sheet = state.sheets.find(s=>s.key===sheetKey) || null;
      if(!sheet){
        report.missing.push({stage:"journals", what:"sheetSchema", sheetKey, file:jf.name});
        continue;
      }
      const journalKey = `${spaceId}::${instanceId}`;
      const colNames = (sheet.columns||[]).map(c=>c.name);
      if(Array.isArray(jf.parsed?.rowsV2)){
        for(const r of jf.parsed.rowsV2){
          const cells = Array.isArray(r.cells)?r.cells:[];
          const data = {};
          for(let i=0;i<colNames.length;i++) data[colNames[i]] = String(cells[i] ?? "");
          await addRow(journalKey, { data, subrows: r.subrows || [] });
        }
        report.applied.journals++;
      }
    }
  }catch(e){ report.errors.push({stage:"journals", error:String(e.message||e)}); }

  // 4) Cases
  try{
    for(const cf of caseFiles){
      try{ await importPayload(cf.parsed); report.applied.cases++; }
      catch(e){ report.errors.push({stage:"cases", file:cf.name, error:String(e.message||e)}); }
    }
  }catch(e){ report.errors.push({stage:"cases", error:String(e.message||e)}); }

  report.meta.finishedAt = new Date().toISOString();
  // Offer report download for auditing completeness
  try{
    const blob = new Blob([JSON.stringify(report, null, 2)], {type:"application/json"});
    downloadBlob(blob, `import_report_${nowStamp()}.json`);
  }catch(_e){}

  alert(`Full backup імпорт завершено.\n\nНалаштування ключів: ${report.applied.cfg}\nЖурнали імпортовано: ${report.applied.journals}\nОписів справ: ${report.applied.cases}\n\nЗвіт імпорту збережено окремим JSON.`);
}

function colLettersToIndex(ref){
  // e.g. "A1" -> 1, "AA10" -> 27
  const m=/^([A-Z]+)\d+$/.exec(ref||"");
  if(!m) return null;
  const s=m[1];
  let n=0;
  for(let i=0;i<s.length;i++){ n = n*26 + (s.charCodeAt(i)-64); }
  return n;
}
function getCellTextFromXml(cellEl, sharedStrings){
  if(!cellEl) return "";
  const t = cellEl.getAttribute("t") || "";
  if(t==="inlineStr"){
    const tEl=cellEl.getElementsByTagName("t")[0];
    return tEl ? (tEl.textContent||"") : "";
  }
  const vEl=cellEl.getElementsByTagName("v")[0];
  const v = vEl ? (vEl.textContent||"") : "";
  if(t==="s"){
    const idx=parseInt(v,10);
    return Number.isFinite(idx) && sharedStrings[idx]!=null ? sharedStrings[idx] : "";
  }
  return v;
}
function parseSharedStringsXml(xmlText){
  const out=[];
  try{
    const doc=new DOMParser().parseFromString(xmlText,"application/xml");
    const si = Array.from(doc.getElementsByTagName("si"));
    for(const node of si){
      // shared string may be rich text; concatenate all <t>
      const ts = Array.from(node.getElementsByTagName("t"));
      out.push(ts.map(x=>x.textContent||"").join(""));
    }
  }catch(_e){}
  return out;
}

async function importXlsxFile(input){
  const file=input.files && input.files[0];
  if(!file) return;
  const sheet=currentSheet();
  if(!sheet){ input.value=""; return; }

  const op=await modalOpen({
    title:"Імпорт XLSX у поточний лист",
    bodyNodes:[
      el("div",{className:"muted",textContent:`Лист: ${sheet.title}`}),
      el("div",{className:"muted",textContent:"Файл має починатися з даних (без заголовків). Колонки — в тому ж порядку, що і в журналі."}),
    ],
    actions:[
      btn("Скасувати","cancel","btn"),
      btn("Додати рядки","append","btn btn-primary"),
      btn("Замінити дані","replace","btn btn-primary"),
    ]
  });
  if(op.type==="cancel"){ input.value=""; return; }

  try{
    const buf=await file.arrayBuffer();
    const entries=await unzipEntries(buf);
    const findEntry=(name)=>entries.find(e=>e.name===name);
    const sheetEntry = findEntry("xl/worksheets/sheet1.xml") || entries.find(e=>e.name.startsWith("xl/worksheets/") && e.name.endsWith(".xml"));
    if(!sheetEntry) throw new Error("XLSX: не знайдено xl/worksheets/sheet1.xml");

    const ssEntry = findEntry("xl/sharedStrings.xml");
    const sharedStrings = ssEntry ? parseSharedStringsXml(new TextDecoder().decode(ssEntry.data)) : [];

    const sheetXml = new TextDecoder().decode(sheetEntry.data);
    const doc=new DOMParser().parseFromString(sheetXml,"application/xml");
    const rows = Array.from(doc.getElementsByTagName("row"));
    const colDefs = sheet.columns;

    if(op.type==="replace"){
      const ok=confirm(`Замінити ВСІ дані листа «${sheet.title}» імпортом з Excel?`);
      if(!ok){ input.value=""; return; }
      await clearRows(curDataKey());
    }

    const existing = await getRows(curDataKey());
    const orderCol = sheet.orderColumn;
    let nextNum = orderCol ? nextOrder(existing, orderCol) : null;

    // Build a simple matrix: row -> array of strings by column index (1-based in XLSX)
    const matrix=[];
    let maxCol=0;
    for(const rEl of rows){
      const cells = Array.from(rEl.getElementsByTagName("c"));
      if(!cells.length) continue;
      const byIndex = new Map();
      for(const cEl of cells){
        const ref=cEl.getAttribute("r")||"";
        const idx=colLettersToIndex(ref);
        if(!idx) continue;
        byIndex.set(idx, cEl);
        if(idx>maxCol) maxCol=idx;
      }
      if(!maxCol) continue;
      const arr=[];
      for(let ci=1; ci<=maxCol; ci++){
        const cellEl = byIndex.get(ci);
        let val = getCellTextFromXml(cellEl, sharedStrings);
        arr.push(String(val??"").trim());
      }
      matrix.push({ r: rEl.getAttribute("r")||"?", cells: arr });
    }

    const targetColumns = Array.isArray(colDefs) ? colDefs : [];
    const targetCols = targetColumns.length;
    const sourceCols = maxCol;

    // Detect header row very conservatively (only if it looks like column names)
    let headerDetected=false;
    let sourceColumns=[];
    if(matrix.length){
      const first = matrix[0].cells || [];
      const nonEmpty = first.filter(x=>String(x||"").trim()!=="");
      if(nonEmpty.length>=2){
        let match=0;
        for(const v of nonEmpty){
          const vv=String(v||"").trim();
          for(const tc of targetColumns){
            if(String(tc?.name||"").trim()===vv){ match++; break; }
          }
        }
        const ratio = match / Math.max(1, nonEmpty.length);
        // be very conservative: header is assumed only when it strongly looks like column names
        if(match>=3 && ratio>=0.7){
          headerDetected=true;
          sourceColumns = first.map(function(v,idx){ return { name: String(v||("Колонка "+(idx+1))).trim() || ("Колонка "+(idx+1)) }; });
        }
      }
    }
    if(!sourceColumns.length){
      for(let i=0;i<sourceCols;i++) sourceColumns.push({name:"Колонка "+(i+1)});
    }

    // If mismatch, ask whether to proceed and allow mapping for XLSX as well
    let mapping = null;
    if(sourceCols !== targetCols){
      const ask = await modalOpen({
        title:"Невідповідність колонок",
        bodyNodes:[
          el("div",{textContent:`У журналі ${targetCols} колонок, у файлі ${sourceCols} колонок.`}),
          el("div",{className:"muted",textContent:"Чи провести імпорт? Якщо так — оберіть відповідність колонок."})
        ],
        actions:[ btn("Ні","no","btn"), btn("Так","yes","btn btn-primary") ]
      });
      if(ask.type!=="yes"){ input.value=""; return; }

      const mapUi = buildMappingUI({ targetColumns: targetColumns, sourceColumns: sourceColumns, sourceCols: sourceCols });
      const step = await modalOpen({
        title:"Зіставлення колонок",
        bodyNodes:[ mapUi.node ],
        actions:[ btn("Скасувати","cancel","btn"), btn("Імпортувати","do","btn btn-primary") ]
      });
      if(step.type!=="do"){ input.value=""; return; }
      mapping = mapUi.getMapping();
    } else {
      // identity mapping
      mapping = targetColumns.map(function(_c, idx){ return idx+1; });
    }

    // Apply import
    let imported=0;
    const errors=[];
    const startIndex = headerDetected ? 1 : 0;
    for(let ri=startIndex; ri<matrix.length; ri++){
      const rowObj = matrix[ri];
      const rCells = rowObj.cells || [];
      if(!rCells.length) continue;

      const data={};
      let any=false;
      for(let ci=0; ci<colDefs.length; ci++){
        const def=colDefs[ci];
        const srcColNum = parseInt(mapping[ci]||0,10);
        const srcIdx = srcColNum ? (srcColNum-1) : -1;
        let val = (srcIdx>=0 && srcIdx<rCells.length) ? String(rCells[srcIdx]??"") : "";
        val = String(val??"").trim();

        if(def.type==="int"){
          if(val===""){
            // ok
          } else if(/^\d+$/.test(val)){
            // ok
          } else if(/^\d+(?:\.0+)?$/.test(val)){
            // Excel numeric like 12.0
            val = String(parseInt(val,10));
          } else {
            errors.push(`Рядок ${rowObj.r||"?"}: поле «${def.name}» має бути числом`);
            val = "";
          }
        }

        if(def.type==="date"){
          if(val===""){
            // ok
          } else {
            const p=parseUAdate(val);
            if(p) val=p;
            else {
              // try excel serial
              const serial = Number(val);
              const ex = excelSerialToUAdate(serial);
              if(ex) val=ex;
              else {
                errors.push(`Рядок ${rowObj.r||"?"}: поле «${def.name}» має дату ДД.ММ.РРРР`);
                val="";
              }
            }
          }
        }

        if(val!=="") any=true;
        data[def.name]=val;
      }
      if(!any) continue;

      if(orderCol && (!data[orderCol] || !/^\d+$/.test(String(data[orderCol]).trim()))){
        data[orderCol] = String(nextNum++);
      }

      await addRow(curDataKey(),{data, subrows:[]});
      imported++;
    }
    input.value="";
    render();
    const msg = `Імпорт XLSX завершено. Додано рядків: ${imported}.`;
    if(errors.length){
      alert(msg + "\n\nПопередження (перші 5):\n" + errors.slice(0,5).join("\n"));
    } else {
      alert(msg);
    }
  }catch(e){
    console.error(e);
    alert("Помилка імпорту XLSX: " + e.message);
    input.value="";
  }
}

// ------------------------
// JSON import wizard (column-index mapping)

function journalSourceFromParsed(parsed){
  const metaTitle = parsed?.meta?.title || parsed?.sheet?.title || "";
  const sourceSheet = parsed?.sheet || null;
  // v2 preferred
  if(Array.isArray(parsed?.rowsV2)){
    const rows = parsed.rowsV2.map(r=>({ cells: Array.isArray(r.cells)?r.cells:[], subrows:r.subrows||[] }));
    const colsCount = Number.isFinite(parsed.columnsCount) ? parsed.columnsCount : Math.max(0, ...rows.map(x=>x.cells.length));
    const sourceCols = Math.max(colsCount, Math.max(0,...rows.map(x=>x.cells.length)));
    return { title: metaTitle, key: parsed?.meta?.key||"", sourceSheet, sourceCols, rows };
  }

  // legacy: rows with data/exportData objects
  const colNames = Array.isArray(sourceSheet?.columns) ? sourceSheet.columns.map(c=>c.name) : [];
  const legacyRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const rows = legacyRows.map(r=>{
    const obj = r.exportData || r.data || {};
    const cells = colNames.map(n=>String(obj?.[n] ?? ""));
    return { cells, subrows: r.subrows||[] };
  });
  const sourceCols = colNames.length || Math.max(0,...rows.map(x=>x.cells.length));
  return { title: metaTitle, key: parsed?.meta?.key||"", sourceSheet, sourceCols, rows };
}

function buildMappingUI(opts){
  // opts: { targetColumns:[{name}], sourceColumns:[{name}], sourceCols:number }
  const targetColumns = Array.isArray(opts && opts.targetColumns) ? opts.targetColumns : [];
  const sourceColumns = Array.isArray(opts && opts.sourceColumns) ? opts.sourceColumns : [];
  const sourceCols = Number.isFinite(opts && opts.sourceCols) ? opts.sourceCols : (sourceColumns.length||0);
  const wrap = el("div",{className:"import-map import-map--big"});
  const info = el("div",{className:"muted",textContent:`В журналі ${targetColumns.length} колонок. В імпорті ${sourceCols} колонок.`});
  wrap.appendChild(info);

  const grid = el("div",{className:"import-map-grid"});
  const selects = [];
  const under = [];

  for(let i=0;i<targetColumns.length;i++){
    const tcol = targetColumns[i];
    const card = el("div",{className:"import-map-card"});
    // над віконцем: назва колонки існуючого журналу
    card.appendChild(el("div",{className:"import-map-top",textContent: String(tcol && tcol.name ? tcol.name : ("Колонка " + (i+1)))}));

    const sel = el("select",{className:"input import-map-select"});
    sel.appendChild(el("option",{value:"0",textContent:"(пропустити)"}));
    for(let si=1; si<=sourceCols; si++){
      const sname = (sourceColumns[si-1] && sourceColumns[si-1].name) ? sourceColumns[si-1].name : ("Колонка " + si);
      sel.appendChild(el("option",{value:String(si), textContent: `${si}. ${sname}`}));
    }
    // default mapping: same index if possible
    sel.value = String(Math.min(i+1, sourceCols||0));
    card.appendChild(sel);

    // під віконцем: назва колонки імпорту
    const lbl = el("div",{className:"import-map-bottom",textContent:""});
    under.push(lbl);
    card.appendChild(lbl);

    selects.push(sel);
    grid.appendChild(card);
  }

  function refreshUnder(){
    for(let i=0;i<selects.length;i++){
      const v = parseInt(selects[i].value,10);
      if(!v){ under[i].textContent = "(пропущено)"; continue; }
      const sname = (sourceColumns[v-1] && sourceColumns[v-1].name) ? sourceColumns[v-1].name : ("Колонка " + v);
      under[i].textContent = sname;
    }
  }
  for(const s of selects){ s.onchange = refreshUnder; }
  refreshUnder();

  wrap.appendChild(grid);
  wrap.appendChild(el("div",{className:"muted",textContent:"Над списком — колонка журналу. Під списком — обрана колонка з файлу. 0 = пропустити."}));

  const getMapping = function(){
    const out=[];
    for(let i=0;i<selects.length;i++){
      const v = parseInt(selects[i].value,10);
      out.push(Number.isFinite(v) ? v : 0);
    }
    return out;
  };
  return { node: wrap, getMapping: getMapping };
}

async function importJsonWizard(parsed){
  // Optional: full import bundle (single JSON containing multiple journals)
  if(Array.isArray(parsed?.journals)){
    const pre = await modalOpen({
      title:"Майстер повного імпорту JSON",
      bodyNodes:[
        el("div",{className:"muted",textContent:`Журналів у файлі: ${parsed.journals.length}`}),
        el("div",{className:"muted",textContent:"Імпорт виконується по черзі для кожного журналу."})
      ],
      actions:[
        btn("Скасувати","cancel","btn"),
        btn("Додати","append","btn btn-primary"),
        btn("Замінити","replace","btn btn-danger"),
      ]
    });
    if(pre.type==="cancel") return;
    const replace = (pre.type==="replace");
    // cases (if any) - import after journals
    for(const j of parsed.journals){
      // reuse single-journal wizard but force mode
      if(replace){
        // only clear once per target sheet inside applyJournalImport
      }
      await importJsonWizard({ ...j, __bundleMode:true, __bundleReplace:replace });
    }
    if(Array.isArray(parsed?.cases)){
      for(const c of parsed.cases){ await importPayload(c); }
    }
    return;
  }
  // case descriptions: keep as-is
  if(parsed?.meta?.type==="case_description"){
    await importPayload(parsed);
    alert("Імпорт JSON завершено.");
    return;
  }

  if(parsed?.meta?.type!=="journal"){
    throw new Error("Невідомий формат JSON (очікується journal або case_description).")
  }

  const source = journalSourceFromParsed(parsed);
  const targetDefault = (state.mode==="sheet") ? currentSheet() : state.sheets[0];
  if(!targetDefault) throw new Error("Немає доступних листів для імпорту.");

  // choose target sheet
  const sel = el("select",{className:"input"});
  for(const sh of state.sheets){
    const opt = el("option",{value:sh.key,textContent:`${sh.title} (${sh.key})`});
    if(sh.key===targetDefault.key) opt.selected=true;
    sel.appendChild(opt);
  }

  let preType = "append";
  if(parsed?.__bundleMode){
    preType = parsed.__bundleReplace ? "replace" : "append";
  } else {
    const pre = await modalOpen({
      title:"Майстер імпорту JSON",
      bodyNodes:[
        el("div",{className:"muted",textContent:`Файл: ${source.title || "(без назви)"}`}),
        el("div",{textContent:"Оберіть лист, в який імпортувати:"}),
        sel,
      ],
      actions:[
        btn("Скасувати","cancel","btn"),
        btn("Додати","append","btn btn-primary"),
        btn("Замінити","replace","btn btn-danger"),
      ]
    });
    if(pre.type==="cancel") return;
    preType = pre.type;
  }

  const targetSheet = state.sheets.find(s=>s.key===sel.value) || targetDefault;

  // sheet title mismatch warning
  if(source.title && targetSheet.title && source.title !== targetSheet.title){
    const ok = await modalOpen({
      title:"Попередження",
      bodyNodes:[
        el("div",{textContent:`Назва листа в СЕДО: «${targetSheet.title}»`} ),
        el("div",{textContent:`Назва листа в JSON: «${source.title}»`} ),
        el("div",{className:"muted",textContent:"Назви відрізняються. Продовжити імпорт?"})
      ],
      actions:[ btn("Скасувати","cancel","btn"), btn("Продовжити","go","btn btn-primary") ]
    });
    if(ok.type!=="go") return;
  }

  const targetCols = (targetSheet.columns||[]).length;
  const sourceCols = Math.max(0, source.sourceCols||0);

  // Only ask for mapping when there is a mismatch (as requested). Otherwise use identity mapping.
  let mapping = null;
  if(sourceCols !== targetCols){
    const ask = await modalOpen({
      title:"Невідповідність колонок",
      bodyNodes:[
        el("div",{textContent:`У журналі ${targetCols} колонок, у файлі ${sourceCols} колонок.`}),
        el("div",{className:"muted",textContent:"Чи провести імпорт? Якщо так — оберіть відповідність колонок."})
      ],
      actions:[ btn("Ні","no","btn"), btn("Так","yes","btn btn-primary") ]
    });
    if(ask.type!=="yes") return;

    const sourceColumns = Array.isArray(source.sourceSheet?.columns) ? source.sourceSheet.columns : [];
    const mapUi = buildMappingUI({ targetColumns: (targetSheet.columns||[]), sourceColumns: sourceColumns, sourceCols: sourceCols });
    const step = await modalOpen({
      title:"Зіставлення колонок",
      bodyNodes:[ mapUi.node ],
      actions:[ btn("Скасувати","cancel","btn"), btn("Імпортувати","do","btn btn-primary") ]
    });
    if(step.type!=="do") return;
    mapping = mapUi.getMapping();
  } else {
    mapping = (targetSheet.columns||[]).map(function(_c, idx){ return idx+1; });
  }

  const replace = (preType==="replace");
  await applyJournalImport({targetSheet, source, mapping, replace});
  if(!parsed?.__bundleMode) alert("Імпорт JSON завершено.");
}

function normalizeDateToDDMMYY(s){
  const t = String(s||"").trim();
  if(!t) return "";
  // dd.mm.yy or dd.mm.yyyy
  let m = /^([0-3]\d)\.([01]\d)\.(\d{2}|\d{4})$/.exec(t);
  if(m){
    const dd=m[1], mm=m[2];
    const yy = m[3].length===4 ? m[3].slice(-2) : m[3];
    return `${dd}.${mm}.${yy}`;
  }
  // yyyy-mm-dd
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if(m){
    return `${m[3]}.${m[2]}.${m[1].slice(-2)}`;
  }
  return t;
}

async function applyJournalImport({targetSheet, source, mapping, replace}){
  if(replace){
    await clearRows(journalKeyForSheet(state.spaceId, targetSheet.key));
  }
  const cols = targetSheet.columns||[];
  const errors=[];
  let imported=0;
  // determine next auto-number if needed
  let nextNum=null;
  const orderCol = targetSheet.orderColumn;
  if(orderCol){
    const existing = await getRows(journalKeyForSheet(state.spaceId, targetSheet.key));
    let max=0;
    for(const r of existing){
      const v=parseInt(r?.data?.[orderCol]||"",10);
      if(Number.isFinite(v)) max=Math.max(max,v);
    }
    nextNum=max+1;
  }

  for(let i=0;i<source.rows.length;i++){
    const srcRow = source.rows[i];
    const cells = Array.isArray(srcRow.cells) ? srcRow.cells : [];
    const data={};
    for(let tIdx=0;tIdx<cols.length;tIdx++){
      const col = cols[tIdx];
      const srcColNum = parseInt(mapping[tIdx]||0,10);
      const srcIdx = srcColNum ? (srcColNum-1) : -1;
      let v = (srcIdx>=0 && srcIdx<cells.length) ? String(cells[srcIdx] ?? "") : "";
      if(col.type==="date") v = normalizeDateToDDMMYY(v);
      // basic int sanitize
      if(col.type==="int"){
        v = String(v||"").trim();
        if(v!=="" && !/^\d+$/.test(v)){
          errors.push(`Рядок ${i+1}, колонка ${tIdx+1}: очікується число`);
          v = "";
        }
      }
      data[col.name]=v;
    }
    // auto-fill order column if empty
    if(orderCol && (!data[orderCol] || String(data[orderCol]).trim()==="") && nextNum!=null){
      data[orderCol]=String(nextNum++);
    }
    await addRow(journalKeyForSheet(state.spaceId, targetSheet.key),{data, subrows: srcRow.subrows||[]});
    imported++;
  }
  if(errors.length){
    alert(`Імпорт завершено. Додано: ${imported}.\n\nПопередження (перші 10):\n`+errors.slice(0,10).join("\n"));
  }
  render();
}
async function importPayload(parsed){
  if(parsed?.meta?.type==="journal"){
    const key=parsed.meta.key;
    let sheet=state.sheets.find(s=>s.key===key);
    if(!sheet){
      const sh=parsed.sheet;
      const custom={key,title:parsed.meta.title||sh?.title||key,orderColumn:sh?.orderColumn||null,columns:sh?.columns||[],addFields:sh?.addFields||(sh?.columns||[]).map(c=>c.name),subrows:sh?.subrows||null,export:sh?.export||{pageSize:"A4",orientation:"portrait"}};
      state.sheets.push(custom);
      await saveUserSheets(state.sheets.filter(s=>isCustomKey(s.key)));
      await loadConfig();
    }
    // v2: rowsV2 (cells array) preferred
    if(Array.isArray(parsed.rowsV2)){
      const colNames = (sheet?.columns||[]).map(c=>c.name);
      for(const r of parsed.rowsV2){
        const cells = Array.isArray(r.cells)?r.cells:[];
        const data={};
        for(let i=0;i<colNames.length;i++) data[colNames[i]] = String(cells[i] ?? "");
        await addRow(key,{data, subrows:r.subrows||[]});
      }
    } else if(Array.isArray(parsed.rows)){
      for(const r of parsed.rows){
        await addRow(key,{data:r.data||{}, subrows:r.subrows||[]});
      }
    }
    return;
  }
  if(parsed?.meta?.type==="case_description"){
    const c=parsed.meta.case||{};
    const id=await addCase({caseIndex:c.caseIndex||"", caseTitle:c.caseTitle||"", createdFrom:c.createdFrom||"import", createdAt:c.createdAt||new Date().toISOString()});
    if(Array.isArray(parsed.rows)){
      for(const r of parsed.rows) await addCaseRow(id,{...r});
    }
  }
}
async function clearCurrent(){
  if(state.mode==="case"){ alert("Очистку опису справи додамо наступним кроком."); return; }
  const sh=currentSheet(); const ok=confirm(`Очистити лист «${sh.title}» повністю?`); if(!ok) return;
  await clearRows(curDataKey()); render();
}
async function clearAll(){
  const ok=confirm("Очистити ВСІ листи, всі справи і всі описи?"); if(!ok) return;
  await clearAllRows(); await clearAllCasesAndRows(); render();
}
await loadConfig();
await ensureDefaultTransferTemplates(state.sheets);
const __spaces = await ensureSpaces();
state.spaces = __spaces;
fillSpaceSelect(__spaces);
applyUISettings();

// Space switching (isolated per-space hierarchy)
if(spaceSelect){
  var _spaceRootChanged = false;
  var _spaceRootClickTimer = null;

  // When the user opens the ROOT space dropdown while being inside a subspace,
  // selecting the same root option does not fire onchange. We treat "closing" the picker
  // as an intent to go to that level (journal-nav parity).
  spaceSelect.onpointerdown = function(){
    _spaceRootChanged = false;
    if(_spaceRootClickTimer){ clearTimeout(_spaceRootClickTimer); _spaceRootClickTimer = null; }
  };

  // Android/WebView often does NOT fire onchange when the user picks the SAME option
  // (e.g. being in subspace 1.1 and "picking" root space 1 again). To mirror journal-nav
  // behavior, we treat closing the picker with the same value as an intent to go to this level.
  spaceSelect.onclick = function(){
    if(_spaceRootClickTimer){ clearTimeout(_spaceRootClickTimer); }
    _spaceRootClickTimer = setTimeout(function(){
      try{
        if(!_spaceRootChanged && Array.isArray(state.spacePath) && state.spacePath.length>1){
          var v = spaceSelect.value || (state.spacePath && state.spacePath[0]);
          if(v) setSpacePath([v]);
        }
      }catch(_e){}
    }, 450);
  };

  spaceSelect.onchange = async function(){
    _spaceRootChanged = true;
    const v = spaceSelect.value;
    if(v === "__add__"){
      // revert selection before prompts
      fillSpaceSelect(state.spaces);
      const name = (prompt("Назва нового простору:", "Новий простір")||"").trim();
      if(!name) return;
      const { id } = await addSpace(name);
      state.spaces = await ensureSpaces();
      fillSpaceSelect(state.spaces);
      await setSpacePath([id]);
    } else {
      await setSpacePath([v || state.spaceId]);
    }
  };

  spaceSelect.onblur = async function(){
    try{
      if(!_spaceRootChanged && Array.isArray(state.spacePath) && state.spacePath.length>1){
        const v = spaceSelect.value || (state.spacePath && state.spacePath[0]);
        if(v) await setSpacePath([v]);
      }
    }catch(_e){}
  };
}

// Add subspace button: creates a child space under the currently selected space.
if(btnAddSubspace){
  btnAddSubspace.onclick = async (e)=>{
    e.preventDefault(); e.stopPropagation();
    const parentId = state.spaceId || (Array.isArray(state.spacePath) && state.spacePath.length ? state.spacePath[state.spacePath.length-1] : null);
    if(!parentId) return;
    const parent = spaceById(state.spaces, parentId);
    const pname = parent ? parent.name : "Простір";
    const name = (prompt(`Назва підпростору у: ${pname}`, "Новий підпростір")||"").trim();
    if(!name) return;
    const { id } = await addSubspace(parentId, name);
    state.spaces = await ensureSpaces();
    let newPath = (state.spacePath && state.spacePath.length) ? state.spacePath.slice() : [parentId];
    // ensure path ends with parentId
    if(newPath[newPath.length-1]!==parentId){
      const idx = newPath.lastIndexOf(parentId);
      newPath = (idx>=0) ? newPath.slice(0, idx+1) : [parentId];
    }
    newPath.push(id);
    await setSpacePath(newPath);
  };
}
state.journalPath = ensureValidJournalPath(state.jtree, state.journalPath);
renderJournalNav();
await fillCaseSelect();
window.addEventListener("resize", ()=>{ updateStickyOffsets(); });
render();