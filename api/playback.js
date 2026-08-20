'use strict';

const IA_SEARCH = 'https://archive.org/advancedsearch.php';
const IA_META = 'https://archive.org/metadata/';
const IA_DOWNLOAD = 'https://archive.org/download/';
const IA_DETAILS = 'https://archive.org/details/';

function clean(value, max = 300) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function safeIdentifier(value='') {
  const id=clean(value,180);
  return /^[A-Za-z0-9._-]+$/.test(id) ? id : '';
}
function safeLucene(value = '') {
  return String(value).replace(/[\\+\-!(){}\[\]^"~*?:/]/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalize(value = '') {
  return String(value).toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(a|an|the|unabridged|abridged|audiobook|audio|book|version|edition)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function asArray(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function text(value) { return asArray(value).filter(Boolean).join(' '); }
function parseLength(value) {
  if (typeof value === 'number') return value;
  const s = String(value || '').trim();
  if (!s) return 0;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((n, p) => n * 60 + p, 0);
}

async function fetchJson(url, timeoutMs = 4200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'AudioBox/3.0 playback-hunter' }
    });
    if (!response.ok) throw new Error(`Upstream ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function titleScore(targetTitle, candidateTitle) {
  const target = normalize(targetTitle), got = normalize(candidateTitle);
  if (!target || !got) return 0;
  if (target === got) return 100;
  if (got.includes(target) || target.includes(got)) return 68;
  const a = new Set(target.split(' ').filter(x => x.length > 2));
  const b = new Set(got.split(' ').filter(x => x.length > 2));
  const common = [...a].filter(x => b.has(x)).length;
  return a.size ? (common / a.size) * 58 : 0;
}
function candidateScore(book, doc) {
  let score = titleScore(book.title, Array.isArray(doc.title) ? doc.title[0] : doc.title);
  const creator = text(doc.creator).toLowerCase();
  const surnames = String(book.author || '').toLowerCase().split(/[,;&]/).flatMap(x => x.trim().split(/\s+/).slice(-1)).filter(Boolean);
  if (surnames.some(name => name.length > 2 && creator.includes(name))) score += 38;
  score += Math.min(14, Math.log10(Math.max(1, Number(doc.downloads || 1))) * 3);
  return score;
}
async function iaSearch(query, rows = 8) {
  const params = new URLSearchParams({ q: query, rows: String(rows), page: '1', output: 'json' });
  for (const field of ['identifier', 'title', 'creator', 'downloads', 'collection', 'subject', 'description']) params.append('fl[]', field);
  params.append('sort[]', 'downloads desc');
  const payload = await fetchJson(`${IA_SEARCH}?${params.toString()}`, 3600);
  return payload?.response?.docs || [];
}
function audioFiles(files) {
  const all = (Array.isArray(files) ? files : []).filter(f =>
    f?.name && !f.private && /MP3/i.test(String(f.format || '')) && !/sample|preview|spectrogram/i.test(String(f.name))
  );
  const preferred = [
    all.filter(f => /VBR MP3/i.test(String(f.format || ''))),
    all.filter(f => /128Kbps MP3/i.test(String(f.format || ''))),
    all.filter(f => /64Kbps MP3/i.test(String(f.format || ''))),
    all
  ].find(group => group.length) || [];
  const seen = new Set();
  return preferred.filter(f => {
    const stem = String(f.name).toLowerCase().replace(/(?:_64kb|_128kb)?\.mp3$/, '');
    if (seen.has(stem)) return false;
    seen.add(stem);
    return true;
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
}
function openlyPlayable(metadata = {}) {
  const collection = text(metadata.collection).toLowerCase();
  const license = String(metadata.licenseurl || '').toLowerCase();
  const rights = `${text(metadata.rights)} ${text(metadata.description)} ${text(metadata.subject)}`.toLowerCase();
  if (collection.includes('librivoxaudio') || collection.includes('audio_bookspoetry')) return true;
  if (/creativecommons\.org\/licenses\//.test(license) || /publicdomain|public domain|creativecommons\.org\/publicdomain/.test(license)) return true;
  if (/\bpublic domain\b|\blibrivox\b|creative commons|\bcc by\b|\bcc0\b/.test(rights)) return true;
  return false;
}
function metadataToPlayback(payload, identifier, provider, score, expectedMinutes) {
  const md = payload?.metadata || {};
  if (!openlyPlayable(md)) return null;
  const files = audioFiles(payload?.files || []);
  if (!files.length) return null;
  const sections = files.slice(0, 250).map((file, index) => ({
    index,
    title: file.title || file.track || String(file.name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
    fileName: file.name,
    duration: parseLength(file.length),
    url: `${IA_DOWNLOAD}${encodeURIComponent(identifier)}/${String(file.name).split('/').map(encodeURIComponent).join('/')}`
  }));
  const totalSeconds = sections.reduce((sum, s) => sum + (s.duration || 0), 0);
  let finalScore = score;
  if (expectedMinutes && totalSeconds) {
    const ratio = totalSeconds / (Number(expectedMinutes) * 60);
    if (ratio >= 0.72 && ratio <= 1.28) finalScore += 24;
    else if (ratio < 0.45 || ratio > 1.8) finalScore -= 32;
  }
  return {
    identifier, provider, confidence: Math.round(finalScore),
    matchedTitle: clean(Array.isArray(md.title)?md.title[0]:md.title, 300),
    matchedCreator: text(md.creator).slice(0, 300),
    sourceUrl: `${IA_DETAILS}${encodeURIComponent(identifier)}`,
    totalSeconds, sections
  };
}
async function directPlayback(identifier) {
  const payload = await fetchJson(`${IA_META}${encodeURIComponent(identifier)}`, 4200);
  return metadataToPlayback(payload, identifier, 'Internet Archive / LibriVox', 200, 0);
}
async function verifyCandidate(book, item) {
  try {
    const payload = await fetchJson(`${IA_META}${encodeURIComponent(item.doc.identifier)}`, 4200);
    const playback = metadataToPlayback(payload, item.doc.identifier, item.provider, item.score, book.durationMinutes);
    if (!playback) return null;
    const threshold = item.provider === 'Internet Archive / LibriVox' ? 76 : 112;
    return playback.confidence >= threshold ? playback : null;
  } catch { return null; }
}
async function hunt(book) {
  const title = safeLucene(book.title), creator = safeLucene(book.author);
  if (!title) return null;
  const searches = [
    {provider:'Internet Archive / LibriVox',q:`collection:librivoxaudio AND mediatype:audio AND title:("${title}")${creator?` AND creator:("${creator}")`:''}`},
    {provider:'Internet Archive / Audiobooks',q:`collection:audio_bookspoetry AND mediatype:audio AND title:("${title}")${creator?` AND creator:("${creator}")`:''}`},
    {provider:'Internet Archive / Open Audio',q:`mediatype:audio AND title:("${title}")${creator?` AND creator:("${creator}")`:''} AND (subject:(audiobook) OR subject:("audio book") OR description:(audiobook) OR description:(librivox))`}
  ];
  const settled = await Promise.allSettled(searches.map(async source => {
    const docs = await iaSearch(source.q, 8);
    return docs.map(doc => ({ provider: source.provider, doc, score: candidateScore(book, doc) }));
  }));
  const candidates = settled.flatMap(x => x.status === 'fulfilled' ? x.value : [])
    .filter(x => x.doc?.identifier).sort((a,b)=>b.score-a.score).slice(0,4);
  if (!candidates.length) return null;
  const verified = (await Promise.all(candidates.map(item => verifyCandidate(book,item)))).filter(Boolean).sort((a,b)=>b.confidence-a.confidence);
  return verified[0] || null;
}

module.exports = async function handler(req, res) {
  const started = Date.now();
  const identifier = safeIdentifier(req.query?.identifier);
  const asin = clean(req.query?.asin, 32).toUpperCase();
  const title = clean(req.query?.title, 300);
  const author = clean(req.query?.author, 300);
  const durationMinutes = Math.max(0, Math.min(10000, Number(req.query?.duration || 0) || 0));

  try {
    if (identifier) {
      const playback = await directPlayback(identifier);
      if (playback?.sections?.length) {
        res.setHeader('Cache-Control','public, s-maxage=2592000, stale-while-revalidate=604800');
        return res.status(200).json({available:true,playback,huntMs:Date.now()-started,direct:true});
      }
      res.setHeader('Cache-Control','public, s-maxage=21600, stale-while-revalidate=86400');
      return res.status(200).json({available:false,playback:null,huntMs:Date.now()-started,direct:true});
    }

    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const playback = await Promise.race([
      hunt({ asin, title, author, durationMinutes }),
      new Promise(resolve => setTimeout(() => resolve(null), 6200))
    ]);
    if (playback) {
      res.setHeader('Cache-Control', 'public, s-maxage=2592000, stale-while-revalidate=604800');
      return res.status(200).json({ available: true, playback, huntMs: Date.now() - started });
    }
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json({ available: false, playback: null, huntMs: Date.now() - started });
  } catch (error) {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
    return res.status(200).json({ available: false, playback: null, huntMs: Date.now() - started, detail: error?.message || 'Playback hunt failed' });
  }
};
