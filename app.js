'use strict';

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

const GENRES = [
  ['Adventure','Adventure'],
  ['Mystery','Mystery'],
  ['Science Fiction','Science Fiction'],
  ['Horror','Horror'],
  ['Romance','Romance'],
  ['Poetry','Poetry'],
  ['History','History'],
  ['Biography','Biography'],
  ['Children','Children'],
  ['Humor','Humor']
];

const state = {
  bookCache: new Map(), coverCache: new Map(), wikiCache: new Map(),
  rows: new Map(), currentBook: null, currentChapter: 0,
  view: 'home', searchTimer: null, sleepTimer: null
};

const store = {
  get(key, fallback){ try{return JSON.parse(localStorage.getItem(`audiobox:${key}`)) ?? fallback}catch{return fallback} },
  set(key, value){ localStorage.setItem(`audiobox:${key}`, JSON.stringify(value)) },
  favorites(){ return this.get('favorites', []) },
  toggleFavorite(id){ const items=this.favorites(); const i=items.indexOf(String(id)); if(i>=0)items.splice(i,1);else items.unshift(String(id));this.set('favorites',items);return i<0 },
  progress(){ return this.get('progress', {}) },
  saveProgress(id, data){ const p=this.progress();p[String(id)]={...p[String(id)],...data,updatedAt:Date.now()};this.set('progress',p) },
  recent(){ return this.get('recent', []) },
  touchRecent(id){ const ids=this.recent().filter(x=>String(x)!==String(id));ids.unshift(String(id));this.set('recent',ids.slice(0,30)) }
};

function escapeHtml(s=''){ return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])) }
function stripHtml(s=''){ const d=document.createElement('div');d.innerHTML=s;return (d.textContent||'').replace(/\s+/g,' ').trim() }
function authorName(book){ const a=book?.authors?.[0];return a ? [a.first_name,a.last_name].filter(Boolean).join(' ') : 'Unknown author' }
function allAuthors(book){ return (book?.authors||[]).map(a=>[a.first_name,a.last_name].filter(Boolean).join(' ')).filter(Boolean).join(', ')||'Unknown author' }
function genreNames(book){ return (book?.genres||[]).map(g=>g.name).filter(Boolean) }
function parsePlaytime(s){ if(typeof s==='number')return s; const parts=String(s||'0').split(':').map(Number); if(parts.some(Number.isNaN))return Number(s)||0; return parts.reduce((acc,n)=>acc*60+n,0) }
function fmtTime(sec){ if(!Number.isFinite(sec)||sec<0)return '0:00';sec=Math.floor(sec);const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}` }
function compactRuntime(book){ const sec=book.totaltimesecs||0;if(!sec)return book.totaltime||'';const h=Math.floor(sec/3600),m=Math.round((sec%3600)/60);return h?`${h}h ${m}m`:`${m}m` }
function normalizedTitle(title=''){return title.toLowerCase().replace(/[\[(]?version\s*\d+[\])]?/gi,'').replace(/\s+/g,' ').trim()}
function editionScore(book){ const readers=new Set((book.sections||[]).flatMap(s=>(s.readers||[]).map(r=>r.reader_id||r.display_name)).filter(Boolean)); let score=0;if(readers.size===1)score+=100;if(readers.size>1)score+=Math.max(0,40-readers.size);score+=Math.min(30,(book.sections||[]).length/2);score+=Math.min(20,(Number(book.id)||0)/5000);return score }
function bestEditions(books){ const groups=new Map();for(const book of books){const key=`${normalizedTitle(book.title)}|${authorName(book).toLowerCase()}`;const old=groups.get(key);if(!old||editionScore(book)>editionScore(old))groups.set(key,book)}return [...groups.values()] }
function rememberBooks(books){ books.forEach(b=>state.bookCache.set(String(b.id),b));return books }

async function api(path, params={}){
  const qs=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!==null&&v!==''));
  const r=await fetch(`${path}?${qs}`);if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||`Request failed (${r.status})`);return r.json()
}
async function fetchBooks(params={}){ const {books}=await api('/api/librivox',params);return rememberBooks(books||[]) }

function fallbackMarkup(book){return `<div class="cover-fallback"><strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(authorName(book))}</span></div>`}
function getPrimaryCover(book){return book.coverart_jpg||book.coverart_thumbnail||''}
async function resolveCover(book){
  const primary=getPrimaryCover(book);if(primary)return primary;
  const key=`${book.title}|${authorName(book)}`;if(state.coverCache.has(key))return state.coverCache.get(key);
  try{const {results}=await api('/api/openlibrary',{q:`${book.title} ${authorName(book)}`,limit:1});const cover=results?.[0]?.cover||'';state.coverCache.set(key,cover);return cover}catch{state.coverCache.set(key,'');return ''}
}
function loadCover(img,book){
  const primary=getPrimaryCover(book); if(primary){img.src=primary;img.hidden=false;img.addEventListener('error',async()=>{img.onerror=null;const fallback=await resolveCover({...book,coverart_jpg:'',coverart_thumbnail:''});if(fallback)img.src=fallback;else img.hidden=true},{once:true});return}
  resolveCover(book).then(url=>{if(url){img.src=url;img.hidden=false}else img.hidden=true})
}

function progressFor(book){const p=store.progress()[String(book.id)];if(!p)return 0;const total=book.totaltimesecs||0;if(!total)return 0;const completedBefore=(book.sections||[]).slice(0,p.chapterIndex||0).reduce((n,s)=>n+parsePlaytime(s.playtime),0);return Math.min(100,((completedBefore+(p.time||0))/total)*100)}
function cardMarkup(book){ const prog=progressFor(book);return `<button class="card" data-book-id="${escapeHtml(book.id)}" aria-label="${escapeHtml(book.title)}">${fallbackMarkup(book)}<img data-cover-id="${escapeHtml(book.id)}" alt="Cover of ${escapeHtml(book.title)}" hidden /><div class="card-overlay"><strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(authorName(book))}</span></div>${prog>0?`<div class="progress-line"><i style="width:${prog.toFixed(1)}%"></i></div>`:''}</button>` }
function hydrateCovers(root=document){ $$('img[data-cover-id]',root).forEach(img=>{const b=state.bookCache.get(img.dataset.coverId);if(b)loadCover(img,b)}) }
function bindCards(root=document){ $$('[data-book-id]',root).forEach(el=>el.addEventListener('click',()=>openDetails(el.dataset.bookId))) }
function skeletons(n=8){return Array.from({length:n},()=>'<div class="card skeleton"></div>').join('')}

async function renderHome(){
  const view=$('#homeView');
  view.innerHTML=`<section class="hero"><div class="hero-bg"></div><div class="hero-content"><div class="eyebrow">Featured audiobook</div><h1>AudioBox</h1><div class="hero-author">Loading the library…</div><p class="hero-desc">Stories, classics, mysteries, history and more.</p></div></section><div class="content-rows"><section class="row"><div class="row-head"><h2>Loading</h2></div><div class="rail">${skeletons()}</div></section></div>`;
  try{
    const [featured,...rowResults]=await Promise.all([
      fetchBooks({genre:'Adventure',limit:12}),
      fetchBooks({genre:'Mystery',limit:16}),
      fetchBooks({genre:'Adventure',limit:16,offset:16}),
      fetchBooks({genre:'Science Fiction',limit:16}),
      fetchBooks({genre:'Horror',limit:16}),
      fetchBooks({genre:'Romance',limit:16})
    ]);
    const hero=bestEditions(featured)[0]||featured[0];
    const recent=await booksFromIds(Object.keys(store.progress()).sort((a,b)=>(store.progress()[b]?.updatedAt||0)-(store.progress()[a]?.updatedAt||0)).slice(0,14));
    const recentlyPlayed=await booksFromIds(store.recent().slice(0,14));
    const fav=await booksFromIds(store.favorites().slice(0,14));
    const rowDefs=[
      ...(recent.length?[['Continue Listening',recent]]:[]),
      ...(recentlyPlayed.length?[['Recently Played',recentlyPlayed]]:[]),
      ['Mysteries',bestEditions(rowResults[0])],['Adventure',bestEditions(rowResults[1])],['Science Fiction',bestEditions(rowResults[2])],['Dark & Supernatural',bestEditions(rowResults[3])],['Romance',bestEditions(rowResults[4])],
      ...(fav.length?[['My List',fav]]:[])
    ].filter(([,b])=>b.length);
    view.innerHTML=`${hero?heroMarkup(hero):''}<div class="content-rows">${rowDefs.map(([name,books])=>rowMarkup(name,books)).join('')}</div>`;
    if(hero) hydrateHero(view,hero);hydrateCovers(view);bindCards(view);bindHomeActions(view);
  }catch(err){view.innerHTML=errorMarkup('The library could not be loaded',err.message)}
}
function heroMarkup(book){return `<section class="hero" data-hero-id="${book.id}"><div class="hero-bg"></div><div class="hero-content"><div class="eyebrow">Featured audiobook</div><h1>${escapeHtml(book.title)}</h1><div class="hero-author">${escapeHtml(allAuthors(book))} · ${escapeHtml(compactRuntime(book))}</div><p class="hero-desc">${escapeHtml(stripHtml(book.description)||'Press play to begin listening.')}</p><div class="hero-actions"><button class="btn primary" data-hero-play>▶ Play</button><button class="btn secondary" data-hero-info>ⓘ More Info</button></div></div></section>`}
async function hydrateHero(root,book){const hero=$('.hero',root),bg=$('.hero-bg',hero);const cover=await resolveCover(book);if(cover)bg.style.backgroundImage=`url("${cover.replace(/"/g,'')}")`}
function bindHomeActions(root){const hero=$('[data-hero-id]',root);if(!hero)return;const id=hero.dataset.heroId;$('[data-hero-play]',hero)?.addEventListener('click',()=>playBook(id));$('[data-hero-info]',hero)?.addEventListener('click',()=>openDetails(id))}
function rowMarkup(name,books){return `<section class="row"><div class="row-head"><h2>${escapeHtml(name)}</h2></div><div class="rail">${books.map(cardMarkup).join('')}</div></section>`}
function errorMarkup(title,msg){return `<div class="error-box"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(msg||'Try again in a moment.')}</p><button class="btn secondary" onclick="location.reload()">Retry</button></div>`}

async function booksFromIds(ids){ const missing=ids.filter(id=>!state.bookCache.has(String(id))); const batches=await Promise.all(missing.slice(0,20).map(id=>fetchBooks({id,limit:1}).catch(()=>[])));batches.flat().forEach(b=>state.bookCache.set(String(b.id),b));return ids.map(id=>state.bookCache.get(String(id))).filter(Boolean) }

function renderBrowse(){
  const view=$('#browseView');view.innerHTML=`<div class="browse-hero"><h1>Browse</h1><p class="subtext">Pick a shelf and browse the catalog. Audio starts directly in the AudioBox player.</p><div class="genre-pills">${GENRES.map(([label,value])=>`<button class="pill" data-genre="${escapeHtml(value)}">${escapeHtml(label)}</button>`).join('')}</div></div><div id="browseBody"><div class="grid">${skeletons(18)}</div></div>`;
  $$('.pill',view).forEach(btn=>btn.addEventListener('click',()=>loadGenre(btn.dataset.genre,btn)));
  loadGenre('Adventure',$('.pill',view));
}
async function loadGenre(genre,button){
  $$('.pill',$('#browseView')).forEach(x=>x.classList.toggle('active',x===button));const body=$('#browseBody');body.innerHTML=`<div class="grid">${skeletons(18)}</div>`;
  try{const books=bestEditions(await fetchBooks({genre,limit:40}));body.innerHTML=books.length?`<div class="grid">${books.map(cardMarkup).join('')}</div>`:`<div class="empty"><strong>No shelf found</strong>Try another category.</div>`;hydrateCovers(body);bindCards(body)}catch(err){body.innerHTML=errorMarkup(`Couldn't load ${genre}`,err.message)}
}

async function renderMyList(){
  const view=$('#myListView');view.innerHTML=`<div class="list-hero"><h1>My List</h1><p class="subtext">Saved only on this device. No account required.</p></div><div class="grid">${skeletons(10)}</div>`;
  const books=await booksFromIds(store.favorites());view.innerHTML=`<div class="list-hero"><h1>My List</h1><p class="subtext">Saved only on this device. No account required.</p></div>${books.length?`<div class="grid">${books.map(cardMarkup).join('')}</div>`:`<div class="empty"><strong>Your list is empty.</strong>Add books with the + button and they'll stay here on this device.</div>`}`;hydrateCovers(view);bindCards(view)
}

async function openDetails(id){
  let book=state.bookCache.get(String(id));if(!book){const arr=await fetchBooks({id,limit:1});book=arr[0]}if(!book)return;state.currentBook=book;
  const modal=$('#modalBackdrop'),content=$('#detailContent');content.innerHTML='<div style="min-height:480px;display:grid;place-items:center"><div class="loader"></div></div>';modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';
  const fav=store.favorites().includes(String(book.id)), cover=await resolveCover(book), author=authorName(book);const wiki=await getWiki(author);
  content.innerHTML=`<section class="detail-hero"><div class="detail-hero-bg" ${cover?`style="background-image:url('${escapeHtml(cover)}')"`:''}></div><div class="detail-hero-copy"><h2 id="detailTitle">${escapeHtml(book.title)}</h2><div class="detail-sub">${escapeHtml(allAuthors(book))} · ${escapeHtml(compactRuntime(book))} · ${book.num_sections||book.sections.length} chapters</div><div class="detail-actions"><button class="btn primary" data-detail-play>▶ ${progressFor(book)>0?'Resume':'Play'}</button><button class="circle-btn ${fav?'active':''}" data-favorite title="Add to My List">${fav?'✓':'+'}</button></div></div></section><section class="detail-body"><div class="detail-description">${escapeHtml(stripHtml(book.description)||'No description is available for this recording.')}</div><div class="meta-list"><div><b>Author:</b> ${escapeHtml(allAuthors(book))}</div><div><b>Genres:</b> ${escapeHtml(genreNames(book).join(', ')||'Audiobook')}</div><div><b>Language:</b> ${escapeHtml(book.language||'Unknown')}</div>${book.copyright_year?`<div><b>Year:</b> ${escapeHtml(book.copyright_year)}</div>`:''}<div><b>Recording:</b> ${uniqueReaders(book).length===1?'Single narrator':`${uniqueReaders(book).length||'Multiple'} readers`}</div></div></section>${chaptersMarkup(book)}${authorMarkup(author,wiki,book)}`;
  $('[data-detail-play]',content)?.addEventListener('click',()=>playBook(book.id));$('[data-favorite]',content)?.addEventListener('click',e=>{const added=store.toggleFavorite(book.id);e.currentTarget.textContent=added?'✓':'+';e.currentTarget.classList.toggle('active',added);toast(added?'Added to My List':'Removed from My List')});$$('[data-chapter]',content).forEach(btn=>btn.addEventListener('click',()=>playBook(book.id,Number(btn.dataset.chapter))));
}
function uniqueReaders(book){const m=new Map();(book.sections||[]).forEach(s=>(s.readers||[]).forEach(r=>m.set(String(r.reader_id||r.display_name),r.display_name||'Reader')));return [...m.values()]}
function chaptersMarkup(book){return `<section class="chapters"><div class="chapters-head"><h3>Chapters</h3><span>${book.sections.length}</span></div><div class="chapter-list">${book.sections.map((s,i)=>`<button class="chapter" data-chapter="${i}"><span class="chapter-num">${i+1}</span><span><strong>${escapeHtml(s.title||`Chapter ${i+1}`)}</strong><small>${escapeHtml((s.readers||[]).map(r=>r.display_name).filter(Boolean).join(', '))}</small></span><span class="chapter-time">${fmtTime(parsePlaytime(s.playtime))}</span></button>`).join('')}</div></section>`}
function authorMarkup(author,wiki,book){return `<section class="author-box"><div class="author-card">${wiki?.image?`<img src="${escapeHtml(wiki.image)}" alt="${escapeHtml(author)}" />`:'<div style="width:82px;height:82px;border-radius:50%;background:#2a2a2a"></div>'}<div><h3>${escapeHtml(wiki?.title||author)}</h3><p>${escapeHtml(wiki?.extract||`More audiobooks by ${author} may be available throughout the catalog.`)}</p><div class="text-links">${book.url_text_source?`<a class="text-link" target="_blank" rel="noopener" href="${escapeHtml(book.url_text_source)}">Read source text ↗</a>`:''}${book.url_librivox?`<a class="text-link" target="_blank" rel="noopener" href="${escapeHtml(book.url_librivox)}">Recording details ↗</a>`:''}${book.url_zip_file?`<a class="text-link" target="_blank" rel="noopener" href="${escapeHtml(book.url_zip_file)}">Download audiobook ↗</a>`:''}${wiki?.url?`<a class="text-link" target="_blank" rel="noopener" href="${escapeHtml(wiki.url)}">Author biography ↗</a>`:''}</div></div></div></section>`}
async function getWiki(name){if(!name||name==='Unknown author')return null;if(state.wikiCache.has(name))return state.wikiCache.get(name);try{const {author}=await api('/api/wikipedia',{name});state.wikiCache.set(name,author);return author}catch{return null}}
function closeModal(){const m=$('#modalBackdrop');m.classList.remove('open');m.setAttribute('aria-hidden','true');document.body.style.overflow=''}

async function playBook(id,chapterIndex){
  let book=state.bookCache.get(String(id));if(!book){book=(await fetchBooks({id,limit:1}))[0]}if(!book||!book.sections?.length){toast('No playable chapters found');return}
  state.currentBook=book;const saved=store.progress()[String(book.id)]||{};state.currentChapter=Number.isInteger(chapterIndex)?chapterIndex:Math.min(saved.chapterIndex||0,book.sections.length-1);store.touchRecent(book.id);await loadChapter(saved.time||0,chapterIndex===undefined);closeModal();
}
async function loadChapter(startAt=0,resume=false){
  const book=state.currentBook,section=book.sections[state.currentChapter];if(!section?.listen_url){toast('This chapter has no audio source');return}
  const audio=$('#audio');audio.src=section.listen_url;audio.playbackRate=Number(store.get('speed',1));audio.volume=Number(store.get('volume',.9));$('#speedBtn').textContent=`${audio.playbackRate}×`;$('#volume').value=audio.volume;
  $('#playerTitle').textContent=book.title;$('#playerChapter').textContent=section.title||`Chapter ${state.currentChapter+1}`;const cover=await resolveCover(book);$('#playerCover').src=cover||'';$('#player').classList.add('show');$('#player').setAttribute('aria-hidden','false');
  if('mediaSession' in navigator){try{navigator.mediaSession.metadata=new MediaMetadata({title:section.title||book.title,artist:allAuthors(book),album:book.title,artwork:cover?[{src:cover}]:[]})}catch{}}
  const onMeta=()=>{if(resume&&startAt>0&&startAt<audio.duration-10)audio.currentTime=startAt;audio.play().catch(()=>{});audio.removeEventListener('loadedmetadata',onMeta)};audio.addEventListener('loadedmetadata',onMeta);audio.load();markPlayingChapter();
}
function markPlayingChapter(){ $$('.chapter').forEach((c,i)=>c.classList.toggle('playing',state.currentBook&&Number(c.dataset.chapter)===state.currentChapter)) }
function saveCurrentProgress(){const audio=$('#audio'),book=state.currentBook;if(!book||!audio.src)return;store.saveProgress(book.id,{chapterIndex:state.currentChapter,time:audio.currentTime||0,duration:audio.duration||0})}
function nextChapter(delta=1){const b=state.currentBook;if(!b)return;const next=state.currentChapter+delta;if(next<0||next>=b.sections.length){if(next>=b.sections.length)toast('Finished');return}saveCurrentProgress();state.currentChapter=next;loadChapter(0,false)}

function setupPlayer(){
  const audio=$('#audio'),play=$('#playToggle'),seek=$('#seek');
  play.addEventListener('click',()=>{if(!audio.src)return;if(audio.paused)audio.play();else audio.pause()});audio.addEventListener('play',()=>play.textContent='❚❚');audio.addEventListener('pause',()=>play.textContent='▶');
  audio.addEventListener('timeupdate',()=>{if(Number.isFinite(audio.duration)&&audio.duration>0){seek.value=Math.round((audio.currentTime/audio.duration)*1000);$('#currentTime').textContent=fmtTime(audio.currentTime);$('#duration').textContent=fmtTime(audio.duration)} if(Math.floor(audio.currentTime)%5===0)saveCurrentProgress()});
  audio.addEventListener('ended',()=>nextChapter(1));seek.addEventListener('input',()=>{if(audio.duration)audio.currentTime=(Number(seek.value)/1000)*audio.duration});$('#prevChapter').addEventListener('click',()=>nextChapter(-1));$('#nextChapter').addEventListener('click',()=>nextChapter(1));
  $('#volume').addEventListener('input',e=>{audio.volume=Number(e.target.value);store.set('volume',audio.volume)});$('#speedBtn').addEventListener('click',()=>{const speeds=[.75,1,1.25,1.5,1.75,2],current=speeds.indexOf(audio.playbackRate),next=speeds[(current+1)%speeds.length];audio.playbackRate=next;store.set('speed',next);$('#speedBtn').textContent=`${next}×`;toast(`Playback speed ${next}×`)});
  $('#sleepBtn').addEventListener('click',()=>{const options=[15,30,45,60,0],current=Number($('#sleepBtn').dataset.minutes||0),next=options[(options.indexOf(current)+1)%options.length];clearTimeout(state.sleepTimer);$('#sleepBtn').dataset.minutes=next;$('#sleepBtn').textContent=next?`${next}m`:'☾';if(next){state.sleepTimer=setTimeout(()=>{audio.pause();$('#sleepBtn').textContent='☾';$('#sleepBtn').dataset.minutes=0;toast('Sleep timer ended')},next*60*1000);toast(`Sleep timer: ${next} minutes`)}else toast('Sleep timer off')});
  $('#playerExpand').addEventListener('click',()=>state.currentBook&&openDetails(state.currentBook.id));window.addEventListener('beforeunload',saveCurrentProgress);
}

function setupSearch(){
  const panel=$('#searchPanel'),input=$('#searchInput');const open=()=>{panel.classList.add('open');panel.setAttribute('aria-hidden','false');setTimeout(()=>input.focus(),50)},close=()=>{panel.classList.remove('open');panel.setAttribute('aria-hidden','true');input.blur()};$('#searchToggle').addEventListener('click',open);$('#searchClose').addEventListener('click',close);document.addEventListener('keydown',e=>{if(e.key==='Escape'){if($('#modalBackdrop').classList.contains('open'))closeModal();else if(panel.classList.contains('open'))close()}});
  input.addEventListener('input',()=>{clearTimeout(state.searchTimer);const q=input.value.trim();if(q.length<2){$('#searchResults').innerHTML='';$('#searchMeta').textContent='Search the AudioBox catalog';return}$('#searchMeta').textContent='Searching…';state.searchTimer=setTimeout(()=>runSearch(q),300)});
}
async function runSearch(q){
  const results=$('#searchResults');results.innerHTML=skeletons(10);try{const [titles,authors]=await Promise.all([fetchBooks({title:q,limit:25}),fetchBooks({author:q,limit:25}).catch(()=>[])]);const books=bestEditions([...titles,...authors].filter((b,i,a)=>a.findIndex(x=>x.id===b.id)===i));$('#searchMeta').textContent=books.length?`${books.length} result${books.length===1?'':'s'} for “${q}”`:`No results for “${q}”`;results.innerHTML=books.map(cardMarkup).join('');hydrateCovers(results);bindCards(results)}catch(err){$('#searchMeta').textContent=err.message;results.innerHTML=''}
}

function navigate(view){state.view=view;$$('.view').forEach(v=>v.classList.remove('active'));$(`#${view==='mylist'?'myList':view}View`).classList.add('active');$$('.navlink').forEach(n=>n.classList.toggle('active',n.dataset.nav===view));if(view==='browse'&&!$('#browseView').dataset.loaded){$('#browseView').dataset.loaded='1';renderBrowse()}if(view==='mylist')renderMyList();window.scrollTo({top:0,behavior:'smooth'})}
function setupNav(){$$('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.nav)));window.addEventListener('scroll',()=>$('#topbar').classList.toggle('scrolled',scrollY>24));$('#modalClose').addEventListener('click',closeModal);$('#modalBackdrop').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal()})}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._timer);t._timer=setTimeout(()=>t.classList.remove('show'),1900)}

function setupPlatformFeatures(){
  if('mediaSession' in navigator){
    const handlers={play:()=>$('#audio').play(),pause:()=>$('#audio').pause(),previoustrack:()=>nextChapter(-1),nexttrack:()=>nextChapter(1),seekbackward:d=>{$('#audio').currentTime=Math.max(0,$('#audio').currentTime-(d.seekOffset||15))},seekforward:d=>{$('#audio').currentTime=Math.min($('#audio').duration||Infinity,$('#audio').currentTime+(d.seekOffset||15))}};
    for(const [action,fn] of Object.entries(handlers)){try{navigator.mediaSession.setActionHandler(action,fn)}catch{}}
  }
  if('serviceWorker' in navigator && location.protocol!=='file:') navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
async function init(){setupNav();setupSearch();setupPlayer();setupPlatformFeatures();await renderHome()}
init();
