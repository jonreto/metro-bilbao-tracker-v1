// Vercel serverless function: GET /api/timetable (CDN-cached for 6 h)
const { getTimetable } = require('../lib/static-feed');
module.exports = async (req, res) => {
  try {
    const tt = await getTimetable();
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Timetable-Source', tt.source);
    res.status(200).send(tt.json);
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
};
