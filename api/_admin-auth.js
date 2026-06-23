import crypto from "node:crypto";

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function credentials(req) {
  const header = String(req.headers.authorization || "");
  if (/^basic\s+/i.test(header)) {
    try {
      const decoded = Buffer.from(header.replace(/^basic\s+/i, ""), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        return {
          user: decoded.slice(0, separator),
          password: decoded.slice(separator + 1),
        };
      }
    } catch {
      // Invalid Basic auth is handled as an ordinary authentication failure.
    }
  }
  return {
    user: String(req.headers["x-admin-user"] || ""),
    password: String(req.headers["x-admin-pass"] || ""),
  };
}

export function isAdmin(req) {
  const expectedUser = process.env.ALPHY_ADMIN_USER;
  const expectedPassword = process.env.ALPHY_ADMIN_PASSWORD;
  if (!expectedUser || !expectedPassword) return false;
  const supplied = credentials(req);
  return safeEqual(supplied.user, expectedUser) && safeEqual(supplied.password, expectedPassword);
}

export function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", 'Basic realm="alphy admin"');
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, error: "admin_auth_required" }));
  return false;
}
