import { Tool, Type } from '@google/genai';

export const agentTools: Tool[] = [
  {
    functionDeclarations: [
      {
        name: 'fetch_page',
        description:
          'Fetch the text content of a web page. Use this to get exact pricing or feature details from a specific URL found during research.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            url: {
              type: Type.STRING,
              description: 'The full HTTPS URL of the pricing or product page to fetch.',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'create_quote',
        description:
          'Create a formal purchase quote for a service you have fully researched and verified. Call this only when you have confirmed the price from the provider website.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            provider: {
              type: Type.STRING,
              description: 'Name of the service provider.',
            },
            description: {
              type: Type.STRING,
              description:
                'Description of the specific plan or tier, including key features, API call limits, and restrictions.',
            },
            price: {
              type: Type.NUMBER,
              description: 'Monthly price as a number, e.g. 9.99',
            },
            currency: {
              type: Type.STRING,
              description: 'ISO 4217 currency code, e.g. USD',
            },
            sourceUrl: {
              type: Type.STRING,
              description: 'The exact URL of the pricing page where this was verified.',
            },
          },
          required: ['provider', 'description', 'price', 'currency', 'sourceUrl'],
        },
      },
    ],
  },
];
