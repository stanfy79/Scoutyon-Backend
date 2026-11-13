import assert from 'node:assert';
import express from 'express';
import { authMiddleware } from '../src/middleware/auth.js';
import * as privyService from '../src/services/privy.js';
import { User } from '../src/models/User.js';

console.log('--- Starting Auth Middleware Mock Tests ---');

// Mock express request & response helpers
function createMockReqRes(headers: Record<string, string>) {
  const req: any = { headers };
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
  };
  return { req, res };
}

async function runMiddlewareTests() {
  // Test 1: Missing Authorization Header
  {
    const { req, res } = createMockReqRes({});
    let nextCalled = false;
    await authMiddleware(req, res, () => { nextCalled = true; });
    assert.strictEqual(res.statusCode, 401, 'Must return 401 on missing auth header');
    assert.strictEqual(nextCalled, false, 'next() must not be called');
    console.log('✓ Missing Authorization header rejected with 401');
  }

  // Test 2: Invalid Bearer Format
  {
    const { req, res } = createMockReqRes({ authorization: 'Basic 12345' });
    let nextCalled = false;
    await authMiddleware(req, res, () => { nextCalled = true; });
    assert.strictEqual(res.statusCode, 401, 'Must return 401 on non-Bearer format');
    assert.strictEqual(nextCalled, false, 'next() must not be called');
    console.log('✓ Non-Bearer Authorization header rejected with 401');
  }

  // Test 3: Empty Token
  {
    const { req, res } = createMockReqRes({ authorization: 'Bearer ' });
    let nextCalled = false;
    await authMiddleware(req, res, () => { nextCalled = true; });
    assert.strictEqual(res.statusCode, 401, 'Must return 401 on empty token');
    assert.strictEqual(nextCalled, false, 'next() must not be called');
    console.log('✓ Empty Bearer token rejected with 401');
  }

  // Test 4: Deprecated endpoint check
  {
    const app = express();
    app.use(express.json());
    const authRoutes = (await import('../src/routes/auth.js')).default;
    app.use('/api/auth', authRoutes);

    // Call POST /api/auth/register
    const req: any = { method: 'POST', url: '/api/auth/register', headers: {} };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(data: any) { this.body = data; return this; }
    };
    
    // We can simulate calling the route handler directly
    const routes = (authRoutes as any).stack;
    const registerRoute = routes.find((r: any) => r.route?.path === '/register');
    assert.ok(registerRoute, 'POST /register route exists');
    
    const handler = registerRoute.route.stack[0].handle;
    handler(req, res);
    assert.strictEqual(res.statusCode, 410, 'Deprecated register must return 410 Gone');
    console.log('✓ Deprecated /api/auth/register returns 410 Gone');
  }

  console.log('--- All Auth Middleware Mock Tests Passed! ---');
}

runMiddlewareTests().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
