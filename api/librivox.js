'use strict';
const { getLibriVox } = require('../lib/providers');

module.exports = async function handler(req, res) {
  try {
    const books = await getLibriVox(req.query || {});
    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=86400');
    res.status(200).json({ books });
  } catch (error) {
    res.status(502).json({ error: 'LibriVox is temporarily unavailable.', detail: error.message });
  }
};
