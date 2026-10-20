import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VisualNote } from '../src/audio/engine';
import { feedLine } from '../src/ui/feed';

const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const note = (over: Partial<VisualNote>): VisualNote => ({
  at: 0, kind: 'buy', venue: 'curve', size: 0.1, pitch: 0.5, label: null, link: null, whale: false, pan: 0,
  coin: MINT, symbol: 'POPCAT', sol: 0.2, faint: false, ...over,
});

test('small trades stay out of the feed, big ones and whales get in', () => {
  assert.equal(feedLine(note({}), false), null);
  assert.equal(feedLine(note({ sol: 2.34 }), false)?.text, 'Buy 2.3 SOL $POPCAT');
  assert.equal(feedLine(note({ kind: 'sell', sol: 15 }), false)?.text, 'Sell 15 SOL $POPCAT');
  assert.equal(feedLine(note({ venue: 'swap', sol: null, whale: true }), false)?.text, 'Buy $POPCAT on PumpSwap · whale');
});

test('in focus mode every trade of the coin is listed, others never', () => {
  assert.equal(feedLine(note({ sol: 0.05 }), true)?.text, 'Buy 0.05 SOL $POPCAT');
  assert.equal(feedLine(note({ sol: 50, faint: true }), true), null);
});

test('coin events always show, unknown tickers fall back to a short address', () => {
  assert.equal(feedLine(note({ kind: 'create', symbol: 'NEW' }), false)?.text, 'New coin $NEW');
  assert.equal(feedLine(note({ kind: 'migrate', symbol: null }), false)?.text, '7GCi…W2hr graduated to PumpSwap');
  assert.equal(feedLine(note({ kind: 'complete' }), false)?.tone, 'gold');
  assert.equal(feedLine(note({ kind: 'failed', coin: null }), false), null);
});
