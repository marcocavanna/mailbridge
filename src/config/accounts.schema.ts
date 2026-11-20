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
 * SASL mechanism names for `mbsync`'s `AuthMechs`, space separated (`PLAIN`, `LOGIN PLAIN`).
 *
 * The value is written verbatim into a generated config file, so the pattern is the guard: a newline
 * or any other character outside a mechanism name would let `accounts.json` inject directives.
 */
const authMechsSchema = z
  .string()
  .regex(/^[A-Z0-9_-]+( [A-Z0-9_-]+)*$/, 'use SASL mechanism names in capitals, separated by single spaces');

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
  /**
   * Restricts the SASL mechanisms `mbsync` may negotiate. Absent = let SASL choose.
   *
   * Needed when the server advertises a mechanism the system `libsasl2` cannot complete, which makes
   * `mbsync` fail before it ever tries `PLAIN`: Aruba offering `OAUTHBEARER` is the precedent. It does
   * not relax transport security: TLS stays mandatory, see `.claude/rules/security.md` §6.
   */
  authMechs: authMechsSchema.optional(),
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

/**
 * How the account authenticates.
 *
 * - `password`: the password lives in the Keychain under `mailbridge:<id>`. The default, so a
 *   configuration written before OAuth existed keeps its meaning.
 * - `oauth2`: SASL XOAUTH2 with a token from the provider. Only the refresh token is persisted, in the
 *   Keychain under `mailbridge:<id>:oauth`; access tokens live in memory. `tenantId` and `clientId`
 *   identify a **public** client registered by the account owner: neither is a secret, and no client
 *   secret exists. Nothing in the code names a tenant or an application.
 */
const passwordAuthSchema = z.object({
  type: z.literal('password'),
});

const oauth2AuthSchema = z.object({
  type:     z.literal('oauth2'),
  provider: z.literal('microsoft'),
  /**
   * Directory (tenant) id, or one of the tenant's domain names. The multi-tenant aliases (`common`,
   * `organizations`, `consumers`) are refused: the client is registered in a single tenant.
   */
  tenantId: z
    .string()
    .regex(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i,
      'use the directory (tenant) id or a domain of the tenant',
    ),
  /** Application (client) id of the app registration. */
  clientId: z.guid(),
});

export const authSchema = z.discriminatedUnion('type', [passwordAuthSchema, oauth2AuthSchema]);

export const accountSchema = z
  .object({
    id:      accountIdSchema,
    label:   z.string().min(1).max(120),
    address: z.email(),
    auth:    authSchema.default({ type: 'password' }),
    imap:    imapSchema,
    /**
     * Absent = the account reads and prepares drafts, and sends nothing: the user sends from their mail
     * client. That is a configuration, not a degraded state.
     */
    smtp:    smtpSchema.optional(),
    folders: foldersSchema.default({}),
    mirror:  mirrorSchema.default({ enabled: true }),
  })
  .superRefine((account, context) => {
    if (account.auth.type !== 'oauth2') {
      return;
    }

    /*
     * Sending with OAuth would need the SMTP.Send scope and SMTP AUTH enabled on the mailbox. Not
     * supported: an OAuth account prepares drafts, and the user sends them from the mail client.
     */
    if (account.smtp !== undefined) {
      context.addIssue({
        code:    'custom',
        path:    ['smtp'],
        message: 'sending is not supported on OAuth accounts: remove smtp and send drafts from the mail client',
      });
    }
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
export type AccountAuth = z.infer<typeof authSchema>;
export type OAuth2Auth = z.infer<typeof oauth2AuthSchema>;
export type Account = z.infer<typeof accountSchema>;
export type AccountsConfig = z.infer<typeof accountsConfigSchema>;
