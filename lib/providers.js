'use strict';

const LIBRIVOX_BASE = 'https://librivox.org/api/feed/audiobooks/';
const OPENLIBRARY_SEARCH = 'https://openlibrary.org/search.json';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function safeText(value, max = 160) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AudioBox/1.0 (+public audiobook player)' }
    });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBooks(payload) {
  const books = payload && Array.isArray(payload.books) ? payload.books : [];
  return books.map((book) => ({
    id: String(book.id || ''),
    title: book.title || 'Untitled',
    description: book.description || '',
    language: book.language || '',
    copyright_year: book.copyright_year || '',
    num_sections: Number(book.num_sections || 0),
    url_rss: book.url_rss || '',
    url_zip_file: book.url_zip_file || '',
    url_project: book.url_project || '',
    url_librivox: book.url_librivox || '',
    url_iarchive: book.url_iarchive || '',
    url_text_source: book.url_text_source || '',
    totaltime: book.totaltime || '',
    totaltimesecs: Number(book.totaltimesecs || 0),
    coverart_jpg: book.coverart_jpg || '',
    coverart_thumbnail: book.coverart_thumbnail || '',
    authors: Array.isArray(book.authors) ? book.authors : [],
    genres: Array.isArray(book.genres) ? book.genres : [],
    translators: Array.isArray(book.translators) ? book.translators : [],
    sections: Array.isArray(book.sections) ? book.sections.map((section) => ({
      id: String(section.id || ''),
      section_number: Number(section.section_number || 0),
      title: section.title || '',
      listen_url: section.listen_url || '',
      language: section.language || '',
      playtime: section.playtime || '0',
      file_name: section.file_name || '',
      readers: Array.isArray(section.readers) ? section.readers : []
    })) : []
  }));
}

async function getLibriVox(params = {}) {
  const query = new URLSearchParams();
  query.set('format', 'json');
  query.set('coverart', '1');
  query.set('extended', params.extended === '0' ? '0' : '1');
  query.set('limit', String(clampInt(params.limit, 1, 50, 20)));
  query.set('offset', String(clampInt(params.offset, 0, 100000, 0)));

  const id = safeText(params.id, 20);
  const title = safeText(params.title, 120);
  const author = safeText(params.author, 100);
  const genre = safeText(params.genre, 100);
  const since = safeText(params.since, 20);

  if (id && /^\d+$/.test(id)) query.set('id', id);
  if (title) query.set('title', title.startsWith('^') ? title : `^${title}`);
  if (author) query.set('author', author.startsWith('^') ? author : `^${author}`);
  if (genre) query.set('genre', genre.startsWith('^') ? genre : `^${genre}`);
  if (since && /^\d+$/.test(since)) query.set('since', since);

  const payload = await fetchJson(`${LIBRIVOX_BASE}?${query.toString()}`);
  return normalizeBooks(payload);
}

async function searchOpenLibrary(params = {}) {
  const q = safeText(params.q, 180);
  if (!q) return [];
  const query = new URLSearchParams({
    q,
    fields: 'key,title,author_name,cover_i,first_publish_year,edition_key,isbn',
    limit: String(clampInt(params.limit, 1, 10, 3))
  });
  const payload = await fetchJson(`${OPENLIBRARY_SEARCH}?${query.toString()}`);
  return (payload.docs || []).map((doc) => ({
    key: doc.key || '',
    title: doc.title || '',
    authors: doc.author_name || [],
    coverId: doc.cover_i || null,
    cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '',
    year: doc.first_publish_year || null,
    isbn: Array.isArray(doc.isbn) ? doc.isbn.slice(0, 5) : []
  }));
}

async function getWikipediaAuthor(params = {}) {
  const name = safeText(params.name, 120);
  if (!name) return null;
  const search = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: name,
    gsrlimit: '1',
    prop: 'extracts|pageimages|info',
    exintro: '1',
    explaintext: '1',
    inprop: 'url',
    piprop: 'thumbnail',
    pithumbsize: '320',
    format: 'json',
    origin: '*'
  });
  const payload = await fetchJson(`${WIKIPEDIA_API}?${search.toString()}`);
  const pages = payload?.query?.pages ? Object.values(payload.query.pages) : [];
  if (!pages.length) return null;
  const page = pages[0];
  return {
    title: page.title || name,
    extract: page.extract || '',
    url: page.fullurl || '',
    image: page.thumbnail?.source || ''
  };
}

module.exports = { getLibriVox, searchOpenLibrary, getWikipediaAuthor };
