import mongoose, { Schema, Document } from 'mongoose';

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface ISessionMemorySummary {
  sessionSummary: string;
  activeIntent?: string;
  knownParameters: Record<string, unknown>;
  pendingClarifications: string[];
  pendingTransactionId?: string | null;
}

export interface ITransactionContextMemory {
  activeTransactionIntent?: string;
  sourceAsset?: string;
  sourceNetwork?: string;
  destinationAsset?: string;
  destinationNetwork?: string;
  amount?: string;
  recipientAddress?: string;
  quoteId?: string | null;
  preparationId?: string | null;
  quoteExpiry?: Date | null;
  preparationExpiry?: Date | null;
  transactionStatus?: string;
  outstandingUserAction?: string | null;
}

export interface IMessage {
  role: MessageRole;
  content: string;
  toolName?: string;
  timestamp: Date;
}

export interface ISession extends Document {
  userId: mongoose.Types.ObjectId;
  budgetId?: mongoose.Types.ObjectId;
  goal: string;
  messages: IMessage[];
  sessionSummary: ISessionMemorySummary;
  transactionContext: ITransactionContextMemory;
  status: 'active' | 'archived' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    role: { type: String, enum: ['user', 'assistant', 'tool'], required: true },
    content: { type: String, required: true },
    toolName: { type: String },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const sessionSummarySchema = new Schema<ISessionMemorySummary>(
  {
    sessionSummary: { type: String, default: '' },
    activeIntent: { type: String, default: 'general_chat' },
    knownParameters: { type: Schema.Types.Mixed, default: {} },
    pendingClarifications: { type: [String], default: [] },
    pendingTransactionId: { type: String, default: null },
  },
  { _id: false },
);

const transactionContextSchema = new Schema<ITransactionContextMemory>(
  {
    activeTransactionIntent: { type: String },
    sourceAsset: { type: String },
    sourceNetwork: { type: String },
    destinationAsset: { type: String },
    destinationNetwork: { type: String },
    amount: { type: String },
    recipientAddress: { type: String },
    quoteId: { type: String, default: null },
    preparationId: { type: String, default: null },
    quoteExpiry: { type: Date, default: null },
    preparationExpiry: { type: Date, default: null },
    transactionStatus: { type: String },
    outstandingUserAction: { type: String, default: null },
  },
  { _id: false },
);

const sessionSchema = new Schema<ISession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    budgetId: { type: Schema.Types.ObjectId, ref: 'Budget' },
    goal: { type: String, required: true },
    messages: [messageSchema],
    sessionSummary: { type: sessionSummarySchema, default: () => ({
      sessionSummary: '',
      activeIntent: 'general_chat',
      knownParameters: {},
      pendingClarifications: [],
      pendingTransactionId: null,
    }) },
    transactionContext: { type: transactionContextSchema, default: {} },
    status: {
      type: String,
      enum: ['active', 'archived', 'failed'],
      default: 'active',
    },
  },
  { timestamps: true },
);

export const Session = mongoose.model<ISession>('Session', sessionSchema);
