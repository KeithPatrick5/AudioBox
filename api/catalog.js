'use strict';

const LIBEX_ORIGINS = [
  'https://libexdb.com',
  'https://libex.lostcartographer.xyz'
];

const HOME_SHELVES = [
  ['Trending Now', { products_sort_by: 'BestSellers', limit: 36 }],
  ['New & Upcoming', { products_sort_by: '-ReleaseDate', limit: 30 }],
  ['Fantasy', { keywords: 'fantasy', products_sort_by: 'BestSellers', limit: 24 }],
  ['Mystery & Thrillers', { keywords: 'mystery thriller', products_sort_by: 'BestSellers', limit: 24 }],
  ['Science Fiction', { keywords: 'science fiction', products_sort_by: 'BestSellers', limit: 24 }],
  ['Romance', { keywords: 'romance', products_sort_by: 'BestSellers', limit: 24 }]
];

function clean(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function clamp(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

async function fetchJson(url, timeoutMs = 14000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AudioBox/2.0 (+https://github.com/KeithPatrick5/AudioBox)'
      }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`Libex returned ${response.status}${text ? `: ${text.slice(0, 140)}` : ''}`);
      err.status = response.status;
      throw err;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function libex(path, params = {}) {
  const query = new URLSearchParams();
  query.set('region', 'us');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }

  let lastError;
  for (const origin of LIBEX_ORIGINS) {
    try {
      return await fetchJson(`${origin}${path}?${query.toString()}`);
    } catch (error) {
      lastError = error;
      if (error?.status === 404) throw error;
    }
  }
  throw lastError || new Error('Libex is unavailable');
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

function cache(res, seconds, stale = 86400) {
  res.setHeader('Cache-Control', `public, s-maxage=${seconds}, stale-while-revalidate=${stale}`);
}

async function searchBooks(params) {
  const payload = await libex('/search', params);
  return normalizeList(payload);
}

async function homePayload() {
  const settled = await Promise.allSettled(
    HOME_SHELVES.map(([, params]) => searchBooks(params))
  );

  const rows = settled.map((result, index) => ({
    name: HOME_SHELVES[index][0],
    books: result.status === 'fulfilled' ? result.value : []
  })).filter(row => row.books.length);

  if (!rows.length) {
    const errors = settled.filter(x => x.status === 'rejected').map(x => x.reason?.message).filter(Boolean);
    throw new Error(errors[0] || 'No catalog rows could be loaded');
  }

  const hero = rows[0]?.books?.[0] || rows.flatMap(row => row.books)[0] || null;
  return { hero, rows, provider: 'Libex / Audible metadata' };
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
      cache(res, 900, 86400);
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
      cache(res, 3600, 86400);
      return res.status(200).json({ books });
    }

    if (mode === 'book') {
      const asin = clean(req.query?.asin, 20).toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) return res.status(400).json({ error: 'Invalid audiobook ID.' });
      let payload;
      let lastError;
      for (const origin of LIBEX_ORIGINS) {
        try {
          payload = await fetchJson(`${origin}/book/${encodeURIComponent(asin)}?region=us`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (error?.status === 404) break;
        }
      }
      if (!payload) throw lastError || new Error('Book metadata unavailable');
      const book = normalizeBook(payload);
      cache(res, 86400, 604800);
      return res.status(200).json({ book });
    }

    return res.status(400).json({ error: 'Unknown catalog request.' });
  } catch (error) {
    const status = error?.status === 404 ? 404 : 502;
    res.status(status).json({ error: status === 404 ? 'No audiobooks found.' : 'The audiobook catalog is temporarily unavailable.', detail: error?.message || 'Unknown error' });
  }
};
