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
import paymentRoutes from './routes/payments.js';
import transferRoutes from './routes/transfers.js';
import { assertSignerInfrastructure } from './services/privyPaymentSigner.js';
import vendorRoutes from './vendor.routes.js';
import purchaseRoutes from './purchase.routes.js';

const app = express();

// ── Global middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin:
    config.CORS_ORIGINS.length > 0
      ? config.CORS_ORIGINS
      : config.NODE_ENV === 'development'
        ? true
        : false,
}));
app.use(morgan(config.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/quotes', quoteRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/transfers', transferRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Error handler (must be last) ─────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  await connectDB();
  if (config.PAYMENTS_LIVE_ENABLED) {
    await assertSignerInfrastructure();
  }
  app.listen(config.PORT, () => {
    console.log(`Scoutyon Backend running on http://localhost:${config.PORT}`);
    console.log(`Live payments enabled: ${config.PAYMENTS_LIVE_ENABLED && !config.SIMULATE_PAYMENTS}`);
  });
}

start().catch((error: unknown) => {
  const failure = error as { code?: string; message?: string };
  console.error(
    `Scoutyon Backend startup failed${failure.code ? ` (${failure.code})` : ''}: ${failure.message ?? 'Unknown error'}`,
  );
  process.exitCode = 1;
});
