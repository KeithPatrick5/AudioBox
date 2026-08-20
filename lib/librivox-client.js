'use strict';

(() => {
  const nativeFetch = window.fetch.bind(window);
  let active = 0;
  const queue = [];
  const MAX_CONCURRENT = 2;

  function runQueued(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const item = queue.shift();
      active++;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function directLibriVox(searchParams) {
    return runQueued(() => new Promise((resolve, reject) => {
      const callback = `__audiobox_lv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const params = new URLSearchParams(searchParams);
      params.set('format', 'jsonp');
      params.set('extended', '1');
      params.set('coverart', '1');

      for (const key of ['title', 'author', 'genre']) {
        const value = params.get(key);
        if (value && !value.startsWith('^')) params.set(key, `^${value}`);
      }

      params.set('callback', callback);
      const script = document.createElement('script');
      let finished = false;
      const timer = setTimeout(() => finish(new Error('LibriVox request timed out')), 15000);

      function cleanup() {
        clearTimeout(timer);
        script.remove();
        try { delete window[callback]; } catch { window[callback] = undefined; }
      }

      function finish(error, data) {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error); else resolve(data);
      }

      window[callback] = data => finish(null, data);
      script.onerror = () => finish(new Error('LibriVox direct request failed'));
      script.src = `https://librivox.org/api/feed/audiobooks/?${params.toString()}`;
      document.head.appendChild(script);
    }));
  }

  window.fetch = async function audioBoxFetch(resource, init) {
    const url = typeof resource === 'string' ? resource : resource?.url;
    if (!url || !url.startsWith('/api/librivox')) return nativeFetch(resource, init);

    try {
      const parsed = new URL(url, location.origin);
      const payload = await directLibriVox(parsed.searchParams);
      const books = Array.isArray(payload?.books) ? payload.books : [];
      return new Response(JSON.stringify({ books }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    } catch (directError) {
      try {
        return await nativeFetch(resource, init);
      } catch {
        throw directError;
      }
    }
  };
})();
