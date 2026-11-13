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
      {
        name: 'search_vendors',
        description:
          'Discover candidate vendors for a specified requirement using any known public URLs and vendor metadata.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            requirement: { type: Type.STRING, description: 'The user requirement or goal.' },
            category: { type: Type.STRING, description: 'Vendor category or product type.' },
            keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
            budget: {
              type: Type.OBJECT,
              properties: {
                currency: { type: Type.STRING },
                minimum: { type: Type.NUMBER },
                maximum: { type: Type.NUMBER },
              },
            },
            location: { type: Type.STRING },
            specifications: { type: Type.ARRAY, items: { type: Type.STRING } },
            preferredCharacteristics: { type: Type.ARRAY, items: { type: Type.STRING } },
            constraints: { type: Type.ARRAY, items: { type: Type.STRING } },
            candidateUrls: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['requirement'],
        },
      },
      {
        name: 'list_purchases',
        description: 'List the authenticated user’s purchase records and statuses.',
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      {
        name: 'budget_summary',
        description: 'Retrieve the spending summary for a specific budget.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            budgetId: { type: Type.STRING, description: 'The id of the budget to inspect.' },
          },
          required: ['budgetId'],
        },
      },
      {
        name: 'supported_assets',
        description: 'Retrieve the configured NEAR Intents source and destination asset catalogue.',
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      {
        name: 'get_supported_assets',
        description: 'Fetch the currently supported source and destination assets from the NEAR Intents token catalogue.',
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
      {
        name: 'get_transfer_quote',
        description: 'Get a real live swap quote from the NEAR Intents 1Click API. Provide token symbols (not guessed asset IDs), human-readable input amount, and networks when needed. Use session context to fill omitted prior details; if required information is still missing or ambiguous, return a clarification instead of guessing.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            sourceAsset: { type: Type.STRING, description: 'Source token symbol, such as USDC. The server resolves it against the live NEAR Intents token catalogue.' },
            destinationAsset: { type: Type.STRING, description: 'Destination token symbol, such as NEAR or ETH. The server resolves it against the live NEAR Intents token catalogue.' },
            amount: { type: Type.STRING, description: 'Human-readable exact input amount, e.g. "10" or "0.25".' },
            sourceNetwork: { type: Type.STRING, description: 'Source network when a symbol exists on multiple networks.' },
            destinationNetwork: { type: Type.STRING, description: 'Destination network when a symbol exists on multiple networks.' },
            recipientAddress: { type: Type.STRING, description: 'Optional destination address. The authenticated wallet is used only for EVM destinations; non-EVM destinations require an explicit compatible address.' },
            refundAddress: { type: Type.STRING, description: 'Optional origin-chain refund address. The authenticated wallet is used only for EVM source chains.' },
          },
        },
      },
      {
        name: 'prepare_transfer',
        description: 'Prepare a persisted transfer workflow from an executable quote after review.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            sourceAsset: { type: Type.STRING },
            destinationAsset: { type: Type.STRING },
            amount: { type: Type.STRING },
            sourceNetwork: { type: Type.STRING },
            destinationNetwork: { type: Type.STRING },
            recipientAddress: { type: Type.STRING },
            refundAddress: { type: Type.STRING },
            quoteId: { type: Type.STRING },
          },
          required: ['sourceAsset', 'destinationAsset', 'amount', 'recipientAddress'],
        },
      },
      {
        name: 'confirm_transaction',
        description: 'Confirm a previously prepared payment after wallet authorization is available.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            paymentId: { type: Type.STRING, description: 'ID of the prepared payment attempt to confirm.' },
            confirm: { type: Type.BOOLEAN, description: 'Must be true to explicitly authorize the payment.' },
          },
          required: ['paymentId', 'confirm'],
        },
      },
      {
        name: 'get_transaction_status',
        description: 'Check the status of a transfer or payment in the authenticated user context.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            paymentId: { type: Type.STRING, description: 'The payment attempt or transaction ID to inspect.' },
          },
        },
      },
      {
        name: 'get_transaction_history',
        description: 'List recent transfer activities for the authenticated user.',
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
      },
    ],
  },
];
