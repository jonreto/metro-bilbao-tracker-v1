// Vercel serverless function: GET /api/live
const { getLive } = require('../lib/realtime');
module.exports = async (req, res) => {
  try {
    const live = await getLive();
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(live));
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
};
