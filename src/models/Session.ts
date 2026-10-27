import mongoose, { Schema, Document } from 'mongoose';

export type MessageRole = 'user' | 'assistant' | 'tool';

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
  status: 'active' | 'completed' | 'failed';
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

const sessionSchema = new Schema<ISession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    budgetId: { type: Schema.Types.ObjectId, ref: 'Budget' },
    goal: { type: String, required: true },
    messages: [messageSchema],
    status: {
      type: String,
      enum: ['active', 'completed', 'failed'],
      default: 'active',
    },
  },
  { timestamps: true },
);

export const Session = mongoose.model<ISession>('Session', sessionSchema);
