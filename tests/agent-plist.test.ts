import { describe, expect, it } from 'vitest';

import { AGENT_LABEL, buildAgentPlist } from '#schedule/plist';

import type { AgentConfig } from '#schedule/plist';

/* --------
 * Fixture
 * -------- */

function buildConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    executablePath:  '/opt/mailbridge/MailbridgeSync.app/Contents/MacOS/mailbridge-sync',
    intervalMinutes: 30,
    accountIds:      [],
    logPath:         '/tmp/sync.log',
    errorLogPath:    '/tmp/sync.error.log',
    ...overrides,
  };
}

/* --------
 * Plist
 * -------- */

describe('buildAgentPlist', () => {
  it('converts minutes into seconds for StartInterval', () => {
    expect(buildAgentPlist(buildConfig({ intervalMinutes: 30 }))).toContain('<integer>1800</integer>');
    expect(buildAgentPlist(buildConfig({ intervalMinutes: 180 }))).toContain('<integer>10800</integer>');
  });

  it('uses --all when no accounts are given', () => {
    expect(buildAgentPlist(buildConfig())).toContain('<string>--all</string>');
  });

  it('lists the given accounts instead of --all', () => {
    const plist = buildAgentPlist(buildConfig({ accountIds: ['one', 'two'] }));

    expect(plist).toContain('<string>one</string>');
    expect(plist).toContain('<string>two</string>');
    expect(plist).not.toContain('--all');
  });

  /*
   * launchd starts with a minimal environment: without this PATH, `mbsync` and `notmuch` are not found
   * and the sync fails with a "command not found" that is hard to trace back to the cause.
   */
  it('declares a PATH containing the homebrew directory', () => {
    expect(buildAgentPlist(buildConfig())).toContain('/opt/homebrew/bin');
  });

  /*
   * stderr lands in `sync.error.log`: at `info` level that file would fill up with lines that are not
   * errors and would stop being a useful signal.
   */
  it('lowers the log level to warn, keeping the error file meaningful', () => {
    const plist = buildAgentPlist(buildConfig());

    expect(plist).toContain('<key>MAILBRIDGE_LOG_LEVEL</key>');
    expect(plist).toMatch(/<key>MAILBRIDGE_LOG_LEVEL<\/key>\s*<string>warn<\/string>/);
  });

  it('passes --quiet, because the output goes to a log file', () => {
    expect(buildAgentPlist(buildConfig())).toContain('<string>--quiet</string>');
  });

  it('does not run at login: at startup the machine has other things to do', () => {
    expect(buildAgentPlist(buildConfig())).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
  });

  it('uses the Label as the agent identity', () => {
    expect(buildAgentPlist(buildConfig())).toContain(`<string>${AGENT_LABEL}</string>`);
  });

  /*
   * A path with `&` produces a plist launchd rejects without saying which character broke it.
   */
  it('escapes XML characters in paths', () => {
    const plist = buildAgentPlist(buildConfig({ executablePath: '/Users/x/Dev & Test/mailbridge-sync' }));

    expect(plist).toContain('/Users/x/Dev &amp; Test/mailbridge-sync');
    expect(plist).not.toContain('Dev & Test');
  });

  it('orders the arguments the way the CLI expects', () => {
    const plist = buildAgentPlist(buildConfig({ accountIds: ['only-this'] }));
    const order = ['sync', 'only-this', '--quiet'].map((value) => plist.indexOf(`<string>${value}</string>`));

    expect(order).toEqual([...order].sort((left, right) => left - right));
  });
});
