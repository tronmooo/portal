// Minimal test to verify function works
module.exports = function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.statusCode = 200;
  res.end(JSON.stringify({ status: "ok", url: req.url, method: req.method }));
};
