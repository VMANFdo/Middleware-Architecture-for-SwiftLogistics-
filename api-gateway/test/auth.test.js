'use strict';

const jwt = require('jsonwebtoken');
const {
  createAccessToken,
  authenticateToken,
  requireRole,
  asyncRoute,
} = require('../app');

const SECRET = process.env.JWT_SECRET;
const ISSUER = 'swifttrack-api-gateway';
const AUDIENCE = 'swifttrack-apps';

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
}

function runMiddleware(middleware, req) {
  const res = mockRes();
  const next = jest.fn();
  middleware(req, res, next);
  return { res, next };
}

describe('createAccessToken', () => {
  test('round-trips identity and role through the token', () => {
    const token = createAccessToken({
      id: 'CLT001',
      role: 'client',
      email: 'techmart@example.com',
      name: 'TechMart Online',
    });

    const claims = jwt.verify(token, SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });

    expect(claims.sub).toBe('CLT001');
    expect(claims.role).toBe('client');
    expect(claims.email).toBe('techmart@example.com');
    expect(claims.name).toBe('TechMart Online');
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.iat).toEqual(expect.any(Number));
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  test('omits the subject from the top-level claims we expose', () => {
    const token = createAccessToken({ id: 'DRV001', role: 'driver', email: 'x@y.z', name: 'X' });
    const claims = jwt.decode(token);
    expect(claims.sub).toBe('DRV001');
    expect(claims.id).toBeUndefined();
  });
});

describe('authenticateToken', () => {
  const validToken = createAccessToken({
    id: 'CLT001',
    role: 'client',
    email: 'techmart@example.com',
    name: 'TechMart Online',
  });

  test('rejects a request with no Authorization header', () => {
    const { res, next } = runMiddleware(authenticateToken, { get: () => undefined });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  test('rejects a non-Bearer scheme', () => {
    const { res, next } = runMiddleware(authenticateToken, {
      get: () => `Basic ${validToken}`,
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('accepts a valid Bearer token and attaches the claims', () => {
    const req = { get: () => `Bearer ${validToken}` };
    const { res, next } = runMiddleware(authenticateToken, req);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth).toMatchObject({ sub: 'CLT001', role: 'client' });
  });

  test('rejects an expired token with a specific message', () => {
    const expired = jwt.sign({ role: 'client' }, SECRET, {
      subject: 'CLT001',
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithm: 'HS256',
      expiresIn: '-10s',
    });

    const { res, next } = runMiddleware(authenticateToken, { get: () => `Bearer ${expired}` });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Access token has expired' }),
    );
  });

  test('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ role: 'client', sub: 'CLT001' }, 'attacker-secret', {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithm: 'HS256',
    });

    const { res, next } = runMiddleware(authenticateToken, { get: () => `Bearer ${forged}` });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Access token is invalid' }),
    );
  });

  test('rejects the alg:none token-forgery attack', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        role: 'client',
        sub: 'CLT001',
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const forged = `${header}.${payload}.`;

    const { res, next } = runMiddleware(authenticateToken, { get: () => `Bearer ${forged}` });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects a token minted for a different issuer', () => {
    const wrongIssuer = jwt.sign({ role: 'client' }, SECRET, {
      subject: 'CLT001',
      issuer: 'some-other-service',
      audience: AUDIENCE,
      algorithm: 'HS256',
    });

    const { res, next } = runMiddleware(authenticateToken, { get: () => `Bearer ${wrongIssuer}` });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects a token minted for a different audience', () => {
    const wrongAudience = jwt.sign({ role: 'client' }, SECRET, {
      subject: 'CLT001',
      issuer: ISSUER,
      audience: 'someone-else',
      algorithm: 'HS256',
    });

    const { res, next } = runMiddleware(authenticateToken, { get: () => `Bearer ${wrongAudience}` });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireRole', () => {
  const clientToken = createAccessToken({ id: 'CLT001', role: 'client', email: 'a@b.c', name: 'A' });
  const driverToken = createAccessToken({ id: 'DRV001', role: 'driver', email: 'd@e.f', name: 'D' });

  function verifyWith(middleware, token) {
    const req = { get: () => `Bearer ${token}` };
    const authRes = mockRes();
    const authNext = jest.fn();
    authenticateToken(req, authRes, authNext);
    if (!authNext.mock.calls.length) {
      throw new Error('token did not authenticate');
    }

    const { res, next } = runMiddleware(middleware, req);
    return { allowed: next.mock.calls.length > 0, res };
  }

  test('allows an explicitly permitted role', () => {
    const { allowed } = verifyWith(requireRole('client'), clientToken);
    expect(allowed).toBe(true);
  });

  test('allows any of several permitted roles', () => {
    expect(verifyWith(requireRole('client', 'driver'), clientToken).allowed).toBe(true);
    expect(verifyWith(requireRole('client', 'driver'), driverToken).allowed).toBe(true);
  });

  test('rejects a role that is not in the allow-list', () => {
    const { allowed, res } = verifyWith(requireRole('driver'), clientToken);
    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'You do not have permission to access this resource',
      }),
    );
  });

  test('rejects when no authenticated user is attached at all', () => {
    const { res, next } = runMiddleware(requireRole('client'), {});
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('asyncRoute', () => {
  test('passes a resolved handler result to the response', async () => {
    const handler = asyncRoute(async (req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = mockRes();
    const next = jest.fn();
    await handler({}, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('forwards a rejected handler to the Express error middleware', async () => {
    const boom = new Error('downstream exploded');
    const handler = asyncRoute(async () => {
      throw boom;
    });

    const next = jest.fn();
    await handler({}, mockRes(), next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});
