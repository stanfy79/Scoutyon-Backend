import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { Session } from '../models/Session.js';
import { runAgent } from '../agent/runner.js';

const router = Router();
router.use(authMiddleware);

/**
 * POST /api/agent/chat
 * Start a new agent session. Streams the response as Server-Sent Events.
 *
 * Body: { goal: string, budgetId?: string }
 *
 * SSE event types: session | text | tool_call | tool_result | quote | error | done
 */
router.post('/chat', async (req, res, next) => {
  try {
    const { goal, budgetId } = req.body as { goal?: string; budgetId?: string };

    if (!goal || goal.trim().length === 0) {
      res.status(400).json({ error: 'goal is required' });
      return;
    }

    // Create session record
    const session = await Session.create({
      userId: req.userId,
      budgetId: budgetId || undefined,
      goal: goal.trim(),
      messages: [{ role: 'user', content: goal.trim(), timestamp: new Date() }],
      status: 'active',
    });

    // Open SSE stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Session-Id', session._id.toString());
    res.flushHeaders();

    // First event carries the sessionId so the client can reference quotes later
    res.write(
      `data: ${JSON.stringify({ type: 'session', data: { sessionId: session._id.toString() } })}\n\n`,
    );

    await runAgent({
      goal: goal.trim(),
      sessionId: session._id.toString(),
      userId: req.userId!,
      budgetId,
      history: [],
      res,
    });

    await Session.findByIdAndUpdate(session._id, { status: 'completed' });
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
    const sessions = await Session.find({ userId: req.userId })
      .select('-messages')
      .sort({ createdAt: -1 })
      .lean();
    res.json(sessions);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/agent/sessions/:id
 * Get a single session including messages.
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

export default router;
