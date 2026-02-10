// js/transfer_core.js
// TransferCore: UI-agnostic execution engine for transfers between spaces/journals/subjournals.
// UI must provide prompts/choices via deps callbacks.
import { getRows, addRow, getAllCases, addCase, getCaseRows, addCaseRow } from "./db.js";
import { CASE_DESC_COLUMNS } from "./schema.js";

function casePseudoSheet(){
  return { key:"__case__", title:"Опис справи", columns: CASE_DESC_COLUMNS.map(c=>({name:c.name, subrows:false})) };
}

function buildDataKey(spaceId, nodeId){
  // nodeId is a journal instance id like "root:<sheetKey>" or nested instance id.
  if(!spaceId) throw new Error("TransferCore: spaceId is required");
  if(!nodeId) return `${spaceId}::root`;
  return `${spaceId}::${nodeId}`;
}
function defaultRootNodeIdForSheet(sheetKey){ return `root:${sheetKey}`; }

export async function executeTransfer({
  state,
  sourceSheet,
  rows,
  tpl,
  subMode="all",
  subIndexes=[],
  pickedDest=null,
  deps={}
}){
  const toIsCase = (tpl.toSheetKey==="__case__");

  const getSheetByKey = deps.getSheetByKey || ((key)=> (state?.sheets||[]).find(s=>s.key===key) || null);

  const toSheet = toIsCase ? casePseudoSheet() : getSheetByKey(tpl.toSheetKey);
  if(!toSheet) { deps.alert?.("Цільовий лист не знайдено."); return; }

  // destination dataKey
  let dest = pickedDest || null;
  let destSpaceId = (dest?.spaceId || dest?.space || dest?.space_id) || state?.spaceId;
  let destNodeId = (dest?.journalId || dest?.id) || defaultRootNodeIdForSheet(toSheet.key);
  let destDataKey = toIsCase ? null : buildDataKey(destSpaceId, destNodeId);

  // check subrows permission needs
  let routes = (tpl.routes||[]).map(r=>({...r, sources:[...(r.sources||[])]}));
  const needEnable = new Set();
  if(!toIsCase && subMode!=="main"){
    for(const r of routes){
      const colName = (toSheet.columns?.[r.targetCol]?.name);
      if(!colName) continue;
      const def = (toSheet.columns||[]).find(c=>c.name===colName);
      if(def && def.subrows===false) needEnable.add(colName);
    }
  }
  if(needEnable.size){
    const decision = await (deps.onNeedEnableSubrows?.({toSheetKey:toSheet.key, colNames:[...needEnable]}) ?? "cancel");
    if(decision==="cancel") return;
    if(decision==="skip"){
      routes = routes.filter(r=>{
        const colName = (toSheet.columns?.[r.targetCol]?.name);
        return colName ? !needEnable.has(colName) : true;
      });
    }
    if(decision==="allow"){
      await deps.allowSubrows?.({toSheetKey:toSheet.key, colNames:[...needEnable]});
    }
  }

  const getVal = (row, colIdx, subIdx)=>{
    const colName = sourceSheet.columns?.[colIdx]?.name;
    if(!colName) return "";
    if(subIdx!=null){
      if(subIdx===0){
        const v = row.data?.[colName];
        return String(v ?? "");
      }
      const sr = (row.subrows||[])[subIdx-1];
      if(sr && sr[colName]!=null) return String(sr[colName]);
      return "";
    }
    return String(row.data?.[colName] ?? "");
  };

  const compute = (row, subIdx, route)=>{
    const vals = (route.sources||[]).map(i=>getVal(row,i,subIdx));
    if(route.op==="sum"){
      let sum=0;
      for(const v of vals){
        const n = parseFloat(String(v).replace(",", "."));
        if(!Number.isNaN(n)) sum += n;
      }
      return String(sum);
    }
    if(route.op==="seq"){
      return vals.map(v=>String(v)).join("");
    }
    if(route.op==="newline"){
      const parts = vals.map(v=>String(v)).filter(v=>v.trim()!=="");
      return parts.join("\n");
    }
    const delim = (route.delimiter==null) ? " " : String(route.delimiter);
    const parts = vals.map(v=>String(v)).filter(v=>v.trim()!=="");
    return parts.join(delim);
  };

  // destination case id selection
  let targetCaseId = null;
  if(toIsCase){
    targetCaseId = deps.caseId || (state?.mode==="case" ? state?.caseId : null);
    if(!targetCaseId){
      targetCaseId = await deps.pickOrCreateCase?.();
      if(!targetCaseId) return;
    }
  }

  // helpers for case write
  async function appendCaseRowLocal(caseId, mapped){
    if(deps.appendCaseRow) return deps.appendCaseRow(caseId, mapped);
    // fallback: add with auto number
    const rows=await getCaseRows(caseId);
    let max=0;
    for(const r of rows){
      const v=parseInt(r["№ з/п"]??0,10);
      if(!Number.isNaN(v)&&v>max) max=v;
    }
    await addCaseRow(caseId,{...mapped,"№ з/п":String(max+1)});
  }

  for(const row of rows){
    if(toIsCase){
      let idxes=[0];
      const total = 1 + (row.subrows||[]).length;
      if(subMode==="all") idxes = Array.from({length: total}, (_,i)=>i);
      else if(subMode==="selected"){
        idxes = (subIndexes||[]).filter(n=>Number.isFinite(n));
        if(!idxes.length) idxes=[0];
      } else idxes=[0];
      idxes = [...idxes].sort((a,b)=>a-b);

      for(const subIdx of idxes){
        const mapped = {};
        for(const r of routes){
          const tgtName = toSheet.columns?.[r.targetCol]?.name;
          if(!tgtName) continue;
          mapped[tgtName] = compute(row, subIdx, r);
        }
        await appendCaseRowLocal(targetCaseId, mapped);
      }
      continue;
    }

    const out = { data:{}, subrows:[] };

    let idxes=[0];
    const total = 1 + (row.subrows||[]).length;
    if(subMode==="all") idxes = Array.from({length: total}, (_,i)=>i);
    else if(subMode==="selected"){
      idxes = (subIndexes||[]).filter(n=>Number.isFinite(n));
      if(!idxes.length) idxes=[0];
    } else if(subMode==="main") idxes=[0];
    idxes = [...idxes].sort((a,b)=>a-b);

    const firstIdx = idxes[0] ?? 0;
    for(const r of routes){
      const tgtName = toSheet.columns?.[r.targetCol]?.name;
      if(!tgtName) continue;
      out.data[tgtName] = compute(row, firstIdx, r);
    }

    const extraIdxes = idxes.slice(1);
    if(extraIdxes.length){
      for(let j=0;j<extraIdxes.length;j++) out.subrows.push({});
      for(const r of routes){
        const tgtName = toSheet.columns?.[r.targetCol]?.name;
        if(!tgtName) continue;
        const def = (toSheet.columns||[]).find(c=>c.name===tgtName);
        if(def && def.subrows){
          for(let j=0;j<extraIdxes.length;j++){
            out.subrows[j][tgtName] = compute(row, extraIdxes[j], r);
          }
        }
      }
    }

    // auto-order
    if(toSheet.orderColumn){
      const cur=String(out.data[toSheet.orderColumn]??"").trim();
      if(!cur){
        const existing=await getRows(destDataKey);
        const maxN = existing.reduce((m,r)=>Math.max(m, parseInt(r.data?.[toSheet.orderColumn]??0,10)||0),0);
        out.data[toSheet.orderColumn]=String(maxN+1);
      }
    }

    await addRow(destDataKey, out);
  }

  deps.alert?.("Перенесено.");
  deps.onDone?.();
}
