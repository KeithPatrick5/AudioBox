'use strict';

(() => {
  const nativeFetch = window.fetch.bind(window);
  const resultByQuery = new Map();
  const resultByIdentifier = new Map();
  const queue = [];
  let active = 0;
  const MAX_PREFETCH = 2;
  const PREFETCH_LIMIT = 12;

  function norm(value = '') {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function key(title, author = '') { return `${norm(title)}|${norm(author)}`; }

  function migrateOldNegatives() {
    const flag = 'audiobox:v2:hunter-migrated';
    if (localStorage.getItem(flag)) return;
    try {
      const storageKey = 'audiobox:v2:playback-map';
      const map = JSON.parse(localStorage.getItem(storageKey) || '{}');
      for (const [id, value] of Object.entries(map)) {
        if (value?.notFound) delete map[id];
      }
      localStorage.setItem(storageKey, JSON.stringify(map));
      localStorage.setItem(flag, '1');
    } catch {}
  }

  function synthSearch(result) {
    const p = result?.playback;
    const docs = result?.available && p ? [{
      identifier: p.identifier,
      title: p.matchedTitle || '',
      creator: p.matchedCreator || '',
      downloads: 999999,
      collection: p.provider || 'audiobook'
    }] : [];
    return new Response(JSON.stringify({ response: { docs, numFound: docs.length } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  function synthMetadata(playback) {
    const files = (playback?.sections || []).map(section => ({
      name: section.fileName,
      title: section.title,
      length: section.duration || 0,
      format: 'VBR MP3'
    }));
    return new Response(JSON.stringify({
      metadata: {
        title: playback?.matchedTitle || '',
        creator: playback?.matchedCreator || '',
        collection: ['librivoxaudio'],
        rights: 'Publicly playable source resolved by AudioBox'
      },
      files
    }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }

  async function resolve(title, author = '', duration = 0, asin = '') {
    const exact = key(title, author);
    const titleOnly = key(title, '');
    if (resultByQuery.has(exact)) return resultByQuery.get(exact);
    if (!author && resultByQuery.has(titleOnly)) return resultByQuery.get(titleOnly);

    const params = new URLSearchParams({ title: String(title || '') });
    if (author) params.set('author', String(author));
    if (duration) params.set('duration', String(duration));
    if (asin) params.set('asin', String(asin));

    const promise = nativeFetch(`/api/playback?${params.toString()}`, { headers: { Accept: 'application/json' } })
      .then(async response => {
        if (!response.ok) return { available: false, playback: null };
        const data = await response.json();
        if (data?.playback?.identifier) resultByIdentifier.set(String(data.playback.identifier), data.playback);
        return data;
      })
      .catch(() => ({ available: false, playback: null }));

    resultByQuery.set(exact, promise);
    if (!author) resultByQuery.set(titleOnly, promise);
    const data = await promise;
    resultByQuery.set(exact, data);
    if (!data.available) resultByQuery.set(titleOnly, data);
    return data;
  }

  function extractSearch(url) {
    try {
      const parsed = new URL(url);
      const q = parsed.searchParams.get('q') || '';
      const title = q.match(/title:\(\"([^\"]+)\"\)/i)?.[1] || q.match(/title:\(([^)]+)\)/i)?.[1] || '';
      const author = q.match(/creator:\(\"([^\"]+)\"\)/i)?.[1] || q.match(/creator:\(([^)]+)\)/i)?.[1] || '';
      return { title: title.trim(), author: author.trim() };
    } catch { return { title: '', author: '' }; }
  }

  function scheduleBooks(data) {
    const books = [];
    if (data?.hero) books.push(data.hero);
    for (const row of data?.rows || []) {
      for (const book of row?.books || []) books.push(book);
      if (books.length >= PREFETCH_LIMIT) break;
    }
    const seen = new Set();
    for (const book of books) {
      if (!book?.title || seen.has(book.id)) continue;
      seen.add(book.id);
      queue.push(book);
      if (queue.length >= PREFETCH_LIMIT) break;
    }
    pump();
  }

  function pump() {
    while (active < MAX_PREFETCH && queue.length) {
      const book = queue.shift();
      active++;
      resolve(book.title, (book.authors || []).join(', '), Number(book.durationMinutes || 0), book.asin || book.id)
        .finally(() => { active--; setTimeout(pump, 120); });
    }
  }

  migrateOldNegatives();

  window.fetch = async function audioBoxFastFetch(resource, init) {
    const url = typeof resource === 'string' ? resource : resource?.url || '';

    if (url.includes('archive.org/advancedsearch.php')) {
      const { title, author } = extractSearch(url);
      if (title) return synthSearch(await resolve(title, author));
    }

    if (url.includes('archive.org/metadata/')) {
      try {
        const identifier = decodeURIComponent(new URL(url).pathname.split('/metadata/')[1] || '');
        const playback = resultByIdentifier.get(identifier);
        if (playback) return synthMetadata(playback);
      } catch {}
    }

    const response = await nativeFetch(resource, init);

    if (url.startsWith('/api/catalog') && url.includes('mode=home')) {
      response.clone().json().then(scheduleBooks).catch(() => {});
    }

    return response;
  };

  window.AudioBoxPlaybackHunter = {
    resolve,
    cachedCount: () => resultByIdentifier.size,
    queuedCount: () => queue.length
  };
})();
