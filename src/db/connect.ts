import mongoose from 'mongoose';
import { config } from '../config.js';

export async function connectDB(): Promise<void> {
  try {
    await mongoose.connect(config.MONGODB_URI);
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
}
