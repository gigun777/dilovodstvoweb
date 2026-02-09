// js/quicknav.js
// Reusable "Quick Navigation Window" core.
// Can be used as a navigator (mutates app state via callbacks) or as a picker (returns selection).

import { el, btn, modalOpen, confirmDeleteNumber } from './ui.js';

const norm = (v)=>String(v||'').toLowerCase().trim();

// Small helper for caret buttons
function mkCaret(hasKids, expanded, title=''){
  const b = el('button', {className:'btn btn-ghost', textContent: hasKids ? (expanded ? '▾' : '▸') : ' ', title});
  b.style.width = '34px';
  b.style.height = '34px';
  b.style.padding = '0';
  b.style.lineHeight = '1';
  b.style.fontSize = '18px';
  b.style.color = 'black';
  if(!hasKids){ b.style.opacity='0'; b.style.pointerEvents='none'; }
  return b;
}

/**
 * Open quick navigation window.
 *
 * @param {Object} opts
 * @param {string} [opts.title]
 * @param {'navigate'|'pick'} [opts.mode] - navigate uses onNavigate callbacks, pick resolves a selection.
 * @param {boolean} [opts.showSpaces]
 * @param {boolean} [opts.showJournals]
 * @param {boolean} [opts.allowAdd]
 * @param {boolean} [opts.allowDelete]
 * @param {boolean} [opts.defaultCollapsed] - initial collapsed state.
 * @param {boolean} [opts.persistDefaultCollapsed] - persist toggle via cfgKey.
 * @param {string} [opts.cfgKeyDefaultCollapsed]
 * @param {function(string):Promise<any>} [opts.cfgGet]
 * @param {function(string,any):Promise<void>} [opts.cfgSet]
 *
 * Data:
 * @param {Array<{id:string,name:string,parentId?:string|null,kind?:string}>} [opts.spaces]
 * @param {string} [opts.activeSpaceId]
 * @param {Object} [opts.jtree] - {nodes:{[id]:{id,title?,key?,children?:string[],parentId?:string|null}}, topIds:string[]}
 * @param {string} [opts.activeJournalId]
 *
 * Callbacks:
 * @param {(spaceId:string)=>Promise<void>|void} [opts.onGoSpace]
 * @param {(parentSpaceId:string|null)=>Promise<void>|void} [opts.onAddSpace]
 * @param {(spaceId:string)=>Promise<void>|void} [opts.onDeleteSpace]
 * @param {(pathIds:string[])=>Promise<void>|void} [opts.onGoJournalPath]
 * @param {(pathIds:string[])=>Promise<void>|void} [opts.onAddJournalChild]
 * @param {(journalId:string)=>Promise<void>|void} [opts.onDeleteJournal]
 *
 * Picker:
 * @param {(sel:{kind:'space'|'journal', id:string, path?:string[]})=>Promise<void>|void} [opts.onPick]
 * @param {boolean} [opts.closeOnPick]
 */
export async function openQuickNavWindow(opts={}){
  const {
    title='Навігація: дерево просторів і журналів',
    mode='navigate',
    showSpaces=true,
    showJournals=true,
    allowAdd=true,
    allowDelete=true,
    persistDefaultCollapsed=true,
    cfgKeyDefaultCollapsed='treenav_default_collapsed',
    cfgGet,
    cfgSet,
    // Static snapshots (optional). If getData is provided, these are treated as initial values.
    spaces=[],
    activeSpaceId=null,
    jtree=null,
    activeJournalId=null,

    // Optional live data provider. When present, the window refreshes data after mutations
    // (add/delete/select) and before each render.
    // Expected return: { spaces, activeSpaceId, jtree, activeJournalId }
    getData=null,
    onGoSpace,
    onAddSpace,
    onDeleteSpace,
    onGoJournalPath,
    onAddJournalChild,
    onDeleteJournal,
    onPick,
    closeOnPick=true,
  } = opts;

  // Live data refresh helper
  let _spaces = spaces;
  let _activeSpaceId = activeSpaceId;
  let _jtree = jtree;
  let _activeJournalId = activeJournalId;

  async function refreshData(){
    if(typeof getData !== 'function') return;
    const d = await getData();
    if(!d || typeof d !== 'object') return;
    if(Array.isArray(d.spaces)) _spaces = d.spaces;
    if(typeof d.activeSpaceId === 'string' || d.activeSpaceId===null) _activeSpaceId = d.activeSpaceId;
    if(d.jtree && typeof d.jtree === 'object') _jtree = d.jtree;
    if(typeof d.activeJournalId === 'string' || d.activeJournalId===null) _activeJournalId = d.activeJournalId;
  }

  await refreshData();

  // defaultCollapsed: by default true unless overridden or stored.
  let defaultCollapsed = true;
  if(Object.prototype.hasOwnProperty.call(opts,'defaultCollapsed')) defaultCollapsed = !!opts.defaultCollapsed;
  else if(persistDefaultCollapsed && cfgGet){
    const raw = await cfgGet(cfgKeyDefaultCollapsed);
    defaultCollapsed = (raw===null || raw===undefined) ? true : !!raw;
  }

  // Data indexes (rebuilt on demand)
  let onlySpaces = [];
  let bySpaceId = {};
  let spaceChildren = {};
  let nodes = {};
  let topIds = [];

  const nodeById = (id)=>nodes[id] || null;
  const nodeTitle = (n)=>{
    if(!n) return '';
    if(n.title) return String(n.title);
    if(n.key) return String(n.key);
    return String(n.id||'');
  };

  function rebuildIndexes(){
    onlySpaces = (_spaces||[]).filter(s=>s && (s.kind==='space' || !s.kind));
    bySpaceId = Object.fromEntries(onlySpaces.map(s=>[s.id,s]));
    spaceChildren = {};
    for(const s of onlySpaces){
      const pid = s.parentId || null;
      if(!spaceChildren[pid]) spaceChildren[pid] = [];
      spaceChildren[pid].push(s);
    }
    for(const k of Object.keys(spaceChildren)){
      spaceChildren[k].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
    }
    nodes = (_jtree && _jtree.nodes) ? _jtree.nodes : {};
    topIds = (_jtree && Array.isArray(_jtree.topIds)) ? _jtree.topIds : [];
  }

  rebuildIndexes();

  // UI header
  const headerRow = el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px; margin:2px 0 6px;'});
  const hint = el('div', {className:'muted', textContent:'Швидка навігація. Натисніть ▸/▾ щоб згорнути/розгорнути гілки.'});

  // Default expand/collapse toggle (circle with caret)
  const btnDefaultCollapsed = el('button', {className:'btn btn-ghost', textContent:'▸', title:'Перемикає: гілки згорнуті/розгорнуті (і застосовує одразу)'});
  btnDefaultCollapsed.style.width = '38px';
  btnDefaultCollapsed.style.height = '38px';
  btnDefaultCollapsed.style.padding = '0';
  btnDefaultCollapsed.style.borderRadius = '999px';
  btnDefaultCollapsed.style.fontSize = '18px';
  btnDefaultCollapsed.style.lineHeight = '1';
  btnDefaultCollapsed.style.color = 'black';

  const defaultCollapsedState = { value: !!defaultCollapsed };
  const applyCollapsedVisual = ()=>{
    if(defaultCollapsedState.value){
      btnDefaultCollapsed.classList.add('treenav-toggle-on');
      btnDefaultCollapsed.textContent = '▸';
    }else{
      btnDefaultCollapsed.classList.remove('treenav-toggle-on');
      btnDefaultCollapsed.textContent = '▾';
    }
  };
  applyCollapsedVisual();

  headerRow.appendChild(hint);
  headerRow.appendChild(btnDefaultCollapsed);

  // Search row
  const searchRow = el('div', {style:'display:flex; gap:8px; align-items:center; margin:0 0 8px;'});
  const searchInput = el('input', {type:'search', placeholder:'Пошук (простір/журнал)…', className:'input'});
  searchInput.style.flex='1';
  searchInput.style.height='38px';
  const clearBtn = el('button', {className:'btn btn-ghost', textContent:'✕', title:'Очистити пошук'});
  clearBtn.style.width='38px'; clearBtn.style.height='38px'; clearBtn.style.padding='0';
  clearBtn.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); searchInput.value=''; renderTree(); searchInput.focus(); };
  searchRow.appendChild(searchInput);
  searchRow.appendChild(clearBtn);

  const treeWrap = el('div', {style:'max-height:60vh; overflow:auto; padding:6px 2px;'});

  // Expanded state
  const expandedSpaces = new Set();
  const expandedJournals = new Set();
  const isExpanded = (set,id)=>set.has(id);
  const setExpanded = (set,id,v)=>{ if(v) set.add(id); else set.delete(id); };

  // Visible filters (search)
  let searchActive=false;
  let visibleSpaceIds=null;
  let visibleJournalIds=null;

  // Internal close handler set by modalOpen()
  let _close = null;
  const close = ()=>{ try{ _close && _close(); }catch(_e){} };

  // Node builders
  const makeSpaceNode = (s, depth=0)=>{
    if(visibleSpaceIds && !visibleSpaceIds.has(s.id)) return [];
    const kidsAll = spaceChildren[s.id] || [];
    const kids = visibleSpaceIds ? kidsAll.filter(k=>visibleSpaceIds.has(k.id)) : kidsAll;
    if(!defaultCollapsedState.value && kids.length && !expandedSpaces.has(s.id)) expandedSpaces.add(s.id);

    const row = el('div', {style:`display:flex; gap:8px; align-items:center; padding:6px 8px; margin-left:${depth*14}px; border-radius:10px;`});
    const isActive = (s.id===_activeSpaceId);
    row.style.background = isActive ? 'rgba(0,200,0,0.12)' : '';

    const caret = mkCaret(!!kids.length, isExpanded(expandedSpaces, s.id), kids.length?'Згорнути/розгорнути':'');
    const b = el('button', {className:'btn', textContent:`📁 ${s.name}`});
    b.style.height='34px';
    b.onclick = async ()=>{
      if(mode==='pick'){
        const sel = {kind:'space', id:s.id};
        try{ await (onPick ? onPick(sel) : null); }catch(_e){}
        if(closeOnPick) close();
        return;
      }
      if(onGoSpace){
        await onGoSpace(s.id);
        await refreshData();
        rebuildIndexes();
        renderTree();
      }
    };

    const addBtn = el('button', {className:'btn btn-ghost', textContent:'＋', title:'Додати підпростір'});
    addBtn.style.width='38px'; addBtn.style.padding='0';
    if(!allowAdd || !onAddSpace){ addBtn.style.display='none'; }
    addBtn.onclick = async (e)=>{
      e.preventDefault(); e.stopPropagation();
      await onAddSpace(s.id);
      await refreshData();
      rebuildIndexes();
      renderTree();
    };

    const delBtn = el('button', {className:'btn btn-ghost danger', textContent:'🗑', title:'Видалити простір'});
    delBtn.style.width='38px'; delBtn.style.padding='0';
    if(!allowDelete || !onDeleteSpace){ delBtn.style.display='none'; }
    delBtn.onclick = async (e)=>{
      e.preventDefault(); e.stopPropagation();
      // Confirm here, to keep a consistent UX when embedding the window elsewhere.
      const ok = await confirmDeleteNumber(`Видалити простір "${(bySpaceId[s.id]?.name)||s.id}"?\n\nУвага: будуть видалені також усі підпростори.`);
      if(!ok) return;
      await onDeleteSpace(s.id);
      await refreshData();
      rebuildIndexes();
      renderTree();
    };

    const childWrap = el('div', {});
    childWrap.style.display = isExpanded(expandedSpaces, s.id) ? '' : 'none';
    for(const c of kids){
      for(const n of makeSpaceNode(c, depth+1)) childWrap.appendChild(n);
    }
    caret.onclick = (e)=>{
      e.preventDefault(); e.stopPropagation();
      const next = !isExpanded(expandedSpaces, s.id);
      setExpanded(expandedSpaces, s.id, next);
      caret.textContent = next ? '▾' : '▸';
      childWrap.style.display = next ? '' : 'none';
    };

    row.appendChild(caret);
    row.appendChild(b);
    row.appendChild(addBtn);
    row.appendChild(delBtn);
    return [row, childWrap];
  };

  const makeJournalNode = (id, path, depth=0)=>{
    if(visibleJournalIds && !visibleJournalIds.has(id)) return [];
    const n = nodeById(id);
    if(!n) return [];
    const kidsAll = (n.children||[]).filter(cid=>!!nodeById(cid));
    const kids = visibleJournalIds ? kidsAll.filter(cid=>visibleJournalIds.has(cid)) : kidsAll;
    if(!defaultCollapsedState.value && kids.length && !expandedJournals.has(id)) expandedJournals.add(id);

    const row = el('div', {style:`display:flex; gap:8px; align-items:center; padding:6px 8px; margin-left:${depth*14}px; border-radius:10px;`});
    const isActive = (_activeJournalId===id);
    row.style.background = isActive ? 'rgba(0,200,0,0.12)' : '';

    const caret = mkCaret(!!kids.length, isExpanded(expandedJournals, id), kids.length?'Згорнути/розгорнути':'');
    const b = el('button', {className:'btn', textContent:`📄 ${nodeTitle(n)}`});
    b.style.height='34px';
    b.onclick = async ()=>{
      if(mode==='pick'){
        const sel = {kind:'journal', id, path:path.slice()};
        try{ await (onPick ? onPick(sel) : null); }catch(_e){}
        if(closeOnPick) close();
        return;
      }
      if(onGoJournalPath){
        await onGoJournalPath(path.slice());
        await refreshData();
        rebuildIndexes();
        renderTree();
      }
    };

    const add = el('button', {className:'btn btn-ghost', textContent:'＋', title:'Додати піджурнал'});
    add.style.width='38px'; add.style.padding='0';
    if(!allowAdd || !onAddJournalChild){ add.style.display='none'; }
    add.onclick = async (e)=>{
      e.preventDefault(); e.stopPropagation();
      await onAddJournalChild(path.slice());
      await refreshData();
      rebuildIndexes();
      renderTree();
    };

    const canDelete = !String(id).startsWith('root:');
    const del = el('button', {className:'btn btn-ghost danger', textContent:'🗑', title: canDelete ? 'Видалити журнал' : 'Кореневий журнал видаляти не можна'});
    del.style.width='38px'; del.style.padding='0';
    if(!allowDelete || !onDeleteJournal){ del.style.display='none'; }
    else if(!canDelete){ del.style.opacity='0.35'; del.style.pointerEvents='none'; }
    del.onclick = async (e)=>{
      e.preventDefault(); e.stopPropagation();
      if(!canDelete) return;
      const ok = await confirmDeleteNumber(`Видалити журнал "${nodeTitle(n)}"?\n\nУвага: будуть видалені також усі його піджурнали.`);
      if(!ok) return;
      if(onDeleteJournal) await onDeleteJournal(id);
      await refreshData();
      rebuildIndexes();
      renderTree();
    };

    const childWrap = el('div', {});
    childWrap.style.display = isExpanded(expandedJournals, id) ? '' : 'none';
    for(const cid of kids){
      for(const line of makeJournalNode(cid, path.concat([cid]), depth+1)) childWrap.appendChild(line);
    }
    caret.onclick = (e)=>{
      e.preventDefault(); e.stopPropagation();
      const next = !isExpanded(expandedJournals, id);
      setExpanded(expandedJournals, id, next);
      caret.textContent = next ? '▾' : '▸';
      childWrap.style.display = next ? '' : 'none';
    };

    row.appendChild(caret);
    row.appendChild(b);
    row.appendChild(add);
    row.appendChild(del);
    return [row, childWrap];
  };

  const renderTree = ()=>{
    treeWrap.innerHTML='';
    const q = norm(searchInput.value||'');
    searchActive = !!q;

    const visibleSpaces = new Set();
    const expandSpacesForSearch = new Set();
    const visibleJournals = new Set();
    const expandJournalsForSearch = new Set();

    if(searchActive){
      // Spaces: matches + ancestors
      const matches = new Set();
      for(const s of onlySpaces){ if(norm(s.name).includes(q)) matches.add(s.id); }
      const includeWithAncestors = (id)=>{
        let cur = bySpaceId[id];
        while(cur){
          visibleSpaces.add(cur.id);
          const pid = cur.parentId || null;
          if(pid) expandSpacesForSearch.add(pid);
          cur = pid ? bySpaceId[pid] : null;
        }
      };
      for(const id of matches) includeWithAncestors(id);

      // Journals: matches + ancestors
      const jMatches = new Set();
      for(const id of Object.keys(nodes)){
        if(norm(nodeTitle(nodes[id])).includes(q)) jMatches.add(id);
      }
      const includeJWithAncestors = (id)=>{
        let cur = nodes[id];
        while(cur){
          visibleJournals.add(cur.id);
          const pid = cur.parentId || null;
          if(pid) expandJournalsForSearch.add(pid);
          cur = pid ? nodes[pid] : null;
        }
      };
      for(const id of jMatches) includeJWithAncestors(id);
    }

    visibleSpaceIds = searchActive ? visibleSpaces : null;
    visibleJournalIds = searchActive ? visibleJournals : null;

    if(searchActive){
      expandedSpaces.clear();
      expandedJournals.clear();
      for(const id of expandSpacesForSearch) expandedSpaces.add(id);
      for(const id of expandJournalsForSearch) expandedJournals.add(id);
    }else if(defaultCollapsedState.value){
      expandedSpaces.clear();
      expandedJournals.clear();
    }else{
      expandedSpaces.clear();
      expandedJournals.clear();
      for(const s of onlySpaces){ if((spaceChildren[s.id]||[]).length) expandedSpaces.add(s.id); }
      for(const id of Object.keys(nodes)){
        const n = nodes[id];
        const kids = (n?.children||[]).filter(cid=>!!nodes[cid]);
        if(kids.length) expandedJournals.add(id);
      }
    }

    if(showSpaces){
      treeWrap.appendChild(el('div', {className:'muted', textContent:'Простори'}));
      const roots = spaceChildren[null] || spaceChildren[undefined] || [];
      for(const r of roots){
        if(searchActive && visibleSpaces.size && !visibleSpaces.has(r.id)) continue;
        for(const n of makeSpaceNode(r, 0)) treeWrap.appendChild(n);
      }
      treeWrap.appendChild(el('div', {style:'height:10px'}));
    }

    if(showJournals){
      treeWrap.appendChild(el('div', {className:'muted', textContent:'Журнали (поточний простір)'}));
      const top = (topIds||[]).filter(id=>!!nodeById(id));
      for(const id of top){
        if(searchActive && visibleJournals.size && !visibleJournals.has(id)) continue;
        for(const n of makeJournalNode(id, [id], 0)) treeWrap.appendChild(n);
      }
    }

    if(searchActive){
      const hasAny = (visibleSpaces.size>0) || (visibleJournals.size>0);
      if(!hasAny){
        treeWrap.appendChild(el('div', {className:'muted', textContent:'Нічого не знайдено.', style:'margin-top:10px'}));
      }
    }
  };

  searchInput.oninput = ()=>renderTree();

  btnDefaultCollapsed.onclick = async (e)=>{
    e.preventDefault(); e.stopPropagation();
    defaultCollapsedState.value = !defaultCollapsedState.value;
    if(persistDefaultCollapsed && cfgSet){
      await cfgSet(cfgKeyDefaultCollapsed, defaultCollapsedState.value);
    }
    applyCollapsedVisual();
    renderTree();
  };

  // Initial render
  renderTree();

  // Open modal
  const closeBtn = btn('Закрити','close','btn');
  const p = modalOpen({ title, bodyNodes:[headerRow, searchRow, treeWrap], actions:[closeBtn] });
  // modalOpen resolves on close; we use this to assign _close (internal)
  // by hacking: create our own close closure by awaiting p and no-op.
  // We cannot access the internal close from modalOpen, so we simply rely on user closing or pick close.
  // For programmatic close on pick, we simulate a click on close button.
  _close = ()=>{ try{ closeBtn.click(); }catch(_e){} };
  await p;
}

/**
 * Create an embeddable QuickNav panel (no modal).
 * Useful for placing the same tree UI inside other dialogs (e.g. transfer destination picker).
 *
 * Returns: { root, api }
 *  - root: HTMLElement to insert
 *  - api: {
 *      setSearch(value),
 *      getSearch(),
 *      setDefaultCollapsed(bool),
 *      collapseAll(),
 *      expandAll(),
 *      refresh(),
 *      getSelected(),
 *      setSelected(sel)
 *    }
 */
export async function createQuickNavPanel(opts={}){
  // We reuse the same core as the modal, but return nodes instead of opening modalOpen().
  const {
    title=null, // unused (kept for API parity)
    mode='pick',
    showSpaces=false,
    showJournals=true,
    allowAdd=false,
    allowDelete=false,
    // If false: keep search value but hide the UI.
    showSearch=true,
    persistDefaultCollapsed=false,
    cfgKeyDefaultCollapsed='treenav_default_collapsed',
    cfgGet,
    cfgSet,
    spaces=[],
    activeSpaceId=null,
    jtree=null,
    activeJournalId=null,
    getData=null,
    onGoSpace,
    onAddSpace,
    onDeleteSpace,
    onGoJournalPath,
    onAddJournalChild,
    onDeleteJournal,
    onPick,
    closeOnPick=false,
  } = opts;

  // ---- The following is a slightly adapted copy of openQuickNavWindow() ----
  let _spaces = spaces;
  let _activeSpaceId = activeSpaceId;
  let _jtree = jtree;
  let _activeJournalId = activeJournalId;

  async function refreshData(){
    if(typeof getData !== 'function') return;
    const d = await getData();
    if(!d || typeof d !== 'object') return;
    if(Array.isArray(d.spaces)) _spaces = d.spaces;
    if(typeof d.activeSpaceId === 'string' || d.activeSpaceId===null) _activeSpaceId = d.activeSpaceId;
    if(d.jtree && typeof d.jtree === 'object') _jtree = d.jtree;
    if(typeof d.activeJournalId === 'string' || d.activeJournalId===null) _activeJournalId = d.activeJournalId;
  }
  await refreshData();

  let defaultCollapsed = true;
  if(Object.prototype.hasOwnProperty.call(opts,'defaultCollapsed')) defaultCollapsed = !!opts.defaultCollapsed;
  else if(persistDefaultCollapsed && cfgGet){
    const raw = await cfgGet(cfgKeyDefaultCollapsed);
    defaultCollapsed = (raw===null || raw===undefined) ? true : !!raw;
  }

  let onlySpaces = [];
  let bySpaceId = {};
  let spaceChildren = {};
  let nodes = {};
  let topIds = [];
  const nodeById = (id)=>nodes[id] || null;
  const nodeTitle = (n)=>{
    if(!n) return '';
    if(n.title) return String(n.title);
    if(n.key) return String(n.key);
    return String(n.id||'');
  };

  function rebuildIndexes(){
    onlySpaces = (_spaces||[]).filter(s=>s && (s.kind==='space' || !s.kind));
    bySpaceId = Object.fromEntries(onlySpaces.map(s=>[s.id,s]));
    spaceChildren = {};
    for(const s of onlySpaces){
      const pid = s.parentId || null;
      if(!spaceChildren[pid]) spaceChildren[pid] = [];
      spaceChildren[pid].push(s);
    }
    for(const k of Object.keys(spaceChildren)){
      spaceChildren[k].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
    }
    nodes = (_jtree && _jtree.nodes) ? _jtree.nodes : {};
    topIds = (_jtree && Array.isArray(_jtree.topIds)) ? _jtree.topIds : [];
  }
  rebuildIndexes();

  const root = el('div', {className:'quicknav-panel'});

  // Header row (hint + toggle)
  const headerRow = el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px; margin:2px 0 6px;'});
  const hint = el('div', {className:'muted', textContent:'Швидка навігація.'});
  const btnDefaultCollapsed = el('button', {className:'btn btn-ghost', textContent:'▸', title:'Перемикає: гілки згорнуті/розгорнуті (і застосовує одразу)'});
  btnDefaultCollapsed.style.width = '38px';
  btnDefaultCollapsed.style.height = '38px';
  btnDefaultCollapsed.style.padding = '0';
  btnDefaultCollapsed.style.borderRadius = '999px';
  btnDefaultCollapsed.style.fontSize = '18px';
  btnDefaultCollapsed.style.lineHeight = '1';
  btnDefaultCollapsed.style.color = 'black';

  const defaultCollapsedState = { value: !!defaultCollapsed };
  const applyCollapsedVisual = ()=>{
    if(defaultCollapsedState.value){
      btnDefaultCollapsed.classList.add('treenav-toggle-on');
      btnDefaultCollapsed.textContent = '▸';
    }else{
      btnDefaultCollapsed.classList.remove('treenav-toggle-on');
      btnDefaultCollapsed.textContent = '▾';
    }
  };
  applyCollapsedVisual();
  headerRow.appendChild(hint);
  headerRow.appendChild(btnDefaultCollapsed);
  root.appendChild(headerRow);

  // Search row (optional)
  const searchRow = el('div', {style:'display:flex; gap:8px; align-items:center; margin:0 0 8px;'});
  const searchInput = el('input', {type:'search', placeholder:'Пошук (простір/журнал)…', className:'input'});
  searchInput.style.flex='1';
  searchInput.style.height='38px';
  const clearBtn = el('button', {className:'btn btn-ghost', textContent:'✕', title:'Очистити пошук'});
  clearBtn.style.width='38px'; clearBtn.style.height='38px'; clearBtn.style.padding='0';
  clearBtn.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); searchInput.value=''; renderTree(); if(showSearch) searchInput.focus(); };
  searchRow.appendChild(searchInput);
  searchRow.appendChild(clearBtn);
  if(showSearch){
    root.appendChild(searchRow);
  }else{
    // keep input for programmatic value injection later
    searchRow.style.display='none';
    root.appendChild(searchRow);
  }

  const treeWrap = el('div', {style:'max-height:38vh; overflow:auto; padding:6px 2px; border:1px solid rgba(0,0,0,0.08); border-radius:12px;'});
  root.appendChild(treeWrap);

  // Expanded state
  const expandedSpaces = new Set();
  const expandedJournals = new Set();
  const isExpanded = (set,id)=>set.has(id);
  const setExpanded = (set,id,v)=>{ if(v) set.add(id); else set.delete(id); };

  // Visible filters (search)
  let visibleSpaceIds=null;
  let visibleJournalIds=null;

  let selected = null; // {kind, id, path}

  const computeVisibleSets = ()=>{
    const q = norm(searchInput.value);
    if(!q){ visibleSpaceIds=null; visibleJournalIds=null; return; }
    // Journals: include matches + ancestors
    const vJ = new Set();
    const vS = new Set();
    // spaces
    for(const s of onlySpaces){
      if(norm(s.name).includes(q)){
        let cur=s;
        while(cur){ vS.add(cur.id); cur = cur.parentId ? bySpaceId[cur.parentId] : null; }
      }
    }
    // journals
    const addAnc = (id)=>{
      let cur = nodeById(id);
      while(cur){ vJ.add(cur.id); cur = cur.parentId ? nodeById(cur.parentId) : null; }
    };
    for(const id of Object.keys(nodes||{})){
      const n = nodeById(id);
      if(!n) continue;
      if(norm(nodeTitle(n)).includes(q)) addAnc(id);
    }
    visibleSpaceIds = vS.size ? vS : new Set();
    visibleJournalIds = vJ.size ? vJ : new Set();
  };

  const makeSpaceNode = (s, depth=0)=>{
    if(visibleSpaceIds && !visibleSpaceIds.has(s.id)) return [];
    const kidsAll = spaceChildren[s.id] || [];
    const kids = visibleSpaceIds ? kidsAll.filter(k=>visibleSpaceIds.has(k.id)) : kidsAll;
    if(!defaultCollapsedState.value && kids.length && !expandedSpaces.has(s.id)) expandedSpaces.add(s.id);

    const row = el('div', {style:`display:flex; gap:8px; align-items:center; padding:6px 8px; margin-left:${depth*14}px; border-radius:10px;`});
    const isActive = (s.id===_activeSpaceId);
    row.style.background = isActive ? 'rgba(0,200,0,0.12)' : '';
    const caret = mkCaret(!!kids.length, isExpanded(expandedSpaces, s.id), kids.length?'Згорнути/розгорнути':'');
    const b = el('button', {className:'btn', textContent:`📁 ${s.name}`});
    b.style.height='34px';
    b.onclick = async ()=>{
      selected = {kind:'space', id:s.id};
      if(mode==='pick' && onPick) await onPick({kind:'space', id:s.id});
      if(mode==='navigate' && onGoSpace) await onGoSpace(s.id);
      await refresh();
    };
    caret.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); setExpanded(expandedSpaces, s.id, !isExpanded(expandedSpaces,s.id)); renderTree(); };
    row.appendChild(caret);
    row.appendChild(b);

    // Add/delete buttons are disabled in transfer embedding by default.
    if(allowAdd){
      const addB = el('button', {className:'btn btn-ghost', textContent:'＋', title:'Додати'});
      addB.style.width='34px'; addB.style.height='34px'; addB.style.padding='0';
      addB.onclick = async (e)=>{ e.preventDefault(); e.stopPropagation(); onAddSpace && await onAddSpace(s.id); await refresh(); };
      row.appendChild(addB);
    }
    if(allowDelete){
      const delB = el('button', {className:'btn btn-ghost', textContent:'🗑', title:'Видалити'});
      delB.style.width='34px'; delB.style.height='34px'; delB.style.padding='0';
      delB.onclick = async (e)=>{ e.preventDefault(); e.stopPropagation(); onDeleteSpace && await onDeleteSpace(s.id); await refresh(); };
      row.appendChild(delB);
    }

    const out=[row];
    if(kids.length && isExpanded(expandedSpaces,s.id)){
      for(const k of kids) out.push(...makeSpaceNode(k, depth+1));
    }
    return out;
  };

  const makeJournalNode = (id, depth=0, path=[])=>{
    const n = nodeById(id);
    if(!n) return [];
    if(visibleJournalIds && !visibleJournalIds.has(id)) return [];
    const kidsAll = n.children || [];
    const kids = visibleJournalIds ? kidsAll.filter(cid=>visibleJournalIds.has(cid)) : kidsAll;
    if(!defaultCollapsedState.value && kids.length && !expandedJournals.has(id)) expandedJournals.add(id);

    const row = el('div', {style:`display:flex; gap:8px; align-items:center; padding:6px 8px; margin-left:${depth*14}px; border-radius:10px;`});
    const isActive = (id===_activeJournalId);
    row.style.background = isActive ? 'rgba(0,120,255,0.12)' : '';
    const caret = mkCaret(!!kids.length, isExpanded(expandedJournals,id), kids.length?'Згорнути/розгорнути':'');
    const title = nodeTitle(n);
    const b = el('button', {className:'btn', textContent:`📄 ${title}`});
    b.style.height='34px';
    const curPath = [...path, id];
    b.onclick = async ()=>{
      selected = {kind:'journal', id, path: curPath};
      if(mode==='pick' && onPick) await onPick({kind:'journal', id, path: curPath});
      if(mode==='navigate' && onGoJournalPath) await onGoJournalPath(curPath);
      // in embedded mode we keep it open
      await refresh();
    };
    caret.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); setExpanded(expandedJournals,id, !isExpanded(expandedJournals,id)); renderTree(); };
    row.appendChild(caret);
    row.appendChild(b);

    if(allowAdd){
      const addB = el('button', {className:'btn btn-ghost', textContent:'＋', title:'Додати піджурнал'});
      addB.style.width='34px'; addB.style.height='34px'; addB.style.padding='0';
      addB.onclick = async (e)=>{ e.preventDefault(); e.stopPropagation(); onAddJournalChild && await onAddJournalChild(curPath); await refresh(); };
      row.appendChild(addB);
    }
    if(allowDelete){
      const delB = el('button', {className:'btn btn-ghost', textContent:'🗑', title:'Видалити журнал'});
      delB.style.width='34px'; delB.style.height='34px'; delB.style.padding='0';
      delB.onclick = async (e)=>{ e.preventDefault(); e.stopPropagation(); onDeleteJournal && await onDeleteJournal(id); await refresh(); };
      row.appendChild(delB);
    }

    const out=[row];
    if(kids.length && isExpanded(expandedJournals,id)){
      for(const cid of kids) out.push(...makeJournalNode(cid, depth+1, curPath));
    }
    return out;
  };

  function applyDefaultExpandedState(){
    expandedSpaces.clear();
    expandedJournals.clear();
    if(!defaultCollapsedState.value){
      // expand everything that has kids
      for(const pid of Object.keys(spaceChildren)){
        for(const s of (spaceChildren[pid]||[])){
          if((spaceChildren[s.id]||[]).length) expandedSpaces.add(s.id);
        }
      }
      for(const id of Object.keys(nodes||{})){
        const n = nodeById(id);
        if(n && (n.children||[]).length) expandedJournals.add(id);
      }
    }
  }
  applyDefaultExpandedState();

  function renderTree(){
    rebuildIndexes();
    computeVisibleSets();
    treeWrap.innerHTML='';
    const frag = document.createDocumentFragment();
    if(showSpaces){
      const roots = spaceChildren[null] || [];
      for(const s of roots){
        const parts = makeSpaceNode(s, 0);
        for(const p of parts) frag.appendChild(p);
      }
    }
    if(showJournals){
      const roots = topIds || [];
      for(const jid of roots){
        const parts = makeJournalNode(jid, 0, []);
        for(const p of parts) frag.appendChild(p);
      }
    }
    treeWrap.appendChild(frag);
  }

  async function refresh(){
    await refreshData();
    rebuildIndexes();
    renderTree();
  }

  // events
  searchInput.addEventListener('input', ()=>renderTree());
  btnDefaultCollapsed.onclick = async (e)=>{
    e.preventDefault(); e.stopPropagation();
    defaultCollapsedState.value = !defaultCollapsedState.value;
    applyCollapsedVisual();
    applyDefaultExpandedState();
    if(persistDefaultCollapsed && cfgSet){
      try{ await cfgSet(cfgKeyDefaultCollapsed, defaultCollapsedState.value); }catch(_e){}
    }
    renderTree();
  };

  renderTree();

  return {
    root,
    api: {
      setSearch: (v)=>{ searchInput.value = String(v??''); renderTree(); },
      getSearch: ()=>String(searchInput.value||''),
      setDefaultCollapsed: async (v)=>{
        defaultCollapsedState.value = !!v;
        applyCollapsedVisual();
        applyDefaultExpandedState();
        if(persistDefaultCollapsed && cfgSet){
          try{ await cfgSet(cfgKeyDefaultCollapsed, defaultCollapsedState.value); }catch(_e){}
        }
        renderTree();
      },
      collapseAll: ()=>{ defaultCollapsedState.value=true; applyCollapsedVisual(); applyDefaultExpandedState(); renderTree(); },
      expandAll: ()=>{ defaultCollapsedState.value=false; applyCollapsedVisual(); applyDefaultExpandedState(); renderTree(); },
      refresh,
      getSelected: ()=>selected,
      setSelected: (sel)=>{ selected = sel; renderTree(); },
    }
  };
}
