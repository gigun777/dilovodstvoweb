// js/export.js
import { downloadBlob } from "./ui.js";
import { nowStamp, safeName, normalizeForExport } from "./schema.js";
import { makeZipStore } from "./zip.js";
import { exportDOCXTable, exportXLSXTable, buildDOCXBytes, buildXLSXBytes } from "./office.js";
import { exportPDFTable } from "./pdfgen.js";

export function makeJournalExportFileName(title, stamp){
  return `${safeName(title)}_${stamp}.json`;
}
export function makeCaseExportFileName(caseIndex, caseTitle, stamp){
  const label = `${caseIndex||"Без_індексу"}_${caseTitle||"Без_заголовка"}`;
  return `${safeName("Opis_spravy")}_${safeName(label)}_${stamp}.json`;
}

function rowsToFlatObjects(sheet, rows){
  return rows.map(r=>normalizeForExport(sheet,r));
}

function applyRowFilters(flatRows, rowFilters){
  if(!rowFilters || !rowFilters.length) return flatRows;
  const pass = (row)=>{
    for(const f of rowFilters){
      const v = String(row[f.col] ?? "");
      const needle = String(f.value ?? "");
      if(f.op==="contains" && !v.includes(needle)) return false;
      if(f.op==="not_contains" && v.includes(needle)) return false;
      if(f.op==="equals" && v !== needle) return false;
      if(f.op==="not_equals" && v === needle) return false;
    }
    return true;
  };
  return flatRows.filter(pass);
}

export function exportJournalAsJSON({sheet, rows, sheetExportProfile, visibleColumnsForView}){
  const stamp=nowStamp();
  // v2: column-index based backup (cells array in the order of sheet.columns)
  const colNames = (sheet?.columns||[]).map(c=>c.name);
  const rowsV2 = rows.map(r=>({
    id: r.id,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    cells: colNames.map(n=>String(r?.data?.[n] ?? "")),
    subrows: r.subrows||[]
  }));
  const payload = {
    meta:{ type:"journal", version:2, key:sheet.key, title:sheet.title, exportedAt:new Date().toISOString() },
    // keep schema snapshot for reference, but imports should not rely on column names
    sheet,
    columnsCount: colNames.length,
    exportProfile: sheetExportProfile || null,
    // v2 format
    rowsV2,
    // legacy format kept for backward compatibility
    rows: rows.map(r=>({ ...r, exportData: normalizeForExport(sheet,r) }))
  };
  const json = JSON.stringify(payload, null, 2);
  downloadBlob(new Blob([json], {type:"application/json"}), makeJournalExportFileName(sheet.title, stamp));
}

export function exportJournalAsDOCX({sheet, rows, columns, sheetExportProfile}){
  const flat = rowsToFlatObjects(sheet, rows);
  const filtered = applyRowFilters(flat, sheetExportProfile?.rowFilters);
  exportDOCXTable({
    title: sheet.title,
    subtitle: `Експорт: ${new Date().toLocaleString()}`,
    columns,
    rows: filtered,
    filenameBase: sheet.title
  });
}

export function exportJournalAsXLSX({sheet, rows, columns, sheetExportProfile}){
  const flat = rowsToFlatObjects(sheet, rows);
  const filtered = applyRowFilters(flat, sheetExportProfile?.rowFilters);
  exportXLSXTable({
    title: sheet.title,
    columns,
    rows: filtered,
    filenameBase: sheet.title
  });
}

export function exportJournalAsPDF({sheet, rows, columns, sheetExportProfile}){
  const flat = rowsToFlatObjects(sheet, rows);
  const filtered = applyRowFilters(flat, sheetExportProfile?.rowFilters);
  exportPDFTable({
    title: sheet.title,
    subtitle: `Експорт: ${new Date().toLocaleString()}`,
    columns,
    rows: filtered,
    filenameBase: sheet.title,
    pageSize: sheetExportProfile?.pageSize || "A4",
    orientation: sheetExportProfile?.orientation || "portrait"
  });
}

export async function exportAllZipJSON({sheets, allRowsBySheet, cases, caseRowsByCaseId}){
  const stamp = nowStamp();
  const files = [];
  for(const sh of sheets){
    const rows = allRowsBySheet.get(sh.key) || [];
    const colNames = (sh?.columns||[]).map(c=>c.name);
    const rowsV2 = rows.map(r=>({
      id: r.id,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      cells: colNames.map(n=>String(r?.data?.[n] ?? "")),
      subrows: r.subrows||[]
    }));
    const payload = {
      meta:{ type:"journal", version:2, key:sh.key, title:sh.title, exportedAt:new Date().toISOString() },
      sheet: sh,
      columnsCount: colNames.length,
      rowsV2,
      rows: rows.map(r=>({ ...r, exportData: normalizeForExport(sh,r) }))
    };
    const json = JSON.stringify(payload, null, 2);
    files.push({ name: makeJournalExportFileName(sh.title, stamp), data: new TextEncoder().encode(json) });
  }
  for(const c of cases){
    const rows = caseRowsByCaseId.get(c.id) || [];
    const payload = { meta:{ type:"case_description", exportedAt:new Date().toISOString(), case: c }, rows };
    const json=JSON.stringify(payload,null,2);
    files.push({ name: makeCaseExportFileName(c.caseIndex,c.caseTitle,stamp), data: new TextEncoder().encode(json) });
  }
  const zipBytes = makeZipStore(files);
  const blob=new Blob([zipBytes],{type:"application/zip"});
  downloadBlob(blob, `dilovodstvo_full_export_${stamp}.zip`);
}

// Full backup ZIP (JSON + XLSX + DOCX for each journal; PDF excluded).
// The archive is self-descriptive: every JSON file contains restore info
// (meta.restore) so the files may live either in folders or flat at ZIP root.
// Import side can use meta.restore.stage + keys to restore in correct order.
export async function exportFullBackupZip({
  stamp,
  spaces,
  journalTreesBySpaceId,
  sheets,
  rowsByDataKey,
  cfgDump,
  includeDocx = true,
  includeXlsx = true,
}){
  const files = [];
  const ts = new Date().toISOString();
  const backupId = `fullbackup_${stamp}`;

  const manifest = {
    meta: { type: "fullbackup_manifest", version: 1, backupId, exportedAt: ts },
    note: "This archive may contain folders or may be flat. JSON files include meta.restore for correct import.",
    stages: [
      "spaces",
      "journal_templates",
      "journals",
      "display_settings",
      "transfer_rules",
      "other_settings"
    ]
  };
  files.push({ name: `Dilovodstvo/Exports/${backupId}/00_manifest.json`, data: te(JSON.stringify(manifest, null, 2)) });

  // 1) Spaces
  files.push({
    name: `Dilovodstvo/Exports/${backupId}/01_spaces.json`,
    data: te(JSON.stringify({
      meta: { type: "cfg", stage: "spaces", key: "spaces_v1", exportedAt: ts, restore: { stage: "spaces", key: "spaces_v1" } },
      value: spaces
    }, null, 2))
  });

  // 2) Journal trees per space
  for(const [spaceId, tree] of Object.entries(journalTreesBySpaceId||{})){
    files.push({
      name: `Dilovodstvo/Exports/${backupId}/spaces/${safeName(spaceId)}/02_journal_tree_${safeName(spaceId)}.json`,
      data: te(JSON.stringify({
        meta: { type: "cfg", stage: "spaces", key: `journal_tree_v1:${spaceId}`, exportedAt: ts, restore: { stage: "spaces", key: `journal_tree_v1:${spaceId}`, spaceId } },
        value: tree
      }, null, 2))
    });
  }

  // 3) Templates (sheet schemas)
  const templateKeys = ["all_sheets", "user_sheets"];
  for(const k of templateKeys){
    if(cfgDump && Object.prototype.hasOwnProperty.call(cfgDump, k)){
      files.push({
        name: `Dilovodstvo/Exports/${backupId}/03_${k}.json`,
        data: te(JSON.stringify({
          meta: { type: "cfg", stage: "journal_templates", key: k, exportedAt: ts, restore: { stage: "journal_templates", key: k } },
          value: cfgDump[k]
        }, null, 2))
      });
    }
  }

  // 4) Journals (data) + human-friendly XLSX/DOCX
  for(const sh of (sheets||[])){
    const colNames = (sh?.columns||[]).map(c=>c.name);
    for(const [dataKey, rows] of Object.entries(rowsByDataKey||{})){
      // dataKey format: <spaceId>::<journalInstanceId>
      // We can't know sheetKey from dataKey reliably; export only those keys where active sheet matches.
      // Caller should provide rowsByDataKey already filtered per sheet.
      // Here we store per sheetKey folder.
      if(!dataKey || !Array.isArray(rows)) continue;
      const rowsV2 = rows.map(r=>({
        id: r.id,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        journalKey: r.journalKey,
        cells: colNames.map(n=>String(r?.data?.[n] ?? "")),
        subrows: r.subrows||[]
      }));
      const payload = {
        meta: {
          type: "journal",
          version: 2,
          key: sh.key,
          title: sh.title,
          exportedAt: ts,
          restore: { stage: "journals", sheetKey: sh.key, journalKey: dataKey }
        },
        sheet: sh,
        columnsCount: colNames.length,
        rowsV2
      };
      const base = `${safeName(sh.title||sh.key)}__${safeName(dataKey)}`;
      const folder = `Dilovodstvo/Exports/${backupId}/journals/${safeName(sh.key)}/`;
      files.push({ name: `${folder}${base}.json`, data: te(JSON.stringify(payload, null, 2)) });

      // XLSX/DOCX (exclude PDF)
      const flatRows = rows.map(r=>normalizeForExport(sh,r));
      const columns = (sh?.columns||[]).map(c=>c.name);
      if(includeXlsx){
        const x = buildXLSXBytes({ title: sh.title, columns, rows: flatRows });
        files.push({ name: `${folder}${base}.xlsx`, data: x });
      }
      if(includeDocx){
        const d = buildDOCXBytes({ title: sh.title, subtitle: `Експорт: ${new Date().toLocaleString()}`, columns, rows: flatRows });
        files.push({ name: `${folder}${base}.docx`, data: d });
      }
    }
  }

  // 5) Display settings, transfer rules, other settings (cfg dump)
  const knownStages = {
    display_settings: ["sheet_settings", "add_fields"],
    transfer_rules: ["transfer_rules", "transfer_templates_v2", "transferRules"],
  };
  const used = new Set(["spaces_v1", ...Object.values(journalTreesBySpaceId||{}).map(()=>null)]);
  // Add staged known keys
  for(const [stage, keys] of Object.entries(knownStages)){
    for(const k of keys){
      if(cfgDump && Object.prototype.hasOwnProperty.call(cfgDump, k)){
        files.push({
          name: `Dilovodstvo/Exports/${backupId}/cfg/${stage}__${safeName(k)}.json`,
          data: te(JSON.stringify({
            meta: { type: "cfg", stage, key: k, exportedAt: ts, restore: { stage, key: k } },
            value: cfgDump[k]
          }, null, 2))
        });
      }
    }
  }
  // Everything else (except templates and spaces) -> other_settings
  if(cfgDump){
    for(const [k, v] of Object.entries(cfgDump)){
      if(templateKeys.includes(k)) continue;
      if(k === "spaces_v1") continue;
      if(k.startsWith("journal_tree_v1:")) continue;
      if(Object.values(knownStages).some(arr=>arr.includes(k))) continue;
      files.push({
        name: `Dilovodstvo/Exports/${backupId}/cfg/other__${safeName(k)}.json`,
        data: te(JSON.stringify({
          meta: { type: "cfg", stage: "other_settings", key: k, exportedAt: ts, restore: { stage: "other_settings", key: k } },
          value: v
        }, null, 2))
      });
    }
  }

  const zipBytes = makeZipStore(files);
  const blob = new Blob([zipBytes], { type: "application/zip" });
  downloadBlob(blob, `${backupId}.zip`);
}

function te(text){
  return new TextEncoder().encode(text);
}

// ------------------------
// Full backup (ZIP) core
// Creates a single archive fullbackup_<stamp>.zip with:
//  - manifest (import order)
//  - spaces + journal trees
//  - full cfg dump
//  - full journal data as JSON (+ optional DOCX/XLSX human-readable exports)
//  - cases
// NOTE: PDF intentionally excluded.

export async function exportFullBackupZipAllFormats({
  stamp,
  spaces,
  journalTreesBySpaceId,
  cfgDump,
  sheets,
  rowsByDataKey,
  cases,
  caseRowsByCaseId,
}){
  const exportedAt = new Date().toISOString();
  const files = [];

  const manifest = {
    meta: { type: "fullbackup_manifest", version: 1, exportedAt },
    // Import stages (requested): spaces -> user templates -> journals -> view settings -> rules -> other
    stages: [
      "spaces",
      "journal_trees",
      "cfg",
      "journals",
      "cases",
    ],
  };
  files.push({ name: `Dilovodstvo/manifest.json`, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });

  // Spaces
  files.push({
    name: `Dilovodstvo/spaces/spaces_v1.json`,
    data: new TextEncoder().encode(JSON.stringify({ meta:{type:"cfg", key:"spaces_v1", exportedAt}, value: spaces }, null, 2))
  });

  // Journal trees per space
  const jtPayload = { meta:{type:"journal_trees", version:1, exportedAt}, trees: journalTreesBySpaceId };
  files.push({ name:`Dilovodstvo/spaces/journal_trees.json`, data: new TextEncoder().encode(JSON.stringify(jtPayload, null, 2)) });

  // Full cfg dump (all keys)
  files.push({
    name: `Dilovodstvo/cfg/cfg_dump.json`,
    data: new TextEncoder().encode(JSON.stringify({ meta:{type:"cfg_dump", version:1, exportedAt}, cfg: cfgDump }, null, 2))
  });

  // Journals (JSON + DOCX + XLSX)
  for(const sh of (sheets||[])){
    // We export per-space instances too. rowsByDataKey must include keys for each instance.
    // Use sheet.key to find all data keys that end with "::..." nodes with this sheetKey.
  }

  // Determine all journal instances from rowsByDataKey map
  for(const [dataKey, rows] of rowsByDataKey.entries()){
    const parts = String(dataKey).split("::");
    const spaceId = parts[0] || "";
    const instanceId = parts.slice(1).join("::");

    // Find sheetKey from instance id (root:<sheetKey> or node in journal tree)
    let sheetKey = null;
    if(instanceId.startsWith("root:")){
      sheetKey = instanceId.slice("root:".length);
    } else {
      const tree = journalTreesBySpaceId?.[spaceId];
      const node = tree?.nodes?.[instanceId];
      sheetKey = node?.sheetKey || null;
    }
    const sheet = (sheets||[]).find(s=>s.key===sheetKey) || null;
    if(!sheet) continue;

    const colNames = (sheet?.columns||[]).map(c=>c.name);
    const rowsV2 = (rows||[]).map(r=>({
      id: r.id,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      cells: colNames.map(n=>String(r?.data?.[n] ?? "")),
      subrows: r.subrows||[]
    }));

    const restore = { kind:"journal", spaceId, instanceId, sheetKey };
    const payload = {
      meta:{ type:"journal", version:2, key:sheet.key, title:sheet.title, exportedAt, restore },
      sheet,
      columnsCount: colNames.length,
      rowsV2,
    };
    const base = `${safeName(spaceId)}__${safeName(instanceId)}`;
    const folder = `Dilovodstvo/journals/${safeName(spaceId)}/${safeName(instanceId)}`;

    files.push({ name:`${folder}/journal.json`, data: new TextEncoder().encode(JSON.stringify(payload, null, 2)) });

    // Human-readable formats (DOCX/XLSX) - full content, no filters
    const flatRows = (rows||[]).map(r=>normalizeForExport(sheet,r));
    const cols = (sheet?.columns||[]).map(c=>c.name);
    const docxBytes = buildDOCXBytes({
      title: sheet.title,
      subtitle: `Full backup: ${exportedAt}`,
      columns: cols,
      rows: flatRows,
    });
    files.push({ name:`${folder}/journal.docx`, data: docxBytes });
    const xlsxBytes = buildXLSXBytes({
      title: sheet.title,
      columns: cols,
      rows: flatRows,
    });
    files.push({ name:`${folder}/journal.xlsx`, data: xlsxBytes });
  }

  // Cases
  for(const c of (cases||[])){
    const rows = caseRowsByCaseId.get(c.id) || [];
    const payload = { meta:{ type:"case_description", exportedAt, case: c }, rows };
    files.push({ name:`Dilovodstvo/cases/${safeName(c.caseIndex||"case")}_${safeName(c.caseTitle||"")}.json`, data: new TextEncoder().encode(JSON.stringify(payload, null, 2)) });
  }

  const zipBytes = makeZipStore(files);
  const blob = new Blob([zipBytes], {type:"application/zip"});
  downloadBlob(blob, `fullbackup_${stamp}.zip`);
}
