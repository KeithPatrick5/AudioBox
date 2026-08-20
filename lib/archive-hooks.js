'use strict';

(() => {
  const originalOpenDetails = window.openDetails;
  const originalPlayBook = window.playBook;

  async function refreshBook(id) {
    try {
      await window.fetchBooks({ id, limit: 1 });
    } catch (error) {
      console.warn('AudioBox: could not load full audiobook metadata', error);
    }
  }

  if (typeof originalOpenDetails === 'function') {
    window.openDetails = async function archiveOpenDetails(id) {
      await refreshBook(id);
      return originalOpenDetails(id);
    };
  }

  if (typeof originalPlayBook === 'function') {
    window.playBook = async function archivePlayBook(id, chapterIndex) {
      await refreshBook(id);
      return originalPlayBook(id, chapterIndex);
    };
  }
})();
