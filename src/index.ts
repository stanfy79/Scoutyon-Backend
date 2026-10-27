import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { connectDB } from './db/connect.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import agentRoutes from './routes/agent.js';
import budgetRoutes from './routes/budgets.js';
import quoteRoutes from './routes/quotes.js';
import transactionRoutes from './routes/transactions.js';

const app = express();

// ── Global middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(morgan(config.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/quotes', quoteRoutes);
app.use('/api/transactions', transactionRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Error handler (must be last) ─────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(config.PORT, () => {
    console.log(`Scoutyon Backend running on http://localhost:${config.PORT}`);
    console.log(`Simulate payments: ${config.SIMULATE_PAYMENTS}`);
    console.log(`NEAR network: ${config.NEAR_NETWORK}`);
  });
});
