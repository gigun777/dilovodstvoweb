// js/spaces_core.js
// BUILD: v12.6.15
// Core (no DOM): spaces + per-space journal tree + isolated journal instance keys.

import { cfgGet, cfgSet } from "./db.js";

export function norm(s){ return (s||"").toString().trim().toLowerCase(); }

// ---- Spaces ----

export async function ensureSpaces(){
  let spaces = await cfgGet("spaces_v1");
  if(!Array.isArray(spaces) || !spaces.length){
    spaces = [
      {id:"space1", name:"Простір 1", parentId:null, kind:"space", meta:{}},
    ];
    await cfgSet("spaces_v1", spaces);
  }
  // Return ALL spaces (root + subspaces). UI decides how to present the hierarchy.
  return spaces.filter(s=>s && s.kind==="space");
}

export async function addSpace(name){
  const spaces = await cfgGet("spaces_v1") || [];
  const id = `space_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  spaces.push({id, name:String(name||"").trim()||"Новий простір", parentId:null, kind:"space", meta:{}});
  await cfgSet("spaces_v1", spaces);
  return {id, name};
}

export async function addSubspace(parentId, name){
  const spaces = await cfgGet("spaces_v1") || [];
  const id = `subspace_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  const p = spaces.find(s=>s && s.id===parentId) || null;
  const pname = p ? p.name : "Простір";
  spaces.push({id, name:String(name||"").trim()||`Підпростір (${pname})`, parentId: parentId||null, kind:"space", meta:{}});
  await cfgSet("spaces_v1", spaces);
  return {id, name};
}

export function spaceChildren(spaces, parentId){
  return (spaces||[]).filter(s=>s && s.kind==="space" && (s.parentId||null)===(parentId||null));
}

export function spaceById(spaces, id){
  return (spaces||[]).find(s=>s && s.id===id) || null;
}

// ---- Journal tree (per space) ----

export async function ensureJournalTree(spaceId, sheets){
  let tree = await cfgGet(`journal_tree_v1:${spaceId}`);
  if(!tree || typeof tree!=="object" || !tree.nodes){
    tree = { nodes:{}, topIds:[] };
  }
  if(!Array.isArray(tree.topIds)) tree.topIds = [];
  if(!tree.nodes || typeof tree.nodes!=="object") tree.nodes = {};

  // Ensure deterministic top-level journals for all existing sheets (6 defaults + admin added)
  const sheetOrder = (sheets||[]).map(s=>s.key);
  for(let i=0;i<sheetOrder.length;i++){
    const key = sheetOrder[i];
    const id = `root:${key}`;
    if(!tree.nodes[id]){
      tree.nodes[id] = {
        id,
        parentId:null,
        sheetKey:key,
        numPath:[i+1],
        title: (sheets||[]).find(s=>s.key===key)?.name || (sheets||[]).find(s=>s.key===key)?.title || key,
        children:[],
      };
    }
    if(!tree.topIds.includes(id)) tree.topIds.push(id);
  }
  // Keep topIds order consistent with sheets order
  tree.topIds = sheetOrder.map(k=>`root:${k}`).filter(id=>tree.nodes[id]);

  await cfgSet(`journal_tree_v1:${spaceId}`, tree);
  return tree;
}

export async function saveJournalTree(spaceId, tree){
  if(tree) await cfgSet(`journal_tree_v1:${spaceId}`, tree);
}

export function nodeById(tree, id){ return tree?.nodes?.[id] || null; }

export function childrenOf(tree, id){
  const n = nodeById(tree, id);
  return (n?.children||[]).map(cid=>nodeById(tree, cid)).filter(Boolean);
}

export function nodeTitle(node){
  const num = Array.isArray(node?.numPath) ? node.numPath.join('.') : '';
  const base = node?.title || '';
  return num ? `${num} ${base}`.trim() : base;
}

export function currentInstanceId(journalPath){
  return (journalPath && journalPath.length) ? journalPath[journalPath.length-1] : null;
}

export function currentDataKey(spaceId, journalPath){
  const id = currentInstanceId(journalPath);
  return id ? `${spaceId}::${id}` : `${spaceId}::root`;
}

export function activeSheetKey(tree, journalPath, fallbackSheetKey){
  const id = currentInstanceId(journalPath);
  const n = id ? nodeById(tree, id) : null;
  return n?.sheetKey || fallbackSheetKey;
}

// Data key for a top-level (space) journal by sheetKey (used by transfer/import/export routines).
export function journalKeyForSheet(spaceId, sheetKey){
  return `${spaceId}::root:${sheetKey}`;
}

// Create a child journal instance under parentId.
// Returns created node id.
export function createChild(tree, parentId, childSheetKey, title){
  if(!tree || !tree.nodes) throw new Error("Tree not initialized");
  const parentNode = nodeById(tree, parentId);
  if(!parentNode) throw new Error("Parent node not found");

  const siblings = (parentNode.children||[]).map(cid=>nodeById(tree,cid)).filter(Boolean);
  const nextIdx = siblings.length + 1;
  const numPath = (parentNode.numPath||[]).concat([nextIdx]);

  const id = 'sj_' + Date.now() + '_' + Math.random().toString(16).slice(2);
  tree.nodes[id] = {
    id,
    parentId,
    sheetKey: childSheetKey,
    numPath,
    title: String(title||"").trim() || childSheetKey,
    children:[]
  };
  if(!Array.isArray(parentNode.children)) parentNode.children = [];
  parentNode.children.push(id);
  return id;
}
