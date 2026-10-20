import type { VisualNote } from '../audio/engine';
import { FEED } from '../config';

export interface FeedLine {
  text: string;
  tone: 'buy' | 'sell' | 'create' | 'gold';
  link: string | null;
}

const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const coinName = (n: VisualNote) => (n.symbol ? `$${n.symbol}` : n.coin ? shortAddress(n.coin) : 'a coin');
const formatSol = (sol: number) => `${sol.toFixed(sol < 0.1 ? 2 : sol < 10 ? 1 : 0)} SOL`;

/**
 * One line of the activity log (like the edit log in Listen to Wikipedia).
 * At ~12 trades per second a full log is unreadable, so only coin events and
 * big trades get in, unless the listener focuses on one coin: then its every
 * trade is listed.
 */
export function feedLine(n: VisualNote, focusActive: boolean, coinMode = false): FeedLine | null {
  if (n.faint) return null;
  const name = coinName(n);
  // Listening to a few coins, a trade line names the coin and the wallet.
  const wallet = coinMode && n.user ? shortAddress(n.user) : null;
  switch (n.kind) {
    case 'failed':
      return null;
    case 'create':
      return { text: `New coin ${name}`, tone: 'create', link: n.link };
    case 'complete':
      return { text: `${name} filled its bonding curve`, tone: 'gold', link: n.link };
    case 'migrate':
      return { text: `${name} graduated to PumpSwap`, tone: 'gold', link: n.link };
    case 'buy':
    case 'sell': {
      const notable = focusActive || n.whale || (n.sol ?? 0) >= FEED.minSol;
      if (!notable) return null;
      const parts = [n.kind === 'buy' ? 'Buy' : 'Sell'];
      if (n.sol !== null) parts.push(formatSol(n.sol));
      parts.push(name);
      if (wallet) parts.push(`· ${wallet}`);
      if (n.venue === 'swap' && !coinMode) parts.push('on PumpSwap');
      return { text: parts.join(' ') + (n.whale ? ' · whale' : ''), tone: n.kind, link: n.link };
    }
  }
}
