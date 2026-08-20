'use strict';

const LIBEX_ORIGINS = [
  'https://libexdb.com',
  'https://libex.lostcartographer.xyz'
];

const HOME_GENRES = [
  ['Fantasy', /fantasy|epic|magic|sword|dragon/i],
  ['Mystery & Thrillers', /mystery|thriller|crime|detective|suspense/i],
  ['Science Fiction', /science fiction|sci[- ]?fi|space|dystopia|cyberpunk/i],
  ['Romance', /romance|love story/i],
  ['Biography & Memoir', /biography|memoir|autobiography/i],
  ['Business & Money', /business|money|finance|economics|entrepreneur/i]
];

function clean(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function clamp(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

async function fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AudioBox/2.1 (+https://github.com/KeithPatrick5/AudioBox)'
      }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`Libex returned ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
      err.status = response.status;
      throw err;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function firstSuccessful(urls) {
  const tasks = urls.map(url => fetchJson(url));
  try {
    return await Promise.any(tasks);
  } catch (aggregate) {
    const errors = aggregate?.errors || [];
    const notFound = errors.length && errors.every(e => e?.status === 404);
    const error = errors.find(e => e?.status !== 404) || errors[0] || new Error('Libex is unavailable');
    if (notFound) error.status = 404;
    throw error;
  }
}

async function libex(path, params = {}) {
  const query = new URLSearchParams();
  query.set('region', 'us');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return firstSuccessful(LIBEX_ORIGINS.map(origin => `${origin}${path}?${query.toString()}`));
}

function names(items) {
  return (Array.isArray(items) ? items : [])
    .map(item => typeof item === 'string' ? item : item?.name)
    .filter(Boolean);
}

function normalizeBook(raw = {}) {
  const asin = clean(raw.asin, 32);
  if (!asin) return null;
  const genres = (Array.isArray(raw.genres) ? raw.genres : [])
    .map(g => ({ name: clean(g?.name || g, 120), type: clean(g?.type, 40) }))
    .filter(g => g.name);

  return {
    id: asin,
    asin,
    source: 'libex',
    title: clean(raw.title, 300) || 'Untitled',
    subtitle: clean(raw.subtitle, 300),
    description: clean(raw.summary || raw.description, 12000),
    authors: names(raw.authors),
    narrators: names(raw.narrators),
    genres: genres.map(g => g.name),
    genreDetails: genres,
    series: (Array.isArray(raw.series) ? raw.series : []).map(s => ({
      asin: clean(s?.asin, 32),
      name: clean(s?.name, 200),
      position: clean(s?.position, 40)
    })).filter(s => s.name),
    publisher: clean(raw.publisher, 240),
    copyright: clean(raw.copyright, 100),
    isbn: clean(raw.isbn, 40),
    language: clean(raw.language, 80),
    rating: Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : null,
    releaseDate: clean(raw.releaseDate, 40),
    cover: clean(raw.imageUrl, 2000),
    durationMinutes: Number.isFinite(Number(raw.lengthMinutes)) ? Number(raw.lengthMinutes) : 0,
    link: clean(raw.link, 2000),
    isListenable: Boolean(raw.isListenable),
    isAvailable: Boolean(raw.isAvailable),
    isBuyable: Boolean(raw.isBuyable),
    isVvab: Boolean(raw.isVvab),
    plans: Array.isArray(raw.plans) ? raw.plans.filter(Boolean).slice(0, 20) : []
  };
}

function normalizeList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.books) ? payload.books
    : Array.isArray(payload?.matches) ? payload.matches
    : [];
  const seen = new Set();
  return list.map(normalizeBook).filter(book => {
    if (!book || seen.has(book.asin)) return false;
    seen.add(book.asin);
    return true;
  });
}

function dedupe(books) {
  const seen = new Set();
  return (books || []).filter(book => {
    if (!book?.id || seen.has(book.id)) return false;
    seen.add(book.id);
    return true;
  });
}

function searchableText(book) {
  return [book.title, book.subtitle, book.description, ...(book.genres || [])].filter(Boolean).join(' ');
}

function cache(res, seconds, stale = 86400) {
  res.setHeader('Cache-Control', `public, s-maxage=${seconds}, stale-while-revalidate=${stale}`);
}

async function searchBooks(params) {
  const payload = await libex('/search', params);
  return normalizeList(payload);
}

async function homePayload() {
  const settled = await Promise.allSettled([
    searchBooks({ products_sort_by: 'BestSellers', limit: 50 }),
    searchBooks({ products_sort_by: '-ReleaseDate', limit: 50 })
  ]);

  const trending = settled[0].status === 'fulfilled' ? settled[0].value : [];
  const newest = settled[1].status === 'fulfilled' ? settled[1].value : [];
  const pool = dedupe([...trending, ...newest]);

  if (!pool.length) {
    const errors = settled.filter(x => x.status === 'rejected').map(x => x.reason?.message).filter(Boolean);
    throw new Error(errors[0] || 'No catalog rows could be loaded');
  }

  const rows = [];
  if (trending.length) rows.push({ name: 'Trending Now', books: trending.slice(0, 30) });
  if (newest.length) rows.push({ name: 'New Releases', books: newest.slice(0, 28) });

  for (const [name, regex] of HOME_GENRES) {
    const books = pool.filter(book => regex.test(searchableText(book))).slice(0, 22);
    if (books.length >= 5) rows.push({ name, books });
  }

  const hero = trending[0] || newest[0] || pool[0] || null;
  return { hero, rows, provider: 'Libex / Audible metadata', generatedAt: Date.now() };
}

module.exports = async function handler(req, res) {
  const mode = clean(req.query?.mode || 'home', 20).toLowerCase();

  try {
    if (mode === 'home') {
      cache(res, 21600, 172800);
      return res.status(200).json(await homePayload());
    }

    if (mode === 'search') {
      const q = clean(req.query?.q, 160);
      if (!q) return res.status(200).json({ books: [] });
      const books = await searchBooks({
        keywords: q,
        products_sort_by: 'Relevance',
        limit: clamp(req.query?.limit, 1, 50, 40),
        page: clamp(req.query?.page, 0, 9, 0)
      });
      cache(res, 1800, 86400);
      return res.status(200).json({ books });
    }

    if (mode === 'genre') {
      const genre = clean(req.query?.genre, 120);
      const books = await searchBooks({
        ...(genre ? { keywords: genre } : {}),
        products_sort_by: 'BestSellers',
        limit: clamp(req.query?.limit, 1, 50, 50),
        page: clamp(req.query?.page, 0, 9, 0)
      });
      cache(res, 7200, 86400);
      return res.status(200).json({ books });
    }

    if (mode === 'book') {
      const asin = clean(req.query?.asin, 20).toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) return res.status(400).json({ error: 'Invalid audiobook ID.' });
      const payload = await firstSuccessful(LIBEX_ORIGINS.map(origin => `${origin}/book/${encodeURIComponent(asin)}?region=us`));
      const book = normalizeBook(payload);
      cache(res, 86400, 604800);
      return res.status(200).json({ book });
    }

    return res.status(400).json({ error: 'Unknown catalog request.' });
  } catch (error) {
    const status = error?.status === 404 ? 404 : 502;
    res.status(status).json({
      error: status === 404 ? 'No audiobooks found.' : 'The audiobook catalog is temporarily unavailable.',
      detail: error?.message || 'Unknown error'
    });
  }
};
