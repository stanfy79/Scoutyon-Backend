import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropLegacyUniqueApiKeyIndexes } from '../src/db/migrations/dropLegacyApiKeyIndex.js';

test('drops only the unique single-field legacy apiKey index', async () => {
  const dropped: string[] = [];
  const result = await dropLegacyUniqueApiKeyIndexes({
    async indexes() {
      return [
        { name: '_id_', key: { _id: 1 }, unique: true },
        { name: 'apiKey_1', key: { apiKey: 1 }, unique: true },
        { name: 'apiKey_1_email_1', key: { apiKey: 1, email: 1 }, unique: true },
        { name: 'apiKey_1_non_unique', key: { apiKey: 1 }, unique: false },
      ];
    },
    async dropIndex(name) {
      dropped.push(name);
    },
  });

  assert.deepEqual(result, ['apiKey_1']);
  assert.deepEqual(dropped, ['apiKey_1']);
});

test('does not drop other indexes when the legacy unique apiKey index is absent', async () => {
  const dropped: string[] = [];
  const result = await dropLegacyUniqueApiKeyIndexes({
    async indexes() {
      return [{ name: 'apiKey_1', key: { apiKey: 1 }, unique: false }];
    },
    async dropIndex(name) {
      dropped.push(name);
    },
  });

  assert.deepEqual(result, []);
  assert.deepEqual(dropped, []);
});
