// Аутентификация: хэширование паролей, JWT-токены входа, middleware.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const TOKEN_TTL = '365d'; // вход живёт 1 год

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function signToken(brigadierId, secret) {
  return jwt.sign({ id: brigadierId }, secret, { expiresIn: TOKEN_TTL });
}

function verifyToken(token, secret) {
  try {
    return jwt.verify(token, secret); // { id, iat, exp }
  } catch (e) {
    return null;
  }
}

// Фабрика middleware: требует вошедшего активного бригадира.
// getSecret — функция, возвращающая текущий секрет подписи.
function requireAuth(pool, getSecret) {
  return async (req, res, next) => {
    try {
      const token = req.cookies && req.cookies.token;
      if (!token) return res.status(401).json({ error: 'Требуется вход' });
      const payload = verifyToken(token, getSecret());
      if (!payload) return res.status(401).json({ error: 'Требуется вход' });
      const r = await pool.query(
        'SELECT id, login, status, is_admin FROM brigadiers WHERE id = $1',
        [payload.id]
      );
      const brigadier = r.rows[0];
      if (!brigadier || brigadier.status !== 'active') {
        return res.status(401).json({ error: 'Требуется вход' });
      }
      req.brigadier = brigadier;
      next();
    } catch (err) {
      console.error('Auth error:', err);
      res.status(500).json({ error: err.message });
    }
  };
}

// Требует, чтобы вошедший был администратором. Ставится после requireAuth.
function requireAdmin(req, res, next) {
  if (!req.brigadier || !req.brigadier.is_admin) {
    return res.status(403).json({ error: 'Доступ только для администратора' });
  }
  next();
}

module.exports = {
  hashPassword, verifyPassword, signToken, verifyToken, requireAuth, requireAdmin,
};
