import { z } from 'zod';

/* --------
 * Primitives
 * -------- */

/** Account slug: it ends up in the Keychain service name, so no surprising characters. */
const accountIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'use only lowercase letters, digits, dot, dash and underscore');

const hostSchema = z.string().min(1).max(255);

const portSchema = z.number().int().min(1).max(65535);

/**
 * Special folder names. A union of literals: no enum.
 */
export const SPECIAL_FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'junk'] as const;

export const specialFolderSchema = z.enum(SPECIAL_FOLDERS);

/* --------
 * Account
 * -------- */

const imapSchema = z.object({
  host:   hostSchema,
  port:   portSchema.default(993),
  /** Implicit TLS. `false` is not supported: see `.claude/rules/security.md` §6. */
  secure: z.literal(true).default(true),
  user:   z.string().min(1),
});

const smtpSchema = z.object({
  host: hostSchema,
  port: portSchema.default(465),
  /** `true` = implicit TLS on 465. `false` = mandatory STARTTLS on 587, never plaintext. */
  secure: z.boolean().default(true),
  /** Falls back to `imap.user` when absent. */
  user: z.string().min(1).optional(),
});

/**
 * Folder path overrides, for servers that do not announce special-use flags.
 * Anything missing is discovered at runtime.
 */
const foldersSchema = z.partialRecord(specialFolderSchema, z.string().min(1));

const mirrorSchema = z.object({
  enabled: z.boolean().default(true),
  /** Defaults to `~/Mail/<accountId>`. */
  maildirPath: z.string().min(1).optional(),
});

export const accountSchema = z.object({
  id:      accountIdSchema,
  label:   z.string().min(1).max(120),
  address: z.email(),
  imap:    imapSchema,
  smtp:    smtpSchema,
  folders: foldersSchema.default({}),
  mirror:  mirrorSchema.default({ enabled: true }),
});

export const accountsConfigSchema = z.object({
  version: z.literal(1),
  /**
   * An empty list is a **valid** state: it is the configuration after removing the last account.
   * Whoever needs at least one account checks for it at their own boundary, with an error that says
   * what to do — not with a schema validation failure.
   */
  accounts: z.array(accountSchema),
});

/* --------
 * Derived types
 * -------- */

export type SpecialFolder = z.infer<typeof specialFolderSchema>;
export type ImapConfig = z.infer<typeof imapSchema>;
export type SmtpConfig = z.infer<typeof smtpSchema>;
export type Account = z.infer<typeof accountSchema>;
export type AccountsConfig = z.infer<typeof accountsConfigSchema>;
