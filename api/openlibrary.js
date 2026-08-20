'use strict';
const { searchOpenLibrary } = require('../lib/providers');

module.exports = async function handler(req, res) {
  try {
    const results = await searchOpenLibrary(req.query || {});
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json({ results });
  } catch (error) {
    res.status(502).json({ error: 'Open Library is temporarily unavailable.', detail: error.message });
  }
};
