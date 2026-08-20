'use strict';
const { getWikipediaAuthor } = require('../lib/providers');

module.exports = async function handler(req, res) {
  try {
    const author = await getWikipediaAuthor(req.query || {});
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json({ author });
  } catch (error) {
    res.status(502).json({ error: 'Author information is temporarily unavailable.', detail: error.message });
  }
};
