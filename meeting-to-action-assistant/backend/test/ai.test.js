import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTranscript, __test__ } from '../src/ai.js';
import { config } from '../src/config.js';

test('parses plain JSON text', () => {
  assert.deepEqual(__test__.parseJson('{"meetingSummary":"Weekly sync"}'), { meetingSummary: 'Weekly sync' });
});

test('parses JSON in Markdown fences and surrounded by text', () => {
  assert.deepEqual(__test__.parseJson('```json\n{"meetingSummary":"Weekly sync"}\n```'), { meetingSummary: 'Weekly sync' });
  assert.deepEqual(__test__.parseJson('Result:\n{"meetingSummary":"Weekly sync"}\nDone.'), { meetingSummary: 'Weekly sync' });
});

test('rejects malformed JSON rather than accepting a partial report', () => {
  assert.throws(() => __test__.parseJson('{"meetingSummary":'), SyntaxError);
  assert.equal(__test__.schema.safeParse(__test__.safeDefaults({ keyPoints: [] })).success, false);
});

const completeReport = {
  meetingSummary: 'The team confirmed the launch review and assigned the agenda.',
  keyPoints: ['The review remains scheduled.'],
  decisions: [{ title: 'Keep review scheduled', description: 'The review remains on the calendar.', evidence: 'We will keep the review on Thursday.', confidence: 'high', kind: 'confirmed' }],
  actionItems: [{ title: 'Send agenda', description: 'Share the launch agenda.', owner: 'Maya', deadline: '2026-11-02', priority: 'medium', status: 'pending', sourceExcerpt: 'Maya will send the agenda by Monday.', confidence: 'high', needsClarification: false, clarificationQuestion: null }],
  followUps: [{ title: 'Review launch readiness', description: 'Discuss progress at the scheduled review.', owner: null, deadline: null }],
  clarifications: [{ relatedActionTitle: null, issue: 'Owner not stated for sponsor update.', question: 'Who owns the sponsor update?', resolved: false }],
};

test('accepts a complete structured meeting report with every required field', () => {
  const parsed = __test__.schema.parse(__test__.safeDefaults(completeReport));
  assert.equal(parsed.followUps.length, 1);
  assert.equal(parsed.clarifications.length, 1);
  assert.equal(parsed.actionItems.length, 1);
});

test('rejects a syntactically valid but truncated report missing required arrays', () => {
  const truncated = { ...completeReport };
  delete truncated.followUps;
  delete truncated.clarifications;
  const result = __test__.schema.safeParse(__test__.safeDefaults(truncated));
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues.filter(issue => ['followUps', 'clarifications'].includes(issue.path[0])).map(issue => issue.path[0]).sort(), ['clarifications', 'followUps']);
});

test('normalizes safe optional values and invalid dates without inventing facts', () => {
  const normalized = __test__.safeDefaults({
    meetingSummary: 'A short meeting summary.',
    keyPoints: [], decisions: [], followUps: [], clarifications: [],
    actionItems: [{ title: 'Send launch plan', description: 'Send the plan.', deadline: 'next Friday', status: 'unknown', priority: 'urgent' }],
  });
  const task = normalized.actionItems[0];
  assert.equal(task.owner, null);
  assert.equal(task.deadline, null);
  assert.equal(task.needsClarification, true);
  assert.match(task.clarificationQuestion, /confirm the calendar date/i);
  assert.equal(task.status, 'pending');
  assert.equal(task.priority, 'medium');
  assert.equal(normalized.decisions.length, 0);
  assert.equal(normalized.followUps.length, 0);
  assert.equal(normalized.clarifications.length, 0);
  assert.equal(__test__.schema.safeParse(normalized).success, true);
});

test('preserves valid ISO dates and explicit null owners', () => {
  const normalized = __test__.safeDefaults({
    meetingSummary: 'A short meeting summary.',
    keyPoints: [], decisions: [], followUps: [], clarifications: [],
    actionItems: [{ title: 'Send plan', description: 'Send the plan.', owner: null, deadline: '2026-10-30' }],
  });
  assert.equal(normalized.actionItems[0].deadline, '2026-10-30');
  assert.equal(normalized.actionItems[0].owner, null);
  assert.equal(normalized.actionItems[0].needsClarification, false);
});

test('distinguishes Groq model, permission, credential, and request failures', () => {
  assert.match(__test__.providerFailure({ status: 400 }, { code: 'invalid_request_error', message: 'Invalid schema' }).message, /HTTP 400.*Invalid schema/);
  assert.match(__test__.providerFailure({ status: 401 }, { code: 'invalid_api_key' }).message, /rejected the API key/);
  assert.match(__test__.providerFailure({ status: 403 }, { code: 'permissions_error' }).message, /denied access/);
  assert.match(__test__.providerFailure({ status: 404 }, { code: 'model_not_found' }).message, /could not find the configured model/);
  assert.match(__test__.providerFailure({ status: 429 }, { code: 'rate_limit_exceeded' }).message, /rate limit or quota/);
});

test('sanitizes provider error diagnostics without exposing a key or transcript', async () => {
  const transcript = 'Private synthetic transcript content';
  const response = new Response(JSON.stringify({ error: {
    code: 'invalid_request_error', type: 'request_error',
    message: `Bad request for ${transcript}; token gsk_1234567890abcdefgh`,
  } }), { status: 400 });
  const detail = await __test__.readProviderError(response, transcript);
  assert.equal(detail.code, 'invalid_request_error');
  assert.equal(detail.type, 'request_error');
  assert.doesNotMatch(detail.message, /Private synthetic transcript content|gsk_1234567890abcdefgh/);
  assert.match(detail.message, /\[redacted\]/);
});

test('handles Groq json_validate_failed as bounded, retryable incomplete output', async () => {
  const privateGeneration = 'A sensitive transcript-derived output fragment';
  const response = new Response(JSON.stringify({ error: {
    code: 'json_validate_failed', type: 'invalid_request_error',
    message: `max completion tokens reached; missing required content. failed_generation: ${privateGeneration}`,
  } }), { status: 400 });
  const detail = await __test__.readProviderError(response, 'Synthetic transcript');
  assert.equal(detail.incompleteOutput, true);
  assert.doesNotMatch(detail.message, /sensitive transcript-derived output fragment/);
  const failure = __test__.providerFailure({ status: 400 }, detail);
  assert.match(failure.message, /report was incomplete.*completion-token limit.*Please retry/i);
  assert.doesNotMatch(failure.message, /API key|model not found/i);
});

test('retries json_validate_failed once with a larger completion budget and validates the full schema', async () => {
  const originalFetch = globalThis.fetch;
  const logged = [];
  const originalWarn = console.warn;
  const requests = [];
  const privateFragment = 'Transcript-derived private detail';
  console.warn = (...args) => logged.push(args.join(' '));
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (requests.length === 1) return new Response(JSON.stringify({ error: {
      code: 'json_validate_failed', type: 'invalid_request_error',
      message: `max_completion_tokens reached and output was truncated; failed_generation: ${privateFragment}`,
    } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(completeReport) } }] }), { status: 200 });
  };
  try {
    const report = await analyzeTranscript({
      date: '2026-10-23', participants: ['Maya'],
      transcript: 'Synthetic meeting transcript for regression test. Maya will send the launch agenda by Monday. The team confirmed the launch review. Sponsor update ownership remains unresolved.',
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].max_completion_tokens, config.groqMaxCompletionTokens);
    assert.equal(requests[1].max_completion_tokens, Math.min(config.groqMaxCompletionTokens * 2, 65536));
    assert.equal(requests[0].response_format.type, 'json_schema');
    assert.equal(requests[0].response_format.json_schema.strict, true);
    const required = requests[0].response_format.json_schema.schema.required;
    assert.deepEqual(required, ['meetingSummary', 'keyPoints', 'decisions', 'actionItems', 'followUps', 'clarifications']);
    assert.equal(report.followUps.length, 1);
    assert.equal(report.clarifications.length, 1);
    assert.equal(report.actionItems.length, 1);
    assert.ok(logged.every(line => !line.includes(privateFragment)));
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('returns a safe retry message when json_validate_failed persists after the bounded retry', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: {
      code: 'json_validate_failed', type: 'invalid_request_error',
      message: 'max completion tokens reached before generating all required properties',
    } }), { status: 400 });
  };
  try {
    await assert.rejects(
      analyzeTranscript({ date: null, participants: [], transcript: 'Synthetic transcript of sufficient length for the analysis endpoint.' }),
      error => error.status === 502 && /incomplete.*completion-token limit.*Please retry/i.test(error.message),
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});
