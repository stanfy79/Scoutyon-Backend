import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Session } from '../models/Session.js';
import { runAgent } from '../agent/runner.js';
import { buildSessionSummaryFromMessages } from '../services/sessionMemory.js';

const router = Router();
router.use(authMiddleware);

/**
 * POST /api/agent/chat
 * Start or continue an agent session. Streams the response as Server-Sent Events.
 *
 * Body: { goal: string, budgetId?: string, sessionId?: string }
 *
 * SSE event types: session | text | tool_call | tool_result | quote | error | done
 */
router.post('/chat', async (req, res, next) => {
  try {
    const { goal, budgetId, sessionId } = req.body as { goal?: string; budgetId?: string; sessionId?: string };

    if (!goal || goal.trim().length === 0) {
      res.status(400).json({ error: 'goal is required' });
      return;
    }

    const trimmedGoal = goal.trim();
    if (sessionId && !/^[a-f\d]{24}$/i.test(sessionId)) {
      res.status(400).json({ error: 'sessionId is invalid' });
      return;
    }
    let session = sessionId
      ? await Session.findOne({ _id: sessionId, userId: req.userId })
      : null;

    if (sessionId && !session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (!session) {
      session = await Session.create({
        userId: req.userId,
        budgetId: budgetId || undefined,
        goal: trimmedGoal,
        messages: [],
        status: 'active',
      });
    }

    session.goal = trimmedGoal;
    session.status = 'active';
    session.messages = session.messages ?? [];
    session.messages.push({ role: 'user', content: trimmedGoal, timestamp: new Date() });
    session.sessionSummary = buildSessionSummaryFromMessages(session.messages, session.sessionSummary);
    await session.save();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Session-Id', session._id.toString());
    res.flushHeaders();

    res.write(
      `data: ${JSON.stringify({ type: 'session', data: { sessionId: session._id.toString(), resumed: Boolean(sessionId) } })}\n\n`,
    );

    await runAgent({
      goal: trimmedGoal,
      sessionId: session._id.toString(),
      userId: req.userId!,
      budgetId,
      history: [],
      res,
    });

    res.end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/agent/sessions
 * List all sessions for the authenticated user.
 */
router.get('/sessions', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const safePage = Number.isFinite(page) && page > 0 ? page : 1;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20;

    const [sessions, total] = await Promise.all([
      Session.find({ userId: req.userId })
        .select('-messages')
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),
      Session.countDocuments({ userId: req.userId }),
    ]);

    res.json({
      sessions,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/agent/sessions/:id
 * Get a single session including a summary and messages.
 */
router.get('/sessions/:id', async (req, res, next) => {
  try {
    const session = await Session.findOne({
      _id: req.params.id,
      userId: req.userId,
    }).lean();
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    next(err);
  }
});

router.get('/sessions/:id/messages', async (req, res, next) => {
  try {
    const session = await Session.findOne({
      _id: req.params.id,
      userId: req.userId,
    }).lean();

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const safePage = Number.isFinite(page) && page > 0 ? page : 1;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const total = messages.length;
    const start = (safePage - 1) * safeLimit;
    const pageMessages = messages.slice(start, start + safeLimit);

    res.json({
      sessionId: session._id,
      messages: pageMessages,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sessions/:id/memory', async (req, res, next) => {
  try {
    const session = await Session.findOne({
      _id: req.params.id,
      userId: req.userId,
    }).lean();

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json({
      sessionSummary: session.sessionSummary ?? null,
      transactionContext: session.transactionContext ?? null,
      recentMessages: Array.isArray(session.messages) ? session.messages.slice(-12) : [],
    });
  } catch (err) {
    next(err);
  }
});

export default router;
