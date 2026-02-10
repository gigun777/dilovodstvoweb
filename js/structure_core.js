// js/structure_core.js
// BUILD: v12.6.24 (StructureCore)
// Core (no DOM): unified model for Spaces/Subspaces + Journals/Subjournals + "Level" semantics.
// ES5/ES6-safe: no async/await, no optional chaining, no trailing commas.

import { cfgGet, cfgSet } from "./db.js";
import {
  ensureJournalTree, saveJournalTree,
  nodeById, childrenOf, nodeTitle,
  createChild
} from "./spaces_core.js";

// ---------- helpers ----------
function norm(s){ return (s || "").toString().trim(); }
function nowId(prefix){
  // reasonably unique id without crypto
  return (prefix || "id") + "_" + Date.now().toString(36) + "_" + Math.floor(Math.random()*1e9).toString(36);
}
function cloneArr(a){ return Array.isArray(a) ? a.slice() : []; }
function isObj(o){ return o && typeof o === "object"; }

function loadSpaceTree(){
  return cfgGet("spaces_tree_v1").then(function(tree){
    if(isObj(tree) && isObj(tree.nodes) && Array.isArray(tree.roots)) return tree;

    // migrate from legacy spaces_v1 (flat list) into a tree
    return cfgGet("spaces_v1").then(function(spaces){
      var roots = [];
      var nodes = {};
      if(Array.isArray(spaces)){
        for(var i=0;i<spaces.length;i++){
          var s = spaces[i] || {};
          var id = s.id || nowId("space");
          if(!nodes[id]){
            nodes[id] = { id:id, title: (s.title||s.name||("Простір "+(i+1))), parent:null, children:[] };
            roots.push(id);
          }
        }
      }
      if(!roots.length){
        var id0 = nowId("space");
        nodes[id0] = { id:id0, title:"Простір 1", parent:null, children:[] };
        roots = [id0];
      }
      tree = { roots: roots, nodes: nodes };
      return cfgSet("spaces_tree_v1", tree).then(function(){ return tree; });
    });
  });
}

function saveSpaceTree(tree){
  return cfgSet("spaces_tree_v1", tree).then(function(){ return tree; });
}

function pathToRoot(tree, id){
  var p = [];
  var guard = 0;
  var cur = id;
  while(cur && guard++ < 1000){
    p.push(cur);
    var n = tree.nodes[cur];
    cur = n ? n.parent : null;
  }
  p.reverse();
  return p;
}

function computeNumPaths(tree){
  // assigns numPath like [1,2,1] based on sibling order in roots/children arrays
  function dfs(ids, prefix){
    for(var i=0;i<ids.length;i++){
      var id = ids[i];
      var n = tree.nodes[id];
      if(!n) continue;
      n.numPath = prefix.concat([i+1]);
      if(Array.isArray(n.children) && n.children.length) dfs(n.children, n.numPath);
    }
  }
  dfs(tree.roots || [], []);
  return tree;
}

function spaceDisplayName(tree, id){
  var n = tree.nodes[id];
  if(!n) return "";
  var num = Array.isArray(n.numPath) ? n.numPath.join(".") : "";
  var title = n.title || "";
  return (num ? (num + " " + title) : title).trim();
}

// ---------- public core ----------
export var StructureCore = (function(){
  // persisted keys
  var KEY_SPACE_PATH = "space_path_v1";
  function keyJournalPath(spaceId){ return "journal_path_v1:" + spaceId; }

  function ensure(){
    return loadSpaceTree().then(function(tree){
      computeNumPaths(tree);
      return saveSpaceTree(tree);
    });
  }

  // ----- spaces -----
  function getSpaceTree(){ return loadSpaceTree().then(function(tree){ computeNumPaths(tree); return tree; }); }

  function getSpacePath(){
    // Always return a valid persisted path. If missing/invalid, default to first root.
    return getSpaceTree().then(function(tree){
      return cfgGet(KEY_SPACE_PATH).then(function(p){
        var arr = Array.isArray(p) ? p : [];
        var out = [];
        for(var i=0;i<arr.length;i++){
          var id = arr[i];
          if(tree.nodes[id]) out.push(id);
        }
        if(!out.length && tree.roots && tree.roots.length){
          out = [tree.roots[0]];
          return cfgSet(KEY_SPACE_PATH, out).then(function(){ return out; });
        }
        return out;
      });
    });
  }

  function setSpacePath(path){
    // trims invalid nodes
    return getSpaceTree().then(function(tree){
      var p = cloneArr(path);
      var out = [];
      for(var i=0;i<p.length;i++){
        var id = p[i];
        if(tree.nodes[id]) out.push(id);
      }
      if(!out.length){
        out = tree.roots && tree.roots.length ? [tree.roots[0]] : [];
      }
      return cfgSet(KEY_SPACE_PATH, out).then(function(){ return out; });
    });
  }

  function enterSpace(spaceId){
    return getSpaceTree().then(function(tree){
      if(!tree.nodes[spaceId]) throw new Error("Space not found");
      var p = pathToRoot(tree, spaceId);
      return cfgSet(KEY_SPACE_PATH, p).then(function(){ return p; });
    });
  }

  function currentSpaceId(){
    return getSpacePath().then(function(p){
      return p && p.length ? p[p.length-1] : null;
    });
  }

  function listSpaceSiblings(spaceId){
    return getSpaceTree().then(function(tree){
      var n = tree.nodes[spaceId];
      if(!n) return [];
      var ids;
      if(n.parent){
        var pn = tree.nodes[n.parent];
        ids = pn && Array.isArray(pn.children) ? pn.children : [];
      }else{
        ids = Array.isArray(tree.roots) ? tree.roots : [];
      }
      var out = [];
      for(var i=0;i<ids.length;i++){
        var id = ids[i];
        var nn = tree.nodes[id];
        if(nn) out.push({ id:id, title: spaceDisplayName(tree, id), rawTitle: nn.title || "" });
      }
      return out;
    });
  }

  function listSpaceChildren(spaceId){
    return getSpaceTree().then(function(tree){
      var n = tree.nodes[spaceId];
      var ids = n && Array.isArray(n.children) ? n.children : [];
      var out = [];
      for(var i=0;i<ids.length;i++){
        var id = ids[i];
        var nn = tree.nodes[id];
        if(nn) out.push({ id:id, title: spaceDisplayName(tree, id), rawTitle: nn.title || "" });
      }
      return out;
    });
  }

  function createRootSpace(title){
    title = norm(title) || "Простір";
    return getSpaceTree().then(function(tree){
      var id = nowId("space");
      tree.nodes[id] = { id:id, title:title, parent:null, children:[] };
      tree.roots = tree.roots || [];
      tree.roots.push(id);
      computeNumPaths(tree);
      return saveSpaceTree(tree).then(function(){
        // enter created root
        return cfgSet(KEY_SPACE_PATH, [id]).then(function(){ return id; });
      });
    });
  }

  function createSubspace(parentId, title){
    title = norm(title) || "Підпростір";
    return getSpaceTree().then(function(tree){
      if(!parentId || !tree.nodes[parentId]){
        // If parentId is missing/invalid, fall back to the first root (safe default).
        if(tree.roots && tree.roots.length && tree.nodes[tree.roots[0]]) parentId = tree.roots[0];
      }
      if(!tree.nodes[parentId]) throw new Error("Parent space not found");
      var id = nowId("space");
      tree.nodes[id] = { id:id, title:title, parent:parentId, children:[] };
      var pn = tree.nodes[parentId];
      pn.children = pn.children || [];
      pn.children.push(id);
      computeNumPaths(tree);
      return saveSpaceTree(tree).then(function(){
        // auto-enter child (as requested)
        var p = pathToRoot(tree, id);
        return cfgSet(KEY_SPACE_PATH, p).then(function(){ return id; });
      });
    });
  }

  function getSpaceLevelModel(){
    // returns an object describing "Level" controls for spaces, analogous to journals
    return Promise.all([getSpaceTree(), getSpacePath()]).then(function(res){
      var tree = res[0], path = res[1];
      var cur = path && path.length ? path[path.length-1] : (tree.roots[0] || null);
      var parent = cur && tree.nodes[cur] ? tree.nodes[cur].parent : null;
      var siblingsIds = parent ? (tree.nodes[parent].children || []) : (tree.roots || []);
      var siblings = [];
      for(var i=0;i<siblingsIds.length;i++){
        var id = siblingsIds[i];
        if(tree.nodes[id]) siblings.push({ id:id, title: spaceDisplayName(tree, id) });
      }
      var childrenIds = cur && tree.nodes[cur] ? (tree.nodes[cur].children || []) : [];
      var children = [];
      for(var j=0;j<childrenIds.length;j++){
        var cid = childrenIds[j];
        if(tree.nodes[cid]) children.push({ id:cid, title: spaceDisplayName(tree, cid) });
      }
      return {
        currentId: cur,
        siblings: siblings,
        children: children,
        hasChildren: children.length > 0,
        // active highlight must apply ONLY to currentId
        activeId: cur
      };
    });
  }

  // ----- journals (per current space) -----
  function getJournalTree(spaceId){
    return ensureJournalTree(spaceId).then(function(tree){ return tree; });
  }

  function getJournalPath(spaceId){
    return cfgGet(keyJournalPath(spaceId)).then(function(p){
      return Array.isArray(p) ? p : [];
    });
  }

  function setJournalPath(spaceId, path){
    return getJournalTree(spaceId).then(function(tree){
      var p = cloneArr(path);
      var out = [];
      for(var i=0;i<p.length;i++){
        var id = p[i];
        if(nodeById(tree, id)) out.push(id);
      }
      // if empty but there are top nodes, keep empty (root-level selection means "no instance selected yet")
      return cfgSet(keyJournalPath(spaceId), out).then(function(){ return out; });
    });
  }

  function enterJournal(spaceId, instanceId){
    return getJournalTree(spaceId).then(function(tree){
      if(!nodeById(tree, instanceId)) throw new Error("Journal not found");
      // build path using parents
      var p = [];
      var guard = 0;
      var cur = instanceId;
      while(cur && guard++ < 1000){
        p.push(cur);
        var n = nodeById(tree, cur);
        cur = n ? n.parentId : null;
      }
      p.reverse();
      return cfgSet(keyJournalPath(spaceId), p).then(function(){ return p; });
    });
  }

  function currentJournalId(spaceId){
    return getJournalPath(spaceId).then(function(p){
      return p && p.length ? p[p.length-1] : null;
    });
  }

  function listJournalSiblings(spaceId, instanceId){
    return getJournalTree(spaceId).then(function(tree){
      var n = instanceId ? nodeById(tree, instanceId) : null;
      var parentId = n ? n.parentId : null;
      var ids;
      if(parentId){
        ids = (childrenOf(tree, parentId) || []).map(function(x){ return x.id; });
      }else{
        ids = (tree.top || []).slice ? tree.top.slice() : (tree.top || []);
      }
      var out = [];
      for(var i=0;i<ids.length;i++){
        var id = ids[i];
        var nn = nodeById(tree, id);
        if(nn) out.push({ id:id, title: nodeTitle(nn), sheetKey: nn.sheetKey || null, rawTitle: nn.title || "" });
      }
      return out;
    });
  }

  function listJournalChildren(spaceId, instanceId){
    return getJournalTree(spaceId).then(function(tree){
      var kids = instanceId ? childrenOf(tree, instanceId) : [];
      var out = [];
      for(var i=0;i<(kids||[]).length;i++){
        var nn = kids[i];
        out.push({ id: nn.id, title: nodeTitle(nn), sheetKey: nn.sheetKey || null, rawTitle: nn.title || "" });
      }
      return out;
    });
  }

  function createSubjournal(spaceId, parentId, sheetKey, title){
    // sheetKey is required in this project
    return getJournalTree(spaceId).then(function(tree){
      var pid = parentId;
      if(!pid) throw new Error("Parent journal required");
      var newId = createChild(tree, pid, sheetKey, title);
      return saveJournalTree(spaceId, tree).then(function(){
        // auto-enter child
        return enterJournal(spaceId, newId).then(function(){ return newId; });
      });
    });
  }

  function createRootJournal(spaceId, sheetKey, title){
    // create a top-level journal node
    return getJournalTree(spaceId).then(function(tree){
      // emulate createChild under a virtual root: parentId null means top-level in this tree implementation,
      // but createChild expects a parentId. We'll attach under a hidden root node.
      var rootId = tree._rootId;
      if(!rootId){
        rootId = nowId("jroot");
        tree._rootId = rootId;
        tree.nodes[rootId] = { id: rootId, parentId: null, children: [], numPath: [], title: "ROOT", sheetKey: null };
        tree.top = tree.top || [];
      }
      var id = createChild(tree, rootId, sheetKey, title);
      // ensure appears in top
      tree.top = tree.top || [];
      if(tree.top.indexOf(id) === -1) tree.top.push(id);
      return saveJournalTree(spaceId, tree).then(function(){
        return enterJournal(spaceId, id).then(function(){ return id; });
      });
    });
  }

  function getJournalLevelModel(spaceId){
    // returns an object describing "Level" controls for journals per user definitions.
    // Level is represented by:
    // 1) siblings of current instance (same level)
    // 2) children of current instance (next level) if any
    return Promise.all([getJournalTree(spaceId), getJournalPath(spaceId)]).then(function(res){
      var tree = res[0], path = res[1];
      var cur = path && path.length ? path[path.length-1] : null;
      var curNode = cur ? nodeById(tree, cur) : null;
      var parentId = curNode ? curNode.parentId : null;

      // siblings: journals of the same level (children of parent)
      var siblings = [];
      var siblingNodes = [];
      if(parentId){
        siblingNodes = childrenOf(tree, parentId) || [];
      }else{
        // top-level journals in this space
        var tops = tree.top || [];
        for(var i=0;i<tops.length;i++){
          var nn = nodeById(tree, tops[i]);
          if(nn) siblingNodes.push(nn);
        }
      }
      for(var s=0;s<siblingNodes.length;s++){
        siblings.push({ id: siblingNodes[s].id, title: nodeTitle(siblingNodes[s]) });
      }

      // children: next level under current journal
      var children = [];
      if(cur){
        var kids = childrenOf(tree, cur) || [];
        for(var c=0;c<kids.length;c++){
          children.push({ id: kids[c].id, title: nodeTitle(kids[c]) });
        }
      }

      return {
        currentId: cur,
        siblings: siblings,
        children: children,
        hasChildren: children.length > 0,
        activeId: cur
      };
    });
  }

  return {
    // init
    ensure: ensure,

    // spaces tree/state
    getSpaceTree: getSpaceTree,
    getSpacePath: getSpacePath,
    setSpacePath: setSpacePath,
    enterSpace: enterSpace,
    currentSpaceId: currentSpaceId,
    listSpaceSiblings: listSpaceSiblings,
    listSpaceChildren: listSpaceChildren,
    createRootSpace: createRootSpace,
    createSubspace: createSubspace,
    getSpaceLevelModel: getSpaceLevelModel,

    // journals per space
    getJournalTree: getJournalTree,
    getJournalPath: getJournalPath,
    setJournalPath: setJournalPath,
    enterJournal: enterJournal,
    currentJournalId: currentJournalId,
    listJournalSiblings: listJournalSiblings,
    listJournalChildren: listJournalChildren,
    createRootJournal: createRootJournal,
    createSubjournal: createSubjournal,
    getJournalLevelModel: getJournalLevelModel
  };
})(); 