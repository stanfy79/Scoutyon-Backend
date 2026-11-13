interface IndexDescription {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
}

interface IndexCollection {
  indexes(): Promise<IndexDescription[]>;
  dropIndex(name: string): Promise<unknown>;
}

export async function dropLegacyUniqueApiKeyIndexes(
  collection: IndexCollection,
): Promise<string[]> {
  const indexes = await collection.indexes();
  const legacyIndexes = indexes.filter(
    (index) =>
      index.unique === true &&
      Object.keys(index.key).length === 1 &&
      index.key.apiKey === 1,
  );
  const droppedNames: string[] = [];

  for (const index of legacyIndexes) {
    if (!index.name) {
      throw new Error('Cannot safely drop the legacy apiKey index because MongoDB returned no index name');
    }
    await collection.dropIndex(index.name);
    droppedNames.push(index.name);
  }

  return droppedNames;
}
