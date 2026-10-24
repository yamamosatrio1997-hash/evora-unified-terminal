import { describe, expect, it } from 'vitest';
import {
  deskLine, gameBanter, instructionScript, makeVars, meetingScript, pantryScript, reportScript, standingScript,
  traderChatScript,
} from '../src/config/dialogue';
import { LEADS, ODIN, ROSTER, TRADERS } from '../src/config/roster';
import { FundState } from '../src/sim/FundState';

const fund = new FundState();
const unfilled = /\{\w+\}/;

describe('dialogue templates', () => {
  it('fills every placeholder in every script', () => {
    for (let i = 0; i < 200; i++) {
      const v = makeVars(fund, Date.now());
      const scripts = [
        meetingScript([ODIN, ...LEADS], v),
        instructionScript([LEADS[i % 8], TRADERS[i % 12]], v),
        standingScript([LEADS[i % 8], LEADS[(i + 1) % 8], LEADS[(i + 2) % 8]], v),
        pantryScript([LEADS[i % 8], LEADS[(i + 3) % 8]], v),
        reportScript(v),
        traderChatScript([TRADERS[0], TRADERS[1]], v),
      ];
      for (const lines of scripts) for (const [, text] of lines) expect(text).not.toMatch(unfilled);
      for (const def of ROSTER) expect(deskLine(def, v)).not.toMatch(unfilled);
      for (const g of ['billiard', 'pingpong', 'ps'] as const) expect(gameBanter(g, LEADS[0])).not.toMatch(unfilled);
    }
  });

  it('keeps speaker indices inside the participant list', () => {
    const v = makeVars(fund, Date.now());
    for (const [idx] of meetingScript([ODIN, LEADS[0], LEADS[1]], v)) expect(idx).toBeLessThan(3);
    for (const [idx] of reportScript(v)) expect(idx).toBeLessThan(2);
  });

  it('uses the signal symbol when overridden', () => {
    const v = makeVars(fund, Date.now(), { sym: 'SOLUSDT', side: 'SHORT' });
    expect(v.sym).toBe('SOLUSDT');
    expect(v.side).toBe('SHORT');
  });
});
