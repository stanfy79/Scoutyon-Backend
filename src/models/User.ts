import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  name: string;
  apiKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    apiKey: { type: String, required: true, unique: true, index: true },
  },
  { timestamps: true },
);

export const User = mongoose.model<IUser>('User', userSchema);
