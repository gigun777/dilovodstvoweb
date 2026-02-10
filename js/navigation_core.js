// js/navigation_core.js
// BUILD: v12.6.16
// Core (no DOM): navigation over a per-space journal tree.

import { nodeById, childrenOf, nodeTitle } from "./spaces_core.js";

// ---- Normalization ----

// Ensure journalPath is valid for the given tree.
// Rules:
// - path[0] must be a valid top node; otherwise choose the first topId.
// - each next node must exist AND be a descendant of the previous node; otherwise trim.
export function ensureValidJournalPath(tree, journalPath){
  const topIds = Array.isArray(tree?.topIds) ? tree.topIds : [];
  let path = Array.isArray(journalPath) ? journalPath.slice() : [];

  // Ensure a valid top.
  if(!path.length || !nodeById(tree, path[0])){
    path = topIds[0] ? [topIds[0]] : [];
  }
  if(!path.length) return [];

  // Validate chain.
  const out = [path[0]];
  for(let i=1;i<path.length;i++){
    const prev = out[out.length-1];
    const cand = path[i];
    const prevKids = childrenOf(tree, prev).map(n=>n.id);
    if(prevKids.includes(cand) && nodeById(tree, cand)) out.push(cand);
    else break;
  }
  return out;
}

// ---- Path operations (gesture-friendly) ----

export function currentNodeId(path){
  return (Array.isArray(path) && path.length) ? path[path.length-1] : null;
}

// Replace top-level journal.
export function setTop(path, topId){
  return topId ? [topId] : [];
}

// Update selection at a specific depth (depth>=1).
// If selectedId is falsy -> stay at parent (trim deeper levels).
export function setAtDepth(path, depth, selectedId){
  const base = Array.isArray(path) ? path.slice(0, depth) : [];
  if(!selectedId) return base;
  return base.concat([selectedId]);
}

// Back-compat alias (old name).
export function setChild(path, depth, selectedId){
  return setAtDepth(path, depth, selectedId);
}

// Go up one level.
export function goParent(path){
  if(!Array.isArray(path) || path.length<=1) return path||[];
  return path.slice(0, -1);
}

// Go to a specific child.
export function goChild(path, childId){
  if(!childId) return path||[];
  return (Array.isArray(path)?path:[]).concat([childId]);
}

// Go to the first child of the current node (if any). Returns same path if none.
export function goFirstChild(tree, path){
  const cur = currentNodeId(path);
  if(!cur) return path||[];
  const kids = childrenOf(tree, cur);
  if(!kids.length) return path||[];
  return goChild(path, kids[0].id);
}

// ---- UI model helpers (still DOM-free) ----

// Build a minimal model for rendering navigation controls.
// Includes:
// - topNodes: top-level journals
// - path: normalized current path
// - levels: chain of selectable children for each depth (to render selects + plus buttons)
export function buildNavModel(tree, journalPath){
  const path = ensureValidJournalPath(tree, journalPath);
  const topNodes = (Array.isArray(tree?.topIds)?tree.topIds:[])
    .map(id=>nodeById(tree,id))
    .filter(Boolean);

  const levels = [];
  let trimmedPath = path.slice();

  for(let depth=0; depth<trimmedPath.length; depth++){
    const parentId = trimmedPath[depth];
    const kids = childrenOf(tree, parentId);
    if(!kids.length) break;

    const nextDepth = depth + 1;
    const selected = trimmedPath[nextDepth] && kids.some(k=>k.id===trimmedPath[nextDepth])
      ? trimmedPath[nextDepth]
      : "";

    // If no explicit selection at next depth, trim deeper and stop ("stay here").
    if(!selected){
      trimmedPath = trimmedPath.slice(0, nextDepth);
      levels.push({ depth: nextDepth, parentId, kids, selected: "" });
      break;
    }

    levels.push({ depth: nextDepth, parentId, kids, selected });
  }

  return { topNodes, path: trimmedPath, levels };
}

export function breadcrumbs(tree, path){
  const normPath = ensureValidJournalPath(tree, path);
  return normPath
    .map(id=>nodeById(tree,id))
    .filter(Boolean)
    .map(n=>({ id:n.id, title: nodeTitle(n) }));
}

// Whether a given node id is the currently displayed node.
export function isActiveNode(path, id){
  return currentNodeId(path) === id;
}
