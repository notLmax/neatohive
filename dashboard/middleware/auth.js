'use strict';

const crypto = require('crypto');

function createAuthMiddleware(expectedToken) {
  if (!expectedToken || typeof expectedToken !== 'string') {
    throw new Error('createAuthMiddleware: expectedToken must be a non-empty string');
  }

  const expectedBuf = Buffer.from(expectedToken, 'utf8');

  return function authMiddleware(req, res, next) {
    const presentedToken = tokenFromRequest(req);
    if (typeof presentedToken !== 'string') {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const presentedBuf = Buffer.from(presentedToken, 'utf8');

    if (presentedBuf.length !== expectedBuf.length) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    if (!crypto.timingSafeEqual(presentedBuf, expectedBuf)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    return next();
  };
}

function tokenFromRequest(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (typeof header === 'string') {
    const match = header.match(/^Bearer (.+)$/i);
    if (match) {
      return match[1];
    }
  }

  const queryToken = req.query && typeof req.query.token === 'string' ? req.query.token : null;
  if (queryToken) {
    return queryToken;
  }

  return null;
}

module.exports = { createAuthMiddleware };
