import { renderAccountDetail } from './account-view.js';
import { pickAccount, requireOverview } from './account-resolve.js';
import { testAccount } from './account-read-actions.js';
import { askConfirm, askPort, askText, askTypedConfirmation, prompts, required } from './prompt-helpers.js';
import { colors, formatBytes, heading } from './ui.js';

import { accountSchema } from '#config/accounts.schema';
import { addAccount, removeAccount, updateAccount } from '#config/write-accounts';
import { resolveMaildirPath } from '#mirror/paths';
import { readMirrorStats } from '#mirror/stats';
import { deletePassword, promptAndStorePassword } from '#secrets/keychain-write';

import type { Account } from '#config/accounts.schema';

/* --------
 * Write actions
 * -------- */

/**
 * Collects an account's fields. With `current` it becomes an edit: every prompt starts from the
 * present value, so one field can change without retyping the others.
 */
async function collectAccount(current?: Account): Promise<Account> {
  const isEdit = current !== undefined;

  const id = await askText('Short account id', {
    ...(isEdit ? { initialValue: current.id } : { placeholder: 'work' }),
    validate: (value) => (
      accountSchema.shape.id.safeParse(value).success
        ? undefined
        : 'Lowercase letters, digits, dot, dash and underscore only.'
    ),
  });

  const address = await askText('Email address', {
    ...(isEdit ? { initialValue: current.address } : {}),
    validate: (value) => (accountSchema.shape.address.safeParse(value).success ? undefined : 'Not a valid address.'),
  });

  const accountLabel = await askText('Display name to send as', {
    initialValue: isEdit ? current.label : address,
  });

  prompts.log.step('IMAP — reading');

  const imapHost = await askText('  IMAP host', {
    ...(isEdit ? { initialValue: current.imap.host } : { placeholder: 'imap.example.com' }),
  });
  const imapPort = await askPort('  IMAP port (implicit TLS)', isEdit ? current.imap.port : 993);
  const imapUser = await askText('  IMAP username', { initialValue: isEdit ? current.imap.user : address });

  prompts.log.step('SMTP — sending');

  const smtpHost = await askText('  SMTP host', {
    initialValue: isEdit ? current.smtp.host : imapHost.replace(/^imap\./, 'smtp.'),
  });
  const smtpPort = await askPort('  SMTP port (465 TLS, 587 STARTTLS)', isEdit ? current.smtp.port : 465);
  const smtpUser = await askText('  SMTP username', {
    initialValue: isEdit ? (current.smtp.user ?? current.imap.user) : imapUser,
  });

  const mirrorEnabled = await askConfirm(
    'Enable the local mirror for fast search?',
    isEdit ? current.mirror.enabled : true,
  );

  return accountSchema.parse({
    id,
    label: accountLabel,
    address,
    imap: {
      host:   imapHost,
      port:   imapPort,
      secure: true,
      user:   imapUser,
    },
    smtp: {
      host:   smtpHost,
      port:   smtpPort,
      secure: smtpPort === 465,
      ...(smtpUser === imapUser ? {} : { user: smtpUser }),
    },
    folders: isEdit ? current.folders : {},
    mirror:  { enabled: mirrorEnabled, ...(isEdit && current.mirror.maildirPath !== undefined ? { maildirPath: current.mirror.maildirPath } : {}) },
  });
}

export async function addAccountFlow(): Promise<void> {
  const account = await collectAccount();
  const path = await addAccount(account);

  prompts.log.success(`Account "${account.id}" written to ${path}`);

  // ---- Credential: the password is asked for by `security`, not by this process
  prompts.log.step('Storing the credential in the Keychain — macOS asks for the password, it never passes through here');

  await promptAndStorePassword(account.id, account.imap.user, 'imap');

  if (account.smtp.user !== undefined && account.smtp.user !== account.imap.user) {
    prompts.log.step('The SMTP username differs: storing the SMTP credential as well');
    await promptAndStorePassword(account.id, account.smtp.user, 'smtp');
  }

  // ---- Verify right away: an account configured and never tested is one you find broken later
  if (await askConfirm('Test the connection now?', true)) {
    await testAccount(account.id);
  }
}

export async function editAccountFlow(accountId?: string): Promise<void> {
  const target = accountId ?? (await pickAccount('Which account should I edit?'));
  const entry = await requireOverview(target);

  const choice = required(await prompts.select({
    message: `What should I change on "${target}"?`,
    options: [
      { value: 'fields', label: 'Hosts, ports, address, sender name' },
      { value: 'password', label: 'The password only' },
      { value: 'mirror', label: `Local mirror (now: ${entry.account.mirror.enabled ? 'on' : 'off'})` },
    ],
  }));

  if (choice === 'password') {
    prompts.log.step('macOS asks for the password: it never passes through this process');

    await promptAndStorePassword(target, entry.account.imap.user, 'imap');
    prompts.log.success(`Credential for "${target}" updated.`);

    return;
  }

  if (choice === 'mirror') {
    const enabled = !entry.account.mirror.enabled;

    await updateAccount(target, { ...entry.account, mirror: { ...entry.account.mirror, enabled } });

    prompts.log.success(`Mirror for "${target}" ${enabled ? 'enabled' : 'disabled'}.`);

    if (!enabled) {
      prompts.log.info(`The files stay in ${resolveMaildirPath(entry.account)}: I am not touching them.`);
    }

    return;
  }

  const updated = await collectAccount(entry.account);

  await updateAccount(target, updated);

  prompts.log.success(`Account "${target}" updated${updated.id === target ? '' : ` and renamed to "${updated.id}"`}.`);

  if (updated.id !== target) {
    prompts.log.warn([
      `The id changed: the Keychain credential is still stored under "${target}"`,
      `and the mirror still lives in ${resolveMaildirPath(entry.account)}.`,
      'Store the password under the new id and sync again.',
    ].join(' '));
  }
}

/**
 * Removing an account.
 *
 * Three distinct objects with three distinct treatments, and this is not gratuitous complexity: the
 * configuration is rewritten, the credential is **unrecoverable** once deleted, and the mirror is a
 * rebuildable cache that costs a full sync to rebuild. See `.claude/rules/security.md` §4.
 */
export async function removeAccountFlow(accountId?: string): Promise<void> {
  const target = accountId ?? (await pickAccount('Which account should I remove?'));
  const entry = await requireOverview(target);

  prompts.log.message(`${heading(`Removing "${target}"`)}\n\n${renderAccountDetail(entry)}`);

  const stats = entry.stats ?? (entry.account.mirror.enabled ? await readMirrorStats(entry.account) : undefined);

  prompts.log.warn([
    'About to remove the account from the configuration.',
    'The MCP server will no longer see it.',
  ].join(' '));

  if (!(await askTypedConfirmation('Confirm?', target))) {
    prompts.log.info('Cancelled: nothing was touched.');

    return;
  }

  await removeAccount(target);
  prompts.log.success(`"${target}" removed from the configuration.`);

  // ---- Credential: irreversible, hence a separate question
  prompts.log.warn(`The Keychain credential cannot be recreated: this program does not know the password for "${target}".`);

  if (await askConfirm('Delete the Keychain credential as well?', false)) {
    const deleted = await deletePassword(target, 'imap');

    await deletePassword(target, 'smtp');

    prompts.log.success(deleted ? 'Credential deleted.' : 'There was no credential to delete.');
  } else {
    prompts.log.info('Credential left in the Keychain.');
  }

  // ---- Mirror: never deleted from here
  if (stats?.exists === true) {
    prompts.log.info([
      `The mirror stays on disk: ${colors.bold(stats.path)} (${formatBytes(stats.sizeBytes)}).`,
      'I am not deleting it — remove it by hand if you want it gone.',
    ].join('\n  '));
  }
}
