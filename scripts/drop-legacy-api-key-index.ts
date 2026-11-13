import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { User } from '../src/models/User.js';
import { dropLegacyUniqueApiKeyIndexes } from '../src/db/migrations/dropLegacyApiKeyIndex.js';

try {
  await mongoose.connect(config.MONGODB_URI);
  const droppedIndexes = await dropLegacyUniqueApiKeyIndexes(User.collection);

  if (droppedIndexes.length === 0) {
    console.log('No legacy unique apiKey index found; no changes made.');
  } else {
    console.log(`Dropped legacy unique apiKey index(es): ${droppedIndexes.join(', ')}`);
  }
} catch (error) {
  console.error('Failed to remove legacy unique apiKey index:', error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
