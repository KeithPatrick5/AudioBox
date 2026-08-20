'use strict';

const LIBEX_ORIGINS = [
  'https://libexdb.com',
  'https://libex.lostcartographer.xyz'
];

const IA_SEARCH = 'https://archive.org/advancedsearch.php';
const IA_IMAGE = 'https://archive.org/services/img/';
const IA_DETAILS = 'https://archive.org/details/';

const CURATED = [
  ['Dracula','Bram Stoker','Popular & Playable',['Horror','Classics']],
  ['Frankenstein','Mary Shelley','Popular & Playable',['Horror','Science Fiction']],
  ['The Adventures of Sherlock Holmes','Arthur Conan Doyle','Popular & Playable',['Mystery','Classics']],
  ['The Count of Monte Cristo','Alexandre Dumas','Popular & Playable',['Adventure','Classics']],
  ['The Picture of Dorian Gray','Oscar Wilde','Popular & Playable',['Horror','Classics']],
  ['The War of the Worlds','H. G. Wells','Popular & Playable',['Science Fiction','Classics']],
  ['Treasure Island','Robert Louis Stevenson','Popular & Playable',['Adventure','Classics']],
  ["Alice's Adventures in Wonderland",'Lewis Carroll','Popular & Playable',['Fantasy','Children']],
  ['Pride and Prejudice','Jane Austen','Popular & Playable',['Romance','Classics']],
  ['Moby Dick','Herman Melville','Popular & Playable',['Adventure','Classics']],

  ['The Hound of the Baskervilles','Arthur Conan Doyle','Mystery & Suspense',['Mystery']],
  ['The Moonstone','Wilkie Collins','Mystery & Suspense',['Mystery']],
  ['The Woman in White','Wilkie Collins','Mystery & Suspense',['Mystery']],
  ['The Murders in the Rue Morgue','Edgar Allan Poe','Mystery & Suspense',['Mystery','Horror']],
  ['The Turn of the Screw','Henry James','Mystery & Suspense',['Horror']],
  ['The Legend of Sleepy Hollow','Washington Irving','Mystery & Suspense',['Horror']],
  ['Heart of Darkness','Joseph Conrad','Mystery & Suspense',['Classics']],
  ['The Strange Case of Dr Jekyll and Mr Hyde','Robert Louis Stevenson','Mystery & Suspense',['Horror']],

  ['The Time Machine','H. G. Wells','Sci-Fi & Horror',['Science Fiction']],
  ['The Invisible Man','H. G. Wells','Sci-Fi & Horror',['Science Fiction']],
  ['Twenty Thousand Leagues Under the Sea','Jules Verne','Sci-Fi & Horror',['Science Fiction','Adventure']],
  ['The Island of Doctor Moreau','H. G. Wells','Sci-Fi & Horror',['Science Fiction','Horror']],
  ['The Metamorphosis','Franz Kafka','Sci-Fi & Horror',['Classics']],
  ['The Phantom of the Opera','Gaston Leroux','Sci-Fi & Horror',['Horror']],
  ['The House on the Borderland','William Hope Hodgson','Sci-Fi & Horror',['Horror','Science Fiction']],
  ['The Lost World','Arthur Conan Doyle','Sci-Fi & Horror',['Adventure','Science Fiction']],

  ['Around the World in Eighty Days','Jules Verne','Adventure',['Adventure']],
  ['The Call of the Wild','Jack London','Adventure',['Adventure']],
  ['White Fang','Jack London','Adventure',['Adventure']],
  ['The Adventures of Tom Sawyer','Mark Twain','Adventure',['Adventure']],
  ['Adventures of Huckleberry Finn','Mark Twain','Adventure',['Adventure']],
  ['Robinson Crusoe','Daniel Defoe','Adventure',['Adventure']],
  ['The Three Musketeers','Alexandre Dumas','Adventure',['Adventure']],
  ['Kidnapped','Robert Louis Stevenson','Adventure',['Adventure']],

  ['Jane Eyre','Charlotte Brontë','Classic Literature',['Classics','Romance']],
  ['Wuthering Heights','Emily Brontë','Classic Literature',['Classics','Romance']],
  ['Little Women','Louisa May Alcott','Classic Literature',['Classics']],
  ['Great Expectations','Charles Dickens','Classic Literature',['Classics']],
  ['A Christmas Carol','Charles Dickens','Classic Literature',['Classics']],
  ['Crime and Punishment','Fyodor Dostoevsky','Classic Literature',['Classics']],
  ['The Brothers Karamazov','Fyodor Dostoevsky','Classic Literature',['Classics']],
  ['Anna Karenina','Leo Tolstoy','Classic Literature',['Classics']],
  ['Anne of Green Gables','Lucy Maud Montgomery','Classic Literature',['Classics']],
  ['The Secret Garden','Frances Hodgson Burnett','Classic Literature',['Classics']]
];

function clean(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function clamp(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function arr(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function text(value) { return arr(value).filter(Boolean).join(' '); }
function norm(value='') {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\([^)]*\)|\[[^\]]*\]/g,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\b(a|an|the|version|edition|audiobook|audio book|vol|volume)\b/g,' ')
    .replace(/\s+/g,' ').trim();
}
function titleScore(target, candidate) {
  const a=norm(target),b=norm(candidate);if(!a||!b)return 0;if(a===b)return 100;if(a.includes(b)||b.includes(a))return 72;
  const A=new Set(a.split(' ').filter(x=>x.length>2)),B=new Set(b.split(' ').filter(x=>x.length>2));
  const common=[...A].filter(x=>B.has(x)).length;return A.size?common/A.size*60:0;
}

async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'AudioBox/3.0 (+https://github.com/KeithPatrick5/AudioBox)' }
    });
    if (!response.ok) {
      const body = await response.text().catch(()=>'');
      const err = new Error(`Upstream returned ${response.status}${body?`: ${body.slice(0,120)}`:''}`);
      err.status = response.status;
      throw err;
    }
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function libex(path, params={}) {
  const query = new URLSearchParams({ region:'us' });
  for (const [k,v] of Object.entries(params)) if (v!==undefined && v!==null && v!=='') query.set(k,String(v));
  const attempts = LIBEX_ORIGINS.map(origin => fetchJson(`${origin}${path}?${query}`));
  try { return await Promise.any(attempts); }
  catch (group) { throw group?.errors?.[0] || new Error('Libex is unavailable'); }
}

function names(items) {
  return (Array.isArray(items)?items:[]).map(x=>typeof x==='string'?x:x?.name).filter(Boolean);
}
function normalizeBook(raw={}) {
  const asin=clean(raw.asin,32);if(!asin)return null;
  const genres=(Array.isArray(raw.genres)?raw.genres:[]).map(g=>({name:clean(g?.name||g,120),type:clean(g?.type,40)})).filter(g=>g.name);
  return {
    id:asin,asin,source:'libex',title:clean(raw.title,300)||'Untitled',subtitle:clean(raw.subtitle,300),
    description:clean(raw.summary||raw.description,12000),authors:names(raw.authors),narrators:names(raw.narrators),
    genres:genres.map(g=>g.name),genreDetails:genres,
    series:(Array.isArray(raw.series)?raw.series:[]).map(s=>({asin:clean(s?.asin,32),name:clean(s?.name,200),position:clean(s?.position,40)})).filter(s=>s.name),
    publisher:clean(raw.publisher,240),copyright:clean(raw.copyright,100),isbn:clean(raw.isbn,40),language:clean(raw.language,80),
    rating:Number.isFinite(Number(raw.rating))?Number(raw.rating):null,releaseDate:clean(raw.releaseDate,40),cover:clean(raw.imageUrl,2000),
    durationMinutes:Number.isFinite(Number(raw.lengthMinutes))?Number(raw.lengthMinutes):0,link:clean(raw.link,2000),
    isListenable:Boolean(raw.isListenable),isAvailable:Boolean(raw.isAvailable),isBuyable:Boolean(raw.isBuyable),isVvab:Boolean(raw.isVvab),plans:Array.isArray(raw.plans)?raw.plans.filter(Boolean).slice(0,20):[]
  };
}
function normalizeList(payload) {
  const list=Array.isArray(payload)?payload:Array.isArray(payload?.books)?payload.books:Array.isArray(payload?.matches)?payload.matches:[];
  const seen=new Set();return list.map(normalizeBook).filter(b=>{if(!b||seen.has(b.asin))return false;seen.add(b.asin);return true;});
}
async function searchBooks(params){return normalizeList(await libex('/search',params));}

function archiveBook(entry, doc) {
  const [canonical, fallbackAuthor, shelf, genres] = entry;
  const identifier=String(doc.identifier||'');
  const creator=text(doc.creator)||fallbackAuthor;
  return {
    id:`ia:${identifier}`,source:'archive',playbackIdentifier:identifier,
    title:clean(Array.isArray(doc.title)?doc.title[0]:doc.title,300)||canonical,subtitle:'',
    description:clean(text(doc.description),3000),authors:[creator],narrators:[],genres,genreDetails:[],series:[],
    publisher:'LibriVox / Internet Archive',copyright:'Public domain recording',isbn:'',language:clean(text(doc.language),80)||'English',
    rating:null,releaseDate:clean(Array.isArray(doc.date)?doc.date[0]:doc.date,40),cover:`${IA_IMAGE}${encodeURIComponent(identifier)}`,
    durationMinutes:0,link:`${IA_DETAILS}${encodeURIComponent(identifier)}`,isListenable:true,isAvailable:true,isBuyable:false,isVvab:false,plans:[],
    downloads:Number(doc.downloads||0),homeShelf:shelf
  };
}

async function playableHome() {
  const phrases = CURATED.map(([title]) => `title:\"${String(title).replace(/\"/g,'')}\"`).join(' OR ');
  const q = `collection:librivoxaudio AND mediatype:audio AND (${phrases})`;
  const params=new URLSearchParams({q,rows:'200',page:'1',output:'json'});
  for(const field of ['identifier','title','creator','description','language','date','downloads']) params.append('fl[]',field);
  params.append('sort[]','downloads desc');
  const payload=await fetchJson(`${IA_SEARCH}?${params}`,9000);
  const docs=payload?.response?.docs||[];
  if(!docs.length)throw new Error('Playable audiobook inventory is unavailable');

  const chosen=[];
  for(const entry of CURATED){
    const [title,expectedAuthor]=entry;
    const surname=expectedAuthor.toLowerCase().split(/\s+/).pop();
    const ranked=docs.map(doc=>{
      let score=titleScore(title,Array.isArray(doc.title)?doc.title[0]:doc.title);
      const c=text(doc.creator).toLowerCase();if(surname&&c.includes(surname))score+=24;
      score+=Math.min(12,Math.log10(Math.max(1,Number(doc.downloads||1)))*2.4);
      return {doc,score};
    }).filter(x=>x.score>=72).sort((a,b)=>b.score-a.score);
    if(ranked[0])chosen.push(archiveBook(entry,ranked[0].doc));
  }

  const unique=[...new Map(chosen.map(b=>[b.playbackIdentifier,b])).values()];
  if(!unique.length)throw new Error('No confirmed playable titles were found');
  const order=['Popular & Playable','Mystery & Suspense','Sci-Fi & Horror','Adventure','Classic Literature'];
  const rows=order.map(name=>({name,books:unique.filter(b=>b.homeShelf===name)})).filter(r=>r.books.length);
  const hero=unique.find(b=>norm(b.title)===norm('Dracula'))||rows[0]?.books?.[0]||unique[0];
  return {hero,rows,provider:'Internet Archive / LibriVox confirmed playback',playableOnly:true};
}

function cache(res,seconds,stale=86400){res.setHeader('Cache-Control',`public, s-maxage=${seconds}, stale-while-revalidate=${stale}`);}

module.exports = async function handler(req,res) {
  const mode=clean(req.query?.mode||'home',20).toLowerCase();
  try {
    if(mode==='home'){
      cache(res,43200,172800);
      return res.status(200).json(await playableHome());
    }
    if(mode==='search'){
      const q=clean(req.query?.q,160);if(!q)return res.status(200).json({books:[]});
      const books=await searchBooks({keywords:q,products_sort_by:'Relevance',limit:clamp(req.query?.limit,1,50,40),page:clamp(req.query?.page,0,9,0)});
      cache(res,900,86400);return res.status(200).json({books});
    }
    if(mode==='genre'){
      const genre=clean(req.query?.genre,120);
      const books=await searchBooks({...genre?{keywords:genre}:{},products_sort_by:'BestSellers',limit:clamp(req.query?.limit,1,50,50),page:clamp(req.query?.page,0,9,0)});
      cache(res,3600,86400);return res.status(200).json({books});
    }
    if(mode==='book'){
      const asin=clean(req.query?.asin,20).toUpperCase();if(!/^[A-Z0-9]{10}$/.test(asin))return res.status(400).json({error:'Invalid audiobook ID.'});
      const payload=await libex(`/book/${encodeURIComponent(asin)}`,{});const book=normalizeBook(payload);cache(res,86400,604800);return res.status(200).json({book});
    }
    return res.status(400).json({error:'Unknown catalog request.'});
  } catch(error) {
    const status=error?.status===404?404:502;
    return res.status(status).json({error:status===404?'No audiobooks found.':'The audiobook catalog is temporarily unavailable.',detail:error?.message||'Unknown error'});
  }
};
