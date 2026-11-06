import test from 'node:test';
import assert from 'node:assert/strict';
import { safeErrorDetail, safeValidationIssues } from '../src/diagnostics.js';

test('diagnostic detail redacts API credentials and a submitted transcript', () => {
  const transcript='Private synthetic transcript content that must not enter logs.';
  const key='gsk_testsecretvalue123456789';
  const detail=safeErrorDetail(new Error(`Database rejected ${transcript}; auth Bearer ${key}`),[key,transcript]);
  assert.equal(detail.includes(transcript),false);
  assert.equal(detail.includes(key),false);
  assert.match(detail,/\[redacted\]/);
});

test('validation diagnostics retain field and error codes without submitted values', () => {
  const result=safeValidationIssues({issues:[{path:['transcript'],code:'too_big',message:'private text'}]});
  assert.deepEqual(result,[{field:'transcript',code:'too_big'}]);
  assert.equal(JSON.stringify(result).includes('private text'),false);
});
