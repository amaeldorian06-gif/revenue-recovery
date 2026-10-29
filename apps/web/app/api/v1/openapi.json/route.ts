import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Revenue Recovery OS — Public API v1',
    version: '1.0.0',
    description: [
      'The API can prepare, never dispatch.',
      '`POST /v1/actions` deliberately creates drafts only: there is no endpoint —',
      'and there will be none — where an API key can approve or send a message.',
      'Approval and sending are human acts in this product.',
      '',
      'Auth: `Authorization: Bearer rrs_live_…` (or `rrs_test_…`). Keys are shown',
      'once at creation; only their SHA-256 is stored.',
      'Rate limit: 120 requests/minute/workspace, sliding window; a 429 carries',
      '`Retry-After` and every response carries `X-RateLimit-Remaining`.',
      'Errors: RFC 9457 `application/problem+json` with a stable `code`.',
      'Plans: Growth = read-only, Scale = read+write, Starter = no API.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'current deployment' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'rrs_live_… / rrs_test_…' },
    },
    schemas: {
      Problem: {
        type: 'object',
        properties: {
          type: { type: 'string' }, title: { type: 'string' },
          status: { type: 'integer' }, code: { type: 'string' }, detail: { type: 'string' },
        },
      },
      Opportunity: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }, clientName: { type: 'string' },
          title: { type: 'string' }, amountCents: { type: 'integer' },
          status: { type: 'string', enum: ['open', 'won', 'lost'] },
          arm: { type: 'string', enum: ['treatment', 'holdout'] },
          stage: { type: 'string' }, replyReceivedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Recommendation: {
        type: 'object',
        properties: {
          id: { type: 'string' }, opportunityId: { type: 'string' }, rank: { type: 'integer' },
          priority: { type: 'integer' }, expectedValueCents: { type: 'integer', nullable: true },
          pResponse: { type: 'number', nullable: true }, why: { type: 'string' }, acted: { type: 'boolean' },
        },
      },
      Result: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['A', 'B', 'C'] },
          treated: { type: 'integer', nullable: true }, controlled: { type: 'integer', nullable: true },
          estimate: { type: 'number', nullable: true },
          ciLow: { type: 'number', nullable: true }, ciHigh: { type: 'number', nullable: true },
          significant: { type: 'boolean' }, updatedAt: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/api/v1/opportunities': {
      get: {
        summary: 'List opportunities', tags: ['Read'],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'won', 'lost'] } },
          { name: 'arm', in: 'query', schema: { type: 'string', enum: ['treatment', 'holdout'] } },
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100, default: 50 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'opaque, from nextCursor' },
        ],
        responses: {
          200: {
            description: 'A page of opportunities',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Opportunity' } }, nextCursor: { type: 'string', nullable: true } } } } },
          },
          429: { description: 'Rate limited', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/api/v1/recommendations': {
      get: {
        summary: "A day's ranked queue", tags: ['Read'],
        parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' }, description: 'defaults to today' }],
        responses: { 200: { description: 'The ranked list' } },
      },
    },
    '/api/v1/actions': {
      post: {
        summary: 'Create a draft action (never sends)',
        description: '**Deliberately cannot send.** The created action is `status=draft`; no job picks it up for dispatch. Approval stays in the product, with a human.',
        tags: ['Write'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['opportunityId', 'text'], properties: { opportunityId: { type: 'string', format: 'uuid' }, subject: { type: 'string' }, text: { type: 'string', maxLength: 4000 } } } } },
        },
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        responses: {
          201: { description: 'Draft created (status=draft)' },
          403: { description: 'PLAN_FEATURE_UNAVAILABLE (needs Scale) or SCOPE_MISSING', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/api/v1/replies': {
      post: {
        summary: 'Record an external reply and stop the sequence',
        tags: ['Write'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['opportunityId'], properties: { opportunityId: { type: 'string' }, fromEmail: { type: 'string' }, subject: { type: 'string' }, receivedAt: { type: 'string', format: 'date-time' }, snippet: { type: 'string' } } } } },
        },
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        responses: { 201: { description: 'Reply recorded; pending actions cancelled' } },
      },
    },
    '/api/v1/results': {
      get: {
        summary: 'A/B/C results with intervals', tags: ['Read'],
        responses: { 200: { description: 'Levels with significance flag first' } },
      },
    },
    '/api/v1/usage': {
      get: {
        summary: 'Current-period counters', tags: ['Read'],
        responses: { 200: { description: 'proposals, emails, seats, mailboxes' } },
      },
    },
  },
} as const;

export function GET() {
  return NextResponse.json(spec);
}
