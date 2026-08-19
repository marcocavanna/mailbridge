import { describe, expect, it } from 'vitest';

import { BUNDLE_DISPLAY_NAME, BUNDLE_IDENTIFIER, resolveBundleExecutablePath, resolveBundlePath } from '#schedule/app-bundle';
import { buildAgentPlist } from '#schedule/plist';

/* --------
 * Bundle paths
 * -------- */

describe('bundle paths', () => {
  it('lives in Application Support, not among the user\'s applications', () => {
    expect(resolveBundlePath()).toContain('/Library/Application Support/mailbridge/');
    expect(resolveBundlePath()).toMatch(/MailbridgeSync\.app$/);
  });

  it('exposes the executable at the canonical place inside a bundle', () => {
    expect(resolveBundleExecutablePath()).toBe(`${resolveBundlePath()}/Contents/MacOS/mailbridge-sync`);
  });

  it('has a reverse-DNS identifier and a readable name', () => {
    expect(BUNDLE_IDENTIFIER).toBe('com.marcocavanna.mailbridge');
    expect(BUNDLE_DISPLAY_NAME).toBe('Mailbridge Sync');
  });
});

/* --------
 * Agent wiring
 * -------- */

describe('the plist launches the bundle, not Node', () => {
  /*
   * This is the whole point: in System Settings a background item is attributed to whoever signs the
   * launched executable. With Node as the first argument, macOS announces an item from
   * "Node.js Foundation".
   */
  it('puts the bundle executable as the first argument', () => {
    const plist = buildAgentPlist({
      executablePath:  resolveBundleExecutablePath(),
      intervalMinutes: 30,
      accountIds:      [],
      logPath:         '/tmp/a.log',
      errorLogPath:    '/tmp/b.log',
    });

    const firstString = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(plist);

    expect(firstString?.[1]).toBe(resolveBundleExecutablePath());
  });

  it('never names a node binary in the arguments', () => {
    const plist = buildAgentPlist({
      executablePath:  resolveBundleExecutablePath(),
      intervalMinutes: 30,
      accountIds:      ['one'],
      logPath:         '/tmp/a.log',
      errorLogPath:    '/tmp/b.log',
    });

    expect(plist).not.toMatch(/<string>[^<]*\/bin\/node<\/string>/);
  });
});
