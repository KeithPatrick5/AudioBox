'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const GENRES = [
    'Best Sellers', 'Fantasy', 'Mystery & Thrillers', 'Science Fiction', 'Romance',
    'Horror', 'Biography & Memoir', 'History', 'Business', 'Self-Development',
    'True Crime', 'Comedy'
  ];

  const IA = {
    search: 'https://archive.org/advancedsearch.php',
    metadata: 'https://archive.org/metadata/',
    download: 'https://archive.org/download/',
    details: 'https://archive.org/details/'
  };

  const state = {
    books: new Map(),
    playback: new Map(),
    playbackPromises: new Map(),
    currentBook: null,
    currentPlayback: null,
    currentChapter: 0,
    currentView: 'home',
    searchTimer: null,
    sleepTimer: null,
    lastProgressSave: 0
  };

  const storage = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(`audiobox:v2:${key}`)) ?? fallback; }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`audiobox:v2:${key}`, JSON.stringify(value)); } catch {}
    },
    favorites() { return this.get('favorites', []); },
    toggleFavorite(id) {
      const ids = this.favorites().filter(Boolean);
      const key = String(id);
      const index = ids.indexOf(key);
      if (index >= 0) ids.splice(index, 1); else ids.unshift(key);
      this.set('favorites', ids.slice(0, 100));
      return index < 0;
    },
    recent() { return this.get('recent', []); },
    touchRecent(id) {
      const key = String(id);
      const ids = this.recent().filter(x => String(x) !== key);
      ids.unshift(key);
      this.set('recent', ids.slice(0, 40));
    },
    progress() { return this.get('progress', {}); },
    saveProgress(id, value) {
      const all = this.progress();
      all[String(id)] = { ...(all[String(id)] || {}), ...value, updatedAt: Date.now() };
      this.set('progress', all);
    },
    snapshots() { return this.get('snapshots', {}); },
    rememberBook(book) {
      if (!book?.id) return;
      const all = this.snapshots();
      all[String(book.id)] = { ...book, description: String(book.description || '').slice(0, 2400), savedAt: Date.now() };
      const entries = Object.entries(all).sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0)).slice(0, 120);
      this.set('snapshots', Object.fromEntries(entries));
    },
    playbackMap() { return this.get('playback-map', {}); },
    savePlayback(id, value) {
      const all = this.playbackMap();
      all[String(id)] = { ...value, checkedAt: Date.now() };
      this.set('playback-map', all);
    }
  };

  function esc(value = '') {
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function stripHtml(value = '') {
    const el = document.createElement('div');
    el.innerHTML = String(value);
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  }

  function runtime(book) {
    const mins = Number(book?.durationMinutes || 0);
    if (!mins) return '';
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  function author(book) { return book?.authors?.filter(Boolean).join(', ') || 'Unknown author'; }
  function narrator(book) { return book?.narrators?.filter(Boolean).join(', ') || ''; }

  function remember(books) {
    for (const book of books || []) {
      if (!book?.id) continue;
      state.books.set(String(book.id), book);
      storage.rememberBook(book);
    }
    return books || [];
  }

  function restoreSnapshots() {
    for (const [id, book] of Object.entries(storage.snapshots())) {
      if (book?.id) state.books.set(String(id), book);
    }
  }

  async function api(params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const response = await fetch(`/api/catalog?${qs.toString()}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.detail || `Catalog request failed (${response.status})`);
    return data;
  }

  async function getBook(id) {
    const key = String(id);
    const cached = state.books.get(key);
    try {
      const { book } = await api({ mode: 'book', asin: key });
      if (book) return remember([book])[0];
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
    return cached || null;
  }

  async function booksByIds(ids) {
    const missing = ids.filter(id => !state.books.has(String(id))).slice(0, 12);
    const fetched = await Promise.all(missing.map(id => getBook(id).catch(() => null)));
    remember(fetched.filter(Boolean));
    return ids.map(id => state.books.get(String(id))).filter(Boolean);
  }

  function fallbackCover(book) {
    return `<div class="cover-fallback"><strong>${esc(book.title)}</strong><span>${esc(author(book))}</span></div>`;
  }

  function progressPercent(book) {
    const p = storage.progress()[String(book.id)];
    if (!p) return 0;
    const duration = Number(p.bookDuration || (book.durationMinutes || 0) * 60);
    if (!duration) return 0;
    return Math.max(0, Math.min(100, (Number(p.absoluteTime || 0) / duration) * 100));
  }

  function card(book) {
    const progress = progressPercent(book);
    const rating = Number(book.rating || 0);
    return `<button class="card catalog-card" data-book-id="${esc(book.id)}" aria-label="${esc(book.title)}">
      ${fallbackCover(book)}
      ${book.cover ? `<img src="${esc(book.cover)}" alt="Cover of ${esc(book.title)}" loading="lazy" referrerpolicy="no-referrer" />` : ''}
      <div class="catalog-chip">${rating ? `★ ${rating.toFixed(1)}` : 'AUDIOBOOK'}</div>
      <div class="card-overlay"><strong>${esc(book.title)}</strong><span>${esc(author(book))}</span></div>
      ${progress > 0 ? `<div class="progress-line"><i style="width:${progress.toFixed(1)}%"></i></div>` : ''}
    </button>`;
  }

  function skeletons(n = 10) { return Array.from({ length: n }, () => '<div class="card skeleton"></div>').join(''); }
  function row(name, books) { return books?.length ? `<section class="row"><div class="row-head"><h2>${esc(name)}</h2></div><div class="rail">${books.map(card).join('')}</div></section>` : ''; }
  function bindCards(root = document) { $$('[data-book-id]', root).forEach(el => el.addEventListener('click', () => openDetails(el.dataset.bookId))); }

  function hero(book) {
    const description = stripHtml(book.description || book.subtitle || 'Discover your next audiobook.');
    const meta = [author(book), runtime(book), book.rating ? `★ ${Number(book.rating).toFixed(1)}` : ''].filter(Boolean).join('  ·  ');
    return `<section class="hero netflix-hero" data-hero-id="${esc(book.id)}">
      <div class="hero-bg" ${book.cover ? `style="background-image:url('${esc(book.cover)}')"` : ''}></div>
      <div class="hero-content">
        <div class="eyebrow"><span class="n-mark">A</span> POPULAR ON AUDIOBOX</div>
        <h1>${esc(book.title)}</h1>
        <div class="hero-author">${esc(meta)}</div>
        <p class="hero-desc">${esc(description)}</p>
        <div class="hero-actions">
          <button class="btn primary" data-hero-play>▶ Play</button>
          <button class="btn secondary" data-hero-info>ⓘ More Info</button>
        </div>
      </div>
    </section>`;
  }

  async function renderHome() {
    const view = $('#homeView');
    view.innerHTML = `<section class="hero netflix-hero loading-hero"><div class="hero-bg"></div><div class="hero-content"><div class="eyebrow">AUDIOBOX</div><h1>Loading…</h1><p class="hero-desc">Building your audiobook shelves.</p></div></section><div class="content-rows"><section class="row"><div class="row-head"><h2>Loading</h2></div><div class="rail">${skeletons(10)}</div></section></div>`;
    try {
      const data = await api({ mode: 'home' });
      const all = (data.rows || []).flatMap(r => r.books || []);
      remember(all);
      if (data.hero) remember([data.hero]);

      const progress = storage.progress();
      const continueIds = Object.keys(progress).sort((a, b) => (progress[b]?.updatedAt || 0) - (progress[a]?.updatedAt || 0));
      const continueBooks = continueIds.map(id => state.books.get(String(id))).filter(Boolean).slice(0, 18);
      const recentBooks = storage.recent().map(id => state.books.get(String(id))).filter(Boolean).slice(0, 18);
      const favoriteBooks = storage.favorites().map(id => state.books.get(String(id))).filter(Boolean).slice(0, 18);
      const rows = [
        ...(continueBooks.length ? [{ name: 'Continue Listening', books: continueBooks }] : []),
        ...(recentBooks.length ? [{ name: 'Recently Played', books: recentBooks }] : []),
        ...(data.rows || []),
        ...(favoriteBooks.length ? [{ name: 'My List', books: favoriteBooks }] : [])
      ];

      const heroBook = data.hero || rows.flatMap(r => r.books || [])[0];
      view.innerHTML = `${heroBook ? hero(heroBook) : ''}<div class="content-rows">${rows.map(r => row(r.name, r.books)).join('')}</div>`;
      bindCards(view);
      const heroEl = $('[data-hero-id]', view);
      $('[data-hero-info]', heroEl)?.addEventListener('click', () => openDetails(heroBook.id));
      $('[data-hero-play]', heroEl)?.addEventListener('click', () => playBook(heroBook.id));
    } catch (error) {
      view.innerHTML = errorBox('The catalog could not be loaded', error.message);
    }
  }

  function errorBox(title, message) {
    return `<div class="error-box"><h2>${esc(title)}</h2><p>${esc(message || 'Try again in a moment.')}</p><button class="btn secondary" onclick="location.reload()">Retry</button></div>`;
  }

  function renderBrowse() {
    const view = $('#browseView');
    view.innerHTML = `<div class="browse-hero"><h1>Browse</h1><p class="subtext">Explore the full audiobook catalog by category.</p><div class="genre-pills">${GENRES.map(g => `<button class="pill" data-genre="${esc(g)}">${esc(g)}</button>`).join('')}</div></div><div id="browseBody"><div class="grid">${skeletons(18)}</div></div>`;
    $$('.pill', view).forEach(btn => btn.addEventListener('click', () => loadGenre(btn.dataset.genre, btn)));
    loadGenre('Best Sellers', $('.pill', view));
  }

  async function loadGenre(name, button) {
    $$('.pill', $('#browseView')).forEach(el => el.classList.toggle('active', el === button));
    const body = $('#browseBody');
    body.innerHTML = `<div class="grid">${skeletons(18)}</div>`;
    try {
      const genre = name === 'Best Sellers' ? '' : name;
      const { books } = await api({ mode: 'genre', genre, limit: 50 });
      remember(books);
      body.innerHTML = books?.length ? `<div class="grid">${books.map(card).join('')}</div>` : '<div class="empty"><strong>No titles found.</strong>Try another shelf.</div>';
      bindCards(body);
    } catch (error) {
      body.innerHTML = errorBox(`Couldn't load ${name}`, error.message);
    }
  }

  async function renderMyList() {
    const view = $('#myListView');
    view.innerHTML = `<div class="list-hero"><h1>My List</h1><p class="subtext">Saved on this device.</p></div><div class="grid">${skeletons(10)}</div>`;
    const books = await booksByIds(storage.favorites());
    view.innerHTML = `<div class="list-hero"><h1>My List</h1><p class="subtext">Saved on this device.</p></div>${books.length ? `<div class="grid">${books.map(card).join('')}</div>` : '<div class="empty"><strong>Your list is empty.</strong>Add titles with the + button.</div>'}`;
    bindCards(view);
  }

  function detailMarkup(book) {
    const fav = storage.favorites().includes(String(book.id));
    const series = book.series?.map(s => `${s.name}${s.position ? ` #${s.position}` : ''}`).join(', ') || '';
    const metaTop = [author(book), runtime(book), book.releaseDate?.slice(0, 4), book.rating ? `★ ${Number(book.rating).toFixed(1)}` : ''].filter(Boolean).join(' · ');
    return `<section class="detail-hero modern-detail">
      <div class="detail-hero-bg" ${book.cover ? `style="background-image:url('${esc(book.cover)}')"` : ''}></div>
      <div class="detail-hero-copy">
        <div class="eyebrow">AUDIOBOX</div>
        <h2 id="detailTitle">${esc(book.title)}</h2>
        ${book.subtitle ? `<div class="detail-subtitle">${esc(book.subtitle)}</div>` : ''}
        <div class="detail-sub">${esc(metaTop)}</div>
        <div class="detail-actions">
          <button class="btn primary" data-detail-play disabled>Checking playback…</button>
          <button class="circle-btn ${fav ? 'active' : ''}" data-favorite title="Add to My List">${fav ? '✓' : '+'}</button>
        </div>
      </div>
    </section>
    <section class="detail-body">
      <div class="detail-description">${esc(stripHtml(book.description) || 'No description is available for this title.')}</div>
      <div class="meta-list">
        <div><b>Author:</b> ${esc(author(book))}</div>
        ${narrator(book) ? `<div><b>Narrated by:</b> ${esc(narrator(book))}</div>` : ''}
        ${series ? `<div><b>Series:</b> ${esc(series)}</div>` : ''}
        ${book.genres?.length ? `<div><b>Genres:</b> ${esc(book.genres.slice(0, 6).join(', '))}</div>` : ''}
        ${book.publisher ? `<div><b>Publisher:</b> ${esc(book.publisher)}</div>` : ''}
        ${book.language ? `<div><b>Language:</b> ${esc(book.language)}</div>` : ''}
      </div>
    </section>
    <section class="playback-zone" data-playback-zone>
      <div class="playback-check"><div class="loader"></div><div><strong>Finding a playback source</strong><span>Checking AudioBox providers…</span></div></div>
    </section>`;
  }

  async function openDetails(id) {
    const modal = $('#modalBackdrop');
    const content = $('#detailContent');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    content.innerHTML = '<div style="min-height:500px;display:grid;place-items:center"><div class="loader"></div></div>';

    try {
      const book = await getBook(id);
      if (!book) throw new Error('Book metadata unavailable.');
      state.currentBook = book;
      content.innerHTML = detailMarkup(book);
      $('[data-favorite]', content)?.addEventListener('click', event => {
        const added = storage.toggleFavorite(book.id);
        event.currentTarget.textContent = added ? '✓' : '+';
        event.currentTarget.classList.toggle('active', added);
        toast(added ? 'Added to My List' : 'Removed from My List');
      });
      $('[data-detail-play]', content)?.addEventListener('click', () => playBook(book.id));

      const playback = await resolvePlayback(book);
      if (state.currentBook?.id !== book.id) return;
      renderPlaybackZone(book, playback);
    } catch (error) {
      content.innerHTML = errorBox('Could not open this audiobook', error.message);
    }
  }

  function renderPlaybackZone(book, playback) {
    const zone = $('[data-playback-zone]', $('#detailContent'));
    const play = $('[data-detail-play]', $('#detailContent'));
    if (!zone || !play) return;

    if (!playback?.sections?.length) {
      play.disabled = true;
      play.textContent = 'Playback not available yet';
      zone.innerHTML = `<div class="playback-unavailable"><strong>Catalog title added.</strong><span>No public playback match was found for this edition yet. The playback resolver is ready for more providers as we add them.</span></div>`;
      return;
    }

    const p = storage.progress()[String(book.id)];
    play.disabled = false;
    play.textContent = `▶ ${p ? 'Resume' : 'Play'}`;
    zone.innerHTML = `<div class="chapters"><div class="chapters-head"><h3>${playback.sections.length} chapters</h3><span>Playback: Internet Archive / LibriVox</span></div><div class="chapter-list">${playback.sections.map((section, i) => `<button class="chapter" data-chapter-index="${i}"><span class="chapter-num">${i + 1}</span><span><strong>${esc(section.title)}</strong><small>${esc(section.fileName || '')}</small></span><span class="chapter-time">${section.duration ? fmtTime(section.duration) : ''}</span></button>`).join('')}</div></div>`;
    $$('[data-chapter-index]', zone).forEach(btn => btn.addEventListener('click', () => startPlayback(book, playback, Number(btn.dataset.chapterIndex), false)));
  }

  function normalizeTitle(value = '') {
    return String(value).toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(a|an|the|unabridged|audiobook)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function safeLucene(value = '') {
    return String(value).replace(/[\\+\-!(){}\[\]^"~*?:/]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function candidateScore(book, doc) {
    const target = normalizeTitle(book.title);
    const got = normalizeTitle(Array.isArray(doc.title) ? doc.title[0] : doc.title);
    let score = 0;
    if (target && got === target) score += 100;
    else if (target && got && (got.includes(target) || target.includes(got))) score += 65;
    else {
      const a = new Set(target.split(' ').filter(x => x.length > 2));
      const b = new Set(got.split(' ').filter(x => x.length > 2));
      const common = [...a].filter(x => b.has(x)).length;
      score += a.size ? (common / a.size) * 55 : 0;
    }
    const authorText = String(Array.isArray(doc.creator) ? doc.creator.join(' ') : doc.creator || '').toLowerCase();
    const surname = author(book).toLowerCase().split(/\s+/).filter(Boolean).pop();
    if (surname && authorText.includes(surname)) score += 35;
    score += Math.min(15, Math.log10(Number(doc.downloads || 1)) * 3);
    return score;
  }

  async function archiveSearch(book) {
    const title = safeLucene(book.title);
    const creator = safeLucene(author(book));
    const queries = [
      `collection:librivoxaudio AND mediatype:audio AND title:("${title}") AND creator:("${creator}")`,
      `collection:librivoxaudio AND mediatype:audio AND title:("${title}")`
    ];

    for (const q of queries) {
      const params = new URLSearchParams({ q, rows: '10', page: '1', output: 'json' });
      for (const field of ['identifier', 'title', 'creator', 'downloads']) params.append('fl[]', field);
      params.append('sort[]', 'downloads desc');
      const response = await fetch(`${IA.search}?${params.toString()}`, { mode: 'cors' });
      if (!response.ok) continue;
      const data = await response.json();
      const docs = data?.response?.docs || [];
      const ranked = docs.map(doc => ({ doc, score: candidateScore(book, doc) })).sort((a, b) => b.score - a.score);
      if (ranked[0]?.score >= 70) return ranked[0].doc.identifier;
    }
    return null;
  }

  function audioFiles(files) {
    const all = (Array.isArray(files) ? files : []).filter(f => f?.name && !f.private && /MP3/i.test(String(f.format || '')) && !/sample|preview/i.test(String(f.name)));
    const preferred = [
      all.filter(f => /VBR MP3/i.test(String(f.format || ''))),
      all.filter(f => /64Kbps MP3/i.test(String(f.format || ''))),
      all.filter(f => /128Kbps MP3/i.test(String(f.format || ''))),
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

  function parseLength(value) {
    if (Number.isFinite(Number(value)) && String(value).trim() !== '') return Number(value);
    const parts = String(value || '').split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((n, p) => n * 60 + p, 0);
  }

  async function playbackFromIdentifier(identifier) {
    const response = await fetch(`${IA.metadata}${encodeURIComponent(identifier)}`, { mode: 'cors' });
    if (!response.ok) throw new Error(`Playback metadata returned ${response.status}`);
    const payload = await response.json();
    const files = audioFiles(payload?.files || []);
    const sections = files.map((file, index) => ({
      index,
      title: file.title || file.track || String(file.name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
      fileName: file.name,
      duration: parseLength(file.length),
      url: `${IA.download}${encodeURIComponent(identifier)}/${String(file.name).split('/').map(encodeURIComponent).join('/')}`
    }));
    return { identifier, sourceUrl: `${IA.details}${encodeURIComponent(identifier)}`, sections };
  }

  async function resolvePlayback(book) {
    const id = String(book.id);
    if (state.playback.has(id)) return state.playback.get(id);
    if (state.playbackPromises.has(id)) return state.playbackPromises.get(id);

    const task = (async () => {
      const stored = storage.playbackMap()[id];
      const age = Date.now() - Number(stored?.checkedAt || 0);
      if (stored?.identifier && age < 30 * 86400000) {
        try {
          const playback = await playbackFromIdentifier(stored.identifier);
          state.playback.set(id, playback);
          return playback;
        } catch {}
      }
      if (stored?.notFound && age < 86400000) {
        const none = { identifier: null, sections: [] };
        state.playback.set(id, none);
        return none;
      }

      try {
        const identifier = await archiveSearch(book);
        if (!identifier) {
          storage.savePlayback(id, { notFound: true });
          const none = { identifier: null, sections: [] };
          state.playback.set(id, none);
          return none;
        }
        const playback = await playbackFromIdentifier(identifier);
        if (!playback.sections.length) throw new Error('No audio files');
        storage.savePlayback(id, { identifier });
        state.playback.set(id, playback);
        return playback;
      } catch (error) {
        console.warn('AudioBox playback resolver:', error);
        const none = { identifier: null, sections: [] };
        state.playback.set(id, none);
        return none;
      }
    })().finally(() => state.playbackPromises.delete(id));

    state.playbackPromises.set(id, task);
    return task;
  }

  async function playBook(id) {
    const book = await getBook(id).catch(() => state.books.get(String(id)) || null);
    if (!book) return toast('Could not load this title.');
    toast('Finding playback…');
    const playback = await resolvePlayback(book);
    if (!playback?.sections?.length) {
      toast('No playback source for this title yet.');
      if (!$('#modalBackdrop').classList.contains('open')) openDetails(book.id);
      return;
    }
    const p = storage.progress()[String(book.id)];
    startPlayback(book, playback, Math.min(Number(p?.chapterIndex || 0), playback.sections.length - 1), true);
  }

  function startPlayback(book, playback, chapterIndex = 0, resume = true) {
    const audio = $('#audio');
    const section = playback.sections[chapterIndex];
    if (!section) return;
    state.currentBook = book;
    state.currentPlayback = playback;
    state.currentChapter = chapterIndex;
    storage.rememberBook(book);
    storage.touchRecent(book.id);

    audio.src = section.url;
    audio.playbackRate = Number($('#speedBtn').dataset.speed || 1);
    $('#player').classList.add('show');
    $('#player').setAttribute('aria-hidden', 'false');
    $('#playerTitle').textContent = book.title;
    $('#playerChapter').textContent = section.title;
    $('#playerCover').src = book.cover || '';
    $('#playerCover').alt = book.title;

    const p = storage.progress()[String(book.id)];
    audio.addEventListener('loadedmetadata', function restore() {
      if (resume && p && Number(p.chapterIndex) === chapterIndex && Number(p.time) > 0 && Number(p.time) < audio.duration - 5) audio.currentTime = Number(p.time);
      audio.play().catch(() => {});
    }, { once: true });

    updateMediaSession(book, section);
    updatePlayingChapter();
  }

  function updateMediaSession(book, section) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: section.title || book.title,
        artist: author(book),
        album: book.title,
        artwork: book.cover ? [{ src: book.cover, sizes: '512x512' }] : []
      });
    } catch {}
  }

  function updatePlayingChapter() {
    $$('[data-chapter-index]', $('#detailContent')).forEach(el => el.classList.toggle('playing', Number(el.dataset.chapterIndex) === state.currentChapter));
  }

  function absoluteProgress() {
    if (!state.currentPlayback) return 0;
    const before = state.currentPlayback.sections.slice(0, state.currentChapter).reduce((sum, s) => sum + Number(s.duration || 0), 0);
    return before + Number($('#audio').currentTime || 0);
  }

  function fullPlaybackDuration() {
    return state.currentPlayback?.sections?.reduce((sum, s) => sum + Number(s.duration || 0), 0) || (state.currentBook?.durationMinutes || 0) * 60;
  }

  function saveProgress(force = false) {
    const audio = $('#audio');
    const book = state.currentBook;
    if (!book || !state.currentPlayback?.sections?.length) return;
    const now = Date.now();
    if (!force && now - state.lastProgressSave < 5000) return;
    state.lastProgressSave = now;
    storage.saveProgress(book.id, {
      chapterIndex: state.currentChapter,
      time: audio.currentTime || 0,
      absoluteTime: absoluteProgress(),
      bookDuration: fullPlaybackDuration()
    });
  }

  function nextChapter(delta = 1) {
    if (!state.currentPlayback || !state.currentBook) return;
    const next = state.currentChapter + delta;
    if (next < 0 || next >= state.currentPlayback.sections.length) return;
    saveProgress(true);
    startPlayback(state.currentBook, state.currentPlayback, next, false);
  }

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function closeModal() {
    $('#modalBackdrop').classList.remove('open');
    $('#modalBackdrop').setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function switchView(name) {
    state.currentView = name;
    $$('.view').forEach(view => view.classList.toggle('active', view.id === `${name === 'mylist' ? 'myList' : name}View`));
    $$('.navlink').forEach(btn => btn.classList.toggle('active', btn.dataset.nav === name));
    if (name === 'browse') renderBrowse();
    if (name === 'mylist') renderMyList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function initSearch() {
    const panel = $('#searchPanel');
    const input = $('#searchInput');
    const results = $('#searchResults');
    const meta = $('#searchMeta');
    const open = () => { panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false'); setTimeout(() => input.focus(), 80); };
    const close = () => { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); input.blur(); };
    $('#searchToggle').addEventListener('click', open);
    $('#searchClose').addEventListener('click', close);

    input.addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      const q = input.value.trim();
      if (q.length < 2) {
        meta.textContent = 'Search the AudioBox catalog';
        results.innerHTML = '';
        return;
      }
      meta.textContent = 'Searching…';
      results.innerHTML = skeletons(12);
      state.searchTimer = setTimeout(async () => {
        try {
          const { books } = await api({ mode: 'search', q, limit: 40 });
          remember(books);
          meta.textContent = `${books.length} result${books.length === 1 ? '' : 's'} for “${q}”`;
          results.innerHTML = books.length ? books.map(card).join('') : '<div class="empty"><strong>No matches.</strong>Try another title or author.</div>';
          bindCards(results);
        } catch (error) {
          meta.textContent = error.message;
          results.innerHTML = '';
        }
      }, 350);
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (panel.classList.contains('open')) close();
        else if ($('#modalBackdrop').classList.contains('open')) closeModal();
      }
    });
  }

  function initPlayer() {
    const audio = $('#audio');
    const play = $('#playToggle');
    const seek = $('#seek');
    const volume = $('#volume');
    const speed = $('#speedBtn');
    const sleep = $('#sleepBtn');

    play.addEventListener('click', () => audio.paused ? audio.play().catch(() => {}) : audio.pause());
    $('#prevChapter').addEventListener('click', () => nextChapter(-1));
    $('#nextChapter').addEventListener('click', () => nextChapter(1));
    $('#playerExpand').addEventListener('click', () => state.currentBook && openDetails(state.currentBook.id));

    audio.addEventListener('play', () => { play.textContent = '❚❚'; });
    audio.addEventListener('pause', () => { play.textContent = '▶'; saveProgress(true); });
    audio.addEventListener('timeupdate', () => {
      $('#currentTime').textContent = fmtTime(audio.currentTime);
      $('#duration').textContent = fmtTime(audio.duration);
      if (Number.isFinite(audio.duration) && audio.duration > 0) seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
      saveProgress(false);
    });
    audio.addEventListener('durationchange', () => { $('#duration').textContent = fmtTime(audio.duration); });
    audio.addEventListener('ended', () => {
      if (state.currentPlayback && state.currentChapter < state.currentPlayback.sections.length - 1) nextChapter(1);
      else saveProgress(true);
    });

    seek.addEventListener('input', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
    });
    volume.addEventListener('input', () => { audio.volume = Number(volume.value); });
    audio.volume = Number(volume.value);

    const speeds = [1, 1.25, 1.5, 1.75, 2, 0.75];
    speed.dataset.speed = '1';
    speed.addEventListener('click', () => {
      const current = Number(speed.dataset.speed || 1);
      const next = speeds[(speeds.indexOf(current) + 1) % speeds.length];
      speed.dataset.speed = String(next);
      speed.textContent = `${next}×`;
      audio.playbackRate = next;
    });

    const sleepOptions = [0, 15, 30, 45, 60];
    let sleepIndex = 0;
    sleep.addEventListener('click', () => {
      sleepIndex = (sleepIndex + 1) % sleepOptions.length;
      const mins = sleepOptions[sleepIndex];
      clearTimeout(state.sleepTimer);
      if (!mins) {
        sleep.textContent = '☾';
        toast('Sleep timer off');
      } else {
        sleep.textContent = `${mins}m`;
        state.sleepTimer = setTimeout(() => { audio.pause(); sleep.textContent = '☾'; sleepIndex = 0; toast('Sleep timer finished'); }, mins * 60000);
        toast(`Sleep timer: ${mins} minutes`);
      }
    });

    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler?.('play', () => audio.play());
      navigator.mediaSession.setActionHandler?.('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler?.('previoustrack', () => nextChapter(-1));
      navigator.mediaSession.setActionHandler?.('nexttrack', () => nextChapter(1));
      navigator.mediaSession.setActionHandler?.('seekbackward', details => { audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 15)); });
      navigator.mediaSession.setActionHandler?.('seekforward', details => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (details.seekOffset || 30)); });
    }
  }

  function initNav() {
    $$('[data-nav]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.nav)));
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalBackdrop').addEventListener('click', event => { if (event.target === event.currentTarget) closeModal(); });
    window.addEventListener('scroll', () => $('#topbar').classList.toggle('scrolled', window.scrollY > 35), { passive: true });
  }

  async function init() {
    restoreSnapshots();
    initNav();
    initSearch();
    initPlayer();
    renderHome();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  window.addEventListener('beforeunload', () => saveProgress(true));
  window.addEventListener('DOMContentLoaded', init);
})();
