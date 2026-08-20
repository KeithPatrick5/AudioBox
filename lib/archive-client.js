'use strict';

(() => {
  const nativeFetch = window.fetch.bind(window);
  const SEARCH = 'https://archive.org/advancedsearch.php';
  const META = 'https://archive.org/metadata/';
  const IMAGE = 'https://archive.org/services/img/';
  const DOWNLOAD = 'https://archive.org/download/';
  const DETAILS = 'https://archive.org/details/';

  const asArray = value => Array.isArray(value) ? value : (value == null ? [] : [value]);
  const first = value => Array.isArray(value) ? value[0] : value;
  const text = value => asArray(value).filter(Boolean).join(' ');
  const safe = value => String(value || '').replace(/[\\"()\[\]{}:+\-!^~*?]/g, ' ').replace(/\s+/g, ' ').trim();

  function parseLength(value) {
    if (typeof value === 'number') return value;
    const s = String(value || '').trim();
    if (!s) return 0;
    if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
    const parts = s.split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((n, p) => n * 60 + p, 0);
  }

  function authorObject(creator) {
    const name = text(creator) || 'Unknown author';
    return [{ first_name: '', last_name: name }];
  }

  function subjectObjects(subject) {
    return asArray(subject).filter(Boolean).slice(0, 24).map(name => ({ name: String(name) }));
  }

  function summaryBook(doc) {
    const id = String(doc.identifier || '');
    return {
      id,
      title: first(doc.title) || 'Untitled',
      description: text(doc.description),
      language: text(doc.language),
      copyright_year: String(first(doc.date) || '').slice(0, 4),
      num_sections: 0,
      url_rss: '',
      url_zip_file: '',
      url_project: `${DETAILS}${encodeURIComponent(id)}`,
      url_librivox: '',
      url_iarchive: `${DETAILS}${encodeURIComponent(id)}`,
      url_text_source: '',
      totaltime: '',
      totaltimesecs: 0,
      coverart_jpg: `${IMAGE}${encodeURIComponent(id)}`,
      coverart_thumbnail: `${IMAGE}${encodeURIComponent(id)}`,
      authors: authorObject(doc.creator),
      genres: subjectObjects(doc.subject),
      translators: [],
      sections: []
    };
  }

  function pickAudioFiles(files) {
    const usable = files.filter(f => f && f.name && !f.private && /mp3/i.test(String(f.format || '')));
    const preferred = [
      usable.filter(f => /VBR MP3/i.test(String(f.format || ''))),
      usable.filter(f => /64Kbps MP3/i.test(String(f.format || ''))),
      usable.filter(f => /128Kbps MP3/i.test(String(f.format || ''))),
      usable
    ].find(group => group.length) || [];

    const seen = new Set();
    return preferred
      .filter(f => !/sample|preview/i.test(String(f.name)))
      .filter(f => {
        const stem = String(f.name).toLowerCase().replace(/(?:_64kb|_128kb)?\.mp3$/, '');
        if (seen.has(stem)) return false;
        seen.add(stem);
        return true;
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
  }

  function detailedBook(payload, id) {
    const md = payload?.metadata || {};
    const files = Array.isArray(payload?.files) ? payload.files : [];
    const audioFiles = pickAudioFiles(files);
    const creator = md.creator || md.author || 'Unknown author';
    const sections = audioFiles.map((file, index) => ({
      id: `${id}:${index + 1}`,
      section_number: index + 1,
      title: file.title || file.track || String(file.name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
      listen_url: `${DOWNLOAD}${encodeURIComponent(id)}/${String(file.name).split('/').map(encodeURIComponent).join('/')}`,
      language: text(md.language),
      playtime: file.length || '0',
      file_name: file.name,
      readers: [{ reader_id: '', display_name: text(creator) || 'LibriVox reader' }]
    }));

    const totalSeconds = sections.reduce((sum, section) => sum + parseLength(section.playtime), 0);
    const zip = files.find(f => /zip/i.test(String(f.format || '')) && /mp3/i.test(String(f.name || '')) && !/spectrogram/i.test(String(f.name || '')));
    const source = first(md.source) || first(md.external_identifier) || '';

    return {
      id: String(id),
      title: first(md.title) || 'Untitled',
      description: text(md.description),
      language: text(md.language),
      copyright_year: String(first(md.date) || '').slice(0, 4),
      num_sections: sections.length,
      url_rss: '',
      url_zip_file: zip ? `${DOWNLOAD}${encodeURIComponent(id)}/${String(zip.name).split('/').map(encodeURIComponent).join('/')}` : '',
      url_project: `${DETAILS}${encodeURIComponent(id)}`,
      url_librivox: typeof source === 'string' && source.includes('librivox.org') ? source : '',
      url_iarchive: `${DETAILS}${encodeURIComponent(id)}`,
      url_text_source: typeof source === 'string' && /^https?:/i.test(source) && !source.includes('librivox.org') ? source : '',
      totaltime: '',
      totaltimesecs: totalSeconds,
      coverart_jpg: `${IMAGE}${encodeURIComponent(id)}`,
      coverart_thumbnail: `${IMAGE}${encodeURIComponent(id)}`,
      authors: authorObject(creator),
      genres: subjectObjects(md.subject),
      translators: [],
      sections
    };
  }

  async function getJson(url, timeoutMs = 18000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await nativeFetch(url, { signal: controller.signal, mode: 'cors' });
      if (!response.ok) throw new Error(`Archive.org returned ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function buildQuery(params) {
    const clauses = ['collection:librivoxaudio', 'mediatype:audio'];
    const title = safe(params.get('title'));
    const author = safe(params.get('author'));
    const genre = safe(params.get('genre'));

    if (title) clauses.push(`title:(${title.split(' ').join(' AND ')})`);
    if (author) clauses.push(`creator:(${author.split(' ').join(' AND ')})`);
    if (genre) clauses.push(`(subject:(${genre.split(' ').join(' AND ')}) OR description:(${genre.split(' ').join(' AND ')}))`);
    return clauses.join(' AND ');
  }

  async function searchBooks(params) {
    const limit = Math.max(1, Math.min(50, Number(params.get('limit')) || 20));
    const offset = Math.max(0, Number(params.get('offset')) || 0);
    const page = Math.floor(offset / limit) + 1;
    const query = new URLSearchParams();
    query.set('q', buildQuery(params));
    for (const field of ['identifier','title','creator','description','subject','language','date','downloads']) query.append('fl[]', field);
    query.set('rows', String(limit));
    query.set('page', String(page));
    query.append('sort[]', 'downloads desc');
    query.set('output', 'json');

    let payload = await getJson(`${SEARCH}?${query.toString()}`);
    let docs = payload?.response?.docs || [];

    if (!docs.length && params.get('genre')) {
      const fallback = new URLSearchParams(query);
      fallback.set('q', 'collection:librivoxaudio AND mediatype:audio');
      payload = await getJson(`${SEARCH}?${fallback.toString()}`);
      docs = payload?.response?.docs || [];
    }

    return docs.map(summaryBook).filter(book => book.id);
  }

  async function fetchBooks(params) {
    const id = params.get('id');
    if (id) {
      const payload = await getJson(`${META}${encodeURIComponent(id)}`);
      return [detailedBook(payload, id)];
    }
    return searchBooks(params);
  }

  window.fetch = async function audioBoxArchiveFetch(resource, init) {
    const url = typeof resource === 'string' ? resource : resource?.url;
    if (!url || !url.startsWith('/api/librivox')) return nativeFetch(resource, init);

    const parsed = new URL(url, location.origin);
    try {
      const books = await fetchBooks(parsed.searchParams);
      return new Response(JSON.stringify({ books }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'The audiobook catalog could not be loaded.', detail: error.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  };
})();
